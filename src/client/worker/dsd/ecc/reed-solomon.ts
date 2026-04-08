/*
 * Reed-Solomon GF(2^6) error correction for DSD (P25).
 * Ported from SDR++ Brown ReedSolomon.hpp.
 * Credit: Simon Rockliff, University of Adelaide.
 */

const MM = 6;    // RS code over GF(2^mm)
const NN = 63;   // nn = 2^mm - 1, length of codeword

/** Generic Reed-Solomon(63, kk) decoder over GF(2^6). */
class ReedSolomon63 {
	private readonly tt: number;  // error-correcting capability
	private readonly kk: number;  // kk = nn - 2*tt
	private readonly alphaTo: Int32Array;
	private readonly indexOf: Int32Array;
	private readonly gg: Int32Array;

	constructor(tt: number) {
		this.tt = tt;
		this.kk = NN - 2 * tt;
		this.alphaTo = new Int32Array(NN + 1);
		this.indexOf = new Int32Array(NN + 1);
		this.gg = new Int32Array(NN - this.kk + 1);

		// P25 irreducible polynomial: alpha^6 + alpha + 1
		const genPoly = [1, 1, 0, 0, 0, 0, 1];
		this.generateGF(genPoly);
		this.genPoly();
	}

	private generateGF(pp: number[]): void {
		let mask = 1;
		this.alphaTo[MM] = 0;
		for (let i = 0; i < MM; i++) {
			this.alphaTo[i] = mask;
			this.indexOf[this.alphaTo[i]] = i;
			if (pp[i] !== 0) this.alphaTo[MM] ^= mask;
			mask <<= 1;
		}
		this.indexOf[this.alphaTo[MM]] = MM;
		mask >>= 1;
		for (let i = MM + 1; i < NN; i++) {
			if (this.alphaTo[i - 1] >= mask)
				this.alphaTo[i] = this.alphaTo[MM] ^ ((this.alphaTo[i - 1] ^ mask) << 1);
			else
				this.alphaTo[i] = this.alphaTo[i - 1] << 1;
			this.indexOf[this.alphaTo[i]] = i;
		}
		this.indexOf[0] = -1;
	}

	private genPoly(): void {
		const { gg, alphaTo, indexOf, kk } = this;
		gg[0] = 2;
		gg[1] = 1;
		for (let i = 2; i <= NN - kk; i++) {
			gg[i] = 1;
			for (let j = i - 1; j > 0; j--)
				if (gg[j] !== 0)
					gg[j] = gg[j - 1] ^ alphaTo[(indexOf[gg[j]] + i) % NN];
				else
					gg[j] = gg[j - 1];
			gg[0] = alphaTo[(indexOf[gg[0]] + i) % NN];
		}
		for (let i = 0; i <= NN - kk; i++)
			gg[i] = indexOf[gg[i]];
	}

