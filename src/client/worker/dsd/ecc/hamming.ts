/*
 * Hamming(10,6,3) error correction for DSD (P25).
 * Ported from SDR++ Brown Hamming.hpp.
 * Uses table-based implementation for fast lookups.
 */

// ── Hamming(10,6,3) core (bitset-based, used to build tables) ────────

/** G matrix rows (10-bit) from APCO 25 reference */
const G_ROWS = [
	0b1000001110, // g0
	0b0100001101, // g1
	0b0010001011, // g2
	0b0001000111, // g3
	0b0000100011, // g4
	0b0000011100, // g5
];

/** H matrix rows (10-bit) for syndrome calculation */
const H_ROWS = [
	0b1110011000, // h0
	0b1101010100, // h1
	0b1011100010, // h2
	0b0111100001, // h3
];

/** Bad bit table: syndrome → bit position to correct (-2 = no error, -1 = uncorrectable) */
const BAD_BIT_TABLE = new Int8Array(16);
BAD_BIT_TABLE[0] = -2;  // no errors
BAD_BIT_TABLE[1] = 0;
BAD_BIT_TABLE[2] = 1;
BAD_BIT_TABLE[3] = 5;
BAD_BIT_TABLE[4] = 2;
BAD_BIT_TABLE[5] = -1;  // uncorrectable
BAD_BIT_TABLE[6] = -1;
BAD_BIT_TABLE[7] = 6;
BAD_BIT_TABLE[8] = 3;
BAD_BIT_TABLE[9] = -1;
BAD_BIT_TABLE[10] = -1;
BAD_BIT_TABLE[11] = 7;
BAD_BIT_TABLE[12] = 4;
BAD_BIT_TABLE[13] = 8;
BAD_BIT_TABLE[14] = 9;
BAD_BIT_TABLE[15] = -1;

/** Popcount for 10-bit values */
function popcount10(v: number): number {
	v = v - ((v >>> 1) & 0x55555555);
	v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
	return (((v + (v >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;
}

/** Decode a 10-bit Hamming(10,6,3) value. Returns error count (0=ok, 1=corrected, 2=uncorrectable). */
function hammingDecode10(input: number): { decoded: number; errorCount: number } {
	// Calculate syndrome
	let syndrome = 0;
	for (let i = 0; i < 4; i++) {
		const row = H_ROWS[i];
		const bits = popcount10(input & row);
		if (bits & 1) syndrome |= (1 << (3 - i));
	}

	if (syndrome === 0) {
		return { decoded: input >>> 4, errorCount: 0 };
	}

	const badBit = BAD_BIT_TABLE[syndrome];
	if (badBit === -1) {
		return { decoded: input >>> 4, errorCount: 2 };
	}

	// Flip the bad bit
	input ^= (1 << badBit);
	return { decoded: input >>> 4, errorCount: 1 };
}

/** Encode a 6-bit value to 10-bit Hamming(10,6,3). Returns 10-bit codeword. */
function hammingEncode6(input: number): number {
	let codeword = input << 4;
	// Calculate parity bits using G^T
	const GT_ROWS = [
		0b111001, // gt0
		0b110101, // gt1
		0b101110, // gt2
		0b011110, // gt3
	];
	let parity = 0;
	for (let i = 0; i < 4; i++) {
		const bits = popcount10(input & GT_ROWS[i]);
		if (bits & 1) parity |= (1 << (3 - i));
	}
	return codeword | parity;
}

// ── Precomputed lookup tables (built at module load) ─────────────────

const FIXED_VALUES = new Int32Array(1024);
const ERROR_COUNTS = new Int32Array(1024);
const ENCODE_PARITIES = new Int32Array(64);

// Build all tables
for (let i = 0; i < 1024; i++) {
	const { decoded, errorCount } = hammingDecode10(i);
	FIXED_VALUES[i] = decoded;
	ERROR_COUNTS[i] = errorCount;
}
for (let i = 0; i < 64; i++) {
	const encoded = hammingEncode6(i);
	ENCODE_PARITIES[i] = encoded & 0xF; // just the 4 parity bits
}

// ── Public API (table-based, fast) ───────────────────────────────────

/** Convert 6 hex bits + 4 parity bits (char arrays) to 10-bit int. */
function hexParityToInt(hex: Int8Array, par: Int8Array): number {
	let value = 0;
	for (let i = 0; i < 6; i++) { value <<= 1; value |= hex[i] & 1; }
	for (let i = 0; i < 4; i++) { value <<= 1; value |= par[i] & 1; }
	return value;
}

/** Convert 6-bit hex (char array) to int. */
function hexToInt(hex: Int8Array): number {
	let value = 0;
	for (let i = 0; i < 6; i++) { value <<= 1; value |= hex[i] & 1; }
	return value;
}

/** Convert int to 6-bit hex (char array). */
function intToHex(value: number, hex: Int8Array): void {
	for (let i = 5; i >= 0; i--) { hex[i] = value & 1; value >>>= 1; }
}

/**
 * Decode a 6-bit hex word with 4-bit Hamming parity.
 * Corrects single-bit errors in-place.
 * @returns Error count: 0=ok, 1=corrected, 2=uncorrectable
 */
export function hammingDecode(hex: Int8Array, par: Int8Array): number {
	const value = hexParityToInt(hex, par);
	const errorCount = ERROR_COUNTS[value];
	if (errorCount === 1) {
		intToHex(FIXED_VALUES[value], hex);
	}
	return errorCount;
}

/**
 * Encode a 6-bit hex word and output 4-bit parity.
 */
export function hammingEncode(hex: Int8Array, outParity: Int8Array): void {
	const value = hexToInt(hex);
	let parity = ENCODE_PARITIES[value];
	for (let i = 3; i >= 0; i--) {
		outParity[i] = parity & 1;
		parity >>>= 1;
	}
}
