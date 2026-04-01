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

// ── LMS64C Protocol Constants ────────────────────────────────────
const PACKET_SIZE = 64;
const MAX_PACKET_DATA = 56;

// LMS64C command codes
const CMD_GET_INFO      = 0x00;
const CMD_LMS7002_RST   = 0x20;
const CMD_LMS7002_WR    = 0x21;
const CMD_LMS7002_RD    = 0x22;
const CMD_USB_FIFO_RST  = 0x40;
const CMD_BRDSPI_WR     = 0x55;
const CMD_BRDSPI_RD     = 0x56;

// LMS64C status codes
const STATUS_COMPLETED  = 1;

// USB bulk endpoints for LMS64C control
const CTRL_BULK_OUT     = 0x0F;
const CTRL_BULK_IN      = 0x8F;

// USB bulk endpoint for IQ streaming
const STREAM_BULK_IN    = 0x81;

// ── LMS7002M Register Addresses ──────────────────────────────────
// Top-level
const REG_MAC           = 0x0020;  // Channel select: bits [1:0]

// AFE (Analog Front-End)
const REG_AFE_CFG       = 0x0082;  // EN_G_AFE, PD_AFE, PD_RX_AFE1, etc.

// CGEN (Clock Generator PLL) — from LMS7002M_parameters.h
// Register 0x0086: [15] SPDUP_VCO_CGEN, [14] RESET_N_CGEN, [9] EN_INTONLY_SDM_CGEN,
//                  [2] PD_VCO_CGEN, [1] PD_VCO_COMP_CGEN, [0] EN_G_CGEN
const REG_CGEN_CFG0     = 0x0086;
const REG_CGEN_FRAC_L   = 0x0087;  // FRAC_SDM_CGEN[15:0]
const REG_CGEN_INT      = 0x0088;  // INT_SDM_CGEN[13:4], FRAC_SDM_CGEN_MSB[3:0]
const REG_CGEN_DIV      = 0x0089;  // DIV_OUTCH_CGEN[10:3]
const REG_CGEN_VCO      = 0x008B;  // ICT_VCO_CGEN[13:9], CSW_VCO_CGEN[8:1], COARSE_START_CGEN[0]
const REG_CGEN_COMP     = 0x008C;  // VCO_CMPHO_CGEN[13], VCO_CMPLO_CGEN[12]

// SX (Synthesizer — channel-dependent: SXR when MAC=1, SXT when MAC=2)
// Register 0x011C: [10] EN_DIV2_DIVPROG, [1] PD_VCO, [0] EN_G
const REG_SX_CFG        = 0x011C;  // EN_DIV2_DIVPROG[10], PD_VCO[1], EN_G[0]
const REG_SX_FRAC_L     = 0x011D;  // FRAC_SDM[15:0]
const REG_SX_INT        = 0x011E;  // INT_SDM[13:4], FRAC_SDM_MSB[3:0]
const REG_SX_DIV        = 0x011F;  // DIV_LOCH[8:6]
const REG_SX_VCO_CFG    = 0x0121;  // CSW_VCO[10:3], SEL_VCO[2:1]
const REG_SX_COMP       = 0x0123;  // VCO_CMPHO[13], VCO_CMPLO[12]
const REG_SX_ENABLE     = 0x0124;  // EN_DIR_SXRSXT[4]

// RFE (RX Frontend)
const REG_RFE_CFG1      = 0x010C;  // EN_G_RFE, EN_DIR_RFE
const REG_RFE_CFG2      = 0x010D;  // SEL_PATH_RFE, EN_DCOFF_RXFE_RFE, etc.
const REG_RFE_GAIN      = 0x0113;  // G_LNA_RFE[3:0], G_TIA_RFE[1:0]

// RBB (RX Baseband)
const REG_RBB_CFG1      = 0x0115;  // EN_G_RBB, EN_DIR_RBB
const REG_RBB_PGA       = 0x0119;  // G_PGA_RBB[4:0], RCC_CTL_PGA_RBB

// RXTSP (RX Digital Signal Processing)
const REG_RXTSP_CFG     = 0x0400;  // EN_RXTSP, etc.
const REG_RXTSP_BYPASS  = 0x040C;  // GC_BYP, PH_BYP, DC_BYP, etc.

// LML (LimeLight interface)
// Note: RXEN_A/B, TXEN_A/B are in register 0x0020 (bits 4,5,2,3), NOT 0x0023
const REG_LML_CFG0      = 0x0020;  // RXEN_A[4], RXEN_B[5], TXEN_A[2], TXEN_B[3]

// FPGA registers (accessed via CMD_BRDSPI_WR/RD)
const FPGA_REG_CTRL     = 0x000A;  // RX_EN (bit 0), TX_EN (bit 1)

// VCO frequency ranges (Hz) for SX PLL — [min, max] per band
const SX_VCO_LOW:  [number, number] = [3800e6,  5222e6];
const SX_VCO_MID:  [number, number] = [4961e6,  6754e6];
const SX_VCO_HIGH: [number, number] = [6306e6,  7714e6];
const SX_VCO_RANGES = [SX_VCO_LOW, SX_VCO_MID, SX_VCO_HIGH];

// CGEN VCO range
const CGEN_VCO_MIN = 1930e6;
const CGEN_VCO_MAX = 2940e6;

// Reference clock (default for LimeSDR USB)
const REF_CLK = 30.72e6;

// Match HackRF's 256KB transfer size for fewer callbacks and better USB batching
const TRANSFER_BUFFER_SIZE = 262144;

// ── LMS64C Protocol Layer ────────────────────────────────────────

class LMS64CProtocol {
	private dev: USBDevice;

	constructor(dev: USBDevice) {
		this.dev = dev;
	}

	/** Reset USB streaming FIFOs on the FX3 controller.
	 *  payload=0x01: hard reset (on device open)
	 *  payload=0x00: stream buffer reset (before starting streams)
	 *  Fire-and-forget: the FIFO reset disrupts USB endpoints so the
	 *  response may not arrive cleanly.
	 */
	async resetUSBFIFO(payload: number): Promise<void> {
		const packet = new Uint8Array(PACKET_SIZE);
		packet[0] = CMD_USB_FIFO_RST;
		packet[1] = 0;
		packet[2] = 1;  // 1 block
		packet[3] = 0;
		packet[8] = payload;
		await this.dev.transferOut(CTRL_BULK_OUT & 0x7F, packet);
		// Drain any response — may fail or timeout after FIFO reset
		try {
			await this.dev.transferIn(CTRL_BULK_IN & 0x7F, PACKET_SIZE);
		} catch (_) { /* expected after FIFO reset */ }
	}

	/** Send a command and receive the response. */
	async sendCommand(cmd: number, data?: Uint8Array, blockCount?: number): Promise<Uint8Array> {
		const packet = new Uint8Array(PACKET_SIZE);
		packet[0] = cmd;
		packet[1] = 0;  // status (unused for TX)
		packet[2] = blockCount ?? (data ? Math.ceil(data.length / 4) : 0);
		packet[3] = 0;  // periphID
		// bytes 4-7: reserved

		if (data) {
			packet.set(data.subarray(0, MAX_PACKET_DATA), 8);
		}

		// Send via bulk OUT
		const outResult = await this.dev.transferOut(
			CTRL_BULK_OUT & 0x7F,  // endpoint number without direction bit
			packet,
		);
		if (outResult.status !== 'ok') {
			throw new Error(`LMS64C: bulk OUT failed (status=${outResult.status})`);
		}

		// Read response via bulk IN
		const inResult = await this.dev.transferIn(
			CTRL_BULK_IN & 0x7F,  // endpoint number without direction bit
			PACKET_SIZE,
		);
		if (inResult.status !== 'ok' || !inResult.data) {
			throw new Error(`LMS64C: bulk IN failed (status=${inResult.status})`);
		}

		const response = new Uint8Array(inResult.data.buffer, inResult.data.byteOffset, inResult.data.byteLength);
		if (response[1] !== STATUS_COMPLETED) {
			throw new Error(`LMS64C: command 0x${cmd.toString(16)} failed (status=${response[1]})`);
		}

		return response;
	}

