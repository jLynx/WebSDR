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

import type { RDSMessage } from './types';

// ── RDS Constants ────────────────────────────────────────────────
const RDS_BITRATE = 1187.5;
const RDS_PILOT = 19000; // stereo pilot — RDS subcarrier = 3 × pilot

// Offset words for each block position (10-bit, per IEC 62106)
const OFFSET_A  = 0x0FC;
const OFFSET_B  = 0x198;
const OFFSET_C  = 0x168;
const OFFSET_CP = 0x350;
const OFFSET_D  = 0x1B4;

// Generator polynomial for RDS checkword (x^10 + x^8 + x^7 + x^5 + x^4 + x^3 + 1)
const RDS_POLY = 0x5B9; // 10-bit: 10110111001
const SYNDROME_A  = calcSyndrome(OFFSET_A);
const SYNDROME_B  = calcSyndrome(OFFSET_B);
const SYNDROME_C  = calcSyndrome(OFFSET_C);
const SYNDROME_CP = calcSyndrome(OFFSET_CP);
const SYNDROME_D  = calcSyndrome(OFFSET_D);

function calcSyndrome(offset: number): number {
	let reg = 0;
	for (let i = 25; i >= 0; i--) {
		const bit = (i >= 10) ? 0 : ((offset >> i) & 1);
		const fb = ((reg >> 9) & 1) ^ bit;
		reg = ((reg << 1) & 0x3FF);
		if (fb) reg ^= RDS_POLY;
	}
	return reg;
}

function computeSyndrome(block: number): number {
	let reg = 0;
	for (let i = 25; i >= 0; i--) {
		const fb = ((reg >> 9) & 1) ^ ((block >> i) & 1);
		reg = ((reg << 1) & 0x3FF);
		if (fb) reg ^= RDS_POLY;
	}
	return reg;
}

// EU PTY labels (0-31)
const PTY_LABELS_EU = [
	'None', 'News', 'Current Affairs', 'Information', 'Sport', 'Education',
	'Drama', 'Culture', 'Science', 'Varied', 'Pop Music', 'Rock Music',
	'Easy Listening', 'Light Classical', 'Serious Classical', 'Other Music',
	'Weather', 'Finance', 'Children', 'Social Affairs', 'Religion',
	'Phone In', 'Travel', 'Leisure', 'Jazz Music', 'Country Music',
	'National Music', 'Oldies Music', 'Folk Music', 'Documentary',
	'Alarm Test', 'Alarm'
];

// NA (RBDS) PTY labels
const PTY_LABELS_NA = [
	'None', 'News', 'Information', 'Sports', 'Talk', 'Rock',
	'Classic Rock', 'Adult Hits', 'Soft Rock', 'Top 40', 'Country',
	'Oldies', 'Soft', 'Nostalgia', 'Jazz', 'Classical',
	'R&B', 'Soft R&B', 'Language', 'Religious Music', 'Religious Talk',
	'Personality', 'Public', 'College', 'Spanish Talk', 'Spanish Music',
	'Hip Hop', '', '', 'Weather', 'Emergency Test', 'Emergency'
];

// ── Biquad Filter Section ────────────────────────────────────────
// Direct Form II Transposed biquad for numerical stability

class BiquadSection {
	private b0: number;
	private b1: number;
	private b2: number;
	private a1: number;
	private a2: number;
	private x1 = 0;
	private x2 = 0;
	private y1 = 0;
	private y2 = 0;

	constructor(b0: number, b1: number, b2: number, a1: number, a2: number) {
		this.b0 = b0; this.b1 = b1; this.b2 = b2;
		this.a1 = a1; this.a2 = a2;
	}

	process(x: number): number {
		const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2
			- this.a1 * this.y1 - this.a2 * this.y2;
		this.x2 = this.x1; this.x1 = x;
		this.y2 = this.y1; this.y1 = y;
		return y;
	}

	reset(): void {
		this.x1 = 0; this.x2 = 0;
		this.y1 = 0; this.y2 = 0;
	}
}

