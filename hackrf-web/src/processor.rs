// ============================================================================
// DspProcessor — Full SDR++ VFO + Demod Pipeline
// ============================================================================
//
// Signal chain (matches SDR++ exactly):
//   1. FrequencyXlator (NCO mixer) — complex rotate to shift channel to baseband
//   2. RationalResampler (polyphase) — decimate from source SR → IF SR (50 kHz)
//   3. Channel FIR filter — LPF at bandwidth/2 (only if bandwidth != IF SR)
//   4. Squelch — avg magnitude gate on complex IQ (pre-demod)
//   5. Quadrature FM discriminator — atan2 phase diff → float audio
//   6. Post-demod FIR filter — LPF at bandwidth/2 on demodulated audio
//   7. Audio RationalResampler — 50 kHz → 48 kHz (polyphase)
//
// All steps run at appropriate sample rates, matching SDR++ processing order.

use std::f32::consts::PI;
use std::slice;

use wasm_bindgen::prelude::*;

use crate::dsp::decimation::{compute_power_decim_ratio, PowerDecimator};
use crate::dsp::filter::{ComplexFIR, RealFIR};
use crate::dsp::primitives::{gcd, high_pass_taps, low_pass_taps};
use crate::dsp::resampler::{PolyphaseResamplerComplex, PolyphaseResamplerF32};

#[wasm_bindgen]
pub struct DspProcessor {
    // NCO state (phasor form — no per-sample trig, just complex multiply)
    phasor_re: f32,
    phasor_im: f32,
    phasor_inc_re: f32,
    phasor_inc_im: f32,

    // Sample rates
    in_sample_rate: f32,
    if_sample_rate: f32,   // 50000.0 Hz (matches SDR++ NFM getIFSampleRate)
    audio_sample_rate: f32, // 48000.0 Hz

    // Pre-decimation: FIR filter plan matching SDR++
    power_decim: PowerDecimator,

    // WFM mode flag (uses SDR++ broadcast_fm.h audio filter settings)
    is_wfm: bool,

    // Bandwidth
    bandwidth: f32,

    // IQ resampler: pre_decim_rate → 50 kHz
    iq_resampler: PolyphaseResamplerComplex,

    // Channel bandwidth FIR filter (complex, operates at IF SR)
    channel_filter: ComplexFIR,
    channel_filter_needed: bool,

    // FM demodulator state
    prev_phase: f32,
    inv_deviation: f32,

    // Post-demod FIR (real, operates at IF SR)
    post_demod_fir: RealFIR,

    // Audio resampler: IF SR → audio SR
    audio_resampler: PolyphaseResamplerF32,

    // Squelch state
    squelch_level: f32,   // dB threshold (-100 = disabled)
    squelch_enabled: bool,
    last_squelch_db: f32, // last measured signal level in dB

    // DC Blocker state (matches SDR++ dc_block.h)
    dc_avg_i: f32,
    dc_avg_q: f32,
    dc_alpha: f32,

    // NCO output buffers (reused to avoid per-call allocation)
    nco_buf_i: Vec<f32>,
    nco_buf_q: Vec<f32>,

    // Scratch buffers (reused to avoid allocations)
    scratch_i: Vec<f32>,
    scratch_q: Vec<f32>,
    scratch_i2: Vec<f32>,
    scratch_q2: Vec<f32>,
    scratch_audio: Vec<f32>,
    scratch_audio2: Vec<f32>,

    audio_fir_hp: RealFIR,
    use_hp: bool,
    use_lp: bool,
}

