/*
 * Main DSD (Digital Speech Decoder) state machine.
 * Handles frame sync detection and dispatches to mode-specific processors.
 * Ported from SDR++ Brown dsd.h / dsd_demod.cpp.
 */

import { FIRFilter, ClockRecovery, FourFSKSlicer, FMDiscriminator, rrcTaps } from './dsd-dsp';
import { SYNC_WORDS, DSD_IF_RATE, DSD_SYMBOL_RATE, DSD_AUDIO_RATE, MBE_SAMPLES_PER_FRAME, RRC_ALPHA, RRC_NUM_TAPS, SyncType, syncTypeToMode, syncTypeLabel, isVoiceSync } from './types';
import type { DSDMode, DSDStatus } from './types';
import { processDMRSingleBurst, DMR_BURST_DIBITS } from './dsd-dmr';
import { processNXDNVoice, NXDN_VOICE_DIBITS } from './dsd-nxdn';
import { processDSTARVoice, DSTAR_VOICE_DIBITS, DSTAR_FRAME_DIBITS } from './dsd-dstar';
import { parseP25NID, extractP25IMBE, processP25LDU1, processP25LDU2, processP25HDU, processP25TDU, processP25TDULC, P25_NID_DIBITS, P25_LDU_BODY_DIBITS, DUID_LDU1, DUID_LDU2, DUID_HDU, DUID_TDU, DUID_TDULC } from './dsd-p25';
import { decodeAmbe, decodeImbe, ensureMbelibInitialized, isMbelibReady, resetMbe } from '../mbelib-init';

// ── Sync word matching ───────────────────────────────────────────────

interface SyncPattern {
	pattern: string;
	type: SyncType;
	len: number;
}

const SYNC_PATTERNS: SyncPattern[] = [
	// P25 (24 dibits)
	{ pattern: SYNC_WORDS.P25P1, type: SyncType.P25P1, len: 24 },
	{ pattern: SYNC_WORDS.INV_P25P1, type: SyncType.INV_P25P1, len: 24 },
	// DMR (24 dibits)
	{ pattern: SYNC_WORDS.DMR_BS_DATA, type: SyncType.DMR_BS_DATA, len: 24 },
	{ pattern: SYNC_WORDS.DMR_BS_VOICE, type: SyncType.DMR_BS_VOICE, len: 24 },
	{ pattern: SYNC_WORDS.DMR_MS_DATA, type: SyncType.DMR_MS_DATA, len: 24 },
	{ pattern: SYNC_WORDS.DMR_MS_VOICE, type: SyncType.DMR_MS_VOICE, len: 24 },
	{ pattern: SYNC_WORDS.DMR_DM_TS1_DATA, type: SyncType.DMR_DM_TS1_DATA, len: 24 },
	{ pattern: SYNC_WORDS.DMR_DM_TS1_VOICE, type: SyncType.DMR_DM_TS1_VOICE, len: 24 },
	{ pattern: SYNC_WORDS.DMR_DM_TS2_DATA, type: SyncType.DMR_DM_TS2_DATA, len: 24 },
	{ pattern: SYNC_WORDS.DMR_DM_TS2_VOICE, type: SyncType.DMR_DM_TS2_VOICE, len: 24 },
	// D-STAR (24 dibits)
	{ pattern: SYNC_WORDS.DSTAR, type: SyncType.DSTAR, len: 24 },
	{ pattern: SYNC_WORDS.INV_DSTAR, type: SyncType.INV_DSTAR, len: 24 },
	{ pattern: SYNC_WORDS.DSTAR_HD, type: SyncType.DSTAR_HD, len: 24 },
	{ pattern: SYNC_WORDS.INV_DSTAR_HD, type: SyncType.INV_DSTAR_HD, len: 24 },
	// NXDN (18 dibits)
	{ pattern: SYNC_WORDS.NXDN_MS_DATA, type: SyncType.NXDN_MS_DATA, len: 18 },
	{ pattern: SYNC_WORDS.INV_NXDN_MS_DATA, type: SyncType.INV_NXDN_MS_DATA, len: 18 },
	{ pattern: SYNC_WORDS.NXDN_MS_VOICE, type: SyncType.NXDN_MS_VOICE, len: 18 },
	{ pattern: SYNC_WORDS.INV_NXDN_MS_VOICE, type: SyncType.INV_NXDN_MS_VOICE, len: 18 },
	{ pattern: SYNC_WORDS.NXDN_BS_DATA, type: SyncType.NXDN_BS_DATA, len: 18 },
	{ pattern: SYNC_WORDS.INV_NXDN_BS_DATA, type: SyncType.INV_NXDN_BS_DATA, len: 18 },
	{ pattern: SYNC_WORDS.NXDN_BS_VOICE, type: SyncType.NXDN_BS_VOICE, len: 18 },
	{ pattern: SYNC_WORDS.INV_NXDN_BS_VOICE, type: SyncType.INV_NXDN_BS_VOICE, len: 18 },
];

