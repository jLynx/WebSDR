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
const R828D_I2C_ADDR = 0x74;
const R820T_CHECK_VAL = 0x96;

// Initial register values for R8xx (registers 0x05–0x1f, 27 bytes).
// Matches R8xx.REGISTERS from jtarrio/webrtlsdr r8xx.ts.
const R820T_INIT_REGS = [
	// 0x05: loop-through off, LNA auto, LNA gain 3
	0b10000011,
	// 0x06: power det 1 on, power det 3 off, filter gain +3dB, LNA pwr 2
	0b00110010,
	// 0x07: mixer pwr on, mixer current normal, mixer auto, mixer gain 5
	0b01110101,
	// 0x08: mixer buf pwr on, mixer buf low current, image gain adj 0
	0b11000000,
	// 0x09: IF filter off, IF filter low current, image phase adj 0
	0b01000000,
	// 0x0a: channel filter on, filter pwr 2, filter bw fine 6
	0b11010110,
	// 0x0b: filter bw coarse 3, high pass corner 12
	0b01101100,
	// 0x0c: VGA pwr on, VGA gain pin, VGA gain 5.5dB
	0b11110101,
	// 0x0d: LNA agc thresh high 0.94V, low 0.64V
	0b01100011,
	// 0x0e: mixer agc thresh high 1.04V, low 0.84V
	0b01110101,
	// 0x0f: LDO 3.0V, clock output off, internal agc clock on
	0b01101000,
	// 0x10: PLL to mixer div 1:1, PLL div 1, xtal swing low, no cap
	0b01101100,
	// 0x11: PLL analog reg 2.0V
	0b10000011,
	// 0x12
	0b10000000,
	// 0x13
	0b00000000,
	// 0x14: NI2C = 15
	0b00001111,
	// 0x15: SDM_IN[16:9]
	0b00000000,
	// 0x16: SDM_IN[8:1]
	0b11000000,
	// 0x17: PLL digital reg 1.8V, open drain high-Z
	0b00110000,
	// 0x18
	0b01001000,
	// 0x19: RF filter pwr on, agc_pin=agc_in
	0b11001100,
	// 0x1a: tracking filter bypass, PLL auto-tune 128kHz, RF filter highest
	0b01100000,
	// 0x1b: highest corner LPNF/LPF
	0b00000000,
	// 0x1c: power det 3 TOP 5
	0b01010100,
	// 0x1d: power det 1 TOP 5, power det 2 TOP 6
	0b10101110,
	// 0x1e: filter extension enable, power det timing control 10
	0b01001010,
	// 0x1f
	0b11000000,
];

// Multiplexer configurations per frequency band.
// [startMHz, open_d (R0x17 bit3), rf_mux_ploy (R0x1a bits 7:6,1:0), tf_c (R0x1b)]
// Matches STD_MUX_CFGS from jtarrio/webrtlsdr r8xx.ts.
const MUX_CFGS: [number, number, number, number][] = [
	[0,   0b1000, 0b00000010, 0b11011111],
	[50,  0b1000, 0b00000010, 0b10111110],
	[55,  0b1000, 0b00000010, 0b10001011],
	[60,  0b1000, 0b00000010, 0b01111011],
	[65,  0b1000, 0b00000010, 0b01101001],
	[70,  0b1000, 0b00000010, 0b01011000],
	[75,  0b0000, 0b00000010, 0b01000100],
	[90,  0b0000, 0b00000010, 0b00110100],
	[110, 0b0000, 0b00000010, 0b00100100],
	[140, 0b0000, 0b00000010, 0b00010100],
	[180, 0b0000, 0b00000010, 0b00010011],
	[250, 0b0000, 0b00000010, 0b00010001],
	[280, 0b0000, 0b00000010, 0b00000000],
	[310, 0b0000, 0b01000001, 0b00000000],
	[588, 0b0000, 0b01000000, 0b00000000],
];

// Experimentally: LNA goes in 2.3dB steps, Mixer in 1.2dB steps.
// (matches setManualGain logic in jtarrio/webrtlsdr r8xx.ts)

