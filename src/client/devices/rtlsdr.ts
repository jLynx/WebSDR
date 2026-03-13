/*
RTL-SDR WebUSB driver for BrowSDR
Copyright (c) 2026, jLynx <https://github.com/jLynx>

Based on rtlsdrjs by Sandeep Mistry (Apache 2.0)
  https://github.com/sandeepmistry/rtlsdrjs
Based on Google Radio Receiver by Jacobo Tarrío (Apache 2.0)
  https://github.com/nicholasgasior/nicholasgasior-chrome-apps-radio-receiver

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

// ── USB Protocol Constants ────────────────────────────────────────
const XTAL_FREQ = 28800000;
const IF_FREQ = 3570000;
const BYTES_PER_SAMPLE = 2;
const TRANSFER_BUFFER_SIZE = 65536;
const WRITE_FLAG = 0x10;

const BLOCK = {
	DEMOD: 0x000,
	USB: 0x100,
	SYS: 0x200,
	I2C: 0x600,
};

const REG = {
	SYSCTL: 0x2000,
	EPA_CTL: 0x2148,
	EPA_MAXPKT: 0x2158,
	DEMOD_CTL: 0x3000,
	DEMOD_CTL_1: 0x300b,
};

// ── R820T Tuner Constants ─────────────────────────────────────────
const R820T_I2C_ADDR = 0x34;
const R820T_CHECK_VAL = 0x69;
const R820T_INIT_REGS = [
	0x83, 0x32, 0x75, 0xc0, 0x40, 0xd6, 0x6c,
	0xf5, 0x63, 0x75, 0x68, 0x6c, 0x83, 0x80, 0x00,
	0x0f, 0x00, 0xc0, 0x30, 0x48, 0xcc, 0x60, 0x00,
	0x54, 0xae, 0x4a, 0xc0,
];

const MUX_CFGS: [number, number, number, number][] = [
	[0, 0x08, 0x02, 0xdf],
	[50, 0x08, 0x02, 0xbe],
	[55, 0x08, 0x02, 0x8b],
	[60, 0x08, 0x02, 0x7b],
	[65, 0x08, 0x02, 0x69],
	[70, 0x08, 0x02, 0x58],
	[75, 0x00, 0x02, 0x44],
	[90, 0x00, 0x02, 0x34],
	[110, 0x00, 0x02, 0x24],
	[140, 0x00, 0x02, 0x14],
	[180, 0x00, 0x02, 0x13],
	[250, 0x00, 0x02, 0x11],
	[280, 0x00, 0x02, 0x00],
	[310, 0x00, 0x41, 0x00],
	[588, 0x00, 0x40, 0x00],
];

const BIT_REVS = [
	0x0, 0x8, 0x4, 0xc, 0x2, 0xa, 0x6, 0xe,
	0x1, 0x9, 0x5, 0xd, 0x3, 0xb, 0x7, 0xf,
];

// ── Low-level USB communication layer ─────────────────────────────
class RtlCom {
	private dev: USBDevice;

	constructor(dev: USBDevice) {
		this.dev = dev;
	}

	async writeReg(block: number, reg: number, value: number, length: number): Promise<void> {
		const buf = this.numberToBuffer(value, length);
		await this.writeCtrlMsg(reg, block | WRITE_FLAG, buf);
	}

	async readReg(block: number, reg: number, length: number): Promise<number> {
		const buf = await this.readCtrlMsg(reg, block, length);
		return this.bufferToNumber(buf);
	}

	async writeRegBuffer(block: number, reg: number, buffer: ArrayBuffer): Promise<void> {
		await this.writeCtrlMsg(reg, block | WRITE_FLAG, buffer);
	}

	async readRegBuffer(block: number, reg: number, length: number): Promise<ArrayBuffer> {
		return this.readCtrlMsg(reg, block, length);
	}

	async readDemodReg(page: number, addr: number): Promise<number> {
		return this.readReg(page, (addr << 8) | 0x20, 1);
	}

	async writeDemodReg(page: number, addr: number, value: number, len: number): Promise<void> {
		const buf = this.numberToBuffer(value, len, true);
		await this.writeCtrlMsg((addr << 8) | 0x20, page | WRITE_FLAG, buf);
		// Dummy read of demod page 0x0a as sync barrier (matches librtlsdr).
		// This ensures the RTL2832U commits the write before we proceed.
		// Previously this stalled on FC0012 devices, but that crash was
		// actually caused by corrupted DEMOD_CTL from wrong GPIO addresses.
		try {
			await this.readDemodReg(0x0a, 0x01);
		} catch (_) {
			// Sync read failed — not critical, continue
		}
	}

	async openI2C(): Promise<void> {
		await this.writeDemodReg(1, 1, 0x18, 1);
	}

	async closeI2C(): Promise<void> {
		await this.writeDemodReg(1, 1, 0x10, 1);
	}

	async readI2CReg(addr: number, reg: number): Promise<number> {
		console.log(`RTL-SDR: I2C read addr=0x${addr.toString(16)} reg=0x${reg.toString(16)}`);
		await this.writeRegBuffer(BLOCK.I2C, addr, new Uint8Array([reg]).buffer);
		return this.readReg(BLOCK.I2C, addr, 1);
	}

	async writeI2CReg(addr: number, reg: number, value: number): Promise<void> {
		await this.writeRegBuffer(BLOCK.I2C, addr, new Uint8Array([reg, value]).buffer);
	}

	async readI2CRegBuffer(addr: number, reg: number, len: number): Promise<ArrayBuffer> {
		await this.writeRegBuffer(BLOCK.I2C, addr, new Uint8Array([reg]).buffer);
		return this.readRegBuffer(BLOCK.I2C, addr, len);
	}

	async readBulk(length: number): Promise<ArrayBuffer> {
		const result = await this.dev.transferIn(1, length);
		if (result.status !== 'ok') throw new Error('RTL-SDR bulk read failed: ' + result.status);
		return new Uint8Array(result.data!.buffer).buffer as ArrayBuffer;
	}

	private async readCtrlMsg(value: number, index: number, length: number): Promise<ArrayBuffer> {
		const result = await this.dev.controlTransferIn({
			requestType: 'vendor',
			recipient: 'device',
			request: 0,
			value,
			index,
		}, Math.max(8, length));
		if (result.status !== 'ok') {
			throw new Error(`RTL-SDR USB read failed: val=0x${value.toString(16)} idx=0x${index.toString(16)} status=${result.status}`);
		}
		return new Uint8Array(result.data!.buffer).slice(0, length).buffer as ArrayBuffer;
	}

	private async writeCtrlMsg(value: number, index: number, data: ArrayBuffer): Promise<void> {
		const result = await this.dev.controlTransferOut({
			requestType: 'vendor',
			recipient: 'device',
			request: 0,
			value,
			index,
		}, data);
		if (result.status !== 'ok') {
			throw new Error(`RTL-SDR USB write failed: val=0x${value.toString(16)} idx=0x${index.toString(16)} status=${result.status}`);
		}
	}

	private bufferToNumber(buffer: ArrayBuffer): number {
		const dv = new DataView(buffer);
		if (buffer.byteLength === 1) return dv.getUint8(0);
		if (buffer.byteLength === 2) return dv.getUint16(0, true);
		if (buffer.byteLength === 4) return dv.getUint32(0, true);
		return 0;
	}

	private numberToBuffer(value: number, len: number, bigEndian = false): ArrayBuffer {
		const buffer = new ArrayBuffer(len);
		const dv = new DataView(buffer);
		if (len === 1) dv.setUint8(0, value);
		else if (len === 2) dv.setUint16(0, value, !bigEndian);
		else if (len === 4) dv.setUint32(0, value, !bigEndian);
		return buffer;
	}
}

// ── R820T Tuner ───────────────────────────────────────────────────
class R820T {
	private com: RtlCom;
	private xtalFreq: number;
	private shadowRegs!: Uint8Array;
	private hasPllLock = false;

	constructor(com: RtlCom, xtalFreq: number) {
		this.com = com;
		this.xtalFreq = xtalFreq;
	}

	static async check(com: RtlCom): Promise<boolean> {
		const val = await com.readI2CReg(R820T_I2C_ADDR, 0);
		return val === R820T_CHECK_VAL;
	}

	async init(): Promise<void> {
		this.shadowRegs = new Uint8Array(R820T_INIT_REGS);
		for (let i = 0; i < R820T_INIT_REGS.length; i++) {
			await this.com.writeI2CReg(R820T_I2C_ADDR, i + 5, R820T_INIT_REGS[i]);
		}
		await this.initElectronics();
	}

	async setFrequency(freq: number): Promise<number> {
		await this.setMux(freq);
		return this.setPll(freq);
	}

	async setAutoGain(): Promise<void> {
		await this.writeEach([
			[0x05, 0x00, 0x10],
			[0x07, 0x10, 0x10],
			[0x0c, 0x0b, 0x9f],
		]);
	}

	async setManualGain(gain: number): Promise<void> {
		let step: number;
		if (gain <= 15) {
			step = Math.round(1.36 + gain * (1.1118 + gain * (-0.0786 + gain * 0.0027)));
		} else {
			step = Math.round(1.2068 + gain * (0.6875 + gain * (-0.01011 + gain * 0.0001587)));
		}
		step = Math.max(0, Math.min(30, step));
		const lnaValue = Math.floor(step / 2);
		const mixerValue = Math.floor((step - 1) / 2);
		await this.writeEach([
			[0x05, 0x10, 0x10],
			[0x07, 0x00, 0x10],
			[0x0c, 0x08, 0x9f],
			[0x05, lnaValue, 0x0f],
			[0x07, mixerValue, 0x0f],
		]);
	}

	async close(): Promise<void> {
		await this.writeEach([
			[0x06, 0xb1, 0xff], [0x05, 0xb3, 0xff], [0x07, 0x3a, 0xff],
			[0x08, 0x40, 0xff], [0x09, 0xc0, 0xff], [0x0a, 0x36, 0xff],
			[0x0c, 0x35, 0xff], [0x0f, 0x68, 0xff], [0x11, 0x03, 0xff],
			[0x17, 0xf4, 0xff], [0x19, 0x0c, 0xff],
		]);
	}

	private async initElectronics(): Promise<void> {
		await this.writeEach([
			[0x0c, 0x00, 0x0f],
			[0x13, 49, 0x3f],
			[0x1d, 0x00, 0x38],
		]);
		const filterCap = await this.calibrateFilter(true);
		await this.writeEach([
			[0x0a, 0x10 | filterCap, 0x1f],
			[0x0b, 0x6b, 0xef],
			[0x07, 0x00, 0x80],
			[0x06, 0x10, 0x30],
			[0x1e, 0x40, 0x60],
			[0x05, 0x00, 0x80],
			[0x1f, 0x00, 0x80],
			[0x0f, 0x00, 0x80],
			[0x19, 0x60, 0x60],
			[0x1d, 0xe5, 0xc7],
			[0x1c, 0x24, 0xf8],
			[0x0d, 0x53, 0xff],
			[0x0e, 0x75, 0xff],
			[0x05, 0x00, 0x60],
			[0x06, 0x00, 0x08],
			[0x11, 0x38, 0x08],
			[0x17, 0x30, 0x30],
			[0x0a, 0x40, 0x60],
			[0x1d, 0x00, 0x38],
			[0x1c, 0x00, 0x04],
			[0x06, 0x00, 0x40],
			[0x1a, 0x30, 0x30],
			[0x1d, 0x18, 0x38],
			[0x1c, 0x24, 0x04],
			[0x1e, 0x0d, 0x1f],
			[0x1a, 0x20, 0x30],
		]);
	}

	private async calibrateFilter(firstTry: boolean): Promise<number> {
		await this.writeEach([
			[0x0b, 0x6b, 0x60],
			[0x0f, 0x04, 0x04],
			[0x10, 0x00, 0x03],
		]);
		await this.setPll(56000000);
		if (!this.hasPllLock) throw new Error('PLL not locked during filter calibration');
		await this.writeEach([
			[0x0b, 0x10, 0x10],
			[0x0b, 0x00, 0x10],
			[0x0f, 0x00, 0x04],
		]);
		const data = await this.readRegBuffer(0x00, 5);
		let filterCap = data[4] & 0x0f;
		if (filterCap === 0x0f) filterCap = 0;
		if (filterCap !== 0 && firstTry) return this.calibrateFilter(false);
		return filterCap;
	}

	private async setMux(freq: number): Promise<void> {
		const freqMhz = freq / 1000000;
		let i: number;
		for (i = 0; i < MUX_CFGS.length - 1; i++) {
			if (freqMhz < MUX_CFGS[i + 1][0]) break;
		}
		const cfg = MUX_CFGS[i];
		await this.writeEach([
			[0x17, cfg[1], 0x08],
			[0x1a, cfg[2], 0xc3],
			[0x1b, cfg[3], 0xff],
			[0x10, 0x00, 0x0b],
			[0x08, 0x00, 0x3f],
			[0x09, 0x00, 0x3f],
		]);
	}

	private async setPll(freq: number): Promise<number> {
		const pllRef = Math.floor(this.xtalFreq);
		await this.writeEach([
			[0x10, 0x00, 0x10],
			[0x1a, 0x00, 0x0c],
			[0x12, 0x80, 0xe0],
		]);
		let divNum = Math.min(6, Math.floor(Math.log(1770000000 / freq) / Math.LN2));
		const mixDiv = 1 << (divNum + 1);
		const data = await this.readRegBuffer(0x00, 5);
		const vcoFineTune = (data[4] & 0x30) >> 4;
		if (vcoFineTune > 2) --divNum;
		else if (vcoFineTune < 2) ++divNum;
		await this.writeRegMask(0x10, divNum << 5, 0xe0);

		const vcoFreq = freq * mixDiv;
		const nint = Math.floor(vcoFreq / (2 * pllRef));
		const vcoFra = vcoFreq % (2 * pllRef);

		if (nint > 63) { this.hasPllLock = false; return 0; }

		const ni = Math.floor((nint - 13) / 4);
		const si = (nint - 13) % 4;
		await this.writeEach([
			[0x14, ni + (si << 6), 0xff],
			[0x12, vcoFra === 0 ? 0x08 : 0x00, 0x08],
		]);
		const sdm = Math.min(65535, Math.floor(32768 * vcoFra / pllRef));
		await this.writeEach([
			[0x16, sdm >> 8, 0xff],
			[0x15, sdm & 0xff, 0xff],
		]);
		await this.getPllLock(true);
		await this.writeRegMask(0x1a, 0x08, 0x08);
		return 2 * pllRef * (nint + sdm / 65536) / mixDiv;
	}

	private async getPllLock(firstTry: boolean): Promise<void> {
		const data = await this.readRegBuffer(0x00, 3);
		if (data[2] & 0x40) { this.hasPllLock = true; return; }
		if (firstTry) {
			await this.writeRegMask(0x12, 0x60, 0xe0);
			return this.getPllLock(false);
		}
		this.hasPllLock = false;
	}

	private async readRegBuffer(addr: number, length: number): Promise<Uint8Array> {
		const buf = await this.com.readI2CRegBuffer(R820T_I2C_ADDR, addr, length);
		const arr = new Uint8Array(buf);
		// R820T returns bit-reversed data
		for (let i = 0; i < arr.length; i++) {
			const b = arr[i];
			arr[i] = (BIT_REVS[b & 0xf] << 4) | BIT_REVS[b >> 4];
		}
		return arr;
	}

	private async writeRegMask(addr: number, value: number, mask: number): Promise<void> {
		const rc = this.shadowRegs[addr - 5];
		const val = (rc & ~mask) | (value & mask);
		this.shadowRegs[addr - 5] = val;
		await this.com.writeI2CReg(R820T_I2C_ADDR, addr, val);
	}

	private async writeEach(cmds: [number, number, number][]): Promise<void> {
		for (const [addr, value, mask] of cmds) {
			await this.writeRegMask(addr, value, mask);
		}
	}
}

// ── FC0012 Tuner ──────────────────────────────────────────────────
const FC0012_I2C_ADDR = 0xc6;
const FC0012_CHECK_VAL = 0xa1;

// Frequency band table from librtlsdr tuner_fc0012.c:
// [maxFreqMHz, multiplier, reg5 (RF_OUTDIV_A), reg6 (RF_OUTDIV_B)]
const FC0012_BANDS: [number, number, number, number][] = [
	[37.084, 96, 0x82, 0x00],
	[55.625, 64, 0x82, 0x02],
	[74.167, 48, 0x42, 0x00],
	[111.25, 32, 0x42, 0x02],
	[148.334, 24, 0x22, 0x00],
	[222.5, 16, 0x22, 0x02],
	[296.667, 12, 0x12, 0x00],
	[445, 8, 0x12, 0x02],
	[593.334, 6, 0x0a, 0x00],
	[Infinity, 4, 0x0a, 0x02],
];

class FC0012 {
	private com: RtlCom;
	private xtalFreq: number;

	constructor(com: RtlCom, xtalFreq: number) {
		this.com = com;
		this.xtalFreq = xtalFreq;
	}

	async init(): Promise<void> {
		// FC0012 initialization register table (from librtlsdr tuner_fc0012.c)
		const initRegs: [number, number][] = [
			[0x01, 0x05], // reg 1: RF_A
			[0x02, 0x10], // reg 2: RF_M
			[0x03, 0x00], // reg 3: RF_K high
			[0x04, 0x00], // reg 4: RF_K low
			[0x05, 0x0f], // reg 5: IF_M — set IF to 0
			[0x06, 0x00], // reg 6: control reg (LNA power, VCO speed, BW)
			[0x07, 0x20], // reg 7: bit5 = xtal 28.8MHz
			[0x08, 0xff], // reg 8: AGC clock divide by 256, gain 1/256, BW 1/8
			[0x09, 0x6e], // reg 9: disable loop-through, enable LO test buf
			[0x0a, 0xb8], // reg a: disable loop-through 2
			[0x0b, 0x82], // reg b: AGC
			[0x0c, 0xfe], // reg c: 0xfc | 0x02 for Realtek demod
			[0x0d, 0x02], // reg d: AGC/LNA force
			[0x0e, 0x00], // reg e: VCO calibration
			[0x0f, 0x00], // reg f
			[0x10, 0x00], // reg 10
			[0x11, 0x00], // reg 11
			[0x12, 0x1f], // reg 12: max gain
			[0x13, 0x08], // reg 13: LNA gain (mid value)
			[0x14, 0x00], // reg 14
			[0x15, 0x04], // reg 15: LNA compensation enabled
		];
		for (const [reg, val] of initRegs) {
			await this.com.writeI2CReg(FC0012_I2C_ADDR, reg, val);
		}
	}

	async setFrequency(freq: number): Promise<number> {
		const freqMhz = freq / 1e6;

		// Find the right band/multiplier/register values from librtlsdr table
		let multi = 4;
		let reg5val = 0x0a;
		let reg6val = 0x02;
		for (const [maxFreq, m, r5, r6] of FC0012_BANDS) {
			if (freqMhz < maxFreq) {
				multi = m;
				reg5val = r5;
				reg6val = r6;
				break;
			}
		}

		const f_vco = freq * multi;
		const xtal_freq_div_2 = this.xtalFreq / 2;

		// Calculate PLL divider: xdiv, then split into pm (coarse) and am (fine)
		// Match librtlsdr integer rounding: round up if remainder >= half
		let xdiv = Math.floor(f_vco / xtal_freq_div_2);
		if ((f_vco - xdiv * xtal_freq_div_2) >= (xtal_freq_div_2 / 2)) xdiv++;

		let pm = Math.floor(xdiv / 8);
		let am = xdiv - 8 * pm;

		// FC0012 requires am >= 2 for valid PLL lock
		if (am < 2) {
			am += 8;
			pm--;
		}

		// Clamp and validate
		if (pm > 31) {
			am = am + 8 * (pm - 31);
			pm = 31;
		}
		if (am > 15 || pm < 0x0b) {
			console.warn(`FC0012: no valid PLL combination for ${freq} Hz`);
		}

		// Fractional part (delta-sigma) — 15-bit resolution per librtlsdr
		const f_remainder = f_vco - Math.floor(f_vco / xtal_freq_div_2) * xtal_freq_div_2;
		let xin = Math.floor((f_remainder / 1000) * 32768 / (xtal_freq_div_2 / 1000));
		if (xin >= 16384) xin += 32768;
		xin = xin & 0xffff;

		// VCO speed selection
		let vcoSelect = 0;
		if (f_vco >= 3060000000) {
			reg6val |= 0x08;
			vcoSelect = 1;
		}

		// Fix clock out (bit 5)
		reg6val |= 0x20;

		// Write PLL registers 1-6
		await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x01, am);
		await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x02, pm);
		await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x03, (xin >> 8) & 0xff);
		await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x04, xin & 0xff);

		// Modified for Realtek demod: OR in 0x07 to reg5
		await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x05, reg5val | 0x07);

		// Build reg 6: band bits + VCO speed + clock out + bandwidth (6MHz = 0x80)
		let reg6 = reg6val | 0x80; // 6 MHz bandwidth
		await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x06, reg6);

		// VCO calibration
		await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x0e, 0x80);
		await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x0e, 0x00);

		// VCO re-calibration: read back and adjust if out of range
		await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x0e, 0x00);
		try {
			const vcoCal = await this.com.readI2CReg(FC0012_I2C_ADDR, 0x0e);
			const vcoTmp = vcoCal & 0x3f;
			if (vcoSelect) {
				if (vcoTmp > 0x3c) {
					reg6 &= ~0x08;
					await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x06, reg6);
					await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x0e, 0x80);
					await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x0e, 0x00);
				}
			} else {
				if (vcoTmp < 0x02) {
					reg6 |= 0x08;
					await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x06, reg6);
					await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x0e, 0x80);
					await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x0e, 0x00);
				}
			}
		} catch (_) {
			console.warn('FC0012: VCO calibration readback failed');
		}

		console.log(`FC0012: tuned to ${(freq / 1e6).toFixed(3)} MHz (multi=${multi}, pm=${pm}, am=${am}, xin=${xin}, vco=${(f_vco/1e6).toFixed(0)}MHz)`);
		return freq;
	}

	async setAutoGain(): Promise<void> {
		// Enable AGC, disable forced LNA gain
		await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x0d, 0x00);
	}

	async setManualGain(gain: number): Promise<void> {
		// FC0012 has 5 discrete LNA gain steps (from librtlsdr tuner_fc0012.c).
		// Input is slider value 0-50, map to nearest step:
		//   0-10: -9.9 dB (reg 0x02)
		//  11-20: -4.0 dB (reg 0x00)
		//  21-30:  7.1 dB (reg 0x08)
		//  31-40: 17.9 dB (reg 0x17)
		//  41-50: 19.2 dB (reg 0x10)
		let lnaBits: number;
		if (gain <= 10) lnaBits = 0x02;       // -9.9 dB
		else if (gain <= 20) lnaBits = 0x00;  // -4.0 dB
		else if (gain <= 30) lnaBits = 0x08;  //  7.1 dB
		else if (gain <= 40) lnaBits = 0x17;  // 17.9 dB
		else lnaBits = 0x10;                  // 19.2 dB

		// Read-modify-write register 0x13: preserve bits 5-7, set gain in bits 0-4
		// (matches librtlsdr fc0012_set_gain)
		const reg13 = await this.com.readI2CReg(FC0012_I2C_ADDR, 0x13);
		await this.com.writeI2CReg(FC0012_I2C_ADDR, 0x13, (reg13 & 0xe0) | lnaBits);
	}

	async close(): Promise<void> {
		// Power down the tuner — no specific shutdown needed for FC0012
	}
}

// ── E4000 Tuner ───────────────────────────────────────────────────
// Ported from tuner_e4k.c (Harald Welte / Sylvain Munaut / GPL-2.0)
const E4K_I2C_ADDR = 0xc8;
const E4K_CHECK_ADDR = 0x02;
const E4K_CHECK_VAL  = 0x40;

// E4000 register addresses (from tuner_e4k.h)
const E4K_REG_MASTER1    = 0x00;
const E4K_REG_CLK_INP    = 0x05;
const E4K_REG_REF_CLK    = 0x06;
const E4K_REG_CLKOUT_PWDN = 0x0a;
const E4K_REG_SYNTH1     = 0x0d;
const E4K_REG_SYNTH3     = 0x0f;
const E4K_REG_SYNTH4     = 0x10;
const E4K_REG_SYNTH5     = 0x11;
const E4K_REG_SYNTH7     = 0x13;
const E4K_REG_FILT1      = 0x29;
const E4K_REG_FILT2      = 0x2a;
const E4K_REG_FILT3      = 0x2b;
const E4K_REG_GAIN1      = 0x44;
const E4K_REG_GAIN2      = 0x45;
const E4K_REG_GAIN3      = 0x46;
const E4K_REG_GAIN4      = 0x47;
const E4K_REG_AGC1       = 0x4c;
const E4K_REG_AGC4       = 0x4f;
const E4K_REG_AGC5       = 0x50;
const E4K_REG_AGC6       = 0x51;
const E4K_REG_AGC7       = 0x53;
const E4K_REG_AGC8       = 0x54;
const E4K_REG_AGC11      = 0x57;
const E4K_REG_BIAS       = 0x7e;
const E4K_REG_DC1        = 0x70;
const E4K_REG_DC2        = 0x71;
const E4K_REG_DC3        = 0x72;
const E4K_REG_DC4        = 0x73;
const E4K_REG_DC5        = 0x74;
const E4K_REG_DCTIME1    = 0x75;
const E4K_REG_DCTIME2    = 0x76;

// Master1 bits
const E4K_MASTER1_RESET    = 0x01;
const E4K_MASTER1_NORM_STBY = 0x02;
const E4K_MASTER1_POR_DET  = 0x04;
// AGC bits
const E4K_AGC1_MOD_MASK                  = 0x0f;
const E4K_AGC_MOD_SERIAL                 = 0x00;
const E4K_AGC_MOD_IF_SERIAL_LNA_AUTON   = 0x0d;
const E4K_AGC7_MIX_GAIN_AUTO            = 0x01;
const E4K_AGC11_LNA_GAIN_ENH            = 0x01;
const E4K_FILT3_DISABLE                 = 0x04;
const E4K_DC5_RANGE_DET_EN              = 0x04;

// PLL constants
const E4K_PLL_Y    = 65536;
const E4K_FOSC_MIN = 16000000;
const E4K_FOSC_MAX = 30000000;
const E4K_FLO_MIN  = 50000000;   // OUT_OF_SPEC
const E4K_FLO_MAX  = 2200000000; // OUT_OF_SPEC
const E4K_FVCO_MIN = 2600000000;
const E4K_FVCO_MAX = 3900000000;

// PLL vars table: {maxFlo Hz, reg_synth7, mult}
const E4K_PLL_VARS: { freq: number; regSynth7: number; mult: number }[] = [
	{ freq:  72400000, regSynth7: (1 << 3) | 7, mult: 48 },
	{ freq:  81200000, regSynth7: (1 << 3) | 6, mult: 40 },
	{ freq: 108300000, regSynth7: (1 << 3) | 5, mult: 32 },
	{ freq: 162500000, regSynth7: (1 << 3) | 4, mult: 24 },
	{ freq: 216600000, regSynth7: (1 << 3) | 3, mult: 16 },
	{ freq: 325000000, regSynth7: (1 << 3) | 2, mult: 12 },
	{ freq: 350000000, regSynth7: (1 << 3) | 1, mult:  8 },
	{ freq: 432000000, regSynth7: (0 << 3) | 3, mult:  8 },
	{ freq: 667000000, regSynth7: (0 << 3) | 2, mult:  6 },
	{ freq: 1200000000, regSynth7: (0 << 3) | 1, mult: 4 },
];

// Band enum (matches the C enum e4k_band)
const E4K_BAND_VHF2 = 0;
const E4K_BAND_VHF3 = 1;
const E4K_BAND_UHF  = 2;
const E4K_BAND_L    = 3;

// RF filter center frequencies (Hz): UHF and L
const E4K_RF_FILT_UHF = [
	360e6, 380e6, 405e6, 425e6, 450e6, 475e6, 505e6, 540e6,
	575e6, 615e6, 670e6, 720e6, 760e6, 840e6, 890e6, 970e6,
];
const E4K_RF_FILT_L = [
	1300e6, 1320e6, 1360e6, 1410e6, 1445e6, 1460e6, 1490e6, 1530e6,
	1560e6, 1590e6, 1640e6, 1660e6, 1680e6, 1700e6, 1720e6, 1750e6,
];

// IF filter bandwidths (Hz)
const E4K_MIX_FILTER_BW = [
	27000000, 27000000, 27000000, 27000000,
	27000000, 27000000, 27000000, 27000000,
	4600000, 4200000, 3800000, 3400000,
	3300000, 2700000, 2300000, 1900000,
];
const E4K_IFRC_FILTER_BW = [
	21400000, 21000000, 17600000, 14700000,
	12400000, 10600000,  9000000,  7700000,
	 6400000,  5300000,  4400000,  3400000,
	 2600000,  1800000,  1200000,  1000000,
];
const E4K_IFCH_FILTER_BW = [
	5500000, 5300000, 5000000, 4800000, 4600000, 4400000, 4300000, 4100000,
	3900000, 3800000, 3700000, 3600000, 3400000, 3300000, 3200000, 3100000,
	3000000, 2950000, 2900000, 2800000, 2750000, 2700000, 2600000, 2550000,
	2500000, 2450000, 2400000, 2300000, 2280000, 2240000, 2200000, 2150000,
];

// LNA gain table: [gain_tenth_dB, register_value]
const E4K_LNA_GAIN: [number, number][] = [
	[-50, 0], [-25, 1], [0, 4], [25, 5], [50, 6], [75, 7],
	[100, 8], [125, 9], [150, 10], [175, 11], [200, 12], [250, 13], [300, 14],
];

function e4kClosestIdx(arr: number[], freq: number): number {
	let bestDelta = Infinity;
	let bestIdx = 0;
	for (let i = 0; i < arr.length; i++) {
		const d = Math.abs(arr[i] - freq);
		if (d < bestDelta) { bestDelta = d; bestIdx = i; }
	}
	return bestIdx;
}

class E4000 {
	private com: RtlCom;
	private fosc: number;
	private band = -1;

	constructor(com: RtlCom, fosc: number) {
		this.com = com;
		this.fosc = fosc;
	}

	/** Direct I2C register read for E4000 */
	private async regRead(reg: number): Promise<number> {
		return this.com.readI2CReg(E4K_I2C_ADDR, reg);
	}

	/** Direct I2C register write for E4000 */
	private async regWrite(reg: number, val: number): Promise<void> {
		return this.com.writeI2CReg(E4K_I2C_ADDR, reg, val);
	}

	/** Read-modify-write a masked register */
	private async regSetMask(reg: number, mask: number, val: number): Promise<void> {
		const cur = await this.regRead(reg);
		if ((cur & mask) === (val & mask)) return;
		await this.regWrite(reg, (cur & ~mask) | (val & mask));
	}

	async init(): Promise<void> {
		// Dummy read to wake up
		try { await this.regRead(0); } catch (_) { /* expected NACK */ }

		// Reset + clear POR indicator
		await this.regWrite(E4K_REG_MASTER1,
			E4K_MASTER1_RESET | E4K_MASTER1_NORM_STBY | E4K_MASTER1_POR_DET);

		// Configure clock
		await this.regWrite(E4K_REG_CLK_INP, 0x00);
		await this.regWrite(E4K_REG_REF_CLK, 0x00);
		await this.regWrite(E4K_REG_CLKOUT_PWDN, 0x96);

		// Magic init values (from tuner_e4k.c magic_init)
		await this.regWrite(0x7e, 0x01);
		await this.regWrite(0x7f, 0xfe);
		await this.regWrite(0x82, 0x00);
		await this.regWrite(0x86, 0x50);
		await this.regWrite(0x87, 0x20);
		await this.regWrite(0x88, 0x01);
		await this.regWrite(0x9f, 0x7f);
		await this.regWrite(0xa0, 0x07);

		// AGC setup
		await this.regWrite(E4K_REG_AGC4, 0x10); // High threshold
		await this.regWrite(E4K_REG_AGC5, 0x04); // Low threshold
		await this.regWrite(E4K_REG_AGC6, 0x1a); // LNA calib + loop rate

		// Manual AGC (LNA serial mode)
		await this.regSetMask(E4K_REG_AGC1, E4K_AGC1_MOD_MASK, E4K_AGC_MOD_SERIAL);
		// Mixer gain manual
		await this.regSetMask(E4K_REG_AGC7, E4K_AGC7_MIX_GAIN_AUTO, 0);

		// Switch to auto-gain
		await this.setAutoGain();

		// Moderate IF gain defaults
		await this.setIfGain(1, 6);
		await this.setIfGain(2, 0);
		await this.setIfGain(3, 0);
		await this.setIfGain(4, 0);
		await this.setIfGain(5, 9);
		await this.setIfGain(6, 9);

		// Set IF filters to narrowest useful settings
		await this.setIfFilterBw(0, 1900000);  // mixer: 1.9 MHz
		await this.setIfFilterBw(2, 1000000);  // IF RC: 1 MHz
		await this.setIfFilterBw(1, 2150000);  // IF channel: 2.15 MHz
		// Enable channel filter
		await this.regSetMask(E4K_REG_FILT3, E4K_FILT3_DISABLE, 0);

		// Disable time variant DC correction and LUT
		await this.regSetMask(E4K_REG_DC5, 0x03, 0);
		await this.regSetMask(E4K_REG_DCTIME1, 0x03, 0);
		await this.regSetMask(E4K_REG_DCTIME2, 0x03, 0);

		console.log(`[E4K] Initialized (fosc=${(this.fosc / 1e6).toFixed(3)} MHz)`);
	}

	async setFrequency(freq: number): Promise<number> {
		if (freq < E4K_FLO_MIN || freq > E4K_FLO_MAX) {
			console.warn(`[E4K] Frequency ${freq} Hz out of range`);
		}

		// Find PLL entry: first entry whose max freq > requested freq
		let rIdx = E4K_PLL_VARS[E4K_PLL_VARS.length - 1].regSynth7;
		let mult = E4K_PLL_VARS[E4K_PLL_VARS.length - 1].mult;
		for (const v of E4K_PLL_VARS) {
			if (freq < v.freq) {
				rIdx = v.regSynth7;
				mult = v.mult;
				break;
			}
		}

		const fosc = this.fosc;

		// Compute Fvco target
		// Use BigInt to avoid float precision loss at high freq * mult values
		const intendedFvco = freq * mult;

		// Integer Z: floor(Fvco / Fosc)
		const z = Math.floor(intendedFvco / fosc);
		if (z > 255) {
			console.error('[E4K] Z out of range:', z);
			return -1;
		}

		// Fractional X: (remainder * Y) / Fosc
		const remainder = intendedFvco - fosc * z;
		const x = Math.floor((remainder * E4K_PLL_Y) / fosc) & 0xffff;

		// Compute actual tuned frequency
		const fvco = fosc * z + (fosc * x) / E4K_PLL_Y;
		const flo = Math.round(fvco / mult);

		// Program PLL
		await this.regWrite(E4K_REG_SYNTH7, rIdx);          // R + 3phase/2phase
		await this.regWrite(E4K_REG_SYNTH3, z & 0xff);       // Z integer part
		await this.regWrite(E4K_REG_SYNTH4, x & 0xff);       // X low byte
		await this.regWrite(E4K_REG_SYNTH5, (x >> 8) & 0xff);// X high byte

		// Set band
		await this.setBand(flo);

		// Set RF filter
		await this.setRfFilter(flo);

		// Check PLL lock
		const synth1 = await this.regRead(E4K_REG_SYNTH1);
		if (!(synth1 & 0x01)) {
			console.warn(`[E4K] PLL not locked for ${(freq / 1e6).toFixed(3)} MHz (synth1=0x${synth1.toString(16)})`);
		}

		console.log(`[E4K] tuned: req=${(freq/1e6).toFixed(3)}MHz actual=${(flo/1e6).toFixed(3)}MHz z=${z} x=${x} mult=${mult}`);
		return flo;
	}

	private async setBand(flo: number): Promise<void> {
		let band: number;
		if (flo < 140e6)       band = E4K_BAND_VHF2;
		else if (flo < 350e6)  band = E4K_BAND_VHF3;
		else if (flo < 1135e6) band = E4K_BAND_UHF;
		else                   band = E4K_BAND_L;

		if (band === this.band) return;
		this.band = band;

		// Set bias
		const biasVal = (band === E4K_BAND_L) ? 0 : 3;
		await this.regWrite(E4K_REG_BIAS, biasVal);

		// Workaround: reset SYNTH1 band bits before writing to avoid 325-350 MHz gap
		await this.regSetMask(E4K_REG_SYNTH1, 0x06, 0);
		await this.regSetMask(E4K_REG_SYNTH1, 0x06, band << 1);
	}

	private async setRfFilter(flo: number): Promise<void> {
		let idx = 0;
		if (flo >= 350e6 && flo < 1135e6) {
			idx = e4kClosestIdx(E4K_RF_FILT_UHF, flo);
		} else if (flo >= 1135e6) {
			idx = e4kClosestIdx(E4K_RF_FILT_L, flo);
		}
		// VHF2/VHF3: idx=0 (no filter needed)
		await this.regSetMask(E4K_REG_FILT1, 0x0f, idx);
	}

	/** Set IF filter by index: 0=mixer, 1=IF channel, 2=IF RC */
	private async setIfFilterBw(filter: number, bw: number): Promise<void> {
		// Tables and field descriptors: {table, reg, shift, width}
		const filters = [
			{ table: E4K_MIX_FILTER_BW,  reg: E4K_REG_FILT2, shift: 4, width: 4 },
			{ table: E4K_IFCH_FILTER_BW, reg: E4K_REG_FILT3, shift: 0, width: 5 },
			{ table: E4K_IFRC_FILTER_BW, reg: E4K_REG_FILT2, shift: 0, width: 4 },
		];
		if (filter >= filters.length) return;
		const f = filters[filter];
		const idx = e4kClosestIdx(f.table, bw);
		const mask = ((1 << f.width) - 1) << f.shift;
		await this.regSetMask(f.reg, mask, idx << f.shift);
	}

	/** Set IF gain for stage 1–6 */
	private async setIfGain(stage: number, value: number): Promise<void> {
		// Stage gain fields: {reg, shift, width, gainTable}
		const IF1 = [-3, 6];
		const IF23 = [0, 3, 6, 9];
		const IF4 = [0, 1, 2, 2];
		const IF56 = [3, 6, 9, 12, 15, 15, 15, 15];
		const stageInfo = [
			null, // stage 0 unused
			{ reg: E4K_REG_GAIN3, shift: 0, width: 1, gains: IF1  },
			{ reg: E4K_REG_GAIN3, shift: 1, width: 2, gains: IF23 },
			{ reg: E4K_REG_GAIN3, shift: 3, width: 2, gains: IF23 },
			{ reg: E4K_REG_GAIN3, shift: 5, width: 2, gains: IF4  },
			{ reg: E4K_REG_GAIN4, shift: 0, width: 3, gains: IF56 },
			{ reg: E4K_REG_GAIN4, shift: 3, width: 3, gains: IF56 },
		];
		if (stage < 1 || stage > 6) return;
		const s = stageInfo[stage]!;
		const idx = s.gains.indexOf(value);
		if (idx < 0) return;
		const mask = ((1 << s.width) - 1) << s.shift;
		await this.regSetMask(s.reg, mask, idx << s.shift);
	}

	async setAutoGain(): Promise<void> {
		// LNA auto
		await this.regSetMask(E4K_REG_AGC1, E4K_AGC1_MOD_MASK, E4K_AGC_MOD_IF_SERIAL_LNA_AUTON);
		// Mixer gain auto
		await this.regSetMask(E4K_REG_AGC7, E4K_AGC7_MIX_GAIN_AUTO, 1);
		// Disable LNA gain enhancement
		await this.regSetMask(E4K_REG_AGC11, 0x07, 0);
	}

	async setManualGain(gain: number): Promise<void> {
		// Map 0-50 slider → closest LNA gain step (in units of 0.1 dB tenths)
		// gain=0 → auto, gain=1..50 → map to dB range 0..30
		const tenths = Math.round(gain * 6); // 50 → 300 tenths = 30 dB
		// Find closest LNA gain entry
		let bestRegVal = 0;
		let bestDelta = Infinity;
		for (const [lnaTenths, regVal] of E4K_LNA_GAIN) {
			const d = Math.abs(tenths - lnaTenths);
			if (d < bestDelta) { bestDelta = d; bestRegVal = regVal; }
		}
		// Set manual mode
		await this.regSetMask(E4K_REG_AGC1, E4K_AGC1_MOD_MASK, E4K_AGC_MOD_SERIAL);
		await this.regSetMask(E4K_REG_AGC7, E4K_AGC7_MIX_GAIN_AUTO, 0);
		// Write LNA gain register
		await this.regSetMask(E4K_REG_GAIN1, 0x0f, bestRegVal);
	}

	async close(): Promise<void> {
		// Standby mode
		await this.regSetMask(E4K_REG_MASTER1, E4K_MASTER1_NORM_STBY, 0);
	}
}