/** Maximum bit errors allowed when matching sync words. */
const SYNC_TOLERANCE = 2;

/**
 * Try to match the sync word in the dibit history buffer.
 * Allows up to SYNC_TOLERANCE bit mismatches.
 */
function matchSync(dibitHistory: string): SyncType {
	const len = dibitHistory.length;

	for (const sp of SYNC_PATTERNS) {
		if (len < sp.len) continue;
		const start = len - sp.len;
		let mismatches = 0;
		let matched = true;

		for (let i = 0; i < sp.len; i++) {
			if (dibitHistory[start + i] !== sp.pattern[i]) {
				mismatches++;
				if (mismatches > SYNC_TOLERANCE) {
					matched = false;
					break;
				}
			}
		}

		if (matched) return sp.type;
	}

	return SyncType.NONE;
}

// ── Main DSD Decoder ─────────────────────────────────────────────────

/**
 * DSD Decoder class.
 * Processes FM-demodulated audio at DSD_IF_RATE and outputs decoded voice.
 */
export class DSDDecoder {
	// DSP chain
	private rrcFilter: FIRFilter;
	private clockRecovery: ClockRecovery;
	private slicer: FourFSKSlicer;

	// State
	private dibitHistory: string = '';
	private dibitBuf: Uint8Array;
	private dibitBufPos = 0;
	private currentSync: SyncType = SyncType.NONE;
	private lastSyncType: SyncType = SyncType.NONE;
	private frameSyncLost = 0;
	private synced = false;
	private mbelibReady = false;

	// Audio output accumulator
	private audioAccum: Float32Array;
	private audioAccumLen = 0;

	// Callbacks
	private onAudio: (samples: Float32Array) => void;
	private onStatus: (status: DSDStatus) => void;

	// Status
	private status: DSDStatus = {
		mode: 'unknown',
		synced: false,
		mbelibLoaded: false,
		voiceFrameCount: 0,
	};

	// Resampler: 8000 → 48000 Hz (handled externally, but we provide 8kHz)
	private mbeInitPromise: Promise<void> | null = null;

	constructor(
		onAudio: (samples: Float32Array) => void,
		onStatus: (status: DSDStatus) => void
	) {
		this.onAudio = onAudio;
		this.onStatus = onStatus;

		// Build RRC filter taps
		const taps = rrcTaps(RRC_NUM_TAPS, DSD_IF_RATE, DSD_SYMBOL_RATE, RRC_ALPHA);
		this.rrcFilter = new FIRFilter(taps);

		// Clock recovery: 9600 Hz → 4800 sym/s
		this.clockRecovery = new ClockRecovery(DSD_IF_RATE, DSD_SYMBOL_RATE);

		// 4-FSK slicer
		this.slicer = new FourFSKSlicer();

		// Dibit buffer (circular, large enough for any frame)
		this.dibitBuf = new Uint8Array(65536);

		// Audio accumulator
		this.audioAccum = new Float32Array(8000); // 1 second at 8 kHz

		// Start mbelib initialization
		this.mbeInitPromise = ensureMbelibInitialized().then(() => {
			this.mbelibReady = true;
			this.status.mbelibLoaded = true;
			console.log('DSD: mbelib WASM loaded — voice decoding enabled');
		}).catch(err => {
			this.status.mbelibLoaded = false;
			console.warn('DSD: mbelib WASM not available — run mbelib-wasm/build.sh to enable voice decoding. Error:', err);
		});
	}

