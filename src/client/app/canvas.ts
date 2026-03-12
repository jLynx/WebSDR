import type { AppInstance } from './types';
import { VFO_COLORS } from './constants';
import { Waterfall, WaterfallGL } from '../utils';

export const canvasMethods = {
	initCanvas(this: AppInstance) {
		const { fftSize } = this.radio;
		const { waterfall } = this.$refs;

		const renderSize = Math.min(fftSize, 8192);
		this.renderSize = renderSize;
		const nx = Math.pow(2, Math.ceil(Math.log2(renderSize)));
		const useWebGL = nx <= 16384;

		// Attach non-reactively to prevent Vue DevTools from deep-inspecting rendering engine objects and freezing
		this._waterfallEngine = useWebGL ?
			new WaterfallGL(waterfall, renderSize, 512) :
			new Waterfall(waterfall, renderSize, 512);

		this._waterfallEngine.setRange(this.display.minDB, this.display.maxDB);

		this.resizeFftCanvas();

		// Re-apply saved zoom to the newly created engine
		this.applyZoomToEngine();
	},
	resizeFftCanvas(this: AppInstance) {
		const fft = this.$refs.fft;
		const rect = this.$refs.fftContainer.getBoundingClientRect();
		const dpr = window.devicePixelRatio || 1;
		fft.width = rect.width * dpr;
		fft.height = rect.height * dpr;
		// Let CSS width:100%/height:100% handle display sizing
		// so the canvas shrinks with its container
		fft.style.width = '';
		fft.style.height = '';
		this._fftCtx = fft.getContext('2d');
		this._fftCtx.scale(dpr, dpr);

		// Redraw spectrum with last frame data if available
		if (this._lastSpectrumData) {
			this._zoomRepaint = true;
			this.drawSpectrum(this._lastSpectrumData);
			this._zoomRepaint = false;
		}
	},
	drawSpectrum(this: AppInstance, data: Float32Array) {
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

		// Re-sample data to exactly renderSize bins for the waterfall texture.
		// Downsample (max-hold) when input is larger, linear-interpolate when smaller
		// (e.g. compressed remote frames arrive as 2048 bins but renderSize is 8192).
		let wfData = data;
		if (data.length !== this.renderSize) {
			wfData = new Float32Array(this.renderSize);
			const factor = data.length / this.renderSize;
			if (data.length > this.renderSize) {
				// Downsample: max-hold over each output bin's source span
				for (let i = 0; i < this.renderSize; i++) {
					let maxVal = -1000;
					const start = Math.floor(i * factor);
					const end = Math.floor((i + 1) * factor);
					for (let j = start; j < end; j++) {
						if (data[j] > maxVal) maxVal = data[j];
					}
					wfData[i] = maxVal;
				}
			} else {
				// Upsample: linear interpolation so compressed remote frames fill the texture
				for (let i = 0; i < this.renderSize; i++) {
					const srcPos = i * factor;
					const lo = Math.floor(srcPos);
					const hi = Math.min(lo + 1, data.length - 1);
					const t = srcPos - lo;
					wfData[i] = data[lo] * (1 - t) + data[hi] * t;
				}
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
};

export function mountCanvas(this: AppInstance) {
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

	const getFreqFromEvent = (e: MouseEvent) => {
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const p = (e.clientX - rect.left) / rect.width;
		return this.minFreq + p * (this.maxFreq - this.minFreq);
	};

	const updateHover = (e: MouseEvent) => {
		const hoverFreq = getFreqFromEvent(e);
		this.hoverFreqText = hoverFreq.toFixed(3) + " MHz";

		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const p = (e.clientX - rect.left) / rect.width;
		const ht = this.$refs.hoverTick;
		ht.style.display = "block";
		ht.style.left = (p * 100) + "%";
	};

	const handleMouseMove = (e: MouseEvent) => {
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
			const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();

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

	const handleMouseDown = (e: MouseEvent) => {
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

	const handleMouseUp = (e: MouseEvent) => {
		isDraggingVFO = false;
		isPanning = false;
	};

	// Prevent context menu on right click for panning
	const handleContextMenu = (e: Event) => e.preventDefault();

	// Touch handling for mobile (pinch-to-zoom, single-finger pan, tap-to-tune)
	let touchStartDist = 0;
	let touchStartScale = 1;
	let touchStartOffset = 0;
	let touchStartCenter = 0;
	let touchIsPanning = false;
	let touchLastX = 0;
	let touchStartX = 0;
	let touchStartY = 0;
	let touchStartTime = 0;
	const TAP_THRESHOLD = 10; // pixels
	const TAP_TIME = 300; // ms

	const getTouchDist = (t1: Touch, t2: Touch) =>
		Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);

	const handleTouchStart = (e: TouchEvent) => {
		if (e.touches.length === 2) {
			// Pinch start
			e.preventDefault();
			touchIsPanning = false;
			touchStartDist = getTouchDist(e.touches[0], e.touches[1]);
			touchStartScale = this.view.zoomScale;
			touchStartOffset = this.view.zoomOffset;
			const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
			touchStartCenter = ((e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left) / rect.width;
		} else if (e.touches.length === 1) {
			// Single finger — could be pan or tap
			touchIsPanning = false;
			touchLastX = e.touches[0].clientX;
			touchStartX = e.touches[0].clientX;
			touchStartY = e.touches[0].clientY;
			touchStartTime = Date.now();
		}
	};

	const handleTouchMove = (e: TouchEvent) => {
		if (e.touches.length === 2) {
			// Pinch-to-zoom
			e.preventDefault();
			const dist = getTouchDist(e.touches[0], e.touches[1]);
			const scaleFactor = dist / touchStartDist;
			const newScale = Math.max(1.0, Math.min(100.0, touchStartScale * scaleFactor));

			// Keep the pinch center point fixed
			const absTarget = touchStartOffset + (touchStartCenter / touchStartScale);
			let newOffset = absTarget - (touchStartCenter / newScale);
			const maxOffset = 1.0 - (1.0 / newScale);
			newOffset = Math.max(0, Math.min(maxOffset, newOffset));

			this.view.zoomScale = newScale;
			this.view.zoomOffset = newOffset;
			this.applyZoomToEngine();
		} else if (e.touches.length === 1) {
			// Single finger pan (only when zoomed in)
			const dx = e.touches[0].clientX - touchStartX;
			const dy = e.touches[0].clientY - touchStartY;

			// If we haven't started panning yet, check if we've moved enough
			if (!touchIsPanning) {
				if (Math.abs(dx) > TAP_THRESHOLD || Math.abs(dy) > TAP_THRESHOLD) {
					touchIsPanning = true;
				} else {
					return;
				}
			}

			if (this.view.zoomScale > 1.0) {
				e.preventDefault();
				const pixDx = e.touches[0].clientX - touchLastX;
				touchLastX = e.touches[0].clientX;
				const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
				const pDelta = pixDx / rect.width;
				let newOffset = this.view.zoomOffset - (pDelta / this.view.zoomScale);
				const maxOffset = 1.0 - (1.0 / this.view.zoomScale);
				newOffset = Math.max(0, Math.min(maxOffset, newOffset));
				this.view.zoomOffset = newOffset;
				this.applyZoomToEngine();
			}
		}
	};

	const handleTouchEnd = (e: TouchEvent) => {
		if (e.touches.length === 0 && !touchIsPanning && !this.view.locked) {
			// Tap-to-tune: only if it was a quick, short-distance touch
			const elapsed = Date.now() - touchStartTime;
			if (elapsed < TAP_TIME) {
				const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
				const p = (touchStartX - rect.left) / rect.width;
				const f = this.minFreq + p * (this.maxFreq - this.minFreq);
				const idx = this.activeVfoIndex;
				if (idx >= 0 && idx < this.vfos.length) {
					this.vfos[idx].freq = parseFloat(f.toFixed(3));
					this.updateBackendVfoParams(idx);
				}
			}
		}
		touchIsPanning = false;
	};

	const attachCanvasEvents = (canvas: HTMLElement) => {
		canvas.addEventListener('mousemove', handleMouseMove as EventListener);
		canvas.addEventListener('mouseleave', leaveListener);
		canvas.addEventListener('mousedown', handleMouseDown as EventListener);
		canvas.addEventListener('mouseup', handleMouseUp as EventListener);
		canvas.addEventListener('contextmenu', handleContextMenu);
		canvas.addEventListener('wheel', (e: Event) => {
			const we = e as WheelEvent;
			this.handleWheelZoom(we, (we.currentTarget as HTMLElement).getBoundingClientRect());
			updateHover(we);
		}, { passive: false });

		// Touch events for mobile
		canvas.addEventListener('touchstart', handleTouchStart as EventListener, { passive: false });
		canvas.addEventListener('touchmove', handleTouchMove as EventListener, { passive: false });
		canvas.addEventListener('touchend', handleTouchEnd as EventListener);
	};

	attachCanvasEvents(this.$refs.fft);
	attachCanvasEvents(this.$refs.waterfall);

	// Resize FFT canvas when browser window is resized
	let resizeTimer: ReturnType<typeof setTimeout>;
	window.addEventListener('resize', () => {
		clearTimeout(resizeTimer);
		resizeTimer = setTimeout(() => {
			if (this._fftCtx) this.resizeFftCanvas();
		}, 150);
	});

	// Initial application of zoom bounds
	this.applyZoomToEngine();

	// Check for remote connection link in URL
	const urlParams = new URLSearchParams(window.location.search);
	const connectId = urlParams.get('connect');
	if (connectId) {
		// Start connecting immediately in the background.
		setTimeout(() => this.connectRemoteClient(connectId), 500);
		// Show overlay so the user provides a click gesture to unlock AudioContext.
		this.audioUnlockPendingId = connectId;
	}
}
