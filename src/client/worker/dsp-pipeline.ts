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

// ── FIR Filter Math (SDR++ dsp/taps & dsp/window) ──────────────

export const sinc = (x: number): number => (x === 0.0) ? 1.0 : (Math.sin(x) / x);

export const cosineWindow = (n: number, N: number, coefs: number[]): number => {
	let win = 0.0;
	let sign = 1.0;
	for (let i = 0; i < coefs.length; i++) {
		win += sign * coefs[i] * Math.cos(i * 2.0 * Math.PI * n / N);
		sign = -sign;
	}
	return win;
};

export const nuttall = (n: number, N: number): number => {
	const coefs = [0.355768, 0.487396, 0.144232, 0.012604];
	return cosineWindow(n, N, coefs);
};

export const hzToRads = (freq: number, samplerate: number): number => 2.0 * Math.PI * (freq / samplerate);

export const estimateTapCount = (transWidth: number, samplerate: number): number => {
	return Math.floor(3.8 * samplerate / transWidth);
};

export const windowedSincBase = (count: number, omega: number, windowFunc: (n: number, N: number) => number, norm: number = 1.0): Float32Array => {
	const taps = new Float32Array(count);
	const half = count / 2.0;
	const corr = norm * omega / Math.PI;

	for (let i = 0; i < count; i++) {
		const t = i - half + 0.5;
		taps[i] = sinc(t * omega) * windowFunc(t - half, count) * corr;
	}
	return taps;
};

export const lowPassTaps = (cutoff: number, transWidth: number, samplerate: number, oddTapCount: boolean = false): Float32Array => {
	let count = estimateTapCount(transWidth, samplerate);
	if (oddTapCount && count % 2 === 0) count++;
	const omega = hzToRads(cutoff, samplerate);
	return windowedSincBase(count, omega, (n: number, N: number) => nuttall(n, N));
};

export const highPassTaps = (cutoff: number, transWidth: number, samplerate: number, oddTapCount: boolean = false): Float32Array => {
	let count = estimateTapCount(transWidth, samplerate);
	if (oddTapCount && count % 2 === 0) count++;
	const omega = hzToRads((samplerate / 2.0) - cutoff, samplerate);
	return windowedSincBase(count, omega, (n: number, N: number) => {
		return nuttall(n, N) * ((Math.abs(Math.round(n)) % 2 !== 0) ? -1.0 : 1.0);
	});
};

export const bandPassTaps = (bandStart: number, bandStop: number, transWidth: number, samplerate: number, oddTapCount: boolean = false): Float32Array => {
	let count = estimateTapCount(transWidth, samplerate);
	if (oddTapCount && count % 2 === 0) count++;
	const offsetOmega = hzToRads((bandStart + bandStop) / 2.0, samplerate);
	const omega = hzToRads((bandStop - bandStart) / 2.0, samplerate);
	return windowedSincBase(count, omega, (n: number, N: number) => {
		return 2.0 * Math.cos(offsetOmega * n) * nuttall(n, N);
	});
};

export class FIRFilter {
	taps: Float32Array;
	history: Float32Array;
	histIdx: number;

	constructor(taps?: Float32Array) {
		if (!taps) taps = new Float32Array([1.0]);
		this.taps = taps;
		this.history = new Float32Array(this.taps.length);
		this.histIdx = 0;
	}

	setTaps(taps: Float32Array): void {
		this.taps = taps;
		this.history = new Float32Array(this.taps.length);
		this.histIdx = 0;
	}

	reset(): void {
		this.history.fill(0);
		this.histIdx = 0;
	}

	processOne(sample: number): number {
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

// Math greatest common divisor for rational resampling (iterative to avoid stack overflow)
export function gcd(a: number, b: number): number {
	// Guard against NaN / Infinity / non-integer which would loop forever
	a = Math.round(Math.abs(a));
	b = Math.round(Math.abs(b));
	if (!Number.isFinite(a) || !Number.isFinite(b)) {
		console.error(`[gcd] non-finite input: a=${a}, b=${b} — returning 1`);
		return 1;
	}
	if (a === 0 && b === 0) {
		console.error(`[gcd] both inputs are 0 — returning 1`);
		return 1;
	}
	while (b !== 0) {
		const t = b;
		b = a % b;
		a = t;
	}
	return a;
}

export class PolyphaseResampler {
	interp: number;
	decim: number;
	taps: Float32Array;
	phaseCount: number;
	tapsPerPhase: number;
	phases: Float32Array[];
	bufStartOffset: number;
	buffer: Float32Array;
	phase: number;
	offset: number;
	_outBuf: Float32Array;

	constructor(interp: number, decim: number, taps: Float32Array) {
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

	process(input: Float32Array, count: number): Float32Array {
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

export class RationalResampler {
	interp: number;
	decim: number;
	resamp: PolyphaseResampler;

	constructor(inSamplerate: number, outSamplerate: number) {
		const IntSR = Math.round(inSamplerate);
		const OutSR = Math.round(outSamplerate);
		if (IntSR <= 0 || OutSR <= 0) {
			console.error(`[RationalResampler] Invalid sample rates: in=${inSamplerate} (→${IntSR}), out=${outSamplerate} (→${OutSR})`);
		}
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

	process(input: Float32Array): Float32Array {
		return this.resamp.process(input, input.length);
	}
}
