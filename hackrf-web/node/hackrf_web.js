/* @ts-self-types="./hackrf_web.d.ts" */

class DspProcessor {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DspProcessorFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_dspprocessor_free(ptr, 0);
    }
    /**
     * Create a new DSP processor matching SDR++ NFM pipeline.
     *
     * # Arguments
     * * `in_sample_rate` - Source sample rate (e.g. 2_000_000.0 for 2 MHz)
     * * `shift_hz` - Frequency offset in Hz (VFO offset from center)
     * * `bandwidth` - Channel bandwidth in Hz (default 12500.0 for NFM)
     * @param {number} in_sample_rate
     * @param {number} shift_hz
     * @param {number} bandwidth
     */
    constructor(in_sample_rate, shift_hz, bandwidth) {
        const ret = wasm.dspprocessor_new(in_sample_rate, shift_hz, bandwidth);
        this.__wbg_ptr = ret >>> 0;
        DspProcessorFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Process raw i8 IQ samples through the full SDR++ NFM pipeline.
     * Returns the number of f32 audio samples written to `output`.
     *
     * Input: i8 IQ pairs [I0, Q0, I1, Q1, ...]
     * Output: f32 mono audio at 48 kHz
     * @param {Int8Array} input
     * @param {Float32Array} output
     * @returns {number}
     */
    process(input, output) {
        const ptr0 = passArray8ToWasm0(input, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        var ptr1 = passArrayF32ToWasm0(output, wasm.__wbindgen_malloc);
        var len1 = WASM_VECTOR_LEN;
        const ret = wasm.dspprocessor_process(this.__wbg_ptr, ptr0, len0, ptr1, len1, output);
        return ret >>> 0;
    }
    /**
     * Process raw i8 IQ samples through NCO + decimation only.
     * Returns interleaved complex f32 IQ pairs at IF sample rate (50 kHz).
     * Used for non-FM modes (AM, SSB, CW, RAW) where JS handles demodulation.
     * @param {Int8Array} input
     * @param {Float32Array} output
     * @returns {number}
     */
    process_iq_only(input, output) {
        const ptr0 = passArray8ToWasm0(input, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        var ptr1 = passArrayF32ToWasm0(output, wasm.__wbindgen_malloc);
        var len1 = WASM_VECTOR_LEN;
        const ret = wasm.dspprocessor_process_iq_only(this.__wbg_ptr, ptr0, len0, ptr1, len1, output);
        return ret >>> 0;
    }
    /**
     * Reset all DSP state (filter histories, demod phase, resampler state).
     * Call this when switching demodulation modes or when the signal chain
     * changes to avoid stale state causing audio artifacts.
     */
    reset() {
        wasm.dspprocessor_reset(this.__wbg_ptr);
    }
    /**
     * Update the channel bandwidth and rebuild filters.
     * @param {number} bandwidth
     */
    set_bandwidth(bandwidth) {
        wasm.dspprocessor_set_bandwidth(this.__wbg_ptr, bandwidth);
    }
    /**
     * Change the IF sample rate and rebuild the entire resampler/filter chain.
     * SDR++ uses different IF rates per demodulator mode:
     *   NFM: 50,000 Hz,  WFM: 250,000 Hz,  AM: 15,000 Hz,
     *   USB/LSB/DSB: 24,000 Hz,  CW: 3,000 Hz
     * @param {number} new_if_sr
     */
    set_if_sample_rate(new_if_sr) {
        wasm.dspprocessor_set_if_sample_rate(this.__wbg_ptr, new_if_sr);
    }
    /**
     * Update the NCO frequency offset.
     * @param {number} sample_rate
     * @param {number} shift_hz
     */
    set_shift(sample_rate, shift_hz) {
        wasm.dspprocessor_set_shift(this.__wbg_ptr, sample_rate, shift_hz);
    }
    /**
     * Set squelch level in dB. Set to -200 or below to effectively disable.
     * @param {number} level
     * @param {boolean} enabled
     */
    set_squelch(level, enabled) {
        wasm.dspprocessor_set_squelch(this.__wbg_ptr, level, enabled);
    }
    /**
     * Enable or disable WFM mode. When enabled, uses SDR++ broadcast_fm.h
     * audio filter settings (15 kHz cutoff, 4 kHz transition) instead of
     * the standard bandwidth/2 cutoff used for NFM and other modes.
     * @param {boolean} enabled
     */
    set_wfm_mode(enabled) {
        wasm.dspprocessor_set_wfm_mode(this.__wbg_ptr, enabled);
    }
}
if (Symbol.dispose) DspProcessor.prototype[Symbol.dispose] = DspProcessor.prototype.free;
exports.DspProcessor = DspProcessor;

class FFT {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FFTFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fft_free(ptr, 0);
    }
    /**
     * Perform a complex FFT on HackRF One IQ samples and apply all
     * preprocessing needed for spectrogram waterfall display.
     *
     * This method performs the following operations in a single pass:
     * 1. Normalize IQ samples (i8 → f32)
     * 2. Apply window function
     * 3. Complex FFT
     * 4. Rearrange frequency axis to DC-centered layout
     * 5. Exponential moving average smoothing (when configured)
     * 6. Convert to dB scale
     *
     * The output array can be used directly as a single row (spectrum at time t)
     * in a waterfall spectrogram display.
     *
     * # Input format
     * * `input_` - Complex sequence as i8 array `[re0, im0, re1, im1, ...]`
     *               Length must be `self.n * 2`
     *
     * # Output format
     * * `result` - Buffer to store results. Length must be `self.n`
     *   - `result[0 .. half_n]` - Negative frequency components (DC-centered, dB scale)
     *   - `result[half_n .. n]` - Positive frequency components (DC-centered, dB scale)
     *
     * # Contract (caller's responsibility)
     * * `input_.len() == self.n * 2` must hold
     * * `result.len() == self.n` must hold
     *
     * # Safety
     * This function uses unsafe memory reinterpretation. Violating the contract
     * may cause undefined behavior.
     * @param {Int8Array} input_
     * @param {Float32Array} result
     */
    fft(input_, result) {
        const ptr0 = passArray8ToWasm0(input_, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        var ptr1 = passArrayF32ToWasm0(result, wasm.__wbindgen_malloc);
        var len1 = WASM_VECTOR_LEN;
        wasm.fft_fft(this.__wbg_ptr, ptr0, len0, ptr1, len1, result);
    }
    /**
     * Create a new FFT processor.
     *
     * # Arguments
     * * `n` - FFT size. Must be a power of two and greater than 0
     * * `window_` - Window function array. Length must equal `n`
     *
     * # Panics
     * * If `n` is 0
     * * If `n` is not a power of two
     * * If `window_.len() != n`
     * @param {number} n
     * @param {Float32Array} window_
     */
    constructor(n, window_) {
        const ptr0 = passArrayF32ToWasm0(window_, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fft_new(n, ptr0, len0);
        this.__wbg_ptr = ret >>> 0;
        FFTFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {number} val
     */
    set_smoothing_speed(val) {
        wasm.fft_set_smoothing_speed(this.__wbg_ptr, val);
    }
}
if (Symbol.dispose) FFT.prototype[Symbol.dispose] = FFT.prototype.free;
exports.FFT = FFT;

function set_panic_hook() {
    wasm.set_panic_hook();
}
exports.set_panic_hook = set_panic_hook;

function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_copy_to_typed_array_5294f8e46aecc086: function(arg0, arg1, arg2) {
            new Uint8Array(arg2.buffer, arg2.byteOffset, arg2.byteLength).set(getArrayU8FromWasm0(arg0, arg1));
        },
        __wbg___wbindgen_throw_39bc967c0e5a9b58: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_error_a6fa202b58aa1cd3: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./hackrf_web_bg.js": import0,
    };
}

const DspProcessorFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_dspprocessor_free(ptr >>> 0, 1));
const FFTFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fft_free(ptr >>> 0, 1));

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
function decodeText(ptr, len) {
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

const wasmPath = `${__dirname}/hackrf_web_bg.wasm`;
const wasmBytes = require('fs').readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBytes);
let wasm = new WebAssembly.Instance(wasmModule, __wbg_get_imports()).exports;
wasm.__wbindgen_start();