	/**
	 * Process a chunk of FM-demodulated audio at DSD_IF_RATE (9600 Hz).
	 * Decoded voice audio (8 kHz) is emitted via the onAudio callback.
	 */
	process(fmAudio: Float32Array): void {
		// Step 1: RRC filter
		const filtered = new Float32Array(fmAudio.length);
		this.rrcFilter.process(fmAudio, filtered);

		// Step 2: Clock recovery (extract symbols at 4800 sym/s)
		this.clockRecovery.process(filtered);
		const numSymbols = this.clockRecovery.symbolCount;
		if (numSymbols === 0) return;

		// Step 3: Slice to dibits
		const dibits = new Uint8Array(numSymbols);
		this.slicer.process(this.clockRecovery.symbolBuf, dibits, numSymbols);

		// Step 4: Feed dibits to frame sync + decoder
		for (let i = 0; i < numSymbols; i++) {
			this.feedDibit(dibits[i]);
		}

		// Emit accumulated audio
		if (this.audioAccumLen > 0) {
			this.onAudio(this.audioAccum.subarray(0, this.audioAccumLen).slice());
			this.audioAccumLen = 0;
		}
	}

	/**
	 * Feed a single dibit into the decoder state machine.
	 */
	private feedDibit(dibit: number): void {
		// Store in circular dibit buffer
		this.dibitBuf[this.dibitBufPos & 0xFFFF] = dibit;
		this.dibitBufPos++;

		// Build history string for sync matching
		this.dibitHistory += dibit.toString();

		// Keep history at reasonable length
		if (this.dibitHistory.length > 48) {
			this.dibitHistory = this.dibitHistory.slice(-48);
		}

		if (this.synced) {
			// Already synced: process frame data
			this.processFrameData();
		} else {
			// Searching for sync
			this.searchFrameSync();
		}
	}

	/**
	 * Search for frame sync pattern in recent dibit history.
	 */
	private searchFrameSync(): void {
		if (this.dibitHistory.length < 18) return; // Need at least NXDN sync length

		const syncType = matchSync(this.dibitHistory);
		if (syncType !== SyncType.NONE) {
			this.currentSync = syncType;
			this.lastSyncType = syncType;
			this.synced = true;
			this.frameSyncLost = 0;

			const mode = syncTypeToMode(syncType);
			this.status.mode = mode;
			this.status.synced = true;
			this.status.syncName = syncTypeLabel(syncType);
			this.status.mbelibLoaded = this.mbelibReady;
			this.onStatus({ ...this.status });

			// Reset dibit position for frame processing
			this.frameDataRemaining = this.getFrameLength(syncType);
			this.frameDataRead = 0;
			this.frameStart = this.dibitBufPos;
			this.dibitHistory = '';
		}
	}

	private frameDataRemaining = 0;
	private frameDataRead = 0;
	private frameStart = 0;

	/**
	 * Process dibits that are part of a frame (after sync was found).
	 */
	private processFrameData(): void {
		this.frameDataRead++;
		this.frameDataRemaining--;

		if (this.frameDataRemaining <= 0) {
			// Frame complete - process it
			this.processCompleteFrame();

			// Go back to searching for next sync
			this.synced = false;
			this.dibitHistory = '';
		}
	}

