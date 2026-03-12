use crate::fft::FFT;
use rustfft::FftPlanner;
use rustfft::num_complex::Complex;

/// Generate a unit (rectangular) window with no shaping
fn ones_window(n: usize) -> Vec<f32> {
    vec![1.0; n]
}

#[test]
fn test_fft_construction() {
    let n = 8;
    let window = ones_window(n);
    let fft = FFT::new(n, &window);

    assert_eq!(fft.n, n);
    // Internal fields are not directly accessible, but construction succeeding is OK
}

#[test]
fn test_fft_set_smoothing_speed() {
    let n = 8;
    let window = ones_window(n);
    let mut fft = FFT::new(n, &window);

    fft.set_smoothing_speed(0.5);
    // Setting succeeds is OK (internal fields are private)
}

#[test]
fn test_fft_dc_input() {
    // FFT test with DC-only input (all same values)
    let n = 8;
    let window = ones_window(n);
    let mut fft = FFT::new(n, &window);

    let mut input = vec![0i8; n * 2]; // Complex<i8> so n * 2
    for i in 0..n {
        input[i * 2] = 64; // real = 64
        input[i * 2 + 1] = 0; // imaginary = 0
    }

    let mut result = vec![0.0f32; n];
    fft.fft(&input, &mut result);

    // Results are rearranged to DC-centered, so DC component is at center (half_n)
    let half_n = n / 2;
    let dc_component = result.iter().enumerate().max_by(|a, b| {
        a.1.partial_cmp(b.1).unwrap()
    });

    // DC component should be at index 4 (half_n)
    assert_eq!(dc_component.unwrap().0, half_n);
}

#[test]
fn test_fft_zero_input_should_not_produce_inf() {
    // All-zero input: should not produce log10(0) = -inf
    let n = 8;
    let window = ones_window(n);
    let mut fft = FFT::new(n, &window);

    let input = vec![0i8; n * 2]; // all zeros

    let mut result = vec![0.0f32; n];
    fft.fft(&input, &mut result);

    // All results should be finite (not inf, -inf, or NaN)
    for (i, &val) in result.iter().enumerate() {
        assert!(
            val.is_finite(),
            "result[{}] = {} is not finite (zero input should not produce inf)",
            i, val
        );
    }
}

#[test]
fn test_fft_smoothing() {
    // Numerically verify the effect of smoothing
    // When smoothing_speed = 0.5 (SDR++ semantics):
    // result[k] = 0.5 * new_dB[k] + 0.5 * prev_dB[k]
    let n = 8;
    let window = ones_window(n);
    let mut fft = FFT::new(n, &window);
    fft.set_smoothing_speed(0.5);

    let mut input = vec![0i8; n * 2];
    for i in 0..n {
        input[i * 2] = 64; // real = 64
        input[i * 2 + 1] = 0; // imaginary = 0
    }

    let mut result1 = vec![0.0f32; n];
    fft.fft(&input, &mut result1);

    let mut result2 = vec![0.0f32; n];
    fft.fft(&input, &mut result2);

    // With smoothing applied, the 2nd result should differ from the 1st
    // (because prev holds non-zero values)
    let mut differences_found = false;
    for i in 0..n {
        if result1[i].is_finite() && result2[i].is_finite() {
            let diff = (result1[i] - result2[i]).abs();
            // Values should have changed due to smoothing (tolerance 1e-6)
            if diff > 1e-6 {
                differences_found = true;
            }
        }
    }
    assert!(
        differences_found,
        "Smoothing should produce different results on consecutive calls with same input"
    );
}

#[test]
fn test_fft_smoothing_disabled_when_speed_is_one() {
    // Smoothing is disabled when smoothing_speed = 1.0 (SDR++ semantics: 1.0 = no smoothing)
    let n = 8;
    let window = ones_window(n);
    let mut fft = FFT::new(n, &window);
    // Default is 1.0 (no smoothing)

    let mut input = vec![0i8; n * 2];
    for i in 0..n {
        input[i * 2] = 64;
        input[i * 2 + 1] = 0;
    }

    let mut result1 = vec![0.0f32; n];
    fft.fft(&input, &mut result1);

    let mut result2 = vec![0.0f32; n];
    fft.fft(&input, &mut result2);

    // Without smoothing, same input → same output
    for i in 0..n {
        if result1[i].is_finite() && result2[i].is_finite() {
            assert_eq!(
                result1[i], result2[i],
                "Without smoothing, same input should produce same output at index {}",
                i
            );
        }
    }
}