	/** Decode input[0..62] (polynomial form) into recd[0..62]. Returns 1 on irrecoverable error. */
	decode(input: Int32Array, recd: Int32Array): number {
		const { tt, kk, alphaTo, indexOf } = this;
		const nnkk = NN - kk;

		for (let i = 0; i < NN; i++)
			recd[i] = indexOf[input[i]];

		// Compute syndromes
		const s = new Int32Array(nnkk + 1);
		let synError = 0;
		for (let i = 1; i <= nnkk; i++) {
			s[i] = 0;
			for (let j = 0; j < NN; j++)
				if (recd[j] !== -1)
					s[i] ^= alphaTo[(recd[j] + i * j) % NN];
			if (s[i] !== 0) synError = 1;
			s[i] = indexOf[s[i]];
		}

		if (!synError) {
			for (let i = 0; i < NN; i++)
				recd[i] = recd[i] !== -1 ? alphaTo[recd[i]] : 0;
			return 0;
		}

		// Berlekamp-Massey algorithm
		const elp = Array.from({ length: nnkk + 2 }, () => new Int32Array(nnkk));
		const d = new Int32Array(nnkk + 2);
		const l = new Int32Array(nnkk + 2);
		const uLu = new Int32Array(nnkk + 2);

		d[0] = 0;
		d[1] = s[1];
		elp[0][0] = 0;
		elp[1][0] = 1;
		for (let i = 1; i < nnkk; i++) {
			elp[0][i] = -1;
			elp[1][i] = 0;
		}
		l[0] = 0;
		l[1] = 0;
		uLu[0] = -1;
		uLu[1] = 0;
		let u = 0;

		do {
			u++;
			if (d[u] === -1) {
				l[u + 1] = l[u];
				for (let i = 0; i <= l[u]; i++) {
					elp[u + 1][i] = elp[u][i];
					elp[u][i] = indexOf[elp[u][i]];
				}
			} else {
				let q = u - 1;
				while (d[q] === -1 && q > 0) q--;
				if (q > 0) {
					let j = q;
					do {
						j--;
						if (d[j] !== -1 && uLu[q] < uLu[j]) q = j;
					} while (j > 0);
				}

				l[u + 1] = l[u] > l[q] + u - q ? l[u] : l[q] + u - q;

				for (let i = 0; i < nnkk; i++) elp[u + 1][i] = 0;
				for (let i = 0; i <= l[q]; i++)
					if (elp[q][i] !== -1)
						elp[u + 1][i + u - q] = alphaTo[(d[u] + NN - d[q] + elp[q][i]) % NN];
				for (let i = 0; i <= l[u]; i++) {
					elp[u + 1][i] ^= elp[u][i];
					elp[u][i] = indexOf[elp[u][i]];
				}
			}
			uLu[u + 1] = u - l[u + 1];

			if (u < nnkk) {
				d[u + 1] = s[u + 1] !== -1 ? alphaTo[s[u + 1]] : 0;
				for (let i = 1; i <= l[u + 1]; i++)
					if (s[u + 1 - i] !== -1 && elp[u + 1][i] !== 0)
						d[u + 1] ^= alphaTo[(s[u + 1 - i] + indexOf[elp[u + 1][i]]) % NN];
				d[u + 1] = indexOf[d[u + 1]];
			}
		} while (u < nnkk && l[u + 1] <= tt);

		u++;
		let irrecoverable = 0;

		if (l[u] <= tt) {
			for (let i = 0; i <= l[u]; i++) elp[u][i] = indexOf[elp[u][i]];

			const root = new Int32Array(tt);
			const loc = new Int32Array(tt);
			const reg = new Int32Array(tt + 1);
			let count = 0;

			for (let i = 1; i <= l[u]; i++) reg[i] = elp[u][i];
			for (let i = 1; i <= NN; i++) {
				let q = 1;
				for (let j = 1; j <= l[u]; j++)
					if (reg[j] !== -1) {
						reg[j] = (reg[j] + j) % NN;
						q ^= alphaTo[reg[j]];
					}
				if (!q) {
					root[count] = i;
					loc[count] = NN - i;
					count++;
				}
			}

			if (count === l[u]) {
				const z = new Int32Array(tt + 1);
				const err = new Int32Array(NN);

				for (let i = 1; i <= l[u]; i++) {
					if (s[i] !== -1 && elp[u][i] !== -1)
						z[i] = alphaTo[s[i]] ^ alphaTo[elp[u][i]];
					else if (s[i] !== -1)
						z[i] = alphaTo[s[i]];
					else if (elp[u][i] !== -1)
						z[i] = alphaTo[elp[u][i]];
					else
						z[i] = 0;
					for (let j = 1; j < i; j++)
						if (s[j] !== -1 && elp[u][i - j] !== -1)
							z[i] ^= alphaTo[(elp[u][i - j] + s[j]) % NN];
					z[i] = indexOf[z[i]];
				}

				for (let i = 0; i < NN; i++) {
					err[i] = 0;
					recd[i] = recd[i] !== -1 ? alphaTo[recd[i]] : 0;
				}

				for (let i = 0; i < l[u]; i++) {
					err[loc[i]] = 1;
					for (let j = 1; j <= l[u]; j++)
						if (z[j] !== -1)
							err[loc[i]] ^= alphaTo[(z[j] + j * root[i]) % NN];
					if (err[loc[i]] !== 0) {
						err[loc[i]] = indexOf[err[loc[i]]];
						let q = 0;
						for (let j = 0; j < l[u]; j++)
							if (j !== i)
								q += indexOf[1 ^ alphaTo[(loc[j] + root[i]) % NN]];
						q = q % NN;
						err[loc[i]] = alphaTo[(err[loc[i]] - q + NN) % NN];
						recd[loc[i]] ^= err[loc[i]];
					}
				}
			} else {
				irrecoverable = 1;
			}
		} else {
			irrecoverable = 1;
		}

		if (irrecoverable) {
			for (let i = 0; i < NN; i++)
				recd[i] = recd[i] !== -1 ? alphaTo[recd[i]] : 0;
		}

		return irrecoverable;
	}
}

