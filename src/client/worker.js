/*
Copyright (c) 2026, jLynx <https://github.com/jLynx>
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

import * as Comlink from "./lib/comlink.mjs";
import { HackRF } from "./hackrf.js";
import init, { FFT, DspProcessor, set_panic_hook, alloc_iq_buffer, free_iq_buffer } from "./hackrf-web/pkg/hackrf_web.js";

// wasm module (top-level import)
let wasmInitialized = false;

async function ensureWasmInitialized() {
	if (!wasmInitialized) {
		await init();
		set_panic_hook();
		wasmInitialized = true;
	}
}

/**
 * POCSAG paging protocol decoder.
 * Operates on FM-demodulated Float32 audio samples (typically 48 kHz).
 *
 * Runs two independent baud-rate decoders in parallel (1200 Bd and 512 Bd),
 * so both rates are always active simultaneously.  Each sub-decoder uses a
 * zero-crossing PLL that correctly aligns sampling to the CENTER of each bit
 * (zero crossings must land at spb/2, not at the sample point).
 * Sync word detection tolerates up to 2 bit-errors via Hamming distance.
 */

/** Hamming distance between two 32-bit integers. */
function _pocsagHamming(a, b) {
	let x = (a ^ b) >>> 0;
	x -= (x >>> 1) & 0x55555555;
	x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
	x = (x + (x >>> 4)) & 0x0f0f0f0f;
	return Math.imul(x, 0x01010101) >>> 24;
}

class _POCSAGSingleBaud {
	static SYNC_WORD = 0x7CD215D8 >>> 0;
	static SYNC_INVERTED = (~0x7CD215D8) >>> 0;
	static IDLE_CW = 0x7A89C197 >>> 0;
	// Max Hamming distance to still recognise a sync / idle word
	static SYNC_TOLERANCE = 2;

	constructor(audioRate, baud, onMessage) {
		this.audioRate = audioRate;
		this.spb = audioRate / baud;   // samples per bit
		this.baudRate = baud;
		this.onMessage = onMessage;

		this.dcLevel = 0;
		this.dcAlpha = 0.001;              // fast initial DC tracking
		this.clockPhase = 0;
		this.lastSample = 0;

		this.shiftReg = 0;
		this.inverted = false;
		this.state = 'hunt';

		this.cwBitCnt = 0;
		this.currentCw = 0;
		this.batchCwIdx = 0;

		this.pageActive = false;
		this.pageCapcode = 0;
		this.pageFunc = 0;
		this.pageBits = [];
	}

	reset() {
		this.dcLevel = 0;
		this.clockPhase = 0;
		this.lastSample = 0;
		this.shiftReg = 0;
		this.state = 'hunt';
		this.cwBitCnt = 0;
		this.currentCw = 0;
		this.batchCwIdx = 0;
		this.pageActive = false;
		this.pageBits = [];
	}

	process(samples) {
		const spb = this.spb;
		const spbHalf = spb * 0.5;

		for (let i = 0; i < samples.length; i++) {
			// Adaptive DC removal — tighten alpha once roughly settled
			this.dcLevel += this.dcAlpha * (samples[i] - this.dcLevel);
			if (this.dcAlpha > 0.0001) this.dcAlpha *= 0.9999;
			const s = samples[i] - this.dcLevel;

			// Zero-crossing PLL: at a bit transition the sample should be at
			// clockPhase ≈ spbHalf (midpoint between bit-sample events).
			// Nudge the clock so transitions land at spbHalf.
			if ((this.lastSample < 0) !== (s < 0)) {
				let err = this.clockPhase - spbHalf;
				// Wrap to [-spbHalf, +spbHalf]
				if (err > spbHalf) err -= spb;
				if (err < -spbHalf) err += spb;
				// Hard-gate: ignore corrections larger than 40% of a bit period
				// (those are glitches, not true bit edges)
				if (Math.abs(err) < spb * 0.40) {
					this.clockPhase -= err * 0.12;
				}
			}
			this.lastSample = s;

			// Sample at the start of each new bit period
			if (++this.clockPhase >= spb) {
				this.clockPhase -= spb;
				this._onBit(s >= 0 ? 1 : 0);
			}
		}
	}