// ── Tuner interface ───────────────────────────────────────────────
interface TunerDriver {
	init(): Promise<void>;
	setFrequency(freq: number): Promise<number>;
	setAutoGain(): Promise<void>;
	setManualGain(gain: number): Promise<void>;
	close(): Promise<void>;
}

// ── RTL-SDR Device ────────────────────────────────────────────────
export class RtlSdrDevice implements SdrDevice {
	readonly deviceType = 'rtlsdr';
	readonly sampleRates = [
		250000, 1024000, 1536000, 1792000, 1920000,
		2048000, 2160000, 2400000, 2560000, 2880000, 3200000,
	];
	readonly sampleFormat = 'int8' as const;
	readonly gainControls: GainControl[] = [
		{ name: 'Tuner', min: 0, max: 50, step: 1, default: 20, type: 'slider' },
		{ name: 'Bias-T', min: 0, max: 1, step: 1, default: 0, type: 'checkbox' },
	];

	private dev!: USBDevice;
	private com!: RtlCom;
	private tuner!: TunerDriver;
	private tunerName = '';
	private hasIfFreq = true; // R820T uses IF offset, FC0012 does not
	private conjugateIq = false; // FC0012 (zero-IF) needs spectrum inversion to match R820T
	private rxRunning: Promise<void>[] | null = null;
	private rxCallback: ((data: ArrayBufferView) => void) | null = null;
	private ppm = 0;
	private usbLock: Promise<void> = Promise.resolve();

