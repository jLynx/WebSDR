/*
 * DSD DSP front-end: RRC filter, clock recovery, and 4-FSK slicer.
 * Ported from SDR++ Brown ch_extravhf_decoder.
 */

import { DSD_SYMBOL_RATE, DSD_IF_RATE, SLICER_MID_FACTOR } from './types';

// ── Root Raised Cosine (RRC) Filter ──────────────────────────────────

/**
 * Generate RRC filter taps.
 * @param numTaps Number of filter taps (should be odd)
 * @param sampleRate Input sample rate
 * @param symbolRate Symbol rate (4800 for DSD)
 * @param alpha Roll-off factor (0.2 for DSD)
 */
export function rrcTaps(numTaps: number, sampleRate: number, symbolRate: number, alpha: number): Float32Array {
	const taps = new Float32Array(numTaps);
	const Ts = sampleRate / symbolRate; // samples per symbol
	const mid = (numTaps - 1) / 2;
	let sum = 0;

	for (let i = 0; i < numTaps; i++) {
		const t = (i - mid) / Ts;
		let h: number;

		if (t === 0) {
			h = (1 / Ts) * (1 + alpha * (4 / Math.PI - 1));
		} else if (Math.abs(Math.abs(t) - 1 / (4 * alpha)) < 1e-8) {
			h = (alpha / (Ts * Math.SQRT2)) * (
				(1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * alpha)) +
				(1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * alpha))
			);
		} else {
			const piT = Math.PI * t;
			const fourAlphaT = 4 * alpha * t;
			h = (1 / Ts) * (
				Math.sin(piT * (1 - alpha)) + fourAlphaT * Math.cos(piT * (1 + alpha))
			) / (piT * (1 - fourAlphaT * fourAlphaT));
		}

		taps[i] = h;
		sum += h * h;
	}

	// Normalize energy
	const norm = 1 / Math.sqrt(sum);
	for (let i = 0; i < numTaps; i++) taps[i] *= norm;

	return taps;
}

/**
 * Simple FIR filter operating on float samples.
 */
export class FIRFilter {
	private taps: Float32Array;
	private buffer: Float32Array;
	private bufIdx: number;
	private numTaps: number;

	constructor(taps: Float32Array) {
		this.taps = taps;
		this.numTaps = taps.length;
		this.buffer = new Float32Array(this.numTaps);
		this.bufIdx = 0;
	}

	processSample(sample: number): number {
		this.buffer[this.bufIdx] = sample;
		let sum = 0;
		let idx = this.bufIdx;
		for (let i = 0; i < this.numTaps; i++) {
			sum += this.taps[i] * this.buffer[idx];
			if (--idx < 0) idx = this.numTaps - 1;
		}
		this.bufIdx = (this.bufIdx + 1) % this.numTaps;
		return sum;
	}

	process(input: Float32Array, output: Float32Array): void {
		for (let i = 0; i < input.length; i++) {
			output[i] = this.processSample(input[i]);
		}
	}

	reset(): void {
		this.buffer.fill(0);
		this.bufIdx = 0;
	}
}

// ── Mueller-Muller Clock Recovery ────────────────────────────────────

/**
 * Clock recovery using a Mueller-Muller timing error detector.
 * Extracts one symbol per symbol period from the input stream.
 *
 * Operates on RRC-filtered samples at IF_RATE (9600 Hz) to extract
 * symbols at SYMBOL_RATE (4800 sym/s) → 2 samples per symbol.
 */
export class ClockRecovery {
	private omega: number;      // nominal samples per symbol
	private mu: number;         // fractional sample offset
	private omegaGain: number;  // loop filter gain for omega
	private muGain: number;     // loop filter gain for mu
	private prevSample: number;
	private prevDecision: number; // hard decision of previous symbol (sign-based)
	private omegaRel: number;   // relative omega limit
	private omegaMid: number;   // nominal omega (for limiting)

	/** Output buffer for extracted symbols */
	symbolBuf: Float32Array;
	symbolCount: number;

	constructor(sampleRate: number = DSD_IF_RATE, symbolRate: number = DSD_SYMBOL_RATE) {
		this.omega = sampleRate / symbolRate;
		this.omegaMid = this.omega;
		this.mu = 0;
		this.prevSample = 0;
		this.prevDecision = 0;
		this.omegaRel = 0.005; // relative limit on omega adjustment

		// Loop filter parameters (2nd order, BW=0.01, damping=1.0)
		const bw = 2 * Math.PI * 0.01; // loop bandwidth
		const damp = 1.0;
		const denom = 1 + 2 * damp * bw + bw * bw;
		this.muGain = 4 * damp * bw / denom;
		this.omegaGain = 4 * bw * bw / denom;

		this.symbolBuf = new Float32Array(4096);
		this.symbolCount = 0;
	}

