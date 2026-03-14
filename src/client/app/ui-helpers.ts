import type { AppInstance } from './types';
import { VFO_COLORS } from './constants';

export const uiHelperMethods = {
	copyRemoteLink(this: AppInstance) {
		navigator.clipboard.writeText(this.remoteLink).then(() => {
			this.copyLinkSuccess = true;
			this.copyLinkTooltip = 'Copied!';
			setTimeout(() => {
				this.copyLinkSuccess = false;
				this.copyLinkTooltip = 'Copy link';
			}, 2000);
		});
	},
	togglePanel(this: AppInstance, key: string) {
		this.collapsedPanels[key] = !this.collapsedPanels[key];
	},
	toggleBookmarkCategory(this: AppInstance, collKey: string) {
		this.collapsedPanels[collKey] = !this.collapsedPanels[collKey];
	},
	formatFreq(this: AppInstance, mhz: number) {
		if (!mhz) return "000.000000";
		let s = mhz.toFixed(6);
		return s.padStart(10, '0');
	},
	// Format a duration in milliseconds as a human-readable string (e.g. "2m 05s")
	formatActivityDuration(this: AppInstance, ms: number) {
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
	resetActivityStats(this: AppInstance) {
		this.vfoActivityStats = [];
		this.activityNow = Date.now();
	},
	vfoColor(this: AppInstance, index: number) {
		return VFO_COLORS[index % VFO_COLORS.length];
	},
	vfoTint(this: AppInstance, index: number) {
		const hex = VFO_COLORS[index % VFO_COLORS.length];
		// Parse hex to rgba with 0.25 alpha
		const r = parseInt(hex.slice(1, 3), 16);
		const g = parseInt(hex.slice(3, 5), 16);
		const b = parseInt(hex.slice(5, 7), 16);
		return `rgba(${r}, ${g}, ${b}, 0.25)`;
	},
	// Returns the bookmark name if the VFO's frequency matches any saved individual bookmark.
	vfoBookmarkLabel(this: AppInstance, i: number) {
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
	focusVfoFreq(this: AppInstance, index: number) {
		this.vfos[index].focused = true;
	},
	focusActivityVfo(this: AppInstance, index: number) {
		this.activeVfoIndex = index;

		// Scroll the VFO tab into view within the top-bar (overflow-x: auto container)
		this.$nextTick(() => {
			const container = document.querySelector('.vfo-displays');
			const tabs = document.querySelectorAll('.vfo-display');
			if (container && tabs[index]) {
				const tab = tabs[index] as HTMLElement;
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
	labelFreq(this: AppInstance, percent: number) {
		const freq = this.minFreq + percent * (this.maxFreq - this.minFreq);
		return freq.toFixed(2);
	},
	showMsg(this: AppInstance, msg: string) {
		this.snackbar.message = msg;
		this.snackbar.show = true;
		setTimeout(() => { this.snackbar.show = false; }, 3000);
	},
	toggleSidebar(this: AppInstance) {
		this.sidebarOpen = !this.sidebarOpen;
	},
	closeSidebar(this: AppInstance) {
		this.sidebarOpen = false;
	},
	unlockAndConnect(this: AppInstance) {
		this.audioUnlockPendingId = null;
		this._initAudioCtx();
	},
	_initAudioCtx(this: AppInstance) {
		if (!this.audioCtx) {
			const AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
			this.audioCtx = new AudioContext({ sampleRate: 48000 });
			this.gainNode = this.audioCtx.createGain();
			this.gainNode.gain.value = 1.0;

			// Route audio through a hidden <audio> element backed by a MediaStream.
			// This makes the OS treat the tab as a real media app so it:
			//   1. Shows media playback controls in the notification shade
			//   2. Keeps the browser process (and WebRTC connection) alive when the screen locks
			// Browsers without MediaStreamDestination fall back to the direct destination.
			if (typeof this.audioCtx.createMediaStreamDestination === 'function') {
				const mediaDest = this.audioCtx.createMediaStreamDestination();
				this.gainNode.connect(mediaDest);
				const audio = document.createElement('audio');
				audio.srcObject = mediaDest.stream;
				audio.style.cssText = 'position:absolute;width:0;height:0;';
				document.body.appendChild(audio);
				audio.play().catch(() => {});
				this._mediaAudioEl = audio;
			} else {
				this.gainNode.connect(this.audioCtx.destination);
			}

			this.nextPlayTime = 0;
			this.audioRingBuf = new Float32Array(4800);
			this.audioRingPos = 0;
		}
		if (this.audioCtx.state === 'suspended') {
			this.audioCtx.resume().catch((e: any) => console.warn('AudioContext resume blocked:', e));
			if (this._mediaAudioEl) this._mediaAudioEl.play().catch(() => {});
		}
	},
};