#[wasm_bindgen]
impl DspProcessor {
    /// Create a new DSP processor matching SDR++ NFM pipeline.
    ///
    /// # Arguments
    /// * `in_sample_rate` - Source sample rate (e.g. 2_000_000.0 for 2 MHz)
    /// * `shift_hz` - Frequency offset in Hz (VFO offset from center)
    /// * `bandwidth` - Channel bandwidth in Hz (default 12500.0 for NFM)
    #[wasm_bindgen(constructor)]
    pub fn new(in_sample_rate: f32, shift_hz: f32, bandwidth: f32) -> Self {
        let if_sample_rate = 50000.0f32;
        let audio_sample_rate = 48000.0f32;

        // NCO: phasor form (negate offset to match SDR++ xlator.init(NULL, -_offset, _inSR))
        let phase_inc = -2.0 * PI * shift_hz / in_sample_rate;
        let (sin_inc, cos_inc) = phase_inc.sin_cos();

        // Pre-decimation: pure FIR filter plan matching SDR++
        let total_ratio = compute_power_decim_ratio(in_sample_rate, if_sample_rate);
        let power_decim = PowerDecimator::new(total_ratio);
        let pre_decim_rate = in_sample_rate / total_ratio as f32;

        // IQ rational resampler: pre_decim_rate → IF
        let iq_resampler = Self::build_complex_resampler(pre_decim_rate, if_sample_rate);

        // Channel filter: LPF at bandwidth/2, operating at IF SR
        let channel_filter_needed = (bandwidth - if_sample_rate).abs() > 1.0;
        let channel_filter = if channel_filter_needed {
            let filter_width = bandwidth as f64 / 2.0;
            let taps = low_pass_taps(filter_width, filter_width * 0.1, if_sample_rate as f64);
            ComplexFIR::new(taps)
        } else {
            ComplexFIR::new(vec![1.0])
        };

        // FM demodulator: deviation = bandwidth/2
        let deviation_rad = 2.0 * PI * (bandwidth / 2.0) / if_sample_rate;
        let inv_deviation = 1.0 / deviation_rad;

        // Post-demod FIR: LPF at bandwidth/2, transition = 10% of cutoff, at IF SR
        let post_demod_fir = {
            let cutoff = bandwidth as f64 / 2.0;
            let trans = cutoff * 0.1;
            let taps = low_pass_taps(cutoff, trans, if_sample_rate as f64);
            RealFIR::new(taps)
        };

        // Audio HPF: HPF at 300Hz, transition = 100Hz
        let audio_fir_hp = {
            let taps = high_pass_taps(300.0, 100.0, if_sample_rate as f64);
            RealFIR::new(taps)
        };

        // Audio resampler: IF SR → audio SR
        let audio_resampler = Self::build_f32_resampler(if_sample_rate, audio_sample_rate);

        let dc_alpha = 1.0 - (10.0 / in_sample_rate);

        DspProcessor {
            phasor_re: 1.0,
            phasor_im: 0.0,
            phasor_inc_re: cos_inc,
            phasor_inc_im: sin_inc,
            in_sample_rate,
            if_sample_rate,
            audio_sample_rate,
            power_decim,
            is_wfm: false,
            bandwidth,
            iq_resampler,
            channel_filter,
            channel_filter_needed,
            prev_phase: 0.0,
            inv_deviation,
            post_demod_fir,
            audio_fir_hp,
            use_lp: false,
            use_hp: false,
            audio_resampler,
            squelch_level: -100.0,
            squelch_enabled: false,
            last_squelch_db: -120.0,
            dc_avg_i: 0.0,
            dc_avg_q: 0.0,
            dc_alpha,
            nco_buf_i: Vec::with_capacity(262144),
            nco_buf_q: Vec::with_capacity(262144),
            scratch_i: Vec::with_capacity(8192),
            scratch_q: Vec::with_capacity(8192),
            scratch_i2: Vec::with_capacity(8192),
            scratch_q2: Vec::with_capacity(8192),
            scratch_audio: Vec::with_capacity(8192),
            scratch_audio2: Vec::with_capacity(8192),
        }
    }

    fn build_complex_resampler(in_sr: f32, out_sr: f32) -> PolyphaseResamplerComplex {
        let in_sr_u = in_sr.round() as usize;
        let out_sr_u = out_sr.round() as usize;
        let d = gcd(in_sr_u, out_sr_u);
        let interp = out_sr_u / d;
        let decim = in_sr_u / d;

        let tap_sr = in_sr as f64 * interp as f64;
        let tap_bw = (in_sr as f64).min(out_sr as f64) / 2.0;
        let tap_tw = tap_bw * 0.1;
        let mut taps = low_pass_taps(tap_bw, tap_tw, tap_sr);
        for t in taps.iter_mut() {
            *t *= interp as f32;
        }

        PolyphaseResamplerComplex::new(interp, decim, &taps)
    }

