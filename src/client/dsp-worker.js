import init, { DspProcessor, set_panic_hook, alloc_iq_buffer, free_iq_buffer } from "./hackrf-web/pkg/hackrf_web.js";

// --- FIR & Resampler Math ---
const sinc = (x) => (x === 0.0) ? 1.0 : (Math.sin(x) / x);

const cosineWindow = (n, N, coefs) => {
    let win = 0.0;
    let sign = 1.0;
    for (let i = 0; i < coefs.length; i++) {
        win += sign * coefs[i] * Math.cos(i * 2.0 * Math.PI * n / N);
        sign = -sign;
    }
    return win;
};

const nuttall = (n, N) => {
    const coefs = [0.355768, 0.487396, 0.144232, 0.012604];
    return cosineWindow(n, N, coefs);
};

const hzToRads = (freq, samplerate) => 2.0 * Math.PI * (freq / samplerate);

const estimateTapCount = (transWidth, samplerate) => {
    return Math.floor(3.8 * samplerate / transWidth);
};

const windowedSincBase = (count, omega, windowFunc, norm = 1.0) => {
    const taps = new Float32Array(count);
    const half = count / 2.0;
    const corr = norm * omega / Math.PI;

    for (let i = 0; i < count; i++) {
        const t = i - half + 0.5;
        taps[i] = sinc(t * omega) * windowFunc(t - half, count) * corr;
    }
    return taps;
};

const lowPassTaps = (cutoff, transWidth, samplerate, oddTapCount = false) => {
    let count = estimateTapCount(transWidth, samplerate);
    if (oddTapCount && count % 2 === 0) count++;
    const omega = hzToRads(cutoff, samplerate);
    return windowedSincBase(count, omega, (n, N) => nuttall(n, N));
};

const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));

class PolyphaseResampler {
    constructor(interp, decim, taps) {
        this.interp = interp;
        this.decim = decim;
        this.taps = taps;

        this.phaseCount = interp;
        this.tapsPerPhase = Math.floor((taps.length + this.phaseCount - 1) / this.phaseCount);
        this.phases = new Array(this.phaseCount);

        for (let i = 0; i < this.phaseCount; i++) {
            this.phases[i] = new Float32Array(this.tapsPerPhase);
        }

        const totTapCount = this.phaseCount * this.tapsPerPhase;
        for (let i = 0; i < totTapCount; i++) {
            const phaseIdx = (this.phaseCount - 1) - (i % this.phaseCount);
            const tapIdx = Math.floor(i / this.phaseCount);
            this.phases[phaseIdx][tapIdx] = (i < taps.length) ? taps[i] : 0.0;
        }

        const initBlockSize = 4096;
        this.bufStartOffset = this.tapsPerPhase - 1;
        this.buffer = new Float32Array(this.bufStartOffset + initBlockSize);
        this.phase = 0;
        this.offset = 0;

        this._outBuf = new Float32Array(Math.ceil(initBlockSize * interp / decim) + 4);
    }

    process(input, count) {
        const needed = this.bufStartOffset + count;
        if (needed > this.buffer.length) {
            const bigger = new Float32Array(needed + 1024);
            bigger.set(this.buffer.subarray(0, this.bufStartOffset));
            this.buffer = bigger;
        }

        this.buffer.set(input.subarray(0, count), this.bufStartOffset);

        const maxOut = Math.ceil(count * this.interp / this.decim) + 4;
        if (maxOut > this._outBuf.length) {
            this._outBuf = new Float32Array(maxOut + 64);
        }

        let outIdx = 0;
        while (this.offset < count) {
            let sum = 0.0;
            const phaseTaps = this.phases[this.phase];
            const bufOff = this.offset;
            for (let i = 0; i < this.tapsPerPhase; i++) {
                sum += this.buffer[bufOff + i] * phaseTaps[i];
            }
            this._outBuf[outIdx++] = sum;

            this.phase += this.decim;
            this.offset += Math.floor(this.phase / this.interp);
            this.phase = this.phase % this.interp;
        }
        this.offset -= count;
        this.buffer.copyWithin(0, count, count + this.bufStartOffset);
        return this._outBuf.subarray(0, outIdx);
    }
}

class RationalResampler {
    constructor(inSamplerate, outSamplerate) {
        const IntSR = Math.round(inSamplerate);
        const OutSR = Math.round(outSamplerate);
        const divider = gcd(IntSR, OutSR);

        this.interp = OutSR / divider;
        this.decim = IntSR / divider;

        const tapSamplerate = inSamplerate * this.interp;
        const tapBandwidth = Math.min(inSamplerate, outSamplerate) / 2.0;
        const tapTransWidth = tapBandwidth * 0.1;

        let taps = lowPassTaps(tapBandwidth, tapTransWidth, tapSamplerate);
        for (let i = 0; i < taps.length; i++) taps[i] *= this.interp;

        this.resamp = new PolyphaseResampler(this.interp, this.decim, taps);
    }