	/**
	 * Process a complete frame based on the sync type.
	 */
	private processCompleteFrame(): void {
		const syncType = this.currentSync;
		const mode = syncTypeToMode(syncType);
		const startPos = this.frameStart & 0xFFFF;

		switch (mode) {
			case 'dmr':
				this.processDMRFrame(syncType, startPos);
				break;
			case 'p25':
				this.processP25Frame(syncType, startPos);
				break;
			case 'dstar':
				this.processDSTARFrame(syncType, startPos);
				break;
			case 'nxdn':
				this.processNXDNFrame(syncType, startPos);
				break;
		}

		this.onStatus({ ...this.status });
	}

	// ── Mode-specific frame processing ─────────────────────────────

	private processDMRFrame(syncType: SyncType, startPos: number): void {
		const isVoice = isVoiceSync(syncType);

		// Update slot info based on sync type
		if (syncType === SyncType.DMR_BS_VOICE || syncType === SyncType.DMR_MS_VOICE) {
			this.status.slot0Burst = 'VOICE';
		} else if (syncType === SyncType.DMR_BS_DATA || syncType === SyncType.DMR_MS_DATA) {
			this.status.slot0Burst = 'DATA';
		}

		if (!isVoice) {
			this.status.mbeDecoding = false;
			return;
		}

		const ambeFrames = processDMRSingleBurst(this.dibitBuf, startPos, this.status);

		if (!this.mbelibReady) {
			this.status.mbeDecoding = false;
			this.status.mbeErrors = '(mbelib not loaded)';
			return;
		}

		this.status.mbeDecoding = true;
		let errBar = '';
		for (const frame of ambeFrames) {
			try {
				const audio = decodeAmbe(frame);
				this.appendAudio(audio);
				this.status.voiceFrameCount = (this.status.voiceFrameCount || 0) + 1;
				errBar += '=';
			} catch (e) {
				errBar += 'X';
			}
		}
		this.status.mbeErrors = errBar;
	}

	private processP25Frame(syncType: SyncType, startPos: number): void {
		// Parse NID to get DUID
		const nid = parseP25NID(this.dibitBuf, startPos);
		this.status.nac = nid.nac;
		this.status.duid = nid.duidName;

		const afterNid = startPos + P25_NID_DIBITS;

		const decodeImbeFrames = (frames: Int8Array[], label: string) => {
			if (!this.mbelibReady) {
				this.status.mbeDecoding = false;
				this.status.mbeErrors = '(mbelib not loaded)';
				return;
			}
			this.status.mbeDecoding = true;
			let errBar = '';
			for (const frame of frames) {
				try {
					const audio = decodeImbe(frame);
					this.appendAudio(audio);
					this.status.voiceFrameCount = (this.status.voiceFrameCount || 0) + 1;
					errBar += '=';
				} catch (e) {
					errBar += 'X';
				}
			}
			this.status.mbeErrors = errBar;
		};

		switch (nid.duid) {
			case DUID_LDU1: {
				const imbeFrames = processP25LDU1(this.dibitBuf, afterNid, this.status);
				decodeImbeFrames(imbeFrames, 'LDU1');
				break;
			}
			case DUID_LDU2: {
				const imbeFrames = processP25LDU2(this.dibitBuf, afterNid, this.status);
				decodeImbeFrames(imbeFrames, 'LDU2');
				break;
			}
			case DUID_HDU:
				processP25HDU(this.dibitBuf, afterNid, this.status);
				this.status.mbeDecoding = false;
				break;
			case DUID_TDU:
				processP25TDU(this.dibitBuf, afterNid, this.status);
				this.status.mbeDecoding = false;
				if (this.mbelibReady) resetMbe();
				break;
			case DUID_TDULC:
				processP25TDULC(this.dibitBuf, afterNid, this.status);
				this.status.mbeDecoding = false;
				if (this.mbelibReady) resetMbe();
				break;
			default:
				this.status.mbeDecoding = false;
				break;
		}
	}