	/** Get device info (firmware version, device type, serial). */
	async getDeviceInfo(): Promise<{ firmware: number; device: number; protocol: number; hardware: number; serial: bigint }> {
		const resp = await this.sendCommand(CMD_GET_INFO);
		const d = resp;

		// Debug: dump the full response to understand byte layout
		const hexDump = Array.from(d.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join(' ');
		console.log(`LimeSDR GET_INFO raw response: ${hexDump}`);

		let serial = BigInt(0);
		for (let i = 0; i < 8; i++) {
			serial = (serial << BigInt(8)) | BigInt(d[18 + i]);
		}
		return {
			firmware: d[8],
			device: d[9],
			protocol: d[10],
			hardware: d[11],
			serial,
		};
	}

	/** Reset LMS7002M chip. level: 0=low, 1=high, 2=pulse */
	async resetLMS7002M(level: number): Promise<void> {
		const data = new Uint8Array(2);
		data[0] = 0;  // LMS_RST_DEACTIVATE=0, LMS_RST_ACTIVATE=1, LMS_RST_PULSE=2
		data[1] = level;
		await this.sendCommand(CMD_LMS7002_RST, data);
	}

	/** Write LMS7002M SPI registers. Up to 14 registers per call. */
	async spiWrite(pairs: [number, number][]): Promise<void> {
		if (pairs.length === 0) return;
		if (pairs.length > 14) {
			// Split into multiple packets
			for (let i = 0; i < pairs.length; i += 14) {
				await this.spiWrite(pairs.slice(i, i + 14));
			}
			return;
		}
		const data = new Uint8Array(pairs.length * 4);
		for (let i = 0; i < pairs.length; i++) {
			const [addr, val] = pairs[i];
			// Write bit (bit 15 of address) = 1
			data[i * 4 + 0] = ((addr >> 8) & 0x7F) | 0x80;
			data[i * 4 + 1] = addr & 0xFF;
			data[i * 4 + 2] = (val >> 8) & 0xFF;
			data[i * 4 + 3] = val & 0xFF;
		}
		await this.sendCommand(CMD_LMS7002_WR, data);
	}

	/** Read LMS7002M SPI registers. Up to 28 registers per call. */
	async spiRead(addrs: number[]): Promise<number[]> {
		if (addrs.length === 0) return [];
		if (addrs.length > 28) {
			const results: number[] = [];
			for (let i = 0; i < addrs.length; i += 28) {
				results.push(...await this.spiRead(addrs.slice(i, i + 28)));
			}
			return results;
		}
		const data = new Uint8Array(addrs.length * 2);
		for (let i = 0; i < addrs.length; i++) {
			data[i * 2 + 0] = (addrs[i] >> 8) & 0x7F;  // No write bit
			data[i * 2 + 1] = addrs[i] & 0xFF;
		}
		// For reads, blockCount = number of registers (each address is 2 bytes)
		const resp = await this.sendCommand(CMD_LMS7002_RD, data, addrs.length);
		const values: number[] = [];
		for (let i = 0; i < addrs.length; i++) {
			values.push((resp[8 + i * 4 + 2] << 8) | resp[8 + i * 4 + 3]);
		}
		return values;
	}

	/** Write a single SPI register. */
	async spiWriteReg(addr: number, value: number): Promise<void> {
		await this.spiWrite([[addr, value]]);
	}

	/** Read a single SPI register. */
	async spiReadReg(addr: number): Promise<number> {
		const [val] = await this.spiRead([addr]);
		return val;
	}

	/** Modify specific bits in a register (read-modify-write). */
	async spiModifyReg(addr: number, mask: number, value: number): Promise<void> {
		const current = await this.spiReadReg(addr);
		await this.spiWriteReg(addr, (current & ~mask) | (value & mask));
	}

	/**
	 * Configure FPGA PLL for the data interface.
	 * Simplified port of LimeSuite FPGA::SetPllFrequency.
	 *
	 * FPGA register map:
	 *   0x0003: PLL control (index, reset, start)
	 *   0x0005: Direct clock bypass
	 *   0x0021: Status (busy bit 0, error bits [14:7])
	 *   0x0025: Phase config
	 *   0x0026: M/N odd/bypass flags
	 *   0x0027: C[7:0] odds/bypasses
	 *   0x0028: C[15:8] odds/bypasses
	 *   0x002A: N high/low counters
	 *   0x002B: M high/low counters
	 *   0x002E+i: C[i] high/low counters
	 */
	async fpgaSetPllFrequency(pllIndex: number, inputFreqHz: number, clockFreqsHz: number[], clockPhasesDeg: number[] = []): Promise<void> {
		// LimeSuite register map: READ from 0x0003, WRITE to 0x0023 (different FPGA addresses!)
		const PLLCFG_START = 0x1;    // bit 0: trigger PLL M/N/C counter load
		const PHCFG_START  = 0x2;    // bit 1: trigger phase shift operation
		const PLLRST_START = 0x4;    // bit 2: trigger PLL reset
		const PHCFG_UPDN   = 1 << 13; // bit 13: phase shift direction
		const PHCFG_MODE   = 1 << 14; // bit 14: phase find mode (0=normal, 1=auto-search)
		const PLL_READ_ADDR  = 0x0003; // read address for PLL control
		const PLL_WRITE_ADDR = 0x0023; // write address for PLL control
		const PHASE_VAL_ADDR = 0x0024; // CNT_PHASE step count
		const STATUS_ADDR    = 0x0021; // busy/done/error status
		const VCO_MIN = 600e6;
		const VCO_MAX = 1300e6;

		// Disable direct clocking for this PLL
		const drctClk = await this.fpgaRead(0x0005);
		await this.fpgaWrite(0x0005, drctClk & ~(1 << pllIndex));

		// Read control register (from 0x0003), set PLL index
		let reg23val = await this.fpgaRead(PLL_READ_ADDR);
		reg23val &= ~(0x1F << 3);     // clear PLL index
		reg23val &= ~PLLCFG_START;    // clear start
		reg23val &= ~PHCFG_START;     // clear phase start
		reg23val &= ~PLLRST_START;    // clear reset
		reg23val &= ~PHCFG_UPDN;     // clear phase direction
		reg23val |= pllIndex << 3;

		// Set phase config enable bit and PLL index
		const reg25 = await this.fpgaRead(0x0025);
		await this.fpgaWrite(0x0025, reg25 | 0x80);
		await this.fpgaWrite(PLL_WRITE_ADDR, reg23val);

		// Reset PLL (write to 0x0023, not 0x0003!)
		await this.fpgaWrite(PLL_WRITE_ADDR, reg23val | PLLRST_START);
		await delay(10);
		await this.fpgaWrite(PLL_WRITE_ADDR, reg23val & ~PLLRST_START);
		// LimeSuite does NOT poll for reset completion on non-QPCIE boards

		// Find best M, N for VCO frequency
		// VCO = inputFreq * M / N, must be in [600, 1300] MHz
		let bestM = 1, bestN = 1, bestDeviation = 1e18;

		for (let testM = 1; testM <= 255; testM++) {
			for (let testN = 1; testN <= 255; testN++) {
				const vco = inputFreqHz * testM / testN;
				if (vco < VCO_MIN || vco > VCO_MAX) continue;

				// Check that all output clocks have reasonable dividers
				let valid = true;
				let deviation = 0;
				for (const clkFreq of clockFreqsHz) {
					const C = Math.round(vco / clkFreq);
					if (C < 1 || C > 255) { valid = false; break; }
					deviation += Math.abs(vco / C - clkFreq);
				}
				if (!valid) continue;

				if (deviation < bestDeviation) {
					bestDeviation = deviation;
					bestM = testM;
					bestN = testN;
				}
				if (deviation === 0) break;
			}
			if (bestDeviation === 0) break;
		}

		const Fvco = inputFreqHz * bestM / bestN;
		console.log(`FPGA PLL ${pllIndex}: M=${bestM}, N=${bestN}, Fvco=${(Fvco / 1e6).toFixed(2)} MHz`);

		// Program M/N
		const nlow = Math.floor(bestN / 2);
		const nhigh = nlow + (bestN % 2);
		const mlow = Math.floor(bestM / 2);
		const mhigh = mlow + (bestM % 2);

		let mnOddByp = ((bestM % 2) << 3) | ((bestN % 2) << 1);
		if (bestM === 1) mnOddByp |= (1 << 2);  // bypass M
		if (bestN === 1) mnOddByp |= 1;          // bypass N

		await this.fpgaWrite(0x0026, mnOddByp);
		await this.fpgaWrite(0x002A, (nhigh << 8) | nlow);
		await this.fpgaWrite(0x002B, (mhigh << 8) | mlow);

		// Program output dividers (C counters) and bypass flags
		let c7_c0_byp = 0x5555;  // all bypassed by default

		for (let i = 0; i < clockFreqsHz.length && i < 8; i++) {
			const C = Math.round(Fvco / clockFreqsHz[i]);
			const clow = Math.floor(C / 2);
			const chigh = clow + (C % 2);

			if (C !== 1) {
				c7_c0_byp &= ~(1 << (i * 2));      // enable (clear bypass bit)
			}
			c7_c0_byp |= (C % 2) << (i * 2 + 1);  // odd bit

			await this.fpgaWrite(0x002E + i, (chigh << 8) | clow);
			console.log(`  Clock ${i}: C=${C}, freq=${(Fvco / C / 1e6).toFixed(2)} MHz`);
		}

		await this.fpgaWrite(0x0027, c7_c0_byp);
		await this.fpgaWrite(0x0028, 0x5555);  // C[15:8] all bypassed

		// Start PLL configuration (write to 0x0023, NOT 0x0003!)
		await this.fpgaWrite(PLL_WRITE_ADDR, reg23val | PLLCFG_START);

		// LimeSuite does NOT poll for PLL lock on non-QPCIE boards (LimeSDR-USB).
		// The FPGA status register 0x0021 behaves differently on LimeSDR-USB.
		// Just allow time for the PLL to settle.
		await delay(20);

		// Check status for informational purposes only (non-blocking)
		const pllStatus = await this.fpgaRead(STATUS_ADDR);
		if (pllStatus & 0x1) {
			console.log(`FPGA PLL ${pllIndex}: locked`);
		} else {
			console.log(`FPGA PLL ${pllIndex}: configured (status=0x${pllStatus.toString(16)})`);
		}

		// Clear start bit
		await this.fpgaWrite(PLL_WRITE_ADDR, reg23val & ~PLLCFG_START);

		// Apply phase shifts via PHCFG block
		// LimeSuite always uses 0x0023/0x0024/0x0021 regardless of PLL index
		// (PLL selection is embedded in reg23val bits [7:3])
		for (let i = 0; i < clockPhasesDeg.length; i++) {
			const phase_deg = clockPhasesDeg[i];
			if (phase_deg === undefined || phase_deg === 0) continue;

			// Phase step size = 360 / (8 * C) degrees
			const C = Math.round(Fvco / clockFreqsHz[i]);
			const Fstep_deg = 360.0 / (8.0 * C);
			const nSteps = Math.floor(0.49 + phase_deg / Fstep_deg);
			if (nSteps === 0) continue;

			const cnt_ind = (i + 2) & 0x1F; // C0=index 2, C1=index 3
			reg23val &= ~PLLCFG_START;       // clear PLL start
			reg23val &= ~(0xF << 8);         // clear CNT_IND
			reg23val &= ~PHCFG_MODE;         // MODE=0 for normal phase shift
			reg23val |= (cnt_ind << 8);

			if (nSteps >= 0) reg23val |= PHCFG_UPDN;
			else reg23val &= ~PHCFG_UPDN;

			// Write: clear start, set step count, set config, trigger
			// LimeSuite does NOT poll for phase completion on non-QPCIE boards
			await this.fpgaWrite(PLL_WRITE_ADDR, reg23val & ~PHCFG_START);
			await this.fpgaWrite(PHASE_VAL_ADDR, Math.abs(nSteps));
			await this.fpgaWrite(PLL_WRITE_ADDR, reg23val);
			await this.fpgaWrite(PLL_WRITE_ADDR, reg23val | PHCFG_START);

			// Small delay for phase shift to complete (no polling needed)
			await delay(10);

			await this.fpgaWrite(PLL_WRITE_ADDR, reg23val & ~PHCFG_START);
		}
	}

	/** Write FPGA register via board SPI. */
	async fpgaWrite(addr: number, value: number): Promise<void> {
		const data = new Uint8Array(4);
		data[0] = ((addr >> 8) & 0x7F) | 0x80;
		data[1] = addr & 0xFF;
		data[2] = (value >> 8) & 0xFF;
		data[3] = value & 0xFF;
		await this.sendCommand(CMD_BRDSPI_WR, data);
	}

	/** Read FPGA register via board SPI. */
	async fpgaRead(addr: number): Promise<number> {
		const data = new Uint8Array(2);
		data[0] = (addr >> 8) & 0x7F;
		data[1] = addr & 0xFF;
		const resp = await this.sendCommand(CMD_BRDSPI_RD, data);
		return (resp[8 + 2] << 8) | resp[8 + 3];
	}
}

// ── LMS7002M Chip Control ────────────────────────────────────────

class LMS7002M {
	private proto: LMS64CProtocol;