	async open(device: USBDevice): Promise<void> {
		this.dev = device;
		await device.open();
		await device.selectConfiguration(1);
		console.log('RTL-SDR: device opened');

		this.com = new RtlCom(device);

		// Match charliegerard's exact init order: USB block writes BEFORE claiming interface
		await this.com.writeReg(BLOCK.USB, REG.SYSCTL, 0x09, 1);
		await this.com.writeReg(BLOCK.USB, REG.EPA_MAXPKT, 0x0200, 2);
		await this.com.writeReg(BLOCK.USB, REG.EPA_CTL, 0x0210, 2);
		console.log('RTL-SDR: USB controller initialized');

		await device.claimInterface(0);
		console.log('RTL-SDR: interface claimed');

		// Initialize demodulator registers
		await this.com.writeReg(BLOCK.SYS, REG.DEMOD_CTL_1, 0x22, 1);
		await this.com.writeReg(BLOCK.SYS, REG.DEMOD_CTL, 0xe8, 1);
		console.log('RTL-SDR: demod control set');

		// Write demod register init sequence
		await this.com.writeDemodReg(1, 0x01, 0x14, 1);
		await this.com.writeDemodReg(1, 0x01, 0x10, 1);
		await this.com.writeDemodReg(1, 0x15, 0x00, 1);
		await this.com.writeDemodReg(1, 0x16, 0x00, 1);
		await this.com.writeDemodReg(1, 0x17, 0x00, 1);
		await this.com.writeDemodReg(1, 0x17, 0x00, 1);
		await this.com.writeDemodReg(1, 0x18, 0x00, 1);
		await this.com.writeDemodReg(1, 0x19, 0x00, 1);
		await this.com.writeDemodReg(1, 0x1a, 0x00, 1);
		await this.com.writeDemodReg(1, 0x1b, 0x00, 1);
		await this.com.writeDemodReg(1, 0x1c, 0xca, 1);
		await this.com.writeDemodReg(1, 0x1d, 0xdc, 1);
		await this.com.writeDemodReg(1, 0x1e, 0xd7, 1);
		await this.com.writeDemodReg(1, 0x1f, 0xd8, 1);
		await this.com.writeDemodReg(1, 0x20, 0xe0, 1);
		await this.com.writeDemodReg(1, 0x21, 0xf2, 1);
		await this.com.writeDemodReg(1, 0x22, 0x0e, 1);
		await this.com.writeDemodReg(1, 0x23, 0x35, 1);
		await this.com.writeDemodReg(1, 0x24, 0x06, 1);
		await this.com.writeDemodReg(1, 0x25, 0x50, 1);
		await this.com.writeDemodReg(1, 0x26, 0x9c, 1);
		await this.com.writeDemodReg(1, 0x27, 0x0d, 1);
		await this.com.writeDemodReg(1, 0x28, 0x71, 1);
		await this.com.writeDemodReg(1, 0x29, 0x11, 1);
		await this.com.writeDemodReg(1, 0x2a, 0x14, 1);
		await this.com.writeDemodReg(1, 0x2b, 0x71, 1);
		await this.com.writeDemodReg(1, 0x2c, 0x74, 1);
		await this.com.writeDemodReg(1, 0x2d, 0x19, 1);
		await this.com.writeDemodReg(1, 0x2e, 0x41, 1);
		await this.com.writeDemodReg(1, 0x2f, 0xa5, 1);
		await this.com.writeDemodReg(0, 0x19, 0x05, 1);
		await this.com.writeDemodReg(1, 0x93, 0xf0, 1);
		await this.com.writeDemodReg(1, 0x94, 0x0f, 1);
		await this.com.writeDemodReg(1, 0x11, 0x00, 1);
		await this.com.writeDemodReg(1, 0x04, 0x00, 1);
		await this.com.writeDemodReg(0, 0x61, 0x60, 1);
		await this.com.writeDemodReg(0, 0x06, 0x80, 1);
		await this.com.writeDemodReg(1, 0xb1, 0x1b, 1);
		await this.com.writeDemodReg(0, 0x0d, 0x83, 1);

		console.log('RTL-SDR: demod registers initialized');

		// Detect tuner chip by probing known I2C addresses
		const xtalFreq = Math.floor(XTAL_FREQ * (1 + this.ppm / 1000000));
		await this.com.openI2C();
		console.log('RTL-SDR: I2C opened, probing tuner addresses...');

		// Probe tuners in the same order as librtlsdr rtlsdr_open:
		// Phase 1: Probe tuners that don't need GPIO reset
		const PHASE1_PROBES: { name: string; addr: number; checkReg: number; expectVal: number; mask?: number }[] = [
			{ name: 'E4000', addr: 0xc8, checkReg: 0x02, expectVal: 0x40 },
			{ name: 'FC0013', addr: 0xc6, checkReg: 0x00, expectVal: 0xa3 },
			{ name: 'R820T/R820T2/R828D', addr: 0x34, checkReg: 0x00, expectVal: 0x69 },
			{ name: 'R828D', addr: 0x74, checkReg: 0x00, expectVal: 0x69 },
		];
		// Phase 2: After GPIO5 reset — FC2580 and FC0012
		const PHASE2_PROBES: { name: string; addr: number; checkReg: number; expectVal: number; mask?: number }[] = [
			{ name: 'FC2580', addr: 0xac, checkReg: 0x01, expectVal: 0x56, mask: 0x7f },
			{ name: 'FC0012', addr: 0xc6, checkReg: 0x00, expectVal: 0xa1 },
		];

		let detectedTuner: string | null = null;
		let detectedAddr = 0;

		const probeOne = async (probe: typeof PHASE1_PROBES[0]): Promise<boolean> => {
			try {
				await this.com.writeRegBuffer(BLOCK.I2C, probe.addr, new Uint8Array([probe.checkReg]).buffer);
				const val = await this.com.readReg(BLOCK.I2C, probe.addr, 1);
				// Bit-reverse for R820T family
				const decoded = (probe.addr === 0x34 || probe.addr === 0x74)
					? ((BIT_REVS[val & 0xf] << 4) | BIT_REVS[val >> 4])
					: val;
				const checkVal = probe.mask ? (decoded & probe.mask) : decoded;
				console.log(`RTL-SDR: probe ${probe.name} (0x${probe.addr.toString(16)}): got 0x${decoded.toString(16)}, expect 0x${probe.expectVal.toString(16)}`);
				if (checkVal === probe.expectVal) {
					detectedTuner = probe.name;
					detectedAddr = probe.addr;
					return true;
				}
			} catch (_) {
				console.log(`RTL-SDR: probe ${probe.name} (0x${probe.addr.toString(16)}): no response`);
			}
			return false;
		};

		// Phase 1: probe without GPIO reset
		for (const probe of PHASE1_PROBES) {
			if (await probeOne(probe)) break;
		}

		// Phase 2: GPIO5 reset then probe FC2580/FC0012
		if (!detectedTuner) {
			console.log('RTL-SDR: Phase 1 found nothing, resetting tuner via GPIO5...');
			await this.com.closeI2C();
			await this.setGpioOutput(5);
			await this.setGpioBit(5, true);
			await this.setGpioBit(5, false);
			await this.com.openI2C();

			for (const probe of PHASE2_PROBES) {
				if (await probeOne(probe)) break;
			}
		}

		if (!detectedTuner) {
			await this.com.closeI2C();
			throw new Error('RTL-SDR: No supported tuner chip found. Probed R820T, E4000, FC0012, FC0013, FC2580.');
		}

		this.tunerName = detectedTuner;
		console.log(`RTL-SDR: detected tuner: ${detectedTuner} at I2C 0x${detectedAddr.toString(16)}`);

		if (detectedAddr === 0x34) {
			// R820T/R820T2/R828D
			this.tuner = new R820T(this.com, xtalFreq);
			this.hasIfFreq = true;

			// Set IF frequency offset for R820T
			const multiplier = -1 * Math.floor(IF_FREQ * (1 << 22) / xtalFreq);
			await this.com.writeDemodReg(1, 0xb1, 0x1a, 1);
			await this.com.writeDemodReg(0, 0x08, 0x4d, 1);
			await this.com.writeDemodReg(1, 0x19, (multiplier >> 16) & 0x3f, 1);
			await this.com.writeDemodReg(1, 0x1a, (multiplier >> 8) & 0xff, 1);
			await this.com.writeDemodReg(1, 0x1b, multiplier & 0xff, 1);
			await this.com.writeDemodReg(1, 0x15, 0x01, 1);
		} else if (detectedAddr === 0xc6) {
			// FC0012 or FC0013
			this.tuner = new FC0012(this.com, xtalFreq);
			this.hasIfFreq = false;
			// FC0012 is zero-IF — no spectrum conjugation needed.
			// It produces non-inverted spectrum like HackRF.
			this.conjugateIq = false;

			// FC0012 requires GPIO6 as output for V-band/U-band filter selection
			await this.setGpioOutput(6);

			// FC0012 uses zero-IF: keep init baseline demod values.
			// Do NOT apply R820T-specific registers:
			//   0xb1=0x1a (low-IF mode) — FC0012 needs 0x1b (zero-IF + IQ compensation)
			//   0x08=0x4d (R820T ADC config) — not applicable to FC0012
			//   0x15=0x01 (spectrum inversion) — FC0012 needs 0x00 (no inversion)
			// The init baseline (0xb1=0x1b, 0x15=0x00) is correct for FC0012.
		} else if (detectedTuner === 'E4000') {
			// E4000 is a zero-IF tuner — same demod config as FC0012
			this.tuner = new E4000(this.com, xtalFreq);
			this.hasIfFreq = false;
			this.conjugateIq = false;
			// Zero-IF mode: use baseline demod values (0xb1=0x1b, 0x15=0x00)
		} else {
			await this.com.closeI2C();
			throw new Error(`RTL-SDR: Detected ${detectedTuner} tuner, but it is not yet supported.`);
		}

		await this.tuner.init();
		console.log(`RTL-SDR: ${detectedTuner} tuner initialized`);
		await this.tuner.setAutoGain();
		await this.com.closeI2C();
		console.log('RTL-SDR: device ready');
	}