/** Create a bandpass biquad filter at the given center frequency and Q. */
function makeBandpass(centerHz: number, Q: number, sampleRate: number): BiquadSection {
	const w0 = 2 * Math.PI * centerHz / sampleRate;
	const sinW0 = Math.sin(w0);
	const cosW0 = Math.cos(w0);
	const alpha = sinW0 / (2 * Q);
	const a0 = 1 + alpha;
	return new BiquadSection(
		alpha / a0,          // b0
		0,                   // b1
		-alpha / a0,         // b2
		-2 * cosW0 / a0,    // a1
		(1 - alpha) / a0     // a2
	);
}

/** Create a 4th-order Butterworth low-pass filter (two cascaded biquads).
 *  Provides 24 dB/octave rolloff — much better than single-pole IIR (6 dB/oct). */
function makeButterworthLpf4(cutoffHz: number, sampleRate: number): BiquadSection[] {
	// Q values for 4th-order Butterworth (from poles at ±22.5° and ±67.5°)
	const Qs = [0.54119610, 1.30656296];
	return Qs.map(Q => {
		const w0 = 2 * Math.PI * cutoffHz / sampleRate;
		const sinW0 = Math.sin(w0);
		const cosW0 = Math.cos(w0);
		const alpha = sinW0 / (2 * Q);
		const a0 = 1 + alpha;
		return new BiquadSection(
			(1 - cosW0) / 2 / a0,    // b0
			(1 - cosW0) / a0,         // b1
			(1 - cosW0) / 2 / a0,    // b2
			-2 * cosW0 / a0,          // a1
			(1 - alpha) / a0           // a2
		);
	});
}

// ── RDS Decoder ──────────────────────────────────────────────────

export class RDSDecoder {
	private callback: (msg: RDSMessage) => void;
	private region: string;

	// 19 kHz pilot PLL — BPF + quadrature mixing + ultra-narrow LPF
	private pilotPhase: number = 0;
	private pilotFreq: number;       // nominal 2π×19000/fs
	private pilotAlpha: number;      // PLL proportional gain
	private pilotBpf: BiquadSection; // 19 kHz bandpass filter
	private pilotMixI: number = 0;   // mixed pilot baseband I (after narrow LPF)
	private pilotMixQ: number = 0;   // mixed pilot baseband Q (after narrow LPF)
	private pilotMixAlpha: number;   // ultra-narrow LPF coefficient

	// 4th-order Butterworth LPF for RDS I and Q channels
	private bqI: BiquadSection[];
	private bqQ: BiquadSection[];

	// Clock recovery (1187.5 bps)
	private samplesPerBit: number;
	private clockPhase: number = 0;
	private prevBpskI: number = 0;

	// Differential decode using complex conjugate product
	private prevSymI: number = 0;
	private prevSymQ: number = 0;

	// Block assembly
	private shiftReg: number = 0;
	private bitCount: number = 0;

	// Sync state machine
	private synced: boolean = false;
	private blockIndex: number = 0; // 0=A, 1=B, 2=C, 3=D
	private goodBlocks: number = 0;
	private blocks: number[] = [0, 0, 0, 0]; // data words (16 bits each)
	private blockValid: boolean[] = [false, false, false, false]; // per-block CRC validity
	private blockErrors: number = 0;

	// Decoded RDS data
	private pi: number = 0;
	private pty: number = -1;
	private tp: boolean = false;
	private ta: boolean = false;
	private psChars: (number | null)[] = new Array(8).fill(null);
	private rtChars: (number | null)[] = new Array(64).fill(null);
	private rtAbFlag: number = -1;
	private lastPs: string = '';
	private lastRt: string = '';

