import type { AppInstance } from './types';
import { makeDefaultVfo, MODE_DEFAULTS } from './constants';

export const vfoMethods = {
	toggleVfoCheckbox(this: AppInstance, index: number) {
		const anyEnabled = this.vfos.some((v: any) => v.enabled);
		if (anyEnabled) {
			this._initAudioCtx();
		}
		// When muting a VFO, flush any partially-filled whisper buffer so the
		// recording doesn't hang waiting for samples that will never arrive.
		if (!this.vfos[index].enabled && this._whisperVfoStates?.[index]?.bufLen > 0) {
			this._flushWhisperVfoBuf(index);
		}
		this.updateBackendVfoParams(index);
	},
	applyVfoFreq(this: AppInstance, e: Event, index: number) {
		const vfo = this.vfos[index];
		vfo.focused = false;
		let val = parseFloat(vfo.displayFreq);
		if (!isNaN(val)) {
			this.validateAndApplyVfoFreq(index, val);
		} else {
			vfo.displayFreq = this.formatFreq(vfo.freq);
		}
		(e.target as HTMLElement).blur();
	},
	applyModeDefaults(this: AppInstance, index: number) {
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
	updateBackendVfoParams(this: AppInstance, index: number) {
		if (this.backend && this.running && index >= 0 && index < this.vfos.length) {
			const vfo = this.vfos[index];
			// Force-disable VFOs that are outside the tunable bandwidth
			// to prevent the DSP from processing out-of-range frequencies
			const inBandwidth = this.isFreqInBandwidth(vfo.freq);
			const params = {
				freq: vfo.freq,
				mode: vfo.mode,
				enabled: vfo.enabled && inBandwidth,
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
				// Send the VFO params to the host over the cmd channel so the host
				// can configure the correct indexed remote VFO worker.
				this._webrtc.sendCommand({ type: 'vfoUpdate', index, params });
			} else {
				this.backend.setVfoParams(index, params);
			}
		}
	},
	async addVfo(this: AppInstance) {
		const newVfo = makeDefaultVfo(this.radio.centerFreq);
		this.vfos.push(newVfo);
		if (this.backend && this.running) {
			if (this.remoteMode === 'client' && this._webrtc) {
				// Tell the host to allocate a new remote VFO worker slot.
				this._webrtc.sendCommand({ type: 'addRemoteVfo' });
				this.updateBackendVfoParams(this.vfos.length - 1);
			} else {
				await this.backend.addVfo();
				this.updateBackendVfoParams(this.vfos.length - 1);
			}
		}
		this.activeVfoIndex = this.vfos.length - 1;

		// Auto lock when 5 or more VFOs are loaded
		if (this.vfos.length >= 5 && !this.view.locked) {
			this.view.locked = true;
			this.showMsg("Display auto-locked (> 5 VFOs)");
		}
	},
	isFreqInBandwidth(this: AppInstance, freq: number): boolean {
		const halfBw = this.radio.sampleRate / 2e6;
		return freq >= this.radio.centerFreq - halfBw && freq <= this.radio.centerFreq + halfBw;
	},

	findCenterForAllVfos(this: AppInstance, newFreq: number, vfoIndex: number): number | null {
		const freqs: number[] = [];
		for (let i = 0; i < this.vfos.length; i++) {
			freqs.push(i === vfoIndex ? newFreq : this.vfos[i].freq);
		}
		const min = Math.min(...freqs);
		const max = Math.max(...freqs);
		const span = this.radio.sampleRate / 1e6;
		if (max - min <= span) {
			return (max + min) / 2;
		}
		return null;
	},

	findBestCenterForSubset(this: AppInstance, newFreq: number, vfoIndex: number): { centerFreq: number; included: number[]; excluded: number[] } {
		const span = this.radio.sampleRate / 1e6;
		const entries: Array<{ index: number; freq: number }> = [];
		for (let i = 0; i < this.vfos.length; i++) {
			entries.push({ index: i, freq: i === vfoIndex ? newFreq : this.vfos[i].freq });
		}
		entries.sort((a, b) => a.freq - b.freq);

		let bestIncluded: number[] = [];
		let bestCenter = newFreq;

		// Try every possible window that includes newFreq
		for (let i = 0; i < entries.length; i++) {
			// Window starts at entries[i].freq - small epsilon
			const windowMin = entries[i].freq;
			const windowMax = windowMin + span;
			// Check if newFreq is in this window
			if (newFreq < windowMin || newFreq > windowMax) continue;
			const included: number[] = [];
			for (const e of entries) {
				if (e.freq >= windowMin && e.freq <= windowMax) {
					included.push(e.index);
				}
			}
			if (included.length > bestIncluded.length) {
				bestIncluded = included;
				// Center the window on the actual VFOs that fit
				const incFreqs = included.map(idx => entries.find(e => e.index === idx)!.freq);
				bestCenter = (Math.min(...incFreqs) + Math.max(...incFreqs)) / 2;
			}
		}

		const excluded = entries.map(e => e.index).filter(i => !bestIncluded.includes(i));
		return { centerFreq: bestCenter, included: bestIncluded, excluded };
	},

	validateAndApplyVfoFreq(this: AppInstance, index: number, newFreq: number) {
		const vfo = this.vfos[index];
		const previousFreq = vfo.freq;

		// Case 1: Already within bandwidth — apply directly
		if (this.isFreqInBandwidth(newFreq)) {
			vfo.freq = newFreq;
			vfo.displayFreq = this.formatFreq(newFreq);
			this.updateBackendVfoParams(index);
			return;
		}

		// Case 2: Client mode with locked center frequency — clamp and warn
		if (this.remoteMode === 'client' && this.locks.centerFreq) {
			const halfBw = this.radio.sampleRate / 2e6;
			const minBw = this.radio.centerFreq - halfBw;
			const maxBw = this.radio.centerFreq + halfBw;
			const clamped = Math.max(minBw, Math.min(maxBw, newFreq));
			vfo.freq = clamped;
			vfo.displayFreq = this.formatFreq(clamped);
			this.updateBackendVfoParams(index);
			this.showMsg('VFO frequency clamped — center frequency is locked by host');
			return;
		}

		// Case 3: Try to fit all VFOs by adjusting center frequency
		const newCenter = this.findCenterForAllVfos(newFreq, index);
		if (newCenter !== null) {
			vfo.freq = newFreq;
			vfo.displayFreq = this.formatFreq(newFreq);
			this.radio.centerFreq = newCenter;
			this.updateAllBackendVfoParams();
			return;
		}

		// Case 4: Can't fit all VFOs — show conflict dialog
		const bestSubset = this.findBestCenterForSubset(newFreq, index);

		const optionA = {
			centerFreq: bestSubset.centerFreq,
			description: `Includes ${bestSubset.included.length} of ${this.vfos.length} VFOs (VFO ${bestSubset.excluded.map((i: number) => i + 1).join(', ')} outside bandwidth)`,
		};

		// Option B: center on just this VFO — only offer if different from option A
		const allOthersExcluded = bestSubset.included.length === 1 && bestSubset.included[0] === index;
		const optionB = allOthersExcluded ? null : {
			centerFreq: newFreq,
			description: `Only VFO ${index + 1} in bandwidth`,
			excludedVfos: this.vfos.map((_: any, i: number) => i).filter((i: number) => i !== index),
		};

		this.vfoConflictDialog = {
			show: true,
			vfoIndex: index,
			requestedFreq: newFreq,
			previousFreq,
			optionA,
			optionB,
		};
	},

	updateAllBackendVfoParams(this: AppInstance) {
		for (let i = 0; i < this.vfos.length; i++) {
			this.updateBackendVfoParams(i);
		}
	},

	resolveVfoConflict(this: AppInstance, choice: 'a' | 'b' | 'cancel') {
		const d = this.vfoConflictDialog;
		if (choice === 'a' && d.optionA) {
			const vfo = this.vfos[d.vfoIndex];
			vfo.freq = d.requestedFreq;
			vfo.displayFreq = this.formatFreq(d.requestedFreq);
			this.radio.centerFreq = d.optionA.centerFreq;
			this.updateAllBackendVfoParams();
		} else if (choice === 'b' && d.optionB) {
			const vfo = this.vfos[d.vfoIndex];
			vfo.freq = d.requestedFreq;
			vfo.displayFreq = this.formatFreq(d.requestedFreq);
			this.radio.centerFreq = d.optionB.centerFreq;
			this.updateAllBackendVfoParams();
		} else {
			// Cancel — revert displayFreq
			const vfo = this.vfos[d.vfoIndex];
			vfo.displayFreq = this.formatFreq(d.previousFreq);
		}
		d.show = false;
	},

	async removeVfo(this: AppInstance, index: number) {
		if (this.vfos.length <= 1) return;
		this.vfos.splice(index, 1);
		if (this.backend && this.running) {
			if (this.remoteMode === 'client' && this._webrtc) {
				this._webrtc.sendCommand({ type: 'removeRemoteVfo', index });
			} else {
				await this.backend.removeVfo(index);
			}
		}
		if (this.activeVfoIndex >= this.vfos.length) {
			this.activeVfoIndex = this.vfos.length - 1;
		}
	},
};
