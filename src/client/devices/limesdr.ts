/*
LimeSDR USB WebUSB driver for BrowSDR
Copyright (c) 2026, jLynx <https://github.com/jLynx>

Based on LimeSuite (Apache 2.0) https://github.com/myriadrf/LimeSuite

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

// ── LMS64C Protocol ─────────────────────────────────────────────────
const CMD_GET_INFO     = 0x00;
const CMD_LMS7002_RST  = 0x20;
const CMD_LMS7002_WR   = 0x21;
const CMD_LMS7002_RD   = 0x22;
const CMD_BRDSPI_WR    = 0x55;
const CMD_BRDSPI_RD    = 0x56;

// USB bulk endpoints
const EP_CTRL_OUT = 0x0F;       // Control command output
const EP_CTRL_IN_NUM = 15;      // Control response input (endpoint number for transferIn)
const EP_STREAM_IN_NUM = 1;     // IQ stream input (endpoint number for transferIn)

// Streaming constants
const TRANSFER_SIZE = 262144;   // 256 KB per bulk transfer
const STREAM_PKT_SIZE = 4096;   // FPGA packet size
const STREAM_HDR_SIZE = 16;     // Packet header bytes
const STREAM_PAYLOAD = STREAM_PKT_SIZE - STREAM_HDR_SIZE; // 4080 bytes of IQ data
const NUM_TRANSFERS = 8;        // Concurrent USB transfers

// Reference clock
const REF_CLK = 30.72e6;        // LimeSDR-USB VCTCXO

// VCO frequency ranges
const CGEN_VCO_MIN = 1930e6;
const CGEN_VCO_MAX = 2940e6;
const SX_VCO_MIN = 3800e6;      // VCOL low bound
const SX_VCO_MAX = 7714e6;      // VCOH high bound
const SX_DIV2_THRESHOLD = 5500e6;

// LNA gain table: index = register value (1-15), value = dB
const LNA_GAIN_DB = [0, 0, 3, 6, 9, 12, 15, 18, 21, 24, 25, 26, 27, 28, 29, 30];

// ── LMS7002M Register Addresses ─────────────────────────────────────
const REG_RESET       = 0x0020;  // Reset/enable/MAC
const REG_LML_CONF1   = 0x0023;  // LML mode config
const REG_LML1_MAP    = 0x0024;  // LML1 sample mapping
const REG_CLK_MUX     = 0x002A;  // Clock muxing
const REG_CLK_SRC     = 0x002B;  // MCLK sources
// AFE
const REG_AFE_CFG     = 0x0082;  // AFE enables

// CGEN (Clock Generator PLL)
const REG_CGEN_CFG    = 0x0086;  // CGEN control (PD, EN_G)
const REG_CGEN_FRAC_L = 0x0087;  // CGEN fractional LSB [15:0]
const REG_CGEN_INT    = 0x0088;  // CGEN INT [13:4], FRAC MSB [3:0]
const REG_CGEN_DIV    = 0x0089;  // CGEN output divider [10:3]
const REG_CGEN_CSW    = 0x008B;  // CGEN VCO CSW [8:1], ICT [13:9]
const REG_CGEN_CMP    = 0x008C;  // CGEN comparator [13:12]

// RFE (RX Front End)
const REG_RFE_EN      = 0x010C;  // RFE enable [0], PD bits
const REG_RFE_PATH    = 0x010D;  // SEL_PATH_RFE [8:7], EN_INSHSW_LB2 [4], LB1 [3], L [2], W [1]
const REG_RFE_GAIN    = 0x0113;  // G_LNA [9:6], G_TIA [1:0]

// RBB (RX Baseband)
const REG_RBB_PGA     = 0x0119;  // G_PGA_RBB [4:0]

// SX (Synthesizer, register space depends on MAC channel)
const REG_SX_CFG      = 0x011C;  // EN_DIV2 [10], EN_INTONLY [9], PD_VCO [1], EN_G [0]
const REG_SX_FRAC_L   = 0x011D;  // FRAC LSB [15:0]
const REG_SX_INT      = 0x011E;  // INT [13:4], FRAC MSB [3:0]
const REG_SX_DIV      = 0x011F;  // DIV_LOCH [8:6]
const REG_SX_ICT      = 0x0120;  // ICT_VCO [7:0]
const REG_SX_VCO      = 0x0121;  // CSW_VCO [10:3], SEL_VCO [2:1]
const REG_SX_CMP      = 0x0123;  // VCO_CMPHO [13:12]

// RBB (RX Baseband)
const REG_RBB_EN      = 0x0115;  // RBB enable [0]

// RxTSP (RX Digital Signal Processing)
const REG_RXTSP_CFG   = 0x0400;  // EN [0]
const REG_RXTSP_DEC   = 0x0403;  // HBD_OVR [14:12]
const REG_RXTSP_AGC   = 0x040A;  // AGC_MODE [13:12]
const REG_RXTSP_BYP   = 0x040C;  // Various bypass bits

// TxTSP (TX DSP - needed for clock routing)
const REG_TXTSP_CFG   = 0x0200;  // EN [0]

// FPGA registers (via board SPI)
const FPGA_REG_DIRECT_CLK = 0x0005; // Direct clock bypass
const FPGA_REG_CH_EN  = 0x0007;  // Channel enable bitmask
const FPGA_REG_IFACE  = 0x0008;  // Stream mode [15:8] + sample width [1:0]
const FPGA_REG_TSTAMP = 0x0009;  // Timestamp/counter reset
const FPGA_REG_CTRL   = 0x000A;  // RX_EN [0], TX_EN [1]
const FPGA_REG_MODE   = 0x0025;  // PLL mode (bit 7 = config enable)
const FPGA_REG_MN_ODD = 0x0026;  // M/N odd and bypass
const FPGA_REG_C_ODD0 = 0x0027;  // C[7:0] odd/bypass
const FPGA_REG_N_CNT  = 0x002A;  // N counter
const FPGA_REG_M_CNT  = 0x002B;  // M counter
const FPGA_REG_C0_CNT = 0x002E;  // C0 counter
const FPGA_REG_CHIP_SEL = 0xFFFF; // FPGA chip select


// ── Helpers ─────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
	return new Promise(r => setTimeout(r, ms));
}

function setBits(reg: number, msb: number, lsb: number, value: number): number {
	const mask = ((1 << (msb - lsb + 1)) - 1) << lsb;
	return (reg & ~mask) | ((value << lsb) & mask);
}

function getBits(reg: number, msb: number, lsb: number): number {
	return (reg >> lsb) & ((1 << (msb - lsb + 1)) - 1);
}

// Find LNA register value for a target dB gain (0-30)
function lnaGainToReg(gainDb: number): number {
	gainDb = Math.max(0, Math.min(30, gainDb));
	for (let i = 15; i >= 1; i--) {
		if (LNA_GAIN_DB[i] <= gainDb) return i;
	}
	return 1;
}

// ── LimeSDR Low-Level Driver ────────────────────────────────────────

class LimeSDR {
	private dev!: USBDevice;
	private rxRunning: Promise<void>[] | null = null;
	private regCache = new Map<number, number>();
	private currentSampleRate = 10e6;
	private currentFrequency = 100e6;

	// ── USB Communication ───────────────────────────────────────

	async open(device: USBDevice): Promise<void> {
		this.dev = device;
		await this.dev.open();
		await this.dev.selectConfiguration(1);
		await this.dev.claimInterface(0);

		// Log available endpoints for debugging
		const iface = this.dev.configuration?.interfaces[0];
		if (iface) {
			const eps = iface.alternate.endpoints;
			console.log(`LimeSDR USB endpoints (${eps.length}):`);
			for (const ep of eps) {
				console.log(`  EP${ep.endpointNumber} ${ep.direction} ${ep.type} pktSize=${ep.packetSize}`);
			}
		}
	}

	async close(): Promise<void> {
		if (this.rxRunning) await this.stopStreaming();
		try { await this.dev.close(); } catch (_) { /* ignore */ }
	}

	private async sendCommand(cmd: number, payload?: Uint8Array): Promise<Uint8Array> {
		const pkt = new Uint8Array(64);
		pkt[0] = cmd;
		if (payload) {
			pkt[2] = Math.ceil(payload.length / 4); // blockCount
			pkt.set(payload, 8);
		}

		await this.dev.transferOut(EP_CTRL_OUT, pkt);
		const result = await this.dev.transferIn(EP_CTRL_IN_NUM, 64);
		if (result.status !== 'ok') throw new Error(`LimeSDR: USB transfer failed (status=${result.status})`);
		return new Uint8Array(result.data!.buffer, result.data!.byteOffset, result.data!.byteLength);
	}

	// ── LMS7002M SPI Registers ──────────────────────────────────

	async writeLMS7002(addr: number, value: number): Promise<void> {
		const data = new Uint8Array(4);
		data[0] = (addr >> 8) | 0x80;  // MSB with write flag
		data[1] = addr & 0xFF;
		data[2] = (value >> 8) & 0xFF;
		data[3] = value & 0xFF;
		await this.sendCommand(CMD_LMS7002_WR, data);
		this.regCache.set(addr, value);
	}

	async readLMS7002(addr: number): Promise<number> {
		const data = new Uint8Array(2);
		data[0] = (addr >> 8) & 0x7F;  // No write flag
		data[1] = addr & 0xFF;
		const resp = await this.sendCommand(CMD_LMS7002_RD, data);
		const value = (resp[8 + 2] << 8) | resp[8 + 3];
		this.regCache.set(addr, value);
		return value;
	}

	async writeLMS7002Batch(pairs: [number, number][]): Promise<void> {
		const maxPerPacket = 14; // 56 bytes / 4 bytes per register
		for (let offset = 0; offset < pairs.length; offset += maxPerPacket) {
			const chunk = pairs.slice(offset, offset + maxPerPacket);
			const data = new Uint8Array(chunk.length * 4);
			for (let i = 0; i < chunk.length; i++) {
				const [addr, value] = chunk[i];
				data[i * 4] = (addr >> 8) | 0x80;
				data[i * 4 + 1] = addr & 0xFF;
				data[i * 4 + 2] = (value >> 8) & 0xFF;
				data[i * 4 + 3] = value & 0xFF;
				this.regCache.set(addr, value);
			}
			await this.sendCommand(CMD_LMS7002_WR, data);
		}
	}

	private async modifyReg(addr: number, msb: number, lsb: number, value: number): Promise<void> {
		let reg = this.regCache.get(addr);
		if (reg === undefined) reg = await this.readLMS7002(addr);
		const updated = setBits(reg, msb, lsb, value);
		if (updated !== reg) await this.writeLMS7002(addr, updated);
	}

	// ── FPGA SPI Registers ──────────────────────────────────────

	async writeFPGA(addr: number, value: number): Promise<void> {
		const data = new Uint8Array(4);
		data[0] = ((addr >> 8) & 0x7F) | 0x80;  // Address MSB with WRITE flag (bit 7)
		data[1] = addr & 0xFF;
		data[2] = (value >> 8) & 0xFF;
		data[3] = value & 0xFF;
		await this.sendCommand(CMD_BRDSPI_WR, data);
	}

	async readFPGA(addr: number): Promise<number> {
		const data = new Uint8Array(2);
		data[0] = (addr >> 8) & 0x7F;   // No write flag for reads
		data[1] = addr & 0xFF;
		const resp = await this.sendCommand(CMD_BRDSPI_RD, data);
		return (resp[8 + 2] << 8) | resp[8 + 3];
	}

	// ── Device Info ─────────────────────────────────────────────

	async getDeviceInfo(): Promise<SdrDeviceInfo> {
		const resp = await this.sendCommand(CMD_GET_INFO);
		const fw = resp[8 + 0];
		const device = resp[8 + 1];
		const proto = resp[8 + 2];
		const hw = resp[8 + 3];
		const serialBytes = resp.slice(8 + 10, 8 + 18);
		const serial = Array.from(serialBytes).map(b => b.toString(16).padStart(2, '0')).join('');

		const deviceNames: Record<number, string> = {
			4: 'LimeSDR-USB',
			5: 'LimeSDR-PCIe',
			10: 'LimeSDR Mini',
			11: 'LimeSDR Mini v2',
		};
		const name = deviceNames[device] ?? `LimeSDR (type=${device})`;

		console.log(`${name}: FW=${fw}, HW=${hw}, Proto=${proto}, Serial=${serial}`);
		return { name, serial, firmware: `FW:${fw} HW:${hw}` };
	}

	// ── Initialization ──────────────────────────────────────────

	async initialize(): Promise<void> {
		console.log('LimeSDR: starting initialization...');

		// 1. Hardware reset via LMS64C command
		const rstData = new Uint8Array(2);
		rstData[0] = 2; // pulse reset
		await this.sendCommand(CMD_LMS7002_RST, rstData);
		await delay(50);

		// 2. Software reset sequence (LimeSuite ResetChip pattern)
		// Assert all resets (LRST/MRST active-low = 0 means in reset)
		await this.writeLMS7002(REG_RESET, 0x0000);
		await delay(10);
		// Release all resets (LRST/MRST = 1 = normal, SRST = 1 = asserted)
		await this.writeLMS7002(REG_RESET, 0xFFFF);
		await delay(10);

		// 3. Clear FIFO soft resets (SRST bits are active-HIGH: 0 = normal operation)
		// Set MAC=01 (Channel A), RXEN_A=1, TXEN_A=1 (TX needed for clock routing)
		// LRST/MRST all = 1 (released), SRST = 0 (released)
		// 0xFF35 = 1111_1111_0011_0101: all LRST/MRST released, SRST cleared,
		//          RXEN_A=1, TXEN_A=1, RXEN_B=0, TXEN_B=0, MAC=01
		await this.writeLMS7002(REG_RESET, 0xFF35);
		await delay(5);
		console.log('LimeSDR: chip reset complete');

		// 4. Enable AFE (ADC/DAC analog front-end)
		// EN_G_AFE=1 (bit 0), PD_RX_AFE1=0 (bit 5 clear = RX on), PD_TX_AFE1=1 (bit 3)
		await this.writeLMS7002(REG_AFE_CFG, 0x8001);  // Power on RX ADC, TX DAC off

		// 5. Enable CGEN and configure for default sample rate
		await this.modifyReg(REG_CGEN_CFG, 0, 0, 1);  // EN_G_CGEN = 1
		console.log(`LimeSDR: setting CGEN for ${(this.currentSampleRate / 1e6).toFixed(2)} MS/s...`);
		// MIMO mode: interface alternates chA/chB each clock, so per-channel rate = FCLK/2
		// Need CGEN = rate * 8 (vs rate * 4 for SISO DDR)
		await this.setCGENFrequency(this.currentSampleRate * 8);

		// Set analog bandwidth
		await this.setAnalogBandwidth(this.currentSampleRate);

		// 6. Enable RFE (RX front-end) — power on ALL blocks
		await this.modifyReg(REG_RFE_EN, 0, 0, 1);    // EN_G_RFE = 1
		// Clear all power-down bits [7:1]:
		// PD_LNA[7]=0, PD_RLOOPB_1[6]=0, PD_RLOOPB_2[5]=0,
		// PD_MXLOBUF[4]=0, PD_QGEN[3]=0, PD_RSSI[2]=0, PD_TIA_RFE[1]=0
		await this.modifyReg(REG_RFE_EN, 7, 1, 0);
		// Set antenna path
		await this.setAntennaPath(1);                   // LNAL default

		// 7. Set default gains
		await this.setLNAGain(14);   // ~29 dB
		await this.setTIAGain(2);    // 12 dB
		await this.setPGAGain(16);   // +4 dB

		// 8. Enable RBB (RX baseband)
		await this.modifyReg(REG_RBB_EN, 0, 0, 1);    // EN_G_RBB = 1
		// Power on RBB blocks: PD_LPFH=0(bit3), PD_LPFL=0(bit2), PD_PGA=0(bit4)
		await this.modifyReg(REG_RBB_EN, 4, 2, 0);

		// 8b. Configure RxTSP
		await this.configureRxTSP();

		// 8c. Enable TxTSP (needed for clock routing)
		await this.modifyReg(REG_TXTSP_CFG, 0, 0, 1);

		// 8d. Configure LML interface
		await this.configureLML();

		// 8e. Configure FPGA
		await this.configureFPGA();

		// 9. Configure and tune SXR (RX LO synthesizer)
		console.log(`LimeSDR: tuning SXR to ${(this.currentFrequency / 1e6).toFixed(3)} MHz...`);
		await this.setFrequencySXR(this.currentFrequency);

		// 10. Dump key registers for diagnostics
		await this.dumpRegisters();

		console.log('LimeSDR: initialization complete');
	}

	// ── Register Diagnostics ────────────────────────────────────

	private async dumpRegisters(): Promise<void> {
		const regs: [string, number][] = [
			['RESET (0x0020)',    REG_RESET],
			['DIQ_PAD (0x0022)', 0x0022],
			['LML_CONF (0x0023)', REG_LML_CONF1],
			['LML1_MAP (0x0024)', REG_LML1_MAP],
			['CLK_MUX (0x002A)', REG_CLK_MUX],
			['CLK_SRC (0x002B)', REG_CLK_SRC],
			['AFE_CFG (0x0082)', REG_AFE_CFG],
			['RXTSP_CFG (0x0400)', REG_RXTSP_CFG],
			['RXTSP_DEC (0x0403)', REG_RXTSP_DEC],
			['RXTSP_BYP (0x040C)', REG_RXTSP_BYP],
		];
		const vals: string[] = [];
		for (const [name, addr] of regs) {
			const val = await this.readLMS7002(addr);
			vals.push(`${name}=0x${val.toString(16).padStart(4, '0')}`);
		}
		console.log('LimeSDR LMS7002 regs: ' + vals.join(', '));

		// FPGA registers
		const fpgaRegs: [string, number][] = [
			['IFACE (0x0008)', FPGA_REG_IFACE],
			['CH_EN (0x0007)', FPGA_REG_CH_EN],
			['CTRL (0x000A)', FPGA_REG_CTRL],
		];
		const fpgaVals: string[] = [];
		for (const [name, addr] of fpgaRegs) {
			const val = await this.readFPGA(addr);
			fpgaVals.push(`${name}=0x${val.toString(16).padStart(4, '0')}`);
		}
		console.log('LimeSDR FPGA regs: ' + fpgaVals.join(', '));
	}

	// ── CGEN PLL (Clock Generator) ──────────────────────────────

	async setCGENFrequency(freq_Hz: number): Promise<void> {
		// Calculate output divider so VCO lands in valid range
		const iHdiv_high = Math.floor(CGEN_VCO_MAX / 2 / freq_Hz) - 1;
		const iHdiv_low = Math.ceil(CGEN_VCO_MIN / 2 / freq_Hz);
		let iHdiv = Math.floor((iHdiv_low + iHdiv_high) / 2);
		iHdiv = Math.max(0, Math.min(255, iHdiv));

		const vcoFreq = 2 * (iHdiv + 1) * freq_Hz;
		if (vcoFreq < CGEN_VCO_MIN || vcoFreq > CGEN_VCO_MAX) {
			throw new Error(`CGEN: VCO freq ${(vcoFreq / 1e6).toFixed(1)} MHz out of range`);
		}

		const ratio = vcoFreq / REF_CLK;
		const gINT = Math.floor(ratio) - 1;
		const gFRAC = Math.round((ratio - gINT - 1) * (1 << 20)) & 0xFFFFF;

		// Write CGEN PLL registers
		await this.writeLMS7002Batch([
			[REG_CGEN_FRAC_L, gFRAC & 0xFFFF],
			[REG_CGEN_INT, ((gINT & 0x3FF) << 4) | ((gFRAC >> 16) & 0xF)],
			[REG_CGEN_DIV, setBits(await this.readLMS7002(REG_CGEN_DIV), 10, 3, iHdiv)],
		]);

		// Enable VCO
		await this.modifyReg(REG_CGEN_CFG, 2, 1, 0); // PD_VCO=0, PD_VCO_COMP=0

		// Tune VCO
		const locked = await this.tuneVCO('CGEN');
		if (locked) {
			console.log(`LimeSDR: CGEN locked, VCO=${(vcoFreq / 1e6).toFixed(1)} MHz, DIV=${iHdiv}, INT=${gINT}, FRAC=${gFRAC}`);
		} else {
			console.warn('LimeSDR: CGEN VCO failed to lock!');
		}
	}

	// ── SX PLL (LO Synthesizer) ─────────────────────────────────

	async setFrequencySXR(freq_Hz: number): Promise<void> {
		// Select SXR channel (MAC=1 for ChA)
		await this.modifyReg(REG_RESET, 1, 0, 1);

		// Find output divider
		let div_loch = -1;
		let vcoFreq = 0;
		for (let d = 6; d >= 0; d--) {
			const testVCO = (1 << (d + 1)) * freq_Hz;
			if (testVCO >= SX_VCO_MIN && testVCO <= SX_VCO_MAX) {
				div_loch = d;
				vcoFreq = testVCO;
				break;
			}
		}
		if (div_loch < 0) throw new Error(`SX: cannot tune to ${(freq_Hz / 1e6).toFixed(3)} MHz`);

		// Calculate PLL values
		const en_div2 = vcoFreq > SX_DIV2_THRESHOLD ? 1 : 0;
		const divisor = en_div2 ? 2 : 1;
		const ratio = vcoFreq / (REF_CLK * divisor);
		const intPart = Math.floor(ratio) - 4;
		const fracPart = Math.round((ratio - intPart - 4) * (1 << 20)) & 0xFFFFF;

		// Write SX PLL registers
		let sxCfg = await this.readLMS7002(REG_SX_CFG);
		sxCfg = setBits(sxCfg, 10, 10, en_div2);    // EN_DIV2_DIVPROG
		sxCfg = setBits(sxCfg, 9, 9, 0);            // EN_INTONLY=0 (fractional mode)
		sxCfg = setBits(sxCfg, 1, 1, 0);             // PD_VCO=0
		sxCfg = setBits(sxCfg, 0, 0, 1);             // EN_G=1
		await this.writeLMS7002(REG_SX_CFG, sxCfg);

		await this.writeLMS7002(REG_SX_FRAC_L, fracPart & 0xFFFF);
		let intReg = await this.readLMS7002(REG_SX_INT);
		intReg = setBits(intReg, 13, 4, intPart & 0x3FF);
		intReg = setBits(intReg, 3, 0, (fracPart >> 16) & 0xF);
		await this.writeLMS7002(REG_SX_INT, intReg);

		let divReg = await this.readLMS7002(REG_SX_DIV);
		divReg = setBits(divReg, 8, 6, div_loch & 0x7);
		await this.writeLMS7002(REG_SX_DIV, divReg);

		// Try all 3 VCO bands, pick the best lock
		let bestVCO = -1;
		let bestCSW = -1;
		let bestScore = 999;

		for (let sel = 0; sel < 3; sel++) {
			await this.modifyReg(REG_SX_VCO, 2, 1, sel);
			const locked = await this.tuneVCO('SX');
			if (locked) {
				const csw = getBits(this.regCache.get(REG_SX_VCO) ?? 0, 10, 3);
				const score = Math.abs(csw - 128);
				if (score < bestScore) {
					bestScore = score;
					bestVCO = sel;
					bestCSW = csw;
				}
			}
		}

		if (bestVCO < 0) {
			// Retry with higher VCO bias current
			const ict = getBits(await this.readLMS7002(REG_SX_ICT), 7, 0);
			if (ict < 255) {
				await this.modifyReg(REG_SX_ICT, 7, 0, Math.min(255, ict + 32));
				// Retry once
				for (let sel = 0; sel < 3; sel++) {
					await this.modifyReg(REG_SX_VCO, 2, 1, sel);
					const locked = await this.tuneVCO('SX');
					if (locked) {
						bestVCO = sel;
						bestCSW = getBits(this.regCache.get(REG_SX_VCO) ?? 0, 10, 3);
						break;
					}
				}
			}
		}

		if (bestVCO < 0) {
			console.warn(`LimeSDR: SX VCO failed to lock at ${(freq_Hz / 1e6).toFixed(3)} MHz`);
			return;
		}
		// Readback and verify actual programmed frequency
		const rbInt = getBits(await this.readLMS7002(REG_SX_INT), 13, 4);
		const rbFracL = await this.readLMS7002(REG_SX_FRAC_L);
		const rbFracH = getBits(await this.readLMS7002(REG_SX_INT), 3, 0);
		const rbDiv = getBits(await this.readLMS7002(REG_SX_DIV), 8, 6);
		const rbEnDiv2 = getBits(await this.readLMS7002(REG_SX_CFG), 10, 10);
		const rbFrac = (rbFracH << 16) | rbFracL;
		const rbDivisor = rbEnDiv2 ? 2 : 1;
		const rbVCO = (rbInt + 4 + rbFrac / (1 << 20)) * REF_CLK * rbDivisor;
		const rbFreq = rbVCO / (1 << (rbDiv + 1));
		console.log(`LimeSDR: SXR locked at ${(freq_Hz / 1e6).toFixed(3)} MHz, actual=${(rbFreq / 1e6).toFixed(3)} MHz, VCO=${bestVCO}, CSW=${bestCSW}, div_loch=${div_loch}, INT=${rbInt}, FRAC=${rbFrac}, DIV=${rbDiv}, EN_DIV2=${rbEnDiv2}`);

		// Apply best VCO + CSW
		let vcoReg = await this.readLMS7002(REG_SX_VCO);
		vcoReg = setBits(vcoReg, 2, 1, bestVCO);
		vcoReg = setBits(vcoReg, 10, 3, bestCSW);
		await this.writeLMS7002(REG_SX_VCO, vcoReg);

		this.currentFrequency = freq_Hz;
	}

	// ── VCO Tuning (Binary Search for CSW) ──────────────────────

	private async tuneVCO(module: 'CGEN' | 'SX'): Promise<boolean> {
		const isCGEN = module === 'CGEN';
		const addrCSW = isCGEN ? REG_CGEN_CSW : REG_SX_VCO;
		const addrCMP = isCGEN ? REG_CGEN_CMP : REG_SX_CMP;
		const cswMSB = isCGEN ? 8 : 10;
		const cswLSB = isCGEN ? 1 : 3;

		// Read comparator helper
		const readCmp = async (): Promise<number> => {
			const val = await this.readLMS7002(addrCMP);
			return getBits(val, 13, 12);
		};

		// Binary search for CSW value
		let csw = 0;
		for (let bit = 7; bit >= 0; bit--) {
			csw |= (1 << bit);
			await this.modifyReg(addrCSW, cswMSB, cswLSB, csw);
			await delay(1); // Settling time
			const cmp = await readCmp();
			if (cmp & 0x01) {
				// VCO too high, clear this bit
				csw &= ~(1 << bit);
			}
		}

		// Verify lock at found value and neighbors
		for (const offset of [0, 1, -1, 2, -2]) {
			const testCSW = Math.max(0, Math.min(255, csw + offset));
			await this.modifyReg(addrCSW, cswMSB, cswLSB, testCSW);
			await delay(1);
			const cmp = await readCmp();
			if (cmp === 2) {
				// Locked
				return true;
			}
		}

		return false;
	}

	// ── Interface Rate Configuration ────────────────────────────
	// Matches LimeSuite's SetRate + SetInterfaceFrequency logic

	// ── RxTSP Configuration ─────────────────────────────────────

	private async configureRxTSP(): Promise<void> {
		// Enable RxTSP
		await this.modifyReg(REG_RXTSP_CFG, 0, 0, 1);

		// HBD_OVR_RXTSP = 7 → bypass decimation
		// In SISO DDR bypass mode: CGEN = sampleRate × 4, no decimation needed
		await this.modifyReg(REG_RXTSP_DEC, 14, 12, 7);

		// AGC bypass
		await this.modifyReg(REG_RXTSP_AGC, 13, 12, 2);

		// Bypass register 0x040C:
		// All TSP blocks bypassed except DC correction (bit 2 = 0)
		// Bit 7: CMIX_BYP=1 (bypass NCO — no digital frequency shift)
		// Bit 6: AGC_BYP=1, Bits 5-3: GFIR3/2/1_BYP=1
		// Bit 1: GC_BYP=1, Bit 0: PH_BYP=1 (no calibration data available)
		await this.writeLMS7002(REG_RXTSP_BYP, 0x00FB);

		// Zero the NCO phase/frequency registers to ensure no residual mixing
		// PHO registers 0x0440-0x0449 (NCO frequency words)
		await this.writeLMS7002(0x0440, 0x0000);  // FCW0 [15:0]
		await this.writeLMS7002(0x0441, 0x0000);  // FCW0 [31:16]
		await this.writeLMS7002(0x0442, 0x0000);  // PHO0

		// DC correction averaging (register 0x0404 bits [2:0] per LimeSuite)
		await this.modifyReg(0x0404, 2, 0, 7);  // Max averaging window

		// Set IQ correction defaults (unity gain, zero phase)
		await this.writeLMS7002(0x0401, 2047);  // GCORRQ = 2047 (unity)
		await this.writeLMS7002(0x0402, 2047);  // GCORRI = 2047 (unity)
		await this.modifyReg(REG_RXTSP_DEC, 11, 0, 0);  // IQCORR = 0 (no phase correction)
	}

	// ── LML Interface Configuration ─────────────────────────────

	private async configureLML(): Promise<void> {
		// 0x0021: Pad pull-ups and SPI mode (4-wire)
		await this.writeLMS7002(0x0021, 0x0E9F);

		// 0x0022: DIQ pad control — MIMO mode (SISODDR disabled)
		// SISO DDR (bits 14,12=1) was causing Q data loss due to FPGA DDR edge selection
		// MIMO mode properly captures I on one DDR edge, Q on the other
		await this.writeLMS7002(0x0022, 0x0FFF);

		// 0x0023: LML direction/mode/routing (LimeSuite Init default)
		await this.writeLMS7002(REG_LML_CONF1, 0x5550);

		// 0x0024, 0x0027: Sample position mapping (AI=0, AQ=1, BI=2, BQ=3)
		await this.writeLMS7002(REG_LML1_MAP, 0xE4E4);
		await this.writeLMS7002(0x0027, 0xE4E4);

		// 0x002C: No TSP clock dividers (bypass mode)
		await this.writeLMS7002(0x002C, 0x0000);

		// 0x002A: FIFO clock mux routing for MIMO bypass (decimation=7, siso=0)
		// Per LimeSuite SetInterfaceFrequency:
		//   RXRDCLK_MUX[3:2]=3, RXWRCLK_MUX[1:0]=1 (mimoBypass RX path)
		//   TXRDCLK_MUX[7:6]=0, TXWRCLK_MUX[5:4]=0 (mimoBypass TX path)
		// = (0<<6) | (0<<4) | (3<<2) | (1<<0) = 0x000D
		await this.writeLMS7002(REG_CLK_MUX, 0x000D);

		// 0x002B: MCLK sources (LimeSuite Init default)
		// MCLK1SRC[3:2]=2 (TXTSPCLKA_DIV), MCLK2SRC[5:4]=3 (RXTSPCLKA_DIV)
		await this.writeLMS7002(REG_CLK_SRC, 0x0038);
	}

	// ── FPGA Configuration ──────────────────────────────────────

	private async configureFPGA(): Promise<void> {
		// Select FPGA chip
		await this.writeFPGA(FPGA_REG_CHIP_SEL, 1);

		// Stop any existing streaming
		await this.writeFPGA(FPGA_REG_CTRL, 0x0000);

		// Set stream mode: MIMO (0x0100), 16-bit samples
		// MIMO mode captures I and Q from separate DDR edges correctly
		// (SISO DDR 0x0040 was losing Q data due to FPGA edge selection)
		await this.writeFPGA(FPGA_REG_IFACE, 0x0100);

		// Channel A only — LimeSuite uses ch_en=1 with MIMO for single-channel RX
		// Data format is non-interleaved: [I, Q, I, Q, ...]
		await this.writeFPGA(FPGA_REG_CH_EN, 0x0001);

		// Configure FPGA PLL for RX
		await this.configureFPGAPLL();

		console.log('LimeSDR: FPGA configured (MIMO mode, ch A)');
	}

	private async configureFPGAPLL(): Promise<void> {
		// FPGA PLL input = MCLK2 = GetReferenceClk_TSP(Rx) = CGEN/4 = rate*2 (MIMO mode)
		const pllInputFreq = this.currentSampleRate * 2;
		// In MIMO bypass (CLK_MUX & 0x0F == 0x0D), output clocks = 2 * input
		// per LimeSuite: clocks[0].outFrequency = bypassRx ? 2*rxRate_Hz : rxRate_Hz
		const pllOutputFreq = pllInputFreq * 2;

		const rxPhase = 89.46 + 1.24e-6 * this.currentSampleRate;
		const txPhase = 89.61 + 2.71e-7 * this.currentSampleRate;

		// Configure TX PLL (index 0) then RX PLL (index 1)
		await this.programFPGAPLL(0, pllInputFreq, [pllOutputFreq, pllOutputFreq], [0, txPhase]);
		await this.programFPGAPLL(1, pllInputFreq, [pllOutputFreq, pllOutputFreq], [0, rxPhase]);
	}

	private async programFPGAPLL(pllIndex: number, inputFreq: number, clockFreqs: number[], clockPhases: number[] = []): Promise<void> {
		const VCO_MIN = 600e6;
		const VCO_MAX = 1300e6;
		const PLL_READ_ADDR = 0x0003;
		const PLL_WRITE_ADDR = 0x0023;

		// Disable direct clock bypass for this PLL
		const directClk = await this.readFPGA(FPGA_REG_DIRECT_CLK);
		await this.writeFPGA(FPGA_REG_DIRECT_CLK, directClk & ~(1 << pllIndex));

		// Read control reg from 0x0003, write to 0x0023 (different addresses!)
		let reg23val = await this.readFPGA(PLL_READ_ADDR);
		reg23val &= ~(0x1F << 3);  // Clear PLL index
		reg23val &= ~0x07;          // Clear start/reset bits
		reg23val |= (pllIndex << 3);

		// Enable phase config
		const reg25 = await this.readFPGA(FPGA_REG_MODE);
		await this.writeFPGA(FPGA_REG_MODE, reg25 | 0x80);
		await this.writeFPGA(PLL_WRITE_ADDR, reg23val);

		// Reset PLL
		await this.writeFPGA(PLL_WRITE_ADDR, reg23val | 0x04);
		await delay(10);
		await this.writeFPGA(PLL_WRITE_ADDR, reg23val & ~0x04);
		await delay(10);

		// Find best M, N for VCO
		let bestM = 1, bestN = 1, bestDev = 1e18;
		for (let m = 1; m <= 255; m++) {
			const vco = inputFreq * m;
			if (vco < VCO_MIN || vco > VCO_MAX) continue;
			let dev = 0;
			let valid = true;
			for (const f of clockFreqs) {
				const c = Math.round(vco / f);
				if (c < 1 || c > 255) { valid = false; break; }
				dev += Math.abs(vco / c - f);
			}
			if (!valid) continue;
			if (dev < bestDev) { bestDev = dev; bestM = m; bestN = 1; }
			if (dev === 0) break;
		}

		const Fvco = inputFreq * bestM / bestN;

		// Program M/N counters
		const mLow = Math.floor(bestM / 2);
		const mHigh = mLow + (bestM % 2);
		const nLow = Math.floor(bestN / 2);
		const nHigh = nLow + (bestN % 2);

		let mnOddByp = ((bestM % 2) << 3) | ((bestN % 2) << 1);
		if (bestM === 1) mnOddByp |= (1 << 2);
		if (bestN === 1) mnOddByp |= 1;

		await this.writeFPGA(FPGA_REG_MN_ODD, mnOddByp);
		await this.writeFPGA(FPGA_REG_N_CNT, (nHigh << 8) | nLow);
		await this.writeFPGA(FPGA_REG_M_CNT, (mHigh << 8) | mLow);

		// Program C counters and bypass flags
		let c7c0Byp = 0x5555; // All bypassed by default
		for (let i = 0; i < clockFreqs.length && i < 8; i++) {
			const C = Math.round(Fvco / clockFreqs[i]);
			const cLow = Math.floor(C / 2);
			const cHigh = cLow + (C % 2);
			if (C !== 1) c7c0Byp &= ~(1 << (i * 2));  // Clear bypass
			c7c0Byp |= (C % 2) << (i * 2 + 1);         // Set odd bit
			await this.writeFPGA(FPGA_REG_C0_CNT + i, (cHigh << 8) | cLow);
		}
		await this.writeFPGA(FPGA_REG_C_ODD0, c7c0Byp);
		await this.writeFPGA(0x0028, 0x5555); // C[15:8] all bypassed

		// Start PLL configuration
		await this.writeFPGA(PLL_WRITE_ADDR, reg23val | 0x01);
		await delay(20);
		await this.writeFPGA(PLL_WRITE_ADDR, reg23val & ~0x01);

		// Phase shifts for clock outputs
		for (let i = 0; i < clockPhases.length; i++) {
			const phase = clockPhases[i];
			if (!phase) continue;
			const C = Math.round(Fvco / clockFreqs[i]);
			const stepDeg = 360.0 / (8.0 * C);
			const nSteps = Math.round(phase / stepDeg);
			if (nSteps === 0) continue;

			const cntInd = (i + 2) & 0x1F;
			let phReg = reg23val & ~0x07;           // Clear start bits
			phReg &= ~(0xF << 8);                   // Clear CNT_IND
			phReg |= (cntInd << 8);
			if (nSteps > 0) phReg |= (1 << 13);     // PHCFG_UPDN

			await this.writeFPGA(PLL_WRITE_ADDR, phReg & ~0x02);
			await this.writeFPGA(0x0024, Math.abs(nSteps));  // Phase count
			await this.writeFPGA(PLL_WRITE_ADDR, phReg);
			await this.writeFPGA(PLL_WRITE_ADDR, phReg | 0x02); // PHCFG_START
			await delay(10);
			await this.writeFPGA(PLL_WRITE_ADDR, phReg & ~0x02);
		}

		console.log(`LimeSDR: FPGA PLL ${pllIndex} configured (M=${bestM}, VCO=${(Fvco/1e6).toFixed(0)} MHz)`);
	}

	// ── Analog Filter Bandwidth ─────────────────────────────────

	async setAnalogBandwidth(bwHz: number): Promise<void> {
		const bw = Math.max(0.5e6, Math.min(bwHz, 40e6));

		// TIA feedback capacitor (0x0112 bits [11:0]): controls TIA bandwidth
		const cfbTia = Math.max(1, Math.min(4095, Math.round(1680e6 / bw - 10)));
		await this.modifyReg(0x0112, 11, 0, cfbTia);

		// LPFL capacitor (0x0116 bits [10:0]): controls LPFL cutoff frequency
		const cCtlLpfl = Math.max(0, Math.min(2047, Math.round(2160e6 / bw - 103)));
		await this.modifyReg(0x0116, 10, 0, cCtlLpfl);

		// LPFL resistance (0x0118 bits [4:0]): lookup table from LimeSuite
		let rccCtlLpfl: number;
		if (cCtlLpfl < 8) rccCtlLpfl = 7;
		else if (cCtlLpfl < 13) rccCtlLpfl = 6;
		else if (cCtlLpfl < 21) rccCtlLpfl = 5;
		else if (cCtlLpfl < 37) rccCtlLpfl = 4;
		else if (cCtlLpfl < 76) rccCtlLpfl = 3;
		else if (cCtlLpfl < 156) rccCtlLpfl = 2;
		else if (cCtlLpfl < 336) rccCtlLpfl = 1;
		else rccCtlLpfl = 0;
		await this.modifyReg(0x0118, 4, 0, rccCtlLpfl);

		// PGA resistance (0x0119 bits [12:8])
		const bwMHz = bw / 1e6;
		const rccCtlPga = Math.max(0, Math.min(31, Math.round(23 - 1.73 * bwMHz)));
		await this.modifyReg(0x0119, 12, 8, rccCtlPga);

		console.log(`LimeSDR: analog BW=${(bw / 1e6).toFixed(1)} MHz`);
	}

	// ── Gain Control ────────────────────────────────────────────

	async setLNAGain(gainDb: number): Promise<void> {
		const regVal = lnaGainToReg(gainDb);
		await this.modifyReg(REG_RFE_GAIN, 9, 6, regVal);
	}

	async setTIAGain(index: number): Promise<void> {
		// index: 0=0dB(reg=1), 1=9dB(reg=2), 2=12dB(reg=3)
		const regVal = Math.max(1, Math.min(3, index + 1));
		await this.modifyReg(REG_RFE_GAIN, 1, 0, regVal);
	}

	async setPGAGain(value: number): Promise<void> {
		// value: 0-31, gain = value - 12 dB
		const clamped = Math.max(0, Math.min(31, value));
		await this.modifyReg(REG_RBB_PGA, 4, 0, clamped);
	}

	async setAntennaPath(index: number): Promise<void> {
		// 0=LNAH, 1=LNAL, 2=LNAW
		const pathMap = [1, 2, 3]; // SEL_PATH_RFE values
		const sel = pathMap[index] ?? 3;

		// Read current register to modify in place
		let reg = await this.readLMS7002(REG_RFE_PATH);
		reg = setBits(reg, 8, 7, sel);                          // SEL_PATH_RFE [8:7]
		reg = setBits(reg, 4, 4, 1);                            // EN_INSHSW_LB2 [4] = 1 (disconnect loopback)
		reg = setBits(reg, 3, 3, 1);                            // EN_INSHSW_LB1 [3] = 1 (disconnect loopback)
		reg = setBits(reg, 2, 2, sel === 2 ? 0 : 1);            // EN_INSHSW_L [2]: 0=connect LNAL
		reg = setBits(reg, 1, 1, sel === 3 ? 0 : 1);            // EN_INSHSW_W [1]: 0=connect LNAW
		await this.writeLMS7002(REG_RFE_PATH, reg);
	}

	// ── Sample Rate ─────────────────────────────────────────────

	async setSampleRate(rate: number): Promise<void> {
		this.currentSampleRate = rate;
		// MIMO mode: need rate * 8 (interface alternates chA/chB each clock)
		await this.setCGENFrequency(rate * 8);
		await this.setAnalogBandwidth(rate);
		await this.configureRxTSP();
		await this.configureLML();
		await this.configureFPGAPLL();
	}

	// ── Streaming ───────────────────────────────────────────────

	async startStreaming(callback: (data: ArrayBufferView) => void): Promise<void> {
		// Follow exact LimeSuite Streamer::Start() sequence:

		// 1. Select FPGA chip
		await this.writeFPGA(FPGA_REG_CHIP_SEL, 0x0001);

		// 2. Stop any existing streaming (clear RX_EN and TX_EN)
		const ctrl = await this.readFPGA(FPGA_REG_CTRL);
		await this.writeFPGA(FPGA_REG_CTRL, ctrl & ~0x03);

		// 3. Reset timestamp counters (pulse: clear→set→clear)
		// SMPL_NR_CLR = bit 0, TXPCT_LOSS_CLR = bit 1 → mask = 0x03
		let reg9 = await this.readFPGA(FPGA_REG_TSTAMP);
		await this.writeFPGA(FPGA_REG_TSTAMP, reg9 & ~0x03);
		await this.writeFPGA(FPGA_REG_TSTAMP, reg9 | 0x03);
		await this.writeFPGA(FPGA_REG_TSTAMP, reg9 & ~0x03);

		// 4. Reset USB streaming FIFOs (0x00 = stream buffer reset)
		await this.sendCommand(0x40, new Uint8Array([0x00]));

		// 5. Configure interface mode: MIMO (0x0100)
		// MIMO mode properly captures I/Q from separate DDR edges
		await this.writeFPGA(FPGA_REG_IFACE, 0x0100);
		await this.writeFPGA(FPGA_REG_CH_EN, 0x0001);  // Channel A only

		// 6. Enable RX streaming only (per LimeSuite StartStreaming — TX_EN not needed)
		const ctrl2 = await this.readFPGA(FPGA_REG_CTRL);
		await this.writeFPGA(FPGA_REG_CTRL, ctrl2 | 0x0001); // RX_EN only

		// 7. Post-start counter pulse (bits 3 and 1, i.e. 5<<1 = 0x0A)
		reg9 = await this.readFPGA(FPGA_REG_TSTAMP);
		await this.writeFPGA(FPGA_REG_TSTAMP, reg9 | (5 << 1));
		await this.writeFPGA(FPGA_REG_TSTAMP, reg9 & ~(5 << 1));

		// 8. Reset LMS7002M logic registers (pulse bits [15:6] of 0x0020)
		const reg20 = await this.readLMS7002(REG_RESET);
		await this.writeLMS7002(REG_RESET, reg20 & ~0xFFC0);  // Assert resets
		await this.writeLMS7002(REG_RESET, reg20 | 0xFFC0);   // Release resets

		// 9. Re-enable RXTSP after logic reset (reset may revert registers)
		await this.configureRxTSP();

		console.log(`LimeSDR: streaming started (${NUM_TRANSFERS} transfers, ${TRANSFER_SIZE} bytes each)`);

		let firstPacketLogged = false;

		const transfer = async (): Promise<void> => {
			// Each concurrent transfer gets its own output buffer (avoids race condition)
			// ch_en=1 MIMO: non-interleaved [I,Q,I,Q,...], 4 bytes per sample
			const samplesPerTransfer = Math.floor(TRANSFER_SIZE / STREAM_PKT_SIZE) * (STREAM_PAYLOAD / 4);
			const outBuf = new Int8Array(samplesPerTransfer * 2);

			await Promise.resolve(); // Yield to event loop
			while (this.rxRunning) {
				try {
					const result = await this.dev.transferIn(EP_STREAM_IN_NUM, TRANSFER_SIZE);
					if (result.status !== 'ok' || !this.rxRunning) break;

					const raw = new Uint8Array(result.data!.buffer, result.data!.byteOffset, result.data!.byteLength);

					// Log first packet for diagnostics
					if (!firstPacketLogged) {
						firstPacketLogged = true;
						const hdr = Array.from(raw.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
						console.log(`LimeSDR: first USB transfer: ${raw.length} bytes, header: ${hdr}`);

						// IQ diagnostic: check if I and Q are independent or identical
						// Per LimeSuite memcpy(complex16_t): word[0]=I, word[1]=Q
						const diagDV = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
						let sumII = 0, sumQQ = 0, sumIQ = 0;
						const pairs: string[] = [];
						const numDiag = Math.min(500, Math.floor((raw.length - STREAM_HDR_SIZE) / 4));
						for (let k = 0; k < numDiag; k++) {
							const off = STREAM_HDR_SIZE + k * 4;
							const iVal = diagDV.getInt16(off,     true);  // word[0] = I
							const qVal = diagDV.getInt16(off + 2, true);  // word[1] = Q
							sumII += iVal * iVal;
							sumQQ += qVal * qVal;
							sumIQ += iVal * qVal;
							if (k < 10) pairs.push(`(I=${iVal},Q=${qVal})`);
						}
						const iRms = Math.sqrt(sumII / numDiag);
						const qRms = Math.sqrt(sumQQ / numDiag);
						const corr = sumII > 0 && sumQQ > 0 ? sumIQ / Math.sqrt(sumII * sumQQ) : 0;
						console.log(`LimeSDR IQ diag: corr=${corr.toFixed(4)}, I_rms=${iRms.toFixed(0)}, Q_rms=${qRms.toFixed(0)}`);
						console.log(`LimeSDR first IQ (word[0]=I, word[1]=Q): ${pairs.join(' ')}`);

						// Auto-calibrate IQ gain balance via RxTSP gain corrector
						const ratio = iRms > 0 && qRms > 0 ? iRms / qRms : 1;
						if (ratio > 1.5 || ratio < 0.67) {
							let gcorrI = 2047, gcorrQ = 2047;
							if (ratio > 1) {
								// I is stronger — reduce I to match Q
								gcorrI = Math.max(1, Math.round(2047 / ratio));
							} else {
								// Q is stronger — reduce Q to match I
								gcorrQ = Math.max(1, Math.round(2047 * ratio));
							}
							try {
								await this.writeLMS7002(0x0402, gcorrI);  // GCORRI
								await this.writeLMS7002(0x0401, gcorrQ);  // GCORRQ
								// Enable gain corrector: clear GC_BYP (bit 1) in 0x040C
								const bypReg = await this.readLMS7002(0x040C);
								await this.writeLMS7002(0x040C, bypReg & ~0x0002);
								console.log(`LimeSDR: IQ auto-cal: GCORRI=${gcorrI}, GCORRQ=${gcorrQ}, ratio=${ratio.toFixed(2)}`);
							} catch (e) {
								console.warn('LimeSDR: IQ auto-cal failed:', e);
							}
						}
					}

					const numPackets = Math.floor(raw.length / STREAM_PKT_SIZE);
					const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

					let outPos = 0;
					for (let pkt = 0; pkt < numPackets; pkt++) {
						const base = pkt * STREAM_PKT_SIZE + STREAM_HDR_SIZE;
						// ch_en=1 MIMO: non-interleaved [I16, Q16, I16, Q16, ...]
						for (let j = 0; j < STREAM_PAYLOAD; j += 4) {
							outBuf[outPos++] = dv.getInt16(base + j,     true) >> 8; // I
							outBuf[outPos++] = dv.getInt16(base + j + 2, true) >> 8; // Q
						}
					}

					if (outPos > 0) {
						callback(outBuf.subarray(0, outPos));
					}
				} catch (e: unknown) {
					if (this.rxRunning) {
						const msg = e instanceof Error ? e.message : String(e);
						console.error('LimeSDR stream error:', msg);
					}
					break;
				}
			}
		};

		this.rxRunning = Array.from({ length: NUM_TRANSFERS }, transfer);
	}

	async stopStreaming(): Promise<void> {
		const transfers = this.rxRunning;
		this.rxRunning = null;

		// Disable RX in FPGA
		try {
			await this.writeFPGA(FPGA_REG_CTRL, 0x0000);
		} catch (_) { /* may fail if USB disconnected */ }

		// Wait for all transfers to complete
		if (transfers) {
			await Promise.allSettled(transfers);
		}
	}
}