	constructor(proto: LMS64CProtocol) {
		this.proto = proto;
	}

	/** Set MAC field to select channel: 1=ChA/SXR, 2=ChB/SXT */
	async setActiveChannel(ch: number): Promise<void> {
		await this.proto.spiModifyReg(REG_MAC, 0x0003, ch & 0x3);
	}

	/** Soft-reset the LMS7002M via pulse on RESET pin. */
	async reset(): Promise<void> {
		await this.proto.resetLMS7002M(2);  // pulse
		await delay(50);
	}

	/** Basic RX initialization: enable channel A, configure digital path. */
	async initRxChannelA(): Promise<void> {
		// Select channel A (MAC=1 for SXR)
		await this.setActiveChannel(1);

		// Enable AFE: power on RX AFE, enable direction
		// Register 0x0082: EN_G_AFE=1, PD_TX_AFE1=1, others 0 (PD_RX_AFE1=0 meaning ON)
		await this.proto.spiWriteReg(REG_AFE_CFG, 0x8001);

		// Enable LML: RXEN_A=1 (bit 4 of register 0x0020)
		await this.proto.spiModifyReg(REG_LML_CFG0, 0x0010, 0x0010);

		// Enable RFE: EN_G_RFE=1 (bit 0), PD_TIA_RFE=0 (bit 1 — MUST be 0!)
		// Register 0x010C bit layout:
		//   [0] EN_G_RFE, [1] PD_TIA_RFE, [2] PD_RSSI, [3] PD_QGEN,
		//   [4] PD_MXLOBUF, [5] PD_RLOOPB_2, [6] PD_RLOOPB_1, [7] PD_LNA
		await this.proto.spiModifyReg(REG_RFE_CFG1, 0x0001, 0x0001);  // EN_G_RFE=1
		// Power on all RFE blocks: clear PD bits [7:1] to 0
		await this.proto.spiModifyReg(REG_RFE_CFG1, 0x00FE, 0x0000);

		// Set RX path: LNAL — best for <700 MHz
		// SEL_PATH_RFE=2[8:7], LB1=disabled[4], LB2=disabled[3],
		// EN_INSHSW_L=0(connected)[2], EN_INSHSW_W=1(shorted)[1]
		await this.proto.spiModifyReg(REG_RFE_CFG2, 0x019E,
			(2 << 7) | (1 << 4) | (1 << 3) | (0 << 2) | (1 << 1));

		// Enable RBB: EN_G_RBB=1 (bit 0)
		await this.proto.spiModifyReg(REG_RBB_CFG1, 0x0001, 0x0001);
		// Power on: PD_LPFH=0(bit 3), PD_LPFL=0(bit 2), PD_PGA=0(bit 4)
		await this.proto.spiModifyReg(REG_RBB_CFG1, 0x001C, 0x0000);

		// Set analog filter bandwidth to match default sample rate
		await this.setAnalogBandwidth(10e6);

		// Enable RXTSP
		await this.proto.spiModifyReg(REG_RXTSP_CFG, 0x0001, 0x0001);  // EN_RXTSP=1

		// Configure RXTSP bypass register (0x040C):
		// DC_BYP=0 (bit 2) — ENABLE DC offset correction (critical to avoid red waterfall)
		// GC_BYP=1 (bit 0), PH_BYP=1 (bit 1) — bypass gain/phase correction (no cal)
		// GFIR1_BYP=1 (bit 3), GFIR2_BYP=1 (bit 4), GFIR3_BYP=1 (bit 5) — bypass FIRs
		// CMIX_BYP=1 (bit 6) — bypass complex mixer
		await this.proto.spiWriteReg(REG_RXTSP_BYPASS, 0x007B);  // all bypassed EXCEPT DC correction

		// Configure DC correction averaging: DCCORR_AVG_RXTSP at register 0x0404 bits [5:3]
		await this.proto.spiModifyReg(0x0404, 0x0038, 0x0007 << 3);  // AVG=7 (max)

		// Verify RXTSP configuration
		const bypassReg = await this.proto.spiReadReg(REG_RXTSP_BYPASS);
		const dcCorrReg = await this.proto.spiReadReg(0x0404);
		const rxtspCfg = await this.proto.spiReadReg(REG_RXTSP_CFG);
		console.log(`LimeSDR: RXTSP verify: CFG(0x400)=0x${rxtspCfg.toString(16)} BYPASS(0x40C)=0x${bypassReg.toString(16)} DCCORR(0x404)=0x${dcCorrReg.toString(16)}`);

		// Enable SXR synthesizer
		await this.setActiveChannel(1);  // MAC=1 selects SXR registers
		await this.proto.spiModifyReg(REG_SX_ENABLE, 0x0010, 0x0010);  // EN_DIR_SXRSXT=1 (bit 4)
		// EN_G=1 (bit 0), PD_VCO=0 (bit 1) in REG_SX_CFG
		await this.proto.spiModifyReg(REG_SX_CFG, 0x0003, 0x0001);

		// Power on remaining RFE blocks (PD_MXLOBUF, PD_QGEN, PD_LNA etc.)
		// Already done above — all PD bits [7:1] cleared to 0
	}

