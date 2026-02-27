/**
 * Whisper Speech-to-Text Web Worker
 *
 * Uses @huggingface/transformers to run OpenAI Whisper models
 * entirely in-browser via WebAssembly / WebGPU.
 *
 * Protocol (postMessage):
 *   Main → Worker:
 *     { type: 'load',      model: 'Xenova/whisper-tiny' }
 *     { type: 'transcribe', audio: Float32Array (16 kHz mono), id: number }
 *
 *   Worker → Main:
 *     { type: 'status',  message: string }
 *     { type: 'loading', progress: number (0-100) }
 *     { type: 'ready' }
 *     { type: 'result',  text: string, id: number }
 *     { type: 'error',   message: string }
 */

let pipeline = null;
let pipelinePromise = null;
let isMultilingual = false;

async function loadModel(model) {
	try {
		self.postMessage({ type: 'status', message: `Loading Transformers.js…` });

		// Dynamic import from CDN (ES module)
		const { pipeline: createPipeline, env } = await import(
			'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1'
		);

		// Disable local model check — always fetch from HF Hub via CDN
		env.allowLocalModels = false;

		// English-only models (.en) reject language/task parameters
		isMultilingual = !model.endsWith('.en');

		self.postMessage({ type: 'status', message: `Downloading model ${model}…` });

		pipeline = await createPipeline('automatic-speech-recognition', model, {
			dtype: 'q8',          // quantized for speed
			device: 'wasm',       // wasm is most compatible; webgpu used automatically when available
			progress_callback: (progress) => {
				if (progress.status === 'progress' && progress.progress != null) {
					self.postMessage({
						type: 'loading',
						progress: Math.round(progress.progress),
						file: progress.file,
					});
				}
			},
		});

		self.postMessage({ type: 'ready' });
	} catch (err) {
		self.postMessage({ type: 'error', message: `Model load failed: ${err.message}` });
	}
}

// Common Whisper hallucinations on silence / noise
const HALLUCINATION_RE = /^\s*(you|a)\s*[.!?,]*\s*$/i;

async function transcribe(audio, id, audioDuration) {
	if (!pipeline) {
		self.postMessage({ type: 'error', message: 'Model not loaded yet.' });
		return;
	}

	try {
		const opts = {
			chunk_length_s: 30,
			stride_length_s: 5,
			return_timestamps: false,
		};
		if (isMultilingual) {
			opts.language = 'en';
			opts.task = 'transcribe';
		}
		const result = await pipeline(audio, opts);

		const text = (result.text || '').trim();

		// Filter out known Whisper hallucinations on silence/noise
		if (!text || HALLUCINATION_RE.test(text)) {
			return; // discard — not real speech
		}

		self.postMessage({ type: 'result', text, id, audioDuration });
	} catch (err) {
		self.postMessage({ type: 'error', message: `Transcription error: ${err.message}` });
	}
}

self.addEventListener('message', (e) => {
	const { type } = e.data;

	if (type === 'load') {
		pipelinePromise = loadModel(e.data.model || 'onnx-community/whisper-tiny.en');
	} else if (type === 'transcribe') {
		// Ensure model is loaded first
		const run = async () => {
			if (pipelinePromise) await pipelinePromise;
			await transcribe(e.data.audio, e.data.id, e.data.audioDuration);
		};
		run();
	}
});
