// ============================================================================
// Decimation (matches SDR++ dsp/multirate/power_decimator.h + decim/plans.h)
// ============================================================================

use super::taps::*;

pub(crate) struct DecimStage {
    pub(crate) decimation: usize,
    pub(crate) taps: &'static [f32],
}

/// Get the decimation plan for a given power-of-2 ratio.
/// Returns list of (decimation, taps) stages.
pub(crate) fn get_decim_plan(ratio: usize) -> Vec<DecimStage> {
    match ratio {
        1   => vec![],
        2   => vec![ DecimStage { decimation: 2, taps: FIR_2_2 } ],
        4   => vec![ DecimStage { decimation: 2, taps: FIR_4_2 }, DecimStage { decimation: 2, taps: FIR_2_2 } ],
        8   => vec![ DecimStage { decimation: 4, taps: FIR_8_4 }, DecimStage { decimation: 2, taps: FIR_2_2 } ],
        16  => vec![ DecimStage { decimation: 8, taps: FIR_16_8 }, DecimStage { decimation: 2, taps: FIR_2_2 } ],
        32  => vec![ DecimStage { decimation: 8, taps: FIR_32_8 }, DecimStage { decimation: 2, taps: FIR_4_2 }, DecimStage { decimation: 2, taps: FIR_2_2 } ],
        64  => vec![ DecimStage { decimation: 8, taps: FIR_64_8 }, DecimStage { decimation: 4, taps: FIR_8_4 }, DecimStage { decimation: 2, taps: FIR_2_2 } ],
        128 => vec![ DecimStage { decimation: 16, taps: FIR_128_16 }, DecimStage { decimation: 4, taps: FIR_8_4 }, DecimStage { decimation: 2, taps: FIR_2_2 } ],
        256 => vec![ DecimStage { decimation: 32, taps: FIR_256_32 }, DecimStage { decimation: 4, taps: FIR_8_4 }, DecimStage { decimation: 2, taps: FIR_2_2 } ],
        512 => vec![ DecimStage { decimation: 32, taps: FIR_512_32 }, DecimStage { decimation: 8, taps: FIR_16_8 }, DecimStage { decimation: 2, taps: FIR_2_2 } ],
        1024 => vec![ DecimStage { decimation: 64, taps: FIR_1024_64 }, DecimStage { decimation: 8, taps: FIR_16_8 }, DecimStage { decimation: 2, taps: FIR_2_2 } ],
        2048 => vec![ DecimStage { decimation: 64, taps: FIR_2048_64 }, DecimStage { decimation: 8, taps: FIR_32_8 }, DecimStage { decimation: 2, taps: FIR_4_2 }, DecimStage { decimation: 2, taps: FIR_2_2 } ],
        4096 => vec![ DecimStage { decimation: 64, taps: FIR_4096_64 }, DecimStage { decimation: 8, taps: FIR_64_8 }, DecimStage { decimation: 4, taps: FIR_8_4 }, DecimStage { decimation: 2, taps: FIR_2_2 } ],
        _ => {
            // Fallback: find the largest supported ratio that fits
            let mut r = 1;
            while r * 2 <= ratio && r * 2 <= 4096 {
                r *= 2;
            }
            get_decim_plan(r)
        }
    }
}

// ── ComplexDecimatingFIR (matches SDR++ dsp/filter/decimating_fir.h) ────────

/// Decimating FIR filter for complex IQ data.
/// Applies an FIR filter and keeps only every `decimation`-th output sample.
struct ComplexDecimatingFIR {
    taps: Vec<f32>,
    tap_count: usize,
    decimation: usize,
    buffer_i: Vec<f32>,
    buffer_q: Vec<f32>,
    offset: usize,
}

impl ComplexDecimatingFIR {
    fn new(taps: &[f32], decimation: usize) -> Self {
        let tap_count = taps.len();
        let buf_size = tap_count - 1 + 262144;
        let buffer_i = vec![0.0f32; buf_size];
        let buffer_q = vec![0.0f32; buf_size];
        ComplexDecimatingFIR {
            taps: taps.to_vec(),
            tap_count,
            decimation,
            buffer_i,
            buffer_q,
            offset: 0,
        }
    }

