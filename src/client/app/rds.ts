import type { AppInstance } from './types';

const EMPTY_STATION = { ps: '', rt: '', pi: '', pty: 0, ptyLabel: '', tp: false, ta: false, freq: '' };

export const rdsMethods = {
	toggleRdsPanel(this: AppInstance) {
		this.rds.panelOpen = !this.rds.panelOpen;
	},
	/** Get (or create) the per-VFO RDS station state */
	_rdsStation(this: AppInstance, vfoIndex: number) {
		if (!this.rds.stations[vfoIndex]) {
			this.rds.stations[vfoIndex] = { ...EMPTY_STATION };
		}
		return this.rds.stations[vfoIndex];
	},
	/** Get the active VFO's RDS station (for display in header) */
	rdsActive(this: AppInstance) {
		return this.rds.stations[this.activeVfoIndex] || EMPTY_STATION;
	},
	/** Get all VFOs that have RDS data, as an array with vfoIndex attached */
	rdsStationList(this: AppInstance): Array<{ vfoIndex: number; ps: string; rt: string; pi: string; pty: number; ptyLabel: string; tp: boolean; ta: boolean; freq: string }> {
		const result: Array<any> = [];
		for (const key of Object.keys(this.rds.stations)) {
			const idx = Number(key);
			const stn = this.rds.stations[idx];
			if (stn && (stn.ps || stn.pi || stn.rt))
				result.push({ ...stn, vfoIndex: idx });
		}
		return result;
	},
	_onRdsMessage(this: AppInstance, vfoIndex: number, freqMhz: number, msg: any) {
		const time = new Date().toLocaleTimeString();
		const freq = freqMhz ? this.formatFreq(freqMhz) + ' MHz' : '';
		const stn = this._rdsStation(vfoIndex);

		if (msg.pi !== undefined) {
			stn.pi = msg.pi;
			stn.freq = freq;
		}
		if (msg.ps !== undefined) {
			stn.ps = msg.ps;
			stn.freq = freq;
			this.rds.log.push({ time, field: 'PS', value: msg.ps, freq, vfoIndex });
		}
		if (msg.rt !== undefined) {
			stn.rt = msg.rt;
			this.rds.log.push({ time, field: 'RT', value: msg.rt, freq, vfoIndex });
		}
		if (msg.pty !== undefined) {
			stn.pty = msg.pty;
			stn.ptyLabel = msg.ptyLabel || '';
		}
		if (msg.tp !== undefined) stn.tp = msg.tp;
		if (msg.ta !== undefined) stn.ta = msg.ta;

		// Auto-scroll log
		this.$nextTick(() => {
			const el = this.$refs.rdsBody;
			if (el) el.scrollTop = el.scrollHeight;
		});
	},
	clearRds(this: AppInstance) {
		this.rds.log = [];
		this.rds.stations = {};
	},
	exportRds(this: AppInstance) {
		const lines = this.rds.log.map((e: any) =>
			`[${e.time}] ${e.freq}  ${e.field}: ${e.value}`
		);
		const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `rds-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
		a.click();
		URL.revokeObjectURL(url);
	},
};
