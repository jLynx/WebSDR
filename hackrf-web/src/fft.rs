use rustfft::num_complex::Complex;
use rustfft::FftPlanner;
use std::slice;

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct FFT {
    pub(crate) n: usize,
    smoothing_speed: f32,
    fft: std::sync::Arc<dyn rustfft::Fft<f32>>,
    prev: Box<[f32]>,
    /// FFT working buffer. Reused to avoid allocations
    buffer: Vec<Complex<f32>>,
    /// Window function with pre-applied scaling (1/128 and 1/n)
    scaled_window: Box<[f32]>,
    /// Output buffer for returning pointers
    output: Vec<f32>,
}

#[wasm_bindgen]
impl FFT {
    /// Create a new FFT processor.
    ///
    /// # Arguments
    /// * `n` - FFT size. Must be a power of two and greater than 0
    /// * `window_` - Window function array. Length must equal `n`
    #[wasm_bindgen(constructor)]
    pub fn new(n: usize, window_: &[f32]) -> FFT {
        assert!(n > 0, "FFT size must be positive");
        assert!(n & (n - 1) == 0, "FFT size must be a power of two");
        assert_eq!(window_.len(), n, "Window size must match FFT size");

        let mut planner = FftPlanner::new();
        let fft = planner.plan_fft_forward(n);

        // Pre-compute scaled window: window[i] * (-1)^i / 128
        // The (-1)^i factor shifts DC to the centre of the output (fftShift)
        // Note: 1/N normalization is applied separately in the power spectrum step
        let scale = 1.0 / 128.0;
        let scaled_window: Vec<f32> = window_
            .iter()
            .enumerate()
            .map(|(i, &w)| {
                let shift = if i % 2 == 0 { 1.0 } else { -1.0 };
                w * scale * shift
            })
            .collect();

        FFT {
            n,
            smoothing_speed: 1.0, // 1.0 = no smoothing (100% new value)
            fft,
            prev: vec![0.0f32; n].into_boxed_slice(),
            buffer: vec![Complex { re: 0.0, im: 0.0 }; n],
            scaled_window: scaled_window.into_boxed_slice(),
            output: vec![0.0f32; n],
        }
    }

    /// Set smoothing speed (SDR++ semantics).
    /// 1.0 = no smoothing (100% new value).
    /// 0.0 = full smoothing (output frozen — 0% new value).
    pub fn set_smoothing_speed(&mut self, val: f32) {
        self.smoothing_speed = val;
    }

    /// Process raw i8 IQ samples and write power spectrum to `result`.
    ///
    /// Input: i8 IQ pairs [I0, Q0, I1, Q1, ...] — length must be at least 2 * n
    /// Output: f32 power spectrum in dB, DC-centered, length `n`
    pub fn fft(&mut self, input_: &[i8], result: &mut [f32]) {
        let n = self.n;

        // Apply pre-computed scaled window (includes (-1)^i shift and 1/(128*n) scaling)
        for i in 0..n {
            self.buffer[i] = Complex {
                re: input_[i * 2] as f32,
                im: input_[i * 2 + 1] as f32,
            } * self.scaled_window[i];
        }

        self.fft.process(&mut self.buffer);

        // Convert to power spectrum in dB with optional EMA smoothing
        let alpha = self.smoothing_speed;
        for i in 0..n {
            let power = self.buffer[i].norm_sqr() / (n as f32);
            let db = power.max(1e-20).log10() * 10.0;

            result[i] = if alpha < 1.0 {
                let s = alpha * db + (1.0 - alpha) * self.prev[i];
                self.prev[i] = s;
                s
            } else {
                db
            };
        }
    }

    /// Zero-copy FFT: takes a raw pointer to i8 IQ data, returns a raw pointer to f32 output.
    /// The returned pointer is valid until the next call to `fft` or `fft_ptr`.
    pub fn fft_ptr(&mut self, iq_ptr: *const i8, num_iq_bytes: usize) -> *const f32 {
        let n = self.n;
        let input_ = unsafe { slice::from_raw_parts(iq_ptr, num_iq_bytes) };

        for i in 0..n {
            self.buffer[i] = Complex {
                re: input_[i * 2] as f32,
                im: input_[i * 2 + 1] as f32,
            } * self.scaled_window[i];
        }

        self.fft.process(&mut self.buffer);

        let alpha = self.smoothing_speed;
        for i in 0..n {
            let power = self.buffer[i].norm_sqr() / (n as f32);
            let db = power.max(1e-20).log10() * 10.0;

            self.output[i] = if alpha < 1.0 {
                let s = alpha * db + (1.0 - alpha) * self.prev[i];
                self.prev[i] = s;
                s
            } else {
                db
            };
        }

        self.output.as_ptr()
    }
}
