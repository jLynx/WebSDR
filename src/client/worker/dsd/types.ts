/*
 * DSD (Digital Speech Decoder) types, constants, and interleave tables.
 * Ported from SDR++ Brown ch_extravhf_decoder.
 *
 * Original DSD source: https://github.com/szechyjs/dsd
 * Copyright (C) 2010 DSD Author (ISC License)
 */

// ── Detected DSD mode ────────────────────────────────────────────────
export type DSDMode = 'dmr' | 'dstar' | 'p25' | 'nxdn' | 'unknown';

export interface DSDStatus {
	mode: DSDMode;
	synced: boolean;
	/** Which sync word was matched (e.g. "DMR_BS_VOICE") */
	syncName?: string;

	// ── mbelib state ──
	/** Whether mbelib WASM is loaded and ready */
	mbelibLoaded?: boolean;
	/** Whether MBE decoder is actively producing audio */
	mbeDecoding?: boolean;
	/** MBE error bar string (e.g. "======R") — one char per voice frame */
	mbeErrors?: string;
	/** Total voice frames decoded this session */
	voiceFrameCount?: number;

	// ── DMR ──
	/** DMR color code (0-15) */
	colorCode?: number;
	/** DMR current slot (0 or 1) */
	slot?: number;
	/** DMR slot 0 burst type description */
	slot0Burst?: string;
	/** DMR slot 1 burst type description */
	slot1Burst?: string;

	// ── P25 ──
	/** P25 Network Access Code (12-bit) */
	nac?: number;
	/** P25 Data Unit ID type string */
	duid?: string;
	/** P25 Source ID */
	src?: number;
	/** P25 Talkgroup ID */
	tg?: number;
	/** P25 Emergency flag */
	emr?: boolean;
	/** P25 Algorithm ID (encryption) */
	algid?: number;

	// ── D-STAR ──
	/** D-STAR callsign (if decoded from header) */
	callsign?: string;

	// ── NXDN ──
	/** NXDN type description */
	nxdnType?: string;
}

// ── Sync word patterns (dibit strings: 0=+3, 1=+1, 2=-1, 3=-3) ─────
// Each character is a dibit value: '0','1','2','3'
export const SYNC_WORDS = {
	// P25 Phase 1
	P25P1:         '111113113311333313133333',
	INV_P25P1:     '333331331133111131311111',

	// DMR Base Station
	DMR_BS_DATA:   '313333111331131131331131',
	DMR_BS_VOICE:  '131111333113313313113313',
	// DMR Mobile Station
	DMR_MS_DATA:   '311131133313133331131113',
	DMR_MS_VOICE:  '133313311131311113313331',
	// DMR Direct Mode
	DMR_DM_TS1_DATA:  '331333313111313133311111',
	DMR_DM_TS1_VOICE: '113111131333131311133333',
	DMR_DM_TS2_DATA:  '311311111333113333133311',
	DMR_DM_TS2_VOICE: '133133333111331111311133',

	// D-STAR
	DSTAR_HD:      '131313131333133113131111',
	INV_DSTAR_HD:  '313131313111311331313333',
	DSTAR:         '313131313133131113313111',
	INV_DSTAR:     '131313131311313331131333',

	// NXDN
	NXDN_MS_DATA:      '313133113131111333',
	INV_NXDN_MS_DATA:  '131311331313333111',
	NXDN_MS_VOICE:     '313133113131113133',
	INV_NXDN_MS_VOICE: '131311331313331311',
	NXDN_BS_DATA:      '313133113131111313',
	INV_NXDN_BS_DATA:  '131311331313333131',
	NXDN_BS_VOICE:     '313133113131113113',
	INV_NXDN_BS_VOICE: '131311331313331331',
} as const;

// ── Sync word length by protocol ─────────────────────────────────────
export const SYNC_LEN_24 = 24; // P25, DMR, D-STAR
export const SYNC_LEN_18 = 18; // NXDN

// ── Symbol rate and IF sample rate ───────────────────────────────────
export const DSD_SYMBOL_RATE = 4800;
export const DSD_IF_RATE = 9600; // 2 samples per symbol
export const DSD_AUDIO_RATE = 8000; // mbelib output rate
export const MBE_SAMPLES_PER_FRAME = 160; // 160 samples @ 8 kHz = 20 ms

