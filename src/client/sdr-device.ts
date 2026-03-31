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

export interface GainControl {
	name: string;
	min: number;
	max: number;
	step: number;
	default: number;
	options?: number[];
	type: 'slider' | 'checkbox';
}

export interface SdrDeviceInfo {
	name: string;
	serial?: string;
	firmware?: string;
}

export interface SdrDevice {
	readonly deviceType: string;
	readonly sampleRates: number[];
	readonly gainControls: GainControl[];
	readonly sampleFormat: 'int8' | 'uint8' | 'int16' | 'float32';

	open(device: USBDevice): Promise<void>;
	close(): Promise<void>;
	getInfo(): Promise<SdrDeviceInfo>;

	setSampleRate(rate: number): Promise<void>;
	setFrequency(freqHz: number): Promise<void>;
	setGain(name: string, value: number): Promise<void>;
	setGains?(gains: Record<string, number>): Promise<void>;
	setBandwidth?(bwHz: number): Promise<void>;

	startRx(callback: (data: ArrayBufferView) => void): Promise<void>;
	stopRx(): Promise<void>;
}

export interface DeviceCapabilities {
	deviceType: string;
	sampleRates: number[];
	gainControls: GainControl[];
	sampleFormat: 'int8' | 'uint8' | 'int16' | 'float32';
}

export interface SdrDriverEntry {
	type: string;
	name: string;
	filters: USBDeviceFilter[];
	create: () => SdrDevice;
}

const drivers: SdrDriverEntry[] = [];

export function registerDriver(entry: SdrDriverEntry): void {
	drivers.push(entry);
}

export function getDrivers(): readonly SdrDriverEntry[] {
	return drivers;
}

export function getAllFilters(): USBDeviceFilter[] {
	return drivers.flatMap(d => d.filters);
}

export function detectDevice(device: USBDevice): SdrDriverEntry | null {
	for (const entry of drivers) {
		for (const filter of entry.filters) {
			if (filter.vendorId !== undefined && filter.vendorId !== device.vendorId) continue;
			if (filter.productId !== undefined && filter.productId !== device.productId) continue;
			return entry;
		}
	}
	return null;
}
