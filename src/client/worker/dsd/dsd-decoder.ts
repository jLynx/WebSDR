/*
 * Main DSD (Digital Speech Decoder) state machine.
 * Handles frame sync detection and dispatches to mode-specific processors.
 * Ported from SDR++ Brown dsd.h / dsd_demod.cpp.
 */

import { FIRFilter, ClockRecovery, FourFSKSlicer, FMDiscriminator, rrcTaps } from './dsd-dsp';
import { SYNC_WORDS, DSD_IF_RATE, DSD_SYMBOL_RATE, DSD_AUDIO_RATE, MBE_SAMPLES_PER_FRAME, RRC_ALPHA, RRC_NUM_TAPS, SyncType, syncTypeToMode, syncTypeLabel, isVoiceSync } from './types';
import type { DSDMode, DSDStatus } from './types';
import { processDMRSingleBurst, DMR_BURST_DIBITS } from './dsd-dmr';
import { checkDMRBurstSync } from './dsd-dmr';
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
const SYNC_TOLERANCE_24 = 2; // For 24-dibit syncs (DMR, P25, D-STAR)
const SYNC_TOLERANCE_18 = 1; // Stricter for 18-dibit syncs (NXDN) — fewer bits = more false positives

/**
 * Try to match the sync word in the dibit history buffer.
 * Prioritizes longer (24-dibit) syncs over shorter (18-dibit) NXDN.
 * Uses stricter tolerance for shorter sync words to reduce false positives.
 */