	async close(): Promise<void> {
		await this.stopRx();
		try {
			await this.com.openI2C();
			await this.tuner.close();
			await this.com.closeI2C();
		} catch (_) { /* ignore */ }
		try {
			await (this.dev as any).releaseInterface(0);
		} catch (_) { /* ignore */ }
		try {
			await this.dev.close();
		} catch (_) { /* ignore */ }
	}

	async getInfo(): Promise<SdrDeviceInfo> {
		const name = this.tunerName ? `RTL-SDR (${this.tunerName})` : 'RTL-SDR';
		const serial = this.dev.serialNumber || undefined;
		return { name, serial };
	}

	/** Serialize USB operations to prevent concurrent control/bulk transfer conflicts. */
	private withUsbLock<T>(fn: () => Promise<T>): Promise<T> {
		const prev = this.usbLock;
		let resolve!: () => void;
		this.usbLock = new Promise<void>(r => { resolve = r; });
		return prev.then(fn).finally(resolve);
	}

	async setSampleRate(rate: number): Promise<void> {
		return this.withUsbLock(async () => {
			console.log('RTL-SDR: setSampleRate', rate);
			// Cancel any active bulk transfers before reconfiguring the demod.
			await this.pauseRx();
			const xtalFreq = Math.floor(XTAL_FREQ * (1 + this.ppm / 1000000));
			let ratio = Math.floor(xtalFreq * (1 << 22) / rate);
			ratio &= 0x0ffffffc;
			const ppmOffset = -1 * Math.floor(this.ppm * (1 << 24) / 1000000);
			await this.com.writeDemodReg(1, 0x9f, (ratio >> 24) & 0xff, 1);
			await this.com.writeDemodReg(1, 0xa0, (ratio >> 16) & 0xff, 1);
			await this.com.writeDemodReg(1, 0xa1, (ratio >> 8) & 0xff, 1);
			await this.com.writeDemodReg(1, 0xa2, ratio & 0xff, 1);
			await this.com.writeDemodReg(1, 0x3e, (ppmOffset >> 8) & 0x3f, 1);
			await this.com.writeDemodReg(1, 0x3f, ppmOffset & 0xff, 1);
			await this.com.writeDemodReg(1, 0x01, 0x14, 1);
			await this.com.writeDemodReg(1, 0x01, 0x10, 1);
			console.log('RTL-SDR: setSampleRate complete');
		});
	}