    process(input) {
        return this.resamp.process(input, input.length);
    }
}

// --- Worker State ---
let wasmInitPromise = null;
let _wasm;
let ddc;
let vfoState;
let sharedIqPtr = 0;
let sharedSabViews = null;

const IF_RATES = {
    nfm: 50000,
    wfm: 250000,
    am: 15000,
    usb: 24000,
    lsb: 24000,
    dsb: 24000,
    cw: 3000,
    raw: 48000,
};
const AUDIO_RATE = 48000;

async function startup() {
    if (!wasmInitPromise) {
        wasmInitPromise = init().then((w) => {
            _wasm = w;
            set_panic_hook();

            // Allocate Wasm memory for this sub-module
            const MAX_USB_SAMPLES = 131072;
            sharedIqPtr = alloc_iq_buffer(MAX_USB_SAMPLES * 2);
            console.log("DSP Worker: Wasm Initialized. IQ Buffer Ptr:", sharedIqPtr);
        }).catch(err => {
            console.error("DSP Worker: Wasm Init Failed:", err);
        });
    }
    await wasmInitPromise;
}

let systemSampleRate = 2000000;

self.onmessage = async (e) => {
    const msg = e.data;
    await startup();

    if (msg.type === "init") {
        systemSampleRate = msg.sampleRate;
        // Initialize the DDC and VFO state
        if (ddc) {
            ddc.free();
        }
        ddc = new DspProcessor(msg.sampleRate, 0.0, msg.params.bandwidth || 150000);

        vfoState = {
            dcAvg: 0,
            carrierAgcGain: 1.0,
            deemphPrev: 0,
            agcGain: 1.0,
            ssbPhase: 0.0,
            audioResampler: null,
            currentIfRate: 0,
            scratchBuf: new Float32Array(512),
            audioTarget: new Float32Array(2048),
            squelchOpen: false,
        };
        sharedSabViews = msg.sabs ? msg.sabs.map(s => new Int8Array(s)) : null;

        configureDDC(msg.params, msg.centerFreq);

        self.postMessage({ type: "init_done" });
    }
    else if (msg.type === "configure") {
        configureDDC(msg.params, msg.centerFreq);
        self.postMessage({ type: "config_done" });
    }
    else if (msg.type === "process") {
        if (!ddc || !vfoState) {
            console.log("DSP Worker: ddc/vfoState unavailable");
            return;
        }

        // Copy payload into WASM memory
        const wasmMemView = new Int8Array(_wasm.memory.buffer);

        if (msg.useSab && sharedSabViews && msg.sabIndex !== undefined) {
            // Zero-copy grab from SAB ring!
            wasmMemView.set(sharedSabViews[msg.sabIndex].subarray(0, msg.chunkLen), sharedIqPtr);
        } else if (msg.chunk) {
            // Direct copy from received buffer
            wasmMemView.set(new Int8Array(msg.chunk), sharedIqPtr);
        } else {
            return; // Invalid chunk
        }

        try {
            const processStart = performance.now();
            const audioOut = processVfoAudio(msg.chunkLen, msg.params);
            const processEnd = performance.now();
            const dspTime = processEnd - processStart;

            if (audioOut) {
                // We MUST slice/copy to isolate it from WASM before transferring
                const cloneOut = audioOut.slice();
                self.postMessage({
                    type: "audio",
                    samples: cloneOut.buffer,
                    chunkId: msg.chunkId,
                    squelchOpen: vfoState.squelchOpen,
                    dspTime: dspTime
                }, [cloneOut.buffer]);
            } else {
                self.postMessage({ type: "audio", samples: null, chunkId: msg.chunkId, squelchOpen: vfoState.squelchOpen, dspTime: dspTime });
            }
        } catch (err) {
            self.postMessage({ type: "error", error: err.message });
        }
    }
};

