// ============================================================================
// FIR Filter (matches SDR++ dsp/filter/fir.h)
// ============================================================================

/// Complex FIR filter with real taps (matches SDR++ volk_32fc_32f_dot_prod_32fc)
pub(crate) struct ComplexFIR {
    taps: Vec<f32>,
    history_i: Vec<f32>,
    history_q: Vec<f32>,
    hist_idx: usize,
}

impl ComplexFIR {
    pub(crate) fn new(taps: Vec<f32>) -> Self {
        let len = taps.len();
        ComplexFIR {
            taps,
            history_i: vec![0.0; len],
            history_q: vec![0.0; len],
            hist_idx: 0,
        }
    }

    pub(crate) fn set_taps(&mut self, taps: Vec<f32>) {
        let len = taps.len();
        self.taps = taps;
        self.history_i = vec![0.0; len];
        self.history_q = vec![0.0; len];
        self.hist_idx = 0;
    }

    pub(crate) fn process_block(&mut self, in_i: &[f32], in_q: &[f32], out_i: &mut [f32], out_q: &mut [f32]) {
        for k in 0..in_i.len() {
            self.history_i[self.hist_idx] = in_i[k];
            self.history_q[self.hist_idx] = in_q[k];

            let mut si = 0.0f32;
            let mut sq = 0.0f32;
            let mut tap_idx = 0;

            // Circular buffer dot product
            let mut i = self.hist_idx as isize;
            loop {
                si += self.history_i[i as usize] * self.taps[tap_idx];
                sq += self.history_q[i as usize] * self.taps[tap_idx];
                tap_idx += 1;
                i -= 1;
                if i < 0 { i = self.taps.len() as isize - 1; }
                if i == self.hist_idx as isize { break; }
            }

            out_i[k] = si;
            out_q[k] = sq;

            self.hist_idx += 1;
            if self.hist_idx >= self.taps.len() {
                self.hist_idx = 0;
            }
        }
    }

    pub(crate) fn reset(&mut self) {
        self.history_i.fill(0.0);
        self.history_q.fill(0.0);
        self.hist_idx = 0;
    }
}

/// Real FIR filter with real taps (for post-demod audio filtering)
pub(crate) struct RealFIR {
    taps: Vec<f32>,
    history: Vec<f32>,
    hist_idx: usize,
}

impl RealFIR {
    pub(crate) fn new(taps: Vec<f32>) -> Self {
        let len = taps.len();
        RealFIR {
            taps,
            history: vec![0.0; len],
            hist_idx: 0,
        }
    }

    pub(crate) fn set_taps(&mut self, taps: Vec<f32>) {
        let len = taps.len();
        self.taps = taps;
        self.history = vec![0.0; len];
        self.hist_idx = 0;
    }

    pub(crate) fn process_block(&mut self, input: &[f32], output: &mut [f32]) {
        for k in 0..input.len() {
            self.history[self.hist_idx] = input[k];

            let mut sum = 0.0f32;
            let mut tap_idx = 0;

            let mut i = self.hist_idx as isize;
            loop {
                sum += self.history[i as usize] * self.taps[tap_idx];
                tap_idx += 1;
                i -= 1;
                if i < 0 { i = self.taps.len() as isize - 1; }
                if i == self.hist_idx as isize { break; }
            }

            output[k] = sum;

            self.hist_idx += 1;
            if self.hist_idx >= self.taps.len() {
                self.hist_idx = 0;
            }
        }
    }

    pub(crate) fn reset(&mut self) {
        self.history.fill(0.0);
        self.hist_idx = 0;
    }
}