	/**
	 * Program CGEN PLL to set the ADC/DAC clock rate.
	 * cgenFreq = sampleRate * (decimation factor, usually power of 2)
	 * The CGEN VCO range is 1930–2940 MHz.
	 *
	 * Register layout (from LMS7002M_parameters.h):
	 *   0x0086: [15] SPDUP_VCO, [14] RESET_N, [9] EN_INTONLY_SDM,
	 *           [2] PD_VCO, [1] PD_VCO_COMP, [0] EN_G_CGEN
	 *   0x0087: FRAC_SDM_CGEN[15:0]
	 *   0x0088: INT_SDM_CGEN[13:4], FRAC_SDM_CGEN_MSB[3:0]
	 *   0x0089: DIV_OUTCH_CGEN[10:3]
	 *   0x008B: ICT_VCO[13:9], CSW_VCO_CGEN[8:1], COARSE_START[0]
	 *   0x008C: VCO_CMPHO_CGEN[13], VCO_CMPLO_CGEN[12]  (read-only)
	 */
	async setCGENFrequency(freqHz: number): Promise<void> {
		// Ensure CGEN is enabled: EN_G_CGEN=1, PD_VCO=0, PD_VCO_COMP=0, RESET_N=1
		await this.proto.spiModifyReg(REG_CGEN_CFG0, 0x4007, 0x4001);
		// bits: [14]=1 (RESET_N), [2]=0 (PD_VCO off), [1]=0 (PD_VCO_COMP off), [0]=1 (EN_G)

		// Find output divider: VCO = freq * 2 * (DIV+1)
		let divOutch = 0;
		let vcoFreq = 0;
		for (divOutch = 0; divOutch < 256; divOutch++) {
			vcoFreq = freqHz * 2 * (divOutch + 1);
			if (vcoFreq >= CGEN_VCO_MIN && vcoFreq <= CGEN_VCO_MAX) break;
		}
		if (vcoFreq < CGEN_VCO_MIN || vcoFreq > CGEN_VCO_MAX) {
			throw new Error(`CGEN: cannot find valid VCO frequency for ${freqHz} Hz`);
		}

		// Calculate integer and fractional dividers
		const nInt = Math.floor(vcoFreq / REF_CLK) - 1;
		const nFrac = Math.round(((vcoFreq / REF_CLK) - nInt - 1) * (1 << 20));

		// Program CGEN registers
		// 0x0087: FRAC_SDM_CGEN[15:0]
		await this.proto.spiWriteReg(REG_CGEN_FRAC_L, nFrac & 0xFFFF);

		// 0x0088: INT_SDM_CGEN[13:4], FRAC_SDM_CGEN_MSB[3:0]
		const intFracHigh = ((nInt & 0x3FF) << 4) | ((nFrac >> 16) & 0x0F);
		await this.proto.spiWriteReg(REG_CGEN_INT, intFracHigh);

		// 0x0089: DIV_OUTCH_CGEN[10:3]
		await this.proto.spiModifyReg(REG_CGEN_DIV, 0x07F8, (divOutch & 0xFF) << 3);

		// Tune CGEN VCO
		await this.tuneVCO_CGEN();

		console.log(`CGEN: VCO=${(vcoFreq / 1e6).toFixed(2)} MHz, N=${nInt}, FRAC=${nFrac}, DIV=${divOutch}`);
	}

	/**
	 * Program SXR PLL to set the RX local oscillator frequency.
	 * VCO range: 3800–7714 MHz, with output dividers for lower frequencies.
	 */
	/**
	 * Program SXR PLL to set the RX local oscillator frequency.
	 * Register layout (from LMS7002M_parameters.h):
	 *   0x011C: [10] EN_DIV2_DIVPROG, [1] PD_VCO, [0] EN_G
	 *   0x011D: FRAC_SDM[15:0]
	 *   0x011E: INT_SDM[13:4], FRAC_SDM_MSB[3:0]
	 *   0x011F: DIV_LOCH[8:6]
	 *   0x0121: CSW_VCO[10:3], SEL_VCO[2:1]
	 *   0x0123: VCO_CMPHO[13], VCO_CMPLO[12]  (read-only)
	 */
	async setFrequencySXR(freqHz: number): Promise<void> {
		// Clamp to LimeSDR frequency range (30 MHz – 3.8 GHz)
		const clampedFreq = Math.max(30e6, Math.min(freqHz, 3.8e9));
		if (clampedFreq !== freqHz) {
			console.warn(`LimeSDR: frequency ${(freqHz / 1e6).toFixed(3)} MHz out of range, clamped to ${(clampedFreq / 1e6).toFixed(3)} MHz`);
			freqHz = clampedFreq;
		}

		// Select SXR channel
		await this.setActiveChannel(1);

		// Ensure SX PLL is powered on: EN_G=1 (bit 0), PD_VCO=0 (bit 1)
		await this.proto.spiModifyReg(REG_SX_CFG, 0x0003, 0x0001);

		// Find output divider (DIV_LOCH)
		let divLoch = -1;
		let vcoFreq = 0;
		for (let d = 6; d >= 0; d--) {
			vcoFreq = freqHz * (1 << (d + 1));
			if (vcoFreq >= SX_VCO_LOW[0] && vcoFreq <= SX_VCO_HIGH[1]) {
				divLoch = d;
				break;
			}
		}
		if (divLoch < 0) {
			throw new Error(`SXR: frequency ${freqHz} Hz out of range`);
		}

		// EN_DIV2_DIVPROG: additional /2 when VCO > 5.5 GHz
		const enDiv2 = vcoFreq > 5.5e9 ? 1 : 0;
		const refDiv = enDiv2 ? 2 : 1;

		// Integer and fractional dividers
		const nInt = Math.floor(vcoFreq / (REF_CLK * refDiv)) - 4;
		const nFrac = Math.round(((vcoFreq / (REF_CLK * refDiv)) - nInt - 4) * (1 << 20));

		// 0x011C: EN_DIV2_DIVPROG[10], preserve EN_G[0] and PD_VCO[1]
		await this.proto.spiModifyReg(REG_SX_CFG, 0x0400, (enDiv2 & 1) << 10);

		// 0x011D: FRAC_SDM[15:0]
		await this.proto.spiWriteReg(REG_SX_FRAC_L, nFrac & 0xFFFF);

		// 0x011E: INT_SDM[13:4], FRAC_SDM_MSB[3:0]
		const intFracHigh = ((nInt & 0x3FF) << 4) | ((nFrac >> 16) & 0x0F);
		await this.proto.spiWriteReg(REG_SX_INT, intFracHigh);

		// 0x011F: DIV_LOCH[8:6]
		await this.proto.spiModifyReg(REG_SX_DIV, 0x01C0, (divLoch & 7) << 6);

		// Determine best VCO band
		let bestVco = 1;  // default to mid
		for (let v = 0; v < SX_VCO_RANGES.length; v++) {
			if (vcoFreq >= SX_VCO_RANGES[v][0] && vcoFreq <= SX_VCO_RANGES[v][1]) {
				bestVco = v;
				break;
			}
		}

		// Tune SX VCO (tries all 3 VCO bands if needed)
		await this.tuneVCO_SX(bestVco);

		console.log(`SXR: freq=${(freqHz / 1e6).toFixed(3)} MHz, VCO=${(vcoFreq / 1e6).toFixed(2)} MHz, ` +
			`N=${nInt}, FRAC=${nFrac}, DIV_LOCH=${divLoch}, VCO_SEL=${bestVco}`);
	}

	/**
	 * Tune CGEN VCO by sweeping CSW_VCO_CGEN[8:1] in register 0x008B
	 * and reading comparator outputs from register 0x008C bits [13:12].
	 */
	private async tuneVCO_CGEN(): Promise<void> {
		const label = 'CGEN';
		// CSW_VCO_CGEN is in 0x008B bits [8:1] (8-bit value shifted left by 1)
		// VCO_CMPHO_CGEN is 0x008C bit 13, VCO_CMPLO_CGEN is 0x008C bit 12

		console.log(`${label} VCO tune: starting...`);
		const cfg = await this.proto.spiReadReg(REG_CGEN_CFG0);
		console.log(`${label} VCO tune: cfg 0x0086=0x${cfg.toString(16)} (EN_G=${cfg & 1}, PD_VCO=${(cfg >> 2) & 1}, PD_COMP=${(cfg >> 1) & 1})`);

		const result = await this.sweepCSW(
			REG_CGEN_VCO,   // CSW register
			0x01FE,         // CSW mask: bits [8:1]
			1,              // CSW shift: value << 1
			REG_CGEN_COMP,  // Comparator register (0x008C)
			13, 12,         // CMPHO bit, CMPLO bit
			label,
		);

		if (!result) {
			console.warn(`${label} VCO tune: FAILED — using CSW=128`);
			await this.proto.spiModifyReg(REG_CGEN_VCO, 0x01FE, 128 << 1);
		}
	}

