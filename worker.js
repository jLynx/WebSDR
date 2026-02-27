/*
Copyright (c) 2019, cho45 <cho45@lowreal.net>

All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
	Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
	Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the
	documentation and/or other materials provided with the distribution.
	Neither the name of Great Scott Gadgets nor the names of its contributors may be used to endorse or promote products derived from this software
	without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

import * as Comlink from "./node_modules/comlink/dist/esm/comlink.mjs";
import { HackRF } from "./hackrf.js";
import init, { FFT, DspProcessor, set_panic_hook } from "./hackrf-web/pkg/hackrf_web.js";

// wasm module (top-level import)
console.log('worker: imported');

let wasmInitialized = false;

async function ensureWasmInitialized() {
	if (!wasmInitialized) {
		console.log('worker: loading wasm...');
		await init();
		set_panic_hook();
		wasmInitialized = true;
		console.log('worker: wasm loaded');
	}
}

class Worker {
	constructor() {
	}

	async init() {
		console.log('init worker');
		await ensureWasmInitialized();
	}

	async open(opts) {
		const devices = await navigator.usb.getDevices();
		const device = !opts ? devices[0] : devices.find(d => {
			if (opts.vendorId) {
				if (d.vendorId !== opts.vendorId) {
					return false;
				}
			}
			if (opts.productId) {
				if (d.productId !== opts.productId) {
					return false;
				}
			}
			if (opts.serialNumber) {
				if (d.serialNumber !== opts.serialNumber) {
					return false;
				}
			}
			return true;
		});
		if (!device) {
			return false;
		}
		console.log(device);
		this.hackrf = new HackRF();
		await this.hackrf.open(device);
		return true;
	}

	async info() {
		const { hackrf } = this;
		const boardId = await hackrf.readBoardId();
		const versionString = await hackrf.readVersionString();
		const apiVersion = await hackrf.readApiVersion();
		const { partId, serialNo } = await hackrf.readPartIdSerialNo();

		let boardRev = HackRF.BOARD_REV_UNDETECTED;
		try {
			boardRev = await hackrf.boardRevRead();
		} catch (e) {
			console.log(e);
		}

		console.log(`Serial Number: ${serialNo.map((i) => (i + 0x100000000).toString(16).slice(1)).join('')}`)
		console.log(`Board ID Number: ${boardId} (${HackRF.BOARD_ID_NAME.get(boardId)})`);
		console.log(`Firmware Version: ${versionString} (API:${apiVersion[0]}.${apiVersion[1]}${apiVersion[2]})`);
		console.log(`Part ID Number: ${partId.map((i) => (i + 0x100000000).toString(16).slice(1)).join(' ')}`)
		console.log(`Board Rev: ${HackRF.BOARD_REV_NAME.get(boardRev)} (${boardRev})`)
		return { boardId, versionString, apiVersion, partId, serialNo };
	}

	async startRxStream(opts, spectrumCallback, audioCallback) {
		const { hackrf } = this;
		const { centerFreq, sampleRate, fftSize, lnaGain, vgaGain, ampEnabled } = opts;

		console.log('startRxStream:', { centerFreq, sampleRate, fftSize });

		await hackrf.setSampleRateManual(sampleRate, 1);
		await hackrf.setBasebandFilterBandwidth(
			HackRF.computeBasebandFilterBw(sampleRate)
		);
		await hackrf.setFreq(centerFreq * 1e6);
		console.log('startRxStream: hardware configured, starting RX...');

		// ── Spectrum FFT setup ────────────────────────────────────────
		const spectrumWindowFunc = (x) => {
			const alpha = 0.16;
			const a0 = (1.0 - alpha) / 2.0;
			const a1 = 1.0 / 2.0;
			const a2 = alpha / 2.0;
			return a0 - a1 * Math.cos(2 * Math.PI * x) + a2 * Math.cos(4 * Math.PI * x);
		};
		const spectrumWindow = new Float32Array(fftSize);
		for (let i = 0; i < fftSize; i++) {
			spectrumWindow[i] = spectrumWindowFunc(i / fftSize);
		}
		const spectrumFft = new FFT(fftSize, spectrumWindow);
		spectrumFft.set_smoothing_speed(0.6);
		const spectrumOutput = new Float32Array(fftSize);

		const iqBuffer = new Int8Array(fftSize * 2);
		let iqBufferPos = 0;
		let spectrumThrottle = 0;

		// ── FIR Filter Math (SDR++ dsp/taps & dsp/window) ──────────────
		const sinc = (x) => (x === 0.0) ? 1.0 : (Math.sin(x) / x);

		const cosineWindow = (n, N, coefs) => {
			let win = 0.0;
			let sign = 1.0;
			for (let i = 0; i < coefs.length; i++) {
				win += sign * coefs[i] * Math.cos(i * 2.0 * Math.PI * n / N);
				sign = -sign;
			}
			return win;
		};

		const nuttall = (n, N) => {
			const coefs = [0.355768, 0.487396, 0.144232, 0.012604];
			return cosineWindow(n, N, coefs);
		};

		const hzToRads = (freq, samplerate) => 2.0 * Math.PI * (freq / samplerate);

		const estimateTapCount = (transWidth, samplerate) => {
			return Math.floor(3.8 * samplerate / transWidth);
		};

		const windowedSincBase = (count, omega, windowFunc, norm = 1.0) => {
			const taps = new Float32Array(count);
			const half = count / 2.0;
			const corr = norm * omega / Math.PI;

			for (let i = 0; i < count; i++) {
				const t = i - half + 0.5;
				taps[i] = sinc(t * omega) * windowFunc(t - half, count) * corr;
			}
			return taps;
		};

		const lowPassTaps = (cutoff, transWidth, samplerate, oddTapCount = false) => {
			let count = estimateTapCount(transWidth, samplerate);
			if (oddTapCount && count % 2 === 0) count++;
			const omega = hzToRads(cutoff, samplerate);
			return windowedSincBase(count, omega, (n, N) => nuttall(n, N));
		};

		const highPassTaps = (cutoff, transWidth, samplerate, oddTapCount = false) => {
			let count = estimateTapCount(transWidth, samplerate);
			if (oddTapCount && count % 2 === 0) count++;
			const omega = hzToRads((samplerate / 2.0) - cutoff, samplerate);
			return windowedSincBase(count, omega, (n, N) => {
				return nuttall(n, N) * ((Math.abs(Math.round(n)) % 2 !== 0) ? -1.0 : 1.0);
			});
		};

		const bandPassTaps = (bandStart, bandStop, transWidth, samplerate, oddTapCount = false) => {
			let count = estimateTapCount(transWidth, samplerate);
			if (oddTapCount && count % 2 === 0) count++;
			const offsetOmega = hzToRads((bandStart + bandStop) / 2.0, samplerate);
			const omega = hzToRads((bandStop - bandStart) / 2.0, samplerate);
			return windowedSincBase(count, omega, (n, N) => {
				return 2.0 * Math.cos(offsetOmega * n) * nuttall(n, N);
			});
		};

		class FIRFilter {
			constructor(taps) {
				if (!taps) taps = new Float32Array([1.0]);
				this.setTaps(taps);
			}

			setTaps(taps) {
				this.taps = taps;
				this.history = new Float32Array(this.taps.length);
				this.histIdx = 0;
			}

			reset() {
				this.history.fill(0);
				this.histIdx = 0;
			}

			processOne(sample) {
				this.history[this.histIdx] = sample;
				let out = 0;
				let tapIdx = 0;

				// Circular buffer dot product
				// From histIdx down to 0
				for (let i = this.histIdx; i >= 0; i--) {
					out += this.history[i] * this.taps[tapIdx++];
				}
				// From end of history buffer down to histIdx + 1
				for (let i = this.history.length - 1; i > this.histIdx; i--) {
					out += this.history[i] * this.taps[tapIdx++];
				}

				this.histIdx++;
				if (this.histIdx >= this.history.length) this.histIdx = 0;

				return out;
			}
		}

		// Math greatest common divisor for rational resampling
		const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));

		class PolyphaseResampler {
			constructor(interp, decim, taps) {
				this.interp = interp;
				this.decim = decim;
				this.taps = taps;

				// Build filter bank (buildPolyphaseBank from SDR++)
				this.phaseCount = interp;
				this.tapsPerPhase = Math.floor((taps.length + this.phaseCount - 1) / this.phaseCount);
				this.phases = new Array(this.phaseCount);

				for (let i = 0; i < this.phaseCount; i++) {
					this.phases[i] = new Float32Array(this.tapsPerPhase);
				}

				const totTapCount = this.phaseCount * this.tapsPerPhase;
				for (let i = 0; i < totTapCount; i++) {
					const phaseIdx = (this.phaseCount - 1) - (i % this.phaseCount);
					const tapIdx = Math.floor(i / this.phaseCount);
					this.phases[phaseIdx][tapIdx] = (i < taps.length) ? taps[i] : 0.0;
				}

				this.buffer = new Float32Array(this.tapsPerPhase - 1 + 64000); // Need enough space for block
				this.bufStartOffset = this.tapsPerPhase - 1;
				this.phase = 0;
				this.offset = 0;
			}

			process(input, count) {
				const out = [];

				// Copy input to buffer (shifting along in the delay line)
				// We assume buffer handles max chunk sizes appropriately.
				this.buffer.set(input.subarray(0, count), this.bufStartOffset);

				while (this.offset < count) {
					// Do convolution
					let sum = 0.0;
					const phaseTaps = this.phases[this.phase];
					for (let i = 0; i < this.tapsPerPhase; i++) {
						sum += this.buffer[this.offset + i] * phaseTaps[i];
					}
					out.push(sum);

					// Increment phase
					this.phase += this.decim;

					// Branchless phase advance if phase wrap arround occurs
					this.offset += Math.floor(this.phase / this.interp);

					// Wrap around if needed
					this.phase = this.phase % this.interp;
				}
				this.offset -= count;

				// Move delay (memmove in c++)
				this.buffer.copyWithin(0, count, count + this.tapsPerPhase - 1);

				return new Float32Array(out);
			}
		}

		class RationalResampler {
			constructor(inSamplerate, outSamplerate) {
				const IntSR = Math.round(inSamplerate);
				const OutSR = Math.round(outSamplerate);
				const divider = gcd(IntSR, OutSR);

				this.interp = OutSR / divider;
				this.decim = IntSR / divider;

				const tapSamplerate = inSamplerate * this.interp;
				const tapBandwidth = Math.min(inSamplerate, outSamplerate) / 2.0;
				const tapTransWidth = tapBandwidth * 0.1;

				// Generate taps and multiply by interp
				let taps = lowPassTaps(tapBandwidth, tapTransWidth, tapSamplerate);
				for (let i = 0; i < taps.length; i++) taps[i] *= this.interp;

				this.resamp = new PolyphaseResampler(this.interp, this.decim, taps);
			}

			process(input) {
				return this.resamp.process(input, input.length);
			}
		}

		// ── Audio DDC setup ───────────────────────────────────────────
		// Full SDR++ pipeline in Rust: NCO → polyphase resampler (→50kHz)
		// → channel FIR → squelch → FM demod → post-demod FIR → audio resampler (→48kHz)
		const initialBandwidth = 150000;

		// Free any existing DDCs
		if (this.ddcs) this.ddcs.forEach(d => { try { d.free(); } catch(_){} });

		// Initialize dynamic VFO arrays (start with one VFO)
		const defaultVfoParams = { freq: centerFreq, mode: 'wfm', enabled: false, deEmphasis: '50us', squelchEnabled: false, squelchLevel: -100.0, lowPass: true, highPass: false, bandwidth: initialBandwidth, volume: 50 };
		this.vfoParams = [{ ...defaultVfoParams }];
		this.ddcs = [new DspProcessor(sampleRate, 0.0, initialBandwidth)];

		// IF sample rates per mode (matches SDR++ getIFSampleRate())
		const IF_RATES = {
			nfm: 50000,
			wfm: 250000,
			am: 15000,
			usb: 24000,
			lsb: 24000,
			dsb: 24000,
			cw: 3000,
			raw: 48000,
		};
		const AUDIO_RATE = 48000;
		// Use the max possible IF rate (WFM 250kHz) for buffer sizing
		const MAX_IF_RATE = 250000;
		const maxDdcOut = Math.ceil(131072 * MAX_IF_RATE / sampleRate) * 2 + 4096;
		this.ddcOutputs = [new Float32Array(maxDdcOut)];

		// ── Audio Demodulator state (matching SDR++ radio_module.h) ───
		const makeVfoState = () => ({
			// AM demod state (non-FM modes use JS-side demod)
			dcAvg: 0,
			carrierAgcGain: 1.0,
			// De-emphasis (SDR++ style: y = alpha*x + (1-alpha)*y_prev)
			deemphPrev: 0,
			// AGC state (SDR++ loop::AGC style)
			agcGain: 1.0,
			// SSB/CW frequency translator state
			ssbPhase: 0,
			// CW tone
			cwTone: 700,
			// Block count
			chunkCount: 0,
			// Non-FM audio resampler (IF → 48 kHz, polyphase)
			audioResampler: new RationalResampler(IF_RATES.nfm, AUDIO_RATE),
			// Track the current IF rate
			currentIfRate: IF_RATES.nfm,
			// Track last bandwidth sent to Rust
			lastBandwidth: initialBandwidth,
			// Track last mode to detect mode switches
			lastMode: '',
		});
		this.vfoStates = [makeVfoState()];

		// Store factories for addVfo/removeVfo
		this._makeVfoState = makeVfoState;
		this._sampleRate = sampleRate;
		this._maxDdcOut = maxDdcOut;
		this._centerFreq = centerFreq;

		// ── DSP Performance Counters ──────────────────────────────────
		const perf = {
			usbCallbacks: 0,      // USB transfer callbacks received
			audioCalls: 0,        // times audio DSP ran
			audioSamplesOut: 0,   // total audio samples produced
			dspTimeSum: 0,        // cumulative DSP processing time (ms)
			dspTimeMax: 0,        // worst-case DSP time this interval
			inputSamplesSum: 0,   // IQ samples received
			droppedChunks: 0,     // chunks where process() returned 0
			msgsSent: 0,          // Comlink audio messages sent to main thread
			lastReportTime: performance.now(),
			// Snapshot for reporting
			report: {
				usbFps: 0, audioFps: 0, dspAvgMs: 0, dspMaxMs: 0,
				audioRate: 0, inputRate: 0, dropped: 0, chunkSize: 0,
			},
		};
		this._perf = perf;

		// Update report snapshot every 500ms
		this._perfInterval = setInterval(() => {
			const now = performance.now();
			const dt = (now - perf.lastReportTime) / 1000; // seconds
			if (dt < 0.1) return;
			perf.report = {
				usbFps: Math.round(perf.usbCallbacks / dt),
				audioFps: Math.round(perf.audioCalls / dt),
				dspAvgMs: perf.audioCalls > 0 ? (perf.dspTimeSum / perf.audioCalls).toFixed(2) : '0',
				dspMaxMs: perf.dspTimeMax.toFixed(2),
				audioRate: Math.round(perf.audioSamplesOut / dt),
				inputRate: Math.round(perf.inputSamplesSum / dt),
				dropped: perf.droppedChunks,
				chunkSize: perf.lastChunkSize || 0,
				msgRate: Math.round(perf.msgsSent / dt),
			};
			perf.usbCallbacks = 0;
			perf.audioCalls = 0;
			perf.audioSamplesOut = 0;
			perf.dspTimeSum = 0;
			perf.dspTimeMax = 0;
			perf.inputSamplesSum = 0;
			perf.droppedChunks = 0;
			perf.msgsSent = 0;
			perf.lastReportTime = now;
		}, 500);

		// ── Audio Batching Buffer ─────────────────────────────────────
		// At high sample rates (20 MHz), USB delivers 152+ chunks/s.
		// Each produces ~315 audio samples. Sending 152 Comlink messages/s
		// floods the main thread. Instead, batch audio and flush at ~20/s.
		const AUDIO_BATCH_THRESHOLD = 2400; // 50ms at 48kHz
		let audioBatchBuf = new Float32Array(4800); // 100ms capacity
		let audioBatchPos = 0;

		const flushAudio = () => {
			if (audioBatchPos > 0) {
				perf.msgsSent++;
				audioCallback(audioBatchBuf.slice(0, audioBatchPos));
				audioBatchPos = 0;
			}
		};

		const pushAudio = (samples) => {
			let srcOff = 0;
			while (srcOff < samples.length) {
				const space = audioBatchBuf.length - audioBatchPos;
				const toCopy = Math.min(space, samples.length - srcOff);
				audioBatchBuf.set(samples.subarray(srcOff, srcOff + toCopy), audioBatchPos);
				audioBatchPos += toCopy;
				srcOff += toCopy;

				if (audioBatchPos >= AUDIO_BATCH_THRESHOLD) {
					flushAudio();
				}
			}
		};

		// ── Audio Processing — helper processes a single VFO ──────────
		// Returns Float32Array of audio samples, or null if none produced
		const processVfoAudio = (signed, ddc, params, vfoState, ddcOut) => {
			if (!params.enabled) return null;

			// Shift freq: The tuned freq relative to the center freq
			const shiftHz = (params.freq - centerFreq) * 1e6;
			ddc.set_shift(sampleRate, shiftHz);

			const mode = params.mode;
			const bw = params.bandwidth || 150000;

			// Detect mode switch → reconfigure IF rate & reset all DSP state
			if (mode !== vfoState.lastMode) {
				vfoState.lastMode = mode;
				vfoState.deemphPrev = 0;
				vfoState.dcAvg = 0;
				vfoState.agcGain = 1.0;
				vfoState.ssbPhase = 0;

				ddc.set_wfm_mode(mode === 'wfm');

				const newIfRate = IF_RATES[mode] || IF_RATES.nfm;
				if (newIfRate !== vfoState.currentIfRate) {
					vfoState.currentIfRate = newIfRate;
					ddc.set_if_sample_rate(newIfRate);
					vfoState.audioResampler = new RationalResampler(newIfRate, AUDIO_RATE);
				} else {
					ddc.reset();
				}
			}

			// Update bandwidth in Rust if changed
			if (bw !== vfoState.lastBandwidth) {
				ddc.set_bandwidth(bw);
				vfoState.lastBandwidth = bw;
			}

			// Update squelch in Rust
			ddc.set_squelch(
				params.squelchLevel || -100.0,
				!!params.squelchEnabled
			);

			if (mode === 'wfm' || mode === 'nfm') {
				// ── FM Path: Full pipeline in Rust (matches SDR++ exactly) ────
				const t0 = performance.now();
				const numAudioSamples = ddc.process(signed, ddcOut);
				const elapsed = performance.now() - t0;
				perf.audioCalls++;
				perf.dspTimeSum += elapsed;
				if (elapsed > perf.dspTimeMax) perf.dspTimeMax = elapsed;
				if (numAudioSamples === 0) { perf.droppedChunks++; return null; }
				perf.audioSamplesOut += numAudioSamples;

				let result = new Float32Array(ddcOut.subarray(0, numAudioSamples));

				// ── De-emphasis (SDR++ filter/deephasis.h) ────────────────
				if (params.deEmphasis !== 'none') {
					const dt = 1.0 / AUDIO_RATE;
					let tau;
					switch (params.deEmphasis) {
						case '22us': tau = 22e-6; break;
						case '50us': tau = 50e-6; break;
						case '75us': tau = 75e-6; break;
						default: tau = 50e-6; break;
					}
					const alpha = dt / (tau + dt);
					for (let i = 0; i < result.length; i++) {
						vfoState.deemphPrev = alpha * result[i] + (1 - alpha) * vfoState.deemphPrev;
						result[i] = vfoState.deemphPrev;
					}
				}

				// Hard-clip as safety net
				for (let i = 0; i < result.length; i++) {
					if (result[i] > 1.0) result[i] = 1.0;
					else if (result[i] < -1.0) result[i] = -1.0;
				}

				return result;
			} else {
				// ── Non-FM Path: NCO + resampler + channel FIR in Rust, demod in JS ──
				const numOutValues = ddc.process_iq_only(signed, ddcOut);
				const numDemodSamples = numOutValues / 2;
				if (numDemodSamples === 0) return null;

				// ── Squelch (SDR++ style: average magnitude in dB) ────────
				let squelchMag = 0;
				for (let i = 0; i < numDemodSamples; i++) {
					const dI = ddcOut[i * 2];
					const dQ = ddcOut[i * 2 + 1];
					squelchMag += Math.sqrt(dI * dI + dQ * dQ);
				}
				squelchMag /= numDemodSamples;
				const squelchDb = 10 * Math.log10(squelchMag + 1e-12);

				if (params.squelchEnabled && squelchDb < params.squelchLevel) {
					const zeros = new Float32Array(numDemodSamples);
					const result = vfoState.audioResampler.process(zeros);
					return result.length > 0 ? result : null;
				}

				const audioDemodRateSamples = new Float32Array(numDemodSamples);
				const ifRate = vfoState.currentIfRate;

				if (mode === 'am') {
					for (let i = 0; i < numDemodSamples; i++) {
						const dI = ddcOut[i * 2];
						const dQ = ddcOut[i * 2 + 1];
						const mag = Math.sqrt(dI * dI + dQ * dQ);
						const dcAlpha = 0.9999;
						vfoState.dcAvg = dcAlpha * vfoState.dcAvg + (1 - dcAlpha) * mag;
						let demodSample = mag - vfoState.dcAvg;
						const agcAttack = 50.0 / ifRate;
						const agcDecay = 5.0 / ifRate;
						const absSample = Math.abs(demodSample);
						if (absSample > vfoState.agcGain) {
							vfoState.agcGain = vfoState.agcGain * (1 - agcAttack) + absSample * agcAttack;
						} else {
							vfoState.agcGain = vfoState.agcGain * (1 - agcDecay) + absSample * agcDecay;
						}
						const agcScale = vfoState.agcGain > 1e-6 ? (0.5 / vfoState.agcGain) : 1.0;
						audioDemodRateSamples[i] = demodSample * agcScale;
					}
				}
				else if (mode === 'usb' || mode === 'lsb' || mode === 'dsb') {
					for (let i = 0; i < numDemodSamples; i++) {
						const dI = ddcOut[i * 2];
						const dQ = ddcOut[i * 2 + 1];
						let shiftFreq = 0;
						if (mode === 'usb') shiftFreq = bw / 2.0;
						else if (mode === 'lsb') shiftFreq = -bw / 2.0;
						const phaseInc = (shiftFreq / ifRate) * 2 * Math.PI;
						vfoState.ssbPhase += phaseInc;
						if (vfoState.ssbPhase > Math.PI) vfoState.ssbPhase -= 2 * Math.PI;
						if (vfoState.ssbPhase < -Math.PI) vfoState.ssbPhase += 2 * Math.PI;
						const cosP = Math.cos(vfoState.ssbPhase);
						const sinP = Math.sin(vfoState.ssbPhase);
						const rI = dI * cosP - dQ * sinP;
						let demodSample = rI;
						const agcAttack = 50.0 / ifRate;
						const agcDecay = 5.0 / ifRate;
						const absSample = Math.abs(demodSample);
						if (absSample > vfoState.agcGain) {
							vfoState.agcGain = vfoState.agcGain * (1 - agcAttack) + absSample * agcAttack;
						} else {
							vfoState.agcGain = vfoState.agcGain * (1 - agcDecay) + absSample * agcDecay;
						}
						const agcScale = vfoState.agcGain > 1e-6 ? (0.5 / vfoState.agcGain) : 1.0;
						audioDemodRateSamples[i] = demodSample * agcScale;
					}
				}
				else if (mode === 'cw') {
					for (let i = 0; i < numDemodSamples; i++) {
						const dI = ddcOut[i * 2];
						const dQ = ddcOut[i * 2 + 1];
						const cwTone = vfoState.cwTone || 700;
						const phaseInc = (cwTone / ifRate) * 2 * Math.PI;
						vfoState.ssbPhase += phaseInc;
						if (vfoState.ssbPhase > Math.PI) vfoState.ssbPhase -= 2 * Math.PI;
						if (vfoState.ssbPhase < -Math.PI) vfoState.ssbPhase += 2 * Math.PI;
						const cosP = Math.cos(vfoState.ssbPhase);
						const sinP = Math.sin(vfoState.ssbPhase);
						const rI = dI * cosP - dQ * sinP;
						let demodSample = rI;
						const agcAttack = 50.0 / ifRate;
						const agcDecay = 5.0 / ifRate;
						const absSample = Math.abs(demodSample);
						if (absSample > vfoState.agcGain) {
							vfoState.agcGain = vfoState.agcGain * (1 - agcAttack) + absSample * agcAttack;
						} else {
							vfoState.agcGain = vfoState.agcGain * (1 - agcDecay) + absSample * agcDecay;
						}
						const agcScale = vfoState.agcGain > 1e-6 ? (0.5 / vfoState.agcGain) : 1.0;
						audioDemodRateSamples[i] = demodSample * agcScale;
					}
				}
				else if (mode === 'raw') {
					for (let i = 0; i < numDemodSamples; i++) {
						audioDemodRateSamples[i] = ddcOut[i * 2];
					}
				}
				else {
					audioDemodRateSamples.fill(0);
				}

				let result = vfoState.audioResampler.process(audioDemodRateSamples);
				if (result.length === 0) return null;

				for (let i = 0; i < result.length; i++) {
					if (result[i] > 1.0) result[i] = 1.0;
					else if (result[i] < -1.0) result[i] = -1.0;
				}

				return result;
			}
		};

		await hackrf.startRx((data) => {
			perf.usbCallbacks++;

			// 1. Waterfall / Spectrum processing
			const signed = new Int8Array(data.buffer, data.byteOffset, data.length);
			perf.lastChunkSize = signed.length;
			perf.inputSamplesSum += signed.length / 2;
			for (let i = 0; i < signed.length; i++) {
				iqBuffer[iqBufferPos++] = signed[i];
				if (iqBufferPos >= iqBuffer.length) {
					iqBufferPos = 0;
					spectrumThrottle++;
					// ~30 fps update
					if (spectrumThrottle % 15 === 0) {
						spectrumFft.fft(iqBuffer, spectrumOutput);
						spectrumCallback(new Float32Array(spectrumOutput));
					}
				}
			}

			// 2. Audio Processing — process all VFOs and mix
			try {
				const vfoOutputs = [];
				for (let v = 0; v < this.vfoParams.length; v++) {
					if (!this.ddcs[v] || !this.vfoStates[v] || !this.ddcOutputs[v]) continue;
					this.vfoStates[v].chunkCount++;
					const out = processVfoAudio(signed, this.ddcs[v], this.vfoParams[v], this.vfoStates[v], this.ddcOutputs[v]);
					if (out) vfoOutputs.push({ audio: out, volume: this.vfoParams[v].volume || 50 });
				}

				if (vfoOutputs.length === 1) {
					// Single VFO: apply volume and push
					const { audio, volume } = vfoOutputs[0];
					const v = volume / 100;
					const vol = v * v;
					for (let i = 0; i < audio.length; i++) {
						audio[i] *= vol;
						if (audio[i] > 1.0) audio[i] = 1.0;
						else if (audio[i] < -1.0) audio[i] = -1.0;
					}
					pushAudio(audio);
				} else if (vfoOutputs.length > 1) {
					// Mix multiple VFOs with per-VFO volume (SDR++ volume² curve)
					const maxLen = Math.max(...vfoOutputs.map(o => o.audio.length));
					const mixed = new Float32Array(maxLen);
					for (const { audio, volume } of vfoOutputs) {
						const v = volume / 100;
						const vol = v * v;
						for (let i = 0; i < audio.length; i++) {
							mixed[i] += audio[i] * vol;
						}
					}
					// Hard clip
					for (let i = 0; i < maxLen; i++) {
						if (mixed[i] > 1.0) mixed[i] = 1.0;
						else if (mixed[i] < -1.0) mixed[i] = -1.0;
					}
					pushAudio(mixed);
				}
			} catch (e) {
				console.error('Audio DSP error:', e.message || e);
			}
		});

		if (ampEnabled !== undefined) await hackrf.setAmpEnable(ampEnabled);
		if (lnaGain !== undefined) await hackrf.setLnaGain(lnaGain);
		if (vgaGain !== undefined) await hackrf.setVgaGain(vgaGain);
	}

	getDspStats() {
		return this._perf ? this._perf.report : null;
	}

	setVfoParams(index, params) {
		if (!this.vfoParams || index < 0 || index >= this.vfoParams.length) return;
		Object.assign(this.vfoParams[index], params);

		if (this.ddcs && this.ddcs[index]) {
			if (params.bandwidth !== undefined) {
				this.ddcs[index].set_bandwidth(params.bandwidth);
			}
			if (params.squelchLevel !== undefined || params.squelchEnabled !== undefined) {
				this.ddcs[index].set_squelch(
					this.vfoParams[index].squelchLevel || -100.0,
					!!this.vfoParams[index].squelchEnabled
				);
			}
		}
	}

	addVfo() {
		if (!this.vfoParams) return -1;
		const centerFreq = this._centerFreq || 100.0;
		const bw = 150000;
		const params = { freq: centerFreq, mode: 'wfm', enabled: false, deEmphasis: '50us', squelchEnabled: false, squelchLevel: -100.0, lowPass: true, highPass: false, bandwidth: bw, volume: 50 };
		this.vfoParams.push(params);
		this.ddcs.push(new DspProcessor(this._sampleRate, 0.0, bw));
		this.vfoStates.push(this._makeVfoState());
		this.ddcOutputs.push(new Float32Array(this._maxDdcOut));
		return this.vfoParams.length - 1;
	}

	removeVfo(index) {
		if (!this.vfoParams || index < 0 || index >= this.vfoParams.length) return;
		if (this.vfoParams.length <= 1) return; // Keep at least one VFO
		try { this.ddcs[index].free(); } catch(_) {}
		this.vfoParams.splice(index, 1);
		this.ddcs.splice(index, 1);
		this.vfoStates.splice(index, 1);
		this.ddcOutputs.splice(index, 1);
	}

	async setSampleRateManual(freq, divider) {
		await this.hackrf.setSampleRateManual(freq, divider);
	}

	async setBasebandFilterBandwidth(bandwidthHz) {
		await this.hackrf.setBasebandFilterBandwidth(bandwidthHz);
	}

	async setLnaGain(value) {
		await this.hackrf.setLnaGain(value);
	}

	async setVgaGain(value) {
		await this.hackrf.setVgaGain(value);
	}

	async setFreq(freqHz) {
		await this.hackrf.setFreq(freqHz);
	}

	async setAmpEnable(enable) {
		await this.hackrf.setAmpEnable(enable);
	}

	async setAntennaEnable(enable) {
		await this.hackrf.setAntennaEnable(enable);
	}

	async initSweep(ranges, numBytes, stepWidth, offset, style) {
		await this.hackrf.initSweep(ranges, numBytes, stepWidth, offset, style);
	}

	async startRx(callback) {
		await this.hackrf.startRx(callback);
	}

	async startRxSweep(callback) {
		await this.hackrf.startRxSweep(callback);
	}

	async stopRx() {
		await this.hackrf.stopRx();
	}

	async close() {
		await this.hackrf.close();
		await this.hackrf.exit();
		await this.hackrf.device.forget();
	}
}

console.log('worker: before Comlink.expose');
Comlink.expose(Worker);
console.log('worker: after Comlink.expose');