	async setFrequency(freqHz: number): Promise<void> {
		return this.withUsbLock(async () => {
			console.log('RTL-SDR: setFrequency', freqHz);
			await this.pauseRx();
			try {
				// FC0012 requires GPIO6 toggle for V-band (>300MHz) vs U-band filter
				if (this.tunerName.startsWith('FC0012')) {
					await this.setGpioBit(6, freqHz > 300000000);
				}
				await this.com.openI2C();
				const tuneFreq = this.hasIfFreq ? freqHz + IF_FREQ : freqHz;
				await this.tuner.setFrequency(tuneFreq);
				await this.com.closeI2C();
			} finally {
				this.resumeRx();
			}
		});
	}

	async setGain(name: string, value: number): Promise<void> {
		return this.withUsbLock(async () => {
			await this.pauseRx();
			try {
				if (name === 'Tuner') {
					await this.com.openI2C();
					if (value <= 0) {
						await this.tuner.setAutoGain();
					} else {
						await this.tuner.setManualGain(value);
					}
					await this.com.closeI2C();
				} else if (name === 'Bias-T') {
					await this.setBiasTee(!!value);
				}
			} finally {
				this.resumeRx();
			}
		});
	}

	/**
	 * Stop bulk transfer loops so control transfers can proceed.
	 * Sets rxRunning to null and waits for the loops to finish their
	 * current readBulk call naturally — no releaseInterface needed.
	 * At 2.88 Msps with 64K transfers, each loop drains in ~11ms.
	 */
	private async pauseRx(): Promise<void> {
		if (!this.rxRunning) return;
		const promises = this.rxRunning;
		this.rxRunning = null;
		// Wait for transfer loops to exit after their current readBulk completes.
		try {
			await Promise.race([
				Promise.allSettled(promises),
				new Promise<void>(r => setTimeout(r, 500)),
			]);
		} catch (_) { /* ignore */ }
	}