	_onBit(bit) {
		this.shiftReg = ((this.shiftReg << 1) | bit) >>> 0;

		if (this.state === 'hunt') {
			// Accept sync word with up to SYNC_TOLERANCE bit errors
			const dNorm = _pocsagHamming(this.shiftReg, _POCSAGSingleBaud.SYNC_WORD);
			const dInv = _pocsagHamming(this.shiftReg, _POCSAGSingleBaud.SYNC_INVERTED);
			if (dNorm <= _POCSAGSingleBaud.SYNC_TOLERANCE) {
				this.inverted = false;
				this._onSync();
			} else if (dInv <= _POCSAGSingleBaud.SYNC_TOLERANCE) {
				this.inverted = true;
				this._onSync();
			}
		} else {
			// Assemble 32-bit codewords with polarity correction.
			// While doing so, keep watching for a new sync word in case we drift
			// — if we see one mid-batch, re-align immediately.
			const dNorm = _pocsagHamming(this.shiftReg, _POCSAGSingleBaud.SYNC_WORD);
			const dInv = _pocsagHamming(this.shiftReg, _POCSAGSingleBaud.SYNC_INVERTED);
			if (this.cwBitCnt >= 28 && (dNorm <= _POCSAGSingleBaud.SYNC_TOLERANCE || dInv <= _POCSAGSingleBaud.SYNC_TOLERANCE)) {
				// Sync word received as a codeword → new batch starts
				this.inverted = dInv < dNorm;
				this.cwBitCnt = 0;
				this.currentCw = 0;
				this.batchCwIdx = 0;
				return;
			}

			const b = this.inverted ? (1 - bit) : bit;
			this.currentCw = ((this.currentCw << 1) | b) >>> 0;
			if (++this.cwBitCnt === 32) {
				this.cwBitCnt = 0;
				this._onCodeword(this.currentCw);
				this.currentCw = 0;
			}
		}
	}

	_onSync() {
		this.state = 'data';
		this.cwBitCnt = 0;
		this.currentCw = 0;
		this.batchCwIdx = 0;
	}

	_onCodeword(cw) {
		// Error-correct the received codeword (mirrors Mayhem: call twice —
		// first call fixes errors, second call counts what remain).
		const pass1 = this._eccCorrect(cw);
		const pass2 = this._eccCorrect(pass1.cw);

		if (pass2.errors >= 3) {
			// Uncorrectable — skip this codeword but keep position counter going
			if (++this.batchCwIdx >= 16) this.state = 'hunt';
			return;
		}

		const corrected = pass2.cw;

		// Exact IDLE check after correction (Mayhem uses exact equality post-ECC)
		if (corrected === _POCSAGSingleBaud.IDLE_CW) {
			if (this.pageActive && this.pageBits.length > 0) this._emitPage();
			this.pageActive = false;
		} else {
			this._processCw(corrected, this.batchCwIdx);
		}

		if (++this.batchCwIdx >= 16) {
			this.state = 'hunt';
		}
	}

	_processCw(cw, cwIdx) {
		const type = (cw >>> 31) & 1;
		if (type === 0) {
			// Address codeword → flush any previous page, start new one
			if (this.pageActive && this.pageBits.length > 0) this._emitPage();
			const addrHigh = (cw >>> 13) & 0x3FFFF;
			const func = (cw >>> 11) & 0x3;
			const frame = (cwIdx >> 1) & 0x7;
			this.pageCapcode = (addrHigh << 3) | frame;
			this.pageFunc = func;
			this.pageBits = [];
			this.pageActive = true;
		} else {
			// Message codeword: 20 data bits (bits 30..11), MSB first
			if (this.pageActive) {
				const data = (cw >>> 11) & 0xFFFFF;
				for (let b = 19; b >= 0; b--) {
					this.pageBits.push((data >>> b) & 1);
				}
			}
		}
	}

	/**
	 * BCH(31,21) error correction — ported directly from Mayhem's EccContainer.
	 *
	 * Builds two lookup tables once (shared across all instances via a static
	 * property) then corrects up to 2 bit-errors per codeword, exactly as the
	 * working Mayhem firmware does.  Returns { cw: correctedValue, errors: n }
	 * where n=0 (clean), 1 (1-bit fixed), 2 (2-bit fixed), or 3 (uncorrectable).
	 */
	static _ecc = null;