// ── Helpers ──────────────────────────────────────────────────────────

function binToHex(input: Int8Array, offset: number): number {
	return ((input[offset] ? 32 : 0) |
		(input[offset + 1] ? 16 : 0) |
		(input[offset + 2] ? 8 : 0) |
		(input[offset + 3] ? 4 : 0) |
		(input[offset + 4] ? 2 : 0) |
		(input[offset + 5] ? 1 : 0));
}

function hexToBin(value: number, output: Int8Array, offset: number): void {
	output[offset]     = (value & 32) ? 1 : 0;
	output[offset + 1] = (value & 16) ? 1 : 0;
	output[offset + 2] = (value & 8) ? 1 : 0;
	output[offset + 3] = (value & 4) ? 1 : 0;
	output[offset + 4] = (value & 2) ? 1 : 0;
	output[offset + 5] = (value & 1) ? 1 : 0;
}

// ── Singleton RS instances (constructed once at module load) ─────────

const rs8 = new ReedSolomon63(8);  // RS(36,20,17) for P25 HDU
const rs6 = new ReedSolomon63(6);  // RS(24,12,13) for P25 LDU1/TDULC
const rs4 = new ReedSolomon63(4);  // RS(24,16,9)  for P25 LDU2

/**
 * Reed-Solomon (36,20,17) decode for P25 HDU.
 * @param hexData 20 hex words as Int8Array (20*6 = 120 bits, row-major)
 * @param hexParity 16 hex words as Int8Array (16*6 = 96 bits)
 * @returns 1 on irrecoverable error, 0 on success
 */
export function rsDecode_36_20_17(hexData: Int8Array, hexParity: Int8Array): number {
	const input = new Int32Array(63);
	const output = new Int32Array(63);
	for (let i = 0; i < 16; i++) input[i] = binToHex(hexParity, i * 6);
	for (let i = 0; i < 20; i++) input[16 + i] = binToHex(hexData, i * 6);
	for (let i = 36; i < 63; i++) input[i] = 0;

	const err = rs8.decode(input, output);
	for (let i = 0; i < 20; i++) hexToBin(output[16 + i], hexData, i * 6);
	return err;
}

/**
 * Reed-Solomon (24,12,13) decode for P25 LDU1 / TDULC.
 * @param hexData 12 hex words (12*6 = 72 bits)
 * @param hexParity 12 hex words (12*6 = 72 bits)
 * @returns 1 on irrecoverable error, 0 on success
 */
export function rsDecode_24_12_13(hexData: Int8Array, hexParity: Int8Array): number {
	const input = new Int32Array(63);
	const output = new Int32Array(63);
	for (let i = 0; i < 12; i++) input[i] = binToHex(hexParity, i * 6);
	for (let i = 0; i < 12; i++) input[12 + i] = binToHex(hexData, i * 6);
	for (let i = 24; i < 63; i++) input[i] = 0;

	const err = rs6.decode(input, output);
	for (let i = 0; i < 12; i++) hexToBin(output[12 + i], hexData, i * 6);
	return err;
}

/**
 * Reed-Solomon (24,16,9) decode for P25 LDU2.
 * @param hexData 16 hex words (16*6 = 96 bits)
 * @param hexParity 8 hex words (8*6 = 48 bits)
 * @returns 1 on irrecoverable error, 0 on success
 */
export function rsDecode_24_16_9(hexData: Int8Array, hexParity: Int8Array): number {
	const input = new Int32Array(63);
	const output = new Int32Array(63);
	for (let i = 0; i < 8; i++) input[i] = binToHex(hexParity, i * 6);
	for (let i = 0; i < 16; i++) input[8 + i] = binToHex(hexData, i * 6);
	for (let i = 24; i < 63; i++) input[i] = 0;

	const err = rs4.decode(input, output);
	for (let i = 0; i < 16; i++) hexToBin(output[8 + i], hexData, i * 6);
	return err;
}
