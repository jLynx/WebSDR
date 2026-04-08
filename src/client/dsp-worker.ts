import init, { DspProcessor, set_panic_hook, alloc_iq_buffer, free_iq_buffer } from "/hackrf-web/pkg/hackrf_web.js";
import { RationalResampler } from './worker/dsp-pipeline';
import { DSDDecoder } from './worker/dsd/dsd-decoder';
import { FMDiscriminator } from './worker/dsd/dsd-dsp';
import { DSD_IF_RATE, DSD_AUDIO_RATE } from './worker/dsd/types';
import type { DSDStatus } from './worker/dsd/types';

// --- Worker State ---
let wasmInitPromise: Promise<void> | null = null;
let _wasm: any;
let ddc: any;
let vfoState: any;
let sharedIqPtr = 0;
let sharedSabViews: Int8Array[] | null = null;

const IF_RATES: Record<string, number> = {
    nfm: 50000,
    wfm: 250000,
    am: 15000,
    usb: 24000,
    lsb: 24000,
    dsb: 24000,
    cw: 3000,
    raw: 48000,
    dsd: 48000,
};
const AUDIO_RATE = 48000;

async function startup(): Promise<void> {
    if (!wasmInitPromise) {
        wasmInitPromise = init().then((w: any) => {
            _wasm = w;
            set_panic_hook();

            // Allocate Wasm memory for this sub-module
            const MAX_USB_SAMPLES = 131072;
            sharedIqPtr = alloc_iq_buffer(MAX_USB_SAMPLES * 2);
            console.log("DSP Worker: Wasm Initialized. IQ Buffer Ptr:", sharedIqPtr);
        }).catch((err: any) => {
            console.error("DSP Worker: Wasm Init Failed:", err);
        });
    }
    await wasmInitPromise;
}

let systemSampleRate = 2000000;

// DSD decoder state (per-worker, one DSD decoder per VFO)
let dsdDecoder: DSDDecoder | null = null;
let dsdFmDemod: FMDiscriminator | null = null;
let dsdAudioResampler: RationalResampler | null = null;
let dsdAudioAccum: Float32Array = new Float32Array(0);
let dsdAudioAccumLen = 0;

self.onmessage = async (e: MessageEvent) => {
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
            audioResampler: null as RationalResampler | null,
            currentIfRate: 0,
            scratchBuf: new Float32Array(512),
            audioTarget: new Float32Array(2048),
            squelchOpen: false,
        };
        sharedSabViews = msg.sabs ? msg.sabs.map((s: SharedArrayBuffer) => new Int8Array(s)) : null;

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
                (self as any).postMessage({
                    type: "audio",
                    samples: cloneOut.buffer,
                    chunkId: msg.chunkId,
                    squelchOpen: vfoState.squelchOpen,
                    dspTime: dspTime
                }, [cloneOut.buffer]);
            } else {
                self.postMessage({ type: "audio", samples: null, chunkId: msg.chunkId, squelchOpen: vfoState.squelchOpen, dspTime: dspTime });
            }
        } catch (err: any) {
            self.postMessage({ type: "error", error: err.message });
        }
    }
};