	/** Restart bulk transfer loops after pauseRx, without resetting the endpoint. */
	private resumeRx(): void {
		if (!this.rxCallback || this.rxRunning) return;
		this.launchBulkLoops(this.rxCallback);
	}

	private async setGpioOutput(gpioNum: number): Promise<void> {
		// RTL2832U SYS block GPIO registers (from librtlsdr enum sys_reg):
		//   GPO  = 0x3001 (output value)
		//   GPOE = 0x3003 (output enable)
		//   GPD  = 0x3004 (direction)
		const GPO = 0x3001;
		const GPOE = 0x3003;
		const GPD = 0x3004;
		const bit = 1 << gpioNum;
		// Match librtlsdr rtlsdr_set_gpio_output:
		// 1. Read direction, clear bit in output (set pin low initially)
		const gpdVal = await this.com.readReg(BLOCK.SYS, GPD, 1);
		await this.com.writeReg(BLOCK.SYS, GPO, gpdVal & ~bit, 1);
		// 2. Enable the pin as output via GPOE
		const gpoeVal = await this.com.readReg(BLOCK.SYS, GPOE, 1);
		await this.com.writeReg(BLOCK.SYS, GPOE, gpoeVal | bit, 1);
	}

	private async setGpioBit(gpioNum: number, on: boolean): Promise<void> {
		const GPO = 0x3001;
		const gpoVal = await this.com.readReg(BLOCK.SYS, GPO, 1);
		const bit = 1 << gpioNum;
		await this.com.writeReg(BLOCK.SYS, GPO, on ? (gpoVal | bit) : (gpoVal & ~bit), 1);
	}

