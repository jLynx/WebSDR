const N = 8192;
const input = new Float32Array(N);
for (let i = 0; i < N; i++) input[i] = Math.random() * 2 - 1.0;

// cic test
let cic_buf_i = Array.from(input);
let cic_len = N;
let start = performance.now();
for (let s = 0; s < 5; s++) {
    let half = Math.floor(cic_len / 2);
    for (let k = 0; k < half; k++) {
        cic_buf_i[k] = (cic_buf_i[2 * k] + cic_buf_i[2 * k + 1]) * 0.5;
    }
    cic_len = half;
}
console.log("CIC test len", cic_len, "val", cic_buf_i[0], "time", performance.now() - start);