    fn build_f32_resampler(in_sr: f32, out_sr: f32) -> PolyphaseResamplerF32 {
        let in_sr_u = in_sr.round() as usize;
        let out_sr_u = out_sr.round() as usize;
        let d = gcd(in_sr_u, out_sr_u);
        let interp = out_sr_u / d;
        let decim = in_sr_u / d;

        let tap_sr = in_sr as f64 * interp as f64;
        let tap_bw = (in_sr as f64).min(out_sr as f64) / 2.0;
        let tap_tw = tap_bw * 0.1;
        let mut taps = low_pass_taps(tap_bw, tap_tw, tap_sr);
        for t in taps.iter_mut() {
            *t *= interp as f32;
        }

        PolyphaseResamplerF32::new(interp, decim, &taps)
    }

    /// Update the NCO frequency offset.
    pub fn set_shift(&mut self, sample_rate: f32, shift_hz: f32) {
        self.in_sample_rate = sample_rate;
        self.dc_alpha = 1.0 - (10.0 / sample_rate);
        // Negate offset to match SDR++ FrequencyXlator
        let phase_inc = -2.0 * PI * shift_hz / sample_rate;
        let (sin_inc, cos_inc) = phase_inc.sin_cos();
        self.phasor_inc_re = cos_inc;
        self.phasor_inc_im = sin_inc;
    }

    /// Update the channel bandwidth and rebuild filters.
    pub fn set_bandwidth(&mut self, bandwidth: f32) {
        if (self.bandwidth - bandwidth).abs() < 1.0 {
            return;
        }
        self.bandwidth = bandwidth;

        // Update channel filter
        self.channel_filter_needed = (bandwidth - self.if_sample_rate).abs() > 1.0;
        if self.channel_filter_needed {
            let filter_width = bandwidth as f64 / 2.0;
            let taps = low_pass_taps(filter_width, filter_width * 0.1, self.if_sample_rate as f64);
            self.channel_filter.set_taps(taps);
        }

        // Update FM deviation
        let deviation_rad = 2.0 * PI * (bandwidth / 2.0) / self.if_sample_rate;
        self.inv_deviation = 1.0 / deviation_rad;

        // Update post-demod filter
        // WFM: 15 kHz cutoff, 4 kHz transition (matches SDR++ broadcast_fm.h)
        // NFM/other: bandwidth/2 cutoff, 10% transition
        let (cutoff, trans) = if self.is_wfm {
            (15000.0_f64, 4000.0_f64)
        } else {
            let c = bandwidth as f64 / 2.0;
            (c, c * 0.1)
        };
        let taps = low_pass_taps(cutoff, trans, self.if_sample_rate as f64);
        self.post_demod_fir.set_taps(taps);
    }

    /// Set squelch level in dB. Set to -200 or below to effectively disable.
    pub fn set_squelch(&mut self, level: f32, enabled: bool) {
        self.squelch_level = level;
        self.squelch_enabled = enabled;
    }

    /// Returns the last measured signal level in dB (for auto-squelch calibration).
    pub fn get_squelch_db(&self) -> f32 {
        self.last_squelch_db
    }

    /// Enable or disable audio filters (LowPass, HighPass) for NFM.
    pub fn set_audio_filters(&mut self, low_pass: bool, high_pass: bool) {
        self.use_lp = low_pass;
        self.use_hp = high_pass;
    }