// ── 4-FSK slicer constants ───────────────────────────────────────────
export const SLICER_MID_FACTOR = 0.6; // threshold factor for umid/lmid
export const SLICER_MAX_CLAMP = 1.3;
export const SLICER_MIN_CLAMP = -1.3;
export const SLICER_LVL_BUF_SIZE = 1024;

// ── MBE quality setting ──────────────────────────────────────────────
export const MBE_UV_QUALITY = 3;

// ── DMR AMBE interleave schedule (36 elements each) ──────────────────
export const DMR_W = new Int8Array([
	0, 1, 0, 1, 0, 1,
	0, 1, 0, 1, 0, 1,
	0, 1, 0, 1, 0, 1,
	0, 1, 0, 1, 0, 2,
	0, 2, 0, 2, 0, 2,
	0, 2, 0, 2, 0, 2,
]);
export const DMR_X = new Int8Array([
	23, 10, 22, 9, 21, 8,
	20, 7, 19, 6, 18, 5,
	17, 4, 16, 3, 15, 2,
	14, 1, 13, 0, 12, 10,
	11, 9, 10, 8, 9, 7,
	8, 6, 7, 5, 6, 4,
]);
export const DMR_Y = new Int8Array([
	0, 2, 0, 2, 0, 2,
	0, 2, 0, 3, 0, 3,
	1, 3, 1, 3, 1, 3,
	1, 3, 1, 3, 1, 3,
	1, 3, 1, 3, 1, 3,
	1, 3, 1, 3, 1, 3,
]);
export const DMR_Z = new Int8Array([
	5, 3, 4, 2, 3, 1,
	2, 0, 1, 13, 0, 12,
	22, 11, 21, 10, 20, 9,
	19, 8, 18, 7, 17, 6,
	16, 5, 15, 4, 14, 3,
	13, 2, 12, 1, 11, 0,
]);

// ── P25 IMBE interleave schedule (72 elements each) ──────────────────
export const P25_IW = new Int8Array([
	0, 2, 4, 1, 3, 5,
	0, 2, 4, 1, 3, 6,
	0, 2, 4, 1, 3, 6,
	0, 2, 4, 1, 3, 6,
	0, 2, 4, 1, 3, 6,
	0, 2, 4, 1, 3, 6,
	0, 2, 5, 1, 3, 6,
	0, 2, 5, 1, 3, 6,
	0, 2, 5, 1, 3, 7,
	0, 2, 5, 1, 3, 7,
	0, 2, 5, 1, 4, 7,
	0, 3, 5, 2, 4, 7,
]);
export const P25_IX = new Int8Array([
	22, 20, 10, 20, 18, 0,
	20, 18, 8, 18, 16, 13,
	18, 16, 6, 16, 14, 11,
	16, 14, 4, 14, 12, 9,
	14, 12, 2, 12, 10, 7,
	12, 10, 0, 10, 8, 5,
	10, 8, 13, 8, 6, 3,
	8, 6, 11, 6, 4, 1,
	6, 4, 9, 4, 2, 6,
	4, 2, 7, 2, 0, 4,
	2, 0, 5, 0, 13, 2,
	0, 21, 3, 21, 11, 0,
]);
export const P25_IY = new Int8Array([
	1, 3, 5, 0, 2, 4,
	1, 3, 6, 0, 2, 4,
	1, 3, 6, 0, 2, 4,
	1, 3, 6, 0, 2, 4,
	1, 3, 6, 0, 2, 4,
	1, 3, 6, 0, 2, 5,
	1, 3, 6, 0, 2, 5,
	1, 3, 6, 0, 2, 5,
	1, 3, 6, 0, 2, 5,
	1, 3, 7, 0, 2, 5,
	1, 4, 7, 0, 3, 5,
	2, 4, 7, 1, 3, 5,
]);
export const P25_IZ = new Int8Array([
	21, 19, 1, 21, 19, 9,
	19, 17, 14, 19, 17, 7,
	17, 15, 12, 17, 15, 5,
	15, 13, 10, 15, 13, 3,
	13, 11, 8, 13, 11, 1,
	11, 9, 6, 11, 9, 14,
	9, 7, 4, 9, 7, 12,
	7, 5, 2, 7, 5, 10,
	5, 3, 0, 5, 3, 8,
	3, 1, 5, 3, 1, 6,
	1, 14, 3, 1, 22, 4,
	22, 12, 1, 22, 20, 2,
]);