	/**
	 * Tune SX VCO by sweeping CSW_VCO[10:3] in register 0x0121
	 * and reading comparator outputs from register 0x0123 bits [13:12].
	 * Tries the preferred VCO band first, then others.
	 */
	private async tuneVCO_SX(preferredVco: number): Promise<void> {
		const label = 'SX';
		// CSW_VCO is in 0x0121 bits [10:3] (8-bit value shifted left by 3)
		// SEL_VCO is in 0x0121 bits [2:1]
		// VCO_CMPHO is 0x0123 bit 13, VCO_CMPLO is 0x0123 bit 12

		const cfg = await this.proto.spiReadReg(REG_SX_CFG);
		console.log(`${label} VCO tune: cfg 0x011C=0x${cfg.toString(16)} (EN_G=${cfg & 1}, PD_VCO=${(cfg >> 1) & 1})`);

		// Try each VCO band, starting with the preferred one
		const vcoOrder = [preferredVco];
		for (let v = 0; v < 3; v++) {
			if (v !== preferredVco) vcoOrder.push(v);
		}

		for (const vco of vcoOrder) {
			// SEL_VCO[2:1]: 0=VCOL, 1=VCOM, 2=VCOH
			await this.proto.spiModifyReg(REG_SX_VCO_CFG, 0x0006, (vco & 3) << 1);
			console.log(`${label} VCO tune: trying VCO band ${vco}...`);

			const result = await this.sweepCSW(
				REG_SX_VCO_CFG,  // CSW register (0x0121)
				0x07F8,          // CSW mask: bits [10:3]
				3,               // CSW shift: value << 3
				REG_SX_COMP,     // Comparator register (0x0123)
				13, 12,          // CMPHO bit, CMPLO bit
				`${label}(VCO${vco})`,
			);

			if (result) return;  // Found lock
		}

		console.warn(`${label} VCO tune: FAILED on all bands — using CSW=128`);
		await this.proto.spiModifyReg(REG_SX_VCO_CFG, 0x07F8, 128 << 3);
	}

	/**
	 * Generic CSW sweep: writes CSW values 0–255 to the specified register field
	 * and reads back comparator outputs. Returns true if lock found.
	 */
	private async sweepCSW(
		cswReg: number, cswMask: number, cswShift: number,
		compReg: number, cmpHiBit: number, cmpLoBit: number,
		label: string,
	): Promise<boolean> {
		let lockStart = -1;
		let lockEnd = -1;

		// Coarse scan (step 4)
		const samples: string[] = [];
		for (let csw = 0; csw <= 255; csw += 4) {
			await this.proto.spiModifyReg(cswReg, cswMask, csw << cswShift);
			await delay(1);
			const comp = await this.proto.spiReadReg(compReg);
			const hi = (comp >> cmpHiBit) & 1;
			const lo = (comp >> cmpLoBit) & 1;
			samples.push(`${csw}:${hi}${lo}`);

			if (hi && lo) {
				if (lockStart < 0) lockStart = csw;
				lockEnd = csw;
			} else if (lockStart >= 0) {
				break;
			}
		}
		console.log(`${label} VCO tune: coarse — ${samples.join(' ')}`);

		// Fine scan if coarse didn't find lock
		if (lockStart < 0) {
			const fineSamples: string[] = [];
			for (let csw = 0; csw <= 255; csw++) {
				await this.proto.spiModifyReg(cswReg, cswMask, csw << cswShift);
				await delay(1);
				const comp = await this.proto.spiReadReg(compReg);
				const hi = (comp >> cmpHiBit) & 1;
				const lo = (comp >> cmpLoBit) & 1;
				if (csw % 32 === 0) fineSamples.push(`${csw}:0x${comp.toString(16)}`);

				if (hi && lo) {
					if (lockStart < 0) lockStart = csw;
					lockEnd = csw;
				} else if (lockStart >= 0) {
					break;
				}
			}
			console.log(`${label} VCO tune: fine — ${fineSamples.join(' ')}`);
		}

		if (lockStart < 0) return false;

		const optimal = Math.round((lockStart + lockEnd) / 2);
		await this.proto.spiModifyReg(cswReg, cswMask, optimal << cswShift);
		console.log(`${label} VCO tune: LOCKED [${lockStart}–${lockEnd}], CSW=${optimal}`);
		return true;
	}

	/**
	 * Set LNA gain (0–15 register value, ~0–30 dB).
	 * G_LNA_RFE is in REG_RFE_GAIN bits [9:6].
	 */
	async setLNAGain(value: number): Promise<void> {
		await this.proto.spiModifyReg(REG_RFE_GAIN, 0x03C0, (value & 0x0F) << 6);
	}

	/**
	 * Set TIA gain (1–3 register value, ~0–12 dB).
	 * G_TIA_RFE is in REG_RFE_GAIN bits [1:0].
	 */
	async setTIAGain(value: number): Promise<void> {
		await this.proto.spiModifyReg(REG_RFE_GAIN, 0x0003, value & 0x03);
	}

	/**
	 * Set PGA gain (0–31 register value, ~-12–19 dB).
	 * G_PGA_RBB is in REG_RBB_PGA[4:0].
	 */
	async setPGAGain(value: number): Promise<void> {
		await this.proto.spiModifyReg(REG_RBB_PGA, 0x001F, value & 0x1F);
	}

	/**
	 * Configure the analog RX bandwidth (TIA + RBB LPFL filters).
	 * Must be called after enabling RBB and whenever sample rate changes.
	 * Approximate formulas from LimeSuite's TuneRxFilterSetup:
	 *   CFB_TIA_RFE (0x0112 [11:0]) ≈ 1680e6 / bwHz - 10
	 *   C_CTL_LPFL_RBB (0x0116 [10:0]) ≈ 2160e6 / bwHz - 103
	 *   RCC_CTL_LPFL_RBB (0x0118 [4:0]) = lookup based on C_CTL
	 *   RCC_CTL_PGA_RBB (0x0119 [12:8]) ≈ 23 - 1.73 * bwMHz
	 */
	async setAnalogBandwidth(bwHz: number): Promise<void> {
		// Clamp bandwidth: LPFL supports ~0.5–40 MHz
		const bw = Math.max(0.5e6, Math.min(bwHz, 40e6));

		// TIA feedback capacitor: controls TIA bandwidth
		const cfbTia = Math.max(1, Math.min(4095, Math.round(1680e6 / bw - 10)));
		await this.proto.spiModifyReg(0x0112, 0x0FFF, cfbTia);

		// LPFL capacitor: controls LPFL cutoff frequency
		const cCtlLpfl = Math.max(0, Math.min(2047, Math.round(2160e6 / bw - 103)));
		await this.proto.spiModifyReg(0x0116, 0x07FF, cCtlLpfl);

		// LPFL resistance: lookup table from LimeSuite
		let rccCtlLpfl: number;
		if (cCtlLpfl < 8) rccCtlLpfl = 7;
		else if (cCtlLpfl < 13) rccCtlLpfl = 6;
		else if (cCtlLpfl < 21) rccCtlLpfl = 5;
		else if (cCtlLpfl < 37) rccCtlLpfl = 4;
		else if (cCtlLpfl < 76) rccCtlLpfl = 3;
		else if (cCtlLpfl < 156) rccCtlLpfl = 2;
		else if (cCtlLpfl < 336) rccCtlLpfl = 1;
		else rccCtlLpfl = 0;
		await this.proto.spiModifyReg(0x0118, 0x001F, rccCtlLpfl);

		// PGA resistance
		const bwMHz = bw / 1e6;
		const rccCtlPga = Math.max(0, Math.min(31, Math.round(23 - 1.73 * bwMHz)));
		await this.proto.spiModifyReg(0x0119, 0x1F00, rccCtlPga << 8);

		console.log(`LimeSDR: analog BW=${(bw / 1e6).toFixed(1)} MHz — CFB_TIA=${cfbTia}, C_LPFL=${cCtlLpfl}, RCC_LPFL=${rccCtlLpfl}, RCC_PGA=${rccCtlPga}`);
	}

