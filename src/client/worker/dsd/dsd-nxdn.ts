/*
 * NXDN frame processor for DSD.
 * Ported from SDR++ Brown dsd_nxdn.cpp.
 *
 * NXDN uses AMBE 3600x2450 codec, same as DMR.
 * Voice frames are XORed with a pseudo-random sequence before interleaving.
 */

import { NXDN_W, NXDN_X, NXDN_Y, NXDN_Z, NXDN_PR } from './types';
import type { DSDStatus } from './types';

/**
 * Process an NXDN voice frame.
 * Extracts 4 AMBE frames from the dibit stream.
 *
 * @param dibitBuf Dibit buffer (should have at least 182 dibits from current position)
 * @param dibitPos Current position in dibit buffer
 * @param status DSD status to update
 * @returns Array of 4 AMBE frames, each as Int8Array[4][24] (96 bytes flat)
 */
export function processNXDNVoice(
	dibitBuf: Uint8Array,
	dibitPos: number,
	status: DSDStatus
): Int8Array[] {
	const frames: Int8Array[] = [];

	// NXDN voice frame: 4 AMBE frames, each 36 dibits
	for (let frame = 0; frame < 4; frame++) {
		const ambe_fr = new Int8Array(96); // 4x24 flat

		for (let i = 0; i < 36; i++) {
			const pos = dibitPos + frame * 36 + i;
			const dibit = dibitBuf[pos] & 3;

			// XOR with pseudo-random sequence
			const prIdx = frame * 36 + i;
			const prBit = prIdx < NXDN_PR.length ? NXDN_PR[prIdx] : 0;

			const bit1 = ((dibit >> 1) & 1) ^ prBit;
			const bit0 = (dibit & 1) ^ prBit;

			// Deinterleave using NXDN schedule (same as DMR)
			const w = NXDN_W[i];
			const x = NXDN_X[i];
			const y = NXDN_Y[i];
			const z = NXDN_Z[i];

			ambe_fr[w * 24 + x] = bit1;
			ambe_fr[y * 24 + z] = bit0;
		}

		frames.push(ambe_fr);
	}

	status.nxdnType = 'Voice';
	return frames;
}

/**
 * Process an NXDN data frame (non-voice).
 * Data frames are skipped (no audio output).
 *
 * @param dibitBuf Dibit buffer
 * @param dibitPos Current position
 * @param status DSD status to update
 */
export function processNXDNData(
	dibitBuf: Uint8Array,
	dibitPos: number,
	status: DSDStatus
): void {
	status.nxdnType = 'Data';
	// Data frames don't produce audio - nothing to decode
}

/** Number of dibits consumed by an NXDN voice frame */
export const NXDN_VOICE_DIBITS = 144; // 4 * 36

/** Number of dibits consumed by an NXDN data frame */
export const NXDN_DATA_DIBITS = 144;
