interface ClientEntry {
	cmd: any;
	fft: any;
	audio: any;
	fftOverflow: boolean;
	audioOverflow: boolean;
	isRelay: boolean;
}

interface StatusMessage {
	status: string;
	id?: string;
	error?: string;
	clientId?: string;
	isRelay?: boolean;
}

type StatusChangeCallback = (msg: StatusMessage) => void;
type CommandCallbackHost = (clientId: string, cmd: any) => void;
type CommandCallbackClient = (cmd: any) => void;
type ChunkCallback = (data: ArrayBuffer) => void;

declare const window: Window & { Peer: any };

/** Prefix prepended to all PeerJS IDs (hidden from users / share links). */
export const PEER_ID_PREFIX = 'browsdr-';

export class WebRTCHandler {
	isHost: boolean;
	peer: any;

	// --- Multi-client (host) ---
	// Map<peerId, ClientEntry>
	clients: Map<string, ClientEntry>;

	// --- Single-connection (client) ---
	connCmd: any;
	connFft: any;
	connAudio: any;
	connFftOverflow: boolean;
	connAudioOverflow: boolean;

	remoteId: string | null; // Used by client to connect to host
	preferredHostId: string | null; // Used by host to reuse a previous share code

	onStatusChange: StatusChangeCallback | null;
	onCommand: CommandCallbackHost | CommandCallbackClient | null;
	onFftChunk: ChunkCallback | null;
	onAudioChunk: ChunkCallback | null;

	constructor(isHost: boolean, remoteId: string | null = null, preferredHostId: string | null = null) {
		this.isHost = isHost;
		this.peer = null;

		// --- Multi-client (host) ---
		this.clients = new Map();

		// --- Single-connection (client) ---
		this.connCmd = null;
		this.connFft = null;
		this.connAudio = null;
		this.connFftOverflow = false;
		this.connAudioOverflow = false;

		this.remoteId = remoteId;
		this.preferredHostId = preferredHostId;

		this.onStatusChange = null;
		this.onCommand = null;
		this.onFftChunk = null;
		this.onAudioChunk = null;
	}

