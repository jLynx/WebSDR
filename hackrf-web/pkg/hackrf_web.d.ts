/* tslint:disable */
/* eslint-disable */

export class DspProcessor {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Create a new DSP processor matching SDR++ NFM pipeline.
     *
     * # Arguments
     * * `in_sample_rate` - Source sample rate (e.g. 2_000_000.0 for 2 MHz)
     * * `shift_hz` - Frequency offset in Hz (VFO offset from center)
     * * `bandwidth` - Channel bandwidth in Hz (default 12500.0 for NFM)
     */
    constructor(in_sample_rate: number, shift_hz: number, bandwidth: number);
    /**
     * Process raw i8 IQ samples through the full SDR++ NFM pipeline.
     * Returns the number of f32 audio samples written to `output`.
     *
     * Input: i8 IQ pairs [I0, Q0, I1, Q1, ...]
     * Output: f32 mono audio at 48 kHz
     */
    process(input: Int8Array, output: Float32Array): number;
    /**
     * Process raw i8 IQ samples through NCO + decimation only.
     * Returns interleaved complex f32 IQ pairs at IF sample rate (50 kHz).
     * Used for non-FM modes (AM, SSB, CW, RAW) where JS handles demodulation.
     */
    process_iq_only(input: Int8Array, output: Float32Array): number;
    /**
     * Reset all DSP state (filter histories, demod phase, resampler state).
     * Call this when switching demodulation modes or when the signal chain
     * changes to avoid stale state causing audio artifacts.
     */
    reset(): void;
    /**
     * Update the channel bandwidth and rebuild filters.
     */
    set_bandwidth(bandwidth: number): void;
    /**
     * Change the IF sample rate and rebuild the entire resampler/filter chain.
     * SDR++ uses different IF rates per demodulator mode:
     *   NFM: 50,000 Hz,  WFM: 250,000 Hz,  AM: 15,000 Hz,
     *   USB/LSB/DSB: 24,000 Hz,  CW: 3,000 Hz
     */
    set_if_sample_rate(new_if_sr: number): void;
    /**
     * Update the NCO frequency offset.
     */
    set_shift(sample_rate: number, shift_hz: number): void;
    /**
     * Set squelch level in dB. Set to -200 or below to effectively disable.
     */
    set_squelch(level: number, enabled: boolean): void;
    /**
     * Enable or disable WFM mode. When enabled, uses SDR++ broadcast_fm.h
     * audio filter settings (15 kHz cutoff, 4 kHz transition) instead of
     * the standard bandwidth/2 cutoff used for NFM and other modes.
     */
    set_wfm_mode(enabled: boolean): void;
}

export class FFT {
    free(): void;
    [Symbol.dispose](): void;
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
     */
    fft(input_: Int8Array, result: Float32Array): void;
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
     */
    constructor(n: number, window_: Float32Array);
    set_smoothing_speed(val: number): void;
}

export function set_panic_hook(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_dspprocessor_free: (a: number, b: number) => void;
    readonly __wbg_fft_free: (a: number, b: number) => void;
    readonly dspprocessor_new: (a: number, b: number, c: number) => number;
    readonly dspprocessor_process: (a: number, b: number, c: number, d: number, e: number, f: any) => number;
    readonly dspprocessor_process_iq_only: (a: number, b: number, c: number, d: number, e: number, f: any) => number;
    readonly dspprocessor_reset: (a: number) => void;
    readonly dspprocessor_set_bandwidth: (a: number, b: number) => void;
    readonly dspprocessor_set_if_sample_rate: (a: number, b: number) => void;
    readonly dspprocessor_set_shift: (a: number, b: number, c: number) => void;
    readonly dspprocessor_set_squelch: (a: number, b: number, c: number) => void;
    readonly dspprocessor_set_wfm_mode: (a: number, b: number) => void;
    readonly fft_fft: (a: number, b: number, c: number, d: number, e: number, f: any) => void;
    readonly fft_new: (a: number, b: number, c: number) => number;
    readonly fft_set_smoothing_speed: (a: number, b: number) => void;
    readonly set_panic_hook: () => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
