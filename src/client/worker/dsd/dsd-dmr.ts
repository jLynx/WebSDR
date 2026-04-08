/*
 * DMR (Digital Mobile Radio) frame processor for DSD.
 * Ported from SDR++ Brown dsd_dmr.cpp.
 *
 * DMR uses 2-slot TDMA with AMBE 3600x2450 codec.
 * Voice superframe: 6 bursts, each containing 3 AMBE frames.
 */

import { DMR_W, DMR_X, DMR_Y, DMR_Z, SYNC_WORDS } from './types';
import type { DSDStatus } from './types';

// ── DMR burst type detection ─────────────────────────────────────────

/** DMR burst types */
const BURST_TYPES = [
	'PI Header',
	'Voice Header',
	'TLC',
	'CSBK',
	'MBC Header',
	'MBC Cont',
	'Data Header',
	'Rate 1/2 Data',
	'Rate 3/4 Data',
	'Idle',
	'Rate 1 Data',
	'Unknown Data',
] as const;

/**
 * Extract color code from a DMR CACH (Common Annex Channel).
 * The CACH is 12 dibits (24 bits) between the two slot halves.
 *
 * @param cachDibits 12 dibits of CACH data
 * @returns Color code (0-15) or -1 if invalid
 */
function extractColorCode(cachDibits: Uint8Array, offset: number): number {
	// CACH format: TACT (7 bits) + payload
	// Color code is in bits 0-3 of the TACT
	let tact = 0;
	for (let i = 0; i < 4; i++) {
		const dibit = cachDibits[offset + i] & 3;
		tact = (tact << 2) | dibit;
	}
	// Color code from bits 4-7 (first 4 bits of TACT after hamming)
	return (tact >> 4) & 0xF;
}

/**
 * Process a DMR voice burst and extract AMBE frames.
 *
 * A DMR voice superframe consists of 6 bursts. Each burst:
 *   - 54 dibits: first half of voice payload
 *   - 12 dibits: CACH (inter-slot signaling)
 *   - 54 dibits: second half of voice payload
 *   Total payload: 108 dibits = 216 bits
 *   This encodes 3 AMBE frames of 36 dibits each (108 total).
 *
 * @param dibitBuf Dibit buffer
 * @param dibitPos Position at start of burst payload (after sync)
 * @param burstIndex Which burst (0-5) in the superframe
 * @param status DSD status to update
 * @returns Array of up to 3 AMBE frames as Int8Array[4][24] (96 bytes flat)
 */
export function processDMRVoiceBurst(
	dibitBuf: Uint8Array,
	dibitPos: number,
	burstIndex: number,
	status: DSDStatus
): Int8Array[] {
	const frames: Int8Array[] = [];

	// Extract 3 AMBE frames from this burst
	// Each AMBE frame uses 36 dibits with interleaving
	for (let frameIdx = 0; frameIdx < 3; frameIdx++) {
		const ambe_fr = new Int8Array(96); // 4x24 flat

		for (let i = 0; i < 36; i++) {
			// Calculate position in the burst
			// Burst layout: 54 dibits | 12 CACH | 54 dibits
			let pos: number;
			const linearPos = frameIdx * 36 + i;

			if (linearPos < 54) {
				pos = dibitPos + linearPos;
			} else {
				// Skip the 12 CACH dibits
				pos = dibitPos + linearPos + 12;
			}

			const dibit = dibitBuf[pos] & 3;
			const bit1 = (dibit >> 1) & 1;
			const bit0 = dibit & 1;

			// Deinterleave using DMR schedule
			const w = DMR_W[i];
			const x = DMR_X[i];
			const y = DMR_Y[i];
			const z = DMR_Z[i];

			ambe_fr[w * 24 + x] = bit1;
			ambe_fr[y * 24 + z] = bit0;
		}

		frames.push(ambe_fr);
	}

	return frames;
}

/**
 * Process a complete DMR voice superframe (6 bursts = 18 AMBE frames).
 *
 * @param dibitBuf Dibit buffer
 * @param dibitPos Position at start of first burst
 * @param status DSD status to update
 * @returns Array of all AMBE frames extracted
 */
export function processDMRVoice(
	dibitBuf: Uint8Array,
	dibitPos: number,
	status: DSDStatus
): Int8Array[] {
	const allFrames: Int8Array[] = [];
	let pos = dibitPos;

	// The first burst is special - sync word was already consumed
	// Subsequent bursts: 54 + 12(CACH) + 54 + 24(sync) = 144 dibits each

	for (let burst = 0; burst < 6; burst++) {
		const frames = processDMRVoiceBurst(dibitBuf, pos, burst, status);
		allFrames.push(...frames);

		// Skip to next burst: 54 + 12 + 54 = 120 payload dibits + 24 sync dibits
		pos += 120 + 24;
	}

	return allFrames;
}