	/**
	 * Set RX antenna path, including input switches.
	 * path: 0=LNAW (wideband), 1=LNAL (low, <700MHz), 2=LNAH (high)
	 *
	 * Register 0x010D bits:
	 *   [8:7] SEL_PATH_RFE: 1=LNAH, 2=LNAL, 3=LNAW
	 *   [4]   EN_INSHSW_LB1_RFE: loopback 1 switch (1=disabled)
	 *   [3]   EN_INSHSW_LB2_RFE: loopback 2 switch (1=disabled)
	 *   [2]   EN_INSHSW_L_RFE: LNAL input switch (0=connected, 1=shorted)
	 *   [1]   EN_INSHSW_W_RFE: LNAW input switch (0=connected, 1=shorted)
	 */
	async setAntennaPath(path: number): Promise<void> {
		// SEL_PATH_RFE values and input switch config per path
		// Switches: 0 = active/connected, 1 = disabled/shorted
		const configs: Record<number, { sel: number; swL: number; swW: number }> = {
			0: { sel: 3, swL: 1, swW: 0 },  // LNAW: connect W, disconnect L
			1: { sel: 2, swL: 0, swW: 1 },  // LNAL: connect L, disconnect W
			2: { sel: 1, swL: 1, swW: 1 },  // LNAH: disconnect both (uses separate input)
		};
		const cfg = configs[path] ?? configs[0];

		// Set SEL_PATH_RFE[8:7], EN_INSHSW_LB1[4]=1, EN_INSHSW_LB2[3]=1,
		// EN_INSHSW_L[2], EN_INSHSW_W[1]
		const val = ((cfg.sel & 3) << 7) | (1 << 4) | (1 << 3) | (cfg.swL << 2) | (cfg.swW << 1);
		await this.proto.spiModifyReg(REG_RFE_CFG2, 0x019E, val);
	}
}

// ── LimeSDR Device (SdrDevice Implementation) ───────────────────

export class LimeSDRDevice implements SdrDevice {
	readonly deviceType = 'limesdr';
	readonly sampleRates = [
		1000000, 2000000, 4000000, 5000000,
		8000000, 10000000, 15000000, 20000000, 30000000,
	];
	readonly sampleFormat = 'int8' as const;
	readonly gainControls: GainControl[] = [
		{ name: 'LNA', min: 1, max: 15, step: 1, default: 9, type: 'slider' },
		{ name: 'TIA', min: 1, max: 3, step: 1, default: 3, type: 'slider' },
		{ name: 'PGA', min: 0, max: 31, step: 1, default: 16, type: 'slider' },
		// Antenna path selection
		{ name: 'Antenna', min: 0, max: 2, step: 1, default: 1, type: 'select',
		  labels: ['LNAW (Wideband)', 'LNAL (Low <700MHz)', 'LNAH (High >700MHz)'] },
	];

	private dev!: USBDevice;
	private proto!: LMS64CProtocol;
	private lms!: LMS7002M;
	private currentSampleRate = 10000000;
	private rxRunning: Promise<void>[] | null = null;

	async open(device: USBDevice): Promise<void> {
		this.dev = device;

		console.log('LimeSDR: USB device info:', {
			vendorId: '0x' + device.vendorId.toString(16).padStart(4, '0'),
			productId: '0x' + device.productId.toString(16).padStart(4, '0'),
			productName: device.productName,
			serialNumber: device.serialNumber,
			configuration: device.configuration,
		});

		console.log('LimeSDR: calling device.open()...');
		try {
			await device.open();
		} catch (e) {
			console.error('LimeSDR: device.open() failed:', e);
			console.error('LimeSDR: This usually means another application (LimeSuiteGUI, SDR++, etc.) has the device open, or a WinUSB/libusb driver is not installed.');
			throw e;
		}
		console.log('LimeSDR: device opened successfully');

		// LimeSDR USB uses interface 0 for all communication
		console.log('LimeSDR: current configuration:', device.configuration);
		if (device.configuration === null) {
			console.log('LimeSDR: selecting configuration 1...');
			await device.selectConfiguration(1);
		}

		console.log('LimeSDR: claiming interface 0...');
		try {
			await device.claimInterface(0);
		} catch (e) {
			console.error('LimeSDR: claimInterface(0) failed:', e);
			console.error('LimeSDR: The interface may be claimed by another driver or application.');
			throw e;
		}
		console.log('LimeSDR: interface 0 claimed');

		// Enumerate endpoints for debugging
		if (device.configuration) {
			for (const iface of device.configuration.interfaces) {
				for (const alt of iface.alternates) {
					console.log(`LimeSDR: interface ${iface.interfaceNumber} alt ${alt.alternateSetting}: ${alt.endpoints.length} endpoints`);
					for (const ep of alt.endpoints) {
						console.log(`  EP ${ep.endpointNumber} ${ep.direction} ${ep.type} packetSize=${ep.packetSize}`);
					}
				}
			}
		}

		this.proto = new LMS64CProtocol(device);
		this.lms = new LMS7002M(this.proto);

		// Hard-reset the FX3 USB streaming FIFOs (LimeSuite does this on open)
		console.log('LimeSDR: resetting USB FIFOs...');
		await this.proto.resetUSBFIFO(0x01);

		// FPGA register 0x0013 (LMS1 control pins) defaults are CORRECT:
		// TXNRX1=1 (Port 1/DIQ1 = TX input to LMS), TXNRX2=0 (Port 2/DIQ2 = RX output from LMS)
		// In gateware: DIQ2 → lms7002_ddin (FPGA RX input), DIQ1 → lms7002_ddout (FPGA TX output)

		// Reset and initialize
		console.log('LimeSDR: resetting LMS7002M...');
		await this.lms.reset();
		await delay(50);

		console.log('LimeSDR: initializing RX channel A...');
		await this.lms.initRxChannelA();

		// Configure LML (LimeLight) interface registers
		// Values matched to LimeSuite LMS7_Device::Init() defaults

		// 0x0021: Pad pull-ups and SPI mode (4-wire)
		await this.proto.spiWriteReg(0x0021, 0x0E9F);

		// 0x0022: DIQ pad control. Enable SISO DDR on both ports (bits 14,12 = 1).
		// SISO DDR doubles the per-channel data rate: I on rising edge, Q on falling.
		// Without SISO DDR, MIMO mode halves the channel A rate (interleaved A/B slots).
		await this.proto.spiWriteReg(0x0022, 0x5FFF);

		// 0x0023: LML direction/mode/routing — CRITICAL register!
		// TRXIQ mode (bit 0=0): TX and RX data are time-multiplexed on the same port.
		// The FPGA receives RX data interleaved with TX on port 2 (DIQ2).
		// LimeSuite Init: 0x5550 — this is the correct value for TRXIQ mode.
		await this.proto.spiWriteReg(0x0023, 0x5550);

		// 0x0024, 0x0027: Sample position mapping (default: AI=0, AQ=1, BI=2, BQ=3)
		await this.proto.spiWriteReg(0x0024, 0xE4E4);
		await this.proto.spiWriteReg(0x0027, 0xE4E4);

		// Set RXTSP decimation to bypass (HBD_OVR_RXTSP = 7 means bypass)
		await this.proto.spiModifyReg(0x0403, 0x7000, 0x7000);

		// 0x002A: FIFO clock mux routing
		// TXRDCLK_MUX[7:6]=2 (TXTSPCLK), TXWRCLK_MUX[5:4]=0 (FCLK1)
		// RXRDCLK_MUX[3:2]=1 (FCLK2), RXWRCLK_MUX[1:0]=2 (RXTSPCLK)
		// RX_MUX[11:10]=0 (RxTSP), TX_MUX[9:8]=0 (Port1)
		await this.proto.spiWriteReg(0x002A, 0x0086);

		// Enable RXTSP and TXTSP (needed for MCLK clock generation)
		await this.proto.spiModifyReg(0x0400, 0x0001, 0x0001); // EN_RXTSP=1
		await this.proto.spiModifyReg(0x0200, 0x0001, 0x0001); // EN_TXTSP=1

		// 0x002B: MCLK source configuration — BOTH sources are in this register!
		// LimeSuite Init: 0x0038
		// MCLK1SRC[3:2]=2 (TXTSPCLKA_DIV) — TX clock for Port 1/DIQ1
		// MCLK2SRC[5:4]=3 (RXTSPCLKA_DIV) — RX clock for Port 2/DIQ2
		await this.proto.spiWriteReg(0x002B, 0x0038);

		// 0x002C: TSP clock dividers (LimeSuite Init: 0x0000)
		await this.proto.spiWriteReg(0x002C, 0x0000);

		// Debug: read back LML registers to verify
		const lmlRegs = await this.proto.spiRead([0x0020, 0x0021, 0x0022, 0x0023, 0x0024, 0x0027, 0x002A, 0x002B, 0x002C]);
		console.log('LimeSDR: LML registers after config:',
			lmlRegs.map((v, i) => `0x${[0x20,0x21,0x22,0x23,0x24,0x27,0x2A,0x2B,0x2C][i].toString(16)}=0x${v.toString(16)}`).join(' '));

		// Pulse LML FIFO reset: clear bits, then set back to 1
		// Register 0x0020: SRST_RXFIFO[7], LRST_RX_A[9], MRST_RX_A[8]
		const reg20 = await this.proto.spiReadReg(0x0020);
		await this.proto.spiWriteReg(0x0020, reg20 & ~0x0380);  // Clear FIFO/logic/mem reset bits
		await this.proto.spiWriteReg(0x0020, reg20 | 0x0380);   // Set them back (not in reset)

		// Set default sample rate (CGEN)
		// LimeSuite bypass mode: CGEN = sampleRate × 4 (ADC = CGEN/4 = sampleRate)
		console.log('LimeSDR: setting CGEN frequency...');
		await this.lms.setCGENFrequency(this.currentSampleRate * 4);

		// Configure FPGA for RX streaming
		console.log('LimeSDR: configuring FPGA...');

		// Phase alignment for DDR data capture — LimeSuite formula (non-search path)
		// Only clock 1 of each PLL gets a phase shift (clock 0 = reference, clock 1 = data latch)
		const rxPhase = 89.46 + 1.24e-6 * this.currentSampleRate;
		const txPhase = 89.61 + 2.71e-7 * this.currentSampleRate;

		// Configure FPGA TX PLL (index 0)
		console.log(`LimeSDR: configuring FPGA TX PLL at ${(this.currentSampleRate / 1e6).toFixed(2)} MHz...`);
		await this.proto.fpgaSetPllFrequency(0, this.currentSampleRate, [this.currentSampleRate, this.currentSampleRate], [0, txPhase]);

		// Configure FPGA RX PLL (index 1)
		console.log(`LimeSDR: configuring FPGA RX PLL at ${(this.currentSampleRate / 1e6).toFixed(2)} MHz...`);
		await this.proto.fpgaSetPllFrequency(1, this.currentSampleRate, [this.currentSampleRate, this.currentSampleRate], [0, rxPhase]);

		// Select chip 0 — register 0xFFFF selects which chip to configure
		await this.proto.fpgaWrite(0xFFFF, 1 << 0);  // chipId=0
		// Stop any ongoing streaming first
		await this.proto.fpgaWrite(FPGA_REG_CTRL, 0x0000);

		console.log('LimeSDR: initialized successfully');
	}