    /// Process `count` complex IQ samples. Input is in `in_i`/`in_q` slices.
    /// Output is written to `out_i`/`out_q` starting at index 0.
    /// Returns the number of output samples produced.
    fn process(&mut self, count: usize, in_i: &[f32], in_q: &[f32],
               out_i: &mut [f32], out_q: &mut [f32]) -> usize {
        let hist = self.tap_count - 1;
        let needed = hist + count;
        if needed > self.buffer_i.len() {
            self.buffer_i.resize(needed, 0.0);
            self.buffer_q.resize(needed, 0.0);
        }

        // Copy input after history (matches SDR++ memcpy(bufStart, in, count * sizeof(D)))
        self.buffer_i[hist..hist + count].copy_from_slice(&in_i[..count]);
        self.buffer_q[hist..hist + count].copy_from_slice(&in_q[..count]);

        // Convolution at decimated positions
        // (matches SDR++ volk_32fc_32f_dot_prod_32fc at offset positions)
        let mut out_count = 0;
        while self.offset < count {
            let mut sum_i = 0.0f32;
            let mut sum_q = 0.0f32;
            for j in 0..self.tap_count {
                sum_i += self.buffer_i[self.offset + j] * self.taps[j];
                sum_q += self.buffer_q[self.offset + j] * self.taps[j];
            }
            out_i[out_count] = sum_i;
            out_q[out_count] = sum_q;
            out_count += 1;
            self.offset += self.decimation;
        }
        self.offset -= count;

        // Move history (matches SDR++ memmove)
        self.buffer_i.copy_within(count..count + hist, 0);
        self.buffer_q.copy_within(count..count + hist, 0);

        out_count
    }

    fn reset(&mut self) {
        self.buffer_i.fill(0.0);
        self.buffer_q.fill(0.0);
        self.offset = 0;
    }
}

// ── PowerDecimator (matches SDR++ dsp/multirate/power_decimator.h) ──────────

/// Multi-stage power-of-2 decimator using optimized FIR filter plans.
/// Replaces the naive CIC averaging approach with proper anti-aliasing filters
/// matching the SDR++ PowerDecimator implementation.
pub(crate) struct PowerDecimator {
    stages: Vec<ComplexDecimatingFIR>,
    #[allow(dead_code)]
    ratio: usize,
    // Ping-pong scratch buffers for multi-stage processing
    buf_a_i: Vec<f32>,
    buf_a_q: Vec<f32>,
    buf_b_i: Vec<f32>,
    buf_b_q: Vec<f32>,
    result_in_a: bool,
}

impl PowerDecimator {
    pub(crate) fn new(ratio: usize) -> Self {
        let actual_ratio = if ratio <= 1 { 1 } else {
            // Clamp to max supported ratio (4096)
            let r = ratio.min(4096);
            // Round down to nearest power of 2
            1usize << (usize::BITS - 1 - r.leading_zeros() as u32)
        };

        let plan = get_decim_plan(actual_ratio);
        let stages: Vec<ComplexDecimatingFIR> = plan.iter()
            .map(|s| ComplexDecimatingFIR::new(s.taps, s.decimation))
            .collect();

        let buf_size = 262144;
        PowerDecimator {
            stages,
            ratio: actual_ratio,
            buf_a_i: vec![0.0; buf_size],
            buf_a_q: vec![0.0; buf_size],
            buf_b_i: vec![0.0; buf_size],
            buf_b_q: vec![0.0; buf_size],
            result_in_a: true,
        }
    }

