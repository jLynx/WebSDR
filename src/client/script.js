import { createApp } from "./lib/vue.esm-browser.js";
import * as Comlink from "./lib/comlink.mjs";
import { HackRF } from "./hackrf.js";
import { Waterfall, WaterfallGL } from "./utils.js";

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
	displayFreq: freq.toFixed(6).padStart(10, '0'),
	focused: false,
});

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
			vfos: [makeDefaultVfo(100.0)],
			activeVfoIndex: 0,
			info: { boardName: "" },
			hoverFreqText: "",
			dspStats: null,
			showStats: false,
			vfoSquelchOpen: [],  // per-VFO squelch activity indicator
			view: {
				zoomScale: 1.0,
				zoomOffset: 0.0
			},
			whisper: {
				panelOpen: false,
				active: false,
				status: 'idle',        // idle | loading | ready | error
				loadProgress: 0,
				model: 'onnx-community/whisper-tiny.en',
				chunkSeconds: 5,
				log: [],               // { time, freq, text, duration }
				statusMsg: '',
				recording: false,      // true while accumulating audio
				transcribing: false,   // true while waiting for Whisper result
				recordStart: null,     // Date when current recording started
				recordDuration: 0,     // seconds of current recording buffer
				pendingChunks: 0,      // number of chunks sent but not yet returned
			},
			bookmarks: [],         // [{ id, type, name, ...type-specific fields }]
			bookmarkModal: { show: false, type: 'individual', name: '' },
			bookmarkEdit: {
				show: false,
				index: -1,
				type: 'individual',
				name: '',
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
		// Bookmarks split into individual/group sections, each sorted by frequency
		bookmarkGroups() {
			const individual = this.bookmarks
				.map((bm, i) => ({ bm, i }))
				.filter(({ bm }) => (bm.type || 'group') === 'individual')
				.sort((a, b) => a.bm.freq - b.bm.freq);
			const group = this.bookmarks
				.map((bm, i) => ({ bm, i }))
				.filter(({ bm }) => (bm.type || 'group') === 'group')
				.sort((a, b) => a.bm.centerFreq - b.bm.centerFreq);
			return { individual, group };
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
		formatFreq(mhz) {
			if (!mhz) return "000.000000";
			let s = mhz.toFixed(6);
			return s.padStart(10, '0');
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
		// Returns the bookmark name if the VFO's frequency matches any saved bookmark.
		vfoBookmarkLabel(i) {
			const vfoFreq = this.vfos[i]?.freq;
			if (vfoFreq == null) return null;
			const TOL = 0.0001; // ~100 Hz tolerance
			for (const bm of this.bookmarks) {
				if ((bm.type || 'group') === 'individual') {
					if (Math.abs(bm.freq - vfoFreq) < TOL) return bm.name;
				} else {
					// Group bookmark: check if any of its VFOs match
					if (bm.vfos && bm.vfos.some(v => Math.abs((v.freq ?? 0) - vfoFreq) < TOL))
						return bm.name;
				}
			}
			return null;
		},
		focusVfoFreq(index) {
			this.vfos[index].focused = true;
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
		async disconnect() {
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
					Comlink.proxy((audioSamples) => this.playAudio(audioSamples))
				);
			} catch (e) {
				console.error('Error starting RX stream:', e);
				this.showMsg("Error starting stream.");
			}

			this.running = true;

			// Start DSP stats polling
			this._statsTimer = setInterval(async () => {
				if (this.backend && this.running) {
					this.dspStats = await this.backend.getDspStats();
					if (this.dspStats && this.dspStats.squelchOpen) {
						this.vfoSquelchOpen = this.dspStats.squelchOpen.slice();
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
			this.waterfallEngine = useWebGL ?
				new WaterfallGL(waterfall, renderSize, 512) :
				new Waterfall(waterfall, renderSize, 512);

			this.waterfallEngine.setRange(this.display.minDB, this.display.maxDB);

			const rect = this.$refs.fftContainer.getBoundingClientRect();
			const dpr = window.devicePixelRatio || 1;
			fft.width = rect.width * dpr; // Draw spectrum based on physical pixels, not full FFT
			fft.height = rect.height * dpr;
			fft.style.width = rect.width + 'px';
			fft.style.height = rect.height + 'px';
			this.fftCtx = fft.getContext('2d');
			this.fftCtx.scale(dpr, dpr);
		},
		drawSpectrum(data) {
			if (!this.running || !this.fftCtx) return;

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

			// Waterfall drawing
			this.waterfallEngine.renderLine(wfData);

			const ctx = this.fftCtx;
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
				if (vfo.freq === null || !vfo.enabled) continue;

				const color = VFO_COLORS[vi % VFO_COLORS.length];
				const bandwidthHz = vfo.bandwidth;
				const currentSpanHz = this.radio.sampleRate / this.view.zoomScale;
				const pixelWidth = (bandwidthHz / currentSpanHz) * w;

				const offsetFreq = (vfo.freq - this.radio.centerFreq) * 1e6;
				const basePixel = (offsetFreq / this.radio.sampleRate) * w + (w / 2);
				const zoomedPixelOffset = basePixel - (this.view.zoomOffset * w);
				const centerPixel = zoomedPixelOffset * this.view.zoomScale;

				// Tint block
				ctx.fillStyle = this.vfoTint(vi);
				ctx.fillRect(centerPixel - pixelWidth / 2, 0, Math.max(pixelWidth, 2), h);

				// Center line
				ctx.strokeStyle = color;
				ctx.lineWidth = 1;
				ctx.beginPath();
				ctx.moveTo(centerPixel, 0);
				ctx.lineTo(centerPixel, h);
				ctx.stroke();

				// Label
				ctx.fillStyle = color;
				ctx.font = "10px Inter, sans-serif";
				ctx.fillText(`VFO ${vi + 1}`, centerPixel + 4, 12 + vi * 12);
			}
		},
		async toggleVfoCheckbox(index) {
			const anyEnabled = this.vfos.some(v => v.enabled);
			if (anyEnabled && !this.audioCtx) {
				const AudioContext = window.AudioContext || window.webkitAudioContext;
				this.audioCtx = new AudioContext({ sampleRate: 48000 });
				if (this.audioCtx.state === 'suspended') {
					await this.audioCtx.resume();
				}
				this.gainNode = this.audioCtx.createGain();
				this.gainNode.gain.value = 1.0; // Volume is handled per-VFO in worker
				this.gainNode.connect(this.audioCtx.destination);
				this.nextPlayTime = 0;
				this.audioRingBuf = new Float32Array(4800);
				this.audioRingPos = 0;
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

			// Feed audio to Whisper transcription pipeline
			if (this.whisper.active) {
				this._feedWhisper(floats);
			}

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
		},
		updateBackendVfoParams(index) {
			if (this.backend && this.running && index >= 0 && index < this.vfos.length) {
				const vfo = this.vfos[index];
				this.backend.setVfoParams(index, {
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
				});
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
			const json = JSON.stringify({ radio: this.radio, gains: this.gains, vfos: this.vfos, activeVfoIndex: this.activeVfoIndex, view: this.view, display: this.display, collapsedPanels: this.collapsedPanels });
			localStorage.setItem('sdr-web-setting', json);
		},
		loadSetting() {
			try {
				const json = localStorage.getItem('sdr-web-setting');
				if (json) {
					const setting = JSON.parse(json);
					if (setting.radio) {
					Object.assign(this.radio, setting.radio);
					// Migrate: enforce minimum fftSize (old saves may have used 2048)
					if (!this.radio.fftSize || this.radio.fftSize < 8192) {
						this.radio.fftSize = 65536;
					}
				}
					if (setting.gains) Object.assign(this.gains, setting.gains);
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
					if (setting.display) Object.assign(this.display, setting.display);
					if (setting.collapsedPanels && typeof setting.collapsedPanels === 'object') Object.assign(this.collapsedPanels, setting.collapsedPanels);
				}
			} catch (e) { }
		},
		applyZoomToEngine() {
			if (this.waterfallEngine) {
				this.waterfallEngine.setZoom(this.view.zoomOffset, this.view.zoomScale);
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
			this._whisperWorker.postMessage({ type: 'load', model: this.whisper.model });

			// Prepare audio accumulation buffer (16 kHz mono)
			this._whisperBuf = [];
			this._whisperBufLen = 0;
			this._whisperChunkId = 0;
			this._whisperSilenceRun = 0;
			this.whisper.active = true;
		},
		stopWhisper() {
			this.whisper.active = false;
			this.whisper.recording = false;
			this.whisper.transcribing = false;
			this.whisper.pendingChunks = 0;
			this.whisper.recordDuration = 0;
			this._whisperBuf = [];
			this._whisperBufLen = 0;
		},
		_onWhisperMessage(e) {
			const msg = e.data;
			switch (msg.type) {
				case 'status':
					this.whisper.statusMsg = msg.message;
					break;
				case 'loading':
					this.whisper.loadProgress = msg.progress;
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
					// Ignore blank / noise-only results
					if (!text || /^\s*$/.test(text) || /^\(.*\)$/.test(text) || /^\[.*\]$/.test(text)) break;
					const now = new Date();
					const time = now.toLocaleTimeString();
					const vfo = this.vfos[this.activeVfoIndex];
					const freq = vfo ? this.formatFreq(vfo.freq) + ' MHz' : '';
					const duration = msg.audioDuration ? msg.audioDuration.toFixed(1) + 's' : '';
					this.whisper.log.push({ time, freq, text, duration });
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
					break;
			}
		},
		/** Feed demodulated audio (48 kHz) into the Whisper accumulation buffer. */
		_feedWhisper(samples48k) {
			if (!this.whisper.active || this.whisper.status !== 'ready') return;

			// Down-sample 48 kHz → 16 kHz (simple 3:1 decimation)
			const ratio = 3;
			const outLen = Math.floor(samples48k.length / ratio);
			const down = new Float32Array(outLen);
			for (let i = 0; i < outLen; i++) {
				down[i] = samples48k[i * ratio];
			}

			// Check if the active VFO has squelch enabled
			const vfo = this.vfos[this.activeVfoIndex];
			const squelchMode = vfo && vfo.squelchEnabled;

			// Compute RMS of this incoming chunk
			let sumSq = 0;
			for (let i = 0; i < down.length; i++) sumSq += down[i] * down[i];
			const rms = Math.sqrt(sumSq / down.length);
			const isSilent = rms < 0.005;

			if (squelchMode) {
				// ── Squelch-aware mode: accumulate entire transmission ──
				if (!isSilent) {
					// Audio is active — accumulate
					if (!this.whisper.recording) {
						this.whisper.recording = true;
						this.whisper.recordStart = new Date();
					}
					this._whisperBuf.push(down);
					this._whisperBufLen += down.length;
					this._whisperSilenceRun = 0;
					this.whisper.recordDuration = this._whisperBufLen / 16000;

					// Safety cap: if transmission exceeds 120s at 16 kHz, flush now
					const MAX_CAP = 16000 * 120;
					if (this._whisperBufLen >= MAX_CAP) {
						this._flushWhisperBuf();
					}
				} else {
					// Silence detected
					if (this._whisperBufLen > 0) {
						// Count consecutive silent chunks; flush after ~0.5 s of silence
						// (acts as a debounce so brief squelch dips don't split words)
						this._whisperSilenceRun = (this._whisperSilenceRun || 0) + down.length;
						const SILENCE_FLUSH = 16000 * 0.5; // 0.5 s
						if (this._whisperSilenceRun >= SILENCE_FLUSH) {
							this._flushWhisperBuf();
						}
					}
					// else: no buffered audio — nothing to do
				}
			} else {
				// ── Fixed-interval mode (no squelch): use chunkSeconds selector ──
				if (isSilent) return; // still skip pure silence

				if (!this.whisper.recording) {
					this.whisper.recording = true;
					this.whisper.recordStart = new Date();
				}
				this._whisperBuf.push(down);
				this._whisperBufLen += down.length;
				this.whisper.recordDuration = this._whisperBufLen / 16000;

				const TARGET = 16000 * this.whisper.chunkSeconds;
				if (this._whisperBufLen >= TARGET) {
					this._flushWhisperBuf();
				}
			}
		},
		/** Concatenate the accumulation buffer and send it to the Whisper worker. */
		_flushWhisperBuf() {
			if (this._whisperBufLen === 0) return;

			const audioDuration = this._whisperBufLen / 16000;

			const full = new Float32Array(this._whisperBufLen);
			let offset = 0;
			for (const chunk of this._whisperBuf) {
				full.set(chunk, offset);
				offset += chunk.length;
			}
			this._whisperBuf = [];
			this._whisperBufLen = 0;
			this._whisperSilenceRun = 0;

			// Update state: no longer recording, now transcribing
			this.whisper.recording = false;
			this.whisper.recordDuration = 0;

			// Final RMS check on the entire buffer
			let sumSq = 0;
			for (let i = 0; i < full.length; i++) sumSq += full[i] * full[i];
			const rms = Math.sqrt(sumSq / full.length);
			if (rms < 0.003) return; // discard if overall energy is negligible

			this.whisper.transcribing = true;
			this.whisper.pendingChunks++;

			const id = this._whisperChunkId++;
			this._whisperWorker.postMessage(
				{ type: 'transcribe', audio: full, id, audioDuration },
				[full.buffer]   // transfer
			);
		},
		// ─── Bookmarks ───────────────────────────────────────────────────────────
		openSaveBookmark(type) {
			const count = this.bookmarks.filter(b => (b.type || 'group') === type).length + 1;
			this.bookmarkModal.type = type;
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
			const { type, name } = this.bookmarkModal;
			if (!name.trim()) return;
			let bm;
			if (type === 'individual') {
				const vfo = this.vfos[this.activeVfoIndex] || this.vfos[0];
				bm = {
					id: Date.now() + '-' + Math.random().toString(36).slice(2),
					type: 'individual',
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
			const reader = new FileReader();
			reader.onload = (e) => {
				try {
					const imported = JSON.parse(e.target.result);
					if (!Array.isArray(imported)) throw new Error('Not an array');
					// Merge: skip any bookmark whose id already exists
					const existingIds = new Set(this.bookmarks.map(b => b.id));
					const newOnes = imported
						.filter(b => b && typeof b === 'object')
						.map(b => ({ type: 'group', ...b }))
						.filter(b => !existingIds.has(b.id));
					this.bookmarks.push(...newOnes);
					this.saveBookmarks();
					this.showMsg(`Imported ${newOnes.length} bookmark${newOnes.length !== 1 ? 's' : ''}.`);
				} catch (err) {
					this.showMsg('Import failed: invalid JSON file.');
				}
			};
			reader.readAsText(file);
			// Reset so the same file can be re-imported if needed
			event.target.value = '';
		},
		loadBookmarks() {
			try {
				const json = localStorage.getItem('sdr-web-bookmarks');
				if (json) {
					const bms = JSON.parse(json);
					// Migrate old bookmarks without a type field
					if (Array.isArray(bms)) this.bookmarks = bms.map(b => ({ type: 'group', ...b }));
				}
			} catch (e) {}
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
		}
	},
	created: async function () {
		this.loadSetting();
		this.loadBookmarks();
		this.backend = await new Backend();
		await this.backend.init();

		this.$watch('radio', async () => {
			this.saveSetting();
			// Reset zoom on radio change
			this.view.zoomScale = 1.0;
			this.view.zoomOffset = 0.0;
			this.applyZoomToEngine();

			if (this.running) {
				await this.togglePlay();
				await this.togglePlay();
			}
		}, { deep: true });

		this.$watch('gains', () => {
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
	},
	mounted() {
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
			if (isDraggingVFO) {
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
			if (e.button === 0) {
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
	}
}).mount('#app');