	constructor(sampleRate: number, callback: (msg: RDSMessage) => void, region: string = 'eu') {
		this.callback = callback;
		this.region = region;
		this.samplesPerBit = sampleRate / RDS_BITRATE;

		// ── Pilot PLL: BPF at 19 kHz → quadrature mix → narrow LPF → I×Q phase error ──
		this.pilotFreq = 2 * Math.PI * RDS_PILOT / sampleRate;
		this.pilotBpf = makeBandpass(RDS_PILOT, 30, sampleRate); // Q=30, ~633 Hz BW
		this.pilotAlpha = 2 * Math.PI * 100 / sampleRate; // High gain for fast pull-in
		this.pilotMixAlpha = 1 - Math.exp(-2 * Math.PI * 30 / sampleRate); // 30 Hz LPF limits noise

		// 4th-order Butterworth LPF at 1.5 kHz for RDS baseband
		this.bqI = makeButterworthLpf4(1500, sampleRate);
		this.bqQ = makeButterworthLpf4(1500, sampleRate);
	}

	process(samples: Float32Array): void {
		for (let i = 0; i < samples.length; i++) {
			const sample = samples[i];

			// ── 19 kHz Pilot PLL ──
			// 1. BPF extracts pilot tone from MPX (rejects audio, stereo, RDS)
			const pilotBpf = this.pilotBpf.process(sample);

			// 2. Quadrature mix BPF output with PLL to get baseband I/Q
			const pllCos = Math.cos(this.pilotPhase);
			const pllSin = Math.sin(this.pilotPhase);
			// 10 Hz LPF — rejects 38kHz mixing product AND audio beats near 19kHz
			this.pilotMixI += this.pilotMixAlpha * (pilotBpf * pllCos - this.pilotMixI);
			this.pilotMixQ += this.pilotMixAlpha * (pilotBpf * pllSin - this.pilotMixQ);

			// 3. Phase error: normalized I×Q (stable at φ=0 and φ=π)
			const pp = this.pilotMixI * this.pilotMixI + this.pilotMixQ * this.pilotMixQ;
			if (pp > 1e-12) {
				this.pilotPhase -= (this.pilotMixI * this.pilotMixQ) / pp * this.pilotAlpha;
			}

			this.pilotPhase += this.pilotFreq;
			if (this.pilotPhase > 2 * Math.PI) this.pilotPhase -= 2 * Math.PI;
			else if (this.pilotPhase < 0) this.pilotPhase += 2 * Math.PI;

			// ── Coherent 57 kHz from triple-angle formulas ──
			const c = pllCos, s = pllSin;
			const cos3 = 4 * c * c * c - 3 * c;
			const sin3 = 3 * s - 4 * s * s * s;

			// Mix MPX with coherent 57 kHz reference
			const rawI = sample * cos3;
			const rawQ = sample * sin3;

			// ── 4th-order Butterworth LPF on I and Q ──
			let filtI = rawI;
			for (let k = 0; k < this.bqI.length; k++) filtI = this.bqI[k].process(filtI);
			let filtQ = rawQ;
			for (let k = 0; k < this.bqQ.length; k++) filtQ = this.bqQ[k].process(filtQ);

			// ── Clock recovery ──
			this.clockPhase += 1.0;
			if ((filtI > 0) !== (this.prevBpskI > 0)) {
				const error = this.clockPhase - this.samplesPerBit / 2;
				this.clockPhase -= error * 0.1;
			}
			this.prevBpskI = filtI;

			// ── Sample at bit boundary (mid-bit, maximum signal) ──
			if (this.clockPhase >= this.samplesPerBit) {
				this.clockPhase -= this.samplesPerBit;

				// Differential decode: Re{z[n] × conj(z[n-1])}
				const diffProd = filtI * this.prevSymI + filtQ * this.prevSymQ;
				const decodedBit = diffProd < 0 ? 1 : 0;

				this.prevSymI = filtI;
				this.prevSymQ = filtQ;

				this.processBit(decodedBit);
			}
		}
	}

