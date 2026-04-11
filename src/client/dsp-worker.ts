import init, { set_panic_hook, alloc_iq_buffer,
    dsp_new, dsp_free, dsp_configure, dsp_set_if_sample_rate,
    dsp_process_ptr, dsp_get_output_len,
    dsp_process_iq_only_ptr, dsp_get_iq_output_len
} from "/hackrf-web/pkg/hackrf_web.js";
import { RationalResampler } from './worker/dsp-pipeline';

// --- Worker-level state (shared across all slots) ---
let wasmInitPromise: Promise<void> | null = null;
let _wasm: any;
let sharedIqPtr = 0;
let sharedSabViews: Int8Array[] | null = null;
let systemSampleRate = 2000000;
let systemCenterFreq = 100.0;

const IF_RATES: Record<string, number> = {
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
const MAX_USB_SAMPLES = 131072;

// --- Per-slot state (raw pointer, no wasm-bindgen borrow tracking) ---
interface Slot {
    ddcPtr: number;  // raw pointer to DspProcessor in WASM heap
    params: any;
    dcAvg: number;
    deemphPrev: number;
    agcGain: number;
    ssbPhase: number;
    audioResampler: RationalResampler | null;
    currentIfRate: number;
    scratchBuf: Float32Array;
    audioTarget: Float32Array;
    squelchOpen: boolean;
}

const slots = new Map<number, Slot>();

async function startup(): Promise<void> {
    if (!wasmInitPromise) {
        wasmInitPromise = init().then((w: any) => {
            _wasm = w;
            set_panic_hook();
            sharedIqPtr = alloc_iq_buffer(MAX_USB_SAMPLES * 2);
            console.log("DSP Worker: Wasm Initialized.");
        }).catch((err: any) => {
            console.error("DSP Worker: Wasm Init Failed:", err);
        });
    }
    await wasmInitPromise;
}

function makeSlot(params: any, centerFreq: number): Slot {
    const ddcPtr = dsp_new(systemSampleRate, 0.0, params.bandwidth || 150000);
    const slot: Slot = {
        ddcPtr,
        params,
        dcAvg: 0,
        deemphPrev: 0,
        agcGain: 1.0,
        ssbPhase: 0.0,
        audioResampler: null,
        currentIfRate: 0,
        scratchBuf: new Float32Array(512),
        audioTarget: new Float32Array(2048),
        squelchOpen: false,
    };
    configureSlot(slot, params, centerFreq);
    return slot;
}

function configureSlot(slot: Slot, params: any, centerFreq: number): void {
    const ifRate = IF_RATES[params.mode];
    if (ifRate === undefined) {
        console.error(`[DSP Worker] Unknown mode "${params.mode}" — no IF rate defined.`);
        return;
    }
    if (slot.currentIfRate !== ifRate) {
        slot.audioResampler = new RationalResampler(ifRate, AUDIO_RATE);
        slot.currentIfRate = ifRate;
        dsp_set_if_sample_rate(slot.ddcPtr, ifRate);
    }
    const offsetFreq = (params.freq - centerFreq) * 1e6;
    dsp_configure(slot.ddcPtr, systemSampleRate, offsetFreq, params.bandwidth,
        params.squelchLevel ?? -100, !!params.squelchEnabled,
        params.mode === 'wfm', params.lowPass || false, params.highPass || false);
    slot.params = params;
}

function processSlotAudio(chunkLenBytes: number, slot: Slot): Float32Array | null {
    const params = slot.params;
    const mode = params.mode;
    const bw = params.bandwidth;

    if (mode === 'nfm' || mode === 'wfm') {
        const outPtr = dsp_process_ptr(slot.ddcPtr, sharedIqPtr, chunkLenBytes);
        const numAudioSamples = dsp_get_output_len(slot.ddcPtr);

        let isSquelched = false;
        if (params.squelchEnabled && numAudioSamples > 0) {
            isSquelched = (numAudioSamples > 0 && new Float32Array(_wasm.memory.buffer, outPtr, numAudioSamples)[Math.floor(numAudioSamples / 2)] === 0.0);
        }
        slot.squelchOpen = !isSquelched;

        if (numAudioSamples === 0) return null;

        const result = new Float32Array(_wasm.memory.buffer, outPtr, numAudioSamples);

        if (params.deEmphasis !== 'none') {
            let tau = 0;
            if (params.deEmphasis === '22us') tau = 22e-6;
            else if (params.deEmphasis === '50us') tau = 50e-6;
            else if (params.deEmphasis === '75us') tau = 75e-6;

            const alpha = 1.0 / (1.0 + tau * AUDIO_RATE);
            const oneMinusAlpha = 1.0 - alpha;

            let prev = slot.deemphPrev;
            for (let i = 0; i < numAudioSamples; i++) {
                prev = alpha * result[i] + oneMinusAlpha * prev;
                result[i] = prev < -1.0 ? -1.0 : prev > 1.0 ? 1.0 : prev;
            }
            slot.deemphPrev = prev;
        } else {
            for (let i = 0; i < numAudioSamples; i++) {
                if (result[i] > 1.0) result[i] = 1.0;
                else if (result[i] < -1.0) result[i] = -1.0;
            }
        }

        if (numAudioSamples > slot.audioTarget.length) {
            slot.audioTarget = new Float32Array(numAudioSamples + 1024);
        }
        const outView = slot.audioTarget.subarray(0, numAudioSamples);
        outView.set(result);
        return outView;
    } else {
        const outPtr = dsp_process_iq_only_ptr(slot.ddcPtr, sharedIqPtr, chunkLenBytes);
        const numOutValues = dsp_get_iq_output_len(slot.ddcPtr);
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

        if (numDemodSamples > slot.scratchBuf.length) {
            slot.scratchBuf = new Float32Array(numDemodSamples + 128);
        }
        const audioDemodRateSamples = slot.scratchBuf.subarray(0, numDemodSamples);

        if (params.squelchEnabled && squelchDb < params.squelchLevel) {
            slot.squelchOpen = false;
            audioDemodRateSamples.fill(0);
            const result = slot.audioResampler!.process(audioDemodRateSamples);
            return result.length > 0 ? result : null;
        }

        slot.squelchOpen = params.squelchEnabled && squelchDb >= params.squelchLevel;
        const ifRate = slot.currentIfRate;

        if (mode === 'am') {
            for (let i = 0; i < numDemodSamples; i++) {
                const dI = _ddcOut[i * 2];
                const dQ = _ddcOut[i * 2 + 1];
                const mag = Math.sqrt(dI * dI + dQ * dQ);
                const dcAlpha = 0.9999;
                slot.dcAvg = dcAlpha * slot.dcAvg + (1 - dcAlpha) * mag;
                const demodSample = mag - slot.dcAvg;
                const agcAttack = 50.0 / ifRate;
                const agcDecay = 5.0 / ifRate;
                const absSample = Math.abs(demodSample);
                if (absSample > slot.agcGain) {
                    slot.agcGain = slot.agcGain * (1 - agcAttack) + absSample * agcAttack;
                } else {
                    slot.agcGain = slot.agcGain * (1 - agcDecay) + absSample * agcDecay;
                }
                const agcScale = slot.agcGain > 1e-6 ? (0.5 / slot.agcGain) : 1.0;
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
                slot.ssbPhase += phaseInc;
                if (slot.ssbPhase > Math.PI) slot.ssbPhase -= 2 * Math.PI;
                if (slot.ssbPhase < -Math.PI) slot.ssbPhase += 2 * Math.PI;
                const cosP = Math.cos(slot.ssbPhase);
                const sinP = Math.sin(slot.ssbPhase);
                const rI = dI * cosP - dQ * sinP;
                const demodSample = rI;
                const agcAttack = 50.0 / ifRate;
                const agcDecay = 5.0 / ifRate;
                const absSample = Math.abs(demodSample);
                if (absSample > slot.agcGain) {
                    slot.agcGain = slot.agcGain * (1 - agcAttack) + absSample * agcAttack;
                } else {
                    slot.agcGain = slot.agcGain * (1 - agcDecay) + absSample * agcDecay;
                }
                const agcScale = slot.agcGain > 1e-6 ? (0.5 / slot.agcGain) : 1.0;
                audioDemodRateSamples[i] = demodSample * agcScale;
            }
        }
        else if (mode === 'cw') {
            for (let i = 0; i < numDemodSamples; i++) {
                const dI = _ddcOut[i * 2];
                const dQ = _ddcOut[i * 2 + 1];
                const cwTone = 700;
                const phaseInc = (cwTone / ifRate) * 2 * Math.PI;
                slot.ssbPhase += phaseInc;
                if (slot.ssbPhase > Math.PI) slot.ssbPhase -= 2 * Math.PI;
                if (slot.ssbPhase < -Math.PI) slot.ssbPhase += 2 * Math.PI;
                const cosP = Math.cos(slot.ssbPhase);
                const sinP = Math.sin(slot.ssbPhase);
                const rI = dI * cosP - dQ * sinP;
                const demodSample = rI;
                const agcAttack = 50.0 / ifRate;
                const agcDecay = 5.0 / ifRate;
                const absSample = Math.abs(demodSample);
                if (absSample > slot.agcGain) {
                    slot.agcGain = slot.agcGain * (1 - agcAttack) + absSample * agcAttack;
                } else {
                    slot.agcGain = slot.agcGain * (1 - agcDecay) + absSample * agcDecay;
                }
                const agcScale = slot.agcGain > 1e-6 ? (0.5 / slot.agcGain) : 1.0;
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

        const result = slot.audioResampler!.process(audioDemodRateSamples);
        if (result.length === 0) return null;

        for (let i = 0; i < result.length; i++) {
            if (result[i] > 1.0) result[i] = 1.0;
            else if (result[i] < -1.0) result[i] = -1.0;
        }

        return result.slice();
    }
}

// --- Message handler ---
self.onmessage = async (e: MessageEvent) => {
    const msg = e.data;
    await startup();

    switch (msg.type) {
        case "init": {
            systemSampleRate = msg.sampleRate;
            systemCenterFreq = msg.centerFreq || 100.0;
            sharedSabViews = msg.sabs ? msg.sabs.map((s: SharedArrayBuffer) => new Int8Array(s)) : null;
            self.postMessage({ type: "init_done" });
            break;
        }

        case "addSlot": {
            const slot = makeSlot(msg.params, msg.centerFreq ?? systemCenterFreq);
            slots.set(msg.slotId, slot);
            break;
        }

        case "removeSlot": {
            const slot = slots.get(msg.slotId);
            if (slot) {
                dsp_free(slot.ddcPtr);
                slots.delete(msg.slotId);
            }
            break;
        }

        case "configure": {
            const slot = slots.get(msg.slotId);
            if (slot) {
                systemCenterFreq = msg.centerFreq ?? systemCenterFreq;
                configureSlot(slot, msg.params, systemCenterFreq);
            }
            self.postMessage({ type: "config_done" });
            break;
        }

        case "process": {
            if (slots.size === 0) return;

            // Copy IQ data into WASM memory once — all slots read from the same buffer.
            // Safe because raw pointer API has no borrow tracking.
            const wasmMemView = new Int8Array(_wasm.memory.buffer);
            if (msg.useSab && sharedSabViews && msg.sabIndex !== undefined) {
                wasmMemView.set(sharedSabViews[msg.sabIndex].subarray(0, msg.chunkLen), sharedIqPtr);
            } else if (msg.chunk) {
                wasmMemView.set(new Int8Array(msg.chunk), sharedIqPtr);
            } else {
                return;
            }

            const results: any[] = [];
            const transfers: ArrayBuffer[] = [];
            const t0 = performance.now();

            for (const [slotId, slot] of slots) {
                try {
                    const audioOut = processSlotAudio(msg.chunkLen, slot);
                    if (audioOut) {
                        const buf = audioOut.slice();
                        results.push({ slotId, samples: buf.buffer, squelchOpen: slot.squelchOpen });
                        transfers.push(buf.buffer);
                    } else {
                        results.push({ slotId, samples: null, squelchOpen: slot.squelchOpen });
                    }
                } catch (err: any) {
                    results.push({ slotId, samples: null, squelchOpen: false });
                }
            }

            const dspTime = performance.now() - t0;
            (self as any).postMessage(
                { type: "audioBatch", results, chunkId: msg.chunkId, dspTime },
                transfers
            );
            break;
        }
    }
};
