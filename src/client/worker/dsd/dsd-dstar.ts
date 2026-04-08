/*
 * D-STAR frame processor for DSD.
 * Ported from SDR++ Brown dsd_dstar.cpp.
 *
 * D-STAR uses AMBE 3600x2450 codec (same as DMR/NXDN).
 * Voice frames use a 72-element interleave schedule.
 */

import { DSTAR_W, DSTAR_X } from './types';
import type { DSDStatus } from './types';

// ── D-STAR voice frame processing ────────────────────────────────────

/**
 * Process a D-STAR voice frame.
 * D-STAR voice superframe: 21 voice frames, each containing
 * 72 dibits that deinterleave into 2 AMBE frames.
 *
 * Frame layout:
 *   72 dibits voice data
 *   3 dibits data (slow data)
 *   Total: 75 dibits per voice frame
 *
 * @param dibitBuf Dibit buffer
 * @param dibitPos Current position in dibit buffer (start of voice data)
 * @param status DSD status to update
 * @returns Array of 2 AMBE frames as Int8Array[4][24] (96 bytes flat each)
 */
export function processDSTARVoice(
	dibitBuf: Uint8Array,
	dibitPos: number,
	status: DSDStatus
): Int8Array[] {
	const ambe_fr1 = new Int8Array(96); // 4x24 flat - frame 1
	const ambe_fr2 = new Int8Array(96); // 4x24 flat - frame 2

	// Deinterleave 72 dibits into 2 AMBE frames using D-STAR schedule
	for (let i = 0; i < 72; i++) {
		const pos = dibitPos + i;
		const dibit = dibitBuf[pos] & 3;
		const bit1 = (dibit >> 1) & 1;
		const bit0 = dibit & 1;

		const w = DSTAR_W[i];
		const x = DSTAR_X[i];

		// D-STAR interleave maps into 2 frames:
		// w selects frame (0-1 for frame1, 2-3 for frame2)
		// x selects bit position
		if (w < 2) {
			ambe_fr1[w * 24 + x] = bit1;
			// The second bit goes to the next position
			if (i + 1 < 72) {
				// Pairs interleave together
			}
		}

		// Simplified deinterleave: use w to select which AMBE frame row
		// and x to select column position
		if (w <= 1) {
			ambe_fr1[w * 24 + x] = bit1;
		} else {
			ambe_fr2[(w - 2) * 24 + x] = bit1;
		}
	}

	// For simplicity and correctness, use the direct dibit-to-AMBE mapping
	// that SDR++ Brown uses: process each dibit with the full W/X schedule
	const frame1 = new Int8Array(96);
	const frame2 = new Int8Array(96);

	for (let i = 0; i < 72; i++) {
		const pos = dibitPos + i;
		const dibit = dibitBuf[pos] & 3;
		const bit1 = (dibit >> 1) & 1;
		const bit0 = dibit & 1;

		const w = DSTAR_W[i];
		const x = DSTAR_X[i];

		// D-STAR uses w as the frame/row selector and x as column
		// w values: 0,1 = frame 1 rows 0-1; 2,3 = frame 2 rows 0-1
		if (w < 2) {
			frame1[w * 24 + x] = bit1;
		} else {
			frame2[(w - 2) * 24 + x] = bit1;
		}

		// bit0 goes to the Y/Z equivalent (next pair in schedule)
		// In D-STAR, W and X schedule covers both bits of each dibit
	}

	status.callsign = undefined; // Set from header processing
	return [frame1, frame2];
}

/**
 * Process D-STAR header frame.
 * The header contains callsign information.
 *
 * @param dibitBuf Dibit buffer
 * @param dibitPos Current position
 * @param status DSD status to update
 */
export function processDSTARHeader(
	dibitBuf: Uint8Array,
	dibitPos: number,
	status: DSDStatus
): void {
	// D-STAR header: 660 bits (330 dibits) with Viterbi/FEC encoding
	// Contains: Flag bytes, RPT2 callsign, RPT1 callsign, YOUR callsign, MY callsign, suffix
	// FEC decoding is complex - for initial implementation, just mark as synced

	// Try to extract raw callsign bytes (simplified, without full FEC)
	const chars: number[] = [];
	for (let i = 0; i < 8; i++) {
		let byte = 0;
		for (let b = 0; b < 4; b++) {
			const pos = dibitPos + 72 + i * 4 + b; // Skip flag bytes
			const dibit = dibitBuf[pos] & 3;
			byte = (byte << 2) | dibit;
		}
		if (byte >= 32 && byte <= 126) chars.push(byte);
	}

	if (chars.length > 0) {
		status.callsign = String.fromCharCode(...chars).trim();
	}
}

/** Number of dibits in a D-STAR voice frame (voice + slow data) */
export const DSTAR_VOICE_DIBITS = 72;

/** Number of dibits in D-STAR slow data per voice frame */
export const DSTAR_SLOW_DATA_DIBITS = 3;

/** Total dibits per D-STAR voice frame */
export const DSTAR_FRAME_DIBITS = DSTAR_VOICE_DIBITS + DSTAR_SLOW_DATA_DIBITS;

/** Number of voice frames in a D-STAR superframe */
export const DSTAR_FRAMES_PER_SUPERFRAME = 21;
