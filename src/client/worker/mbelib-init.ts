/*
 * Lazy loader for the mbelib WASM module.
 * Provides typed wrappers around the C functions for AMBE/IMBE decoding.
 */

let mbelibModule: any = null;
let initPromise: Promise<void> | null = null;

// C function wrappers (set after init)
let _decode_ambe: (frPtr: number, audioPtr: number) => number;
let _decode_imbe: (frPtr: number, audioPtr: number) => number;
let _mbelib_init: () => void;
let _mbelib_reset: () => void;
let _malloc: (size: number) => number;
let _free: (ptr: number) => void;

// Persistent WASM heap pointers for zero-alloc decode calls
let ambeFramePtr = 0;  // 4*24 = 96 bytes
let imbeFramePtr = 0;  // 8*23 = 184 bytes
let audioOutPtr = 0;   // 160 * 4 = 640 bytes (float32)

export async function ensureMbelibInitialized(): Promise<void> {
	if (mbelibModule) return;
	if (initPromise) { await initPromise; return; }

	initPromise = (async () => {
		// Load mbelib WASM via fetch + eval to avoid Vite's import analysis.
		// Emscripten generates a UMD/IIFE that sets `var MbelibModule = ...`
		// so we evaluate it and grab the factory from the global scope.
		// If mbelib hasn't been compiled yet, this fetch will 404 and DSD
		// voice decoding is disabled (sync/status still works).
		const resp = await fetch('/lib/mbelib/mbelib.js');
		if (!resp.ok) throw new Error(`mbelib not found (${resp.status}) — run mbelib-wasm/build.sh to compile`);
		const src = await resp.text();

		// Evaluate the script in the worker's global scope to define MbelibModule
		// Use Function() to avoid strict-mode issues with eval
		const fn = new Function(src + '\nreturn MbelibModule;');
		const MbelibModuleFactory = fn();

		if (typeof MbelibModuleFactory !== 'function') {
			throw new Error('mbelib.js did not produce a factory function');
		}

		mbelibModule = await MbelibModuleFactory({
			locateFile: (path: string) => '/lib/mbelib/' + path,
		});

		_decode_ambe = mbelibModule.cwrap('mbelib_decode_ambe', 'number', ['number', 'number']);
		_decode_imbe = mbelibModule.cwrap('mbelib_decode_imbe', 'number', ['number', 'number']);
		_mbelib_init = mbelibModule.cwrap('mbelib_init', null, []);
		_mbelib_reset = mbelibModule.cwrap('mbelib_reset', null, []);
		_malloc = mbelibModule._malloc;
		_free = mbelibModule._free;

		// Allocate persistent buffers
		ambeFramePtr = _malloc(96);
		imbeFramePtr = _malloc(184);
		audioOutPtr = _malloc(160 * 4);

		_mbelib_init();
		console.log('mbelib WASM initialized');
	})();
	await initPromise;
}

/**
 * Decode an AMBE 3600x2450 voice frame (DMR, D-STAR, NXDN).
 * @param ambeFr 4x24 bit matrix as flat Int8Array (96 bytes, row-major)
 * @returns Float32Array of 160 audio samples at 8 kHz
 */
export function decodeAmbe(ambeFr: Int8Array | Uint8Array): Float32Array {
	const heap8 = new Int8Array(mbelibModule.HEAP8.buffer);
	heap8.set(ambeFr.subarray(0, 96), ambeFramePtr);

	_decode_ambe(ambeFramePtr, audioOutPtr);

	const heapF32 = new Float32Array(mbelibModule.HEAPF32.buffer);
	return new Float32Array(heapF32.buffer, audioOutPtr, 160).slice();
}

/**
 * Decode an IMBE 7200x4400 voice frame (P25 Phase 1).
 * @param imbeFr 8x23 bit matrix as flat Int8Array (184 bytes, row-major)
 * @returns Float32Array of 160 audio samples at 8 kHz
 */
export function decodeImbe(imbeFr: Int8Array | Uint8Array): Float32Array {
	const heap8 = new Int8Array(mbelibModule.HEAP8.buffer);
	heap8.set(imbeFr.subarray(0, 184), imbeFramePtr);

	_decode_imbe(imbeFramePtr, audioOutPtr);

	const heapF32 = new Float32Array(mbelibModule.HEAPF32.buffer);
	return new Float32Array(heapF32.buffer, audioOutPtr, 160).slice();
}

/** Reset the mbelib decoder state (call on mode change / sync loss). */
export function resetMbe(): void {
	if (_mbelib_reset) _mbelib_reset();
}

/** Check if mbelib is loaded and ready. */
export function isMbelibReady(): boolean {
	return mbelibModule !== null;
}