    /// Process `count` complex samples through all decimation stages.
    /// Input is read from `in_i`/`in_q`.
    /// Output is stored in internal buffers accessible via `output_i()`/`output_q()`.
    /// Returns the number of output samples.
    pub(crate) fn process(&mut self, count: usize, in_i: &[f32], in_q: &[f32]) -> usize {
        if self.stages.is_empty() {
            // ratio == 1: just copy
            if self.buf_a_i.len() < count {
                self.buf_a_i.resize(count, 0.0);
                self.buf_a_q.resize(count, 0.0);
            }
            self.buf_a_i[..count].copy_from_slice(&in_i[..count]);
            self.buf_a_q[..count].copy_from_slice(&in_q[..count]);
            self.result_in_a = true;
            return count;
        }

        // Destructure to allow independent field borrows
        let PowerDecimator {
            stages, buf_a_i, buf_a_q, buf_b_i, buf_b_q, result_in_a, ..
        } = self;

        let stage_count = stages.len();
        let mut cur_count = count;
        let mut in_a = false;

        for i in 0..stage_count {
            if i == 0 {
                // First stage: input → buf_a
                if buf_a_i.len() < cur_count {
                    buf_a_i.resize(cur_count, 0.0);
                    buf_a_q.resize(cur_count, 0.0);
                }
                cur_count = stages[i].process(
                    cur_count, in_i, in_q, buf_a_i, buf_a_q
                );
                in_a = true;
            } else if in_a {
                // buf_a → buf_b
                if buf_b_i.len() < cur_count {
                    buf_b_i.resize(cur_count, 0.0);
                    buf_b_q.resize(cur_count, 0.0);
                }
                cur_count = stages[i].process(
                    cur_count, buf_a_i, buf_a_q, buf_b_i, buf_b_q
                );
                in_a = false;
            } else {
                // buf_b → buf_a
                if buf_a_i.len() < cur_count {
                    buf_a_i.resize(cur_count, 0.0);
                    buf_a_q.resize(cur_count, 0.0);
                }
                cur_count = stages[i].process(
                    cur_count, buf_b_i, buf_b_q, buf_a_i, buf_a_q
                );
                in_a = true;
            }
        }

        *result_in_a = in_a;
        cur_count
    }

    pub(crate) fn output_i(&self) -> &[f32] {
        if self.result_in_a { &self.buf_a_i } else { &self.buf_b_i }
    }

    pub(crate) fn output_q(&self) -> &[f32] {
        if self.result_in_a { &self.buf_a_q } else { &self.buf_b_q }
    }

    pub(crate) fn reset(&mut self) {
        for stage in &mut self.stages {
            stage.reset();
        }
    }
}

/// Compute the power-of-2 decimation ratio for a given sample rate conversion.
/// Matches SDR++ RationalResampler's PowerDecimator ratio selection:
/// ratio = 2^floor(log2(inSR / outSR)), clamped to [1, 4096]
pub(crate) fn compute_power_decim_ratio(in_sr: f32, out_sr: f32) -> usize {
    let ratio = in_sr / out_sr;
    if ratio < 2.0 {
        return 1;
    }
    let power = (ratio.log2().floor() as u32).min(12); // max 2^12 = 4096
    1usize << power
}

/// Split a power-of-2 decimation ratio into CIC stages and FIR ratio.
///
/// Previous approach used CIC (pair-averaging) for bulk decimation, but
/// CIC has very poor anti-aliasing: a single CIC-by-2 stage provides only
/// ~-1.8 dB rejection at 0.8×fs, letting broadband noise alias into the
/// passband. At 20 MHz with 5 CIC stages, this caused clearly audible noise.
///
/// Now the PowerDecimator handles ALL decimation using SDR++ FIR filter plans
/// (get_decim_plan) which provide proper >60 dB stopband rejection.
/// At 20 MHz (ratio=64), the 3-stage FIR plan costs ~1.7M multiply-adds
/// (~2-3ms in WASM), well within the 6.5ms USB callback budget.
///
/// Returns (cic_stages=0, fir_ratio=total_ratio).
#[allow(dead_code)]
pub(crate) fn split_decim_ratio(total_ratio: usize) -> (usize, usize) {
    // No CIC stages — PowerDecimator handles all decimation with proper
    // anti-aliasing FIR filters matching SDR++ power_decimator.h
    (0, total_ratio)
}