/**
 * Process a single DMR voice burst.
 * Called per-burst from the main decoder state machine.
 *
 * @param dibitBuf Dibit buffer
 * @param dibitPos Start of the 108 payload dibits (after sync consumed)
 * @param status DSD status to update
 * @returns Array of 3 AMBE frames
 */
export function processDMRSingleBurst(
	dibitBuf: Uint8Array,
	dibitPos: number,
	status: DSDStatus
): Int8Array[] {
	const frames: Int8Array[] = [];

	for (let frameIdx = 0; frameIdx < 3; frameIdx++) {
		const ambe_fr = new Int8Array(96); // 4x24 flat

		for (let i = 0; i < 36; i++) {
			const linearPos = frameIdx * 36 + i;
			const pos = dibitPos + linearPos;
			const dibit = dibitBuf[pos] & 3;
			const bit1 = (dibit >> 1) & 1;
			const bit0 = dibit & 1;

			ambe_fr[DMR_W[i] * 24 + DMR_X[i]] = bit1;
			ambe_fr[DMR_Y[i] * 24 + DMR_Z[i]] = bit0;
		}

		frames.push(ambe_fr);
	}

	return frames;
}

/**
 * Process DMR data burst (non-voice).
 * Data bursts don't produce audio.
 *
 * @param dibitBuf Dibit buffer
 * @param dibitPos Position at start of burst
 * @param status DSD status to update
 * @param slotIndex Which slot (0 or 1)
 */
export function processDMRData(
	dibitBuf: Uint8Array,
	dibitPos: number,
	status: DSDStatus,
	slotIndex: number
): void {
	if (slotIndex === 0) {
		status.slot0Burst = 'Data';
	} else {
		status.slot1Burst = 'Data';
	}
}

/**
 * Try to detect color code from sync area.
 * @param dibitBuf Dibit buffer
 * @param syncPos Position of sync word start
 * @returns Color code (0-15) or -1
 */
export function detectDMRColorCode(
	dibitBuf: Uint8Array,
	syncPos: number,
): number {
	// Color code is embedded in the EMB (Embedded signaling)
	// For simplicity, extract from the CACH that precedes the sync
	// The CACH is 12 dibits before the burst sync
	const cachStart = syncPos - 12;
	if (cachStart < 0) return -1;
	return extractColorCode(dibitBuf, cachStart);
}

/** Number of dibits in a full DMR burst (payload only, no sync) */
export const DMR_BURST_DIBITS = 120; // 54 + 12(CACH) + 54

/** Number of dibits for sync word */
export const DMR_SYNC_DIBITS = 24;

/**
 * Check the sync/EMB word within a DMR voice superframe burst to detect
 * whether this burst carries voice or data. SDR++ Brown does this per-burst
 * and mutes audio for data bursts.
 *
 * The sync/EMB is 24 dibits. We collapse each dibit's polarity (positive → '1',
 * negative → '3') and compare against known sync patterns, matching the
 * SDR++ Brown convention: `(dibit | 1) + 48`.
 *
 * @param dibitBuf  Circular dibit buffer
 * @param syncPos   Position of the 24-dibit sync/EMB word in the buffer
 * @param mask      Circular buffer mask (0xFFFF)
 * @returns true if this burst is DATA (should mute), false if VOICE (decode)
 */
export function checkDMRBurstSync(
	dibitBuf: Uint8Array,
	syncPos: number,
	mask: number
): boolean {
	// Build collapsed sync string: dibits 0,1 → '1'; dibits 2,3 → '3'
	let sync = '';
	for (let i = 0; i < 24; i++) {
		const d = dibitBuf[(syncPos + i) & mask] & 3;
		sync += String.fromCharCode(((d | 1) + 48));
	}

	// Data sync patterns (any of these → mute this slot)
	if (sync === SYNC_WORDS.DMR_BS_DATA ||
		sync === SYNC_WORDS.DMR_MS_DATA ||
		sync === SYNC_WORDS.DMR_DM_TS1_DATA ||
		sync === SYNC_WORDS.DMR_DM_TS2_DATA) {
		return true; // DATA → mute
	}

	// Voice sync patterns or unrecognized EMB → don't mute
	return false;
}
