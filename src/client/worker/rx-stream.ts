/*
Copyright (c) 2026, jLynx <https://github.com/jLynx>

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

import * as Comlink from 'comlink';
import { FFT } from './wasm-init';
import { RationalResampler } from './dsp-pipeline';
import { POCSAGDecoder } from './pocsag';
import type { RxStreamOpts, VfoParams, VfoState, PerfCounters } from './types';
import { IF_RATES, AUDIO_RATE } from './types';
import type { Backend } from './backend';

let _streamStarting = false;

export async function startRxStream(
	backend: Backend,
	opts: RxStreamOpts,
	spectrumCallback: any,
	audioCallback: any,
	whisperCallback: any,
	pocsagCallback: any
): Promise<void> {
	if (_streamStarting) return;
	_streamStarting = true;
	backend._remoteClientAudioCb = audioCallback; // Save reference for when chunk arrives
	backend._remoteClientWhisperCb = whisperCallback; // Save for remote client transcription
	try {
		const { device } = backend;
		if (!device) throw new Error('No device connected');
		const { centerFreq, sampleRate, fftSize, gains } = opts;

		await device.setSampleRate(sampleRate);
		await device.setFrequency(centerFreq * 1e6);

		// ── Spectrum FFT setup ────────────────────────────────────────
		const spectrumWindowFunc = (x: number): number => {
			const n = x * fftSize;
			const N = fftSize;
			const a0 = 0.355768;
			const a1 = 0.487396;
			const a2 = 0.144232;
			const a3 = 0.012604;
			return a0 - a1 * Math.cos(2.0 * Math.PI * n / N) + a2 * Math.cos(4.0 * Math.PI * n / N) - a3 * Math.cos(6.0 * Math.PI * n / N);
		};
		const spectrumWindow = new Float32Array(fftSize);
		for (let i = 0; i < fftSize; i++) {
			spectrumWindow[i] = spectrumWindowFunc(i / fftSize);
		}
		const spectrumFft = new FFT(fftSize, spectrumWindow);
		spectrumFft.set_smoothing_speed(0.6);
		const spectrumOutput = new Float32Array(fftSize);

		// Double buffer for Comlink zero-copy memory transfers
		let specFlip = new Float32Array(fftSize);
		let specFlop = new Float32Array(fftSize);
		let useFlip = true;

		const iqBuffer = new Int8Array(fftSize * 2);
		let iqBufferPos = 0;
		const targetFftFps = 20;
		const spectrumIntervalMs = 1000 / targetFftFps;  // 50ms for 20fps
		let lastSpectrumTime = 0;

		// ── Audio DDC setup ───────────────────────────────────────────
		// Full SDR++ pipeline in Rust: NCO → polyphase resampler (→50kHz)
		// → channel FIR → squelch → FM demod → post-demod FIR → audio resampler (→48kHz)
		const initialBandwidth = 150000;

		// Free any existing DDCs and timers
		if (backend.ddcs) backend.ddcs.forEach((d: any) => { try { d.free(); } catch (_) { } });
		if (backend._perfInterval) { clearInterval(backend._perfInterval); backend._perfInterval = undefined; }

		// Initialize dynamic VFO arrays (start with one VFO)
		const defaultVfoParams: VfoParams = { freq: centerFreq, mode: 'wfm', enabled: false, deEmphasis: '50us', squelchEnabled: false, squelchLevel: -100.0, lowPass: true, highPass: false, bandwidth: initialBandwidth, volume: 50, pocsag: false };
		backend.vfoParams = [{ ...defaultVfoParams }];

		const MAX_USB_SAMPLES = 131072;
		const SHARED_IQ_CAPACITY = MAX_USB_SAMPLES * 2;
		const SAB_POOL_SIZE = 8;
		backend.sabPoolIndex = 0;

		backend.sharedIqPools = [];
		backend.sharedIqViews = [];
		for (let i = 0; i < SAB_POOL_SIZE; i++) {
			const pool = typeof SharedArrayBuffer !== 'undefined'
				? new SharedArrayBuffer(SHARED_IQ_CAPACITY)
				: new ArrayBuffer(SHARED_IQ_CAPACITY);
			backend.sharedIqPools.push(pool);
			backend.sharedIqViews.push(new Int8Array(pool));
		}

		const makeVfoState = (): VfoState => ({
			squelchOpen: false,
			pocsagDecoder: null,
			audioQueue: new Float32Array(32768),
			audioQueueLen: 0,
		});
		backend.vfoStates = [makeVfoState()];
		backend.dspWorkers = [];

		const spawnWorker = (index: number, params: VfoParams): Worker => {
			const worker = new globalThis.Worker(new URL('../dsp-worker.ts', import.meta.url), { type: 'module' });
			worker.onmessage = (e: MessageEvent) => {
				const msg = e.data;
				if (msg.type === "audio") {
					backend._handleWorkerAudio!(index, msg);
				} else if (msg.type === "error") {
					console.error(`[DSP Worker ${index}] Error:`, msg.error);
				}
			};
			worker.postMessage({
				type: 'init',
				sampleRate: sampleRate,
				centerFreq: centerFreq,
				params: params,
				sabs: typeof SharedArrayBuffer !== 'undefined' ? backend.sharedIqPools : null
			});
			return worker;
		};
		backend.dspWorkers.push(spawnWorker(0, backend.vfoParams[0]));

		backend._makeVfoState = makeVfoState;
		backend._spawnWorker = spawnWorker;
		backend._sampleRate = sampleRate;
		backend._centerFreq = centerFreq;

		// ── DSP Performance Counters ──────────────────────────────────
		const perf: PerfCounters = {
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
		backend._perf = perf;

		// Update report snapshot every 500ms
		backend._perfInterval = setInterval(() => {
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

		// ── Per-VFO Whisper Batching ──────────────────────────────────
		// Each VFO gets its own batch buffer so Whisper receives isolated
		// (pre-mix, pre-volume) audio for accurate per-VFO transcription.
		const WHISPER_BATCH_THRESHOLD = 2400;
		const whisperBatchBufs: Float32Array[] = [];   // Float32Array per VFO
		const whisperBatchPos: number[] = [];    // write position per VFO
		const ensureWhisperBuf = (v: number): void => {
			if (!whisperBatchBufs[v]) {
				whisperBatchBufs[v] = new Float32Array(4800);
				whisperBatchPos[v] = 0;
			}
		};
		const pushWhisper = (v: number, freq: number, samples: Float32Array): void => {
			if (!whisperCallback) return;
			ensureWhisperBuf(v);
			let srcOff = 0;
			while (srcOff < samples.length) {
				const space = whisperBatchBufs[v].length - whisperBatchPos[v];
				const toCopy = Math.min(space, samples.length - srcOff);
				whisperBatchBufs[v].set(samples.subarray(srcOff, srcOff + toCopy), whisperBatchPos[v]);
				whisperBatchPos[v] += toCopy;
				srcOff += toCopy;
				if (whisperBatchPos[v] >= WHISPER_BATCH_THRESHOLD) {
					const wCopy = whisperBatchBufs[v].slice(0, whisperBatchPos[v]);
					whisperCallback(v, freq, Comlink.transfer(wCopy, [wCopy.buffer]));
					whisperBatchPos[v] = 0;
				}
			}
		};

		const flushAudio = (): void => {
			if (audioBatchPos > 0) {
				perf.msgsSent++;
				const aCopy = audioBatchBuf.slice(0, audioBatchPos);
				audioCallback(Comlink.transfer(aCopy, [aCopy.buffer]));
				audioBatchPos = 0;
			}
		};

		const pushAudio = (samples: Float32Array): void => {
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
		const processVfoAudio = (iqPtr: number, numIqBytes: number, ddc: any, params: VfoParams, vfoState: VfoState): Float32Array | null => {
			// Mute = silence the speakers, not stop DSP. Still run the pipeline
			// when POCSAG decoding is active so messages aren't lost while muted.
			if (!params.enabled && !params.pocsag) return null;

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
				vfoState.pocsagDecoder = null;  // reset POCSAG on mode change

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
				const outPtr = ddc.process_ptr(iqPtr, numIqBytes);
				const numAudioSamples = ddc.get_output_len();
				const elapsed = performance.now() - t0;
				perf.audioCalls++;
				perf.dspTimeSum += elapsed;
				if (elapsed > perf.dspTimeMax) perf.dspTimeMax = elapsed;
				if (numAudioSamples === 0) { perf.droppedChunks++; vfoState.squelchOpen = false; return null; }
				perf.audioSamplesOut += numAudioSamples;

				// Create float32 view of the returned pointer
				const result = new Float32Array(backend.wasm.memory.buffer, outPtr, numAudioSamples);

				// Detect if Rust squelch is blocking: output is all zeros when closed.
				// Sample a handful of values to check for actual audio energy.
				if (params.squelchEnabled) {
					let sumSq = 0;
					const checkLen = Math.min(numAudioSamples, 256);
					for (let i = 0; i < checkLen; i++) sumSq += result[i] * result[i];
					vfoState.squelchOpen = sumSq > 1e-10;
				} else {
					vfoState.squelchOpen = false;
				}

				// ── De-emphasis + hard-clip combined in one pass ──────────
				if (params.deEmphasis !== 'none') {
					const dt = 1.0 / AUDIO_RATE;
					let tau: number;
					switch (params.deEmphasis) {
						case '22us': tau = 22e-6; break;
						case '50us': tau = 50e-6; break;
						case '75us': tau = 75e-6; break;
						default: tau = 50e-6; break;
					}
					const alpha = dt / (tau + dt);
					const oneMinusAlpha = 1.0 - alpha;
					let prev = vfoState.deemphPrev!;
					for (let i = 0; i < numAudioSamples; i++) {
						prev = alpha * result[i] + oneMinusAlpha * prev;
						result[i] = prev < -1.0 ? -1.0 : prev > 1.0 ? 1.0 : prev;
					}
					vfoState.deemphPrev = prev;
				} else {
					// Hard-clip only
					for (let i = 0; i < numAudioSamples; i++) {
						if (result[i] > 1.0) result[i] = 1.0;
						else if (result[i] < -1.0) result[i] = -1.0;
					}
				}

				// We MUST create a fast slice/copy here!
				// The `result` array memory view points inside the WASM heap.
				// Returning the raw view and passing it to postMessage / AudioWorklet
				// can cause the browser to clone the *entire* WASM Memory buffer (16MB+),
				// destroying performance and causing massive lag spikes.

				// To avoid massive GC pressure from continually calling result.slice() and
				// allocating thousands of Float32Arrays per second, we set into a persistent pool:
				if (numAudioSamples > vfoState.audioTarget!.length) {
					vfoState.audioTarget = new Float32Array(numAudioSamples + 1024);
				}
				const outView = vfoState.audioTarget!.subarray(0, numAudioSamples);
				outView.set(result); // Zero-allocation copy!
				return outView;
			} else {
				// ── Non-FM Path: NCO + resampler + channel FIR in Rust, demod in JS ──
				const outPtr = ddc.process_iq_only_ptr(iqPtr, numIqBytes);
				const numOutValues = ddc.get_iq_output_len();
				const numDemodSamples = numOutValues / 2;
				if (numDemodSamples === 0) return null;

				const _ddcOut = new Float32Array(backend.wasm.memory.buffer, outPtr, numOutValues);

				// ── Squelch (SDR++ style: average magnitude in dB) ────────
				let squelchMag = 0;
				for (let i = 0; i < numDemodSamples; i++) {
					const dI = _ddcOut[i * 2];
					const dQ = _ddcOut[i * 2 + 1];
					squelchMag += Math.sqrt(dI * dI + dQ * dQ);
				}
				squelchMag /= numDemodSamples;
				const squelchDb = 10 * Math.log10(squelchMag + 1e-12);

				// Grow the shared scratch buffer if this block is larger than expected
				if (numDemodSamples > vfoState.scratchBuf!.length) {
					vfoState.scratchBuf = new Float32Array(numDemodSamples + 128);
				}
				const audioDemodRateSamples = vfoState.scratchBuf!.subarray(0, numDemodSamples);

				if (params.squelchEnabled && squelchDb < params.squelchLevel) {
					vfoState.squelchOpen = false;
					// Pass the pre-zeroed scratch slice (fill only what we use)
					audioDemodRateSamples.fill(0);
					const result = vfoState.audioResampler!.process(audioDemodRateSamples);
					return result.length > 0 ? result : null;
				}
				// Signal is above squelch threshold — mark as receiving
				vfoState.squelchOpen = params.squelchEnabled && squelchDb >= params.squelchLevel;

				const ifRate = vfoState.currentIfRate!;

				if (mode === 'am') {
					for (let i = 0; i < numDemodSamples; i++) {
						const dI = _ddcOut[i * 2];
						const dQ = _ddcOut[i * 2 + 1];
						const mag = Math.sqrt(dI * dI + dQ * dQ);
						const dcAlpha = 0.9999;
						vfoState.dcAvg = dcAlpha * vfoState.dcAvg! + (1 - dcAlpha) * mag;
						let demodSample = mag - vfoState.dcAvg!;
						const agcAttack = 50.0 / ifRate;
						const agcDecay = 5.0 / ifRate;
						const absSample = Math.abs(demodSample);
						if (absSample > vfoState.agcGain!) {
							vfoState.agcGain = vfoState.agcGain! * (1 - agcAttack) + absSample * agcAttack;
						} else {
							vfoState.agcGain = vfoState.agcGain! * (1 - agcDecay) + absSample * agcDecay;
						}
						const agcScale = vfoState.agcGain! > 1e-6 ? (0.5 / vfoState.agcGain!) : 1.0;
						audioDemodRateSamples[i] = demodSample * agcScale;
					}
				}
				else if (mode === 'usb' || mode === 'lsb' || mode === 'dsb') {
					for (let i = 0; i < numDemodSamples; i++) {
						const dI = _ddcOut[i * 2];
						const dQ = _ddcOut[i * 2 + 1];
						let shiftFreq = 0;
						if (mode === 'usb') shiftFreq = bw / 2.0;
						else if (mode === 'lsb') shiftFreq = -bw / 2.0;
						const phaseInc = (shiftFreq / ifRate) * 2 * Math.PI;
						vfoState.ssbPhase! += phaseInc;
						if (vfoState.ssbPhase! > Math.PI) vfoState.ssbPhase! -= 2 * Math.PI;
						if (vfoState.ssbPhase! < -Math.PI) vfoState.ssbPhase! += 2 * Math.PI;
						const cosP = Math.cos(vfoState.ssbPhase!);
						const sinP = Math.sin(vfoState.ssbPhase!);
						const rI = dI * cosP - dQ * sinP;
						let demodSample = rI;
						const agcAttack = 50.0 / ifRate;
						const agcDecay = 5.0 / ifRate;
						const absSample = Math.abs(demodSample);
						if (absSample > vfoState.agcGain!) {
							vfoState.agcGain = vfoState.agcGain! * (1 - agcAttack) + absSample * agcAttack;
						} else {
							vfoState.agcGain = vfoState.agcGain! * (1 - agcDecay) + absSample * agcDecay;
						}
						const agcScale = vfoState.agcGain! > 1e-6 ? (0.5 / vfoState.agcGain!) : 1.0;
						audioDemodRateSamples[i] = demodSample * agcScale;
					}
				}
				else if (mode === 'cw') {
					for (let i = 0; i < numDemodSamples; i++) {
						const dI = _ddcOut[i * 2];
						const dQ = _ddcOut[i * 2 + 1];
						const cwTone = vfoState.cwTone || 700;
						const phaseInc = (cwTone / ifRate) * 2 * Math.PI;
						vfoState.ssbPhase! += phaseInc;
						if (vfoState.ssbPhase! > Math.PI) vfoState.ssbPhase! -= 2 * Math.PI;
						if (vfoState.ssbPhase! < -Math.PI) vfoState.ssbPhase! += 2 * Math.PI;
						const cosP = Math.cos(vfoState.ssbPhase!);
						const sinP = Math.sin(vfoState.ssbPhase!);
						const rI = dI * cosP - dQ * sinP;
						let demodSample = rI;
						const agcAttack = 50.0 / ifRate;
						const agcDecay = 5.0 / ifRate;
						const absSample = Math.abs(demodSample);
						if (absSample > vfoState.agcGain!) {
							vfoState.agcGain = vfoState.agcGain! * (1 - agcAttack) + absSample * agcAttack;
						} else {
							vfoState.agcGain = vfoState.agcGain! * (1 - agcDecay) + absSample * agcDecay;
						}
						const agcScale = vfoState.agcGain! > 1e-6 ? (0.5 / vfoState.agcGain!) : 1.0;
						audioDemodRateSamples[i] = demodSample * agcScale;
					}
				}
				else if (mode === 'raw') {
					for (let i = 0; i < numDemodSamples; i++) {
						audioDemodRateSamples[i] = _ddcOut[i * 2];
					}
				}
				else {
					audioDemodRateSamples.fill(0);
				}

				let result = vfoState.audioResampler!.process(audioDemodRateSamples);
				if (result.length === 0) return null;

				for (let i = 0; i < result.length; i++) {
					if (result[i] > 1.0) result[i] = 1.0;
					else if (result[i] < -1.0) result[i] = -1.0;
				}

				return result.slice();
			}
		};

		let chunkCounter = 0;

		const handleWorkerAudio = (v: number, msg: any): void => {
			const state = backend.vfoStates![v];
			const params = backend.vfoParams![v];
			if (!state || !params) return;

			state.squelchOpen = msg.squelchOpen;
			if (!backend._latchedSquelchOpen) backend._latchedSquelchOpen = [];
			if (msg.squelchOpen) backend._latchedSquelchOpen[v] = true;
			if (msg.dspTime) {
				perf.dspTimeSum += msg.dspTime;
				if (msg.dspTime > perf.dspTimeMax) perf.dspTimeMax = msg.dspTime;
				perf.audioCalls++;
			}

			if (msg.samples) {
				const out = new Float32Array(msg.samples);
				perf.audioSamplesOut += out.length;

				if (params.enabled) {
					const qLen = state.audioQueueLen;
					if (qLen + out.length > state.audioQueue.length) {
						const b = new Float32Array(state.audioQueue.length * 2);
						b.set(state.audioQueue.subarray(0, qLen));
						state.audioQueue = b;
					}
					state.audioQueue.set(out, qLen);
					state.audioQueueLen += out.length;

					if (!params.pocsag && whisperCallback) {
						whisperCallback(v, params.freq, out);
					}
				}

				if (pocsagCallback && params.pocsag && params.mode === 'nfm') {
					if (!state.pocsagDecoder) {
						state.pocsagDecoder = new POCSAGDecoder(AUDIO_RATE, (pmsg: any) => {
							pocsagCallback(v, params.freq, pmsg);
						});
					}
					state.pocsagDecoder.process(out);
				} else if (!params.pocsag && state.pocsagDecoder) {
					state.pocsagDecoder = null;
				}
			}

			// Mixer: flush all available audio immediately on every DSP callback.
			// Low-callback-rate devices (LimeSDR ~18/s) produce large audio bursts
			// that the main thread's ring buffer + schedule system smooths out.
			let anyActive = false;
			let minAvailable = Infinity;
			const activeStates: VfoState[] = [];
			const activeParams: VfoParams[] = [];

			for (let i = 0; i < backend.vfoParams!.length; i++) {
				const p = backend.vfoParams![i];
				const s = backend.vfoStates![i];
				if (s && p.enabled) {
					anyActive = true;
					if (s.audioQueueLen < minAvailable) {
						minAvailable = s.audioQueueLen;
					}
					activeStates.push(s);
					activeParams.push(p);
				}
			}

			// Flush with no minimum threshold — let the main thread's audio ring
			// buffer handle the smoothing via _scheduleAudioChunk
			if (anyActive && minAvailable > 0 && minAvailable !== Infinity) {
				if (!backend._mixBuf || backend._mixBuf.length < minAvailable) {
					backend._mixBuf = new Float32Array(minAvailable + 1024);
				}
				const mixed = backend._mixBuf;
				mixed.fill(0, 0, minAvailable);

				for (let i = 0; i < activeStates.length; i++) {
					const state = activeStates[i];
					const params = activeParams[i];
					const vol = params.volume || 50;
					const vScaling = (vol / 100) * (vol / 100);

					const source = state.audioQueue;
					for (let k = 0; k < minAvailable; k++) {
						mixed[k] += source[k] * vScaling;
					}

					const remaining = state.audioQueueLen - minAvailable;
					if (remaining > 0) {
						source.copyWithin(0, minAvailable, state.audioQueueLen);
					}
					state.audioQueueLen = remaining;
				}

				for (let k = 0; k < minAvailable; k++) {
					if (mixed[k] > 1.0) mixed[k] = 1.0;
					else if (mixed[k] < -1.0) mixed[k] = -1.0;
				}

				if (audioCallback) audioCallback(mixed.subarray(0, minAvailable));
			}
		};
		// Expose for worker closure inside spawnWorker
		backend._handleWorkerAudio = handleWorkerAudio;

		// Apply initial gains BEFORE starting bulk reads to avoid
		// control transfer conflicts with in-flight bulk transfers.
		// Matches librtlsdr / SDR++ which configure everything before streaming.
		if (gains) {
			for (const [name, value] of Object.entries(gains)) {
				await device.setGain(name, value);
			}
		}

		await device.startRx((data: any) => {
			perf.usbCallbacks++;

			const signed = new Int8Array(data.buffer, data.byteOffset, data.length);
			perf.lastChunkSize = signed.length;
			perf.inputSamplesSum += signed.length / 2;

			// Write USB chunk directly to WASM memory shared buffer if using SAB
			backend.sharedIqViews![backend.sabPoolIndex!].set(signed);
			chunkCounter++;

			// Bulk copy for spectrum buffer
			{
				let srcOff = 0;
				while (srcOff < signed.length) {
					const space = iqBuffer.length - iqBufferPos;
					const toCopy = Math.min(space, signed.length - srcOff);
					iqBuffer.set(signed.subarray(srcOff, srcOff + toCopy), iqBufferPos);
					iqBufferPos += toCopy;
					srcOff += toCopy;
					if (iqBufferPos >= iqBuffer.length) {
						iqBufferPos = 0;
						const now = performance.now();
						if (now - lastSpectrumTime >= spectrumIntervalMs) {
							lastSpectrumTime = now;
							// Revert back to copy-based FFT for the spectrum waterfall
							// because `iqBuffer` batches data across USB chunk boundaries.
							spectrumFft.fft(iqBuffer, spectrumOutput);

							// Double buffer the output since Comlink.transfer neuters the buffer on this side.
							let specCopy = useFlip ? specFlip : specFlop;
							if (specCopy.length === 0) { // Was neutered by Comlink
								specCopy = new Float32Array(fftSize);
								if (useFlip) specFlip = specCopy;
								else specFlop = specCopy;
							}

							specCopy.set(spectrumOutput);
							useFlip = !useFlip;

							// Slice for remote BEFORE Comlink.transfer — transfer detaches specCopy.buffer,
							// making any subsequent .slice() throw "detached ArrayBuffer".
							if (backend._remoteHostFftCb) backend._remoteHostFftCb(specCopy.slice());
							if (spectrumCallback) spectrumCallback(Comlink.transfer(specCopy, [specCopy.buffer]));
						}
					}
				}
			}

			// Broadcast to DSP workers
			for (let v = 0; v < backend.dspWorkers!.length; v++) {
				const worker = backend.dspWorkers![v];
				if (!worker) continue;
				const params = backend.vfoParams![v];
				if (typeof SharedArrayBuffer !== 'undefined') {
					worker.postMessage({ type: 'process', params: params, useSab: true, sabIndex: backend.sabPoolIndex, chunkLen: signed.length, chunkId: chunkCounter });
				} else {
					const cloneBuf = signed.slice().buffer;
					worker.postMessage({ type: 'process', params: params, useSab: false, chunk: cloneBuf, chunkLen: signed.length, chunkId: chunkCounter }, [cloneBuf]);
				}
			}

			// Feed all remote-client VFO workers (independent from the host mixer)
			if (backend._remoteClients) {
				for (const [, clientState] of backend._remoteClients) {
					for (let rv = 0; rv < clientState.workers.length; rv++) {
						const rw = clientState.workers[rv];
						if (!rw) continue;
						const rp = clientState.params[rv];
						if (typeof SharedArrayBuffer !== 'undefined') {
							rw.postMessage({ type: 'process', params: rp, useSab: true, sabIndex: backend.sabPoolIndex, chunkLen: signed.length, chunkId: chunkCounter });
						} else {
							const rClone = signed.slice().buffer;
							rw.postMessage({ type: 'process', params: rp, useSab: false, chunk: rClone, chunkLen: signed.length, chunkId: chunkCounter }, [rClone]);
						}
					}
				}
			}

			backend.sabPoolIndex = (backend.sabPoolIndex! + 1) % SAB_POOL_SIZE;
		});

		// Reinitialize all remote client DSP workers with the new sample rate
		// and shared IQ buffers. Without this, remote workers hold stale references
		// from the previous startRxStream and produce garbled audio.
		backend._reinitRemoteClientWorkers();
	} catch (e) {
		console.error("DEBUG CRASH IN STARTRXSTREAM:", e);
		throw e;
	} finally {
		_streamStarting = false;
	}
}