	private processBit(bit: number): void {
		// Shift bit into 26-bit register
		this.shiftReg = ((this.shiftReg << 1) | bit) & 0x3FFFFFF;
		this.bitCount++;

		if (!this.synced) {
			// Try to find sync by checking syndrome against all offset words
			if (this.bitCount >= 26) {
				const syn = computeSyndrome(this.shiftReg);
				if (syn === SYNDROME_A) {
					this.synced = true;
					this.goodBlocks = 1;
					this.blocks[0] = (this.shiftReg >> 10) & 0xFFFF;
					this.blockIndex = 1;
					this.bitCount = 0;
				} else if (syn === SYNDROME_B) {
					this.synced = true;
					this.goodBlocks = 0;
					this.blocks[1] = (this.shiftReg >> 10) & 0xFFFF;
					this.blockIndex = 2;
					this.bitCount = 0;
				} else if (syn === SYNDROME_C || syn === SYNDROME_CP) {
					this.synced = true;
					this.goodBlocks = 0;
					this.blocks[2] = (this.shiftReg >> 10) & 0xFFFF;
					this.blockIndex = 3;
					this.bitCount = 0;
				} else if (syn === SYNDROME_D) {
					this.synced = true;
					this.goodBlocks = 0;
					this.blocks[3] = (this.shiftReg >> 10) & 0xFFFF;
					this.blockIndex = 0;
					this.bitCount = 0;
				}
			}
			return;
		}

		// Synced: wait for 26 bits per block
		if (this.bitCount < 26) return;
		this.bitCount = 0;

		const syn = computeSyndrome(this.shiftReg);
		const expectedSyndromes = [SYNDROME_A, SYNDROME_B, SYNDROME_C, SYNDROME_D];
		// Block C can also be C' (for type B groups)
		const expectedSyn = expectedSyndromes[this.blockIndex];
		const isValid = (syn === expectedSyn) ||
			(this.blockIndex === 2 && syn === SYNDROME_CP);

		if (isValid) {
			this.blocks[this.blockIndex] = (this.shiftReg >> 10) & 0xFFFF;
			this.blockValid[this.blockIndex] = true;
			this.goodBlocks++;
			this.blockErrors = 0;
		} else {
			this.blockValid[this.blockIndex] = false;
			this.blockErrors++;
			if (this.blockErrors > 30) {
				// Lost sync
				this.synced = false;
				this.goodBlocks = 0;
				this.blockErrors = 0;
				return;
			}
		}

		// Advance block position
		this.blockIndex = (this.blockIndex + 1) & 3;

		// After block D (index wraps to 0), decode the group
		if (this.blockIndex === 0 && this.goodBlocks >= 2) {
			this.decodeGroup();
		}
		if (this.blockIndex === 0) {
			this.goodBlocks = 0;
			this.blockValid.fill(false);
		}
	}

	/** Accept a printable character at a given position.
	 *  CRC + block-validity checks upstream ensure data integrity. */
	private acceptChar(pos: number, char: number, chars: (number | null)[]): void {
		if (char >= 0x20 && char < 0x7F) chars[pos] = char;
	}