	private async setBiasTee(enable: boolean): Promise<void> {
		await this.setGpioOutput(0);
		await this.setGpioBit(0, enable);
	}

	async startRx(callback: (data: ArrayBufferView) => void): Promise<void> {
		if (this.rxRunning) await this.stopRx();
		this.rxCallback = callback;

		// Reset USB buffer
		await this.com.writeReg(BLOCK.USB, REG.EPA_CTL, 0x0210, 2);
		await this.com.writeReg(BLOCK.USB, REG.EPA_CTL, 0x0000, 2);

		this.launchBulkLoops(callback);
	}

	private launchBulkLoops(callback: (data: ArrayBufferView) => void): void {
		console.log('RTL-SDR: startRx — bulk transfer loops starting');
		let rxCount = 0;
		const transfer = async (): Promise<void> => {
			await Promise.resolve();
			while (this.rxRunning) {
				try {
					const buf = await this.com.readBulk(TRANSFER_BUFFER_SIZE);
					rxCount++;
					if (rxCount <= 3) console.log(`RTL-SDR: bulk read #${rxCount}, ${buf.byteLength} bytes`);
					const uint8Data = new Uint8Array(buf);
					const int8Data = new Int8Array(uint8Data.length);
					if (this.conjugateIq) {
						for (let i = 0; i < uint8Data.length; i += 2) {
							int8Data[i] = uint8Data[i] - 128;
							int8Data[i + 1] = 128 - uint8Data[i + 1];
						}
					} else {
						for (let i = 0; i < uint8Data.length; i++) {
							int8Data[i] = uint8Data[i] - 128;
						}
					}
					callback(new Uint8Array(int8Data.buffer));
				} catch (e: unknown) {
					if (this.rxRunning) {
						const msg = e instanceof Error ? e.message : String(e);
						console.error('RTL-SDR: transfer error:', msg);
					}
					break;
				}
			}
		};
		this.rxRunning = Array.from({ length: 4 }, transfer);
	}