// R820T gain tables — from librtlsdr tuner_r82xx.c
const R82XX_LNA_GAIN_STEPS = [0, 9, 13, 40, 38, 13, 31, 22, 26, 31, 26, 14, 19, 5, 35, 13];
const R82XX_MIXER_GAIN_STEPS = [0, 5, 10, 10, 19, 9, 10, 25, 17, 10, 8, 16, 13, 6, 3, -8];
// 29 discrete gain values (tenths of dB) — matches rtlsdr_get_tuner_gains()
const R82XX_GAINS = [
	0, 9, 14, 27, 37, 77, 87, 125, 144, 157,
	166, 197, 207, 229, 254, 280, 297, 328, 338, 364,
	372, 386, 402, 421, 434, 439, 445, 480, 496,
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

// R82xx tuner family: R820T, R820T2, R828D
// vcoPowerRef: 2 for R820T/R820T2, 1 for R828D (matches jtarrio/webrtlsdr)
class R820T {
	private com: RtlCom;
	private xtalFreq: number;
	private ifFreq: number; // IF frequency (3.57 MHz typical) — added to PLL freq
	private i2cAddr: number;
	private vcoPowerRef: number; // R820T=2, R828D=1
	private isR828D: boolean;
	private isBlogV4: boolean;
	private shadowRegs!: Uint8Array;
	private hasPllLock = false;
	private lastInput = -1; // R828D antenna input tracking
	private gpioCallback: ((gpio: number, on: boolean) => Promise<void>) | null;

	constructor(com: RtlCom, xtalFreq: number, i2cAddr = R820T_I2C_ADDR, isR828D = false, isBlogV4 = false, ifFreq = IF_FREQ, gpioCallback: ((gpio: number, on: boolean) => Promise<void>) | null = null) {
		this.com = com;
		this.xtalFreq = xtalFreq;
		this.ifFreq = ifFreq;
		this.i2cAddr = i2cAddr;
		this.isR828D = isR828D;
		this.isBlogV4 = isBlogV4;
		this.gpioCallback = gpioCallback;
		// R828D uses VCO power ref of 1; R820T/R820T2 uses 2
		this.vcoPowerRef = isR828D ? 1 : 2;
	}

	private i2cWrite(reg: number, val: number) {
		return this.com.writeI2CReg(this.i2cAddr, reg, val);
	}

	private i2cReadBuf(addr: number, len: number) {
		return this.com.readI2CRegBuffer(this.i2cAddr, addr, len);
	}

	async init(): Promise<void> {
		this.shadowRegs = new Uint8Array(R820T_INIT_REGS);
		for (let i = 0; i < R820T_INIT_REGS.length; i++) {
			await this.i2cWrite(i + 5, R820T_INIT_REGS[i]);
		}
		await this.initElectronics();
	}

	// setFrequency receives the raw user frequency.
	// The IF offset is added here before setting the PLL, matching
	// librtlsdr's lo_freq = upconvert_freq + priv->int_freq.
	async setFrequency(freq: number): Promise<number> {
		if (this.isBlogV4) {
			const upconvertFreq = freq <= 28800000 ? freq + 28800000 : freq;
			await this.setMux(upconvertFreq);

			const notchOff = (freq <= 2200000) || (freq >= 85000000 && freq <= 112000000) || (freq >= 172000000 && freq <= 242000000);
			await this.writeRegMask(0x17, notchOff ? 0x00 : 0x08, 0x08);

			const band = freq <= 28800000 ? 0 : (freq < 250000000 ? 1 : 2);
			if (band !== this.lastInput) {
				this.lastInput = band;
				await this.writeRegMask(0x06, band === 0 ? 0x08 : 0x00, 0x08); // cable2
				// GPIO 5 controls the upconverter bypass relay (matches librtlsdr)
				if (this.gpioCallback) await this.gpioCallback(5, band !== 0);
				await this.writeRegMask(0x05, band === 1 ? 0x40 : 0x00, 0x40); // cable1
				// air_in: active-low — clear for UHF (active), set for others (disabled)
				await this.writeRegMask(0x05, band === 2 ? 0x00 : 0x20, 0x20); // air_in
			}
			return await this.setPll(upconvertFreq + this.ifFreq);
		} else {
			const loFreq = freq + this.ifFreq;
			await this.setMux(freq);
			const result = await this.setPll(loFreq);
			// R828D: switch Cable1 LNA on/off at 345 MHz threshold
			if (this.isR828D) {
				const input = freq > 345000000 ? 0x00 : 0x60;
				if (input !== this.lastInput) {
					this.lastInput = input;
					await this.writeRegMask(0x05, input, 0x60);
				}
			}
			return result;
		}
	}

	async setAutoGain(): Promise<void> {
		// [4] lna gain auto
		await this.writeRegMask(0x05, 0b00000000, 0b00010000);
		// [4] mixer gain auto
		await this.writeRegMask(0x07, 0b00010000, 0b00010000);
		
		if (this.isBlogV4) {
			// VGA auto control does not work well on V4 (spectrum pumping). Fix to 0x08.
			await this.writeRegMask(0x0c, 0x08, 0x9f);
		} else {
			// [4] IF vga mode manual [3:0] IF vga gain 26.5dB
			await this.writeRegMask(0x0c, 0b00001011, 0b10011111);
		}
	}

	getGains(): number[] {
		return R82XX_GAINS;
	}

	async setManualGain(gainIdx: number): Promise<void> {
		// Slider value is an index into R82XX_GAINS (0-28).
		// Look up the target gain in tenths of dB, then use the
		// librtlsdr r82xx_set_gain algorithm to find LNA/mixer indices.
		const gainTenths = R82XX_GAINS[Math.min(gainIdx, R82XX_GAINS.length - 1)] ?? 0;
		let lnaIndex = 0;
		let mixIndex = 0;
		let totalGain = 0;
		for (let i = 0; i < 15; i++) {
			if (totalGain >= gainTenths) break;
			totalGain += R82XX_LNA_GAIN_STEPS[++lnaIndex];
			if (totalGain >= gainTenths) break;
			totalGain += R82XX_MIXER_GAIN_STEPS[++mixIndex];
		}
		// [4] LNA gain manual
		await this.writeRegMask(0x05, 0x10, 0x10);
		// [4] mixer gain manual
		await this.writeRegMask(0x07, 0x00, 0x10);
		// Read tuner status — librtlsdr reads 4 bytes from reg 0x00
		// between mode switch and VGA set to let the tuner latch
		await this.readRegBuffer(0x00, 4);
		// [4] VGA mode manual [3:0] VGA gain 16.3dB
		await this.writeRegMask(0x0c, 0x08, 0x9f);
		// [3:0] LNA gain index
		await this.writeRegMask(0x05, lnaIndex, 0x0f);
		// [3:0] mixer gain index
		await this.writeRegMask(0x07, mixIndex, 0x0f);
	}

	async close(): Promise<void> {
		// Matches R8xx.close() from jtarrio/webrtlsdr
		// [7] power det 1 off [6] power det 3 off [5] filter gain [2:0] LNA pwr 1
		await this.writeRegMask(0x06, 0b10110001, 0xff);
		// [7] loop through off [5] lna 1 pwr off [4] LNA gain manual [3:0] LNA gain 3
		await this.writeRegMask(0x05, 0b10110011, 0xff);
		// [6] mixer pwr off [5] mixer normal current [4] mixer gain auto [3:0] mixer gain 10
		await this.writeRegMask(0x07, 0b00111010, 0xff);
		// [7] mixer buf pwr off [6] mixer buf low current [5:0] image gain 0
		await this.writeRegMask(0x08, 0b01000000, 0xff);
		// [7] IF filter off [6] IF filter low current [5:0] image phase 0
		await this.writeRegMask(0x09, 0b11000000, 0xff);
		// [7] channel filter off [6:5] filter pwr 1 [3:0] filter bw 6
		await this.writeRegMask(0x0a, 0b00111010, 0xff);
		// [6] vga pwr off [4] vga controlled by pin [3:0] vga gain 5
		await this.writeRegMask(0x0c, 0b00110101, 0xff);
		// [4] clock output on [1] internal agc clock on
		await this.writeRegMask(0x0f, 0b01101000, 0xff);
		// [7:6] pll analog reg off
		await this.writeRegMask(0x11, 0b00000011, 0xff);
		// [7:6] pll digital reg off [3] open drain high-Z
		await this.writeRegMask(0x17, 0b11110100, 0xff);
		// [7] rf filter pwr off [4] agc pin = agc_in
		await this.writeRegMask(0x19, 0b00001100, 0xff);
	}

	private async initElectronics(): Promise<void> {
		// Matches R8xx._initElectronics() from jtarrio/webrtlsdr
		// [3:0] IF vga -12dB
		await this.writeRegMask(0x0c, 0b00000000, 0b00001111);
		// [5:0] VCO bank 49
		await this.writeRegMask(0x13, 0b00110001, 0b00111111);
		// [5:3] power detector 1 TOP 0
		await this.writeRegMask(0x1d, 0b00000000, 0b00111000);
		const filterCap = await this.calibrateFilter();
		// [4] channel filter high Q [3:0] filter bw manual fine tune
		await this.writeRegMask(0x0a, 0b00010000 | filterCap, 0b00011111);
		// [7:5] filter bw coarse 3 [3:0] high pass corner 11
		await this.writeRegMask(0x0b, 0b01101011, 0b11101111);
		// [7] mixer sideband lower
		await this.writeRegMask(0x07, 0b00000000, 0b10000000);
		// [5] filter gain 0dB [4] mixer filter 6MHz on
		await this.writeRegMask(0x06, 0b00010000, 0b00110000);
		// [6] filter extension enable [5] channel filter extension @ LNA max
		await this.writeRegMask(0x1e, 0b01000000, 0b01100000);
		// [7] loop through on
		await this.writeRegMask(0x05, 0b00000000, 0b10000000);
		// [7] loop through attenuation enable
		await this.writeRegMask(0x1f, 0b00000000, 0b10000000);
		// [7] filter extension widest off
		await this.writeRegMask(0x0f, 0b00000000, 0b10000000);
		// [6:5] RF poly filter current min
		await this.writeRegMask(0x19, 0b01100000, 0b01100000);
		// [7:6] LNA narrow band pwr det lowest BW [2:0] pwr det 2 TOP 5
		await this.writeRegMask(0x1d, 0b11100101, 0b11000111);
		// [7:4] pwr det 3 TOP 4
		await this.writeRegMask(0x1c, 0b00100100, 0b11111000);
		// [7:4] LNA agc pwr det threshold high 0.84V [3:0] low 0.64V
		await this.writeRegMask(0x0d, 0b01010011, 0b11111111);
		// [7:4] mixer agc pwr det threshold high 1.04V [3:0] low 0.84V
		await this.writeRegMask(0x0e, 0b01110101, 0b11111111);
		// [6] cable 1 LNA off [5] LNA 1 pwr on
		await this.writeRegMask(0x05, 0b00000000, 0b01100000);
		// [3] cable 2 LNA off
		await this.writeRegMask(0x06, 0b00000000, 0b00001000);
		// [3] prescale
		await this.writeRegMask(0x11, 0b00111000, 0b00001000);
		// [5:4] prescale 45 current 150u
		await this.writeRegMask(0x17, 0b00110000, 0b00110000);
		// [6:5] filter pwr 2
		await this.writeRegMask(0x0a, 0b01000000, 0b01100000);
		// [5:3] pwr det 1 TOP 0
		await this.writeRegMask(0x1d, 0b00000000, 0b00111000);
		// [2] LNA pwr det mode normal
		await this.writeRegMask(0x1c, 0b00000000, 0b00000100);
		// [6] LNA pwr det narrow band off
		await this.writeRegMask(0x06, 0b00000000, 0b01000000);
		// [5:4] AGC clock 20ms
		await this.writeRegMask(0x1a, 0b00110000, 0b00110000);
		// [5:3] pwr det 1 TOP 3
		await this.writeRegMask(0x1d, 0b00011000, 0b00111000);
		// [2] LNA pwr det 1 low discharge
		await this.writeRegMask(0x1c, 0b00100100, 0b00000100);
		// [4:0] LNA discharge current 13
		await this.writeRegMask(0x1e, 0b00001101, 0b00011111);
		// [5:4] AGC clock 80ms
		await this.writeRegMask(0x1a, 0b00100000, 0b00110000);
	}

	private async calibrateFilter(): Promise<number> {
		let firstTry = true;
		while (true) {
			// [6:5] filter bw manual coarse narrowest
			await this.writeRegMask(0x0b, 0b01100000, 0b01100000);
			// [2] channel filter calibration clock on
			await this.writeRegMask(0x0f, 0b00000100, 0b00000100);
			// [1:0] xtal cap setting -> no cap
			await this.writeRegMask(0x10, 0b00000000, 0b00000011);
			await this.setPll(56000000);
			if (!this.hasPllLock) throw new Error('R82xx: PLL not locked during filter calibration');
			// [4] channel filter calibration start
			await this.writeRegMask(0x0b, 0b00010000, 0b00010000);
			// [4] channel filter calibration reset
			await this.writeRegMask(0x0b, 0b00000000, 0b00010000);
			// [2] channel filter calibration clock off
			await this.writeRegMask(0x0f, 0b00000000, 0b00000100);
			const data = await this.readRegBuffer(0x00, 5);
			// [3:0] filter calibration code
			let filterCap = data[4] & 0b00001111;
			if (filterCap === 0b00001111) filterCap = 0;
			if (filterCap === 0 || !firstTry) return filterCap;
			firstTry = false;
		}
	}

	private async setMux(freq: number): Promise<void> {
		const freqMhz = freq / 1000000;
		let i: number;
		for (i = 0; i < MUX_CFGS.length - 1; i++) {
			if (freqMhz < MUX_CFGS[i + 1][0]) break;
		}
		const cfg = MUX_CFGS[i];
		// [3] open drain
		await this.writeRegMask(0x17, cfg[1], 0b00001000);
		// [7:6] tracking filter [1:0] RF filter
		await this.writeRegMask(0x1a, cfg[2], 0b11000011);
		// [7:4] LPNF [3:0] LPF
		await this.writeRegMask(0x1b, cfg[3], 0b11111111);
		// [3] xtal swing high [1:0] xtal setting no cap
		await this.writeRegMask(0x10, 0b00000000, 0b00001011);
		// [5:0] image gain 0
		await this.writeRegMask(0x08, 0b00000000, 0b00111111);
		// [5:0] image phase 0
		await this.writeRegMask(0x09, 0b00000000, 0b00111111);
	}

	private async setPll(freq: number): Promise<number> {
		const pllRef = Math.floor(this.xtalFreq);
		// [4] PLL reference divider 1:1
		await this.writeRegMask(0x10, 0b00000000, 0b00010000);
		// [3:2] PLL auto tune clock rate 128 kHz
		await this.writeRegMask(0x1a, 0b00000000, 0b00001100);
		// [7:5] VCO core power 4 (mid)
		await this.writeRegMask(0x12, 0b10000000, 0b11100000);
		let divNum = Math.min(6, Math.floor(Math.log(1770000000 / freq) / Math.LN2));
		const mixDiv = 1 << (divNum + 1);
		const data = await this.readRegBuffer(0x00, 5);
		// [5:4] VCO fine tune — compare against vcoPowerRef (2 for R820T, 1 for R828D)
		const vcoFineTune = (data[4] & 0x30) >> 4;
		if (vcoFineTune > this.vcoPowerRef) --divNum;
		else if (vcoFineTune < this.vcoPowerRef) ++divNum;
		// [7:5] pll to mixer divider
		await this.writeRegMask(0x10, divNum << 5, 0b11100000);

		const vcoFreq = freq * mixDiv;
		const nint = Math.floor(vcoFreq / (2 * pllRef));
		const vcoFra = vcoFreq % (2 * pllRef);

		if (nint > (128 / this.vcoPowerRef) - 1) { this.hasPllLock = false; return 0; }

		const ni = Math.floor((nint - 13) / 4);
		const si = (nint - 13) % 4;
		// [7:6] si2c [5:0] ni2c
		await this.writeRegMask(0x14, ni + (si << 6), 0xff);
		// [4] sigma delta dither (0 on)
		await this.writeRegMask(0x12, vcoFra === 0 ? 0b1000 : 0b0000, 0b00001000);
		const sdm = Math.min(65535, Math.floor(32768 * vcoFra / pllRef));
		// SDM high
		await this.writeRegMask(0x16, sdm >> 8, 0xff);
		// SDM low
		await this.writeRegMask(0x15, sdm & 0xff, 0xff);
		await this.getPllLock();
		// [3] PLL auto tune clock rate 8 kHz
		await this.writeRegMask(0x1a, 0b00001000, 0b00001000);
		return 2 * pllRef * (nint + sdm / 65536) / mixDiv;
	}

	private async getPllLock(): Promise<void> {
		let firstTry = true;
		while (true) {
			const data = await this.readRegBuffer(0x00, 3);
			// [6] pll lock?
			if (data[2] & 0b01000000) {
				this.hasPllLock = true;
				return;
			}
			if (!firstTry) {
				// Accept after second attempt regardless (matches reference behavior)
				this.hasPllLock = true;
				return;
			}
			// [7:5] VCO core power 3
			await this.writeRegMask(0x12, 0b01100000, 0b11100000);
			firstTry = false;
		}
	}

	private async readRegBuffer(addr: number, length: number): Promise<Uint8Array> {
		const buf = await this.i2cReadBuf(addr, length);
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
		await this.i2cWrite(addr, val);
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

const FC0012_GAINS = [-99, -40, 71, 179, 192];
const FC0012_GAIN_REGS = [0x02, 0x00, 0x08, 0x17, 0x10];

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

	getGains(): number[] {
		return FC0012_GAINS;
	}

	async setManualGain(gainIdx: number): Promise<void> {
		// FC0012 has 5 discrete LNA gain steps (from librtlsdr tuner_fc0012.c).
		// We expect gainIdx precisely from 0 to 4.
		const index = Math.max(0, Math.min(gainIdx, FC0012_GAIN_REGS.length - 1));
		const lnaBits = FC0012_GAIN_REGS[index];

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

	getGains(): number[] {
		return E4K_LNA_GAIN.map(g => g[0]);
	}

	async setManualGain(gainIdx: number): Promise<void> {
		// Receive slider index
		const index = Math.max(0, Math.min(gainIdx, E4K_LNA_GAIN.length - 1));
		const bestRegVal = E4K_LNA_GAIN[index][1];

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

// ── FC0013 Tuner ─────────────────────────────────────────────────
// Very similar to FC0012 but different init regs, VHF tracking, and gain table.
// Source: tuner_fc0013.c (Hans-Frieder Vogt / Steve Markgraf / GPL-2.0)
const FC0013_I2C_ADDR = 0xc6;

const FC0013_BANDS: [number, number, number, number][] = [
	[37084000,  96, 0x82, 0x00],
	[55625000,  64, 0x02, 0x02],
	[74167000,  48, 0x42, 0x00],
	[111250000, 32, 0x82, 0x02],
	[148334000, 24, 0x22, 0x00],
	[222500000, 16, 0x42, 0x02],
	[296667000, 12, 0x12, 0x00],
	[445000000,  8, 0x22, 0x02],
	[593334000,  6, 0x0a, 0x00],
	[950000000,  4, 0x12, 0x02],
	[Infinity,   2, 0x0a, 0x02],
];

// [gain_tenth_dB, register_value] — from fc0013_lna_gains[]
const FC0013_LNA_GAINS: [number, number][] = [
	[-99, 0x02], [-73, 0x03], [-65, 0x05], [-63, 0x04], [-63, 0x00], [-60, 0x07],
	[-58, 0x01], [-54, 0x06], [58, 0x0f], [61, 0x0e], [63, 0x0d], [65, 0x0c],
	[67, 0x0b], [68, 0x0a], [70, 0x09], [71, 0x08],
	[179, 0x17], [181, 0x16], [182, 0x15], [184, 0x14],
	[186, 0x13], [188, 0x12], [191, 0x11], [197, 0x10],
];

class FC0013 {
	private com: RtlCom;
	private xtalFreq: number;

	constructor(com: RtlCom, xtalFreq: number) {
		this.com = com;
		this.xtalFreq = xtalFreq;
	}

	async init(): Promise<void> {
		// Init register table from tuner_fc0013.c fc0013_init()
		const initRegs: [number, number][] = [
			[0x01, 0x09], [0x02, 0x16], [0x03, 0x00], [0x04, 0x00],
			[0x05, 0x17], [0x06, 0x02], [0x07, 0x2a], // 0x0a|0x20 for 28.8MHz xtal
			[0x08, 0xff], [0x09, 0x6e], [0x0a, 0xb8], [0x0b, 0x82],
			[0x0c, 0xfe], [0x0d, 0x01], [0x0e, 0x00], [0x0f, 0x00],
			[0x10, 0x00], [0x11, 0x00], [0x12, 0x00], [0x13, 0x00],
			[0x14, 0x50], [0x15, 0x01],
		];
		for (const [reg, val] of initRegs) {
			await this.com.writeI2CReg(FC0013_I2C_ADDR, reg, val);
		}
	}

	async setFrequency(freq: number): Promise<number> {
		const freqMhz = freq / 1e6;

		// VHF tracking filter
		await this.setVhfTrack(freq);

		// Band / VHF-UHF-GPS filter selection
		const reg07 = await this.com.readI2CReg(FC0013_I2C_ADDR, 0x07);
		const reg14 = await this.com.readI2CReg(FC0013_I2C_ADDR, 0x14);
		if (freq < 300000000) {
			// VHF: enable VHF filter, disable UHF+GPS
			await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x07, reg07 | 0x10);
			await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x14, reg14 & 0x1f);
		} else if (freq <= 862000000) {
			// UHF
			await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x07, reg07 & 0xef);
			await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x14, (reg14 & 0x1f) | 0x40);
		} else {
			// GPS
			await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x07, reg07 & 0xef);
			await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x14, (reg14 & 0x1f) | 0x20);
		}

		// Find multiplier and band regs
		let multi = 2, reg5val = 0x0a, reg6val = 0x02;
		for (const [maxFreq, m, r5, r6] of FC0013_BANDS) {
			if (freq < maxFreq) { multi = m; reg5val = r5; reg6val = r6; break; }
		}

		const xdiv2 = this.xtalFreq / 2;
		const fvco = freq * multi;

		let xdiv = Math.floor(fvco / xdiv2);
		if ((fvco - xdiv * xdiv2) >= (xdiv2 / 2)) xdiv++;

		let pm = Math.floor(xdiv / 8);
		let am = xdiv - 8 * pm;
		if (am < 2) { am += 8; pm--; }
		if (pm > 31) { am = am + 8 * (pm - 31); pm = 31; }
		if (am > 15 || pm < 0x0b) {
			console.warn(`FC0013: no valid PLL for ${(freq/1e6).toFixed(3)} MHz`);
		}

		// VCO high select
		if (fvco >= 3060000000) reg6val |= 0x08;
		// Clock out fix
		reg6val |= 0x20;

		// Fractional XIN
		const fRem = fvco - Math.floor(fvco / xdiv2) * xdiv2;
		let xin = Math.floor((fRem / 1000) * 32768 / (xdiv2 / 1000));
		if (xin >= 16384) xin += 32768;
		xin &= 0xffff;

		// Write PLL regs 1-6
		await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x01, am);
		await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x02, pm);
		await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x03, (xin >> 8) & 0xff);
		await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x04, xin & 0xff);
		await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x05, reg5val | 0x07); // Realtek demod fix
		await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x06, reg6val | 0x80); // 8 MHz BW

		// multi=64 requires extra bit in reg 0x11
		const reg11 = await this.com.readI2CReg(FC0013_I2C_ADDR, 0x11);
		await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x11,
			multi === 64 ? (reg11 | 0x04) : (reg11 & 0xfb));

		// VCO calibration
		await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x0e, 0x80);
		await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x0e, 0x00);
		await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x0e, 0x00);

		// VCO re-calibration if out of range
		try {
			const vcoCal = await this.com.readI2CReg(FC0013_I2C_ADDR, 0x0e);
			const vcoTmp = vcoCal & 0x3f;
			const highVco = fvco >= 3060000000;
			if (highVco ? vcoTmp > 0x3c : vcoTmp < 0x02) {
				const newReg6 = highVco ? (reg6val & ~0x08) : (reg6val | 0x08);
				await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x06, newReg6 | 0x80);
				await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x0e, 0x80);
				await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x0e, 0x00);
			}
		} catch (_) {
			console.warn('FC0013: VCO calibration readback failed');
		}

		console.log(`FC0013: tuned to ${freqMhz.toFixed(3)} MHz (multi=${multi}, pm=${pm}, am=${am})`);
		return freq;
	}

	private async setVhfTrack(freq: number): Promise<void> {
		const cur = await this.com.readI2CReg(FC0013_I2C_ADDR, 0x1d);
		const base = cur & 0xe3;
		let bits: number;
		if      (freq <= 177500000) bits = 0x1c; // track 7
		else if (freq <= 184500000) bits = 0x18; // track 6
		else if (freq <= 191500000) bits = 0x14; // track 5
		else if (freq <= 198500000) bits = 0x10; // track 4
		else if (freq <= 205500000) bits = 0x0c; // track 3
		else if (freq <= 219500000) bits = 0x08; // track 2
		else if (freq <  300000000) bits = 0x04; // track 1
		else                        bits = 0x1c; // UHF/GPS
		await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x1d, base | bits);
	}

	async setAutoGain(): Promise<void> {
		const cur = await this.com.readI2CReg(FC0013_I2C_ADDR, 0x0d);
		await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x0d, cur & ~0x08);
		await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x13, 0x0a); // fixed IF gain
	}

	getGains(): number[] {
		return FC0013_LNA_GAINS.map(g => g[0]);
	}

	async setManualGain(gainIdx: number): Promise<void> {
		// Receive slider index
		const index = Math.max(0, Math.min(gainIdx, FC0013_LNA_GAINS.length - 1));
		const bestReg = FC0013_LNA_GAINS[index][1];

		// Enable manual gain mode
		const cur = await this.com.readI2CReg(FC0013_I2C_ADDR, 0x0d);
		await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x0d, cur | 0x08);
		await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x13, 0x0a); // fixed IF gain
		// Write LNA gain bits into reg 0x14[4:0]
		const reg14 = await this.com.readI2CReg(FC0013_I2C_ADDR, 0x14);
		await this.com.writeI2CReg(FC0013_I2C_ADDR, 0x14, (reg14 & 0xe0) | bestReg);
	}

	async close(): Promise<void> {
		// No specific shutdown for FC0013
	}
}

