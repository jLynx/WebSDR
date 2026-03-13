/*
Copyright (c) 2026, jLynx <https://github.com/jLynx>

All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
	Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
	Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the
	documentation and/or other materials provided with the distribution.
	Neither the name of Great Scott Gadgets nor the names of its contributors may be used to endorse or promote products derived from this software
	without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

import { HackRF } from '../hackrf';
import type { SdrDevice, SdrDeviceInfo, GainControl } from '../sdr-device';
import { registerDriver } from '../sdr-device';

export class HackRFDevice implements SdrDevice {
	readonly deviceType = 'hackrf';
	readonly sampleRates = [2000000, 4000000, 5000000, 8000000, 10000000, 16000000, 20000000];
	readonly sampleFormat = 'int8' as const;
	readonly gainControls: GainControl[] = [
		{ name: 'LNA', min: 0, max: 40, step: 8, default: 16, type: 'slider' },
		{ name: 'VGA', min: 0, max: 62, step: 2, default: 16, type: 'slider' },
		{ name: 'Amp (14dB)', min: 0, max: 1, step: 1, default: 0, type: 'checkbox' },
	];

	private hackrf = new HackRF();

	async open(device: USBDevice): Promise<void> {
		await this.hackrf.open(device);
	}

	async close(): Promise<void> {
		await this.hackrf.close();
		await this.hackrf.exit();
	}

	async getInfo(): Promise<SdrDeviceInfo> {
		const boardId = await this.hackrf.readBoardId();
		const versionString = await this.hackrf.readVersionString();
		const { serialNo } = await this.hackrf.readPartIdSerialNo();
		const name = HackRF.BOARD_ID_NAME.get(boardId) || 'Unknown HackRF';
		const serial = serialNo.map((i: number) => (i + 0x100000000).toString(16).slice(1)).join('');

		// Log additional info
		const apiVersion = await this.hackrf.readApiVersion();
		const [apiMajor, apiMinor, apiSubminor] = apiVersion;
		const bcdVersion = (apiMajor << 8) | (apiMinor << 4) | apiSubminor;
		console.log(`Board ID: ${boardId} (${name})`);
		console.log(`Firmware: ${versionString} (API:${apiMajor}.${String(apiMinor) + String(apiSubminor)})`);
		console.log(`Serial: ${serial}`);

		if (bcdVersion >= 0x0106 && (boardId === 2 || boardId === 4 || boardId === 5)) {
			try {
				const boardRev = await this.hackrf.boardRevRead();
				const revName = HackRF.BOARD_REV_NAME.get(boardRev);
				if (revName) console.log(`Hardware Revision: ${revName}`);
			} catch (_) { /* not supported */ }
		}

		return { name, serial, firmware: versionString };
	}

	async setSampleRate(rate: number): Promise<void> {
		await this.hackrf.setSampleRateManual(rate, 1);
		await this.hackrf.setBasebandFilterBandwidth(HackRF.computeBasebandFilterBw(rate));
	}

	async setFrequency(freqHz: number): Promise<void> {
		await this.hackrf.setFreq(freqHz);
	}

	async setGain(name: string, value: number): Promise<void> {
		switch (name) {
			case 'LNA': await this.hackrf.setLnaGain(value); break;
			case 'VGA': await this.hackrf.setVgaGain(value); break;
			case 'Amp (14dB)': await this.hackrf.setAmpEnable(!!value); break;
			default: console.warn(`HackRF: unknown gain "${name}"`);
		}
	}

	async setBandwidth(bwHz: number): Promise<void> {
		await this.hackrf.setBasebandFilterBandwidth(bwHz);
	}

	async startRx(callback: (data: ArrayBufferView) => void): Promise<void> {
		await this.hackrf.startRx(callback as (data: Uint8Array) => void);
	}

	async stopRx(): Promise<void> {
		await this.hackrf.stopRx();
	}
}

// USB VID/PID filters for HackRF devices
const HACKRF_FILTERS: USBDeviceFilter[] = [
	{ vendorId: 0x1d50, productId: 0x604b },
	{ vendorId: 0x1d50, productId: 0x6089 },
	{ vendorId: 0x1d50, productId: 0xcc15 },
	{ vendorId: 0x1fc9, productId: 0x000c },
];

registerDriver({
	type: 'hackrf',
	name: 'HackRF',
	filters: HACKRF_FILTERS,
	create: () => new HackRFDevice(),
});
