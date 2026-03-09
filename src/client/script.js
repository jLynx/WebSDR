import { createApp } from "./lib/vue.esm-browser.js";
import * as Comlink from "./lib/comlink.mjs";
import { HackRF } from "./hackrf.js";
import { Waterfall, WaterfallGL } from "./utils.js";
import { WebRTCHandler } from "./webrtc.js";

const Backend = Comlink.wrap(new Worker("./worker.js", { type: "module" }));

// Color palette for N VFOs
const VFO_COLORS = [
	'#ff4444', '#4488ff', '#44cc44', '#ff44ff',
	'#ffaa44', '#44cccc', '#cccc44', '#ff8844',
];

const makeDefaultVfo = (freq = 100.0) => ({
	enabled: false,
	freq: freq,
	mode: 'wfm',
	bandwidth: 150000,
	snapInterval: 100000,
	deEmphasis: '50us',
	squelchEnabled: false,
	squelchLevel: -100.0,
	noiseReduction: false,
	stereo: false,
	lowPass: true,
	highPass: false,
	rds: false,
	rdsRegion: 'eu',
	volume: 50,
	pocsag: false,
	displayFreq: freq.toFixed(6).padStart(10, '0'),
	focused: false,
});

// Bookmark categories
const BOOKMARK_CATEGORIES = [
	{ value: '', label: 'Uncategorised' },
	{ value: 'marine', label: 'Marine' },
	{ value: 'aviation', label: 'Aviation' },
	{ value: 'fire', label: 'Fire' },
	{ value: 'ambulance', label: 'Ambulance / EMS' },
	{ value: 'police', label: 'Police' },
	{ value: 'emergency', label: 'Emergency Services (Mixed)' }, // Added for mixed emergency groups
	{ value: 'pocsag', label: 'POCSAG' },
	{ value: 'amateur', label: 'Amateur Radio' },
	{ value: 'weather', label: 'Weather' },
	{ value: 'military', label: 'Military' },
	{ value: 'radio', label: 'Broadcast Radio' }, // Clarified label
	{ value: 'utility', label: 'Utility' },
	{ value: 'mixed', label: 'Mixed / Multiple' }, // Added for groups spanning unrelated categories
	{ value: 'other', label: 'Other' },
];

// SDR++ mode defaults
const MODE_DEFAULTS = {
	wfm: { bandwidth: 150000, snapInterval: 100000, deEmphasis: '50us', lowPass: true },
	nfm: { bandwidth: 12500, snapInterval: 2500, deEmphasis: 'none', lowPass: true },
	am: { bandwidth: 10000, snapInterval: 1000, deEmphasis: 'none', lowPass: false },
	usb: { bandwidth: 2800, snapInterval: 100, deEmphasis: 'none', lowPass: false },
	lsb: { bandwidth: 2800, snapInterval: 100, deEmphasis: 'none', lowPass: false },
	dsb: { bandwidth: 4600, snapInterval: 100, deEmphasis: 'none', lowPass: false },
	cw: { bandwidth: 200, snapInterval: 10, deEmphasis: 'none', lowPass: false },
	raw: { bandwidth: 48000, snapInterval: 2500, deEmphasis: 'none', lowPass: false },
};

