// ============================================================================
// Polyphase Rational Resampler (matches SDR++ dsp/multirate/polyphase_resampler.h)
// ============================================================================

/// Polyphase rational resampler for f32 mono audio data.
/// Resamples by interp/decim ratio using a polyphase filter bank.
pub(crate) struct PolyphaseResamplerF32 {
    interp: usize,
    decim: usize,
    taps_per_phase: usize,
    phases: Vec<Vec<f32>>,
    buffer: Vec<f32>,
    buf_start_offset: usize,
    phase: usize,
    offset: usize,
}

impl PolyphaseResamplerF32 {
    pub(crate) fn new(interp: usize, decim: usize, taps: &[f32]) -> Self {
        let phase_count = interp;
        let taps_per_phase = (taps.len() + phase_count - 1) / phase_count;
        let mut phases = vec![vec![0.0f32; taps_per_phase]; phase_count];

        let tot_tap_count = phase_count * taps_per_phase;
        for i in 0..tot_tap_count {
            let phase_idx = (phase_count - 1) - (i % phase_count);
            let tap_idx = i / phase_count;
            phases[phase_idx][tap_idx] = if i < taps.len() { taps[i] } else { 0.0 };
        }

        let buffer = vec![0.0f32; taps_per_phase - 1 + 65536];
        PolyphaseResamplerF32 {
            interp,
            decim,
            taps_per_phase,
            phases,
            buffer,
            buf_start_offset: taps_per_phase - 1,
            phase: 0,
            offset: 0,
        }
    }

    pub(crate) fn process(&mut self, input: &[f32], output: &mut Vec<f32>) {
        let count = input.len();
        // Grow buffer dynamically if input exceeds pre-allocated size
        let needed = self.buf_start_offset + count;
        if needed > self.buffer.len() {
            self.buffer.resize(needed, 0.0);
        }
        // Copy input into delay line
        self.buffer[self.buf_start_offset..self.buf_start_offset + count]
            .copy_from_slice(input);

        while self.offset < count {
            // Dot product with current phase taps
            let phase_taps = &self.phases[self.phase];
            let mut sum = 0.0f32;
            for j in 0..self.taps_per_phase {
                sum += self.buffer[self.offset + j] * phase_taps[j];
            }
            output.push(sum);

            self.phase += self.decim;
            self.offset += self.phase / self.interp;
            self.phase %= self.interp;
        }
        self.offset -= count;

        // Move delay line (memmove equivalent)
        self.buffer.copy_within(count..count + self.taps_per_phase - 1, 0);
    }

    pub(crate) fn reset(&mut self) {
        self.buffer.fill(0.0);
        self.phase = 0;
        self.offset = 0;
    }
}

/// Polyphase rational resampler for complex IQ data.
/// Each complex sample is two f32 (I, Q) interleaved.
pub(crate) struct PolyphaseResamplerComplex {
    interp: usize,
    decim: usize,
    taps_per_phase: usize,
    phases: Vec<Vec<f32>>,
    buffer_i: Vec<f32>,
    buffer_q: Vec<f32>,
    buf_start_offset: usize,
    phase: usize,
    offset: usize,
}

impl PolyphaseResamplerComplex {
    pub(crate) fn new(interp: usize, decim: usize, taps: &[f32]) -> Self {
        let phase_count = interp;
        let taps_per_phase = (taps.len() + phase_count - 1) / phase_count;
        let mut phases = vec![vec![0.0f32; taps_per_phase]; phase_count];

        let tot_tap_count = phase_count * taps_per_phase;
        for i in 0..tot_tap_count {
            let phase_idx = (phase_count - 1) - (i % phase_count);
            let tap_idx = i / phase_count;
            phases[phase_idx][tap_idx] = if i < taps.len() { taps[i] } else { 0.0 };
        }

        let buf_size = taps_per_phase - 1 + 262144;
        PolyphaseResamplerComplex {
            interp,
            decim,
            taps_per_phase,
            phases,
            buffer_i: vec![0.0f32; buf_size],
            buffer_q: vec![0.0f32; buf_size],
            buf_start_offset: taps_per_phase - 1,
            phase: 0,
            offset: 0,
        }
    }

    /// Process `count` complex samples from separate I/Q arrays.
    /// Output is appended to out_i and out_q.
    pub(crate) fn process(&mut self, in_i: &[f32], in_q: &[f32], out_i: &mut Vec<f32>, out_q: &mut Vec<f32>) {
        let count = in_i.len();
        debug_assert_eq!(in_i.len(), in_q.len());

        // Grow buffers dynamically if input exceeds pre-allocated size
        let needed = self.buf_start_offset + count;
        if needed > self.buffer_i.len() {
            self.buffer_i.resize(needed, 0.0);
            self.buffer_q.resize(needed, 0.0);
        }

        self.buffer_i[self.buf_start_offset..self.buf_start_offset + count]
            .copy_from_slice(in_i);
        self.buffer_q[self.buf_start_offset..self.buf_start_offset + count]
            .copy_from_slice(in_q);

        while self.offset < count {
            let phase_taps = &self.phases[self.phase];
            let mut sum_i = 0.0f32;
            let mut sum_q = 0.0f32;
            for j in 0..self.taps_per_phase {
                sum_i += self.buffer_i[self.offset + j] * phase_taps[j];
                sum_q += self.buffer_q[self.offset + j] * phase_taps[j];
            }
            out_i.push(sum_i);
            out_q.push(sum_q);

            self.phase += self.decim;
            self.offset += self.phase / self.interp;
            self.phase %= self.interp;
        }
        self.offset -= count;

        self.buffer_i.copy_within(count..count + self.taps_per_phase - 1, 0);
        self.buffer_q.copy_within(count..count + self.taps_per_phase - 1, 0);
    }

    pub(crate) fn reset(&mut self) {
        self.buffer_i.fill(0.0);
        self.buffer_q.fill(0.0);
        self.phase = 0;
        self.offset = 0;
    }
}
