import type { AppInstance } from './types';
import { makeDefaultVfo } from './constants';

export const settingsMethods = {
	saveSetting(this: AppInstance) {
		const obj = {
			radio: this.radio,
			display: this.display,
			gains: this.gains,
			locks: this.locks,
			vfos: this.vfos,
			view: this.view,
			collapsedPanels: this.collapsedPanels,
			recentRemoteIds: this.recentRemoteIds,
		};
		localStorage.setItem("SDRSetting", JSON.stringify(obj));
	},
	loadSetting(this: AppInstance) {
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
					this.vfos = setting.vfos.map((v: any) => ({ ...makeDefaultVfo(), ...v }));
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
				if (setting.recentRemoteIds && Array.isArray(setting.recentRemoteIds)) this.recentRemoteIds = setting.recentRemoteIds;
			}
		} catch (e) { }
	},
	requestOrApplyChange(this: AppInstance, target: string, property: string, value: any) {
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
};
