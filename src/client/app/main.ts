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
		this.backend = await new (Backend as any)();
		await this.backend.init();

		this.$watch('radio', async (newVal: any, oldVal: any) => {
			this.saveSetting();
			// Reset zoom on radio change
			this.view.zoomScale = 1.0;
			this.view.zoomOffset = 0.0;
			this.applyZoomToEngine();

			if (this.remoteMode === 'client') {
				if (!this._applyingSync) {
					this._webrtc.sendCommand({ type: 'requestChange', target: 'radio', property: 'centerFreq', value: this.radio.centerFreq });
					this._webrtc.sendCommand({ type: 'requestChange', target: 'radio', property: 'sampleRate', value: this.radio.sampleRate });
				}
				return;
			}

			if (this.running) {
				await this.togglePlay();
				await this.togglePlay(true);
			}

			// Broadcast updated radio settings to all remote clients
			if (this.remoteMode === 'host' && this._webrtc) {
				this._webrtc.sendCommand({ type: 'sync', radio: this.radio, gains: this.gains, locks: this.locks });
			}
		}, { deep: true });

		this.$watch('gains', () => {
			if (this.remoteMode === 'client') {
				if (!this._applyingSync) {
					this._webrtc.sendCommand({ type: 'requestChange', target: 'gains', property: 'lna', value: this.gains.lna });
					this._webrtc.sendCommand({ type: 'requestChange', target: 'gains', property: 'vga', value: this.gains.vga });
					this._webrtc.sendCommand({ type: 'requestChange', target: 'gains', property: 'ampEnabled', value: this.gains.ampEnabled });
				}
				return;
			}

			if (this.running && this.connected) {
				if (this.backend.setAmpEnable) {
					this.backend.setAmpEnable(this.gains.ampEnabled);
					this.backend.setLnaGain(this.gains.lna);
					this.backend.setVgaGain(this.gains.vga);
				}
			}

			// Broadcast updated gains to all remote clients
			if (this.remoteMode === 'host' && this._webrtc) {
				this._webrtc.sendCommand({ type: 'sync', gains: this.gains, locks: this.locks });
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
		mountCanvas.call(this);
	},
}).mount('#app');
