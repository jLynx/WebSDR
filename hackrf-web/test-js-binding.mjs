import assert from 'assert';
import { FFT } from './node/hackrf_web.js';

async function test() {
	// WASM module is loaded automatically
	console.log('✓ WASM module loaded');

	// Create FFT instance (passing a Float32Array from the JS side)
	const n = 8;
	const window = new Float32Array(n).fill(1.0);
	const fft = new FFT(n, window);
	console.log('✓ FFT instance created');

	// DC input (Int8Array from the JS side)
	const input = new Int8Array(n * 2);
	for (let i = 0; i < n; i++) {
		input[i * 2] = 64;     // real part = 0.5 (64/128)
		input[i * 2 + 1] = 0;  // imaginary part = 0
	}
	console.log('✓ Input array created (DC signal)');

	// Output buffer (Float32Array from the JS side)
	const output = new Float32Array(n);

	// Execute FFT via the JS ↔ WASM binding
	fft.fft(input, output);
	console.log('✓ FFT executed via JS binding');

	// Validate results
	assert.strictEqual(output.length, n, 'Output length should match FFT size');

	// Check the DC component value (index 4 = n/2)
	const dcIndex = n / 2;
	console.log('DC component (index ' + dcIndex + '):', output[dcIndex]);
	console.log('First component (index 0):', output[0]);

	// Verify the DC component is larger than other frequencies
	assert.ok(output[dcIndex] > output[0], 'DC component should be greater than other frequencies');

	// Verify output values are within a reasonable range (dB scale)
	assert.ok(output[dcIndex] < 0, 'DC component should be negative (dB scale)');
	assert.ok(output[dcIndex] > -100, 'DC component should be greater than -100 dB');

	console.log('Output values:', Array.from(output));
	console.log('✓ DC component validation passed');

	console.log('\n✅ All tests passed!');
}

test().catch(err => {
	console.error('❌ Test failed:', err);
	process.exit(1);
});