	static _buildECC() {
		const ecs = new Uint32Array(32);
		const bch = new Uint32Array(1025);

		// Generate ECS (error correction sequences) — same LFSR as Mayhem
		let srr = 0x3b4;
		for (let i = 0; i <= 20; i++) {
			ecs[i] = srr;
			if (srr & 1) srr = (srr >>> 1) ^ 0x3b4;
			else srr = srr >>> 1;
		}

		// Two errors in data
		for (let n = 0; n <= 20; n++) {
			for (let i = 0; i <= 20; i++) {
				const k = (ecs[n] ^ ecs[i]) & 0x3FF;
				bch[k] = (i << 5) + n + 0x2000;
			}
		}
		// One error in data
		for (let n = 0; n <= 20; n++) {
			const k = ecs[n] & 0x3FF;
			bch[k] = n + (0x1f << 5) + 0x1000;
		}
		// One error in data + one error in ECC
		for (let n = 0; n <= 20; n++) {
			for (let i = 0; i < 10; i++) {
				const k = (ecs[n] ^ (1 << i)) & 0x3FF;
				bch[k] = n + (0x1f << 5) + 0x2000;
			}
		}
		// One error in ECC only
		for (let n = 0; n < 10; n++) {
			bch[1 << n] = 0x3ff + 0x1000;
		}
		// Two errors in ECC only
		for (let n = 0; n < 10; n++) {
			for (let i = 0; i < 10; i++) {
				if (i !== n) bch[(1 << n) ^ (1 << i)] = 0x3ff + 0x2000;
			}
		}

		return { ecs, bch };
	}

	_eccCorrect(val) {
		if (!_POCSAGSingleBaud._ecc) _POCSAGSingleBaud._ecc = _POCSAGSingleBaud._buildECC();
		const { ecs, bch } = _POCSAGSingleBaud._ecc;

		// Compute syndrome from data bits (31..11) and received ECC bits (10..1)
		let pari = 0;
		let ecc = 0;
		for (let i = 31; i >= 11; i--) {
			if ((val >>> i) & 1) {
				ecc ^= ecs[31 - i];
				pari ^= 1;
			}
		}

		let acc = 0;
		for (let i = 10; i >= 1; i--) {
			acc = (acc << 1) | ((val >>> i) & 1);
		}
		acc &= 0x3FF;

		const synd = (ecc ^ acc) & 0x3FF;
		let errl = 0;

		if (synd !== 0) {
			const entry = bch[synd];
			if (entry !== 0) {
				const b1 = entry & 0x1f;
				const b2 = (entry >>> 5) & 0x1f;

				if (b2 !== 0x1f) {
					val = (val ^ (1 << (31 - b2))) >>> 0;
					ecc ^= ecs[b2];
				}
				if (b1 !== 0x1f) {
					val = (val ^ (1 << (31 - b1))) >>> 0;
					ecc ^= ecs[b1];
				}

				errl = entry >>> 12;
			} else {
				errl = 3;
			}

			if (errl === 1) pari ^= 1;
		}

		if (errl === 4) errl = 3;

		return { cw: val >>> 0, errors: errl };
	}

	_emitPage() {
		const { pageCapcode: capcode, pageFunc: func, pageBits: bits } = this;
		let text = '';

		if (func === 3) {
			// Alphanumeric: 7-bit ASCII, LSB-first per character
			let c = 0, cb = 0;
			for (let i = 0; i < bits.length; i++) {
				c |= (bits[i] << cb);
				if (++cb === 7) {
					if (c >= 32 && c < 127) text += String.fromCharCode(c);
					else if (c === 10 || c === 13) text += '\n';
					c = 0; cb = 0;
				}
			}
		} else if (func !== 0) {
			// Numeric BCD (func 1/2): 4-bit nibbles, LSB-first
			const NMAP = '0123456789 -.)(';
			for (let i = 0; i + 3 < bits.length; i += 4) {
				const n = bits[i] | (bits[i + 1] << 1) | (bits[i + 2] << 2) | (bits[i + 3] << 3);
				if (n < NMAP.length) text += NMAP[n];
			}
		}
		// func === 0 → tone-only

		const clean = text.replace(/[\x00-\x1F\x7F]/g, ' ').replace(/ {2,}/g, ' ').trim();

		if (clean.length > 0 || func === 0) {
			this.onMessage({
				capcode,
				func,
				type: func === 3 ? 'alpha' : (func === 0 ? 'tone' : 'numeric'),
				text: clean,
				baud: this.baudRate,
			});
		}

		this.pageBits = [];
		this.pageActive = false;
	}
}

