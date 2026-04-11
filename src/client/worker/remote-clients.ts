/*
Copyright (c) 2026, jLynx <https://github.com/jLynx>

All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
	Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
	Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the
	documentation and/or other materials provided with the distribution.
	Neither the name of Great Scott Gadgets nor the names of its contributors may be used to endorse or promote products derived from this software
	without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

import type { VfoParams, RemoteClientState } from './types';
import { AUDIO_RATE } from './types';
import { POCSAGDecoder } from './pocsag';
import { ensureWasmInitialized, init } from './wasm-init';

import type { Backend } from './backend';

// ── Remote-client VFO management (multi-client) ──────────────────────────
// Each connected client gets a single pooled DSP worker with one slot per
// VFO. The host processes IQ data through each client's worker, which
// returns batched audio for all of that client's VFOs. Audio is mixed
// (respecting per-VFO volume) and sent back to that specific client via
// _remoteHostAudioCb(clientId, chunk).

export function _spawnRemotePoolWorker(this: Backend, clientId: string, state: RemoteClientState): number {
	const worker = new globalThis.Worker(new URL('../dsp-worker.ts', import.meta.url), { type: 'module' });
	const poolIndex = state.workers.length;
	worker.onmessage = (e: MessageEvent) => {
		const msg = e.data;
		if (msg.type === 'audioBatch' && msg.results) {
			for (const result of msg.results) {
				const vfoIndex = state.slotIds.indexOf(result.slotId);
				if (vfoIndex === -1) continue;

				const prev = state.squelchOpen[vfoIndex] || false;
				const curr = !!result.squelchOpen;
				state.squelchOpen[vfoIndex] = curr;
				if (curr !== prev && this._remoteHostSquelchCb) {
					this._remoteHostSquelchCb(clientId, state.squelchOpen.slice());
				}
				if (result.samples) {
					this._queueRemoteAudio(clientId, vfoIndex, new Float32Array(result.samples));
				}
			}
		}
	};
	worker.postMessage({
		type: 'init',
		sampleRate: this._sampleRate,
		centerFreq: this._centerFreq,
		sabs: typeof SharedArrayBuffer !== 'undefined' ? this.sharedIqPools : null
	});
	state.workers.push(worker);
	return poolIndex;
}

export async function setRemoteHostCallback(this: Backend, callback: any): Promise<void> {
	this._remoteHostCb = callback;
}

export async function setRemoteHostFftCallback(this: Backend, callback: any): Promise<void> {
	this._remoteHostFftCb = callback;
}

export async function setRemoteHostAudioCallback(this: Backend, callback: any): Promise<void> {
	this._remoteHostAudioCb = callback;
}

export async function setRemoteHostPocsagCallback(this: Backend, callback: any): Promise<void> {
	this._remoteHostPocsagCb = callback;
}

export async function setRemoteHostSquelchCallback(this: Backend, callback: any): Promise<void> {
	this._remoteHostSquelchCb = callback;
}

export function _ensureRemoteClients(this: Backend): void {
	if (!this._remoteClients) {
		this._remoteClients = new Map();
	}
}

export function _getOrCreateClientState(this: Backend, clientId: string): RemoteClientState {
	this._ensureRemoteClients();
	if (!this._remoteClients!.has(clientId)) {
		this._remoteClients!.set(clientId, {
			workers: [],
			slotIds: [],
			slotAssignment: [],
			nextSlotId: 0,
			params: [],
			audioQueues: [],
			mixBuf: null,
			pocsagDecoders: [],
			squelchOpen: []
		});
	}
	return this._remoteClients!.get(clientId)!;
}

export async function addRemoteClient(this: Backend, clientId: string): Promise<void> {
	this._getOrCreateClientState(clientId);
}

export async function removeRemoteClient(this: Backend, clientId: string): Promise<void> {
	this._ensureRemoteClients();
	const state = this._remoteClients!.get(clientId);
	if (!state) return;
	for (const w of state.workers) { try { w.terminate(); } catch (_) {} }
	this._remoteClients!.delete(clientId);
}

export async function setRemoteVfoParams(this: Backend, clientId: string, index: number, params: VfoParams): Promise<void> {
	const state = this._getOrCreateClientState(clientId);
	const wasEnabled = state.params[index] && state.params[index]!.enabled;
	state.params[index] = params;

	if (state.audioQueues[index] && (!params.enabled || (params.enabled && !wasEnabled))) {
		state.audioQueues[index].len = 0;
	}

	if (!this._sampleRate || !this.sharedIqPools) return;

	// If this VFO doesn't have a slot yet, add one
	if (state.slotIds[index] === undefined) {
		const MAX_VFOS_PER_WORKER = 2;
		const maxPool = navigator.hardwareConcurrency || 8;

		// Find least-loaded worker, or spawn a new one
		let workerIdx: number;
		if (state.workers.length === 0) {
			workerIdx = this._spawnRemotePoolWorker!(clientId, state);
		} else {
			const loads = new Array(state.workers.length).fill(0);
			for (const wi of state.slotAssignment) {
				if (wi !== undefined) loads[wi]++;
			}
			const minLoad = Math.min(...loads);
			workerIdx = loads.indexOf(minLoad);
			if (minLoad >= MAX_VFOS_PER_WORKER && state.workers.length < maxPool) {
				workerIdx = this._spawnRemotePoolWorker!(clientId, state);
			}
		}

		const slotId = state.nextSlotId++;
		state.slotIds[index] = slotId;
		state.slotAssignment[index] = workerIdx;
		state.audioQueues[index] = { queue: new Float32Array(32768), len: 0 };
		state.workers[workerIdx].postMessage({
			type: 'addSlot',
			slotId,
			params: params,
			centerFreq: this._centerFreq
		});
	} else {
		const workerIdx = state.slotAssignment[index];
		state.workers[workerIdx].postMessage({
			type: 'configure',
			slotId: state.slotIds[index],
			params: params,
			centerFreq: this._centerFreq
		});
	}
}

export async function addRemoteVfo(this: Backend, clientId: string): Promise<void> {
	const state = this._getOrCreateClientState(clientId);
	const idx = state.params.length;
	state.params[idx] = null;
	state.audioQueues[idx] = { queue: new Float32Array(32768), len: 0 };
}

export async function removeRemoteVfo(this: Backend, clientId: string, index: number): Promise<void> {
	const state = this._remoteClients && this._remoteClients.get(clientId);
	if (!state) return;

	if (state.slotIds[index] !== undefined && state.slotAssignment[index] !== undefined) {
		const workerIdx = state.slotAssignment[index];
		if (state.workers[workerIdx]) {
			state.workers[workerIdx].postMessage({ type: 'removeSlot', slotId: state.slotIds[index] });
		}
	}

	state.slotIds.splice(index, 1);
	state.slotAssignment.splice(index, 1);
	state.params.splice(index, 1);
	state.audioQueues.splice(index, 1);
	state.pocsagDecoders.splice(index, 1);
}

export function _queueRemoteAudio(this: Backend, clientId: string, index: number, samples: Float32Array): void {
	const state = this._remoteClients && this._remoteClients.get(clientId);
	if (!state) return;
	const entry = state.audioQueues[index];
	if (!entry) return;

	// Run POCSAG decoding on the raw audio before mixing
	const params = state.params[index];
	if (this._remoteHostPocsagCb && params && params.pocsag && params.mode === 'nfm') {
		if (!state.pocsagDecoders[index]) {
			state.pocsagDecoders[index] = new POCSAGDecoder(AUDIO_RATE, (pmsg: any) => {
				this._remoteHostPocsagCb(clientId, index, params.freq, pmsg);
			});
		}
		state.pocsagDecoders[index].process(samples);
	} else if (state.pocsagDecoders[index]) {
		state.pocsagDecoders[index] = null;
	}

	const needed = entry.len + samples.length;
	if (needed > entry.queue.length) {
		const grown = new Float32Array(Math.max(needed * 2, 32768));
		grown.set(entry.queue.subarray(0, entry.len));
		entry.queue = grown;
	}
	entry.queue.set(samples, entry.len);
	entry.len += samples.length;
	this._mixAndEmitRemoteAudio(clientId);
}

export function _mixAndEmitRemoteAudio(this: Backend, clientId: string): void {
	if (!this._remoteHostAudioCb) return;
	const state = this._remoteClients && this._remoteClients.get(clientId);
	if (!state) return;
	const BATCH = 512;
	let minAvailable = Infinity;
	const active: { q: { queue: Float32Array; len: number }; p: VfoParams }[] = [];
	for (let i = 0; i < state.params.length; i++) {
		const p = state.params[i];
		if (!p || !p.enabled) continue;
		const q = state.audioQueues[i];
		if (!q) continue;
		if (q.len < minAvailable) minAvailable = q.len;
		active.push({ q, p });
	}
	if (!active.length || minAvailable < BATCH || minAvailable === Infinity) return;
	const MAX_CHUNK = 4800;
	if (minAvailable > MAX_CHUNK) minAvailable = MAX_CHUNK;
	if (!state.mixBuf || state.mixBuf.length < minAvailable) {
		state.mixBuf = new Float32Array(minAvailable + 1024);
	}
	const mixed = state.mixBuf;
	mixed.fill(0, 0, minAvailable);
	for (const { q, p } of active) {
		const vol = (p.volume ?? 50) / 100;
		const vScale = vol * vol;
		for (let k = 0; k < minAvailable; k++) mixed[k] += q.queue[k] * vScale;
		const rem = q.len - minAvailable;
		if (rem > 0) q.queue.copyWithin(0, minAvailable, q.len);
		q.len = rem;
	}
	for (let k = 0; k < minAvailable; k++) {
		if (mixed[k] > 1) mixed[k] = 1;
		else if (mixed[k] < -1) mixed[k] = -1;
	}
	this._remoteHostAudioCb(clientId, mixed.slice(0, minAvailable));
}

export function _reinitRemoteClientWorkers(this: Backend): void {
	if (!this._remoteClients) return;
	for (const [clientId, state] of this._remoteClients) {
		// Terminate all pool workers
		for (const w of state.workers) { try { w.terminate(); } catch (_) {} }
		state.workers = [];
		state.slotAssignment = [];

		// Re-add all VFO slots (pool grows dynamically via setRemoteVfoParams path)
		state.nextSlotId = 0;
		const MAX_VFOS_PER_WORKER = 2;
		const maxPool = navigator.hardwareConcurrency || 8;

		for (let i = 0; i < state.params.length; i++) {
			const params = state.params[i];
			if (!params) continue;

			// Find or spawn worker
			let workerIdx: number;
			if (state.workers.length === 0) {
				workerIdx = this._spawnRemotePoolWorker!(clientId, state);
			} else {
				const loads = new Array(state.workers.length).fill(0);
				for (const wi of state.slotAssignment) {
					if (wi !== undefined) loads[wi]++;
				}
				const minLoad = Math.min(...loads);
				workerIdx = loads.indexOf(minLoad);
				if (minLoad >= MAX_VFOS_PER_WORKER && state.workers.length < maxPool) {
					workerIdx = this._spawnRemotePoolWorker!(clientId, state);
				}
			}

			const slotId = state.nextSlotId++;
			state.slotIds[i] = slotId;
			state.slotAssignment[i] = workerIdx;
			state.workers[workerIdx].postMessage({
				type: 'addSlot',
				slotId,
				params,
				centerFreq: this._centerFreq
			});
			state.audioQueues[i] = { queue: new Float32Array(32768), len: 0 };
		}
	}
}

export async function initRemoteClient(this: Backend): Promise<void> {
	await ensureWasmInitialized();
	this.wasm = await init();
	// Create a stub SdrDevice for the remote client — it receives IQ data
	// via WebRTC rather than USB, so all hardware methods are no-ops.
	const self = this;
	this.device = {
		deviceType: 'remote',
		sampleRates: [2000000, 4000000, 8000000, 10000000, 16000000, 20000000],
		gainControls: [],
		sampleFormat: 'int8',
		async open() {},
		async close() {},
		async getInfo() { return { name: 'Remote SDR' }; },
		async setSampleRate() {},
		async setFrequency() {},
		async setGain() {},
		async startRx(cb: any) { self._remoteClientCb = cb; },
		async stopRx() { self._remoteClientCb = null; },
	} as any;
}

export async function feedRemoteAudioChunk(this: Backend, chunk: any): Promise<void> {
	if (this._remoteClientAudioCb) {
		const floats = (chunk instanceof Float32Array)
			? chunk
			: new Float32Array(chunk instanceof ArrayBuffer ? chunk : chunk.buffer);
		this._remoteClientAudioCb(floats);

		// Feed whisper for local transcription on remote clients.
		// The audio arrives pre-mixed from the host, so attribute it to VFO 0.
		if (this._remoteClientWhisperCb && this.vfoParams && this.vfoParams[0]) {
			this._remoteClientWhisperCb(0, this.vfoParams[0].freq, floats);
		}
	}
}
