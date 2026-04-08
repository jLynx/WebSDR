/*
 * Golay(24,12) error correction for DSD (P25, DMR).
 * Ported from SDR++ Brown Golay24.hpp.
 * Based on the work of Mr Hank Wallace, adapted from http://www.aqdi.com/golay.htm
 */

const POLY = 0xAE3;

/** Nibble weight table for popcount */
const WGT = new Uint8Array([0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4]);

/** Calculate [23,12] Golay codeword. Returns [checkbits(11),data(12)]. */
function golay(cw: number): number {
	cw &= 0xFFF;
	const c = cw;
	for (let i = 1; i <= 12; i++) {
		if (cw & 1) cw ^= POLY;
		cw >>>= 1;
	}
	return ((cw << 12) | c) >>> 0;
}

/** Check overall parity of codeword cw. Returns 0 if even, 1 if odd. */
function parity(cw: number): number {
	let p = (cw & 0xFF) ^ ((cw >>> 8) & 0xFF) ^ ((cw >>> 16) & 0xFF);
	p = p ^ (p >>> 4);
	p = p ^ (p >>> 2);
	p = p ^ (p >>> 1);
	return p & 1;
}

/** Calculate syndrome of a [23,12] Golay codeword. */
function syndrome(cw: number): number {
	cw &= 0x7FFFFF;
	for (let i = 1; i <= 12; i++) {
		if (cw & 1) cw ^= POLY;
		cw >>>= 1;
	}
	return (cw << 12) >>> 0;
}

/** Calculate weight (popcount) of 23-bit codeword. */
function weight(cw: number): number {
	let bits = 0;
	let k = 0;
	while (k < 6 && cw) {
		bits += WGT[cw & 0xF];
		cw >>>= 4;
		k++;
	}
	return bits;
}

/** Rotate 23-bit codeword left by n bits. */
function rotateLeft(cw: number, n: number): number {
	for (let i = 1; i <= n; i++) {
		if (cw & 0x400000) cw = ((cw << 1) | 1) >>> 0;
		else cw = (cw << 1) >>> 0;
	}
	return cw & 0x7FFFFF;
}

/** Rotate 23-bit codeword right by n bits. */
function rotateRight(cw: number, n: number): number {
	for (let i = 1; i <= n; i++) {
		if (cw & 1) cw = ((cw >>> 1) | 0x400000) >>> 0;
		else cw >>>= 1;
	}
	return cw & 0x7FFFFF;
}

/**
 * Correct Golay [23,12] codeword. Returns corrected codeword.
 * Corrects up to 3 bit errors.
 */
function correct(cw: number): { corrected: number; errs: number; errorsDetected: number } {
	const cwsaver = cw;
	let errs = 0;
	let errorsDetected = 0;

	let w = 3;
	let j = -1;
	let mask = 1;

	while (j < 23) {
		if (j !== -1) {
			if (j > 0) {
				cw = (cwsaver ^ mask) >>> 0;
				mask = (mask + mask) >>> 0;
			}
			cw = (cwsaver ^ mask) >>> 0;
			w = 2;
		}

		let s = syndrome(cw);
		if (s) {
			errorsDetected++;
			for (let i = 0; i < 23; i++) {
				errs = weight(s);
				if (errs <= w) {
					cw = (cw ^ s) >>> 0;
					cw = rotateRight(cw, i);
					return { corrected: cw, errs, errorsDetected };
				}
				cw = rotateLeft(cw, 1);
				s = syndrome(cw);
			}
			j++;
		} else {
			return { corrected: cw, errs: 0, errorsDetected };
		}
	}

	return { corrected: cwsaver, errs: 0, errorsDetected };
}

/** Encode 12 bits of data into a Golay(24,12) codeword with parity bit. */
export function golayEncode(data: number): number {
	let codeword = golay(data);
	if (parity(codeword)) codeword ^= 0x800000;
	return codeword >>> 0;
}

/**
 * Decode a Golay(24,12) codeword. Returns 0 on success, 1 on uncorrectable error.
 */
