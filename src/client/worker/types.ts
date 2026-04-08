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

export interface VfoParams {
	freq: number;
	mode: string;
	enabled: boolean;
	deEmphasis: string;
	squelchEnabled: boolean;
	squelchLevel: number;
	lowPass: boolean;
	highPass: boolean;
	bandwidth: number;
	volume: number;
	pocsag: boolean;
	rds: boolean;
	rdsRegion: string;
}

export interface VfoState {
	squelchOpen: boolean;
	pocsagDecoder: any;
	rdsDecoder: any;
	audioQueue: Float32Array;
	audioQueueLen: number;
	lastMode?: string;
	deemphPrev?: number;
	dcAvg?: number;
	agcGain?: number;
	ssbPhase?: number;
	cwTone?: number;
	currentIfRate?: number;
	audioResampler?: any;
	lastBandwidth?: number;
	audioTarget?: Float32Array;
	scratchBuf?: Float32Array;
}

export interface PerfCounters {
	usbCallbacks: number;
	audioCalls: number;
	audioSamplesOut: number;
	dspTimeSum: number;
	dspTimeMax: number;
	inputSamplesSum: number;
	droppedChunks: number;
	msgsSent: number;
	lastReportTime: number;
	lastChunkSize?: number;
	report: PerfReport;
}

export interface PerfReport {
	usbFps: number;
	audioFps: number;
	dspAvgMs: number | string;
	dspMaxMs: number | string;
	audioRate: number;
	inputRate: number;
	dropped: number;
	chunkSize: number;
	msgRate?: number;
}

export interface RxStreamOpts {
	centerFreq: number;
	sampleRate: number;
	fftSize: number;
	gains?: Record<string, number>;
	/** @deprecated Use gains instead */
	lnaGain?: number;
	/** @deprecated Use gains instead */
	vgaGain?: number;
	/** @deprecated Use gains instead */
	ampEnabled?: boolean;
}

export interface RemoteClientState {
	workers: (Worker | null)[];
	params: (VfoParams | null)[];
	audioQueues: { queue: Float32Array; len: number }[];
	mixBuf: Float32Array | null;
	pocsagDecoders: any[];
	rdsDecoders: any[];
	squelchOpen: boolean[];
}

export interface RDSMessage {
	ps?: string;
	rt?: string;
	pi?: string;
	pty?: number;
	ptyLabel?: string;
	tp?: boolean;
	ta?: boolean;
}

export interface POCSAGMessage {
	capcode: number;
	func: number;
	type: 'alpha' | 'tone' | 'numeric';
	text: string;
	baud: number;
}

export interface DeviceOpenOpts {
	vendorId?: number;
	productId?: number;
	serialNumber?: string;
}

/** IF sample rates per demodulation mode */
export const IF_RATES: Record<string, number> = {
	nfm: 50000,
	wfm: 250000,
	am: 15000,
	usb: 24000,
	lsb: 24000,
	dsb: 24000,
	cw: 3000,
	raw: 48000,
};

export const AUDIO_RATE = 48000;
