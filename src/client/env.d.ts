/// <reference types="vite/client" />

// WebUSB API types
interface USBDeviceFilter {
	vendorId?: number;
	productId?: number;
	classCode?: number;
	subclassCode?: number;
	protocolCode?: number;
	serialNumber?: string;
}

interface USBDeviceRequestOptions {
	filters: USBDeviceFilter[];
}

interface USBConfiguration {
	configurationValue: number;
	configurationName: string | null;
	interfaces: USBInterface[];
}

interface USBInterface {
	interfaceNumber: number;
	alternate: USBAlternateInterface;
	alternates: USBAlternateInterface[];
	claimed: boolean;
}

interface USBAlternateInterface {
	alternateSetting: number;
	interfaceClass: number;
	interfaceSubclass: number;
	interfaceProtocol: number;
	interfaceName: string | null;
	endpoints: USBEndpoint[];
}

interface USBEndpoint {
	endpointNumber: number;
	direction: 'in' | 'out';
	type: 'bulk' | 'interrupt' | 'isochronous';
	packetSize: number;
}

interface USBDevice {
	open(): Promise<void>;
	close(): Promise<void>;
	selectConfiguration(configurationValue: number): Promise<void>;
	claimInterface(interfaceNumber: number): Promise<void>;
	controlTransferIn(setup: USBControlTransferParameters, length: number): Promise<USBInTransferResult>;
	controlTransferOut(setup: USBControlTransferParameters, data?: BufferSource): Promise<USBOutTransferResult>;
	transferIn(endpointNumber: number, length: number): Promise<USBInTransferResult>;
	transferOut(endpointNumber: number, data: BufferSource): Promise<USBOutTransferResult>;
	configuration: USBConfiguration | null;
	vendorId: number;
	productId: number;
	productName: string;
	serialNumber: string;
	deviceVersionMajor: number;
	deviceVersionMinor: number;
	deviceVersionSubminor: number;
}

interface USBControlTransferParameters {
	requestType: 'vendor' | 'standard' | 'class';
	recipient: 'device' | 'interface' | 'endpoint' | 'other';
	request: number;
	value: number;
	index: number;
}

interface USBInTransferResult {
	status: 'ok' | 'stall' | 'babble';
	data: DataView;
}

interface USBOutTransferResult {
	status: 'ok' | 'stall';
}

interface USB {
	getDevices(): Promise<USBDevice[]>;
	requestDevice(options: USBDeviceRequestOptions): Promise<USBDevice>;
}

interface Navigator {
	usb: USB;
}

// WASM module declarations (resolved at runtime via Vite public dir)
declare module '/hackrf-web/pkg/hackrf_web.js' {
	export default function init(): Promise<any>;
	export class FFT {
		constructor(size: number);
		process(ptr: number, len: number): number;
		get_output_len(): number;
		free(): void;
	}
	export class DspProcessor {
		constructor(sampleRate: number, shift: number, bandwidth: number);
		process_ptr(ptr: number, len: number): number;
		process_iq_only_ptr(ptr: number, len: number): number;
		get_output_len(): number;
		get_iq_output_len(): number;
		set_shift(sampleRate: number, freq: number): void;
		set_bandwidth(bw: number): void;
		set_squelch(level: number, enabled: boolean): void;
		get_squelch_db(): number;
		set_wfm_mode(enabled: boolean): void;
		set_if_sample_rate(rate: number): void;
		set_audio_filters(lowPass: boolean, highPass: boolean): void;
		free(): void;
	}
	export function set_panic_hook(): void;
	export function alloc_iq_buffer(size: number): number;
	export function free_iq_buffer(ptr: number, size: number): void;
}

// Cloudflare Worker types
interface ExecutionContext {
	waitUntil(promise: Promise<any>): void;
	passThroughOnException(): void;
}