	async stopRx(): Promise<void> {
		if (this.rxRunning) {
			const promises = this.rxRunning;
			this.rxRunning = null;
			// Wait for transfer loops to exit (they check rxRunning after each
			// readBulk completes). Use a timeout to prevent deadlocks if the
			// USB stack stalls a pending transferIn.
			try {
				await Promise.race([
					Promise.allSettled(promises),
					new Promise<void>(r => setTimeout(r, 500)),
				]);
			} catch (_) { /* ignore */ }
		}
	}
}

// ── Register driver ───────────────────────────────────────────────
// Complete list of known RTL2832U-based device VID/PIDs (from librtlsdr)
const RTL_SDR_FILTERS: USBDeviceFilter[] = [
	// Realtek RTL2832U
	{ vendorId: 0x0bda, productId: 0x2832 },
	// Realtek RTL2832U OEM (RTL-SDR Blog, Nooelec, etc.)
	{ vendorId: 0x0bda, productId: 0x2838 },
	// DigitalNow Quad DVB-T PCI-E card
	{ vendorId: 0x0413, productId: 0x6680 },
	// Leadtek WinFast DTV Dongle mini D
	{ vendorId: 0x0413, productId: 0x6f0f },
	// Genius TVGo DVB-T03 USB dongle (Ver. B)
	{ vendorId: 0x0458, productId: 0x707f },
	// Terratec Cinergy T Stick Black (rev 1)
	{ vendorId: 0x0ccd, productId: 0x00a9 },
	// Terratec NOXON DAB/DAB+ USB dongle (rev 1)
	{ vendorId: 0x0ccd, productId: 0x00b3 },
	// Terratec Deutschlandradio DAB Stick
	{ vendorId: 0x0ccd, productId: 0x00b4 },
	// Terratec NOXON DAB Stick - Radio Energy
	{ vendorId: 0x0ccd, productId: 0x00b5 },
	// Terratec Media Broadcast DAB Stick
	{ vendorId: 0x0ccd, productId: 0x00b7 },
	// Terratec BR DAB Stick
	{ vendorId: 0x0ccd, productId: 0x00b8 },
	// Terratec WDR DAB Stick
	{ vendorId: 0x0ccd, productId: 0x00b9 },
	// Terratec MuellerVerlag DAB Stick
	{ vendorId: 0x0ccd, productId: 0x00c0 },
	// Terratec Fraunhofer DAB Stick
	{ vendorId: 0x0ccd, productId: 0x00c6 },
	// Terratec Cinergy T Stick RC (Rev.3)
	{ vendorId: 0x0ccd, productId: 0x00d3 },
	// Terratec T Stick PLUS
	{ vendorId: 0x0ccd, productId: 0x00d7 },
	// Terratec NOXON DAB/DAB+ USB dongle (rev 2)
	{ vendorId: 0x0ccd, productId: 0x00e0 },
	// PixelView PV-DT235U(RN)
	{ vendorId: 0x1554, productId: 0x5020 },
	// Astrometa DVB-T/DVB-T2
	{ vendorId: 0x15f4, productId: 0x0131 },
	// HanfTek DAB+FM+DVB-T
	{ vendorId: 0x15f4, productId: 0x0133 },
	// Compro Videomate U620F
	{ vendorId: 0x185b, productId: 0x0620 },
	// Compro Videomate U650F
	{ vendorId: 0x185b, productId: 0x0650 },
	// Compro Videomate U680F
	{ vendorId: 0x185b, productId: 0x0680 },
	// GIGABYTE GT-U7300
	{ vendorId: 0x1b80, productId: 0xd393 },
	// DIKOM USB-DVBT HD
	{ vendorId: 0x1b80, productId: 0xd394 },
	// Peak 102569AGPK
	{ vendorId: 0x1b80, productId: 0xd395 },
	// KWorld KW-UB450-T USB DVB-T Pico TV
	{ vendorId: 0x1b80, productId: 0xd397 },
	// Zaapa ZT-MINDVBZP
	{ vendorId: 0x1b80, productId: 0xd398 },
	// SVEON STV20 DVB-T USB & FM
	{ vendorId: 0x1b80, productId: 0xd39d },
	// Twintech UT-40
	{ vendorId: 0x1b80, productId: 0xd3a4 },
	// ASUS U3100MINI_PLUS_V2
	{ vendorId: 0x1b80, productId: 0xd3a8 },
	// SVEON STV27 DVB-T USB & FM
	{ vendorId: 0x1b80, productId: 0xd3af },
	// SVEON STV21 DVB-T USB & FM
	{ vendorId: 0x1b80, productId: 0xd3b0 },
	// Dexatek DK DVB-T Dongle (Logilink VG0002A)
	{ vendorId: 0x1d19, productId: 0x1101 },
	// Dexatek DK DVB-T Dongle (MSI DigiVox mini II V3.0)
	{ vendorId: 0x1d19, productId: 0x1102 },
	// Dexatek Technology Ltd. DK 5217 DVB-T Dongle
	{ vendorId: 0x1d19, productId: 0x1103 },
	// MSI DigiVox Micro HD
	{ vendorId: 0x1d19, productId: 0x1104 },
	// Sweex DVB-T USB
	{ vendorId: 0x1f4d, productId: 0xa803 },
	// GTek T803
	{ vendorId: 0x1f4d, productId: 0xb803 },
	// Lifeview LV5TDeluxe
	{ vendorId: 0x1f4d, productId: 0xc803 },
	// MyGica TD312
	{ vendorId: 0x1f4d, productId: 0xd286 },
	// PROlectrix DV107669
	{ vendorId: 0x1f4d, productId: 0xd803 },
];

registerDriver({
	type: 'rtlsdr',
	name: 'RTL-SDR',
	filters: RTL_SDR_FILTERS,
	create: () => new RtlSdrDevice(),
});