	private decodeGroup(): void {
		const bv = this.blockValid;

		// Block A: PI code — only if block A passed CRC
		if (bv[0]) {
			const pi = this.blocks[0];
			if (pi !== this.pi && pi !== 0) {
				this.pi = pi;
				const piHex = pi.toString(16).toUpperCase().padStart(4, '0');
				this.callback({ pi: piHex });
			}
		}

		// Block B must be valid — it contains group type, PTY, segment index
		if (!bv[1]) return;
		const blockB = this.blocks[1];

		const groupType = (blockB >> 12) & 0xF;
		const groupVersion = (blockB >> 11) & 1; // 0=A, 1=B
		const tp = ((blockB >> 10) & 1) === 1;
		const pty = (blockB >> 5) & 0x1F;

		// TP flag
		if (tp !== this.tp) {
			this.tp = tp;
			this.callback({ tp });
		}

		// PTY
		if (pty !== this.pty) {
			this.pty = pty;
			const labels = this.region === 'na' ? PTY_LABELS_NA : PTY_LABELS_EU;
			this.callback({ pty, ptyLabel: labels[pty] || '' });
		}

		// Group 0: Basic tuning and PS name — need block D valid
		if (groupType === 0 && bv[3]) {
			const ta = (blockB & 0x10) !== 0;
			if (ta !== this.ta) {
				this.ta = ta;
				this.callback({ ta });
			}

			// PS name: 2 chars per group 0, segment from bits 1:0 of block B
			const segment = blockB & 0x03;
			const blockD = this.blocks[3];
			const c1 = (blockD >> 8) & 0xFF;
			const c2 = blockD & 0xFF;

			this.acceptChar(segment * 2, c1, this.psChars);
			this.acceptChar(segment * 2 + 1, c2, this.psChars);

			// Check if PS is complete (all 8 chars received)
			const ps = this.buildPS();
			if (ps && ps !== this.lastPs) {
				this.lastPs = ps;
				this.callback({ ps });
			}
		}

		// Group 2: RadioText
		if (groupType === 2) {
			const abFlag = (blockB >> 4) & 1;

			// A/B flag change means new RT message — clear buffer
			if (this.rtAbFlag !== -1 && abFlag !== this.rtAbFlag) {
				this.rtChars.fill(null);
			}
			this.rtAbFlag = abFlag;

			const segment = blockB & 0x0F;

			if (groupVersion === 0 && bv[2] && bv[3]) {
				// 2A: 4 chars per segment (from blocks C and D)
				const blockC = this.blocks[2];
				const blockD = this.blocks[3];
				const c1 = (blockC >> 8) & 0xFF;
				const c2 = blockC & 0xFF;
				const c3 = (blockD >> 8) & 0xFF;
				const c4 = blockD & 0xFF;
				const base = segment * 4;
				this.acceptChar(base, c1, this.rtChars);
				this.acceptChar(base + 1, c2, this.rtChars);
				this.acceptChar(base + 2, c3, this.rtChars);
				this.acceptChar(base + 3, c4, this.rtChars);

				// Check for end-of-message marker (0x0D)
				if (c1 === 0x0D || c2 === 0x0D || c3 === 0x0D || c4 === 0x0D) {
					const rt = this.buildRT();
					if (rt && rt !== this.lastRt) {
						this.lastRt = rt;
						this.callback({ rt });
					}
				}
			} else if (groupVersion === 1 && bv[3]) {
				// 2B: 2 chars per segment (from block D only)
				const blockD = this.blocks[3];
				const c1 = (blockD >> 8) & 0xFF;
				const c2 = blockD & 0xFF;
				const base = segment * 2;
				this.acceptChar(base, c1, this.rtChars);
				this.acceptChar(base + 1, c2, this.rtChars);
			}

			// Periodically emit partial RT
			const rt = this.buildRT();
			if (rt && rt.length >= 4 && rt !== this.lastRt) {
				this.lastRt = rt;
				this.callback({ rt });
			}
		}
	}

	private buildPS(): string | null {
		if (this.psChars.some(c => c === null)) return null;
		return String.fromCharCode(...(this.psChars as number[]));
	}

	private buildRT(): string | null {
		let end = 0;
		for (let i = 0; i < 64; i++) {
			if (this.rtChars[i] !== null) end = i + 1;
		}
		if (end === 0) return null;

		let s = '';
		for (let i = 0; i < end; i++) {
			s += this.rtChars[i] !== null ? String.fromCharCode(this.rtChars[i]!) : ' ';
		}
		return s.trimEnd();
	}

	reset(): void {
		this.synced = false;
		this.blockIndex = 0;
		this.goodBlocks = 0;
		this.blockErrors = 0;
		this.blockValid.fill(false);
		this.bitCount = 0;
		this.shiftReg = 0;
		this.pi = 0;
		this.pty = -1;
		this.tp = false;
		this.ta = false;
		this.psChars.fill(null);
		this.rtChars.fill(null);
		this.rtAbFlag = -1;
		this.lastPs = '';
		this.lastRt = '';
		this.pilotPhase = 0;
		this.pilotMixI = 0;
		this.pilotMixQ = 0;
		this.pilotBpf.reset();
		this.clockPhase = 0;
		this.prevBpskI = 0;
		this.prevSymI = 0;
		this.prevSymQ = 0;
		for (const bq of this.bqI) bq.reset();
		for (const bq of this.bqQ) bq.reset();
	}
}
