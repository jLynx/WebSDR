// ============================================================================
// DSP Primitives (matching SDR++ core/src/dsp/)
// ============================================================================

/// Cosine window (matches SDR++ dsp/window/cosine.h)
/// n: continuous offset value, big_n: window length N
pub(crate) fn cosine_window(n: f64, big_n: f64, coefs: &[f64]) -> f64 {
    let mut win = 0.0;
    let mut sign = 1.0;
    for (i, &c) in coefs.iter().enumerate() {
        win += sign * c * (i as f64 * 2.0 * std::f64::consts::PI * n / big_n).cos();
        sign = -sign;
    }
    win
}

/// Nuttall 4-term cosine window (matches SDR++ dsp/window/nuttall.h)
/// n: continuous offset value, big_n: window length N
pub(crate) fn nuttall_window(n: f64, big_n: f64) -> f64 {
    const COEFS: [f64; 4] = [0.355768, 0.487396, 0.144232, 0.012604];
    cosine_window(n, big_n, &COEFS)
}

/// sinc(x) = sin(x)/x, sinc(0) = 1
pub(crate) fn sinc(x: f64) -> f64 {
    if x.abs() < 1e-12 {
        1.0
    } else {
        x.sin() / x
    }
}

/// Estimate FIR tap count (matches SDR++ dsp/taps/estimate_tap_count.h)
pub(crate) fn estimate_tap_count(trans_width: f64, sample_rate: f64) -> usize {
    (3.8 * sample_rate / trans_width).floor() as usize
}

/// Generate low-pass FIR taps using windowed sinc with Nuttall window
/// (matches SDR++ dsp/taps/low_pass.h + dsp/taps/windowed_sinc.h)
pub(crate) fn low_pass_taps(cutoff: f64, trans_width: f64, sample_rate: f64) -> Vec<f32> {
    let count = estimate_tap_count(trans_width, sample_rate).max(1);
    let omega = 2.0 * std::f64::consts::PI * cutoff / sample_rate;
    let half = count as f64 / 2.0;
    let corr = omega / std::f64::consts::PI;
    let mut taps = Vec::with_capacity(count);
    for i in 0..count {
        let t = i as f64 - half + 0.5;
        // SDR++ windowed_sinc.h passes (t - half, count) to window function
        let win = nuttall_window(t - half, count as f64);
        let val = sinc(t * omega) * win * corr;
        taps.push(val as f32);
    }
    taps
}

/// Generate high-pass FIR taps using spectral inversion of low-pass
/// (matches SDR++ dsp/taps/high_pass.h)
pub(crate) fn high_pass_taps(cutoff: f64, trans_width: f64, sample_rate: f64) -> Vec<f32> {
    let mut count = estimate_tap_count(trans_width, sample_rate).max(1);
    count |= 1; // Length must be odd for spectral inversion

    let omega = 2.0 * std::f64::consts::PI * cutoff / sample_rate;
    let half = count as f64 / 2.0;
    let corr = omega / std::f64::consts::PI;
    let mut taps = Vec::with_capacity(count);

    for i in 0..count {
        let t = i as f64 - half + 0.5;
        let win = nuttall_window(t - half, count as f64);
        let val = sinc(t * omega) * win * corr;

        let mut tap_val = -(val as f32); // Invert
        if i == count / 2 {
            tap_val += 1.0;
        }
        taps.push(tap_val);
    }
    taps
}

/// Greatest common divisor
pub(crate) fn gcd(mut a: usize, mut b: usize) -> usize {
    while b != 0 {
        let t = b;
        b = a % b;
        a = t;
    }
    a
}