	async init(): Promise<string | false> {
		// Import peerjs dynamically from window.Peer since it's loaded as a script
		if (!window.Peer) {
			console.error("PeerJS not loaded!");
			return false;
		}

		// Fetch TURN credentials from our Cloudflare Worker endpoint
		let peerConfig: { iceServers: RTCIceServer[] } | undefined = undefined;
		try {
			const turnResp = await fetch('/api/turn');
			const turnData = await turnResp.json();
			if (turnData.iceServers && turnData.iceServers.length > 0) {
				peerConfig = { iceServers: turnData.iceServers };
				console.log('[WebRTC] TURN credentials loaded');
			} else {
				console.warn('[WebRTC] No TURN servers available, using STUN only');
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn('[WebRTC] Failed to fetch TURN credentials:', msg);
		}

		return new Promise<string>((resolve, reject) => {
			const connectWithRetry = (retries: number) => {
				const peerOpts = peerConfig ? { config: peerConfig } : {};
				if (this.isHost) {
					// Reuse preferred ID if available, otherwise generate a new 5-char code
					const shortId = this.preferredHostId || Math.random().toString(36).substring(2, 7);
					this.peer = new window.Peer(PEER_ID_PREFIX + shortId, peerOpts);
				} else {
					// Client generates random id, will connect to this.remoteId
					this.peer = new window.Peer(undefined, peerOpts);
				}

				this.peer.on('open', (id: string) => {
					console.log('[WebRTC] Peer ID:', id);

					if (this.isHost) {
						this._setStatus({ status: 'ready', id: id });
					} else {
						this._setStatus({ status: 'connecting' });
						if (this.remoteId) {
							this._connectToHost();
						}
					}
					resolve(id);
				});

				this.peer.on('connection', (conn: any) => {
					if (this.isHost) {
						this._handleIncomingConnection(conn);
					}
				});

				this.peer.on('error', (err: any) => {
					if (this.isHost && err.type === 'unavailable-id' && retries > 0) {
						console.warn('[WebRTC] Generated ID was taken, retrying with new ID...');
						this.preferredHostId = null; // Don't reuse the taken ID
						this.peer.destroy();
						connectWithRetry(retries - 1);
						return;
					}

					console.error('[WebRTC] PeerJS error:', err);
					this._setStatus({ status: 'error', error: err.type });
					reject(err);
				});

				this.peer.on('disconnected', () => {
					this._setStatus({ status: 'disconnected' });
				});
			};

			connectWithRetry(3);
		});
	}

	_setStatus(msgObj: StatusMessage): void {
		if (this.onStatusChange) this.onStatusChange(msgObj);
	}

	// Check whether a connection is using a TURN relay (vs direct peer-to-peer)
	async _checkRelayType(conn: any, clientId: string | null): Promise<boolean | null> {
		const pc: RTCPeerConnection | undefined = conn.peerConnection;
		if (!pc) return null;
		try {
			const stats = await pc.getStats();
			for (const [, report] of stats) {
				if (report.type === 'candidate-pair' && report.state === 'succeeded') {
					const localCandidate = stats.get(report.localCandidateId);
					if (localCandidate) {
						const isRelay: boolean = localCandidate.candidateType === 'relay';
						const label = clientId ? clientId.substring(0, 8) : 'host';
						if (isRelay) {
							console.warn(`[WebRTC] Client ${label} is using TURN relay`);
						} else {
							console.log(`[WebRTC] Client ${label} is connected peer-to-peer (${localCandidate.candidateType})`);
						}
						// Include relay status in client-connected event for host tracking
						if (this.isHost && clientId) {
							const client = this.clients.get(clientId);
							if (client) client.isRelay = isRelay;
						}
						return isRelay;
					}
				}
			}
		} catch (_) {}
		return null;
	}

	_connectToHost(): void {
		console.log('[WebRTC] Connecting to host...');
		// Client connects to Host. Open three channels.
		// serialization:'binary' is required for all channels that carry typed arrays.
		// Without it PeerJS defaults to binary-pack (msgpack) which wraps the
		// ArrayBuffer in a Uint8Array envelope -- Float32Array reconstruction on the
		// receiving end then produces garbage values or an array of the wrong length.
		this.connCmd = this.peer.connect(this.remoteId, { label: 'cmd', reliable: true, serialization: 'binary' });
		// 'raw' bypasses binarypack entirely -- send/receive as plain ArrayBuffer.
		// With 'binary' (binarypack), the receiver gets a Uint8Array; doing
		// new Float32Array(uint8Array) then numerically casts each byte (0-255)
		// instead of reinterpreting the raw bytes, producing garbage float values.
		this.connFft = this.peer.connect(this.remoteId, { label: 'fft', reliable: false, serialization: 'raw' });
		this.connAudio = this.peer.connect(this.remoteId, { label: 'audio', reliable: false, serialization: 'raw' });

		this._setupClientListeners(this.connCmd, 'cmd');
		this._setupClientListeners(this.connFft, 'fft');
		this._setupClientListeners(this.connAudio, 'audio');

		// Timeout: if not all channels open within 15s, dump diagnostic info
		setTimeout(() => {
			if (!(this.connCmd?.open && this.connFft?.open && this.connAudio?.open)) {
				console.warn('[WebRTC] Connection timeout after 15s. Not all channels opened.');
				const channels: [string, any][] = [['cmd', this.connCmd], ['fft', this.connFft], ['audio', this.connAudio]];
				channels.forEach(([label, c]) => {
					const pc: RTCPeerConnection | undefined = c?.peerConnection;
					if (pc) {
						console.warn(`[WebRTC] ${label}: open=${c.open}, ICE=${pc.iceConnectionState}, connection=${pc.connectionState}`);
					} else {
						console.warn(`[WebRTC] ${label}: no peerConnection`);
					}
				});
			}
		}, 15000);
	}

	// -- Host: incoming connection handling (multi-client) --

	_handleIncomingConnection(conn: any): void {
		const clientId: string = conn.peer;
		if (!this.clients.has(clientId)) {
			this.clients.set(clientId, { cmd: null, fft: null, audio: null, fftOverflow: false, audioOverflow: false, isRelay: false });
		}
		const client = this.clients.get(clientId)!;

		if (conn.label === 'cmd') {
			client.cmd = conn;
		} else if (conn.label === 'fft') {
			client.fft = conn;
		} else if (conn.label === 'audio') {
			client.audio = conn;
		}

		this._setupHostListeners(conn, conn.label, clientId);
	}

	_setupHostListeners(conn: any, type: string, clientId: string): void {
		conn.on('open', () => {
			const client = this.clients.get(clientId);
			if (client && client.cmd && client.cmd.open && client.fft && client.fft.open && client.audio && client.audio.open) {
				// All 3 channels open -- check relay type on the cmd channel, then emit connected
				this._checkRelayType(client.cmd, clientId).then((isRelay: boolean | null) => {
					this._setStatus({ status: 'client-connected', clientId, isRelay: !!isRelay });
				});
			}
		});

		conn.on('data', (data: any) => {
			if (type === 'cmd') {
				if (this.onCommand) (this.onCommand as CommandCallbackHost)(clientId, data);
			}
			// Host doesn't receive fft/audio from clients
		});

		conn.on('error', (err: any) => {
			console.error(`[WebRTC] Channel error for ${clientId.substring(0, 8)}/${type}:`, err);
		});

		conn.on('close', () => {
			const client = this.clients.get(clientId);
			if (!client) return;
			// Only fire disconnected once when any channel drops
			if (client.cmd && client.fft && client.audio) {
				this.clients.delete(clientId);
				this._setStatus({ status: 'client-disconnected', clientId });
			}
		});
	}

	// -- Client: connection listeners (single host) --

	_setupClientListeners(conn: any, type: string): void {
		conn.on('open', () => {
			if (this.connCmd && this.connCmd.open && this.connFft && this.connFft.open && this.connAudio && this.connAudio.open) {
				this._checkRelayType(this.connCmd, null);
				this._setStatus({ status: 'connected' });
			}
		});

		conn.on('data', (data: any) => {
			if (type === 'cmd') {
				if (this.onCommand) (this.onCommand as CommandCallbackClient)(data);
			} else if (type === 'fft') {
				if (this.onFftChunk) this.onFftChunk(data);
			} else if (type === 'audio') {
				if (this.onAudioChunk) this.onAudioChunk(data);
			}
		});

		conn.on('error', (err: any) => {
			console.error(`[WebRTC] ${type} channel error:`, err);
		});

		conn.on('close', () => {
			this._setStatus({ status: 'disconnected' });
		});
	}

	// -- Sending: Host -> Clients --

	sendCommand(cmd: any): void {
		if (this.isHost) {
			// Broadcast to all clients
			for (const [, client] of this.clients) {
				if (client.cmd && client.cmd.open) {
					client.cmd.send(cmd);
				}
			}
		} else {
			// Client sends to host
			if (this.connCmd && this.connCmd.open) {
				this.connCmd.send(cmd);
			}
		}
	}

	sendCommandTo(clientId: string, cmd: any): void {
		const client = this.clients.get(clientId);
		if (client && client.cmd && client.cmd.open) {
			client.cmd.send(cmd);
		}
	}

	// Returns an ArrayBuffer that contains exactly the bytes of `chunk`.
	// If chunk is a typed-array view (e.g. a subarray of a larger buffer),
	// chunk.buffer is the ENTIRE backing buffer -- we must slice to the view bounds.
	_toArrayBuffer(chunk: ArrayBuffer | ArrayBufferView): ArrayBuffer {
		if (chunk instanceof ArrayBuffer) return chunk;
		const view = chunk as ArrayBufferView;
		return (view.buffer as ArrayBuffer).slice(view.byteOffset, view.byteOffset + view.byteLength);
	}

	sendFftChunk(chunk: ArrayBuffer | ArrayBufferView): void {
		if (this.isHost) {
			const buf = this._toArrayBuffer(chunk);
			// Broadcast to all clients with per-client backpressure
			for (const [, client] of this.clients) {
				if (client.fft && client.fft.open) {
					if (client.fft.dataChannel) {
						const buffered: number = client.fft.dataChannel.bufferedAmount;
						if (buffered > 2097152) client.fftOverflow = true;
						else if (buffered < 524288) client.fftOverflow = false;
						if (client.fftOverflow) continue;
					}
					client.fft.send(buf);
				}
			}
		} else {
			if (this.connFft && this.connFft.open) {
				if (this.connFft.dataChannel) {
					const buffered: number = this.connFft.dataChannel.bufferedAmount;
					if (buffered > 2097152) this.connFftOverflow = true;
					else if (buffered < 524288) this.connFftOverflow = false;
					if (this.connFftOverflow) return;
				}
				this.connFft.send(this._toArrayBuffer(chunk));
			}
		}
	}

	sendAudioChunk(chunk: ArrayBuffer | ArrayBufferView): void {
		// Client-side only (client doesn't send audio)
		if (this.connAudio && this.connAudio.open) {
			if (this.connAudio.dataChannel) {
				const buffered: number = this.connAudio.dataChannel.bufferedAmount;
				if (buffered > 1048576) this.connAudioOverflow = true;
				else if (buffered < 262144) this.connAudioOverflow = false;
				if (this.connAudioOverflow) return;
			}
			this.connAudio.send(this._toArrayBuffer(chunk));
		}
	}

	sendAudioChunkTo(clientId: string, chunk: ArrayBuffer | ArrayBufferView): void {
		const client = this.clients.get(clientId);
		if (!client || !client.audio || !client.audio.open) return;
		if (client.audio.dataChannel) {
			const buffered: number = client.audio.dataChannel.bufferedAmount;
			if (buffered > 1048576) client.audioOverflow = true;
			else if (buffered < 262144) client.audioOverflow = false;
			if (client.audioOverflow) return;
		}
		client.audio.send(this._toArrayBuffer(chunk));
	}

	// -- Client management (host) --

	kickClient(clientId: string): void {
		const client = this.clients.get(clientId);
		if (!client) return;
		if (client.cmd) try { client.cmd.close(); } catch (_) {}
		if (client.fft) try { client.fft.close(); } catch (_) {}
		if (client.audio) try { client.audio.close(); } catch (_) {}
		this.clients.delete(clientId);
	}

	getConnectedClientIds(): string[] {
		return Array.from(this.clients.keys());
	}

	close(): void {
		if (this.isHost) {
			for (const [, client] of this.clients) {
				if (client.cmd) try { client.cmd.close(); } catch (_) {}
				if (client.fft) try { client.fft.close(); } catch (_) {}
				if (client.audio) try { client.audio.close(); } catch (_) {}
			}
			this.clients.clear();
		} else {
			if (this.connCmd) this.connCmd.close();
			if (this.connFft) this.connFft.close();
			if (this.connAudio) this.connAudio.close();
		}
		if (this.peer) this.peer.destroy();
	}
}