function configureDDC(params: any, systemCenterFreq: number): void {
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

    // Initialize or destroy DSD decoder based on mode
    if (params.mode === 'dsd') {
        if (!dsdDecoder) {
            dsdAudioAccum = new Float32Array(16000);
            dsdAudioAccumLen = 0;
            dsdFmDemod = new FMDiscriminator();
            dsdAudioResampler = new RationalResampler(DSD_AUDIO_RATE, AUDIO_RATE);
            dsdDecoder = new DSDDecoder(
                (audio: Float32Array) => {
                    // Accumulate 8 kHz DSD audio
                    if (dsdAudioAccumLen + audio.length > dsdAudioAccum.length) {
                        const newBuf = new Float32Array(dsdAudioAccum.length * 2);
                        newBuf.set(dsdAudioAccum.subarray(0, dsdAudioAccumLen));
                        dsdAudioAccum = newBuf;
                    }
                    dsdAudioAccum.set(audio, dsdAudioAccumLen);
                    dsdAudioAccumLen += audio.length;
                },
                (status: DSDStatus) => {
                    // Post DSD status to main thread
                    self.postMessage({ type: 'dsd_status', status });
                }
            );
        }
    } else {
        if (dsdDecoder) {
            dsdDecoder.reset();
            dsdDecoder = null;
            dsdFmDemod = null;
            dsdAudioResampler = null;
            dsdAudioAccumLen = 0;
        }
    }

    // Apply UI audio filters (High Pass 300Hz, Low Pass BW/2)
    ddc.set_audio_filters(params.lowPass || false, params.highPass || false);
}

function processVfoAudio(chunkLenBytes: number, params: any): Float32Array | null {
    const mode = params.mode;
    const bw = params.bandwidth;

    if (mode === 'nfm' || mode === 'wfm') {
        let outPtr: number;
        try {
            outPtr = ddc.process_ptr(sharedIqPtr, chunkLenBytes);
        } catch (e) {
            console.error("DEBUG process_ptr crashed:", e);
            throw e;
        }

        const numAudioSamples = ddc.get_output_len();

        let isSquelched = false;
        if (params.squelchEnabled && numAudioSamples > 0) {
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
                const demodSample = mag - vfoState.dcAvg;
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
                const demodSample = rI;
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
                const demodSample = rI;
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
        else if (mode === 'dsd') {
            // DSD mode: FM demod the IQ at 9600 Hz, then feed to DSD decoder.
            // Voice audio arrives in bursty chunks (one DMR superframe = 320ms).
            // The main thread's ring buffer handles variable-size chunks, so we
            // return decoded audio directly when available, silence otherwise.
            if (dsdDecoder && dsdFmDemod && dsdAudioResampler) {
                // FM discriminator on IQ at IF rate (48 kHz)
                const fmAudio = new Float32Array(numDemodSamples);
                dsdFmDemod.process(_ddcOut.subarray(0, numOutValues), fmAudio);

                // Reset accumulator before feeding decoder
                dsdAudioAccumLen = 0;

                // Feed FM audio to DSD decoder (emits 8 kHz audio via callback)
                dsdDecoder.process(fmAudio);

                // Resample DSD output: 8 kHz → 48 kHz
                if (dsdAudioAccumLen > 0) {
                    const dsdAudio8k = dsdAudioAccum.subarray(0, dsdAudioAccumLen);
                    const resampled = dsdAudioResampler.process(dsdAudio8k);

                    if (resampled.length > 0) {
                        for (let i = 0; i < resampled.length; i++) {
                            if (resampled[i] > 1.0) resampled[i] = 1.0;
                            else if (resampled[i] < -1.0) resampled[i] = -1.0;
                        }
                        return resampled.slice();
                    }
                }

                // No decoded voice this chunk — return silence (not null!) to keep
                // the audio stream continuous. Returning null would cause the main
                // thread's nextPlayTime to fall behind, breaking audio scheduling.
                const expectedOut = numDemodSamples; // 48kHz IF → 48kHz output = 1:1
                return new Float32Array(expectedOut);
            }
            return null;
        }
        else if (mode === 'raw') {
            for (let i = 0; i < numDemodSamples; i++) {
                audioDemodRateSamples[i] = _ddcOut[i * 2];
            }
        }
        else {
            audioDemodRateSamples.fill(0);
        }

        const result = vfoState.audioResampler.process(audioDemodRateSamples);
        if (result.length === 0) return null;

        for (let i = 0; i < result.length; i++) {
            if (result[i] > 1.0) result[i] = 1.0;
            else if (result[i] < -1.0) result[i] = -1.0;
        }

        return result.slice();
    }
}