	async close(): Promise<void> {
		await this.stopRx();
		try {
			// Disable streaming
			const ctrl = await this.proto.fpgaRead(FPGA_REG_CTRL);
			await this.proto.fpgaWrite(FPGA_REG_CTRL, ctrl & ~0x03);
		} catch (_) { /* ignore */ }
		try { await this.dev.close(); } catch (_) { /* ignore */ }
	}

	async getInfo(): Promise<SdrDeviceInfo> {
		const info = await this.proto.getDeviceInfo();
		const deviceNames: Record<number, string> = {
			5: 'LimeSDR-USB',
			4: 'LimeSDR-Mini',
			10: 'LimeSDR-Mini v2',
			14: 'LimeNET-Micro',
		};
		const name = deviceNames[info.device] || `LimeSDR (type ${info.device})`;
		const serial = info.serial.toString(16).padStart(16, '0');
		const firmware = `FW:${info.firmware} HW:${info.hardware} PROTO:${info.protocol}`;

		console.log(`LimeSDR: ${name}, Serial: ${serial}, ${firmware}`);
		return { name, serial, firmware };
	}

	async setSampleRate(rate: number): Promise<void> {
		this.currentSampleRate = rate;
		// LimeSuite bypass mode: CGEN = sampleRate × 4
		// With default EN_ADCCLKH_CLKGN=1, CLKH_OV_CLKL_CGEN=0:
		//   RX TSP ref = clklfreq/4 = (CGEN/1)/4 = CGEN/4 = sampleRate
		await this.lms.setCGENFrequency(rate * 4);

		// Reconfigure analog filter bandwidth to match new sample rate
		await this.lms.setAnalogBandwidth(rate);
		// Reconfigure both FPGA PLLs to match new rate WITH phase alignment
		// MCLK2 = CGEN/4 = rate, so FPGA PLL reference = rate
		// Phase formula from LimeSuite SetInterfaceFreq (non-search path):
		// Only Clock 1 of each PLL needs phase shift for DDR data capture
		const rxPhase = 89.46 + 1.24e-6 * rate;
		const txPhase = 89.61 + 2.71e-7 * rate;
		await this.proto.fpgaSetPllFrequency(0, rate, [rate, rate], [0, txPhase]);
		await this.proto.fpgaSetPllFrequency(1, rate, [rate, rate], [0, rxPhase]);
	}

	async setFrequency(freqHz: number): Promise<void> {
		await this.lms.setFrequencySXR(freqHz);
	}

	async setGain(name: string, value: number): Promise<void> {
		// Ensure we're writing to channel A registers
		await this.lms.setActiveChannel(1);
		switch (name) {
			case 'LNA':
				await this.lms.setLNAGain(value);
				break;
			case 'TIA':
				await this.lms.setTIAGain(value);
				break;
			case 'PGA':
				await this.lms.setPGAGain(value);
				break;
			case 'Antenna':
				await this.lms.setAntennaPath(value);
				break;
			default:
				console.warn(`LimeSDR: unknown gain "${name}"`);
				return;
		}
		// Readback ALL gain-related registers to verify writes
		const reg0113 = await this.proto.spiReadReg(0x0113);
		const reg0119 = await this.proto.spiReadReg(0x0119);
		const reg010C = await this.proto.spiReadReg(0x010C);
		const reg010D = await this.proto.spiReadReg(0x010D);
		const lna = (reg0113 >> 6) & 0xF;
		const tia = reg0113 & 0x3;
		const pga = reg0119 & 0x1F;
		const sel = (reg010D >> 7) & 0x3;
		const swL = (reg010D >> 2) & 1;
		const swW = (reg010D >> 1) & 1;
		console.log(`LimeSDR: setGain(${name}=${value}) → ` +
			`LNA=${lna} TIA=${tia} PGA=${pga} PATH=${sel} swL=${swL} swW=${swW} | ` +
			`0x0113=0x${reg0113.toString(16)} 0x0119=0x${reg0119.toString(16)} ` +
			`0x010C=0x${reg010C.toString(16)} 0x010D=0x${reg010D.toString(16)}`);
	}