function matchSync(dibitHistory: string, lastMode: DSDMode): SyncType {
	const len = dibitHistory.length;

	// First pass: try 24-dibit syncs (DMR, P25, D-STAR) — highest confidence
	for (const sp of SYNC_PATTERNS) {
		if (sp.len !== 24) continue;
		if (len < 24) continue;
		const start = len - 24;
		let mismatches = 0;
		let matched = true;
		for (let i = 0; i < 24; i++) {
			if (dibitHistory[start + i] !== sp.pattern[i]) {
				mismatches++;
				if (mismatches > SYNC_TOLERANCE_24) { matched = false; break; }
			}
		}
		if (matched) return sp.type;
	}

	// Second pass: try 18-dibit syncs (NXDN) — only if we're not already locked to DMR/P25/D-STAR
	// When the decoder is idle or already in NXDN mode, allow NXDN detection.
	// This prevents false NXDN matches on DMR idle channels.
	if (lastMode === 'unknown' || lastMode === 'nxdn') {
		for (const sp of SYNC_PATTERNS) {
			if (sp.len !== 18) continue;
			if (len < 18) continue;
			const start = len - 18;
			let mismatches = 0;
			let matched = true;
			for (let i = 0; i < 18; i++) {
				if (dibitHistory[start + i] !== sp.pattern[i]) {
					mismatches++;
					if (mismatches > SYNC_TOLERANCE_18) { matched = false; break; }
				}
			}
			if (matched) return sp.type;
		}
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

	/** Count of consecutive syncs for the current mode — used for mode locking */
	private modeLockCount = 0;
	/** Locked mode: once we see 3+ consecutive syncs of the same mode, lock to it */
	private lockedMode: DSDMode = 'unknown';

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
	private _dbgProcessCalls = 0;
	private _dbgSyncCount = 0;
	private _dbgFrameCount = 0;
	private _dbgAudioEmits = 0;
	private _dbgLastLog = 0;

	process(fmAudio: Float32Array): void {
		this._dbgProcessCalls++;

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
		const framesBefore = this._dbgFrameCount;
		for (let i = 0; i < numSymbols; i++) {
			this.feedDibit(dibits[i]);
		}

		// Emit accumulated audio
		if (this.audioAccumLen > 0) {
			this._dbgAudioEmits++;
			const emitLen = this.audioAccumLen;
			this.onAudio(this.audioAccum.subarray(0, this.audioAccumLen).slice());
			this.audioAccumLen = 0;

			// Log every audio emit
			console.log(`[DSD-dec] audio emit: ${emitLen} samples @8kHz (${(emitLen/8000*1000).toFixed(0)}ms), frames decoded this chunk: ${this._dbgFrameCount - framesBefore}, total emits: ${this._dbgAudioEmits}`);
		}

		// Periodic debug summary every 2 seconds
		const now = performance.now();
		if (now - this._dbgLastLog > 2000) {
			console.log(`[DSD-dec] stats: process() calls=${this._dbgProcessCalls}, syncs=${this._dbgSyncCount}, frames=${this._dbgFrameCount}, audioEmits=${this._dbgAudioEmits}, synced=${this.synced}, mode=${this.status.mode}, mbelib=${this.mbelibReady}, fmIn=${fmAudio.length}, symbols=${numSymbols}`);
			this._dbgLastLog = now;
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
	private _lastSyncTime = 0;

	private searchFrameSync(): void {
		if (this.dibitHistory.length < 18) return; // Need at least NXDN sync length

		// Unlock mode if no sync found for 2 seconds (signal may have changed)
		if (this.lockedMode !== 'unknown') {
			const now = performance.now();
			if (now - this._lastSyncTime > 2000) {
				console.log(`[DSD-dec] mode unlock: ${this.lockedMode} → unknown (no sync for 2s)`);
				this.lockedMode = 'unknown';
				this.modeLockCount = 0;
			}
		}

		// Use locked mode to suppress false positives from other protocols
		const effectiveMode = this.lockedMode !== 'unknown' ? this.lockedMode : this.status.mode;
		const syncType = matchSync(this.dibitHistory, effectiveMode);
		if (syncType !== SyncType.NONE) {
			const mode = syncTypeToMode(syncType);

			// Mode locking: if we've locked to a mode, reject syncs from other protocols
			if (this.lockedMode !== 'unknown' && mode !== this.lockedMode) {
				// Reject — this is likely a false positive
				return;
			}

			this.currentSync = syncType;
			this.lastSyncType = syncType;
			this.synced = true;
			this.frameSyncLost = 0;
			this._dbgSyncCount++;
			this._lastSyncTime = performance.now();

			// Update mode lock counter
			if (mode === this.status.mode) {
				this.modeLockCount++;
			} else {
				this.modeLockCount = 1;
			}
			// Lock after 3 consecutive syncs of the same mode
			if (this.modeLockCount >= 3) {
				this.lockedMode = mode;
			}

			this.status.mode = mode;
			this.status.synced = true;
			this.status.syncName = syncTypeLabel(syncType);
			this.status.mbelibLoaded = this.mbelibReady;
			this.onStatus({ ...this.status });

			// Reset dibit position for frame processing
			this.frameDataRemaining = this.getFrameLength(syncType);
			this.frameDataRead = 0;
			this.frameStart = this.dibitBufPos;

			console.log(`[DSD-dec] SYNC #${this._dbgSyncCount}: ${syncTypeLabel(syncType)} (${mode}), pos=${this.dibitBufPos}, frameStart=${this.frameStart}, frameLen=${this.frameDataRemaining}, histLen=${this.dibitHistory.length}, lock=${this.lockedMode}/${this.modeLockCount}`);
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
			const endPos = this.dibitBufPos;
			// Frame complete - process it
			this.processCompleteFrame();

			// Go back to searching for next sync
			this.synced = false;
			this.dibitHistory = '';

			// DEBUG: log the next few dibits to see if a sync word is right there
			const peek: number[] = [];
			for (let k = 0; k < 30; k++) {
				peek.push(this.dibitBuf[(endPos + k) & 0xFFFF]);
			}
			console.log(`[DSD-dec] frame end at pos=${endPos}, frameStart was=${this.frameStart}, consumed=${this.frameDataRead}, next30dibits=[${peek.join('')}]`);
		}
	}

	/**
	 * Process a complete frame based on the sync type.
	 */
	private processCompleteFrame(): void {
		this._dbgFrameCount++;
		const syncType = this.currentSync;
		const mode = syncTypeToMode(syncType);
		const startPos = this.frameStart & 0xFFFF;
		const audioLenBefore = this.audioAccumLen;

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

		const audioProduced = this.audioAccumLen - audioLenBefore;
		console.log(`[DSD-dec] frame #${this._dbgFrameCount}: ${mode}/${syncTypeLabel(syncType)}, startPos=${startPos}, audioProduced=${audioProduced} samples (${(audioProduced/8000*1000).toFixed(0)}ms), accumTotal=${this.audioAccumLen}`);

		this.onStatus({ ...this.status });
	}

	// ── Mode-specific frame processing ─────────────────────────────

	private processDMRFrame(syncType: SyncType, startPos: number): void {
		const isVoice = isVoiceSync(syncType);

		// Update slot info based on sync type
		if (syncType === SyncType.DMR_BS_VOICE || syncType === SyncType.DMR_MS_VOICE ||
			syncType === SyncType.DMR_DM_TS1_VOICE || syncType === SyncType.DMR_DM_TS2_VOICE) {
			this.status.slot0Burst = 'VOICE';
		} else {
			this.status.slot0Burst = 'DATA';
		}

		if (!isVoice) {
			this.status.mbeDecoding = false;
			return;
		}

		if (!this.mbelibReady) {
			this.status.mbeDecoding = false;
			this.status.mbeErrors = '(mbelib not loaded)';
			return;
		}

		// ── DMR voice superframe extraction ──────────────────────────
		//
		// DMR is 2-slot TDMA. A voice superframe = 6 bursts on our slot.
		// Only burst 0 has the full sync word; bursts 1-5 use EMB.
		// We must read all 6 bursts at known positions.
		//
		// Each burst: [12 CACH][54 voice 1st half][24 SYNC/EMB][54 voice 2nd half] = 144 dibits
		// Between our-slot bursts: 144 dibits of the other slot (skip).
		//
		// startPos = right after the 24-dibit sync word of burst 0.
		//
		// Burst 0:
		//   1st half: startPos - 78 .. startPos - 25  (54 dibits, before sync)
		//   2nd half: startPos + 0  .. startPos + 53  (54 dibits, after sync)
		//   sync/EMB: startPos - 24 .. startPos - 1   (24 dibits, = the detected sync)
		//
		// Burst n (n=1..5):
		//   burstBase = startPos + 54 + 144 + (n-1)*288  = startPos + 198 + (n-1)*288
		//   CACH:      burstBase + 0  .. burstBase + 11   (12 dibits, skip)
		//   1st half:  burstBase + 12 .. burstBase + 65   (54 dibits)
		//   EMB:       burstBase + 66 .. burstBase + 89   (24 dibits, check for mute)
		//   2nd half:  burstBase + 90 .. burstBase + 143  (54 dibits)

		const mask = 0xFFFF;
		this.status.mbeDecoding = true;
		let errBar = '';
		let totalFrames = 0;

		// Helper: extract 108 voice dibits from a burst and decode 3 AMBE frames
		const decodeBurst = (v1Start: number, v2Start: number, burstIdx: number, skipFrames12: boolean) => {
			const voiceBuf = new Uint8Array(108);
			for (let i = 0; i < 54; i++) {
				voiceBuf[i] = this.dibitBuf[(v1Start + i) & mask];
				voiceBuf[54 + i] = this.dibitBuf[(v2Start + i) & mask];
			}

			const ambeFrames = processDMRSingleBurst(voiceBuf, 0, this.status);
			for (let fi = 0; fi < ambeFrames.length; fi++) {
				// SDR++ Brown: skip frames 1+2 of the first burst (firstframe logic)
				// because data before the initial sync detection may be invalid
				if (skipFrames12 && fi < 2) {
					errBar += 's'; // skipped
					continue;
				}
				try {
					const audio = decodeAmbe(ambeFrames[fi]);
					this.appendAudio(audio);
					this.status.voiceFrameCount = (this.status.voiceFrameCount || 0) + 1;
					totalFrames++;
					errBar += '=';
				} catch (e) {
					errBar += 'X';
				}
			}
		};

		// Burst 0: voice data straddles the sync word.
		// SDR++ Brown skips frames 1+2 of the first burst because data
		// received before the first sync may not be valid (firstframe logic).
		// The sync/EMB is at startPos-24, which is the sync we just detected,
		// so we know it's VOICE — no mute check needed for burst 0.
		decodeBurst(startPos - 78, startPos, 0, /* skipFrames12 */ true);

		// Bursts 1-5: at known offsets after burst 0
		for (let n = 1; n <= 5; n++) {
			const burstBase = startPos + 54 + 144 + (n - 1) * 288; // = startPos + 198 + (n-1)*288
			const v1Start = burstBase + 12;  // skip 12 CACH
			const embPos = burstBase + 66;   // EMB/sync position
			const v2Start = burstBase + 90;  // skip 12 CACH + 54 voice1 + 24 EMB

			// SDR++ Brown: check the EMB/sync word for each burst.
			// If it indicates DATA, mute this burst's audio output.
			const isMuted = checkDMRBurstSync(this.dibitBuf, embPos, mask);
			if (isMuted) {
				errBar += 'MMM'; // 3 muted frames
				continue;
			}

			decodeBurst(v1Start, v2Start, n, /* skipFrames12 */ false);
		}

		console.log(`[DSD-dec] DMR superframe: ${totalFrames} AMBE frames decoded (${(totalFrames * 160 / 8000 * 1000).toFixed(0)}ms), errBar=${errBar}`);
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
				if (isVoiceSync(syncType)) {
					// DMR voice superframe = 6 bursts. Only burst 0 has the full sync word.
					// Bursts 1-5 use EMB instead — we must read them at known positions.
					// Layout after sync detection point (= right after sync word):
					//   Burst 0 2nd half: 54 dibits
					//   Then 5 × (144 other-slot + 144 our-slot) = 1440 dibits
					// Total: 54 + 1440 = 1494 dibits
					return 1494;
				}
				// DATA burst: just need the 2nd half after sync
				return 54;
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
		this.lockedMode = 'unknown';
		this.modeLockCount = 0;
		this._lastSyncTime = 0;
		if (this.mbelibReady) resetMbe();
		this.onStatus(this.status);
	}
}
