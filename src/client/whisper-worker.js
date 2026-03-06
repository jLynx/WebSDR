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

		// Route model downloads through our Worker proxy to avoid CORS issues
		env.remoteHost = `${self.location.origin}/hf-proxy`;

		// English-only models (.en) reject language/task parameters
		isMultilingual = !model.endsWith('.en');

		self.postMessage({ type: 'status', message: `Downloading model ${model}…` });

		// Track per-file progress so we report the *actual* byte progress of the
		// file currently being downloaded rather than a multi-file weighted average.
		// Transformers.js fires: initiate → progress (n times) → done, per file.
		const _dlFiles = {}; // file → { progress, done }

		pipeline = await createPipeline('automatic-speech-recognition', model, {
			dtype: 'q8',          // quantized for speed
			device: 'wasm',       // wasm is most compatible; webgpu used automatically when available
			progress_callback: (p) => {
				if (p.status === 'initiate') {
					_dlFiles[p.file] = { progress: 0, done: false };
				} else if (p.status === 'progress' && p.progress != null) {
					_dlFiles[p.file] = { progress: Math.round(p.progress), done: false };
					const filesDone  = Object.values(_dlFiles).filter(f => f.done).length;
					const filesTotal = Object.keys(_dlFiles).length;
					self.postMessage({
						type: 'loading',
						phase: 'downloading',
						progress: Math.round(p.progress), // real progress of this file
						file: _shortName(p.file),
						filesDone,
						filesTotal,
					});
				} else if (p.status === 'done') {
					if (_dlFiles[p.file]) _dlFiles[p.file].done = true;
					const allDone = Object.values(_dlFiles).every(f => f.done);
					if (allDone) {
						self.postMessage({ type: 'loading', phase: 'initializing', progress: 100, file: '' });
					}
				}
			},
		});

		self.postMessage({ type: 'ready' });
	} catch (err) {
		console.error('[whisper-worker] Model load failed:', err);
		self.postMessage({ type: 'error', message: `Model load failed: ${err.message}` });
	}
}

// Shorten a HuggingFace file path to a readable label, e.g.
// "onnx/encoder_model_quantized.onnx" → "encoder"
function _shortName(file) {
	return (file || '')
		.split('/').pop()             // basename
		.replace(/\.onnx$|\.json$|\.txt$|\.model$/, '')
		.replace(/_quantized|_merged/g, '')
		.replace(/_model$/, '');
}

// Known Whisper hallucinations on silence, noise, or broadcast interference.
// Each pattern is tested against the trimmed transcript text.
const HALLUCINATION_PATTERNS = [
	// Single filler words (you / a / um / uh / hmm / ah / oh)
	/^\s*(you|a|um+|uh+|hmm*|hm+|ah+|oh|eh|mhm)\s*[.!?,]*\s*$/i,
	// YouTube / streaming phrases whisper confuses with silence
	/thank you (for watching|very much|for joining)[.!]?\s*$/i,
	/please (like|subscribe|share|follow)[.!]?\s*$/i,
	/(don't forget to (like|subscribe|share))/i,
	/\[?\(?(music|applause|laughter|background noise|silence|inaudible|crosstalk|beep|static)\)?\]?\s*$/i,
	// Only punctuation / whitespace
	/^[\s.…\-_*~]+$/,
	// Character repeated 4+ times (e.g. "aaaaaaa", "......")
	/(.)\1{4,}/,
	// Same word repeated 3+ times in a row
	/(\b\w+\b)(\s+\1){3,}/i,
];

function isHallucination(text) {
	return HALLUCINATION_PATTERNS.some(re => re.test(text));
}

async function transcribe(audio, id, audioDuration) {
	if (!pipeline) {
		self.postMessage({ type: 'discarded', id, reason: 'pipeline-not-ready' });
		return;
	}

	try {
		// HAM radio–tuned decode options.
		// • temperature=0                → greedy/deterministic (fast, no random hallucinations)
		// • num_beams=4                  → wider beam search catches accent-shifted phoneme candidates
		// • condition_on_prev_text=false → each chunk decoded fresh (less hallucination drift)
		// • initial_prompt               → NZ HAM vocabulary primes the decoder toward local callsigns,
		//                                  Q-codes, and NZ English spellings/place names so accent-shifted
		//                                  vowels score higher against the right token rather than an
		//                                  American-English near-homophone.
		const opts = {
			chunk_length_s: 30,
			stride_length_s: 6,
			return_timestamps: false,
			temperature: 0,
			num_beams: 4,
			no_repeat_ngram_size: 3,
			condition_on_prev_text: false,
			initial_prompt:
				// Seed the decoder with NZ emergency-service and HAM code notation.
				// Priming with written codes (K46, R4, Q81) makes Whisper prefer that
				// form over phonetic expansions ("Kay forty-six", "are four").
				// NZ place names anchor the decoder to NZ English phonology.
				'New Zealand emergency services and amateur radio. ' +
				'Fire codes: K1 K2 K22 K28 K31 K32 K44 K45 K46 K46-1 K46-2 K46-3 K46-4 K55 K66 K77 K88 K99. ' +
				'Ambulance: Priority 1 Priority 2 Priority 3. Code 1 Code 2. ' +
				'R4 R6 R7 R9 R13 R17 R25 R33 R43 R49 R99. Status 1 Status 2 Status 3 Status 4. ' +
				'Q81 Q82 Q83 Q84 Q85 Q88 Q89 Q90. ' +
				'Auckland Wellington Christchurch Tauranga Hamilton Rotorua Whangarei Dunedin. ' +
				'Ngaruawahia Papatoetoe Papakura Manukau Otahuhu Waitakere Mangere. ' +
				'Palmerston North Whanganui Napier Hastings Gisborne Invercargill Oamaru. ' +
				'ZL1 ZL2 ZL3 ZL4. CQ QRZ QSO over roger copy standby NFM FM.',
		};
		if (isMultilingual) {
			opts.language = 'en';
			opts.task = 'transcribe';
		}
		const t0 = performance.now();
		const result = await pipeline(audio, opts);
		const transcribeTime = ((performance.now() - t0) / 1000).toFixed(2);
		const text = (result.text || '').trim();

		// Filter out known Whisper hallucinations on silence/noise.
		// IMPORTANT: always post back so main thread can decrement pendingChunks.
		if (!text || isHallucination(text)) {
			self.postMessage({ type: 'discarded', id, reason: 'hallucination' });
			return;
		}

		self.postMessage({ type: 'result', text, id, audioDuration, transcribeTime });
	} catch (err) {
		console.error('[whisper-worker] Transcription error:', err);
		self.postMessage({ type: 'error', message: `Transcription error: ${err.message}` });
	}
}

self.addEventListener('message', (e) => {
	const { type } = e.data;

	if (type === 'load') {
		pipelinePromise = loadModel(e.data.model || 'onnx-community/whisper-small');
	} else if (type === 'transcribe') {
		const { id, audioDuration } = e.data;
		// Ensure model is loaded first, then run sequentially
		const run = async () => {
			if (pipelinePromise) await pipelinePromise;
			await transcribe(e.data.audio, id, audioDuration);
		};
		run().catch(err => {
			// Last-resort catch: ensure the main thread is never left hanging
			console.error('[whisper-worker] Unhandled error in run():', err);
			self.postMessage({ type: 'error', message: `Unhandled worker error: ${err.message}` });
		});
	}
});
