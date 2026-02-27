//#!/usr/bin/env node
//

const lib = require("./node/hackrf_web.js");
console.log(lib);
lib.init();

const fft = new lib.FFT(2048);

const input  = new Uint8Array(2048);
for (let i = 0; i < input.length; i++) {
	input[i] = 0x100 * Math.random();
}
console.log(input);

const output = new Float32Array(2048);

fft.fft(input, output);
console.log(output);