// ── FC2580 Tuner ──────────────────────────────────────────────────
// Source: tuner_fc2580.c (FCI / Terratec / GPL-2.0)
const FC2580_I2C_ADDR = 0xac;
const FC2580_CRYSTAL_KHZ = 16384; // 16.384 MHz internal crystal
const FC2580_BORDER_FREQ = 2600000; // kHz — VCO band boundary

class FC2580 {
	private com: RtlCom;

	constructor(com: RtlCom) {
		this.com = com;
	}

	private async wr(reg: number, val: number): Promise<void> {
		await this.com.writeI2CReg(FC2580_I2C_ADDR, reg, val);
	}

	private async rd(reg: number): Promise<number> {
		return this.com.readI2CReg(FC2580_I2C_ADDR, reg);
	}

	async init(): Promise<void> {
		// fc2580_set_init() with external AGC mode
		const fxKhz = FC2580_CRYSTAL_KHZ;
		await this.wr(0x00, 0x00);
		await this.wr(0x12, 0x86);
		await this.wr(0x14, 0x5c);
		await this.wr(0x16, 0x3c);
		await this.wr(0x1f, 0xd2);
		await this.wr(0x09, 0xd7);
		await this.wr(0x0b, 0xd5);
		await this.wr(0x0c, 0x32);
		await this.wr(0x0e, 0x43);
		await this.wr(0x21, 0x0a);
		await this.wr(0x22, 0x82);
		// External AGC
		await this.wr(0x45, 0x20);
		await this.wr(0x4c, 0x02);
		await this.wr(0x3f, 0x88);
		await this.wr(0x02, 0x0e);
		await this.wr(0x58, 0x14);
		// Default filter: BW = 7.8 MHz
		await this.setFilter(8, fxKhz);
		console.log('FC2580: initialized');
	}