    /// Enable or disable WFM mode. When enabled, uses SDR++ broadcast_fm.h
    /// audio filter settings (15 kHz cutoff, 4 kHz transition) instead of
    /// the standard bandwidth/2 cutoff used for NFM and other modes.
    pub fn set_wfm_mode(&mut self, enabled: bool) {
        if self.is_wfm == enabled {
            return;
        }
        self.is_wfm = enabled;
        // Rebuild post-demod filter with appropriate cutoff
        let (cutoff, trans) = if enabled {
            (15000.0_f64, 4000.0_f64)
        } else {
            let c = self.bandwidth as f64 / 2.0;
            (c, c * 0.1)
        };
        // Use self.if_sample_rate here, but WFM also needs an IF SR of 250k.
        let taps = low_pass_taps(cutoff, trans, self.if_sample_rate as f64);
        self.post_demod_fir.set_taps(taps);
    }

    /// Change the IF sample rate and rebuild the entire resampler/filter chain.
    /// SDR++ uses different IF rates per demodulator mode:
    ///   NFM: 50,000 Hz,  WFM: 250,000 Hz,  AM: 15,000 Hz,
    ///   USB/LSB/DSB: 24,000 Hz,  CW: 3,000 Hz
    pub fn set_if_sample_rate(&mut self, new_if_sr: f32) {
        if (self.if_sample_rate - new_if_sr).abs() < 1.0 {
            return;
        }
        self.if_sample_rate = new_if_sr;

        // Rebuild FIR decimation for new ratio
        let total_ratio = compute_power_decim_ratio(self.in_sample_rate, new_if_sr);
        self.power_decim = PowerDecimator::new(total_ratio);
        let pre_decim_rate = self.in_sample_rate / total_ratio as f32;

        // Rebuild IQ resampler: pre_decim_rate → new IF
        self.iq_resampler = Self::build_complex_resampler(pre_decim_rate, new_if_sr);

        // Rebuild channel filter at new IF rate
        self.channel_filter_needed = (self.bandwidth - new_if_sr).abs() > 1.0;
        if self.channel_filter_needed {
            let filter_width = self.bandwidth as f64 / 2.0;
            let taps = low_pass_taps(filter_width, filter_width * 0.1, new_if_sr as f64);
            self.channel_filter.set_taps(taps);
        }

        // Rebuild FM deviation for new IF rate
        let deviation_rad = 2.0 * PI * (self.bandwidth / 2.0) / new_if_sr;
        self.inv_deviation = 1.0 / deviation_rad;

        // Rebuild post-demod filter at new IF rate
        // WFM: 15 kHz cutoff, 4 kHz transition (matches SDR++ broadcast_fm.h)
        let (cutoff, trans) = if self.is_wfm {
            (15000.0_f64, 4000.0_f64)
        } else {
            let c = self.bandwidth as f64 / 2.0;
            (c, c * 0.1)
        };
        let taps = low_pass_taps(cutoff, trans, new_if_sr as f64);
        self.post_demod_fir.set_taps(taps);

        // Rebuild audio resampler: new IF → audio
        self.audio_resampler = Self::build_f32_resampler(new_if_sr, self.audio_sample_rate);

        // Reset all state
        self.prev_phase = 0.0;
        self.phasor_re = 1.0;
        self.phasor_im = 0.0;
        self.channel_filter.reset();
        self.post_demod_fir.reset();
    }

    /// Reset all DSP state (filter histories, demod phase, resampler state).
    /// Call this when switching demodulation modes or when the signal chain
    /// changes to avoid stale state causing audio artifacts.
    pub fn reset(&mut self) {
        // Reset FM demod state
        self.prev_phase = 0.0;

        // Reset NCO phasor (keep frequency, reset phase accumulation)
        self.phasor_re = 1.0;
        self.phasor_im = 0.0;

        // Reset filter histories
        self.channel_filter.reset();
        self.post_demod_fir.reset();

        // Reset decimator
        self.power_decim.reset();

        // Reset resamplers
        self.iq_resampler.reset();
        self.audio_resampler.reset();

        // Reset DC blocker
        self.dc_avg_i = 0.0;
        self.dc_avg_q = 0.0;
    }