#[test]
fn test_fft_smoothing_edge_cases() {
    // Boundary value tests for smoothing_speed (SDR++ semantics)
    let n = 8;
    let window = ones_window(n);

    // 1.0: No smoothing (100% new value, tested above)

    // 0.0: Fully retain previous value (ignore new value, output frozen)
    let mut fft = FFT::new(n, &window);
    fft.set_smoothing_speed(0.0);

    let mut input = vec![0i8; n * 2];
    for i in 0..n {
        input[i * 2] = 64;
        input[i * 2 + 1] = 0;
    }

    let mut result1 = vec![0.0f32; n];
    fft.fft(&input, &mut result1);

    let mut result2 = vec![0.0f32; n];
    fft.fft(&input, &mut result2);

    // When α=0.0, result2 should equal result1 (output is frozen)
    for i in 0..n {
        if result1[i].is_finite() && result2[i].is_finite() {
            assert_eq!(
                result1[i], result2[i],
                "With α=0.0, output should stay constant at index {}",
                i
            );
        }
    }

    // Negative value: behavior is undefined but must not crash
    let mut fft = FFT::new(n, &window);
    fft.set_smoothing_speed(-0.5);
    let mut result = vec![0.0f32; n];
    // OK as long as it doesn't crash
    fft.fft(&input, &mut result);

    // Value greater than 1.0: may oscillate but must not crash
    let mut fft = FFT::new(n, &window);
    fft.set_smoothing_speed(1.5);
    let mut result = vec![0.0f32; n];
    fft.fft(&input, &mut result);
}

#[test]
fn test_fft_dc_input_magnitude() {
    // Verify numerical correctness of FFT results for DC input
    let n = 8;
    let window = ones_window(n);
    let mut fft = FFT::new(n, &window);

    // DC component: all (64 + 0j)
    let mut input = vec![0i8; n * 2];
    for i in 0..n {
        input[i * 2] = 64;
        input[i * 2 + 1] = 0;
    }

    let mut result = vec![0.0f32; n];
    fft.fft(&input, &mut result);

    // Theoretical calculation:
    // Input: 64/128 = 0.5
    // With (-1)^i window shift, DC signal becomes alternating → all energy at bin N/2
    // DC component after FFT: 0.5 * 8 = 4.0 (scaled by 1/(128*8)), magnitude = 0.5
    // Power: 0.5^2 = 0.25
    // dB: 10 * log10(0.25) ≈ -6.02
    let half_n = n / 2;
    let dc_value = result[half_n]; // DC component is at center

    let expected_db = 10.0 * (0.5_f32 * 0.5_f32).log10(); // ≈ -6.02
    assert!(
        (dc_value - expected_db).abs() < 0.1,
        "DC component {} should be close to {} (dB)",
        dc_value, expected_db
    );

    // DC component should be the maximum
    let max_idx = result
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
        .map(|(i, _)| i)
        .unwrap();
    assert_eq!(max_idx, half_n, "DC component should be at index {}", half_n);
}

#[test]
fn test_fft_negative_input() {
    // Test with negative input values
    let n = 8;
    let window = ones_window(n);
    let mut fft = FFT::new(n, &window);

    let mut input = vec![0i8; n * 2];
    for i in 0..n {
        input[i * 2] = -64; // negative value
        input[i * 2 + 1] = 0;
    }

    let mut result = vec![0.0f32; n];
    fft.fft(&input, &mut result);

    // All values should be finite
    for (i, &val) in result.iter().enumerate() {
        assert!(
            val.is_finite(),
            "result[{}] = {} is not finite (negative input should be handled)",
            i, val
        );
    }
}

#[test]
fn test_fft_i8_boundary_values() {
    // Boundary value tests for i8
    let n = 8;
    let window = ones_window(n);
    let mut fft = FFT::new(n, &window);

    // i8::MIN = -128, i8::MAX = 127
    let test_values = [i8::MIN, -1, 0, 1, i8::MAX];

    for &val in &test_values {
        let mut input = vec![0i8; n * 2];
        for i in 0..n {
            input[i * 2] = val;
            input[i * 2 + 1] = 0;
        }

        let mut result = vec![0.0f32; n];
        fft.fft(&input, &mut result);

        // Should not crash, all values should be finite
        for (i, &r) in result.iter().enumerate() {
            assert!(
                r.is_finite(),
                "result[{}] = {} is not finite for input value {}",
                i, r, val
            );
        }
    }
}