	/**
	 * Process a block of RRC-filtered samples and extract symbols.
	 * Call this with each new chunk from the RRC filter.
	 * After calling, read symbolBuf[0..symbolCount-1] for extracted symbols.
	 */
	process(input: Float32Array): void {
		this.symbolCount = 0;
		let idx = 0;
		const len = input.length;

		while (idx < len) {
			// Advance to next symbol position
			const skip = Math.floor(this.mu);
			idx += skip;
			this.mu -= skip;

			if (idx >= len) break;

			// Interpolate using linear interpolation
			const curSample = idx > 0
				? input[idx - 1] * (1 - this.mu) + input[idx] * this.mu
				: input[idx];

			// Hard decision: sign of sample (works for any M-FSK with zero mean)
			const curDecision = curSample > 0 ? 1.0 : -1.0;

			// Mueller-Muller timing error: prevDecision * curSample - curDecision * prevSample
			// Uses hard decisions to avoid the prevSymbol==prevSample degeneracy
			const mmError = this.prevDecision * curSample - curDecision * this.prevSample;

			// Update loop
			this.omega += this.omegaGain * mmError;
			// Clamp omega
			const omegaMin = this.omegaMid * (1 - this.omegaRel);
			const omegaMax = this.omegaMid * (1 + this.omegaRel);
			if (this.omega < omegaMin) this.omega = omegaMin;
			if (this.omega > omegaMax) this.omega = omegaMax;

			this.mu += this.omega + this.muGain * mmError;

			// Store state for next iteration
			this.prevSample = curSample;
			this.prevDecision = curDecision;

			if (this.symbolCount >= this.symbolBuf.length) {
				const newBuf = new Float32Array(this.symbolBuf.length * 2);
				newBuf.set(this.symbolBuf);
				this.symbolBuf = newBuf;
			}
			this.symbolBuf[this.symbolCount++] = curSample;
		}
	}

	reset(): void {
		this.omega = this.omegaMid;
		this.mu = 0;
		this.prevSample = 0;
		this.prevDecision = 0;
		this.symbolCount = 0;
	}
}

// ── 4-FSK Slicer ─────────────────────────────────────────────────────

/**
 * 4-FSK symbol slicer with adaptive threshold levels.
 * Converts float symbols to 2-bit dibits.
 *
 * Symbol mapping (following SDR++ Brown / DSD convention):
 *   >= umid → 01 (+1)
 *   >= center → 00 (+3)
 *   >= lmid → 10 (-1)
 *   < lmid → 11 (-3)
 */
export class FourFSKSlicer {
	max = 1.0;
	min = -1.0;
	center = 0.0;
	umid = 0.625;  // upper mid threshold
	lmid = -0.625; // lower mid threshold
	mid = SLICER_MID_FACTOR;

	// Adaptive level tracking with exponential moving average
	private maxTrack = 0.0;
	private minTrack = 0.0;
	private trackCount = 0;
	private readonly TRACK_ALPHA = 0.01; // EMA smoothing factor
	private readonly TRACK_WARMUP = 100; // samples before using tracked levels

	/** Slice a single symbol to a 2-bit dibit value (0-3). */
	slice(sym: number): number {
		// Track actual min/max levels from the signal
		this.trackCount++;
		if (this.trackCount <= this.TRACK_WARMUP) {
			// During warmup, find initial min/max
			if (sym > this.maxTrack || this.trackCount === 1) this.maxTrack = sym;
			if (sym < this.minTrack || this.trackCount === 1) this.minTrack = sym;
			if (this.trackCount === this.TRACK_WARMUP) {
				this.max = this.maxTrack;
				this.min = this.minTrack;
			}
		} else {
			// After warmup, use EMA tracking of outer symbol levels
			if (sym > this.center) {
				this.maxTrack = this.maxTrack * (1 - this.TRACK_ALPHA) + sym * this.TRACK_ALPHA;
			} else {
				this.minTrack = this.minTrack * (1 - this.TRACK_ALPHA) + sym * this.TRACK_ALPHA;
			}
			this.max = this.maxTrack;
			this.min = this.minTrack;
		}

		// Clamp to reasonable range
		if (this.max > 3.0) this.max = 3.0;
		if (this.max < 0.1) this.max = 0.1;
		if (this.min < -3.0) this.min = -3.0;
		if (this.min > -0.1) this.min = -0.1;

		this.center = (this.max + this.min) * 0.5;
		this.umid = ((this.max - this.center) * this.mid) + this.center;
		this.lmid = ((this.min - this.center) * this.mid) + this.center;

		if (sym >= this.umid) return 0b01;
		if (sym >= this.center) return 0b00;
		if (sym >= this.lmid) return 0b10;
		return 0b11;
	}

	/**
	 * Slice a buffer of symbols to dibits.
	 * @param symbols Input float symbols
	 * @param dibits Output Uint8Array of dibit values (0-3)
	 * @param count Number of symbols to process
	 */
	process(symbols: Float32Array, dibits: Uint8Array, count: number): void {
		for (let i = 0; i < count; i++) {
			dibits[i] = this.slice(symbols[i]);
		}
	}

	reset(): void {
		this.max = 1.0;
		this.min = -1.0;
		this.center = 0.0;
		this.umid = 0.625;
		this.lmid = -0.625;
		this.maxTrack = 0.0;
		this.minTrack = 0.0;
		this.trackCount = 0;
	}
}

// ── FM Discriminator (for IQ → baseband audio) ──────────────────────

/**
 * Simple FM discriminator using atan2 phase difference.
 * Converts complex IQ samples to real FM audio.
 */
export class FMDiscriminator {
	private prevI = 0;
	private prevQ = 0;

	/**
	 * Process interleaved IQ samples (I0, Q0, I1, Q1, ...) to FM audio.
	 * @param iq Interleaved Float32Array [I, Q, I, Q, ...]
	 * @param audio Output Float32Array (half the length of iq)
	 */
	process(iq: Float32Array, audio: Float32Array): void {
		const numSamples = iq.length / 2;
		for (let i = 0; i < numSamples; i++) {
			const curI = iq[i * 2];
			const curQ = iq[i * 2 + 1];
			// Conjugate multiply: (curI + j*curQ) * (prevI - j*prevQ)
			const dI = curI * this.prevI + curQ * this.prevQ;
			const dQ = curQ * this.prevI - curI * this.prevQ;
			audio[i] = Math.atan2(dQ, dI);
			this.prevI = curI;
			this.prevQ = curQ;
		}
	}

	reset(): void {
		this.prevI = 0;
		this.prevQ = 0;
	}
}