// ── LimeSDRDevice (SdrDevice wrapper) ───────────────────────────────

export class LimeSDRDevice implements SdrDevice {
	readonly deviceType = 'limesdr';
	readonly sampleRates = [1e6, 2e6, 5e6, 10e6, 20e6, 30.72e6];
	readonly sampleFormat = 'int8' as const;
	readonly gainControls: GainControl[] = [
		{ name: 'LNA', min: 0, max: 30, step: 1, default: 14, type: 'slider' },
		{ name: 'TIA', min: 0, max: 2, step: 1, default: 2,
			labels: ['0 dB', '9 dB', '12 dB'], type: 'select' },
		{ name: 'PGA', min: 0, max: 31, step: 1, default: 16, type: 'slider' },
		{ name: 'Antenna', min: 0, max: 2, step: 1, default: 1,
			labels: ['LNAH', 'LNAL', 'LNAW'], type: 'select' },
	];

	private lime = new LimeSDR();

	async open(device: USBDevice): Promise<void> {
		await this.lime.open(device);
		await this.lime.initialize();
	}

	async close(): Promise<void> {
		await this.lime.close();
	}

	async getInfo(): Promise<SdrDeviceInfo> {
		return this.lime.getDeviceInfo();
	}

	async setSampleRate(rate: number): Promise<void> {
		await this.lime.setSampleRate(rate);
	}