/** Outer wrapper: runs parallel 1200 Bd and 512 Bd decoders simultaneously. */
class POCSAGDecoder {
	constructor(audioRate, onMessage) {
		this._d1200 = new _POCSAGSingleBaud(audioRate, 1200, onMessage);
		this._d512 = new _POCSAGSingleBaud(audioRate, 512, onMessage);
	}

	process(samples) {
		this._d1200.process(samples);
		this._d512.process(samples);
	}

	reset() {
		this._d1200.reset();
		this._d512.reset();
	}
}

class Worker {
	constructor() {
	}

	async init() {
		await ensureWasmInitialized();
		// In wasm-bindgen, the top-level init function returns the wasm exports
		this.wasm = await init();
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
			console.warn('boardRevRead not supported:', e);
		}

		console.log(`Serial Number: ${serialNo.map((i) => (i + 0x100000000).toString(16).slice(1)).join('')}`)
		console.log(`Board ID Number: ${boardId} (${HackRF.BOARD_ID_NAME.get(boardId)})`);
		console.log(`Firmware Version: ${versionString} (API:${apiVersion[0]}.${apiVersion[1]}${apiVersion[2]})`);
		console.log(`Part ID Number: ${partId.map((i) => (i + 0x100000000).toString(16).slice(1)).join(' ')}`)
		console.log(`Board Rev: ${HackRF.BOARD_REV_NAME.get(boardRev)} (${boardRev})`)
		return { boardId, versionString, apiVersion, partId, serialNo };
	}

	async startRxStream(opts, spectrumCallback, audioCallback, whisperCallback = null, pocsagCallback = null) {
		try {
			const { hackrf } = this;
			const { centerFreq, sampleRate, fftSize, lnaGain, vgaGain, ampEnabled } = opts;

			await hackrf.setSampleRateManual(sampleRate, 1);
			await hackrf.setBasebandFilterBandwidth(
				HackRF.computeBasebandFilterBw(sampleRate)
			);
			await hackrf.setFreq(centerFreq * 1e6);

			// ── Spectrum FFT setup ────────────────────────────────────────
			const spectrumWindowFunc = (x) => {
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
			let spectrumThrottle = 0;
			const targetFftFps = 20;
			const possibleFftFps = sampleRate / fftSize;
			const fftSkipFrames = Math.max(1, Math.round(possibleFftFps / targetFftFps));

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

					// Delay line: only needs tapsPerPhase-1 history samples + a working
					// window for the largest expected input block.  We start conservatively
					// at 4096 samples and grow on demand so we don't waste 256 KB per VFO.
					const initBlockSize = 4096;
					this.bufStartOffset = this.tapsPerPhase - 1;
					this.buffer = new Float32Array(this.bufStartOffset + initBlockSize);
					this.phase = 0;
					this.offset = 0;

					// Pre-allocated output buffer — grown as needed, never shrunk.
					// Avoids the per-call JS Array + Float32Array(array) allocations
					// that previously caused 900 heap objects/sec with 6 VFOs.
					this._outBuf = new Float32Array(Math.ceil(initBlockSize * interp / decim) + 4);
				}

				process(input, count) {
					// Grow delay buffer on demand (rare; only on the first large block)
					const needed = this.bufStartOffset + count;
					if (needed > this.buffer.length) {
						const bigger = new Float32Array(needed + 1024);
						bigger.set(this.buffer.subarray(0, this.bufStartOffset));
						this.buffer = bigger;
					}

					// Copy input into the delay line
					this.buffer.set(input.subarray(0, count), this.bufStartOffset);

					// Pre-calculate max output count and grow output buffer if needed
					const maxOut = Math.ceil(count * this.interp / this.decim) + 4;
					if (maxOut > this._outBuf.length) {
						this._outBuf = new Float32Array(maxOut + 64);
					}

					let outIdx = 0;
					while (this.offset < count) {
						// Convolution for this polyphase sub-filter
						let sum = 0.0;
						const phaseTaps = this.phases[this.phase];
						const bufOff = this.offset;
						for (let i = 0; i < this.tapsPerPhase; i++) {
							sum += this.buffer[bufOff + i] * phaseTaps[i];
						}
						this._outBuf[outIdx++] = sum;

						this.phase += this.decim;
						this.offset += Math.floor(this.phase / this.interp);
						this.phase = this.phase % this.interp;
					}
					this.offset -= count;

					// Shift history samples to the front of the delay line
					this.buffer.copyWithin(0, count, count + this.bufStartOffset);

					// Return a view — callers copy immediately via pushAudio/pushWhisper
					// or iterate read-only, so a view is safe and allocation-free.
					return this._outBuf.subarray(0, outIdx);
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
			if (this.ddcs) this.ddcs.forEach(d => { try { d.free(); } catch (_) { } });

			// Initialize dynamic VFO arrays (start with one VFO)
			const defaultVfoParams = { freq: centerFreq, mode: 'wfm', enabled: false, deEmphasis: '50us', squelchEnabled: false, squelchLevel: -100.0, lowPass: true, highPass: false, bandwidth: initialBandwidth, volume: 50, pocsag: false };
			this.vfoParams = [{ ...defaultVfoParams }];

			const AUDIO_RATE = 48000;
			const MAX_USB_SAMPLES = 131072;
			const SHARED_IQ_CAPACITY = MAX_USB_SAMPLES * 2;
			const SAB_POOL_SIZE = 8;
			this.sabPoolIndex = 0;

			this.sharedIqPools = [];
			this.sharedIqViews = [];
			for (let i = 0; i < SAB_POOL_SIZE; i++) {
				const pool = typeof SharedArrayBuffer !== 'undefined'
					? new SharedArrayBuffer(SHARED_IQ_CAPACITY)
					: new ArrayBuffer(SHARED_IQ_CAPACITY);
				this.sharedIqPools.push(pool);
				this.sharedIqViews.push(new Int8Array(pool));
			}

			const makeVfoState = () => ({
				squelchOpen: false,
				pocsagDecoder: null,
				audioQueue: new Float32Array(32768),
				audioQueueLen: 0,
			});
			this.vfoStates = [makeVfoState()];
			this.dspWorkers = [];

			const spawnWorker = (index, params) => {
				const worker = new globalThis.Worker('./dsp-worker.js', { type: 'module' });
				worker.onmessage = (e) => {
					const msg = e.data;
					if (msg.type === "audio") {
						this._handleWorkerAudio(index, msg);
					} else if (msg.type === "error") {
						console.error(`[DSP Worker ${index}] Error:`, msg.error);
					}
				};
				worker.postMessage({
					type: 'init',
					sampleRate: sampleRate,
					centerFreq: centerFreq,
					params: params,
					sabs: typeof SharedArrayBuffer !== 'undefined' ? this.sharedIqPools : null
				});
				return worker;
			};
			this.dspWorkers.push(spawnWorker(0, this.vfoParams[0]));

			this._makeVfoState = makeVfoState;
			this._spawnWorker = spawnWorker;
			this._sampleRate = sampleRate;
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

			// ── Per-VFO Whisper Batching ──────────────────────────────────
			// Each VFO gets its own batch buffer so Whisper receives isolated
			// (pre-mix, pre-volume) audio for accurate per-VFO transcription.
			const WHISPER_BATCH_THRESHOLD = 2400;
			const whisperBatchBufs = [];   // Float32Array per VFO
			const whisperBatchPos = [];    // write position per VFO
			const ensureWhisperBuf = (v) => {
				if (!whisperBatchBufs[v]) {
					whisperBatchBufs[v] = new Float32Array(4800);
					whisperBatchPos[v] = 0;
				}
			};
			const pushWhisper = (v, freq, samples) => {
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

			const flushAudio = () => {
				if (audioBatchPos > 0) {
					perf.msgsSent++;
					const aCopy = audioBatchBuf.slice(0, audioBatchPos);
					audioCallback(Comlink.transfer(aCopy, [aCopy.buffer]));
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
			const processVfoAudio = (iqPtr, numIqBytes, ddc, params, vfoState) => {
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
					const result = new Float32Array(this.wasm.memory.buffer, outPtr, numAudioSamples);

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
						let tau;
						switch (params.deEmphasis) {
							case '22us': tau = 22e-6; break;
							case '50us': tau = 50e-6; break;
							case '75us': tau = 75e-6; break;
							default: tau = 50e-6; break;
						}
						const alpha = dt / (tau + dt);
						const oneMinusAlpha = 1.0 - alpha;
						let prev = vfoState.deemphPrev;
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
					if (numAudioSamples > vfoState.audioTarget.length) {
						vfoState.audioTarget = new Float32Array(numAudioSamples + 1024);
					}
					const outView = vfoState.audioTarget.subarray(0, numAudioSamples);
					outView.set(result); // Zero-allocation copy!
					return outView;
				} else {
					// ── Non-FM Path: NCO + resampler + channel FIR in Rust, demod in JS ──
					const outPtr = ddc.process_iq_only_ptr(iqPtr, numIqBytes);
					const numOutValues = ddc.get_iq_output_len();
					const numDemodSamples = numOutValues / 2;
					if (numDemodSamples === 0) return null;

					const _ddcOut = new Float32Array(this.wasm.memory.buffer, outPtr, numOutValues);

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
					if (numDemodSamples > vfoState.scratchBuf.length) {
						vfoState.scratchBuf = new Float32Array(numDemodSamples + 128);
					}
					const audioDemodRateSamples = vfoState.scratchBuf.subarray(0, numDemodSamples);

					if (params.squelchEnabled && squelchDb < params.squelchLevel) {
						vfoState.squelchOpen = false;
						// Pass the pre-zeroed scratch slice (fill only what we use)
						audioDemodRateSamples.fill(0);
						const result = vfoState.audioResampler.process(audioDemodRateSamples);
						return result.length > 0 ? result : null;
					}
					// Signal is above squelch threshold — mark as receiving
					vfoState.squelchOpen = params.squelchEnabled && squelchDb >= params.squelchLevel;

					const ifRate = vfoState.currentIfRate;

					if (mode === 'am') {
						for (let i = 0; i < numDemodSamples; i++) {
							const dI = _ddcOut[i * 2];
							const dQ = _ddcOut[i * 2 + 1];
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
							const dI = _ddcOut[i * 2];
							const dQ = _ddcOut[i * 2 + 1];
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
							const dI = _ddcOut[i * 2];
							const dQ = _ddcOut[i * 2 + 1];
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
							audioDemodRateSamples[i] = _ddcOut[i * 2];
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

					return result.slice();
				}
			};

			let chunkCounter = 0;

			const handleWorkerAudio = (v, msg) => {
				const state = this.vfoStates[v];
				const params = this.vfoParams[v];
				if (!state || !params) return;

				state.squelchOpen = msg.squelchOpen;
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
							state.pocsagDecoder = new POCSAGDecoder(AUDIO_RATE, (pmsg) => {
								pocsagCallback(v, params.freq, pmsg);
							});
						}
						state.pocsagDecoder.process(out);
					} else if (!params.pocsag && state.pocsagDecoder) {
						state.pocsagDecoder = null;
					}
				}

				// Mixer block logic
				let anyActive = false;
				let minAvailable = Infinity;
				const AUDIO_BATCH_THRESHOLD = 512;
				const activeStates = [];
				const activeParams = [];

				for (let i = 0; i < this.vfoParams.length; i++) {
					const p = this.vfoParams[i];
					const s = this.vfoStates[i];
					if (s && p.enabled) {
						anyActive = true;
						if (s.audioQueueLen < minAvailable) {
							minAvailable = s.audioQueueLen;
						}
						activeStates.push(s);
						activeParams.push(p);
					}
				}

				if (anyActive && minAvailable > 0 && minAvailable !== Infinity && minAvailable >= AUDIO_BATCH_THRESHOLD) {
					if (!this._mixBuf || this._mixBuf.length < minAvailable) {
						this._mixBuf = new Float32Array(minAvailable + 1024);
					}
					const mixed = this._mixBuf;
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
			this._handleWorkerAudio = handleWorkerAudio;

			await hackrf.startRx((data) => {
				perf.usbCallbacks++;

				const signed = new Int8Array(data.buffer, data.byteOffset, data.length);
				perf.lastChunkSize = signed.length;
				perf.inputSamplesSum += signed.length / 2;

				// Write USB chunk directly to WASM memory shared buffer if using SAB
				this.sharedIqViews[this.sabPoolIndex].set(signed);
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
							spectrumThrottle++;
							if (spectrumThrottle % fftSkipFrames === 0) {
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
								spectrumCallback(Comlink.transfer(specCopy, [specCopy.buffer]));
							}
						}
					}
				}

				// Broadcast to DSP workers
				for (let v = 0; v < this.dspWorkers.length; v++) {
					const worker = this.dspWorkers[v];
					if (!worker) continue;
					const params = this.vfoParams[v];
					if (typeof SharedArrayBuffer !== 'undefined') {
						worker.postMessage({ type: 'process', params: params, useSab: true, sabIndex: this.sabPoolIndex, chunkLen: signed.length, chunkId: chunkCounter });
					} else {
						const cloneBuf = signed.slice().buffer;
						worker.postMessage({ type: 'process', params: params, useSab: false, chunk: cloneBuf, chunkLen: signed.length, chunkId: chunkCounter }, [cloneBuf]);
					}
				}
				this.sabPoolIndex = (this.sabPoolIndex + 1) % SAB_POOL_SIZE;
			});

			if (ampEnabled !== undefined) await hackrf.setAmpEnable(ampEnabled);
			if (lnaGain !== undefined) await hackrf.setLnaGain(lnaGain);
			if (vgaGain !== undefined) await hackrf.setVgaGain(vgaGain);
		} catch (e) {
			console.error("DEBUG CRASH IN STARTRXSTREAM:", e);
			throw e;
		}
	}

	getDspStats() {
		if (!this._perf) return null;
		return {
			...this._perf.report,
			squelchOpen: this.vfoStates ? this.vfoStates.map(s => s.squelchOpen || false) : [],
		};
	}

	setVfoParams(index, params) {
		if (!this.vfoParams || index < 0 || index >= this.vfoParams.length) return;
		Object.assign(this.vfoParams[index], params);

		if (this.dspWorkers && this.dspWorkers[index]) {
			this.dspWorkers[index].postMessage({
				type: 'configure',
				params: this.vfoParams[index],
				centerFreq: this._centerFreq
			});
		}

		// Clear POCSAG decoder when explicitly disabled
		if (params.pocsag === false && this.vfoStates && this.vfoStates[index]) {
			this.vfoStates[index].pocsagDecoder = null;
		}
	}

	addVfo() {
		if (!this.vfoParams) return -1;
		const centerFreq = this._centerFreq || 100.0;
		const bw = 150000;
		const params = { freq: centerFreq, mode: 'wfm', enabled: false, deEmphasis: '50us', squelchEnabled: false, squelchLevel: -100.0, lowPass: true, highPass: false, bandwidth: bw, volume: 50, pocsag: false };
		this.vfoParams.push(params);

		const index = this.vfoParams.length - 1;
		this.vfoStates.push(this._makeVfoState());
		this.dspWorkers.push(this._spawnWorker(index, params));

		return index;
	}

	removeVfo(index) {
		if (!this.vfoParams || index < 0 || index >= this.vfoParams.length) return;
		if (this.vfoParams.length <= 1) return; // Keep at least one VFO

		if (this.dspWorkers[index]) {
			this.dspWorkers[index].terminate();
		}

		this.vfoParams.splice(index, 1);
		this.dspWorkers.splice(index, 1);
		this.vfoStates.splice(index, 1);
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

Comlink.expose(Worker);