// ── D-STAR AMBE interleave schedule (72 elements each) ───────────────
export const DSTAR_W = new Int8Array([
	0, 0, 3, 2, 1, 1, 0, 0, 1, 1, 0, 0,
	3, 2, 1, 1, 3, 2, 1, 1, 0, 0, 3, 2,
	0, 0, 3, 2, 1, 1, 0, 0, 1, 1, 0, 0,
	3, 2, 1, 1, 3, 2, 1, 1, 0, 0, 3, 2,
	0, 0, 3, 2, 1, 1, 0, 0, 1, 1, 0, 0,
	3, 2, 1, 1, 3, 3, 2, 1, 0, 0, 3, 3,
]);
export const DSTAR_X = new Int8Array([
	10, 22, 11, 9, 10, 22, 11, 23, 8, 20, 9, 21,
	10, 8, 9, 21, 8, 6, 7, 19, 8, 20, 9, 7,
	6, 18, 7, 5, 6, 18, 7, 19, 4, 16, 5, 17,
	6, 4, 5, 17, 4, 2, 3, 15, 4, 16, 5, 3,
	2, 14, 3, 1, 2, 14, 3, 15, 0, 12, 1, 13,
	2, 0, 1, 13, 0, 12, 10, 11, 0, 12, 1, 13,
]);

// ── NXDN AMBE interleave schedule (36 elements each) ─────────────────
// Same as DMR interleave
export const NXDN_W = DMR_W;
export const NXDN_X = DMR_X;
export const NXDN_Y = DMR_Y;
export const NXDN_Z = DMR_Z;

// ── NXDN pseudo-random bit sequence (144 elements) ───────────────────
export const NXDN_PR = new Uint8Array([
	1, 0, 0, 1, 0, 0,
	0, 1, 0, 1, 0, 0,
	0, 0, 1, 0, 1, 0,
	1, 1, 0, 1, 0, 0,
	1, 1, 1, 1, 1, 1,
	0, 1, 1, 0, 0, 1,
	0, 0, 1, 0, 0, 1,
	0, 1, 1, 0, 1, 1,
	1, 1, 1, 1, 0, 0,
	1, 0, 0, 1, 1, 0,
	1, 0, 1, 0, 0, 1,
	1, 0, 0, 1, 1, 0,
	0, 0, 0, 0, 0, 0,
	1, 1, 0, 0, 0, 1,
	1, 0, 0, 1, 0, 1,
	0, 0, 0, 1, 1, 0,
	1, 0, 0, 1, 0, 1,
	1, 1, 1, 1, 1, 1,
	0, 1, 0, 0, 0, 1,
	0, 1, 1, 0, 0, 0,
	1, 1, 1, 0, 1, 0,
	1, 1, 0, 0, 1, 0,
	1, 1, 0, 0, 1, 1,
	1, 1, 0, 0, 0, 1,
]);

// ── Dibit-to-symbol mapping ──────────────────────────────────────────
// SDR++ Brown 4FSK mapping: 01=+1.0, 00=+0.5, 10=-0.5, 11=-1.0
// In the dibit stream: 0 = +3, 1 = +1, 2 = -1, 3 = -3 (standard 4FSK)

/** Invert a dibit (0<->2, 1<->3) */
export function invertDibit(d: number): number {
	return d ^ 2;
}

// ── RRC filter design constants ──────────────────────────────────────
export const RRC_ALPHA = 0.2; // roll-off factor
export const RRC_NUM_TAPS = 65;

// ── Frame sync state ─────────────────────────────────────────────────
export const enum SyncType {
	NONE = -1,
	P25P1 = 0,
	INV_P25P1 = 1,
	X2TDMA_BS_VOICE = 2,
	X2TDMA_BS_DATA = 3,
	X2TDMA_MS_VOICE = 4,
	X2TDMA_MS_DATA = 5,
	DSTAR = 6,
	INV_DSTAR = 7,
	NXDN_MS_DATA = 8,
	INV_NXDN_MS_DATA = 9,
	NXDN_MS_VOICE = 10,
	INV_NXDN_MS_VOICE = 11,
	DMR_BS_DATA = 12,
	DMR_BS_VOICE = 13,
	DMR_MS_DATA = 14,
	DMR_MS_VOICE = 15,
	PROVOICE = 16,
	INV_PROVOICE = 17,
	NXDN_BS_DATA = 18,
	INV_NXDN_BS_DATA = 19,
	NXDN_BS_VOICE = 20,
	INV_NXDN_BS_VOICE = 21,
	DSTAR_HD = 22,
	INV_DSTAR_HD = 23,
	DMR_DM_TS1_DATA = 24,
	DMR_DM_TS1_VOICE = 25,
	DMR_DM_TS2_DATA = 26,
	DMR_DM_TS2_VOICE = 27,
}