createApp({
	data() {
		return {
			backend: null,
			connected: false,
			running: false,
			remoteMode: 'none', // 'none' | 'host' | 'client'
			remoteStatus: '',
			remoteLink: '',
			remotePeerId: '',
			snackbar: { show: false, message: "" },
			radio: {
				centerFreq: 100.0,
				sampleRate: 8000000,
				fftSize: 65536,
			},
			display: {
				minDB: -70.0,
				maxDB: 0.0,
			},
			gains: {
				lna: 16,
				vga: 16,
				ampEnabled: false,
			},
			locks: {
				centerFreq: false,
				lna: false,
				vga: false,
				amp: false,
			},
			vfos: [makeDefaultVfo(100.0)],
			activeVfoIndex: 0,
			info: { boardName: "" },
			hoverFreqText: "",
			dspStats: null,
			showStats: false,
			fps: 0,
			vfoSquelchOpen: [],  // per-VFO squelch activity indicator
			vfoSquelchHangUntil: [], // per-VFO timestamp until which we hang the UI open
			vfoActivityStats: [],    // per-VFO { count, totalMs, squelchOpenSince } — frequency activity tracker
			activityNow: 0,          // reactive tick updated by stats timer to refresh activity panel
			showActivity: false,
			view: {
				zoomScale: 1.0,
				zoomOffset: 0.0,
				locked: false
			},
			whisper: {
				panelOpen: false,
				active: false,
				status: 'idle',        // idle | loading | ready | error
				loadProgress: 0,
				loadPhase: 'downloading', // downloading | initializing
				loadFile: '',          // short name of the file currently downloading
				loadFilesDone: 0,      // how many files have finished downloading
				loadFilesTotal: 0,     // total files seen so far
				model: 'onnx-community/whisper-small',
				chunkSeconds: 10,
				log: [],               // { time, freq, text, duration }
				statusMsg: '',
				recording: false,      // true while accumulating audio
				transcribing: false,   // true while waiting for Whisper result
				recordStart: null,     // Date when current recording started
				recordDuration: 0,     // seconds of current recording buffer
				pendingChunks: 0,      // number of chunks sent but not yet returned
			},
			pocsag: {
				panelOpen: false,
				log: [],   // { time, freq, vfoIndex, capcode, type, text, baud }
			},
			bookmarkCategories: BOOKMARK_CATEGORIES,
			bookmarkCategoryFilter: '',
			bookmarkSearch: '',
			bookmarks: [],
			bookmarkModal: { show: false, type: 'individual', name: '', category: '' },
			bookmarkImportModal: { show: false },
			bookmarkEdit: {
				show: false,
				index: -1,
				type: 'individual',
				name: '',
				category: '',
				// individual fields
				freq: 100.0,
				mode: 'nfm',
				bandwidth: 12500,
				snapInterval: 2500,
				deEmphasis: 'none',
				squelchEnabled: false,
				squelchLevel: -100,
				noiseReduction: false,
				stereo: false,
				lowPass: true,
				highPass: false,
				rds: false,
				rdsRegion: 'eu',
				volume: 50,
				// group fields
				centerFreq: 100.0,
				sampleRate: 8000000,
				vfos: [],
				activeVfoIndex: 0,
			},
			collapsedPanels: {},  // keyed by panel id, true = collapsed
		};
	},
	computed: {
		isLocal() {
			const host = window.location.hostname;
			return host === 'localhost' || host === '127.0.0.1';
		},
		activeAudioVfos() {
			const active = [];
			for (let i = 0; i < this.vfos.length; i++) {
				const vfo = this.vfos[i];
				if (vfo.enabled) {
					if (!vfo.squelchEnabled || this.vfoSquelchOpen[i]) {
						active.push({ index: i, vfo });
					}
				}
			}
			return active;
		},
		// VFOs with squelch enabled, sorted by total squelch-open time (most active first)
		sortedVfoActivity() {
			const now = this.activityNow || Date.now();
			const items = this.vfos.map((vfo, i) => {
				if (!vfo.squelchEnabled) return null;
				const stat = this.vfoActivityStats[i] || { count: 0, totalMs: 0, squelchOpenSince: null };
				const liveMs = stat.squelchOpenSince ? (now - stat.squelchOpenSince) : 0;
				const totalMs = stat.totalMs + liveMs;
				return { index: i, vfo, count: stat.count, totalMs, isLive: !!stat.squelchOpenSince };
			}).filter(Boolean);
			items.sort((a, b) => b.totalMs - a.totalMs);
			// Compute pct relative to top entry
			const maxMs = items[0]?.totalMs || 1;
			for (const item of items) item.pct = (item.totalMs / maxMs) * 100;
			return items;
		},
		// Individual bookmarks grouped by category; group bookmarks as a flat sorted list
		bookmarkGroupsByCategory() {
			const search = (this.bookmarkSearch || '').toLowerCase().trim();
			const all = this.bookmarks.map((bm, i) => ({ bm, i }));
			const filtered = search
				? all.filter(({ bm }) =>
					(bm.name || '').toLowerCase().includes(search) ||
					String(bm.freq || bm.centerFreq || '').includes(search)
				)
				: all;
			// Flat group list (sorted by centerFreq)
			const flatGroups = filtered
				.filter(({ bm }) => (bm.type || 'group') === 'group')
				.sort((a, b) => (a.bm.centerFreq || 0) - (b.bm.centerFreq || 0));
			// Individual bookmarks bucketed by category
			const cats = {};
			for (const entry of filtered) {
				if ((entry.bm.type || 'group') !== 'individual') continue;
				const cat = entry.bm.category || '';
				if (!cats[cat]) cats[cat] = [];
				cats[cat].push(entry);
			}
			for (const arr of Object.values(cats)) {
				arr.sort((a, b) => (a.bm.freq || 0) - (b.bm.freq || 0));
			}
			const categories = Object.keys(cats)
				.map(key => ({
					key,
					collKey: 'bm:' + (key || '__uncategorised__'),
					label: BOOKMARK_CATEGORIES.find(c => c.value === key)?.label || 'Uncategorised',
					items: cats[key],
				}))
				.sort((a, b) => {
					if (a.key === '' && b.key !== '') return 1;
					if (a.key !== '' && b.key === '') return -1;
					return a.label.localeCompare(b.label);
				});
			return { categories, flatGroups };
		},
		// Calculate the min/max display bandwidth based on sampleRate AND zoom state
		minFreq() {
			const baseMin = this.radio.centerFreq - (this.radio.sampleRate / 2) / 1e6;
			const baseSpan = this.radio.sampleRate / 1e6;
			return baseMin + (baseSpan * this.view.zoomOffset);
		},
		maxFreq() {
			const baseMin = this.radio.centerFreq - (this.radio.sampleRate / 2) / 1e6;
			const baseSpan = this.radio.sampleRate / 1e6;
			return baseMin + (baseSpan * (this.view.zoomOffset + (1.0 / this.view.zoomScale)));
		}
	},
	methods: {
		togglePanel(key) {
			this.collapsedPanels[key] = !this.collapsedPanels[key];
		},
		toggleBookmarkCategory(collKey) {
			this.collapsedPanels[collKey] = !this.collapsedPanels[collKey];
		},
		formatFreq(mhz) {
			if (!mhz) return "000.000000";
			let s = mhz.toFixed(6);
			return s.padStart(10, '0');
		},
		// Format a duration in milliseconds as a human-readable string (e.g. "2m 05s")
		formatActivityDuration(ms) {
			if (ms < 1000) return ms > 0 ? '<1s' : '0s';
			const totalSec = Math.floor(ms / 1000);
			const h = Math.floor(totalSec / 3600);
			const m = Math.floor((totalSec % 3600) / 60);
			const s = totalSec % 60;
			if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
			if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
			return `${s}s`;
		},
		// Wipe all accumulated activity statistics
		resetActivityStats() {
			this.vfoActivityStats = [];
			this.activityNow = Date.now();
		},
		vfoColor(index) {
			return VFO_COLORS[index % VFO_COLORS.length];
		},
		vfoTint(index) {
			const hex = VFO_COLORS[index % VFO_COLORS.length];
			// Parse hex to rgba with 0.25 alpha
			const r = parseInt(hex.slice(1, 3), 16);
			const g = parseInt(hex.slice(3, 5), 16);
			const b = parseInt(hex.slice(5, 7), 16);
			return `rgba(${r}, ${g}, ${b}, 0.25)`;
		},
		// Returns the bookmark name if the VFO's frequency matches any saved individual bookmark.
		vfoBookmarkLabel(i) {
			const vfoFreq = this.vfos[i]?.freq;
			if (vfoFreq == null) return null;
			const TOL = 0.0001; // ~100 Hz tolerance
			for (const bm of this.bookmarks) {
				if ((bm.type || 'group') === 'individual') {
					if (Math.abs(bm.freq - vfoFreq) < TOL) return bm.name;
				}
			}
			return null;
		},
		focusVfoFreq(index) {
			this.vfos[index].focused = true;
		},
		focusActivityVfo(index) {
			this.activeVfoIndex = index;

			// Scroll the VFO tab into view within the top-bar (overflow-x: auto container)
			this.$nextTick(() => {
				const container = document.querySelector('.vfo-displays');
				const tabs = document.querySelectorAll('.vfo-display');
				if (container && tabs[index]) {
					const tab = tabs[index];
					const containerLeft = container.scrollLeft;
					const containerRight = containerLeft + container.clientWidth;
					const tabLeft = tab.offsetLeft;
					const tabRight = tabLeft + tab.offsetWidth;
					if (tabLeft < containerLeft) {
						container.scrollTo({ left: tabLeft - 8, behavior: 'smooth' });
					} else if (tabRight > containerRight) {
						container.scrollTo({ left: tabRight - container.clientWidth + 8, behavior: 'smooth' });
					}
				}
			});

			// Pan (and optionally zoom) the waterfall to centre on the VFO's frequency
			const vfo = this.vfos[index];
			if (!vfo) return;
			// Normalised position within the full spectrum [0, 1]
			const normalizedPos = (vfo.freq - this.radio.centerFreq) * 1e6 / this.radio.sampleRate + 0.5;
			// Only act if the frequency is within the tuned bandwidth
			if (normalizedPos < 0 || normalizedPos > 1) return;

			// Ensure we are zoomed in enough to clearly see the signal
			const targetZoom = Math.max(this.view.zoomScale, 32.0);
			// Centre the offset on the target frequency
			let newOffset = normalizedPos - (0.5 / targetZoom);
			const maxOffset = 1.0 - (1.0 / targetZoom);
			newOffset = Math.max(0, Math.min(maxOffset, newOffset));

			// Updates trigger the watch('view') to call applyZoomToEngine()
			this.view.zoomScale = targetZoom;
			this.view.zoomOffset = newOffset;
		},
		applyVfoFreq(e, index) {
			const vfo = this.vfos[index];
			vfo.focused = false;
			let val = parseFloat(vfo.displayFreq);
			if (!isNaN(val)) {
				vfo.freq = val;
				vfo.displayFreq = this.formatFreq(val);
				this.updateBackendVfoParams(index);
			} else {
				vfo.displayFreq = this.formatFreq(vfo.freq);
			}
			e.target.blur();
		},
		applyModeDefaults(index) {
			const vfo = this.vfos[index];
			const d = MODE_DEFAULTS[vfo.mode] || MODE_DEFAULTS.nfm;
			if (vfo.mode === 'raw') {
				vfo.bandwidth = this.radio.sampleRate;
			} else {
				vfo.bandwidth = d.bandwidth;
			}
			vfo.snapInterval = d.snapInterval;
			vfo.deEmphasis = d.deEmphasis;
			vfo.squelchEnabled = false;
			vfo.squelchLevel = -100.0;
			vfo.noiseReduction = false;
			vfo.stereo = false;
			vfo.lowPass = d.lowPass;
			vfo.highPass = false;
		},
		labelFreq(percent) {
			const freq = this.minFreq + percent * (this.maxFreq - this.minFreq);
			return freq.toFixed(2);
		},
		showMsg(msg) {
			this.snackbar.message = msg;
			this.snackbar.show = true;
			setTimeout(() => { this.snackbar.show = false; }, 3000);
		},
		async connect() {
			if (!this.backend) return;
			this.showMsg("Connecting...");
			try {
				let ok = await this.backend.open();
				if (!ok) {
					const device = await HackRF.requestDevice();
					if (!device) return;
					ok = await this.backend.open({
						vendorId: device.vendorId,
						productId: device.productId,
						serialNumber: device.serialNumber
					});
				}
				if (ok) {
					this.connected = true;
					const info = await this.backend.info();
					this.info.boardName = HackRF.BOARD_ID_NAME.get(info.boardId);
					this.showMsg("Connected to " + this.info.boardName);
					await this.startStream();
				} else {
					this.showMsg("Failed to open device.");
				}
			} catch (e) {
				this.showMsg("Connect Error: " + e.message);
			}
		},
		async connectMock() {
			if (!this.backend) return;
			this.showMsg("Connecting Mock SDR...");
			try {
				const ok = await this.backend.open("mock");
				if (ok) {
					this.connected = true;
					this.info.boardName = "Mock SDR (Signal Gen)";
					this.showMsg("Connected to Mock SDR");
					await this.startStream();
				} else {
					this.showMsg("Failed to open Mock SDR.");
				}
			} catch (e) {
				this.showMsg("Mock Connect Error: " + e.message);
			}
		},
		async disconnect() {
			if (this.remoteMode === 'client' && this._webrtc) {
				this._webrtc.close();
				this._webrtc = null;
				this.remoteMode = 'none';
				if (this.running) await this.togglePlay();
				this.connected = false;
				this.showMsg("Disconnected from remote device");
				// Clear the URL
				window.history.replaceState({}, document.title, "/");
				return;
			}

			if (this.remoteMode === 'host' && this._webrtc) {
				this._webrtc.close();
				this._webrtc = null;
				this.remoteMode = 'none';
				this.showMsg("Remote sharing stopped");
			}

			if (this.running) await this.togglePlay();
			await this.backend.close();
			this.connected = false;
			this.showMsg("Disconnected");
		},
		async togglePlay() {
			if (this.running) {
				await this.backend.stopRx();
				this.running = false;
				if (this._statsTimer) { clearInterval(this._statsTimer); this._statsTimer = null; }
				this.dspStats = null;
				if (this.audioCtx) {
					try { await this.audioCtx.close(); } catch (_) { }
					this.audioCtx = null;
					this.gainNode = null;
				}
			} else {
				this.startStream();
			}
		},
		async startStream() {
			if (this.running) return;

			this.initCanvas();

			// Set running=true synchronously so drawSpectrum() isn't blocked by the
			// `if (!this.running)` guard while we're awaiting startRxStream(). For
			// remote clients, WebRTC FFT chunks can arrive before that await resolves.
			this.running = true;

			const opts = {
				centerFreq: this.radio.centerFreq,
				sampleRate: this.radio.sampleRate,
				fftSize: this.radio.fftSize,
				lnaGain: this.gains.lna,
				vgaGain: this.gains.vga,
				ampEnabled: this.gains.ampEnabled,
			};

			try {
				await this.backend.startRxStream(opts,
					Comlink.proxy((spectrumData) => this.drawSpectrum(spectrumData)),
					Comlink.proxy((audioSamples) => this.playAudio(audioSamples)),
					Comlink.proxy((vfoIndex, freq, samples) => this._feedWhisperVfo(vfoIndex, freq, samples)),
					Comlink.proxy((vfoIndex, freq, msg) => this._onPocsagMessage(vfoIndex, freq, msg))
				);
			} catch (e) {
				console.error('Error starting RX stream:', e);
				this.showMsg("Error starting stream.");
				this.running = false;
				return;
			}

			this._statsTimer = setInterval(async () => {
				if (this.backend && this.running) {
					this.dspStats = await this.backend.getDspStats();
					if (this.dspStats && this.dspStats.squelchOpen) {
						const now = Date.now();
						const squelchStates = this.dspStats.squelchOpen.slice();
						for (let i = 0; i < squelchStates.length; i++) {
							if (squelchStates[i]) {
								this.vfoSquelchHangUntil[i] = now + 1000;
							} else if (this.vfoSquelchHangUntil[i] && now < this.vfoSquelchHangUntil[i]) {
								squelchStates[i] = true;
							}
						}
						this.vfoSquelchOpen = squelchStates;
						// ── Frequency activity tracker ──
						// Uses raw (pre-hang) states to count true squelch-open events
						const rawOpen = this.dspStats.squelchOpen;
						for (let i = 0; i < rawOpen.length; i++) {
							if (!this.vfoActivityStats[i]) {
								this.vfoActivityStats[i] = { count: 0, totalMs: 0, squelchOpenSince: null };
							}
							const stat = this.vfoActivityStats[i];
							// Only track activity for VFOs that are not muted
							if (rawOpen[i] && this.vfos[i]?.enabled) {
								if (stat.squelchOpenSince === null) {
									// Squelch just opened – start a new event
									stat.squelchOpenSince = now;
									stat.count++;
								}
							} else {
								if (stat.squelchOpenSince !== null) {
									// Squelch just closed – accumulate duration
									stat.totalMs += now - stat.squelchOpenSince;
									stat.squelchOpenSince = null;
								}
							}
						}
						// Bump reactive tick so sortedVfoActivity recomputes
						this.activityNow = now;
					}
				}
			}, 500);

			// Add additional VFOs to the worker (first one is created by default in worker)
			for (let i = 1; i < this.vfos.length; i++) {
				await this.backend.addVfo();
			}

			// Enable first VFO by default when starting stream
			this.vfos[0].enabled = true;
			this.toggleVfoCheckbox(0);

			// Send all VFO params to worker
			for (let i = 0; i < this.vfos.length; i++) {
				this.updateBackendVfoParams(i);
			}
		},
		initCanvas() {
			const { fftSize } = this.radio;
			const { waterfall, fft } = this.$refs;

			const renderSize = Math.min(fftSize, 8192);
			this.renderSize = renderSize;
			const nx = Math.pow(2, Math.ceil(Math.log2(renderSize)));
			const useWebGL = nx <= 16384;

			// Attach non-reactively to prevent Vue DevTools from deep-inspecting rendering engine objects and freezing
			this._waterfallEngine = useWebGL ?
				new WaterfallGL(waterfall, renderSize, 512) :
				new Waterfall(waterfall, renderSize, 512);

			this._waterfallEngine.setRange(this.display.minDB, this.display.maxDB);

			const rect = this.$refs.fftContainer.getBoundingClientRect();
			const dpr = window.devicePixelRatio || 1;
			fft.width = rect.width * dpr; // Draw spectrum based on physical pixels, not full FFT
			fft.height = rect.height * dpr;
			fft.style.width = rect.width + 'px';
			fft.style.height = rect.height + 'px';
			this._fftCtx = fft.getContext('2d');
			this._fftCtx.scale(dpr, dpr);
		},
		drawSpectrum(data) {
			if (!this._fftCtx) return;
			if (!this.running && !this._zoomRepaint) return;

			// Cache latest frame so zoom/pan can repaint immediately without new data
			if (!this._zoomRepaint) this._lastSpectrumData = data;

			// FPS calculation
			const now = performance.now();
			if (!this._lastFrameTime) {
				this._lastFrameTime = now;
				this._framesDrawn = 0;
			} else {
				this._framesDrawn++;
				if (now - this._lastFrameTime >= 1000) {
					this.fps = Math.round((this._framesDrawn * 1000) / (now - this._lastFrameTime));
					this._framesDrawn = 0;
					this._lastFrameTime = now;
				}
			}

			// Downsample for waterfall history
			let wfData = data;
			if (data.length > this.renderSize) {
				wfData = new Float32Array(this.renderSize);
				const factor = data.length / this.renderSize;
				for (let i = 0; i < this.renderSize; i++) {
					let maxVal = -1000;
					const start = Math.floor(i * factor);
					const end = Math.floor((i + 1) * factor);
					for (let j = start; j < end; j++) {
						if (data[j] > maxVal) maxVal = data[j];
					}
					wfData[i] = maxVal;
				}
			}

			// Waterfall drawing — skip adding a new history row when this is just a zoom repaint
			if (!this._zoomRepaint) {
				this._waterfallEngine.renderLine(wfData);
			} else if (this._waterfallEngine.render) {
				// For a zoom-only repaint, just redraw the existing texture at the new zoom
				this._waterfallEngine.render();
			}

			const ctx = this._fftCtx;
			const dpr = window.devicePixelRatio || 1;
			const w = ctx.canvas.width / dpr;
			const h = ctx.canvas.height / dpr;

			ctx.fillStyle = "rgba(0, 0, 0, 1)";
			ctx.fillRect(0, 0, w, h);

			// Grid
			ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
			ctx.lineWidth = 1;
			ctx.beginPath();
			for (let p of [0.25, 0.5, 0.75]) {
				ctx.moveTo(w * p, 0);
				ctx.lineTo(w * p, h);
			}
			ctx.stroke();

			// Spectrum Data
			ctx.save();
			ctx.beginPath();

			const pointsToDraw = Math.floor(data.length / this.view.zoomScale);
			const startIdx = Math.floor(data.length * this.view.zoomOffset);
			const dbRange = this.display.maxDB - this.display.minDB;

			// Decimate points so we don't draw 65k lines
			const drawPoints = Math.min(w, pointsToDraw);
			const factor = pointsToDraw / drawPoints;

			for (let i = 0; i < drawPoints; i++) {
				const start = startIdx + Math.floor(i * factor);
				const end = startIdx + Math.floor((i + 1) * factor);

				let valDB = -1000;
				for (let j = start; j < end; j++) {
					if (j >= data.length) break;
					if (data[j] > valDB) valDB = data[j];
				}

				valDB = Math.max(this.display.minDB, Math.min(this.display.maxDB, valDB));

				// 0 is bottom (minDB), 1 is top (maxDB)
				const n = (valDB - this.display.minDB) / dbRange;
				let y = h - (h * n);

				const x = (i / drawPoints) * w;

				if (i === 0) {
					ctx.moveTo(x, y);
				} else {
					ctx.lineTo(x, y);
				}
			}
			// Draw SDR++ style primary trace (white / light blue depending on theme, using an SDR++-like color)
			ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
			ctx.lineWidth = 1.0;
			ctx.stroke();

			// Fill under spectrum for the shadow trace like SDR++
			ctx.lineTo(w, h);
			ctx.lineTo(0, h);
			ctx.fillStyle = "rgba(255, 255, 255, 0.2)";
			ctx.fill();
			ctx.restore();

			// Draw VFO highlights
			for (let vi = 0; vi < this.vfos.length; vi++) {
				const vfo = this.vfos[vi];
				if (vfo.freq === null) continue;

				const muted = !vfo.enabled;
				const color = VFO_COLORS[vi % VFO_COLORS.length];
				const bandwidthHz = vfo.bandwidth;
				const currentSpanHz = this.radio.sampleRate / this.view.zoomScale;
				const pixelWidth = (bandwidthHz / currentSpanHz) * w;

				const offsetFreq = (vfo.freq - this.radio.centerFreq) * 1e6;
				const basePixel = (offsetFreq / this.radio.sampleRate) * w + (w / 2);
				const zoomedPixelOffset = basePixel - (this.view.zoomOffset * w);
				const centerPixel = zoomedPixelOffset * this.view.zoomScale;

				ctx.save();
				if (muted) ctx.globalAlpha = 0.35;

				// Tint block
				ctx.fillStyle = this.vfoTint(vi);
				ctx.fillRect(centerPixel - pixelWidth / 2, 0, Math.max(pixelWidth, 2), h);

				// Center line — dashed when muted to reinforce the mute state
				ctx.strokeStyle = color;
				ctx.lineWidth = 1;
				if (muted) ctx.setLineDash([4, 3]);
				ctx.beginPath();
				ctx.moveTo(centerPixel, 0);
				ctx.lineTo(centerPixel, h);
				ctx.stroke();
				ctx.setLineDash([]);

				// Label
				ctx.fillStyle = color;
				ctx.font = "10px Inter, sans-serif";
				ctx.fillText(muted ? `VFO ${vi + 1} (mute)` : `VFO ${vi + 1}`, centerPixel + 4, 12 + vi * 12);

				ctx.restore();
			}
		},
		toggleVfoCheckbox(index) {
			const anyEnabled = this.vfos.some(v => v.enabled);
			if (anyEnabled && !this.audioCtx) {
				const AudioContext = window.AudioContext || window.webkitAudioContext;
				this.audioCtx = new AudioContext({ sampleRate: 48000 });
				this.gainNode = this.audioCtx.createGain();
				this.gainNode.gain.value = 1.0; // Volume is handled per-VFO in worker
				this.gainNode.connect(this.audioCtx.destination);
				this.nextPlayTime = 0;
				this.audioRingBuf = new Float32Array(4800);
				this.audioRingPos = 0;
				
				if (this.audioCtx.state === 'suspended') {
					this.audioCtx.resume().catch(e => console.warn("AudioContext resume blocked:", e));
				}
			}
			this.updateBackendVfoParams(index);
		},
		playAudio(samples) {
			if (!this.vfos.some(v => v.enabled) || !this.audioCtx) return;
			if (this.audioCtx.state === 'suspended') return;

			let floats;
			if (samples instanceof Float32Array) floats = samples;
			else {
				const len = samples.length || Object.keys(samples).length;
				floats = new Float32Array(len);
				for (let i = 0; i < len; i++) floats[i] = samples[i];
			}

			if (!floats.length) return;

			// Accumulate into ring buffer, schedule when we have enough
			// This batches tiny chunks (~786 samples) into larger buffers
			// to prevent scheduling gaps on the main thread
			const SCHEDULE_THRESHOLD = 2400; // 50ms at 48kHz — schedule when we have this many
			let srcOffset = 0;
			while (srcOffset < floats.length) {
				const space = this.audioRingBuf.length - this.audioRingPos;
				const toCopy = Math.min(space, floats.length - srcOffset);
				this.audioRingBuf.set(floats.subarray(srcOffset, srcOffset + toCopy), this.audioRingPos);
				this.audioRingPos += toCopy;
				srcOffset += toCopy;

				this.audioRingSize = (this.audioRingPos / SCHEDULE_THRESHOLD).toFixed(2);

				if (this.audioRingPos >= SCHEDULE_THRESHOLD) {
					this._scheduleAudioChunk(this.audioRingBuf.slice(0, this.audioRingPos));
					this.audioRingPos = 0;
				}
			}
		},
		_scheduleAudioChunk(floats) {
			const buffer = this.audioCtx.createBuffer(1, floats.length, 48000);
			buffer.getChannelData(0).set(floats);

			const src = this.audioCtx.createBufferSource();
			src.buffer = buffer;
			src.connect(this.gainNode);

			const now = this.audioCtx.currentTime;
			if (this.nextPlayTime < now) {
				// Fallen behind — reschedule with minimal gap
				this.nextPlayTime = now + 0.01;
			}
			src.start(this.nextPlayTime);
			this.nextPlayTime += buffer.duration;

			this.queuedAudioSched = (this.nextPlayTime - this.audioCtx.currentTime).toFixed(2);
		},
		updateBackendVfoParams(index) {
			if (this.backend && this.running && index >= 0 && index < this.vfos.length) {
				const vfo = this.vfos[index];
				const params = {
					freq: vfo.freq,
					mode: vfo.mode,
					enabled: vfo.enabled,
					bandwidth: vfo.bandwidth,
					deEmphasis: vfo.deEmphasis,
					squelchEnabled: vfo.squelchEnabled,
					squelchLevel: vfo.squelchLevel,
					noiseReduction: vfo.noiseReduction,
					stereo: vfo.stereo,
					lowPass: vfo.lowPass,
					highPass: vfo.highPass,
					rds: vfo.rds,
					rdsRegion: vfo.rdsRegion,
					volume: vfo.volume,
					pocsag: vfo.pocsag,
				};

				if (this.remoteMode === 'client' && this._webrtc) {
					// In client mode the local backend has no real DSP (mock hackrf).
					// Send the VFO params to the host over the cmd channel so the host's
					// dedicated _remoteVfoWorker demodulates the correct frequency and mode.
					this._webrtc.sendCommand({ type: 'vfoUpdate', params });
				} else {
					this.backend.setVfoParams(index, params);
				}
			}
		},
		requestOrApplyChange(target, property, value) {
			if (this.remoteMode === 'client') {
				this._webrtc.sendCommand({ type: 'requestChange', target, property, value });
			} else {
				if (target === 'radio') {
					this.radio[property] = value;
				} else if (target === 'gains') {
					this.gains[property] = value;
				}
			}
		},
		async addVfo() {
			const newVfo = makeDefaultVfo(this.radio.centerFreq);
			this.vfos.push(newVfo);
			if (this.backend && this.running) {
				await this.backend.addVfo();
				this.updateBackendVfoParams(this.vfos.length - 1);
			}
			this.activeVfoIndex = this.vfos.length - 1;

			// Auto lock when 5 or more VFOs are loaded
			if (this.vfos.length >= 5 && !this.view.locked) {
				this.view.locked = true;
				this.showMsg("Display auto-locked (> 5 VFOs)");
			}
		},
		async removeVfo(index) {
			if (this.vfos.length <= 1) return;
			this.vfos.splice(index, 1);
			if (this.backend && this.running) {
				await this.backend.removeVfo(index);
			}
			if (this.activeVfoIndex >= this.vfos.length) {
				this.activeVfoIndex = this.vfos.length - 1;
			}
		},
		saveSetting() {
			const obj = {
				radio: this.radio,
				display: this.display,
				gains: this.gains,
				locks: this.locks,
				vfos: this.vfos,
				view: this.view,
				collapsedPanels: this.collapsedPanels,
			};
			localStorage.setItem("SDRSetting", JSON.stringify(obj));
		},
		loadSetting() {
			try {
				const json = localStorage.getItem('SDRSetting');
				if (json) {
					const setting = JSON.parse(json);
					if (setting.radio) {
						Object.assign(this.radio, setting.radio);
						// Migrate: enforce minimum fftSize (old saves may have used 2048)
						if (!this.radio.fftSize || this.radio.fftSize < 8192) {
							this.radio.fftSize = 65536;
						}
					}
					if (setting.display) Object.assign(this.display, setting.display);
					if (setting.gains) Object.assign(this.gains, setting.gains);
					if (setting.locks) Object.assign(this.locks, setting.locks);
					// Handle new format (vfos array) or legacy format (audio/audio2)
					if (setting.vfos && Array.isArray(setting.vfos)) {
						this.vfos = setting.vfos.map(v => ({ ...makeDefaultVfo(), ...v }));
					} else {
						if (setting.audio) {
							Object.assign(this.vfos[0], setting.audio, { enabled: false, displayFreq: this.formatFreq(setting.audio.freq || 100.0), focused: false });
						}
						if (setting.audio2) {
							const vfo2 = { ...makeDefaultVfo(), ...setting.audio2, enabled: false, displayFreq: this.formatFreq(setting.audio2.freq || 100.0), focused: false };
							this.vfos.push(vfo2);
						}
					}
					if (setting.activeVfoIndex !== undefined) this.activeVfoIndex = setting.activeVfoIndex;
					else if (setting.activeVfo) this.activeVfoIndex = setting.activeVfo - 1;
					if (setting.view) Object.assign(this.view, setting.view);
					if (setting.collapsedPanels && typeof setting.collapsedPanels === 'object') Object.assign(this.collapsedPanels, setting.collapsedPanels);
				}
			} catch (e) { }
		},
		applyZoomToEngine() {
			if (this._waterfallEngine) {
				this._waterfallEngine.setZoom(this.view.zoomOffset, this.view.zoomScale);
				// Force an immediate repaint so the new zoom is visible without waiting for the next data frame
				if (this._lastSpectrumData && this._fftCtx) {
					this._zoomRepaint = true;
					this.drawSpectrum(this._lastSpectrumData);
					this._zoomRepaint = false;
				}
			}
		},
		// ─── Whisper transcription ───────────────────────────
		toggleTranscriptPanel() {
			this.whisper.panelOpen = !this.whisper.panelOpen;
		},
		async toggleWhisper() {
			if (this.whisper.active) {
				this.stopWhisper();
			} else {
				await this.startWhisper();
			}
		},
		async startWhisper() {
			if (!this.running) {
				this.showMsg('Start the SDR stream first.');
				return;
			}

			// Create worker if not yet alive
			if (!this._whisperWorker) {
				this._whisperWorker = new Worker('./whisper-worker.js', { type: 'module' });
				this._whisperWorker.addEventListener('message', (e) => this._onWhisperMessage(e));
			}

			// Load model
			this.whisper.status = 'loading';
			this.whisper.loadProgress = 0;
			this.whisper.loadPhase = 'downloading';
			this.whisper.loadFile = '';
			this.whisper.loadFilesDone = 0;
			this.whisper.loadFilesTotal = 0;
			this._whisperWorker.postMessage({ type: 'load', model: this.whisper.model });

			// Per-VFO whisper accumulation buffers (keyed by vfoIndex)
			this._whisperVfoStates = {};
			this._whisperChunkId = 0;
			this._whisperChunkMeta = {}; // id → { startTime, freq }
			this.whisper.active = true;
		},
		stopWhisper() {
			this.whisper.active = false;
			this.whisper.recording = false;
			this.whisper.transcribing = false;
			this.whisper.pendingChunks = 0;
			this.whisper.recordDuration = 0;
			this._whisperVfoStates = {};
		},
		_onWhisperMessage(e) {
			const msg = e.data;
			switch (msg.type) {
				case 'status':
					this.whisper.statusMsg = msg.message;
					break;
				case 'loading':
					this.whisper.loadProgress = msg.progress;
					this.whisper.loadPhase = msg.phase || 'downloading';
					this.whisper.loadFile = msg.file || '';
					this.whisper.loadFilesDone = msg.filesDone ?? this.whisper.loadFilesDone;
					this.whisper.loadFilesTotal = msg.filesTotal ?? this.whisper.loadFilesTotal;
					break;
				case 'ready':
					this.whisper.status = 'ready';
					this.showMsg('Whisper model loaded — transcription active.');
					break;
				case 'result': {
					const text = msg.text;
					// Track pending count
					this.whisper.pendingChunks = Math.max(0, this.whisper.pendingChunks - 1);
					if (this.whisper.pendingChunks === 0) {
						this.whisper.transcribing = false;
					}
					// Use metadata captured when the audio recording started, not at result time
					const meta = (this._whisperChunkMeta || {})[msg.id] || {};
					delete (this._whisperChunkMeta || {})[msg.id];
					const time = meta.startTime
						? meta.startTime.toLocaleTimeString()
						: new Date().toLocaleTimeString();
					const freq = meta.freq || '';
					const vfoIndex = meta.vfoIndex ?? null;
					const duration = msg.audioDuration ? msg.audioDuration.toFixed(1) + 's' : '';
					const transcribeTime = msg.transcribeTime ? msg.transcribeTime + 's' : '';
					this.whisper.log.push({ time, freq, text, duration, transcribeTime, vfoIndex });
					// Auto-scroll
					this.$nextTick(() => {
						const el = this.$refs.transcriptBody;
						if (el) el.scrollTop = el.scrollHeight;
					});
					break;
				}
				case 'error':
					this.whisper.status = 'error';
					this.whisper.statusMsg = msg.message;
					this.showMsg('Whisper: ' + msg.message);
					// An error also consumes a pending slot
					this.whisper.pendingChunks = Math.max(0, this.whisper.pendingChunks - 1);
					if (this.whisper.pendingChunks === 0) this.whisper.transcribing = false;
					break;
				case 'discarded':
					// Worker silently dropped this chunk (hallucination/silence).
					// Still need to decrement so the "Transcribing…" badge clears.
					this.whisper.pendingChunks = Math.max(0, this.whisper.pendingChunks - 1);
					if (this.whisper.pendingChunks === 0) this.whisper.transcribing = false;
					delete (this._whisperChunkMeta || {})[msg.id];
					break;
			}
		},
		/** Feed isolated per-VFO audio (48 kHz) from the worker into the per-VFO Whisper buffer. */
		_feedWhisperVfo(vfoIndex, freqMhz, samples48k) {
			if (!this.whisper.active || this.whisper.status !== 'ready') return;

			// Down-sample 48 kHz → 16 kHz with 3-tap box-filter anti-aliasing.
			// Averaging consecutive triplets acts as a low-pass (~5 kHz cutoff),
			// removing aliasing while preserving voice (300 Hz – 3 kHz).
			const ratio = 3;
			const outLen = Math.floor(samples48k.length / ratio);
			const down = new Float32Array(outLen);
			for (let i = 0; i < outLen; i++) {
				const j = i * ratio;
				down[i] = (samples48k[j] + (samples48k[j + 1] || 0) + (samples48k[j + 2] || 0)) / 3;
			}

			// Lazily init per-VFO state
			if (!this._whisperVfoStates) this._whisperVfoStates = {};
			if (!this._whisperVfoStates[vfoIndex]) {
				this._whisperVfoStates[vfoIndex] = {
					buf: [], bufLen: 0, silenceRun: 0,
					recording: false, recordStart: null, recordStartFreq: '',
				};
			}
			const vs = this._whisperVfoStates[vfoIndex];

			// Check if this VFO has squelch enabled
			const vfo = this.vfos[vfoIndex];
			const squelchMode = vfo && vfo.squelchEnabled;

			// RMS energy check
			let sumSq = 0;
			for (let i = 0; i < down.length; i++) sumSq += down[i] * down[i];
			const rms = Math.sqrt(sumSq / down.length);
			const isSilent = rms < 0.005;

			if (squelchMode) {
				// ── Squelch-aware mode: accumulate entire transmission ──
				if (!isSilent) {
					if (!vs.recording) {
						vs.recording = true;
						vs.recordStart = new Date();
						vs.recordStartFreq = this.formatFreq(freqMhz) + ' MHz';
					}
					vs.buf.push(down);
					vs.bufLen += down.length;
					vs.silenceRun = 0;
					// Safety cap: flush at 120 s
					if (vs.bufLen >= 16000 * 120) this._flushWhisperVfoBuf(vfoIndex);
				} else {
					if (vs.bufLen > 0) {
						vs.silenceRun += down.length;
						if (vs.silenceRun >= 16000 * 0.5) this._flushWhisperVfoBuf(vfoIndex);
					}
				}
			} else {
				// ── Fixed-interval mode ──
				if (isSilent) return;
				if (!vs.recording) {
					vs.recording = true;
					vs.recordStart = new Date();
					vs.recordStartFreq = this.formatFreq(freqMhz) + ' MHz';
				}
				vs.buf.push(down);
				vs.bufLen += down.length;
				if (vs.bufLen >= 16000 * this.whisper.chunkSeconds) this._flushWhisperVfoBuf(vfoIndex);
			}

			// Update aggregate recording UI state (true if any VFO is recording)
			const anyRecording = Object.values(this._whisperVfoStates).some(s => s.recording);
			this.whisper.recording = anyRecording;
			if (anyRecording) {
				const maxDur = Math.max(...Object.values(this._whisperVfoStates).map(s => s.bufLen / 16000));
				this.whisper.recordDuration = maxDur;
			}
		},
		/** Flush one VFO's accumulation buffer to the Whisper worker. */
		_flushWhisperVfoBuf(vfoIndex) {
			const vs = this._whisperVfoStates && this._whisperVfoStates[vfoIndex];
			if (!vs || vs.bufLen === 0) return;

			const audioDuration = vs.bufLen / 16000;
			const full = new Float32Array(vs.bufLen);
			let offset = 0;
			for (const chunk of vs.buf) { full.set(chunk, offset); offset += chunk.length; }

			vs.buf = [];
			vs.bufLen = 0;
			vs.silenceRun = 0;
			vs.recording = false;

			// Update aggregate UI state
			this.whisper.recording = Object.values(this._whisperVfoStates).some(s => s.recording);
			if (!this.whisper.recording) this.whisper.recordDuration = 0;

			// Final RMS guard — discard silence.  Then normalise to ~0.08 RMS so
			// Whisper handles weak HAM signals as confidently as strong ones.
			// Gain is capped at 20× to avoid flooding the model with pure noise.
			let sumSq = 0;
			for (let i = 0; i < full.length; i++) sumSq += full[i] * full[i];
			const rmsOut = Math.sqrt(sumSq / full.length);
			if (rmsOut < 0.003) return;
			if (rmsOut < 0.08) {
				const gain = Math.min(0.08 / rmsOut, 20.0);
				for (let i = 0; i < full.length; i++) full[i] = Math.max(-1, Math.min(1, full[i] * gain));
			}

			this.whisper.transcribing = true;
			this.whisper.pendingChunks++;

			const id = this._whisperChunkId++;
			if (!this._whisperChunkMeta) this._whisperChunkMeta = {};
			this._whisperChunkMeta[id] = {
				startTime: vs.recordStart || new Date(),
				freq: vs.recordStartFreq,
				vfoIndex,
			};
			this._whisperWorker.postMessage(
				{ type: 'transcribe', audio: full, id, audioDuration },
				[full.buffer]
			);
		},
		// ─── Bookmarks ───────────────────────────────────────────────────────────
		categoryLabel(value) {
			const cat = BOOKMARK_CATEGORIES.find(c => c.value === value);
			return cat ? cat.label : value;
		},
		openSaveBookmark(type) {
			const count = this.bookmarks.filter(b => (b.type || 'group') === type).length + 1;
			this.bookmarkModal.type = type;
			this.bookmarkModal.category = '';
			this.bookmarkModal.name = type === 'individual'
				? `Frequency ${count}`
				: `Group ${count}`;
			this.bookmarkModal.show = true;
			this.$nextTick(() => {
				if (this.$refs.bookmarkNameInput) {
					this.$refs.bookmarkNameInput.focus();
					this.$refs.bookmarkNameInput.select();
				}
			});
		},
		confirmBookmark() {
			const { type, name, category } = this.bookmarkModal;
			if (!name.trim()) return;
			let bm;
			if (type === 'individual') {
				const vfo = this.vfos[this.activeVfoIndex] || this.vfos[0];
				bm = {
					id: Date.now() + '-' + Math.random().toString(36).slice(2),
					type: 'individual',
					category: category || '',
					name: name.trim(),
					freq: vfo.freq,
					mode: vfo.mode,
					bandwidth: vfo.bandwidth,
					snapInterval: vfo.snapInterval,
					deEmphasis: vfo.deEmphasis,
					squelchEnabled: vfo.squelchEnabled,
					squelchLevel: vfo.squelchLevel,
					noiseReduction: vfo.noiseReduction,
					stereo: vfo.stereo,
					lowPass: vfo.lowPass,
					highPass: vfo.highPass,
					rds: vfo.rds,
					rdsRegion: vfo.rdsRegion,
					volume: vfo.volume,
				};
			} else {
				bm = {
					id: Date.now() + '-' + Math.random().toString(36).slice(2),
					type: 'group',
					category: category || '',
					name: name.trim(),
					centerFreq: this.radio.centerFreq,
					sampleRate: this.radio.sampleRate,
					vfos: JSON.parse(JSON.stringify(this.vfos)).map(v => ({ ...v, enabled: false, focused: false })),
					activeVfoIndex: this.activeVfoIndex,
				};
			}
			this.bookmarks.push(bm);
			this.bookmarkModal.show = false;
			this.saveBookmarks();
			this.showMsg(`"${bm.name}" saved.`);
		},
		jumpToBookmark(index) {
			const bm = this.bookmarks[index];
			if (!bm) return;
			if ((bm.type || 'group') === 'individual') {
				// If the target frequency is outside the current visible span, re-center
				// to the nearest integer MHz. Otherwise leave the center alone.
				if (bm.freq < this.minFreq || bm.freq > this.maxFreq) {
					this.radio.centerFreq = Math.round(bm.freq);
				}
				// Apply to the active VFO
				const idx = this.activeVfoIndex;
				const vfo = this.vfos[idx];
				Object.assign(vfo, {
					freq: bm.freq,
					mode: bm.mode,
					bandwidth: bm.bandwidth,
					snapInterval: bm.snapInterval,
					deEmphasis: bm.deEmphasis ?? 'none',
					squelchEnabled: bm.squelchEnabled ?? false,
					squelchLevel: bm.squelchLevel ?? -100,
					noiseReduction: bm.noiseReduction ?? false,
					stereo: bm.stereo ?? false,
					lowPass: bm.lowPass ?? true,
					highPass: bm.highPass ?? false,
					rds: bm.rds ?? false,
					rdsRegion: bm.rdsRegion ?? 'eu',
					volume: bm.volume ?? 50,
					displayFreq: this.formatFreq(bm.freq),
					focused: false,
					enabled: true,
				});
				this.showMsg(`Tuned to "${bm.name}" — ${bm.freq} MHz`);
			} else {
				this.radio.centerFreq = bm.centerFreq;
				if (bm.sampleRate) this.radio.sampleRate = bm.sampleRate;
				this.vfos = bm.vfos.map(v => ({
					...makeDefaultVfo(),
					...v,
					enabled: true,
					focused: false,
					displayFreq: this.formatFreq(v.freq || bm.centerFreq),
				}));
				this.activeVfoIndex = Math.min(bm.activeVfoIndex || 0, this.vfos.length - 1);
				this.showMsg(`Loaded "${bm.name}" — ${bm.vfos.length} VFO${bm.vfos.length !== 1 ? 's' : ''} loaded.`);
			}
		},
		openEditBookmark(index) {
			const bm = this.bookmarks[index];
			if (!bm) return;
			const type = bm.type || 'group';
			const e = this.bookmarkEdit;
			e.index = index;
			e.type = type;
			e.name = bm.name;
			e.category = bm.category || '';
			if (type === 'individual') {
				e.freq = bm.freq;
				e.mode = bm.mode;
				e.bandwidth = bm.bandwidth;
				e.snapInterval = bm.snapInterval;
				e.deEmphasis = bm.deEmphasis ?? 'none';
				e.squelchEnabled = bm.squelchEnabled ?? false;
				e.squelchLevel = bm.squelchLevel ?? -100;
				e.noiseReduction = bm.noiseReduction ?? false;
				e.stereo = bm.stereo ?? false;
				e.lowPass = bm.lowPass ?? true;
				e.highPass = bm.highPass ?? false;
				e.rds = bm.rds ?? false;
				e.rdsRegion = bm.rdsRegion ?? 'eu';
				e.volume = bm.volume ?? 50;
			} else {
				e.centerFreq = bm.centerFreq;
				e.sampleRate = bm.sampleRate || 8000000;
				e.vfos = JSON.parse(JSON.stringify(bm.vfos || []));
				e.activeVfoIndex = bm.activeVfoIndex || 0;
			}
			e.show = true;
		},
		confirmEditBookmark() {
			const e = this.bookmarkEdit;
			if (!e.name.trim()) return;
			const bm = { ...this.bookmarks[e.index] };
			bm.name = e.name.trim();
			bm.category = e.category || '';
			if (e.type === 'individual') {
				bm.freq = parseFloat(e.freq) || bm.freq;
				bm.mode = e.mode;
				bm.bandwidth = e.bandwidth;
				bm.snapInterval = e.snapInterval;
				bm.deEmphasis = e.deEmphasis;
				bm.squelchEnabled = e.squelchEnabled;
				bm.squelchLevel = e.squelchLevel;
				bm.noiseReduction = e.noiseReduction;
				bm.stereo = e.stereo;
				bm.lowPass = e.lowPass;
				bm.highPass = e.highPass;
				bm.rds = e.rds;
				bm.rdsRegion = e.rdsRegion;
				bm.volume = e.volume;
			} else {
				bm.centerFreq = parseFloat(e.centerFreq) || bm.centerFreq;
				bm.sampleRate = e.sampleRate;
				bm.vfos = e.vfos.map(v => ({ ...v, enabled: false, focused: false }));
				bm.activeVfoIndex = e.activeVfoIndex;
			}
			this.bookmarks.splice(e.index, 1, bm);
			e.show = false;
			this.saveBookmarks();
			this.showMsg(`"${bm.name}" updated.`);
		},
		addVfoToEditGroup() {
			this.bookmarkEdit.vfos.push({
				...makeDefaultVfo(this.bookmarkEdit.centerFreq),
				enabled: false,
				focused: false,
			});
		},
		deleteBookmark(index) {
			const name = this.bookmarks[index]?.name;
			this.bookmarks.splice(index, 1);
			this.saveBookmarks();
			if (name) this.showMsg(`"${name}" deleted.`);
		},
		saveBookmarks() {
			// Sort in-place: individual freq bookmarks (by freq) first, then groups (by centerFreq)
			this.bookmarks.sort((a, b) => {
				const aIsIndividual = (a.type || 'group') === 'individual';
				const bIsIndividual = (b.type || 'group') === 'individual';
				if (aIsIndividual !== bIsIndividual) return aIsIndividual ? -1 : 1;
				const aFreq = aIsIndividual ? a.freq : a.centerFreq;
				const bFreq = bIsIndividual ? b.freq : b.centerFreq;
				return aFreq - bFreq;
			});
			localStorage.setItem('sdr-web-bookmarks', JSON.stringify(this.bookmarks));
		},
		exportBookmarks() {
			const json = JSON.stringify(this.bookmarks, null, 2);
			const blob = new Blob([json], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `sdr-bookmarks-${new Date().toISOString().slice(0, 10)}.json`;
			a.click();
			URL.revokeObjectURL(url);
		},
		importBookmarks(event) {
			const file = event.target.files[0];
			if (!file) return;
			// Stash the file, reset input, then show mode dialog
			this._pendingImportFile = file;
			event.target.value = '';
			this.bookmarkImportModal.show = true;
		},
		confirmImport(mode) {
			this.bookmarkImportModal.show = false;
			const file = this._pendingImportFile;
			if (!file) return;
			this._pendingImportFile = null;
			const reader = new FileReader();
			reader.onload = (e) => {
				try {
					const imported = JSON.parse(e.target.result);
					if (!Array.isArray(imported)) throw new Error('Not an array');
					const cleaned = imported
						.filter(b => b && typeof b === 'object')
						.map(b => ({ type: 'group', ...b }));
					if (mode === 'replace') {
						this.bookmarks = cleaned;
						this.saveBookmarks();
						this.showMsg(`Replaced with ${cleaned.length} bookmark${cleaned.length !== 1 ? 's' : ''}.`);
					} else {
						// Merge: skip duplicates by id
						const existingIds = new Set(this.bookmarks.map(b => b.id));
						const newOnes = cleaned.filter(b => !existingIds.has(b.id));
						this.bookmarks.push(...newOnes);
						this.saveBookmarks();
						this.showMsg(`Imported ${newOnes.length} bookmark${newOnes.length !== 1 ? 's' : ''}.`);
					}
				} catch (err) {
					this.showMsg('Import failed: invalid JSON file.');
				}
			};
			reader.readAsText(file);
		},
		loadBookmarks() {
			try {
				const json = localStorage.getItem('sdr-web-bookmarks');
				if (json) {
					const bms = JSON.parse(json);
					// Migrate old bookmarks without a type field
					if (Array.isArray(bms)) this.bookmarks = bms.map(b => ({ type: 'group', ...b }));
				}
			} catch (e) { }
		},
		// ─────────────────────────────────────────────────────────────────────────
		clearTranscript() {
			this.whisper.log = [];
		},
		exportTranscript() {
			const lines = this.whisper.log.map(e => `[${e.time}] ${e.freq}  ${e.text}`);
			const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `transcript-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
			a.click();
			URL.revokeObjectURL(url);
		},
		// ─── POCSAG ──────────────────────────────────────────────────────────────
		togglePocsagPanel() {
			this.pocsag.panelOpen = !this.pocsag.panelOpen;
		},
		_onPocsagMessage(vfoIndex, freqMhz, msg) {
			const time = new Date().toLocaleTimeString();
			const freq = freqMhz ? this.formatFreq(freqMhz) + ' MHz' : '';
			this.pocsag.log.push({
				time,
				freq,
				vfoIndex,
				capcode: msg.capcode,
				type: msg.type,
				text: msg.text,
				baud: msg.baud,
			});
			// Auto-scroll
			this.$nextTick(() => {
				const el = this.$refs.pocsagBody;
				if (el) el.scrollTop = el.scrollHeight;
			});
		},
		clearPocsag() {
			this.pocsag.log = [];
		},
		exportPocsag() {
			const lines = this.pocsag.log.map(e =>
				`[${e.time}] ${e.freq}  CAP:${e.capcode}  TYPE:${e.type}  ${e.text || '(tone)'}`
			);
			const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `pocsag-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
			a.click();
			URL.revokeObjectURL(url);
		},
		handleWheelZoom(e, rect) {
			e.preventDefault();

			const zoomSensitivity = 0.1;
			const zoomDir = e.deltaY < 0 ? 1 : -1;
			const newScale = Math.max(1.0, Math.min(100.0, this.view.zoomScale * (1 + (zoomDir * zoomSensitivity))));

			// Calculate where the mouse is relative to the current view
			const mouseX = e.clientX - rect.left;
			const p = mouseX / rect.width;

			// Calculate the absolute normalized coordinate of the mouse
			const absNormTarget = this.view.zoomOffset + (p / this.view.zoomScale);

			// Calculate new offset to keep the absolute target under the mouse
			let newOffset = absNormTarget - (p / newScale);

			// Clamp offset
			const maxOffset = 1.0 - (1.0 / newScale);
			if (newOffset < 0) newOffset = 0;
			if (newOffset > maxOffset) newOffset = maxOffset;

			this.view.zoomScale = newScale;
			this.view.zoomOffset = newOffset;

			this.applyZoomToEngine();
		},
		async startRemoteHost() {
			console.log("[WebRTC] startRemoteHost clicked");
			if (!this.connected || !this.running) {
				console.log("[WebRTC] Device not connected or running");
				this.showMsg("Start the device first to share it.");
				return;
			}
			console.log("[WebRTC] Setting up Host Mode. Mode =", this.remoteMode);
			this.remoteMode = 'host';
			this.remoteStatus = 'Generating ID...';
			
			console.log("[WebRTC] Instantiating WebRTCHandler");
			this._webrtc = new WebRTCHandler(true); // isHost = true
			
			this._webrtc.onStatusChange = (status) => {
				console.log("[WebRTC] Host status changed:", status);
				if (status.status === 'ready') {
					this.remoteStatus = 'Waiting for connection';
					const origin = window.location.origin;
					this.remoteLink = `${origin}/?connect=${status.id}`;
					console.log("[WebRTC] Link completely generated:", this.remoteLink);
				} else if (status.status === 'connected') {
					this.remoteStatus = 'Client connected';
					this.showMsg("Remote client joined!");
					// Sync current state to client
					this._webrtc.sendCommand({ type: 'sync', radio: this.radio, gains: this.gains, locks: this.locks });
				} else if (status.status === 'disconnected') {
					this.remoteStatus = 'Client disconnected';
					this.showMsg("Remote client left.");
				} else if (status.status === 'error') {
					this.remoteMode = 'none';
					this.showMsg("WebRTC Error: " + status.error);
				}
			};

			this._webrtc.onCommand = (cmd) => this.handleRemoteCommand(cmd);

			console.log("[WebRTC] Calling _webrtc.init()");
			await this._webrtc.init();
			console.log("[WebRTC] _webrtc.init() finished. Resolving remote host callback.");
			// Setup worker to push FFT arrays via Comlink callback
			await this.backend.setRemoteHostFftCallback(Comlink.proxy((chunk) => {
				if (this._webrtc) {
					this._webrtc.sendFftChunk(chunk);
				}
			}));
			// Setup worker to push processed Audio buffer callbacks
			await this.backend.setRemoteHostAudioCallback(Comlink.proxy((chunk) => {
				if (this._webrtc) {
					this._webrtc.sendAudioChunk(chunk);
				}
			}));
		},
		async connectRemoteClient(hostId) {
			this.remoteMode = 'client';
			this.remoteStatus = 'Connecting...';
			this.showMsg("Connecting to remote host...");
			
			this._webrtc = new WebRTCHandler(false, hostId);
			this._webrtc.onStatusChange = (status) => {
				if (status.status === 'connecting') {
					this.remoteStatus = 'Connecting...';
				} else if (status.status === 'connected') {
					this.remoteStatus = 'Connected to Host';
					this.connected = true;
					this.info.boardName = "Remote SDR";
					this.showMsg("Connected! Click anywhere to unmute audio.");
					// Start local processing stream using mock device hooked up to WebRTC
					this.startStream();
				} else if (status.status === 'disconnected') {
					this.remoteStatus = 'Disconnected from Host';
					this.disconnect();
				} else if (status.status === 'error') {
					this.remoteMode = 'none';
					this.showMsg("WebRTC Error: " + status.error);
				}
			};

			this._webrtc.onCommand = (cmd) => this.handleRemoteCommand(cmd);
			this._webrtc.onFftChunk = (chunk) => {
				// Guard on _fftCtx (canvas ready) rather than this.running.
				// this.running is set only after `await backend.startRxStream()` resolves,
				// so frames that arrive in that async gap were silently dropped.
				if (!this._fftCtx) return;
				// chunk arrives as ArrayBuffer (PeerJS serialization:'raw').
				// Guard against Uint8Array in case of fallback path: extract the true
				// underlying bytes via byteOffset + byteLength, not numeric element cast.
				const buf = (chunk instanceof ArrayBuffer)
					? chunk
					: chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
				const fftData = new Float32Array(buf);
				if (fftData.length > 0) this.drawSpectrum(fftData);
			};
			this._webrtc.onAudioChunk = (chunk) => {
				if (this.running && this.backend) {
					// chunk arrives as ArrayBuffer (serialization:'raw').
					// Use .slice() with byteOffset/byteLength to handle typed-array views.
					const buf = (chunk instanceof ArrayBuffer)
						? chunk
						: chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
					this.backend.feedRemoteAudioChunk(Comlink.transfer(buf, [buf]));
				}
			};

			try {
				// initRemoteClient MUST come first — it installs the mock hackrf stub.
				// _webrtc.init() may fire the 'connected' event synchronously, which calls
				// startStream() -> startRxStream() -> hackrf.setSampleRateManual(). If the
				// mock isn't in place yet, hackrf is null and the call throws, leaving
				// this.running = false forever (all FFT frames get dropped).
				await this.backend.initRemoteClient();
				await this._webrtc.init();
			} catch(e) {
				this.showMsg("Failed to initialize remote client.");
			}
		},
		handleRemoteCommand(cmd) {
			if (cmd.type === 'sync') {
				if (cmd.radio) Object.assign(this.radio, cmd.radio);
				if (cmd.gains) Object.assign(this.gains, cmd.gains);
				if (cmd.locks) Object.assign(this.locks, cmd.locks);
			} else if (cmd.type === 'vfoUpdate') {
				if (this.remoteMode === 'host') {
					// Client is telling us what frequency/mode they want. Configure the
					// dedicated remote DSP worker on the host for this client.
					this.backend.setRemoteVfoParams(cmd.params);
				}
			} else if (cmd.type === 'requestChange') {
				if (this.remoteMode === 'host') {
					const { target, property, value } = cmd;
					let allow = true;

					if (target === 'radio' && property === 'centerFreq' && this.locks.centerFreq) allow = false;
					if (target === 'gains') {
						if (property === 'lna' && this.locks.lna) allow = false;
						if (property === 'vga' && this.locks.vga) allow = false;
						if (property === 'ampEnabled' && this.locks.amp) allow = false;
					}

					if (allow) {
						if (target === 'radio') this.radio[property] = value;
						else if (target === 'gains') this.gains[property] = value;
						// Sync back so the client updates their frontend
						this._webrtc.sendCommand({ type: 'sync', radio: this.radio, gains: this.gains });
					} else {
						// Reject the change. Sync back the *current* real state so the client's UI snaps back.
						this._webrtc.sendCommand({ type: 'sync', radio: this.radio, gains: this.gains });
					}
				}
			}
		}
	},
	created: async function () {
		this.loadSetting();
		this.loadBookmarks();
		this.backend = await new Backend();
		await this.backend.init();

		this.$watch('radio', async (newVal, oldVal) => {
			this.saveSetting();
			// Reset zoom on radio change
			this.view.zoomScale = 1.0;
			this.view.zoomOffset = 0.0;
			this.applyZoomToEngine();

			if (this.remoteMode === 'client') {
				// We don't want to restart the stream purely client-side unless the host tells us to via a sync.
				// However, if the client modifies the radio, they are requesting a change. We intercept the UI change.
				// This watch fires *after* the UI modifies `this.radio`. Wait, `this.radio` is already modified here.
				// To intercept correctly, we should have the UI call a method rather than v-model directly,
				// OR we can observe changes, revert them visually if locked, and send the request.
				// For now, since `radio` is modified, we just send a sync request if client.
				this._webrtc.sendCommand({ type: 'requestChange', target: 'radio', property: 'centerFreq', value: this.radio.centerFreq });
				this._webrtc.sendCommand({ type: 'requestChange', target: 'radio', property: 'sampleRate', value: this.radio.sampleRate });
				return;
			}

			if (this.running) {
				await this.togglePlay();
				await this.togglePlay();
			}
		}, { deep: true });

		this.$watch('gains', () => {
			if (this.remoteMode === 'client') {
				this._webrtc.sendCommand({ type: 'requestChange', target: 'gains', property: 'lna', value: this.gains.lna });
				this._webrtc.sendCommand({ type: 'requestChange', target: 'gains', property: 'vga', value: this.gains.vga });
				this._webrtc.sendCommand({ type: 'requestChange', target: 'gains', property: 'ampEnabled', value: this.gains.ampEnabled });
				return;
			}

			if (this.running && this.connected) {
				// We don't have individual gain methods anymore since they were removed.
				// However, changing startRxStream will re-apply gains. Or we can just restart.
				// Wait actually I never removed them, they are back in worker.js! But they aren't exposed in worker.js.
				// It's safest to just restart the stream since we are using DDC anyway, 
				// but actually restarting isn't ideal. Let me just leave this.
				// Actually they ARE exposed by `Comlink` directly grabbing the methods.
				if (this.backend.setAmpEnable) {
					this.backend.setAmpEnable(this.gains.ampEnabled);
					this.backend.setLnaGain(this.gains.lna);
					this.backend.setVgaGain(this.gains.vga);
				}
			}
			this.saveSetting();
		}, { deep: true });

		this.$watch('vfos', () => {
			for (let i = 0; i < this.vfos.length; i++) {
				if (!this.vfos[i].focused) {
					this.vfos[i].displayFreq = this.formatFreq(this.vfos[i].freq);
				}
				this.updateBackendVfoParams(i);
			}
			this.saveSetting();
		}, { deep: true });

		this.$watch('view', () => {
			this.applyZoomToEngine();
			this.saveSetting();
		}, { deep: true });

		this.$watch('collapsedPanels', () => {
			this.saveSetting();
		}, { deep: true });

		this.$watch('locks', () => {
			if (this.remoteMode === 'host' && this._webrtc) {
				this._webrtc.sendCommand({ type: 'sync', locks: this.locks });
			}
			this.saveSetting();
		}, { deep: true });
	},
	mounted() {
		const resumeAudio = () => {
			if (this.audioCtx && this.audioCtx.state === 'suspended') {
				this.audioCtx.resume().catch(() => {});
			}
		};
		document.body.addEventListener('click', resumeAudio, { passive: true });
		document.body.addEventListener('touchstart', resumeAudio, { passive: true });

		// Event listeners for tuning on canvas
		let isDraggingVFO = false;
		let isPanning = false;
		let lastPanX = 0;

		const getFreqFromEvent = (e) => {
			const rect = e.currentTarget.getBoundingClientRect();
			const p = (e.clientX - rect.left) / rect.width;
			return this.minFreq + p * (this.maxFreq - this.minFreq);
		};

		const updateHover = (e) => {
			const hoverFreq = getFreqFromEvent(e);
			this.hoverFreqText = hoverFreq.toFixed(3) + " MHz";

			const rect = e.currentTarget.getBoundingClientRect();
			const p = (e.clientX - rect.left) / rect.width;
			const ht = this.$refs.hoverTick;
			ht.style.display = "block";
			ht.style.left = (p * 100) + "%";
		};

		const handleMouseMove = (e) => {
			if (isDraggingVFO && !this.view.locked) {
				const f = getFreqFromEvent(e);
				const idx = this.activeVfoIndex;
				if (idx >= 0 && idx < this.vfos.length) {
					this.vfos[idx].freq = parseFloat(f.toFixed(3));
					this.updateBackendVfoParams(idx);
				}
			} else if (isPanning) {
				const dx = e.clientX - lastPanX;
				lastPanX = e.clientX;
				const rect = e.currentTarget.getBoundingClientRect();

				// convert pixel delta to normalized view delta
				const pDelta = dx / rect.width;
				// adjust offset
				let newOffset = this.view.zoomOffset - (pDelta / this.view.zoomScale);

				const maxOffset = 1.0 - (1.0 / this.view.zoomScale);
				if (newOffset < 0) newOffset = 0;
				if (newOffset > maxOffset) newOffset = maxOffset;

				this.view.zoomOffset = newOffset;
				this.applyZoomToEngine();
				updateHover(e);
			} else {
				updateHover(e);
			}
		};

		const leaveListener = () => {
			this.$refs.hoverTick.style.display = "none";
			isDraggingVFO = false;
			isPanning = false;
		};

		const handleMouseDown = (e) => {
			if (e.button === 0 && !this.view.locked) {
				// Left click: set active VFO frequency
				isDraggingVFO = true;
				const f = getFreqFromEvent(e);
				const idx = this.activeVfoIndex;
				if (idx >= 0 && idx < this.vfos.length) {
					this.vfos[idx].freq = parseFloat(f.toFixed(3));
					this.updateBackendVfoParams(idx);
				}
			} else if (e.button === 2) {
				// Right click: pan
				isPanning = true;
				lastPanX = e.clientX;
			}
		};

		const handleMouseUp = (e) => {
			isDraggingVFO = false;
			isPanning = false;
		};

		// Prevent context menu on right click for panning
		const handleContextMenu = (e) => e.preventDefault();

		const attachCanvasEvents = (canvas) => {
			canvas.addEventListener('mousemove', handleMouseMove);
			canvas.addEventListener('mouseleave', leaveListener);
			canvas.addEventListener('mousedown', handleMouseDown);
			canvas.addEventListener('mouseup', handleMouseUp);
			canvas.addEventListener('contextmenu', handleContextMenu);
			canvas.addEventListener('wheel', (e) => {
				this.handleWheelZoom(e, e.currentTarget.getBoundingClientRect());
				updateHover(e);
			}, { passive: false });
		};

		attachCanvasEvents(this.$refs.fft);
		attachCanvasEvents(this.$refs.waterfall);

		// Initial application of zoom bounds
		this.applyZoomToEngine();

		// Check for remote connection link in URL
		const urlParams = new URLSearchParams(window.location.search);
		const connectId = urlParams.get('connect');
		if (connectId) {
			// Auto-connect after brief delay to ensure components loaded
			setTimeout(() => {
				this.connectRemoteClient(connectId);
			}, 500);
		}
	}
}).mount('#app');
