/*
Airspy WebUSB driver for BrowSDR
Copyright (c) 2026, jLynx <https://github.com/jLynx>

Based on libairspy (Apache 2.0) https://github.com/airspy/airspyone_host

All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
	Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
	Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the
	documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

import type { SdrDevice, SdrDeviceInfo, GainControl } from '../sdr-device';
import { registerDriver } from '../sdr-device';

// ── Airspy vendor request codes ───────────────────────────────────
const AIRSPY_RECEIVER_MODE = 1;
const AIRSPY_BOARD_ID_READ = 9;
const AIRSPY_VERSION_STRING_READ = 10;
const AIRSPY_BOARD_PARTID_SERIALNO_READ = 11;
const AIRSPY_SET_SAMPLERATE = 12;
const AIRSPY_SET_FREQ = 13;
const AIRSPY_SET_LNA_GAIN = 14;
const AIRSPY_SET_MIXER_GAIN = 15;
const AIRSPY_SET_VGA_GAIN = 16;
const AIRSPY_SET_LNA_AGC = 17;
const AIRSPY_SET_MIXER_AGC = 18;
const AIRSPY_SET_RF_BIAS_CMD = 20;
const AIRSPY_GPIO_WRITE = 21;
const AIRSPY_GET_SAMPLERATES = 25;
const AIRSPY_SET_PACKING = 26;

const RECEIVER_MODE_OFF = 0;
const RECEIVER_MODE_RX = 1;

// Bias-T routes through GPIO_PORT1 / GPIO_PIN13 in libairspy:
// port_pin = (port << 5) | pin = (1 << 5) | 13 = 45
const BIAS_T_GPIO_PORT_PIN = (1 << 5) | 13;

const RX_ENDPOINT = 1; // bulk IN endpoint 0x81
const TRANSFER_BUFFER_SIZE = 262144;

const LOG = '[Airspy]';

// Human-readable names for vendor request codes (for log output only)
const REQ_NAMES: Record<number, string> = {
	[AIRSPY_RECEIVER_MODE]: 'RECEIVER_MODE',
	[AIRSPY_BOARD_ID_READ]: 'BOARD_ID_READ',
	[AIRSPY_VERSION_STRING_READ]: 'VERSION_STRING_READ',
	[AIRSPY_BOARD_PARTID_SERIALNO_READ]: 'BOARD_PARTID_SERIALNO_READ',
	[AIRSPY_SET_SAMPLERATE]: 'SET_SAMPLERATE',
	[AIRSPY_SET_FREQ]: 'SET_FREQ',
	[AIRSPY_SET_LNA_GAIN]: 'SET_LNA_GAIN',
	[AIRSPY_SET_MIXER_GAIN]: 'SET_MIXER_GAIN',
	[AIRSPY_SET_VGA_GAIN]: 'SET_VGA_GAIN',
	[AIRSPY_SET_LNA_AGC]: 'SET_LNA_AGC',
	[AIRSPY_SET_MIXER_AGC]: 'SET_MIXER_AGC',
	[AIRSPY_SET_RF_BIAS_CMD]: 'SET_RF_BIAS_CMD',
	[AIRSPY_GPIO_WRITE]: 'GPIO_WRITE',
	[AIRSPY_GET_SAMPLERATES]: 'GET_SAMPLERATES',
	[AIRSPY_SET_PACKING]: 'SET_PACKING',
};
const reqName = (r: number): string => REQ_NAMES[r] ?? `req=${r}`;

// Hex dump helper for short buffers (truncates long ones)
function hex(buf: ArrayBuffer | Uint8Array, max = 32): string {
	const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
	const n = Math.min(u8.length, max);
	let s = '';
	for (let i = 0; i < n; i++) s += u8[i].toString(16).padStart(2, '0') + ' ';
	if (u8.length > max) s += `... (+${u8.length - max} more)`;
	return s.trim();
}

export class AirspyDevice implements SdrDevice {
	readonly deviceType = 'airspy';
	readonly sampleFormat = 'int16' as const;
	readonly gainControls: GainControl[] = [
		{ name: 'LNA', min: 0, max: 14, step: 1, default: 7, type: 'slider' },
		{ name: 'Mixer', min: 0, max: 15, step: 1, default: 7, type: 'slider' },
		{ name: 'VGA', min: 0, max: 15, step: 1, default: 7, type: 'slider' },
		{ name: 'Bias-T', min: 0, max: 1, step: 1, default: 0, type: 'checkbox' },
	];

	// Populated during open() from device query
	sampleRates: number[] = [3000000, 6000000, 10000000];

	private dev!: USBDevice;
	private rxRunning: Promise<void>[] | null = null;
	// Index into sampleRates of the currently configured rate (sent to firmware)
	private currentRateIndex = 0;
	// RX statistics
	private rxTransferCount = 0;
	private rxByteCount = 0;
	private rxStartTime = 0;
	private rxLastStatsLog = 0;

	async open(device: USBDevice): Promise<void> {
		console.log(`${LOG} open() called`);
		console.log(`${LOG}   USB device: vendorId=0x${device.vendorId.toString(16).padStart(4, '0')}, productId=0x${device.productId.toString(16).padStart(4, '0')}`);
		console.log(`${LOG}   productName="${device.productName}", serialNumber="${device.serialNumber}"`);
		console.log(`${LOG}   USB version: ${device.deviceVersionMajor}.${device.deviceVersionMinor}.${device.deviceVersionSubminor}`);
		this.dev = device;

		try {
			console.log(`${LOG}   -> device.open()`);
			await device.open();
			console.log(`${LOG}      device.open() ok`);
		} catch (e) {
			console.error(`${LOG}   device.open() FAILED:`, e);
			throw e;
		}

		try {
			console.log(`${LOG}   -> selectConfiguration(1)`);
			await device.selectConfiguration(1);
			console.log(`${LOG}      selectConfiguration(1) ok`);
		} catch (e) {
			console.error(`${LOG}   selectConfiguration(1) FAILED:`, e);
			throw e;
		}

		try {
			console.log(`${LOG}   -> claimInterface(0)`);
			await device.claimInterface(0);
			console.log(`${LOG}      claimInterface(0) ok`);
		} catch (e) {
			console.error(`${LOG}   claimInterface(0) FAILED:`, e);
			throw e;
		}

		// Query supported sample rates
		console.log(`${LOG}   Querying supported sample rates...`);
		try {
			console.log(`${LOG}     step 1: GET_SAMPLERATES with index=0 (request count) length=4`);
			const countBuf = await this.vendorIn(AIRSPY_GET_SAMPLERATES, 0, 0, 4);
			const countBytes = new Uint8Array(countBuf);
			console.log(`${LOG}       got ${countBytes.length} bytes: [${hex(countBytes)}]`);
			const count = new DataView(countBuf).getUint32(0, true);
			console.log(`${LOG}       parsed count = ${count}`);

			if (count > 0 && count < 100) {
				console.log(`${LOG}     step 2: GET_SAMPLERATES with index=${count} length=${count * 4}`);
				const ratesBuf = await this.vendorIn(AIRSPY_GET_SAMPLERATES, 0, count, count * 4);
				const ratesBytes = new Uint8Array(ratesBuf);
				console.log(`${LOG}       got ${ratesBytes.length} bytes: [${hex(ratesBytes)}]`);
				const ratesView = new DataView(ratesBuf);
				// IMPORTANT: do NOT sort. The firmware's SET_SAMPLERATE expects the
				// index INTO ITS OWN array — sorting reorders our indices and we end
				// up sending the wrong rate to the device.
				this.sampleRates = [];
				for (let i = 0; i < count; i++) {
					this.sampleRates.push(ratesView.getUint32(i * 4, true));
				}
				console.log(`${LOG}     supported sample rates (firmware order): [${this.sampleRates.map(r => (r / 1e6).toFixed(2) + 'M').join(', ')}]`);
				console.log(`${LOG}     raw values: [${this.sampleRates.join(', ')}]`);
			} else {
				console.warn(`${LOG}     count out of range (0..100), keeping defaults: [${this.sampleRates.join(', ')}]`);
			}
		} catch (e) {
			console.warn(`${LOG}   could not query sample rates, using defaults [${this.sampleRates.join(', ')}]:`, e);
		}

		console.log(`${LOG} open() complete`);
	}

	async close(): Promise<void> {
		console.log(`${LOG} close() called`);
		await this.stopRx();
		try {
			console.log(`${LOG}   sending RECEIVER_MODE_OFF`);
			await this.vendorOut(AIRSPY_RECEIVER_MODE, RECEIVER_MODE_OFF, 0);
		} catch (e) {
			console.warn(`${LOG}   RECEIVER_MODE_OFF on close failed (ignoring):`, e);
		}
		try {
			console.log(`${LOG}   -> device.close()`);
			await this.dev.close();
			console.log(`${LOG}      device.close() ok`);
		} catch (e) {
			console.warn(`${LOG}   device.close() failed (ignoring):`, e);
		}
		console.log(`${LOG} close() complete`);
	}

	async getInfo(): Promise<SdrDeviceInfo> {
		console.log(`${LOG} getInfo() called`);
		let name = 'Airspy';
		let firmware: string | undefined;
		let serial: string | undefined;

		try {
			// Board ID is a single uint8_t in libairspy
			console.log(`${LOG}   reading BOARD_ID (1 byte)`);
			const boardBuf = await this.vendorIn(AIRSPY_BOARD_ID_READ, 0, 0, 1);
			const boardId = new Uint8Array(boardBuf)[0];
			console.log(`${LOG}     board ID raw byte = 0x${boardId.toString(16).padStart(2, '0')} (${boardId})`);
			if (boardId === 0) name = 'Airspy One';
			else if (boardId === 1) name = 'Airspy Mini';
			else if (boardId === 2) name = 'Airspy R2';
			else name = `Airspy (unknown board id ${boardId})`;
			console.log(`${LOG}     decoded name: "${name}"`);
		} catch (e) {
			console.warn(`${LOG}   BOARD_ID_READ failed:`, e);
		}

		try {
			console.log(`${LOG}   reading VERSION_STRING (127 bytes)`);
			const verBuf = await this.vendorIn(AIRSPY_VERSION_STRING_READ, 0, 0, 127);
			const verBytes = new Uint8Array(verBuf);
			console.log(`${LOG}     got ${verBytes.length} bytes`);
			firmware = String.fromCharCode(...verBytes.filter(b => b !== 0));
			console.log(`${LOG}     firmware string: "${firmware}"`);
		} catch (e) {
			console.warn(`${LOG}   VERSION_STRING_READ failed:`, e);
		}

		try {
			console.log(`${LOG}   reading PARTID_SERIALNO (24 bytes)`);
			const serialBuf = await this.vendorIn(AIRSPY_BOARD_PARTID_SERIALNO_READ, 0, 0, 24);
			const serialBytes = new Uint8Array(serialBuf);
			console.log(`${LOG}     got ${serialBytes.length} bytes: [${hex(serialBytes)}]`);
			const dv = new DataView(serialBuf);
			const partId = [dv.getUint32(0, true), dv.getUint32(4, true)];
			const sn = [dv.getUint32(8, true), dv.getUint32(12, true), dv.getUint32(16, true), dv.getUint32(20, true)];
			serial = sn.map(n => (n + 0x100000000).toString(16).slice(1)).join('');
			console.log(`${LOG}     part ID: [0x${partId[0].toString(16)}, 0x${partId[1].toString(16)}]`);
			console.log(`${LOG}     serial: ${serial}`);
		} catch (e) {
			console.warn(`${LOG}   PARTID_SERIALNO_READ failed:`, e);
		}

		const info = { name, serial, firmware };
		console.log(`${LOG} getInfo() returning:`, info);
		return info;
	}

	async setSampleRate(rate: number): Promise<void> {
		console.log(`${LOG} setSampleRate(${rate} Hz = ${(rate / 1e6).toFixed(2)} MHz) called`);
		console.log(`${LOG}   available rates: [${this.sampleRates.map(r => (r / 1e6).toFixed(2) + 'M').join(', ')}]`);

		// libairspy: SET_SAMPLERATE is a vendor IN request that reads back 1 byte,
		// with the sample-rate INDEX placed in wIndex (not the Hz value).
		let idx = this.sampleRates.indexOf(rate);
		if (idx < 0) {
			console.warn(`${LOG}   exact rate ${rate} not in list — picking closest`);
			let best = 0;
			let bestDiff = Math.abs(this.sampleRates[0] - rate);
			for (let i = 1; i < this.sampleRates.length; i++) {
				const d = Math.abs(this.sampleRates[i] - rate);
				if (d < bestDiff) { best = i; bestDiff = d; }
			}
			idx = best;
		}
		this.currentRateIndex = idx;
		console.log(`${LOG}   selected index=${idx} -> ${this.sampleRates[idx]} Hz`);
		console.log(`${LOG}   sending SET_SAMPLERATE (vendor IN, value=0, index=${idx}, length=1)`);
		try {
			const result = await this.vendorIn(AIRSPY_SET_SAMPLERATE, 0, idx, 1);
			console.log(`${LOG}   SET_SAMPLERATE response: [${hex(result)}]`);
		} catch (e) {
			console.error(`${LOG}   SET_SAMPLERATE FAILED:`, e);
			throw e;
		}
	}

	async setFrequency(freqHz: number): Promise<void> {
		console.log(`${LOG} setFrequency(${freqHz} Hz = ${(freqHz / 1e6).toFixed(6)} MHz) called`);
		const data = new ArrayBuffer(4);
		new DataView(data).setUint32(0, freqHz, true);
		console.log(`${LOG}   sending SET_FREQ (vendor OUT, value=0, index=0, data=[${hex(data)}])`);
		try {
			await this.vendorOut(AIRSPY_SET_FREQ, 0, 0, data);
			console.log(`${LOG}   SET_FREQ ok`);
		} catch (e) {
			console.error(`${LOG}   SET_FREQ FAILED:`, e);
			throw e;
		}
	}

	async setGain(name: string, value: number): Promise<void> {
		console.log(`${LOG} setGain(name="${name}", value=${value}) called`);
		// libairspy: gain/AGC setters are vendor IN with the value in wIndex,
		// reading back 1 byte. NOT vendor OUT.
		try {
			switch (name) {
				case 'LNA':
					console.log(`${LOG}   SET_LNA_AGC=0 (disable), then SET_LNA_GAIN=${value & 0x0f}`);
					await this.vendorIn(AIRSPY_SET_LNA_AGC, 0, 0, 1);
					await this.vendorIn(AIRSPY_SET_LNA_GAIN, 0, value & 0x0f, 1);
					break;
				case 'Mixer':
					console.log(`${LOG}   SET_MIXER_AGC=0 (disable), then SET_MIXER_GAIN=${value & 0x0f}`);
					await this.vendorIn(AIRSPY_SET_MIXER_AGC, 0, 0, 1);
					await this.vendorIn(AIRSPY_SET_MIXER_GAIN, 0, value & 0x0f, 1);
					break;
				case 'VGA':
					console.log(`${LOG}   SET_VGA_GAIN=${value & 0x0f}`);
					await this.vendorIn(AIRSPY_SET_VGA_GAIN, 0, value & 0x0f, 1);
					break;
				case 'Bias-T':
					console.log(`${LOG}   GPIO_WRITE port_pin=${BIAS_T_GPIO_PORT_PIN} value=${value ? 1 : 0}`);
					await this.vendorOut(AIRSPY_GPIO_WRITE, value ? 1 : 0, BIAS_T_GPIO_PORT_PIN);
					break;
				default:
					console.warn(`${LOG}   unknown gain control "${name}" — ignoring`);
			}
			console.log(`${LOG}   setGain "${name}" ok`);
		} catch (e) {
			console.error(`${LOG}   setGain "${name}" FAILED:`, e);
			throw e;
		}
	}

	async startRx(callback: (data: ArrayBufferView) => void): Promise<void> {
		console.log(`${LOG} startRx() called`);
		if (this.rxRunning) {
			console.log(`${LOG}   already running, calling stopRx() first`);
			await this.stopRx();
		}

		// libairspy startup sequence (airspy_start_rx in airspy.c):
		//   1. set RECEIVER_MODE_OFF
		//   2. clear halt on bulk IN endpoint
		//   3. set RECEIVER_MODE_RX
		//   4. submit transfers
		try {
			console.log(`${LOG}   step 1/4: RECEIVER_MODE_OFF`);
			await this.vendorOut(AIRSPY_RECEIVER_MODE, RECEIVER_MODE_OFF, 0);
		} catch (e) {
			console.error(`${LOG}   RECEIVER_MODE_OFF FAILED:`, e);
			throw e;
		}

		try {
			console.log(`${LOG}   step 2/4: clearHalt('in', ${RX_ENDPOINT})`);
			await this.dev.clearHalt('in', RX_ENDPOINT);
			console.log(`${LOG}     clearHalt ok`);
		} catch (e) {
			console.warn(`${LOG}   clearHalt failed (continuing anyway):`, e);
		}

		try {
			console.log(`${LOG}   step 3/4: RECEIVER_MODE_RX`);
			await this.vendorOut(AIRSPY_RECEIVER_MODE, RECEIVER_MODE_RX, 0);
		} catch (e) {
			console.error(`${LOG}   RECEIVER_MODE_RX FAILED:`, e);
			throw e;
		}

		console.log(`${LOG}   step 4/4: submitting 4 parallel bulk IN transfers (buffer=${TRANSFER_BUFFER_SIZE} bytes each)`);
		this.rxTransferCount = 0;
		this.rxByteCount = 0;
		this.rxStartTime = performance.now();
		this.rxLastStatsLog = this.rxStartTime;

		const transfer = async (transferId: number): Promise<void> => {
			console.log(`${LOG}   [transfer ${transferId}] started`);
			let firstTransferLogged = false;
			await Promise.resolve();
			while (this.rxRunning) {
				try {
					const result = await this.dev.transferIn(RX_ENDPOINT, TRANSFER_BUFFER_SIZE);
					if (result.status !== 'ok') {
						console.warn(`${LOG}   [transfer ${transferId}] non-ok status: ${result.status}`);
						break;
					}
					const raw = new Uint8Array(result.data!.buffer, 0, result.data!.byteLength);

					this.rxTransferCount++;
					this.rxByteCount += raw.byteLength;

					if (!firstTransferLogged) {
						firstTransferLogged = true;
						const sampleView = new Int16Array(raw.buffer, raw.byteOffset, Math.min(8, raw.byteLength / 2));
						console.log(`${LOG}   [transfer ${transferId}] FIRST DATA: ${raw.byteLength} bytes, first int16 samples: [${Array.from(sampleView).join(', ')}]`);

						// Scan the full packet for min/max/abs-mean so we can verify
						// the sample format (12-bit ±2047 vs full int16 ±32767) and
						// detect clipping. Run on first packet of each worker only.
						const fullView = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
						let mn = 32767, mx = -32768, absSum = 0, clippedNeg = 0, clippedPos = 0;
						for (let i = 0; i < fullView.length; i++) {
							const v = fullView[i];
							if (v < mn) mn = v;
							if (v > mx) mx = v;
							absSum += v < 0 ? -v : v;
							if (v <= -32700) clippedNeg++;
							if (v >= 32700) clippedPos++;
						}
						const absMean = absSum / fullView.length;
						console.log(`${LOG}   [transfer ${transferId}] sample stats: min=${mn} max=${mx} abs-mean=${absMean.toFixed(0)} near-clip neg=${clippedNeg} pos=${clippedPos} (of ${fullView.length} samples)`);
					}

					// Periodic stats log (once per ~2 seconds, from any worker)
					const now = performance.now();
					if (now - this.rxLastStatsLog > 2000) {
						this.rxLastStatsLog = now;
						const elapsed = (now - this.rxStartTime) / 1000;
						const mbps = (this.rxByteCount / elapsed / 1024 / 1024).toFixed(2);
						const avgSize = (this.rxByteCount / this.rxTransferCount).toFixed(0);
						console.log(`${LOG}   RX stats: ${this.rxTransferCount} transfers, ${(this.rxByteCount / 1024 / 1024).toFixed(2)} MiB in ${elapsed.toFixed(1)}s (${mbps} MiB/s, avg ${avgSize} B/transfer)`);
					}

					// Airspy firmware delivers REAL samples (not IQ) at 2x the IQ rate
					// in signed 16-bit LE words using the FULL int16 range (~±32700).
					// libairspy's host-side Hilbert filter converts to IQ; this driver
					// currently passes raw real samples through, so downstream DSP sees
					// a real-valued signal (this is a known follow-up).
					// Scale int16 -> int8 by shifting right 8 (NOT 4 — that overflows
					// when values exceed ±2047 because Int8Array truncates mod 256).
					const int16View = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
					const int8Data = new Int8Array(int16View.length);
					for (let i = 0; i < int16View.length; i++) {
						int8Data[i] = int16View[i] >> 8;
					}
					callback(new Uint8Array(int8Data.buffer));
				} catch (e: unknown) {
					if (this.rxRunning) {
						const msg = e instanceof Error ? e.message : String(e);
						console.error(`${LOG}   [transfer ${transferId}] error after ${this.rxTransferCount} transfers / ${this.rxByteCount} bytes:`, msg, e);
					} else {
						console.log(`${LOG}   [transfer ${transferId}] stopped (rxRunning=false)`);
					}
					break;
				}
			}
			console.log(`${LOG}   [transfer ${transferId}] exited loop`);
		};
		this.rxRunning = Array.from({ length: 4 }, (_, i) => transfer(i));
		console.log(`${LOG} startRx() complete — ${this.rxRunning.length} workers running`);
	}

	async stopRx(): Promise<void> {
		console.log(`${LOG} stopRx() called (rxRunning=${this.rxRunning ? this.rxRunning.length + ' workers' : 'null'})`);
		if (this.rxRunning) {
			const promises = this.rxRunning;
			this.rxRunning = null;
			console.log(`${LOG}   waiting for ${promises.length} transfer workers to finish`);
			try { await Promise.allSettled(promises); } catch (_) { /* ignore */ }
			console.log(`${LOG}   all workers finished`);
		}
		try {
			console.log(`${LOG}   sending RECEIVER_MODE_OFF`);
			await this.vendorOut(AIRSPY_RECEIVER_MODE, RECEIVER_MODE_OFF, 0);
			console.log(`${LOG}   RECEIVER_MODE_OFF ok`);
		} catch (e) {
			console.warn(`${LOG}   RECEIVER_MODE_OFF on stopRx failed (ignoring):`, e);
		}
		const elapsed = this.rxStartTime ? ((performance.now() - this.rxStartTime) / 1000).toFixed(1) : '?';
		console.log(`${LOG} stopRx() complete — total: ${this.rxTransferCount} transfers, ${this.rxByteCount} bytes over ${elapsed}s`);
	}

	// ── USB helper methods ────────────────────────────────────────
	private async vendorOut(request: number, value: number, index: number, data?: ArrayBuffer): Promise<void> {
		const dataLen = data ? data.byteLength : 0;
		console.log(`${LOG}     [USB OUT] ${reqName(request)} value=${value} index=${index} dataLen=${dataLen}${data && dataLen <= 16 ? ` data=[${hex(data)}]` : ''}`);
		try {
			const result = await this.dev.controlTransferOut({
				requestType: 'vendor',
				recipient: 'device',
				request,
				value,
				index,
			}, data);
			if (result.status !== 'ok') {
				console.error(`${LOG}     [USB OUT] ${reqName(request)} non-ok status: ${result.status} (bytesWritten=${result.bytesWritten})`);
				throw new Error(`Airspy: vendor OUT failed (req=${request} ${reqName(request)}, status=${result.status})`);
			}
			console.log(`${LOG}     [USB OUT] ${reqName(request)} ok (bytesWritten=${result.bytesWritten})`);
		} catch (e) {
			console.error(`${LOG}     [USB OUT] ${reqName(request)} threw:`, e);
			throw e;
		}
	}

	private async vendorIn(request: number, value: number, index: number, length: number): Promise<ArrayBuffer> {
		console.log(`${LOG}     [USB IN ] ${reqName(request)} value=${value} index=${index} length=${length}`);
		try {
			const result = await this.dev.controlTransferIn({
				requestType: 'vendor',
				recipient: 'device',
				request,
				value,
				index,
			}, length);
			if (result.status !== 'ok') {
				console.error(`${LOG}     [USB IN ] ${reqName(request)} non-ok status: ${result.status}`);
				throw new Error(`Airspy: vendor IN failed (req=${request} ${reqName(request)}, status=${result.status})`);
			}
			const got = result.data ? result.data.byteLength : 0;
			console.log(`${LOG}     [USB IN ] ${reqName(request)} ok (got ${got}/${length} bytes)`);
			return new Uint8Array(result.data!.buffer).buffer as ArrayBuffer;
		} catch (e) {
			console.error(`${LOG}     [USB IN ] ${reqName(request)} threw:`, e);
			throw e;
		}
	}
}

// ── Register driver ───────────────────────────────────────────────
console.log(`${LOG} driver loaded — registering for vendorId=0x1d50, productId=0x60a1`);
registerDriver({
	type: 'airspy',
	name: 'Airspy',
	filters: [{ vendorId: 0x1d50, productId: 0x60a1 }],
	create: () => new AirspyDevice(),
});