	async setFrequency(freq: number): Promise<number> {
		// FC2580 frequency is in kHz internally
		const fLoKhz = Math.round(freq / 1000);
		const fxKhz = FC2580_CRYSTAL_KHZ;

		// Band selection
		const band = (fLoKhz > 1000000) ? 'L' : (fLoKhz > 400000) ? 'UHF' : 'VHF';

		// Multiplier per band
		const bandMult = (band === 'UHF') ? 4 : (band === 'L') ? 2 : 12;
		const fVco = fLoKhz * bandMult;

		// R value: choose reference divider so f_comp is in right range
		const rVal = (fVco >= 2 * 76 * fxKhz) ? 1 : (fVco >= 76 * fxKhz) ? 2 : 4;
		const fComp = fxKhz / rVal;

		// N and K (fractional)
		const nVal = Math.floor(fVco / 2 / fComp);
		const fDiff = fVco - 2 * fComp * nVal;
		const preShift = 4;
		const fDiffShifted = fDiff << (20 - preShift);
		const divisor = (2 * fComp) >> preShift;
		let kVal = Math.floor(fDiffShifted / divisor);
		if (fDiffShifted - kVal * divisor >= (fComp >> preShift)) kVal++;

		// Build data_0x02: VCO band + R + band bits
		let data02 = 0x0e; // USE_EXT_CLK=0, default
		if (fVco >= FC2580_BORDER_FREQ) data02 |= 0x08; // high VCO

		// Band-specific register writes
		if (band === 'UHF') {
			data02 = (data02 & 0x3f); // UHF band bits
			await this.wr(0x25, 0xf0); await this.wr(0x27, 0x77); await this.wr(0x28, 0x53);
			await this.wr(0x29, 0x60); await this.wr(0x30, 0x09); await this.wr(0x50, 0x8c);
			await this.wr(0x53, 0x50);
			await this.wr(0x5f, fLoKhz < 538000 ? 0x13 : 0x15);
			if (fLoKhz < 538000) {
				await this.wr(0x61, 0x07); await this.wr(0x62, 0x06); await this.wr(0x67, 0x06);
				await this.wr(0x68, 0x08); await this.wr(0x69, 0x10); await this.wr(0x6a, 0x12);
			} else if (fLoKhz < 794000) {
				await this.wr(0x61, 0x03); await this.wr(0x62, 0x03); await this.wr(0x67, 0x03);
				await this.wr(0x68, 0x05); await this.wr(0x69, 0x0c); await this.wr(0x6a, 0x0e);
			} else {
				await this.wr(0x61, 0x07); await this.wr(0x62, 0x06); await this.wr(0x67, 0x07);
				await this.wr(0x68, 0x09); await this.wr(0x69, 0x10); await this.wr(0x6a, 0x12);
			}
			await this.wr(0x63, 0x15); await this.wr(0x6b, 0x0b); await this.wr(0x6c, 0x0c);
			await this.wr(0x6d, 0x78); await this.wr(0x6e, 0x32); await this.wr(0x6f, 0x14);
			await this.setFilter(8, fxKhz);
			await this.wr(0x2d, fLoKhz <= 794000 ? 0x9f : 0x8f);
		} else if (band === 'VHF') {
			data02 = (data02 & 0x3f) | 0x80;
			await this.wr(0x27, 0x77); await this.wr(0x28, 0x33); await this.wr(0x29, 0x40);
			await this.wr(0x30, 0x09); await this.wr(0x50, 0x8c); await this.wr(0x53, 0x50);
			await this.wr(0x5f, 0x0f); await this.wr(0x61, 0x07); await this.wr(0x62, 0x00);
			await this.wr(0x63, 0x15); await this.wr(0x67, 0x03); await this.wr(0x68, 0x05);
			await this.wr(0x69, 0x10); await this.wr(0x6a, 0x12); await this.wr(0x6b, 0x08);
			await this.wr(0x6c, 0x0a); await this.wr(0x6d, 0x78); await this.wr(0x6e, 0x32);
			await this.wr(0x6f, 0x54);
			await this.setFilter(7, fxKhz);
		} else { // L-band
			data02 = (data02 & 0x3f) | 0x40;
			await this.wr(0x2b, 0x70); await this.wr(0x2c, 0x37); await this.wr(0x2d, 0xe7);
			await this.wr(0x30, 0x09); await this.wr(0x44, 0x20); await this.wr(0x50, 0x8c);
			await this.wr(0x53, 0x50); await this.wr(0x5f, 0x0f); await this.wr(0x61, 0x0f);
			await this.wr(0x62, 0x00); await this.wr(0x63, 0x13); await this.wr(0x67, 0x00);
			await this.wr(0x68, 0x02); await this.wr(0x69, 0x0c); await this.wr(0x6a, 0x0e);
			await this.wr(0x6b, 0x08); await this.wr(0x6c, 0x0a); await this.wr(0x6d, 0xa0);
			await this.wr(0x6e, 0x50); await this.wr(0x6f, 0x14);
			await this.setFilter(1, fxKhz);
		}

		// AGC clock pre-divide for xtal >= 28 MHz (always true for RTL-SDR 28.8MHz context
		// but FC2580 uses internal 16.384 MHz, so this only applies if xtal > 28000 kHz - skip)

		// VCO band + PLL programming
		await this.wr(0x02, data02);
		const rBits = (rVal === 1) ? 0x00 : (rVal === 2) ? 0x10 : 0x20;
		await this.wr(0x18, rBits | ((kVal >> 16) & 0x0f));
		await this.wr(0x1a, (kVal >> 8) & 0xff);
		await this.wr(0x1b, kVal & 0xff);
		await this.wr(0x1c, nVal & 0xff);

		console.log(`FC2580: tuned to ${(freq/1e6).toFixed(3)} MHz (band=${band}, n=${nVal}, k=${kVal}, r=${rVal})`);
		return freq;
	}

