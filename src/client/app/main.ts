import { createApp } from 'vue';
import * as Comlink from 'comlink';
import { createAppData } from './state';
import { computedProperties } from './computed';
import { uiHelperMethods } from './ui-helpers';
import { connectionMethods } from './connection';
import { canvasMethods, mountCanvas } from './canvas';
import { audioMethods } from './audio';
import { vfoMethods } from './vfo';
import { settingsMethods } from './settings';
import { bookmarkMethods } from './bookmarks';
import { whisperMethods } from './whisper';
import { pocsagMethods } from './pocsag';
import { zoomMethods } from './zoom';
import { remoteMethods } from './remote';

const Backend = Comlink.wrap<any>(new Worker(new URL('../worker/main.ts', import.meta.url), { type: 'module' }));

// When a new service worker takes control (after update), reload to get fresh assets
if ('serviceWorker' in navigator) {
	navigator.serviceWorker.addEventListener('controllerchange', () => {
		window.location.reload();
	});
}

createApp({
	data() { return createAppData(); },
	computed: { ...computedProperties },
	methods: {
		...uiHelperMethods,
		...connectionMethods,
		...canvasMethods,
		...audioMethods,
		...vfoMethods,
		...settingsMethods,
		...bookmarkMethods,
		...whisperMethods,
		...pocsagMethods,
		...zoomMethods,
		...remoteMethods,
	},
	created: async function () {
		this.loadSetting();
		this.loadBookmarks();

		// Track online/offline status for PWA — disables internet-dependent features when offline
		window.addEventListener('online', () => { this.isOnline = true; });
		window.addEventListener('offline', () => { this.isOnline = false; });

		// Re-acquire the screen wake lock if the page becomes visible again while running
		// (the OS releases it automatically when the screen turns off)
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'visible' && this.running) {
				this._acquireWakeLock();
			}
		});

		this.backend = await new (Backend as any)();
		await this.backend.init();

		let freqDebounce: ReturnType<typeof setTimeout> | null = null;
		this.$watch(() => this.radio.centerFreq, async (newVal: any, oldVal: any) => {
			this.saveSetting();
			// Reset zoom on radio change
			this.view.zoomScale = 1.0;
			this.view.zoomOffset = 0.0;
			this.applyZoomToEngine();

			if (this.remoteMode === 'client') {
				if (!this._applyingSync) {
					this._webrtc.sendCommand({ type: 'requestChange', target: 'radio', property: 'centerFreq', value: newVal });
				}
				return;
			}

			// Debounce: wait for the input to settle before sending USB commands.
			// Typing "106" fires intermediate values (1, 10, 106) — each triggers a
			// full pauseRx/VCO-cal/resumeRx cycle that can leave the FC0012 PLL in a
			// bad state if changes arrive too fast.
			if (freqDebounce) clearTimeout(freqDebounce);
			freqDebounce = setTimeout(() => {
				freqDebounce = null;

				if (this.running && this.backend) {
					this.backend.setFrequency(newVal * 1e6).catch(console.error);
				}

				if (this.remoteMode === 'host' && this._webrtc) {
					this._webrtc.sendCommand({ type: 'sync', radio: this.radio, gains: this.gains, locks: this.locks });
				}
			}, 200);
		});

		this.$watch(() => [this.radio.sampleRate, this.radio.fftSize], async (newVals: any[], oldVals: any[]) => {
			this.saveSetting();
			this.view.zoomScale = 1.0;
			this.view.zoomOffset = 0.0;
			this.applyZoomToEngine();

			if (this.remoteMode === 'client') {
				if (!this._applyingSync) {
					if (newVals[0] !== oldVals[0]) {
						this._webrtc.sendCommand({ type: 'requestChange', target: 'radio', property: 'sampleRate', value: newVals[0] });
					}
				}
				return;
			}

			if (this.running && (newVals[0] !== oldVals[0] || newVals[1] !== oldVals[1])) {
				await this.togglePlay();
				await this.togglePlay(true);
			}

			if (this.remoteMode === 'host' && this._webrtc) {
				this._webrtc.sendCommand({ type: 'sync', radio: this.radio, gains: this.gains, locks: this.locks });
			}
		}, { deep: true });

		let gainDebounce: ReturnType<typeof setTimeout> | null = null;
		this.$watch('gains', () => {
			// Debounce: wait for slider to settle before sending USB commands.
			// Dragging fires many intermediate values — only the final one matters.
			if (gainDebounce) clearTimeout(gainDebounce);
			gainDebounce = setTimeout(() => {
				gainDebounce = null;

				if (this.remoteMode === 'client') {
					if (!this._applyingSync) {
						for (const [name, value] of Object.entries(this.gains)) {
							this._webrtc.sendCommand({ type: 'requestChange', target: 'gains', property: name, value });
						}
					}
					return;
				}

				if (this.running && this.connected && this.backend) {
					this.backend.setGains({ ...this.gains }).catch(console.error);
				}

				if (this.remoteMode === 'host' && this._webrtc) {
					this._webrtc.sendCommand({ type: 'sync', gains: this.gains, locks: this.locks });
				}

				this.saveSetting();
			}, 100);
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
		mountCanvas.call(this);
	},
}).mount('#app');