#[test]
#[should_panic(expected = "Window size must match FFT size")]
fn test_fft_window_size_mismatch() {
    let n = 8;
    let window = vec![1.0; 4]; // undersized
    let _fft = FFT::new(n, &window);
}

#[test]
#[should_panic(expected = "Window size must match FFT size")]
fn test_fft_window_size_oversized() {
    let n = 8;
    let window = vec![1.0; 16]; // oversized
    let _fft = FFT::new(n, &window);
}

#[test]
#[should_panic(expected = "FFT size must be positive")]
fn test_fft_zero_size() {
    let _fft = FFT::new(0, &[]);
}

#[test]
#[should_panic(expected = "FFT size must be a power of two")]
fn test_fft_non_power_of_two() {
    let n = 7; // not a power of two
    let window = vec![1.0; n];
    let _fft = FFT::new(n, &window);
}

#[test]
#[should_panic(expected = "FFT size must be a power of two")]
fn test_fft_odd_size() {
    let n = 9; // odd number
    let window = vec![1.0; n];
    let _fft = FFT::new(n, &window);
}

#[test]
fn test_fft_differential_against_reference() {
    // Compare results between reference (naive) implementation and optimized version
    let n = 16;
    let mut window = vec![0.0f32; n];
    for (i, w) in window.iter_mut().enumerate() {
         // Generate a Hann-like window
         *w = 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / (n - 1) as f32).cos());
    }

    let mut fft = FFT::new(n, &window);
    fft.set_smoothing_speed(0.3);

    let mut input = vec![0i8; n * 2];
    for i in 0..n {
        input[i*2] = (i as i8).wrapping_sub(8).wrapping_mul(10);
        input[i*2+1] = (7i8).wrapping_sub(i as i8).wrapping_mul(10);
    }

    // First run (updating prev from zero)
    let mut result_opt = vec![0.0f32; n];
    fft.fft(&input, &mut result_opt);

    // Reference calculation (1st run)
    let mut prev = vec![0.0f32; n]; // initial state
    let expected = calculate_reference_fft(n, &window, &input, &mut prev, 0.3);

    for i in 0..n {
        assert!((result_opt[i] - expected[i]).abs() < 1e-5, "Mismatch at index {} on 1st run: opt={}, expected={}", i, result_opt[i], expected[i]);
    }

    // Second run (verify smoothing effect)
    fft.fft(&input, &mut result_opt);
    let expected2 = calculate_reference_fft(n, &window, &input, &mut prev, 0.3);

    for i in 0..n {
        assert!((result_opt[i] - expected2[i]).abs() < 1e-5, "Mismatch at index {} on 2nd run: opt={}, expected={}", i, result_opt[i], expected2[i]);
    }
}

/// Naive reference calculation matching SDR++ pipeline (efficiency ignored)
fn calculate_reference_fft(n: usize, window: &[f32], input: &[i8], prev: &mut [f32], alpha: f32) -> Vec<f32> {
    // Apply window with (-1)^i shift and scaling (matches SDR++ iq_frontend.cpp)
    let scale = 1.0 / (128.0 * n as f32);
    let mut buffer = vec![Complex { re: 0.0, im: 0.0 }; n];
    for i in 0..n {
        let shift = if i % 2 == 0 { 1.0f32 } else { -1.0f32 };
        buffer[i] = Complex {
            re: input[i*2] as f32,
            im: input[i*2+1] as f32,
        } * (window[i] * scale * shift);
    }

    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(n);
    fft.process(&mut buffer);

    // Power spectrum + dB + smoothing in dB domain (matches SDR++ waterfall.cpp)
    let mut res = vec![0.0f32; n];
    for i in 0..n {
        let power = buffer[i].norm_sqr();
        let db = power.max(1e-20).log10() * 10.0;

        res[i] = if alpha < 1.0 {
            let s = alpha * db + (1.0 - alpha) * prev[i];
            prev[i] = s;
            s
        } else {
            db
        };
    }
    res
}
