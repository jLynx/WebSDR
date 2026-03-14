import type { AppInstance } from './types';
import * as Comlink from 'comlink';
import { WebRTCHandler, PEER_ID_PREFIX } from '../webrtc';

export const remoteMethods = {
	async startRemoteHost(this: AppInstance) {
		console.log("[WebRTC] startRemoteHost clicked");
		if (!this.connected || !this.running) {
			console.log("[WebRTC] Device not connected or running");
			this.showMsg("Start the device first to share it.");
			return;
		}
		console.log("[WebRTC] Setting up Host Mode. Mode =", this.remoteMode);
		this.remoteMode = 'host';
		this.locks.centerFreq = true;
		this.locks.sampleRate = true;
		// Lock all gain controls
		if (this.deviceCapabilities) {
			for (const gc of this.deviceCapabilities.gainControls) {
				this.locks[gc.name] = true;
			}
		}
		this.remoteStatus = 'Generating ID...';

		console.log("[WebRTC] Instantiating WebRTCHandler");
		const savedCode = localStorage.getItem('browsdr-share-code');
		this._webrtc = new WebRTCHandler(true, null, savedCode); // isHost = true, reuse saved code

		this._webrtc.onStatusChange = (status: any) => {
			console.log("[WebRTC] Host status changed:", status);
			if (status.status === 'ready') {
				this.remoteStatus = 'Waiting for connection';
				const origin = window.location.origin;
				const shortId = status.id.replace(PEER_ID_PREFIX, '');
				localStorage.setItem('browsdr-share-code', shortId);
				this.remoteLink = `${origin}/?connect=${shortId}`;
				console.log("[WebRTC] Link completely generated:", this.remoteLink);
			} else if (status.status === 'client-connected') {
				const clientId = status.clientId;
				this.remoteClients.push({ id: clientId, connectedAt: Date.now(), country: '', vfoCount: 1, firstFreq: null, isRelay: !!status.isRelay });
				this.remoteStatus = this.remoteClients.length + ' client' + (this.remoteClients.length !== 1 ? 's' : '') + ' connected';
				this.showMsg("Remote client joined!");
				// Register client in worker and sync current state
				this.backend.addRemoteClient(clientId);
				this._webrtc.sendCommandTo(clientId, { type: 'sync', radio: this.radio, gains: this.gains, locks: this.locks });
			} else if (status.status === 'client-disconnected') {
				const clientId = status.clientId;
				this.remoteClients = this.remoteClients.filter((c: any) => c.id !== clientId);
				this.backend.removeRemoteClient(clientId);
				if (this.remoteClients.length > 0) {
					this.remoteStatus = this.remoteClients.length + ' client' + (this.remoteClients.length !== 1 ? 's' : '') + ' connected';
				} else {
					this.remoteStatus = 'Waiting for connection';
				}
				this.showMsg("Remote client left.");
			} else if (status.status === 'error') {
				this.remoteMode = 'none';
				this.showMsg("WebRTC Error: " + status.error);
			}
		};

		this._webrtc.onCommand = (clientId: string, cmd: any) => this.handleRemoteCommand(clientId, cmd);

		console.log("[WebRTC] Calling _webrtc.init()");
		await this._webrtc.init();
		console.log("[WebRTC] _webrtc.init() finished. Resolving remote host callback.");
		// Setup worker to push FFT arrays via Comlink callback.
		// KiwiSDR-style compression: downsample to WF_REMOTE_BINS and quantize
		// each bin's dB value to a uint8 (1 dB/step, WF_DB_MIN offset).
		// This reduces bandwidth from ~5 MB/s (65536 Float32 @ 20fps) to
		// ~40 KB/s (2048 uint8 @ 20fps) — a ~128× reduction that prevents the
		// DataChannel from saturating and the waterfall from freezing.
		const WF_REMOTE_BINS = 2048;
		const WF_DB_MIN = -120.0; // uint8 0 ↔ -120 dBfs, 1 dB per LSB
		await this.backend.setRemoteHostFftCallback(Comlink.proxy((chunk: Float32Array) => {
			if (!this._webrtc) return;
			const bins = WF_REMOTE_BINS;
			const factor = chunk.length / bins;
			// 4-byte header: 0xFF 0xDA (magic) + uint16-LE bin count
			const pkt = new Uint8Array(4 + bins);
			pkt[0] = 0xFF; pkt[1] = 0xDA;
			pkt[2] = bins & 0xFF; pkt[3] = (bins >> 8) & 0xFF;
			for (let i = 0; i < bins; i++) {
				// Max-hold downsample (same as local waterfall renderSize path)
				let maxVal = -1e9;
				const s = Math.floor(i * factor);
				const e = Math.floor((i + 1) * factor);
				for (let j = s; j < e; j++) {
					if (chunk[j] > maxVal) maxVal = chunk[j];
				}
				// Clamp to [0..255]: 0 = WF_DB_MIN (-120 dB), 255 = -120+255 = +135 dB
				pkt[4 + i] = Math.max(0, Math.min(255, Math.round(maxVal - WF_DB_MIN)));
			}
			this._webrtc.sendFftChunk(pkt);
		}));
		// Setup worker to push processed Audio buffer callbacks (per-client)
		await this.backend.setRemoteHostAudioCallback(Comlink.proxy((clientId: string, chunk: any) => {
			if (this._webrtc) {
				this._webrtc.sendAudioChunkTo(clientId, chunk);
			}
		}));
		// Setup POCSAG message callback — forward decoded messages to the specific remote client
		await this.backend.setRemoteHostPocsagCallback(Comlink.proxy((clientId: string, vfoIndex: number, freq: number, msg: any) => {
			if (this._webrtc) {
				this._webrtc.sendCommandTo(clientId, { type: 'pocsag', vfoIndex, freq, msg });
			}
		}));
		// Forward squelch state changes so remote clients can track frequency activity
		await this.backend.setRemoteHostSquelchCallback(Comlink.proxy((clientId: string, squelchOpen: boolean[]) => {
			if (this._webrtc) {
				this._webrtc.sendCommandTo(clientId, { type: 'squelchState', squelchOpen });
			}
		}));
	},
	async connectRemoteClient(this: AppInstance, hostId: string) {
		this._initAudioCtx(); // create AudioContext within user gesture before any await
		this.remoteMode = 'client';
		this.remoteStatus = 'Connecting...';
		this.showMsg("Connecting to remote host...");

		// If this is a valid ID (it connected), it will be added to recents here or earlier.
		// Handled via the UI (connectToRemoteId method).

		this._webrtc = new WebRTCHandler(false, PEER_ID_PREFIX + hostId);

		this._webrtc.onStatusChange = (status: any) => {
			if (status.status === 'connecting') {
				this.remoteStatus = 'Connecting...';
			} else if (status.status === 'connected') {
				this.remoteStatus = 'Connected to Host';
				this.connected = true;
				this.info.boardName = "Remote SDR";
				this.showMsg("Connected to remote host.");
				
				// Update recent ids list (keep last 5)
				this.recentRemoteIds = this.recentRemoteIds.filter((x: string) => x !== hostId);
				this.recentRemoteIds.unshift(hostId);
				if (this.recentRemoteIds.length > 5) {
					this.recentRemoteIds = this.recentRemoteIds.slice(0, 5);
				}
				this.saveSetting();

				// Send country info to host
				fetch('/api/geo').then((r: Response) => r.json()).then((data: any) => {
					if (this._webrtc) this._webrtc.sendCommand({ type: 'clientInfo', country: data.country || 'XX' });
				}).catch(() => {});
				// Start local processing stream using mock device hooked up to WebRTC
				this.startStream();
			} else if (status.status === 'disconnected') {
				this.remoteStatus = 'Disconnected from Host';
				this.disconnect();
			} else if (status.status === 'error') {
				this.remoteMode = 'none';
				this.showMsg("WebRTC Error: " + status.error);
			}
		};

		this._webrtc.onCommand = (cmd: any) => this.handleRemoteCommand(cmd);
		this._webrtc.onFftChunk = (chunk: any) => {
			// Guard on _fftCtx (canvas ready) rather than this.running.
			// this.running is set only after `await backend.startRxStream()` resolves,
			// so frames that arrive in that async gap were silently dropped.
			if (!this._fftCtx) return;
			// chunk arrives as ArrayBuffer (PeerJS serialization:'raw').
			// Guard against Uint8Array in case of fallback path: extract the true
			// underlying bytes via byteOffset + byteLength, not numeric element cast.
			const buf = (chunk instanceof ArrayBuffer)
				? chunk
				: chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
			const u8 = new Uint8Array(buf);
			let fftData: Float32Array;
			if (u8.length >= 4 && u8[0] === 0xFF && u8[1] === 0xDA) {
				// KiwiSDR-style quantized packet: 4-byte header + N uint8 bins.
				// Unpack: uint8 → Float32 dB using WF_DB_MIN + uint8 value (1 dB/step).
				const WF_DB_MIN = -120.0;
				const binCount = u8[2] | (u8[3] << 8);
				fftData = new Float32Array(binCount);
				for (let i = 0; i < binCount; i++) {
					fftData[i] = WF_DB_MIN + u8[4 + i];
				}
			} else {
				// Legacy fallback: raw Float32 (old host)
				fftData = new Float32Array(buf);
			}
			if (fftData.length > 0) this.drawSpectrum(fftData);
		};
		this._webrtc.onAudioChunk = (chunk: any) => {
			if (this.running && this.backend) {
				// chunk arrives as ArrayBuffer (serialization:'raw').
				// Use .slice() with byteOffset/byteLength to handle typed-array views.
				const buf = (chunk instanceof ArrayBuffer)
					? chunk
					: chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
				this.backend.feedRemoteAudioChunk(Comlink.transfer(buf, [buf]));
			}
		};

		try {
			// initRemoteClient MUST come first — it installs the mock hackrf stub.
			// _webrtc.init() may fire the 'connected' event synchronously, which calls
			// startStream() -> startRxStream() -> hackrf.setSampleRateManual(). If the
			// mock isn't in place yet, hackrf is null and the call throws, leaving
			// this.running = false forever (all FFT frames get dropped).
			await this.backend.initRemoteClient();
			await this._webrtc.init();
		} catch(e: any) {
			this.showMsg("Failed to initialize remote client.");
		}
	},
	async regenerateShareCode(this: AppInstance) {
		if (this.remoteMode !== 'host' || !this._webrtc) return;
		// Tear down current host session and restart with a fresh code
		localStorage.removeItem('browsdr-share-code');
		this._webrtc.close();
		this._webrtc = null;
		this.remoteLink = '';
		this.remoteClients = [];
		await this.startRemoteHost();
	},
	async connectToRemoteId(this: AppInstance, id: string) {
		const cleanId = id.replace(/https?:\/\/.*?\/\?connect=/, '').trim();
		if (!cleanId) return;

		this.showRemoteConnectDialog = false;
		
		await this.connectRemoteClient(cleanId);
	},
	removeRecentRemoteId(this: AppInstance, id: string) {
		this.recentRemoteIds = this.recentRemoteIds.filter((x: string) => x !== id);
		this.saveSetting();
	},
	handleRemoteCommand(this: AppInstance, clientIdOrCmd: any, cmdOrUndefined?: any) {
		// Support both (clientId, cmd) from host and (cmd) from client
		let clientId: string | null, cmd: any;
		if (cmdOrUndefined === undefined) {
			cmd = clientIdOrCmd;
			clientId = null;
		} else {
			clientId = clientIdOrCmd;
			cmd = cmdOrUndefined;
		}

		if (cmd.type === 'sync') {
			this._applyingSync = true;
			if (cmd.radio) {
				// Flush stale audio to prevent glitches when sample rate or center freq changes
				this.audioRingPos = 0;
				this.nextPlayTime = 0;
				Object.assign(this.radio, cmd.radio);
			}
			if (cmd.gains) Object.assign(this.gains, cmd.gains);
			if (cmd.locks) Object.assign(this.locks, cmd.locks);
			this.$nextTick(() => { this._applyingSync = false; });
		} else if (cmd.type === 'clientInfo') {
			if (this.remoteMode === 'host' && clientId) {
				const rc = this.remoteClients.find((c: any) => c.id === clientId);
				if (rc) rc.country = cmd.country || 'XX';
			}
		} else if (cmd.type === 'vfoUpdate') {
			if (this.remoteMode === 'host' && clientId) {
				this.backend.setRemoteVfoParams(clientId, cmd.index, cmd.params);
				if (cmd.index === 0 && cmd.params) {
					const rc = this.remoteClients.find((c: any) => c.id === clientId);
					if (rc) rc.firstFreq = cmd.params.freq;
				}
			}
		} else if (cmd.type === 'addRemoteVfo') {
			if (this.remoteMode === 'host' && clientId) {
				this.backend.addRemoteVfo(clientId);
				const rc = this.remoteClients.find((c: any) => c.id === clientId);
				if (rc) rc.vfoCount++;
			}
		} else if (cmd.type === 'removeRemoteVfo') {
			if (this.remoteMode === 'host' && clientId) {
				this.backend.removeRemoteVfo(clientId, cmd.index);
				const rc = this.remoteClients.find((c: any) => c.id === clientId);
				if (rc && rc.vfoCount > 0) rc.vfoCount--;
			}
		} else if (cmd.type === 'pocsag') {
			if (this.remoteMode === 'client') {
				this._onPocsagMessage(cmd.vfoIndex, cmd.freq, cmd.msg);
			}
		} else if (cmd.type === 'squelchState') {
			if (this.remoteMode === 'client') {
				// Apply host-side squelch states to local VFO state so
				// getDspStats() returns correct values for frequency activity.
				const states: boolean[] = cmd.squelchOpen;
				for (let i = 0; i < states.length; i++) {
					if (!this.vfoSquelchOpen) this.vfoSquelchOpen = [];
					this.vfoSquelchOpen[i] = states[i];
					// Update activity stats directly (mirrors _statsTimer logic)
					if (!this.vfoActivityStats[i]) {
						this.vfoActivityStats[i] = { count: 0, totalMs: 0, squelchOpenSince: null };
					}
					const stat = this.vfoActivityStats[i];
					const now = Date.now();
					if (states[i] && this.vfos[i]?.enabled) {
						if (stat.squelchOpenSince === null) {
							stat.squelchOpenSince = now;
							stat.count++;
						}
					} else {
						if (stat.squelchOpenSince !== null) {
							stat.totalMs += now - stat.squelchOpenSince;
							stat.squelchOpenSince = null;
						}
					}
				}
				this.activityNow = Date.now();
			}
		} else if (cmd.type === 'requestChange') {
			if (this.remoteMode === 'host') {
				const { target, property, value } = cmd;
				let allow = true;

				if (target === 'radio' && property === 'centerFreq' && this.locks.centerFreq) allow = false;
				if (target === 'radio' && property === 'sampleRate' && this.locks.sampleRate) allow = false;
				if (target === 'gains') {
					if (this.locks[property]) allow = false;
				}

				if (allow) {
					if (target === 'radio') this.radio[property] = value;
					else if (target === 'gains') this.gains[property] = value;
					// Sync back so all clients update their frontend
					this._webrtc.sendCommand({ type: 'sync', radio: this.radio, gains: this.gains });
				} else if (clientId) {
					// Reject the change. Sync back the *current* real state so the requesting client's UI snaps back.
					this._webrtc.sendCommandTo(clientId, { type: 'sync', radio: this.radio, gains: this.gains });
				}
			}
		}
	},
	kickRemoteClient(this: AppInstance, clientId: string) {
		if (!this._webrtc) return;
		this._webrtc.kickClient(clientId);
		this.backend.removeRemoteClient(clientId);
		this.remoteClients = this.remoteClients.filter((c: any) => c.id !== clientId);
		if (this.remoteClients.length > 0) {
			this.remoteStatus = this.remoteClients.length + ' client' + (this.remoteClients.length !== 1 ? 's' : '') + ' connected';
		} else {
			this.remoteStatus = 'Waiting for connection';
		}
		this.showMsg("Client kicked.");
	},
	remoteClientDuration(this: AppInstance, connectedAt: number) {
		const seconds = Math.floor((Date.now() - connectedAt) / 1000);
		if (seconds < 60) return seconds + 's';
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return minutes + 'm';
		const hours = Math.floor(minutes / 60);
		return hours + 'h ' + (minutes % 60) + 'm';
	}
};