	async startRx(callback: (data: ArrayBufferView) => void): Promise<void> {
		if (this.rxRunning) await this.stopRx();

		console.log('LimeSDR: startRx — configuring FPGA streaming...');

		// Select chip 0
		await this.proto.fpgaWrite(0xFFFF, 1 << 0);

		// Stop any existing streaming
		await this.proto.fpgaWrite(FPGA_REG_CTRL, 0x0000);

		// Reset timestamp (0x0009 bits 0 and 1)
		let reg9 = await this.proto.fpgaRead(0x0009);
		await this.proto.fpgaWrite(0x0009, reg9 | 3);
		await this.proto.fpgaWrite(0x0009, reg9 & ~3);

		// Reset USB streaming FIFOs (0x00 means stream buffer reset, LimeSuite requires this)
		await this.proto.resetUSBFIFO(0x00);

		// Set interface mode — MUST match LMS7002M SISODDR setting!
		// SISODDR=1 (reg 0x0022 bits 14,12) → FPGA uses SISO DDR mode (0x0040)
		// In SISO DDR: full clock rate dedicated to channel A (no MIMO halving)
		// smpl_width[1:0]=00 for 16-bit samples
		await this.proto.fpgaWrite(0x0008, 0x0040);

		// Enable channel A (Single channel mode)
		await this.proto.fpgaWrite(0x0007, 0x0001);

		// Enable RX (and TX) streaming (set RX_EN bit 0, TX_EN bit 1)
		// LimeSuite's StartStreaming unconditionally writes 0x3 to this register.
		const ctrl = await this.proto.fpgaRead(FPGA_REG_CTRL);
		await this.proto.fpgaWrite(FPGA_REG_CTRL, ctrl | 0x0003);
		console.log('LimeSDR: startRx — streaming enabled, CTRL=0x' + ((ctrl | 3).toString(16)));

		// Reset pulse on register 0x0009 (bits 1 and 3) — matches LimeSuite
		reg9 = await this.proto.fpgaRead(0x0009);
		await this.proto.fpgaWrite(0x0009, reg9 | (5 << 1));
		await this.proto.fpgaWrite(0x0009, reg9 & ~(5 << 1));

		// Reset LMS7002M Logic Registers — must pulse ALL reset bits [15:6]
		// LimeSuite: clear bits [15:6] (assert reset), then set them (release reset)
		const reg20 = await this.proto.spiReadReg(0x0020);
		await this.proto.spiWriteReg(0x0020, reg20 & ~0xFFC0);  // assert all resets
		await this.proto.spiWriteReg(0x0020, reg20 | 0xFFC0);   // release all resets

		// Re-apply RXTSP configuration AFTER logic reset (reset reverts registers!)
		await this.proto.spiModifyReg(REG_RXTSP_CFG, 0x0001, 0x0001);  // EN_RXTSP=1
		// DC_BYP=0 (bit 2): ENABLE DC correction; bypass everything else
		await this.proto.spiWriteReg(REG_RXTSP_BYPASS, 0x007B);
		// DCCORR_AVG_RXTSP[2:0] at register 0x0404 bits [5:3] (NOT 0x040E!)
		await this.proto.spiModifyReg(0x0404, 0x0038, 0x0007 << 3);  // AVG=7 (max)

		// Verify RXTSP state after reset+reconfig
		const postResetBypass = await this.proto.spiReadReg(REG_RXTSP_BYPASS);
		const postResetDccorr = await this.proto.spiReadReg(0x0404);
		console.log(`LimeSDR: RXTSP post-reset: BYPASS=0x${postResetBypass.toString(16)} DCCORR(0x404)=0x${postResetDccorr.toString(16)}`);

		// Debug: read back all streaming-related FPGA registers
		const dbgRegs = [0x0007, 0x0008, 0x0009, 0x000A, 0xFFFF];
		for (const addr of dbgRegs) {
			const val = await this.proto.fpgaRead(addr);
			console.log(`LimeSDR: FPGA reg 0x${addr.toString(16).padStart(4, '0')} = 0x${val.toString(16).padStart(4, '0')}`);
		}

		// Diagnostic: dump critical register state before attempting transfer
		console.log('LimeSDR: === PRE-TRANSFER DIAGNOSTICS ===');
		// LMS7002M registers (max 14 per spiRead due to 64-byte LMS64C packet limit)
		const diagBatch1 = await this.proto.spiRead([0x0020, 0x0022, 0x0023, 0x002A, 0x002B, 0x002C, 0x002E]);
		const names1 = ['MAC/EN', 'SISODDR', 'LML_DIR', 'CLK_MUX', 'MCLK', 'TSP_DIV', 'MIMO'];
		const addrs1 = [0x0020, 0x0022, 0x0023, 0x002A, 0x002B, 0x002C, 0x002E];
		console.log('LimeSDR: LMS[1]: ' + diagBatch1.map((v, i) =>
			`${names1[i]}(${addrs1[i].toString(16)})=0x${v.toString(16).padStart(4, '0')}`).join(' '));
		const diagBatch2 = await this.proto.spiRead([0x0082, 0x0400, 0x040C, 0x0404, 0x010C, 0x010D, 0x0113]);
		const names2 = ['AFE', 'RXTSP_CFG', 'RXTSP_BYP', 'RXTSP_DC', 'RFE_PD', 'RFE_PATH', 'RFE_GAIN'];
		const addrs2 = [0x0082, 0x0400, 0x040C, 0x0404, 0x010C, 0x010D, 0x0113];
		console.log('LimeSDR: LMS[2]: ' + diagBatch2.map((v, i) =>
			`${names2[i]}(${addrs2[i].toString(16)})=0x${v.toString(16).padStart(4, '0')}`).join(' '));

		// FPGA registers (including 0x0013 for TXNRX pin state)
		const diagFpga = [0x0003, 0x0005, 0x0007, 0x0008, 0x0009, 0x000A, 0x0013, 0xFFFF];
		const fpgaVals: number[] = [];
		for (const a of diagFpga) fpgaVals.push(await this.proto.fpgaRead(a));
		console.log('LimeSDR: FPGA: ' + fpgaVals.map((v, i) =>
			`0x${diagFpga[i].toString(16).padStart(4, '0')}=0x${v.toString(16).padStart(4, '0')}`).join(' '));
		console.log('LimeSDR: === END DIAGNOSTICS ===');

		// Try transfer on EP 1 (stream endpoint)
		const epNum = STREAM_BULK_IN & 0x7F;  // endpoint number = 1

		console.log(`LimeSDR: attempting test transferIn on EP ${epNum}...`);
		try {
			const testResult = await Promise.race([
				(this.dev as any).transferIn(epNum, 65536),
				new Promise<null>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
			]);
			if (testResult && 'data' in testResult && testResult.data) {
				const d = testResult.data;
				const bytes = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
				const hdr = Array.from(bytes.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
				console.log(`LimeSDR: test transfer OK — ${bytes.length} bytes, header: ${hdr}`);
			} else {
				console.warn('LimeSDR: test transfer returned empty result');
			}
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			console.warn(`LimeSDR: test transfer failed: ${msg}`);
		}

		// LimeSDR packet constants
		const PACKET_SZ = 4096;
		const HDR_SZ = 16;
		const PAYLOAD_SZ = PACKET_SZ - HDR_SZ;  // 4080
		const MAX_PACKETS = TRANSFER_BUFFER_SIZE / PACKET_SZ;

		// Launch parallel bulk transfers
		let transferCount = 0;

		const makeTransferLoop = () => {
			// Pre-allocate output buffer: each packet has PAYLOAD_SZ/2 int8 samples
			const loopOutI8 = new Int8Array(MAX_PACKETS * PAYLOAD_SZ / 2);

			return async (): Promise<void> => {
				await Promise.resolve();
				while (this.rxRunning) {
					try {
						const result = await this.dev.transferIn(epNum, TRANSFER_BUFFER_SIZE);
						if (result.status !== 'ok' || !result.data) {
							console.warn(`LimeSDR: transferIn status=${result.status}, data=${!!result.data}`);
							break;
						}

						const raw = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
						const numPackets = Math.floor(raw.length / PACKET_SZ);

						// Diagnostic: log sample statistics for first few transfers
						if (transferCount < 3) {
							const header = Array.from(raw.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
							// Read first packet payload as int16 for diagnostics
							const diagView = new DataView(raw.buffer, raw.byteOffset + HDR_SZ, PAYLOAD_SZ);
							const first8 = Array.from({ length: 8 }, (_, i) => diagView.getInt16(i * 2, true)).join(', ');
							console.log(`LimeSDR: transfer #${transferCount}, ${raw.length} bytes, header: ${header} | first8: [${first8}]`);
							transferCount++;
						}

						// Int16→Int8: convert 12-bit samples (in 16-bit LE containers)
						// to 8-bit by right-shifting by 4. This maps the 12-bit range
						// (±2048) to the full int8 range (±128), preserving dynamic range.
						// The old approach (>> 8, taking high byte) lost 4 bits of precision.
						const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
						let outPos = 0;
						for (let pkt = 0; pkt < numPackets; pkt++) {
							const base = pkt * PACKET_SZ + HDR_SZ;
							for (let j = 0; j < PAYLOAD_SZ; j += 2) {
								loopOutI8[outPos++] = dv.getInt16(base + j, true) >> 4;
							}
						}

						callback(new Uint8Array(loopOutI8.buffer, 0, outPos));
					} catch (e: unknown) {
						if (this.rxRunning) {
							const msg = e instanceof Error ? e.message : String(e);
							console.error('LimeSDR: transfer error:', msg);
						}
						break;
					}
				}
			};
		};

		// 8 concurrent transfers, each with its own buffers (matches HackRF)
		this.rxRunning = Array.from({ length: 8 }, () => makeTransferLoop()());
	}

	async stopRx(): Promise<void> {
		if (this.rxRunning) {
			const promises = this.rxRunning;
			this.rxRunning = null;
			try { await Promise.allSettled(promises); } catch (_) { /* ignore */ }
		}
		try {
			const ctrl = await this.proto.fpgaRead(FPGA_REG_CTRL);
			await this.proto.fpgaWrite(FPGA_REG_CTRL, ctrl & ~0x03);
		} catch (_) { /* ignore */ }
	}
}

// ── Utility ──────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// ── USB VID/PID filters ──────────────────────────────────────────

const LIMESDR_FILTERS: USBDeviceFilter[] = [
	{ vendorId: 0x04B4, productId: 0x00F1 },  // LimeSDR USB (FX3 initialized)
	{ vendorId: 0x04B4, productId: 0x00F3 },  // LimeSDR USB (FX3 bootloader)
	{ vendorId: 0x1D50, productId: 0x6108 },  // LimeSDR (OpenMoko VID)
];

// ── Register driver ──────────────────────────────────────────────

registerDriver({
	type: 'limesdr',
	name: 'LimeSDR',
	filters: LIMESDR_FILTERS,
	create: () => new LimeSDRDevice(),
});