    /// Process raw i8 IQ samples through the full SDR++ NFM pipeline.
    /// Returns the number of f32 audio samples written to `output`.
    ///
    /// Input: i8 IQ pairs [I0, Q0, I1, Q1, ...]
    /// Output: f32 mono audio at 48 kHz
    pub fn process(&mut self, input: &[i8], output: &mut [f32]) -> usize {
        let num_iq = input.len() / 2;
        if num_iq == 0 {
            return 0;
        }

        // ── Stage 1 & 1b: Fused NCO + DC Blocker ────────────
        if self.nco_buf_i.len() < num_iq {
            self.nco_buf_i.resize(num_iq, 0.0);
            self.nco_buf_q.resize(num_iq, 0.0);
        }

        let mut pr = self.phasor_re;
        let mut pi = self.phasor_im;
        let ir = self.phasor_inc_re;
        let ii = self.phasor_inc_im;

        let alpha = self.dc_alpha;
        let mut dc_i = self.dc_avg_i;
        let mut dc_q = self.dc_avg_q;

        let inv_128 = 1.0 / 128.0;

        for i in 0..num_iq {
            let mut i_val = input[i * 2] as f32 * inv_128;
            let mut q_val = input[i * 2 + 1] as f32 * inv_128;

            // DC Blocker (matches SDR++ genDCBlockRate)
            dc_i = dc_i * alpha + i_val * (1.0 - alpha);
            dc_q = dc_q * alpha + q_val * (1.0 - alpha);
            i_val -= dc_i;
            q_val -= dc_q;

            // Standard complex multiply: (i + jq) * (pr + j*pi)
            self.nco_buf_i[i] = i_val * pr - q_val * pi;
            self.nco_buf_q[i] = i_val * pi + q_val * pr;

            // Rotate phasor
            let new_r = pr * ir - pi * ii;
            let new_i = pr * ii + pi * ir;
            pr = new_r;
            pi = new_i;
        }

        self.dc_avg_i = dc_i;
        self.dc_avg_q = dc_q;

        // Renormalize phasor to prevent amplitude drift
        let mag = (pr * pr + pi * pi).sqrt();
        self.phasor_re = pr / mag;
        self.phasor_im = pi / mag;

        // ── Stage 1c: FIR anti-aliasing (recursive decimation structure) ─────
        let decim_len = self.power_decim.process(num_iq, &self.nco_buf_i[..num_iq], &self.nco_buf_q[..num_iq]);

        // ── Stage 2: IQ Rational Resampler (post-decim → IF SR) ─────
        self.scratch_i.clear();
        self.scratch_q.clear();
        self.iq_resampler.process(
            &self.power_decim.output_i()[..decim_len], &self.power_decim.output_q()[..decim_len],
            &mut self.scratch_i, &mut self.scratch_q,
        );
        let if_count = self.scratch_i.len();

        if if_count == 0 {
            return 0;
        }

        // ── Stage 3: Channel Bandwidth FIR Filter ───────────────────
        if self.channel_filter_needed && if_count > 0 {
            self.scratch_i2.resize(if_count, 0.0);
            self.scratch_q2.resize(if_count, 0.0);
            self.channel_filter.process_block(
                &self.scratch_i, &self.scratch_q,
                &mut self.scratch_i2, &mut self.scratch_q2,
            );
            // Swap so scratch_i/q hold filtered output
            std::mem::swap(&mut self.scratch_i, &mut self.scratch_i2);
            std::mem::swap(&mut self.scratch_q, &mut self.scratch_q2);
        }

        // ── Stage 4: Squelch (SDR++ noise_reduction/squelch.h) ──────
        // Always measure signal level so auto-squelch can sample the noise floor
        let mut mag_sum = 0.0f32;
        for k in 0..if_count {
            let i_val = self.scratch_i[k];
            let q_val = self.scratch_q[k];
            mag_sum += (i_val * i_val + q_val * q_val).sqrt();
        }
        let avg_mag = mag_sum / if_count as f32;
        let db = 10.0 * (avg_mag + 1e-12).log10();
        self.last_squelch_db = db;

        if self.squelch_enabled && db < self.squelch_level {
            // Mute: zero the IQ data (SDR++ memset to 0)
            for k in 0..if_count {
                self.scratch_i[k] = 0.0;
                self.scratch_q[k] = 0.0;
            }
        }

        // ── Stage 5: FM Quadrature Demodulator ──────────────────────
        // (matches SDR++ dsp/demod/quadrature.h)
        self.scratch_audio.resize(if_count, 0.0);
        let mut prev_phase = self.prev_phase;
        for k in 0..if_count {
            let cur_phase = self.scratch_q[k].atan2(self.scratch_i[k]);
            let mut diff = cur_phase - prev_phase;
            // normalizePhase (single if/else, matches SDR++ math/normalize_phase.h)
            if diff > PI {
                diff -= 2.0 * PI;
            } else if diff <= -PI {
                diff += 2.0 * PI;
            }
            self.scratch_audio[k] = diff * self.inv_deviation;
            prev_phase = cur_phase;
        }
        self.prev_phase = prev_phase;

        // ── Stage 6: Post-Demod FIR Filter ──────────────────────────
        // (matches SDR++ dsp/demod/fm.h, lowPass at bandwidth/2, highPass at 300Hz)
        self.scratch_audio2.resize(if_count, 0.0);

        if self.is_wfm {
            // WFM unconditionally uses post_demod_fir (15kHz cutoff)
            self.post_demod_fir.process_block(&self.scratch_audio, &mut self.scratch_audio2);
        } else {
            // NFM: Optional UI-driven Audio HighPass and LowPass
            let mut current_buf = &self.scratch_audio;

            if self.use_lp {
                self.post_demod_fir.process_block(current_buf, &mut self.scratch_audio2);
                self.scratch_audio.copy_from_slice(&self.scratch_audio2[..if_count]);
                current_buf = &self.scratch_audio;
            }

            if self.use_hp {
                self.audio_fir_hp.process_block(current_buf, &mut self.scratch_audio2);
                self.scratch_audio.copy_from_slice(&self.scratch_audio2[..if_count]);
                #[allow(unused_assignments)]
                { current_buf = &self.scratch_audio; }
            }

            // If neither were used, copy input to scratch_audio2 directly so the resampler gets it
            if !self.use_lp && !self.use_hp {
                self.scratch_audio2.copy_from_slice(&self.scratch_audio[..if_count]);
            } else {
                // Keep the final output in scratch_audio2 for the resampler input.
                // It was copied to scratch_audio on the last used block, so we mirror it back
                self.scratch_audio2.copy_from_slice(&self.scratch_audio[..if_count]);
            }
        }

        // ── Stage 7: Audio Resampler (50 kHz → 48 kHz) ─────────────
        self.scratch_audio.clear();
        self.audio_resampler.process(&self.scratch_audio2, &mut self.scratch_audio);

        // Copy to output buffer
        let out_count = self.scratch_audio.len().min(output.len());
        output[..out_count].copy_from_slice(&self.scratch_audio[..out_count]);
        out_count
    }