/** Human-readable label for a SyncType value */
export function syncTypeLabel(st: SyncType): string {
	switch (st) {
		case SyncType.P25P1: return 'P25P1';
		case SyncType.INV_P25P1: return '-P25P1';
		case SyncType.DMR_BS_DATA: return 'DMR_BS_DATA';
		case SyncType.DMR_BS_VOICE: return 'DMR_BS_VOICE';
		case SyncType.DMR_MS_DATA: return 'DMR_MS_DATA';
		case SyncType.DMR_MS_VOICE: return 'DMR_MS_VOICE';
		case SyncType.DMR_DM_TS1_DATA: return 'DMR_DM1_DATA';
		case SyncType.DMR_DM_TS1_VOICE: return 'DMR_DM1_VOICE';
		case SyncType.DMR_DM_TS2_DATA: return 'DMR_DM2_DATA';
		case SyncType.DMR_DM_TS2_VOICE: return 'DMR_DM2_VOICE';
		case SyncType.DSTAR: return 'DSTAR';
		case SyncType.INV_DSTAR: return '-DSTAR';
		case SyncType.DSTAR_HD: return 'DSTAR_HD';
		case SyncType.INV_DSTAR_HD: return '-DSTAR_HD';
		case SyncType.NXDN_MS_DATA: return 'NXDN_MS_DATA';
		case SyncType.INV_NXDN_MS_DATA: return '-NXDN_MS_DATA';
		case SyncType.NXDN_MS_VOICE: return 'NXDN_MS_VOICE';
		case SyncType.INV_NXDN_MS_VOICE: return '-NXDN_MS_VOICE';
		case SyncType.NXDN_BS_DATA: return 'NXDN_BS_DATA';
		case SyncType.INV_NXDN_BS_DATA: return '-NXDN_BS_DATA';
		case SyncType.NXDN_BS_VOICE: return 'NXDN_BS_VOICE';
		case SyncType.INV_NXDN_BS_VOICE: return '-NXDN_BS_VOICE';
		default: return 'UNKNOWN';
	}
}

/** Map SyncType to DSDMode */
export function syncTypeToMode(st: SyncType): DSDMode {
	switch (st) {
		case SyncType.P25P1:
		case SyncType.INV_P25P1:
			return 'p25';
		case SyncType.DMR_BS_DATA:
		case SyncType.DMR_BS_VOICE:
		case SyncType.DMR_MS_DATA:
		case SyncType.DMR_MS_VOICE:
		case SyncType.DMR_DM_TS1_DATA:
		case SyncType.DMR_DM_TS1_VOICE:
		case SyncType.DMR_DM_TS2_DATA:
		case SyncType.DMR_DM_TS2_VOICE:
			return 'dmr';
		case SyncType.DSTAR:
		case SyncType.INV_DSTAR:
		case SyncType.DSTAR_HD:
		case SyncType.INV_DSTAR_HD:
			return 'dstar';
		case SyncType.NXDN_MS_DATA:
		case SyncType.INV_NXDN_MS_DATA:
		case SyncType.NXDN_MS_VOICE:
		case SyncType.INV_NXDN_MS_VOICE:
		case SyncType.NXDN_BS_DATA:
		case SyncType.INV_NXDN_BS_DATA:
		case SyncType.NXDN_BS_VOICE:
		case SyncType.INV_NXDN_BS_VOICE:
			return 'nxdn';
		default:
			return 'unknown';
	}
}

/** Is this a voice sync (as opposed to data)? */
export function isVoiceSync(st: SyncType): boolean {
	switch (st) {
		case SyncType.DMR_BS_VOICE:
		case SyncType.DMR_MS_VOICE:
		case SyncType.DMR_DM_TS1_VOICE:
		case SyncType.DMR_DM_TS2_VOICE:
		case SyncType.NXDN_MS_VOICE:
		case SyncType.INV_NXDN_MS_VOICE:
		case SyncType.NXDN_BS_VOICE:
		case SyncType.INV_NXDN_BS_VOICE:
		case SyncType.P25P1:
		case SyncType.INV_P25P1:
		case SyncType.DSTAR:
		case SyncType.INV_DSTAR:
			return true;
		default:
			return false;
	}
}
