import type { AppInstance } from './types';
import { makeDefaultVfo, BOOKMARK_CATEGORIES } from './constants';

export const bookmarkMethods = {
	categoryLabel(this: AppInstance, value: string) {
		const cat = BOOKMARK_CATEGORIES.find(c => c.value === value);
		return cat ? cat.label : value;
	},
	openSaveBookmark(this: AppInstance, type: string) {
		const count = this.bookmarks.filter((b: any) => (b.type || 'group') === type).length + 1;
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
	confirmBookmark(this: AppInstance) {
		const { type, name, category } = this.bookmarkModal;
		if (!name.trim()) return;
		let bm: any;
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
				vfos: JSON.parse(JSON.stringify(this.vfos)).map((v: any) => ({ ...v, enabled: false, focused: false })),
				activeVfoIndex: this.activeVfoIndex,
			};
		}
		this.bookmarks.push(bm);
		this.bookmarkModal.show = false;
		this.saveBookmarks();
		this.showMsg(`"${bm.name}" saved.`);
	},
	async jumpToBookmark(this: AppInstance, index: number) {
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

			// Sync backend VFO count: remove extras, then add missing slots
			if (this.backend && this.running) {
				const oldCount = this.vfos.length;
				const newCount = bm.vfos.length;
				// Remove excess VFOs (from the end to avoid index shifting)
				for (let i = oldCount - 1; i >= newCount; i--) {
					if (this.remoteMode === 'client' && this._webrtc) {
						this._webrtc.sendCommand({ type: 'removeRemoteVfo', index: i });
					} else {
						await this.backend.removeVfo(i);
					}
				}
				// Add missing VFO slots
				for (let i = oldCount; i < newCount; i++) {
					if (this.remoteMode === 'client' && this._webrtc) {
						this._webrtc.sendCommand({ type: 'addRemoteVfo' });
					} else {
						await this.backend.addVfo();
					}
				}
			}

			this.vfos = bm.vfos.map((v: any) => ({
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
	openEditBookmark(this: AppInstance, index: number) {
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
	confirmEditBookmark(this: AppInstance) {
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
			bm.vfos = e.vfos.map((v: any) => ({ ...v, enabled: false, focused: false }));
			bm.activeVfoIndex = e.activeVfoIndex;
		}
		this.bookmarks.splice(e.index, 1, bm);
		e.show = false;
		this.saveBookmarks();
		this.showMsg(`"${bm.name}" updated.`);
	},
	addVfoToEditGroup(this: AppInstance) {
		this.bookmarkEdit.vfos.push({
			...makeDefaultVfo(this.bookmarkEdit.centerFreq),
			enabled: false,
			focused: false,
		});
	},
	deleteBookmark(this: AppInstance, index: number) {
		const name = this.bookmarks[index]?.name;
		this.bookmarks.splice(index, 1);
		this.saveBookmarks();
		if (name) this.showMsg(`"${name}" deleted.`);
	},
	saveBookmarks(this: AppInstance) {
		// Sort in-place: individual freq bookmarks (by freq) first, then groups (by centerFreq)
		this.bookmarks.sort((a: any, b: any) => {
			const aIsIndividual = (a.type || 'group') === 'individual';
			const bIsIndividual = (b.type || 'group') === 'individual';
			if (aIsIndividual !== bIsIndividual) return aIsIndividual ? -1 : 1;
			const aFreq = aIsIndividual ? a.freq : a.centerFreq;
			const bFreq = bIsIndividual ? b.freq : b.centerFreq;
			return aFreq - bFreq;
		});
		localStorage.setItem('sdr-web-bookmarks', JSON.stringify(this.bookmarks));
	},
	exportBookmarks(this: AppInstance) {
		const json = JSON.stringify(this.bookmarks, null, 2);
		const blob = new Blob([json], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `sdr-bookmarks-${new Date().toISOString().slice(0, 10)}.json`;
		a.click();
		URL.revokeObjectURL(url);
	},
	importBookmarks(this: AppInstance, event: Event) {
		const file = (event.target as HTMLInputElement).files?.[0];
		if (!file) return;
		// Stash the file, reset input, then show mode dialog
		this._pendingImportFile = file;
		(event.target as HTMLInputElement).value = '';
		this.bookmarkImportModal.show = true;
	},
	confirmImport(this: AppInstance, mode: string) {
		this.bookmarkImportModal.show = false;
		const file = this._pendingImportFile;
		if (!file) return;
		this._pendingImportFile = null;
		const reader = new FileReader();
		reader.onload = (e: any) => {
			try {
				const imported = JSON.parse(e.target.result);
				if (!Array.isArray(imported)) throw new Error('Not an array');
				const cleaned = imported
					.filter((b: any) => b && typeof b === 'object')
					.map((b: any) => ({ type: 'group', ...b }));
				if (mode === 'replace') {
					this.bookmarks = cleaned;
					this.saveBookmarks();
					this.showMsg(`Replaced with ${cleaned.length} bookmark${cleaned.length !== 1 ? 's' : ''}.`);
				} else {
					// Merge: skip duplicates by id
					const existingIds = new Set(this.bookmarks.map((b: any) => b.id));
					const newOnes = cleaned.filter((b: any) => !existingIds.has(b.id));
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
	loadBookmarks(this: AppInstance) {
		try {
			const json = localStorage.getItem('sdr-web-bookmarks');
			if (json) {
				const bms = JSON.parse(json);
				// Migrate old bookmarks without a type field
				if (Array.isArray(bms)) this.bookmarks = bms.map((b: any) => ({ type: 'group', ...b }));
			}
		} catch (e) { }
	},
};
