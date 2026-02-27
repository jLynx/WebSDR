/* @ts-self-types="./hackrf_web.d.ts" */

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
     * HackRF One の IQ サンプル列に対して複素 FFT を実行し、
     * スペクトログラムのウォーターフォール表示に必要な前処理を全て行う。
     *
     * このメソッドは以下の処理をワンパスで実行する：
     * 1. IQ サンプルの正規化（i8 → f32）
     * 2. 窓関数の適用
     * 3. 複素 FFT
     * 4. DC 中心配置への周波数軸の並べ替え
     * 5. 指数移動平均によるスムージング（設定時）
     * 6. dB スケールへの変換
     *
     * 出力された配列は、そのままスペクトログラムの1行（時刻 t におけるスペクトル）として
     * ウォーターフォール表示に使用できる。
     *
     * # 入力形式
     * * `input_` - i8の配列として表現された複素数列 `[re0, im0, re1, im1, ...]`
     *               長さは `self.n * 2` でなければならない
     *
     * # 出力形式
     * * `result` - 結果を格納するバッファ。長さは `self.n` でなければならない
     *   - `result[0 .. half_n]` - 負の周波数成分（DC中心配置、dBスケール）
     *   - `result[half_n .. n]` - 正の周波数成分（DC中心配置、dBスケール）
     *
     * # コントラクト（呼び出し側の責任）
     * * `input_.len() == self.n * 2` でなければならない
     * * `result.len() == self.n` でなければならない
     *
     * # 安全性
     * この関数は unsafe なメモリ再解釈を使用する。コントラクトに違反する場合、
     * 未定義動作を引き起こす可能性がある。
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
     * 新しいFFTプロセッサを作成する。
     *
     * # 引数
     * * `n` - FFTサイズ。2の累乗であり、0より大きい必要がある
     * * `window_` - 窓関数の配列。長さは `n` と等しくなければならない
     *
     * # パニック
     * * `n` が 0 の場合
     * * `n` が 2の累乗でない場合
     * * `window_.len() != n` の場合
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
    set_smoothing_time_constant(val) {
        wasm.fft_set_smoothing_time_constant(this.__wbg_ptr, val);
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