	private async setFilter(bw: number, fxKhz: number): Promise<void> {
		// fc2580_set_filter() — bw: 1=1.53MHz, 6=6MHz, 7=6.8MHz, 8=7.8MHz
		if (bw === 1) {
			await this.wr(0x36, 0x1c);
			await this.wr(0x37, Math.floor(4151 * fxKhz / 1000000) & 0xff);
			await this.wr(0x39, 0x00);
			await this.wr(0x2e, 0x09);
		} else if (bw === 6) {
			await this.wr(0x36, 0x18);
			await this.wr(0x37, Math.floor(4400 * fxKhz / 1000000) & 0xff);
			await this.wr(0x39, 0x00);
			await this.wr(0x2e, 0x09);
		} else if (bw === 7) {
			await this.wr(0x36, 0x18);
			await this.wr(0x37, Math.floor(3910 * fxKhz / 1000000) & 0xff);
			await this.wr(0x39, 0x80);
			await this.wr(0x2e, 0x09);
		} else { // bw === 8, default
			await this.wr(0x36, 0x18);
			await this.wr(0x37, Math.floor(3300 * fxKhz / 1000000) & 0xff);
			await this.wr(0x39, 0x80);
			await this.wr(0x2e, 0x09);
		}
		// Poll calibration lock (up to 5 attempts)
		for (let i = 0; i < 5; i++) {
			const cal = await this.rd(0x2f);
			if ((cal & 0xc0) === 0xc0) break;
			await this.wr(0x2e, 0x01);
			await this.wr(0x2e, 0x09);
		}
		await this.wr(0x2e, 0x01);
	}