    /// Zero-copy process using a raw pointer for IQ input and returning a raw pointer.
    pub fn process_ptr(&mut self, iq_ptr: *const i8, num_iq_bytes: usize) -> *const f32 {
        let input_slice = unsafe { slice::from_raw_parts(iq_ptr, num_iq_bytes) };
        // We call `process` but with an empty slice, which will run the DSP but skip the output copy
        let _ = self.process(input_slice, &mut []);
        // The final resampler output was left in `scratch_audio`
        self.scratch_audio.as_ptr()
    }

    /// Returns the number of f32 samples generated by the last `process_ptr` call.
    pub fn get_output_len(&self) -> usize {
        self.scratch_audio.len()
    }
}

// ============================================================================
// Legacy DspProcessor compatibility — keep old API for non-NFM modes
// ============================================================================

#[wasm_bindgen]
impl DspProcessor {
    /// Process raw i8 IQ samples through NCO + decimation only.
    /// Returns interleaved complex f32 IQ pairs at IF sample rate (50 kHz).
    /// Used for non-FM modes (AM, SSB, CW, RAW) where JS handles demodulation.
    pub fn process_iq_only(&mut self, input: &[i8], output: &mut [f32]) -> usize {
        let num_iq = input.len() / 2;
        if num_iq == 0 {
            return 0;
        }

        // Stage 1 & 1b: Fused NCO + DC Blocker
        if self.nco_buf_i.len() < num_iq {
            self.nco_buf_i.resize(num_iq, 0.0);
            self.nco_buf_q.resize(num_iq, 0.0);
        }

        let mut pr = self.phasor_re;
        let mut pi = self.phasor_im;
        let ir = self.phasor_inc_re;
        let ii = self.phasor_inc_im;

        let alpha = self.dc_alpha;
        let mut dc_i = self.dc_avg_i;
        let mut dc_q = self.dc_avg_q;

        let inv_128 = 1.0 / 128.0;

        for i in 0..num_iq {
            let mut i_val = input[i * 2] as f32 * inv_128;
            let mut q_val = input[i * 2 + 1] as f32 * inv_128;

            // DC Blocker
            dc_i = dc_i * alpha + i_val * (1.0 - alpha);
            dc_q = dc_q * alpha + q_val * (1.0 - alpha);
            i_val -= dc_i;
            q_val -= dc_q;

            self.nco_buf_i[i] = i_val * pr - q_val * pi;
            self.nco_buf_q[i] = i_val * pi + q_val * pr;

            let new_r = pr * ir - pi * ii;
            let new_i = pr * ii + pi * ir;
            pr = new_r;
            pi = new_i;
        }

        self.dc_avg_i = dc_i;
        self.dc_avg_q = dc_q;

        let mag = (pr * pr + pi * pi).sqrt();
        self.phasor_re = pr / mag;
        self.phasor_im = pi / mag;

        // Stage 1c: FIR anti-aliasing (recursive decimation structure)
        let decim_len = self.power_decim.process(num_iq, &self.nco_buf_i[..num_iq], &self.nco_buf_q[..num_iq]);

        // Stage 2: IQ Rational Resampler
        self.scratch_i.clear();
        self.scratch_q.clear();
        self.iq_resampler.process(
            &self.power_decim.output_i()[..decim_len], &self.power_decim.output_q()[..decim_len],
            &mut self.scratch_i, &mut self.scratch_q,
        );
        let if_count = self.scratch_i.len();

        // Stage 3: Channel filter
        if self.channel_filter_needed && if_count > 0 {
            self.scratch_i2.resize(if_count, 0.0);
            self.scratch_q2.resize(if_count, 0.0);
            self.channel_filter.process_block(
                &self.scratch_i, &self.scratch_q,
                &mut self.scratch_i2, &mut self.scratch_q2,
            );
            std::mem::swap(&mut self.scratch_i, &mut self.scratch_i2);
            std::mem::swap(&mut self.scratch_q, &mut self.scratch_q2);
        }

        // Output interleaved IQ pairs
        // Copy to scratch_audio to retain state for ptr access
        let pairs = if_count;
        self.scratch_audio.resize(pairs * 2, 0.0);
        for k in 0..pairs {
            self.scratch_audio[k * 2] = self.scratch_i[k];
            self.scratch_audio[k * 2 + 1] = self.scratch_q[k];
        }

        let out_count = (pairs * 2).min(output.len());
        output[..out_count].copy_from_slice(&self.scratch_audio[..out_count]);
        out_count
    }

    /// Zero-copy process for IQ only using a raw pointer for input.
    pub fn process_iq_only_ptr(&mut self, iq_ptr: *const i8, num_iq_bytes: usize) -> *const f32 {
        let input_slice = unsafe { slice::from_raw_parts(iq_ptr, num_iq_bytes) };
        let _ = self.process_iq_only(input_slice, &mut []);
        self.scratch_audio.as_ptr()
    }

    /// Returns the number of f32 samples generated by the last `process_iq_only_ptr` call.
    pub fn get_iq_output_len(&self) -> usize {
        self.scratch_audio.len()
    }
}
