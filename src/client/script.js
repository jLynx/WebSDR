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
	wfm:  { bandwidth: 150000, snapInterval: 100000, deEmphasis: '50us', lowPass: true },
	nfm:  { bandwidth: 12500,  snapInterval: 2500,   deEmphasis: 'none', lowPass: true },
	am:   { bandwidth: 10000,  snapInterval: 1000,   deEmphasis: 'none', lowPass: false },
	usb:  { bandwidth: 2800,   snapInterval: 100,    deEmphasis: 'none', lowPass: false },
	lsb:  { bandwidth: 2800,   snapInterval: 100,    deEmphasis: 'none', lowPass: false },
	dsb:  { bandwidth: 4600,   snapInterval: 100,    deEmphasis: 'none', lowPass: false },
	cw:   { bandwidth: 200,    snapInterval: 10,     deEmphasis: 'none', lowPass: false },
	raw:  { bandwidth: 48000,  snapInterval: 2500,   deEmphasis: 'none', lowPass: false },
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
				fftSize: 2048,
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
			view: {
				zoomScale: 1.0,
				zoomOffset: 0.0
			}
		};
	},
	computed: {
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
			console.log('togglePlay clicked, current running state:', this.running);
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
			console.log('startStream called, current running state:', this.running);
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

			console.log('Calling backend.startRxStream with opts:', opts);
			try {
				await this.backend.startRxStream(opts,
					Comlink.proxy((spectrumData) => this.drawSpectrum(spectrumData)),
					Comlink.proxy((audioSamples) => this.playAudio(audioSamples))
				);
				console.log('backend.startRxStream returned successfully.');
			} catch (e) {
				console.error('Error starting RX stream:', e);
				this.showMsg("Error starting stream.");
			}

			this.running = true;

			// Start DSP stats polling
			this._statsTimer = setInterval(async () => {
				if (this.backend && this.running) {
					this.dspStats = await this.backend.getDspStats();
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

			const nx = Math.pow(2, Math.ceil(Math.log2(fftSize)));
			const useWebGL = nx <= 16384;
			this.waterfallEngine = useWebGL ?
				new WaterfallGL(waterfall, fftSize, 512) :
				new Waterfall(waterfall, fftSize, 512);

			this.waterfallEngine.setRange(this.display.minDB, this.display.maxDB);

			const rect = this.$refs.fftContainer.getBoundingClientRect();
			fft.width = fftSize;
			fft.height = rect.height;
			this.fftCtx = fft.getContext('2d');
		},
		drawSpectrum(data) {
			if (!this.running || !this.fftCtx) return;

			// Waterfall drawing
			this.waterfallEngine.renderLine(data);

			const ctx = this.fftCtx;
			const w = ctx.canvas.width;
			const h = ctx.canvas.height;

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

			const pointsToDraw = data.length / this.view.zoomScale;
			const startIdx = Math.floor(data.length * this.view.zoomOffset);
			const dbRange = this.display.maxDB - this.display.minDB;

			for (let i = 0; i < pointsToDraw; i++) {
				const dataIdx = startIdx + i;
				if (dataIdx >= data.length) break;

				// Map current dB into our viewport max/min
				let valDB = data[dataIdx];
				valDB = Math.max(this.display.minDB, Math.min(this.display.maxDB, valDB));

				// 0 is bottom (minDB), 1 is top (maxDB)
				const n = (valDB - this.display.minDB) / dbRange;
				let y = h - (h * n);

				const x = (i / pointsToDraw) * w;

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
			const json = JSON.stringify({ radio: this.radio, gains: this.gains, vfos: this.vfos, activeVfoIndex: this.activeVfoIndex, view: this.view, display: this.display });
			localStorage.setItem('sdr-web-setting', json);
		},
		loadSetting() {
			try {
				const json = localStorage.getItem('sdr-web-setting');
				if (json) {
					const setting = JSON.parse(json);
					if (setting.radio) Object.assign(this.radio, setting.radio);
					if (setting.gains) Object.assign(this.gains, setting.gains);
					// Handle new format (vfos array) or legacy format (audio/audio2)
					if (setting.vfos && Array.isArray(setting.vfos)) {
						this.vfos = setting.vfos.map(v => ({ ...makeDefaultVfo(), ...v, enabled: false }));
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
				}
			} catch (e) { }
		},
		applyZoomToEngine() {
			if (this.waterfallEngine) {
				this.waterfallEngine.setZoom(this.view.zoomOffset, this.view.zoomScale);
			}
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