	async setAutoGain(): Promise<void> {
		// External AGC — registers already set in init(); nothing more needed
	}

	async setManualGain(_gain: number): Promise<void> {
		// FC2580 doesn't expose a direct LNA gain register in this driver;
		// gain is handled by the external AGC on the RTL2832U side.
		console.warn('FC2580: manual gain not supported, using AGC');
	}

	async close(): Promise<void> {
		// No specific shutdown sequence for FC2580
	}
}

// ── Tuner interface ───────────────────────────────────────────────
interface TunerDriver {
	init(): Promise<void>;
	setFrequency(freq: number): Promise<number>;
	setAutoGain(): Promise<void>;
	setManualGain(gainIdx: number): Promise<void>;
	getGains?(): number[];
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
	gainControls: GainControl[] = [
		{ name: 'Tuner', min: 0, max: 28, step: 1, default: 12, type: 'slider' },
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
			{ name: 'R820T/R820T2/R828D', addr: 0x34, checkReg: 0x00, expectVal: 0x96 },
			{ name: 'R828D', addr: 0x74, checkReg: 0x00, expectVal: 0x96 },
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

		if (detectedAddr === 0x34 || detectedAddr === 0x74) {
			// R820T / R820T2 (addr 0x34) or R828D (addr 0x74)
			const isR828D = detectedAddr === 0x74;
			const isBlogV4 = isR828D && (this.dev.productName?.includes('V4') || false);
			// Blog V4 uses 28.8MHz, but standard R828D uses 16MHz clock
			const tunerFreq = (isR828D && !isBlogV4) ? 16000000 : xtalFreq;
			
			const tunerLabel = isBlogV4 ? 'R828D (Blog V4)' : (isR828D ? 'R828D' : 'R820T/R820T2');
			console.log(`RTL-SDR: initializing ${tunerLabel} (vcoPowerRef=${isR828D ? 1 : 2}, xtal=${tunerFreq})`);
			const gpioCallback = async (gpio: number, on: boolean) => {
				await this.setGpioOutput(gpio);
				await this.setGpioBit(gpio, on);
			};
			this.tuner = new R820T(this.com, tunerFreq, detectedAddr, isR828D, isBlogV4, IF_FREQ, isBlogV4 ? gpioCallback : null);
			this.hasIfFreq = true;

			// Set IF frequency offset for R82xx family.
			// The demod IF register is in the RTL2832U which always uses its own
			// 28.8 MHz clock (XTAL_FREQ), regardless of the tuner crystal.
			const multiplier = -1 * Math.floor(IF_FREQ * (1 << 22) / xtalFreq);
			await this.com.writeDemodReg(1, 0xb1, 0x1a, 1);
			await this.com.writeDemodReg(0, 0x08, 0x4d, 1);
			await this.com.writeDemodReg(1, 0x19, (multiplier >> 16) & 0x3f, 1);
			await this.com.writeDemodReg(1, 0x1a, (multiplier >> 8) & 0xff, 1);
			await this.com.writeDemodReg(1, 0x1b, multiplier & 0xff, 1);
			await this.com.writeDemodReg(1, 0x15, 0x01, 1);
		} else if (detectedAddr === 0xc6 && detectedTuner === 'FC0013') {
			// FC0013 — zero-IF, same demod config as FC0012
			this.tuner = new FC0013(this.com, xtalFreq);
			this.hasIfFreq = false;
			this.conjugateIq = false;
			await this.setGpioOutput(6);
		} else if (detectedAddr === 0xc6) {
			// FC0012
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
		} else if (detectedAddr === 0xac) {
			// FC2580 — zero-IF tuner using internal 16.384 MHz crystal
			this.tuner = new FC2580(this.com);
			this.hasIfFreq = false;
			this.conjugateIq = false;
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
		if (this.tuner.getGains) {
			const gains = this.tuner.getGains();
			if (gains.length > 0) {
				this.gainControls[0] = {
					name: 'Tuner',
					min: 0,
					max: gains.length - 1,
					step: 1,
					default: Math.min(Math.floor(gains.length / 2), gains.length - 1),
					options: gains,
					type: 'slider'
				};
			}
		}
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
		return await this.withUsbLock(async () => {
			await this.pauseRx();
			try {
				// Flush the Endpoint buffer since pauseRx() stopped bulk polling 
				// and the FIFO rapidly overrun, wedging the ASIC.
				await this.com.writeReg(BLOCK.USB, REG.EPA_CTL, 0x0210, 2);
				await this.com.writeReg(BLOCK.USB, REG.EPA_CTL, 0x0000, 2);

				console.log('RTL-SDR: setSampleRate', rate);
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
			} finally {
				this.resumeRx();
			}
		});
	}

	async setFrequency(freqHz: number): Promise<void> {
		return await this.withUsbLock(async () => {
			await this.pauseRx();
			try {
				await this.com.writeReg(BLOCK.USB, REG.EPA_CTL, 0x0210, 2);
				await this.com.writeReg(BLOCK.USB, REG.EPA_CTL, 0x0000, 2);

				console.log('RTL-SDR: setFrequency', freqHz);
				if (this.tunerName.startsWith('FC0012')) {
					await this.setGpioBit(6, freqHz > 300000000);
				}
				await this.com.openI2C();
				await this.tuner.setFrequency(freqHz);
				await this.com.closeI2C();
			} finally {
				this.resumeRx();
			}
		});
	}

	async setGain(name: string, value: number): Promise<void> {
		return await this.setGains({ [name]: value });
	}

	async setGains(gains: Record<string, number>): Promise<void> {
		if (!this.tuner) return;
		return await this.withUsbLock(async () => {
			await this.pauseRx();
			try {
				await this.com.writeReg(BLOCK.USB, REG.EPA_CTL, 0x0210, 2);
				await this.com.writeReg(BLOCK.USB, REG.EPA_CTL, 0x0000, 2);

				if ('Tuner' in gains) {
					await this.com.openI2C();
					await this.tuner.setManualGain(gains['Tuner']);
					await this.com.closeI2C();
				}
				if ('Bias-T' in gains) {
					await this.setBiasTee(!!gains['Bias-T']);
				}
			} finally {
				this.resumeRx();
			}
		});
	}



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

	/** Restart bulk transfer loops after pauseRx. */
	private resumeRx(): void {
		if (!this.rxCallback || this.rxRunning) return;
		// Restart bulk loops in the background. This will implicitly use withUsbLock
		// to safely flush the EPA_CTL buffers and clear the WinUSB lockup from pauseRx().
		this.startRx(this.rxCallback).catch(err => {
			console.error('RTL-SDR: Failed to resume Rx:', err);
		});
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
		return this.withUsbLock(async () => {
			if (this.rxRunning) await this.stopRx();
			this.rxCallback = callback;

			// Reset USB buffer (matches librtlsdr rtlsdr_reset_buffer)
			await this.com.writeReg(BLOCK.USB, REG.EPA_CTL, 0x0210, 2);
			await this.com.writeReg(BLOCK.USB, REG.EPA_CTL, 0x0000, 2);

			this.launchBulkLoops(callback);
		});
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