	private processDSTARFrame(syncType: SyncType, startPos: number): void {
		if (syncType === SyncType.DSTAR_HD || syncType === SyncType.INV_DSTAR_HD) {
			this.status.mbeDecoding = false;
			return;
		}

		const ambeFrames = processDSTARVoice(this.dibitBuf, startPos, this.status);

		if (!this.mbelibReady) {
			this.status.mbeDecoding = false;
			this.status.mbeErrors = '(mbelib not loaded)';
			return;
		}

		this.status.mbeDecoding = true;
		let errBar = '';
		for (const frame of ambeFrames) {
			try {
				const audio = decodeAmbe(frame);
				this.appendAudio(audio);
				this.status.voiceFrameCount = (this.status.voiceFrameCount || 0) + 1;
				errBar += '=';
			} catch (e) {
				errBar += 'X';
			}
		}
		this.status.mbeErrors = errBar;
	}

	private processNXDNFrame(syncType: SyncType, startPos: number): void {
		if (!isVoiceSync(syncType)) {
			this.status.mbeDecoding = false;
			return;
		}

		const ambeFrames = processNXDNVoice(this.dibitBuf, startPos, this.status);

		if (!this.mbelibReady) {
			this.status.mbeDecoding = false;
			this.status.mbeErrors = '(mbelib not loaded)';
			return;
		}

		this.status.mbeDecoding = true;
		let errBar = '';
		for (const frame of ambeFrames) {
			try {
				const audio = decodeAmbe(frame);
				this.appendAudio(audio);
				this.status.voiceFrameCount = (this.status.voiceFrameCount || 0) + 1;
				errBar += '=';
			} catch (e) {
				errBar += 'X';
			}
		}
		this.status.mbeErrors = errBar;
	}

	// ── Audio output ────────────────────────────────────────────────

	/**
	 * Append decoded MBE audio (160 samples @ 8 kHz) to the accumulator.
	 */
	private appendAudio(audio: Float32Array): void {
		if (this.audioAccumLen + audio.length > this.audioAccum.length) {
			// Flush current accumulator
			this.onAudio(this.audioAccum.subarray(0, this.audioAccumLen).slice());
			this.audioAccumLen = 0;
		}
		this.audioAccum.set(audio, this.audioAccumLen);
		this.audioAccumLen += audio.length;
	}

	// ── Frame length calculation ────────────────────────────────────

	/**
	 * Get the expected frame length in dibits for the given sync type.
	 */
	private getFrameLength(syncType: SyncType): number {
		const mode = syncTypeToMode(syncType);
		switch (mode) {
			case 'dmr':
				return DMR_BURST_DIBITS; // 120 dibits per burst
			case 'p25':
				return P25_NID_DIBITS + P25_LDU_BODY_DIBITS; // ~752 dibits
			case 'dstar':
				return isVoiceSync(syncType)
					? DSTAR_FRAME_DIBITS  // 75 dibits
					: 330; // Header: 660 bits = 330 dibits
			case 'nxdn':
				return NXDN_VOICE_DIBITS; // 144 dibits
			default:
				return 120;
		}
	}

	/**
	 * Reset the decoder state.
	 */
	reset(): void {
		this.rrcFilter.reset();
		this.clockRecovery.reset();
		this.slicer.reset();
		this.dibitHistory = '';
		this.dibitBufPos = 0;
		this.synced = false;
		this.currentSync = SyncType.NONE;
		this.frameDataRemaining = 0;
		this.frameDataRead = 0;
		this.audioAccumLen = 0;
		this.status = { mode: 'unknown', synced: false, mbelibLoaded: this.mbelibReady, voiceFrameCount: 0 };
		if (this.mbelibReady) resetMbe();
		this.onStatus(this.status);
	}
}