export function golayDecode(cw: { value: number }): { errorFlag: number; fixedErrors: number } {
	const parityBit = cw.value & 0x800000;
	cw.value &= ~0x800000;

	const result = correct(cw.value);
	cw.value = result.corrected | parityBit;

	if (parity(cw.value)) return { errorFlag: 1, fixedErrors: result.errs };
	return { errorFlag: 0, fixedErrors: result.errs };
}

// ── DSD-format adapters (work with char[] bit arrays) ────────────────

/** Pack a char-bit array and parity into a 24-bit codeword for Golay. */
function adaptToCodeword(word: Int8Array, length: number, par: Int8Array): number {
	let codeword = 0;
	// Parity as MSBs (12 bits)
	for (let i = 0; i < 12; i++) {
		codeword <<= 1;
		codeword |= par[11 - i] & 1;
	}
	// Data bits
	for (let i = 0; i < length; i++) {
		codeword <<= 1;
		codeword |= word[length - 1 - i] & 1;
	}
	// Pad if data < 12 bits
	if (length < 12) codeword <<= (12 - length);
	return codeword >>> 0;
}

/** Unpack corrected codeword back into char-bit array. */
function adaptToWord(codeword: number, word: Int8Array, length: number): void {
	for (let i = 0, mask = 1 << (12 - length); i < length; i++, mask <<= 1) {
		word[i] = (codeword & mask) ? 1 : 0;
	}
}

/** Encode char-bit array to parity. */
function adaptFromWord(word: Int8Array, length: number): number {
	let codeword = 0;
	for (let i = 0; i < length; i++) {
		codeword <<= 1;
		codeword |= word[length - 1 - i] & 1;
	}
	if (length < 12) codeword <<= (12 - length);
	return codeword >>> 0;
}

/**
 * Decode a 6-bit hex word with 12-bit Golay parity.
 * Corrects errors in-place. Returns 1 on uncorrectable error.
 */
export function golayDecode6(hex: Int8Array, par: Int8Array): { errorFlag: number; fixedErrors: number } {
	let codeword = adaptToCodeword(hex, 6, par);
	const parityBit = codeword & 0x800000;
	codeword &= ~0x800000;

	const result = correct(codeword);
	codeword = result.corrected | parityBit;

	let fixedErrors = result.errs;
	let errorFlag = parity(codeword) ? 1 : 0;

	if (errorFlag === 1 && (codeword & 0x3F) !== 0) {
		// Discard - don't touch hex
	} else {
		adaptToWord(codeword, hex, 6);
		errorFlag = 0;
	}

	return { errorFlag, fixedErrors };
}

/**
 * Decode a 12-bit dodeca word with 12-bit Golay parity.
 * Corrects errors in-place. Returns 1 on uncorrectable error.
 */
export function golayDecode12(dodeca: Int8Array, par: Int8Array): { errorFlag: number; fixedErrors: number } {
	let codeword = adaptToCodeword(dodeca, 12, par);
	const parityBit = codeword & 0x800000;
	codeword &= ~0x800000;

	const result = correct(codeword);
	codeword = result.corrected | parityBit;

	let fixedErrors = result.errs;
	let errorFlag = parity(codeword) ? 1 : 0;

	if (errorFlag === 1 && (codeword & 0x3F) !== 0) {
		// Discard
	} else {
		adaptToWord(codeword, dodeca, 12);
		errorFlag = 0;
	}

	return { errorFlag, fixedErrors };
}

/**
 * Encode a 6-bit hex word and output 12-bit parity.
 */
export function golayEncode6(hex: Int8Array, outParity: Int8Array): void {
	const data = adaptFromWord(hex, 6);
	const codeword = golayEncode(data);
	for (let i = 0, mask = 1 << 12; i < 12; i++, mask <<= 1) {
		outParity[i] = (codeword & mask) ? 1 : 0;
	}
}

/**
 * Encode a 12-bit word and output 12-bit parity.
 */
export function golayEncode12(dodeca: Int8Array, outParity: Int8Array): void {
	const data = adaptFromWord(dodeca, 12);
	const codeword = golayEncode(data);
	for (let i = 0, mask = 1 << 12; i < 12; i++, mask <<= 1) {
		outParity[i] = (codeword & mask) ? 1 : 0;
	}
}