function configureDDC(params, systemCenterFreq) {
    if (vfoState.currentIfRate !== IF_RATES[params.mode]) {
        vfoState.audioResampler = new RationalResampler(IF_RATES[params.mode], AUDIO_RATE);
        vfoState.currentIfRate = IF_RATES[params.mode];
        ddc.set_if_sample_rate(IF_RATES[params.mode]);
    }

    const offsetFreq = (params.freq - systemCenterFreq) * 1e6;
    ddc.set_shift(systemSampleRate, offsetFreq);
    ddc.set_bandwidth(params.bandwidth);
    ddc.set_squelch(params.squelchLevel, params.squelchEnabled);
    if (params.mode === 'wfm') {
        ddc.set_wfm_mode(true);
    } else {
        ddc.set_wfm_mode(false);
    }

    // Apply UI audio filters (High Pass 300Hz, Low Pass BW/2)
    ddc.set_audio_filters(params.lowPass || false, params.highPass || false);
}

function processVfoAudio(chunkLenBytes, params) {
    const mode = params.mode;
    let bw = params.bandwidth;

    if (mode === 'nfm' || mode === 'wfm') {
        let outPtr;
        try {
            outPtr = ddc.process_ptr(sharedIqPtr, chunkLenBytes);
        } catch (e) {
            console.error("DEBUG process_ptr crashed:", e);
            throw e;
        }

        const numAudioSamples = ddc.get_output_len();

        let isSquelched = false;
        if (params.squelchEnabled && numAudioSamples > 0) {
            // Rust zeros the buffer to apply squelch mute instantly
            // Checking the middle sample is a reliable indicator that the UI squelch is clamped shut.
            isSquelched = (ddc.get_output_len() > 0 && new Float32Array(_wasm.memory.buffer, outPtr, numAudioSamples)[Math.floor(numAudioSamples / 2)] === 0.0);
        }
        vfoState.squelchOpen = !isSquelched;

        if (numAudioSamples === 0) return null;

        const result = new Float32Array(_wasm.memory.buffer, outPtr, numAudioSamples);

        // De-emphasis
        if (params.deEmphasis !== 'none') {
            let tau = 0;
            if (params.deEmphasis === '22us') tau = 22e-6;
            else if (params.deEmphasis === '50us') tau = 50e-6;
            else if (params.deEmphasis === '75us') tau = 75e-6;

            const alpha = 1.0 / (1.0 + tau * AUDIO_RATE);
            const oneMinusAlpha = 1.0 - alpha;

            let prev = vfoState.deemphPrev;
            for (let i = 0; i < numAudioSamples; i++) {
                prev = alpha * result[i] + oneMinusAlpha * prev;
                result[i] = prev < -1.0 ? -1.0 : prev > 1.0 ? 1.0 : prev;
            }
            vfoState.deemphPrev = prev;
        } else {
            for (let i = 0; i < numAudioSamples; i++) {
                if (result[i] > 1.0) result[i] = 1.0;
                else if (result[i] < -1.0) result[i] = -1.0;
            }
        }

        if (numAudioSamples > vfoState.audioTarget.length) {
            vfoState.audioTarget = new Float32Array(numAudioSamples + 1024);
        }
        const outView = vfoState.audioTarget.subarray(0, numAudioSamples);
        outView.set(result);
        return outView;
    } else {
        // Non-FM Path
        const outPtr = ddc.process_iq_only_ptr(sharedIqPtr, chunkLenBytes);
        const numOutValues = ddc.get_iq_output_len();
        const numDemodSamples = numOutValues / 2;
        if (numDemodSamples === 0) return null;

        const _ddcOut = new Float32Array(_wasm.memory.buffer, outPtr, numOutValues);

        let squelchMag = 0;
        for (let i = 0; i < numDemodSamples; i++) {
            const dI = _ddcOut[i * 2];
            const dQ = _ddcOut[i * 2 + 1];
            squelchMag += Math.sqrt(dI * dI + dQ * dQ);
        }
        squelchMag /= numDemodSamples;
        const squelchDb = 10 * Math.log10(squelchMag + 1e-12);

        if (numDemodSamples > vfoState.scratchBuf.length) {
            vfoState.scratchBuf = new Float32Array(numDemodSamples + 128);
        }
        const audioDemodRateSamples = vfoState.scratchBuf.subarray(0, numDemodSamples);

        if (params.squelchEnabled && squelchDb < params.squelchLevel) {
            vfoState.squelchOpen = false;
            audioDemodRateSamples.fill(0);
            const result = vfoState.audioResampler.process(audioDemodRateSamples);
            return result.length > 0 ? result : null;
        }

        vfoState.squelchOpen = params.squelchEnabled && squelchDb >= params.squelchLevel;
        const ifRate = vfoState.currentIfRate;

        if (mode === 'am') {
            for (let i = 0; i < numDemodSamples; i++) {
                const dI = _ddcOut[i * 2];
                const dQ = _ddcOut[i * 2 + 1];
                const mag = Math.sqrt(dI * dI + dQ * dQ);
                const dcAlpha = 0.9999;
                vfoState.dcAvg = dcAlpha * vfoState.dcAvg + (1 - dcAlpha) * mag;
                let demodSample = mag - vfoState.dcAvg;
                const agcAttack = 50.0 / ifRate;
                const agcDecay = 5.0 / ifRate;
                const absSample = Math.abs(demodSample);
                if (absSample > vfoState.agcGain) {
                    vfoState.agcGain = vfoState.agcGain * (1 - agcAttack) + absSample * agcAttack;
                } else {
                    vfoState.agcGain = vfoState.agcGain * (1 - agcDecay) + absSample * agcDecay;
                }
                const agcScale = vfoState.agcGain > 1e-6 ? (0.5 / vfoState.agcGain) : 1.0;
                audioDemodRateSamples[i] = demodSample * agcScale;
            }
        }
        else if (mode === 'usb' || mode === 'lsb' || mode === 'dsb') {
            for (let i = 0; i < numDemodSamples; i++) {
                const dI = _ddcOut[i * 2];
                const dQ = _ddcOut[i * 2 + 1];
                let shiftFreq = 0;
                if (mode === 'usb') shiftFreq = bw / 2.0;
                else if (mode === 'lsb') shiftFreq = -bw / 2.0;
                const phaseInc = (shiftFreq / ifRate) * 2 * Math.PI;
                vfoState.ssbPhase += phaseInc;
                if (vfoState.ssbPhase > Math.PI) vfoState.ssbPhase -= 2 * Math.PI;
                if (vfoState.ssbPhase < -Math.PI) vfoState.ssbPhase += 2 * Math.PI;
                const cosP = Math.cos(vfoState.ssbPhase);
                const sinP = Math.sin(vfoState.ssbPhase);
                const rI = dI * cosP - dQ * sinP;
                let demodSample = rI;
                const agcAttack = 50.0 / ifRate;
                const agcDecay = 5.0 / ifRate;
                const absSample = Math.abs(demodSample);
                if (absSample > vfoState.agcGain) {
                    vfoState.agcGain = vfoState.agcGain * (1 - agcAttack) + absSample * agcAttack;
                } else {
                    vfoState.agcGain = vfoState.agcGain * (1 - agcDecay) + absSample * agcDecay;
                }
                const agcScale = vfoState.agcGain > 1e-6 ? (0.5 / vfoState.agcGain) : 1.0;
                audioDemodRateSamples[i] = demodSample * agcScale;
            }
        }
        else if (mode === 'cw') {
            for (let i = 0; i < numDemodSamples; i++) {
                const dI = _ddcOut[i * 2];
                const dQ = _ddcOut[i * 2 + 1];
                const cwTone = 700;
                const phaseInc = (cwTone / ifRate) * 2 * Math.PI;
                vfoState.ssbPhase += phaseInc;
                if (vfoState.ssbPhase > Math.PI) vfoState.ssbPhase -= 2 * Math.PI;
                if (vfoState.ssbPhase < -Math.PI) vfoState.ssbPhase += 2 * Math.PI;
                const cosP = Math.cos(vfoState.ssbPhase);
                const sinP = Math.sin(vfoState.ssbPhase);
                const rI = dI * cosP - dQ * sinP;
                let demodSample = rI;
                const agcAttack = 50.0 / ifRate;
                const agcDecay = 5.0 / ifRate;
                const absSample = Math.abs(demodSample);
                if (absSample > vfoState.agcGain) {
                    vfoState.agcGain = vfoState.agcGain * (1 - agcAttack) + absSample * agcAttack;
                } else {
                    vfoState.agcGain = vfoState.agcGain * (1 - agcDecay) + absSample * agcDecay;
                }
                const agcScale = vfoState.agcGain > 1e-6 ? (0.5 / vfoState.agcGain) : 1.0;
                audioDemodRateSamples[i] = demodSample * agcScale;
            }
        }
        else if (mode === 'raw') {
            for (let i = 0; i < numDemodSamples; i++) {
                audioDemodRateSamples[i] = _ddcOut[i * 2];
            }
        }
        else {
            audioDemodRateSamples.fill(0);
        }

        let result = vfoState.audioResampler.process(audioDemodRateSamples);
        if (result.length === 0) return null;

        for (let i = 0; i < result.length; i++) {
            if (result[i] > 1.0) result[i] = 1.0;
            else if (result[i] < -1.0) result[i] = -1.0;
        }

        return result.slice();
    }
}