	async setFrequency(freqHz: number): Promise<void> {
		await this.lime.setFrequencySXR(freqHz);
	}

	async setGain(name: string, value: number): Promise<void> {
		switch (name) {
			case 'LNA': await this.lime.setLNAGain(value); break;
			case 'TIA': await this.lime.setTIAGain(value); break;
			case 'PGA': await this.lime.setPGAGain(value); break;
			case 'Antenna': await this.lime.setAntennaPath(value); break;
			default: console.warn(`LimeSDR: unknown gain "${name}"`);
		}
	}

	async startRx(callback: (data: ArrayBufferView) => void): Promise<void> {
		await this.lime.startStreaming(callback);
	}

	async stopRx(): Promise<void> {
		await this.lime.stopStreaming();
	}
}

// ── Driver Registration ─────────────────────────────────────────────

const LIMESDR_FILTERS: USBDeviceFilter[] = [
	{ vendorId: 0x04b4, productId: 0x00f1 },  // Cypress FX3 (LimeSDR-USB)
	{ vendorId: 0x0403, productId: 0x601f },  // FTDI
	{ vendorId: 0x1d50, productId: 0x6108 },  // Myriad-RF
];

registerDriver({
	type: 'limesdr',
	name: 'LimeSDR-USB',
	filters: LIMESDR_FILTERS,
	create: () => new LimeSDRDevice(),
});
