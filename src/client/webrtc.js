export class WebRTCHandler {
	constructor(isHost, remoteId = null) {
		this.isHost = isHost;
		this.peer = null;

		// --- Multi-client (host) ---
		// Map<peerId, { cmd, fft, audio, fftOverflow, audioOverflow }>
		this.clients = new Map();

		// --- Single-connection (client) ---
		this.connCmd = null;
		this.connFft = null;
		this.connAudio = null;
		this.connFftOverflow = false;
		this.connAudioOverflow = false;

		this.remoteId = remoteId; // Used by client to connect to host

		this.onStatusChange = null;
		this.onCommand = null;   // Host: (clientId, cmd) — Client: (cmd)
		this.onFftChunk = null;
		this.onAudioChunk = null;
	}

	async init() {
		// Import peerjs dynamically from window.Peer since it's loaded as a script
		if (!window.Peer) {
			console.error("PeerJS not loaded!");
			return false;
		}

		// Fetch TURN credentials from our Cloudflare Worker endpoint
		let peerConfig = undefined;
		try {
			const turnResp = await fetch('/api/turn');
			const turnData = await turnResp.json();
			if (turnData.iceServers && turnData.iceServers.length > 0) {
				peerConfig = { iceServers: turnData.iceServers };
				console.log('[WebRTC] TURN credentials loaded, ICE servers:', turnData.iceServers.length);
			} else {
				console.warn('[WebRTC] No TURN servers available, using STUN only (may fail behind symmetric NAT)');
			}
		} catch (err) {
			console.warn('[WebRTC] Failed to fetch TURN credentials, using STUN only:', err.message);
		}

		return new Promise((resolve, reject) => {
			const peerOpts = peerConfig ? { config: peerConfig } : {};
			if (this.isHost) {
				// Host generates a random alphabet id
				const id = 'browsdr-' + Math.random().toString(36).substring(2, 8);
				this.peer = new window.Peer(id, peerOpts);
			} else {
				// Client generates random id, will connect to this.remoteId
				this.peer = new window.Peer(undefined, peerOpts);
			}

			this.peer.on('open', (id) => {
				console.log('My peer ID is: ' + id);

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

			this.peer.on('connection', (conn) => {
				if (this.isHost) {
					this._handleIncomingConnection(conn);
				}
			});

			this.peer.on('error', (err) => {
				console.error('PeerJS error:', err);
				this._setStatus({ status: 'error', error: err.type });
				reject(err);
			});

			this.peer.on('disconnected', () => {
				this._setStatus({ status: 'disconnected' });
			});
		});
	}

	_setStatus(msgObj) {
		console.log(`[WebRTC]`, msgObj);
		if (this.onStatusChange) this.onStatusChange(msgObj);
	}

	_monitorIceState(conn, label, side) {
		// PeerJS exposes the underlying RTCPeerConnection once the connection is negotiated
		const check = () => {
			const pc = conn.peerConnection;
			if (!pc) {
				// peerConnection not yet available, retry shortly
				setTimeout(check, 200);
				return;
			}
			console.log(`[${side}] ${label} ICE: ${pc.iceConnectionState}, signaling: ${pc.signalingState}, gathering: ${pc.iceGatheringState}`);
			pc.oniceconnectionstatechange = () => {
				console.log(`[${side}] ${label} ICE state → ${pc.iceConnectionState}`);
				if (pc.iceConnectionState === 'failed') {
					console.error(`[${side}] ${label} ICE negotiation FAILED. Candidates exchanged but no path found.`);
				}
			};
			pc.onicegatheringstatechange = () => {
				console.log(`[${side}] ${label} ICE gathering → ${pc.iceGatheringState}`);
			};
			pc.onconnectionstatechange = () => {
				console.log(`[${side}] ${label} connection state → ${pc.connectionState}`);
			};
		};
		check();
	}

	_connectToHost() {
		console.log(`[WebRTC-Client] Connecting to host ${this.remoteId}, opening 3 channels...`);
		// Client connects to Host. Open three channels.
		// serialization:'binary' is required for all channels that carry typed arrays.
		// Without it PeerJS defaults to binary-pack (msgpack) which wraps the
		// ArrayBuffer in a Uint8Array envelope — Float32Array reconstruction on the
		// receiving end then produces garbage values or an array of the wrong length.
		this.connCmd = this.peer.connect(this.remoteId, { label: 'cmd', reliable: true, serialization: 'binary' });
		// 'raw' bypasses binarypack entirely — send/receive as plain ArrayBuffer.
		// With 'binary' (binarypack), the receiver gets a Uint8Array; doing
		// new Float32Array(uint8Array) then numerically casts each byte (0-255)
		// instead of reinterpreting the raw bytes, producing garbage float values.
		this.connFft = this.peer.connect(this.remoteId, { label: 'fft', reliable: false, serialization: 'raw' });
		this.connAudio = this.peer.connect(this.remoteId, { label: 'audio', reliable: false, serialization: 'raw' });

		this._setupClientListeners(this.connCmd, 'cmd');
		this._setupClientListeners(this.connFft, 'fft');
		this._setupClientListeners(this.connAudio, 'audio');

		// Monitor ICE state on each connection
		this._monitorIceState(this.connCmd, 'cmd', 'WebRTC-Client');
		this._monitorIceState(this.connFft, 'fft', 'WebRTC-Client');
		this._monitorIceState(this.connAudio, 'audio', 'WebRTC-Client');

		// Timeout: if not all channels open within 15s, dump diagnostic info
		setTimeout(() => {
			if (!(this.connCmd?.open && this.connFft?.open && this.connAudio?.open)) {
				console.warn(`[WebRTC-Client] Connection timeout after 15s. Not all channels opened.`);
				this._logClientChannelState();
				[['cmd', this.connCmd], ['fft', this.connFft], ['audio', this.connAudio]].forEach(([label, c]) => {
					if (c?.peerConnection) {
						const pc = c.peerConnection;
						console.warn(`[WebRTC-Client] ${label} — ICE: ${pc.iceConnectionState}, signaling: ${pc.signalingState}, connection: ${pc.connectionState}`);
					} else {
						console.warn(`[WebRTC-Client] ${label} — no peerConnection available`);
					}
				});
			}
		}, 15000);
	}

	// ── Host: incoming connection handling (multi-client) ─────────────────

	_handleIncomingConnection(conn) {
		const clientId = conn.peer;
		console.log(`[WebRTC-Host] Incoming connection from ${clientId}, label=${conn.label}, serialization=${conn.serialization}`);
		if (!this.clients.has(clientId)) {
			this.clients.set(clientId, { cmd: null, fft: null, audio: null, fftOverflow: false, audioOverflow: false });
		}
		const client = this.clients.get(clientId);

		if (conn.label === 'cmd') {
			client.cmd = conn;
		} else if (conn.label === 'fft') {
			client.fft = conn;
		} else if (conn.label === 'audio') {
			client.audio = conn;
		}

		this._setupHostListeners(conn, conn.label, clientId);
		this._monitorIceState(conn, conn.label, `WebRTC-Host(${clientId.substring(0, 8)})`);
	}

	_logHostChannelState(clientId) {
		const client = this.clients.get(clientId);
		if (!client) return;
		console.log(`[WebRTC-Host] Channel state for ${clientId}: cmd=${client.cmd?.open ?? 'null'} fft=${client.fft?.open ?? 'null'} audio=${client.audio?.open ?? 'null'}`);
	}

	_setupHostListeners(conn, type, clientId) {
		conn.on('open', () => {
			console.log(`[WebRTC-Host] ${type} channel opened for client ${clientId}.`);
			this._logHostChannelState(clientId);
			const client = this.clients.get(clientId);
			if (client && client.cmd && client.cmd.open && client.fft && client.fft.open && client.audio && client.audio.open) {
				console.log(`[WebRTC-Host] All 3 channels open for ${clientId}, emitting client-connected.`);
				this._setStatus({ status: 'client-connected', clientId });
			}
		});

		conn.on('data', (data) => {
			if (type === 'cmd') {
				if (this.onCommand) this.onCommand(clientId, data);
			}
			// Host doesn't receive fft/audio from clients
		});

		conn.on('error', (err) => {
			console.error(`[WebRTC-Host] ${type} channel error for client ${clientId}:`, err);
			this._logHostChannelState(clientId);
		});

		conn.on('close', () => {
			console.log(`[WebRTC-Host] ${type} channel closed for client ${clientId}.`);
			const client = this.clients.get(clientId);
			if (!client) return;
			// Only fire disconnected once when any channel drops
			if (client.cmd && client.fft && client.audio) {
				this.clients.delete(clientId);
				this._setStatus({ status: 'client-disconnected', clientId });
			}
		});
	}

	// ── Client: connection listeners (single host) ───────────────────────

	_logClientChannelState() {
		console.log(`[WebRTC-Client] Channel state: cmd=${this.connCmd?.open ?? 'null'} fft=${this.connFft?.open ?? 'null'} audio=${this.connAudio?.open ?? 'null'}`);
	}

	_setupClientListeners(conn, type) {
		conn.on('open', () => {
			console.log(`[WebRTC-Client] ${type} channel opened.`);
			this._logClientChannelState();
			if (this.connCmd && this.connCmd.open && this.connFft && this.connFft.open && this.connAudio && this.connAudio.open) {
				console.log(`[WebRTC-Client] All 3 channels open, emitting connected.`);
				this._setStatus({ status: 'connected' });
			}
		});

		conn.on('data', (data) => {
			if (type === 'cmd') {
				if (this.onCommand) this.onCommand(data);
			} else if (type === 'fft') {
				if (this.onFftChunk) this.onFftChunk(data);
			} else if (type === 'audio') {
				if (this.onAudioChunk) this.onAudioChunk(data);
			}
		});

		conn.on('error', (err) => {
			console.error(`[WebRTC-Client] ${type} channel error:`, err);
			this._logClientChannelState();
		});

		conn.on('close', () => {
			console.log(`[WebRTC-Client] ${type} channel closed.`);
			this._setStatus({ status: 'disconnected' });
		});
	}

	// ── Sending: Host → Clients ──────────────────────────────────────────

	sendCommand(cmd) {
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

	sendCommandTo(clientId, cmd) {
		const client = this.clients.get(clientId);
		if (client && client.cmd && client.cmd.open) {
			client.cmd.send(cmd);
		}
	}

	// Returns an ArrayBuffer that contains exactly the bytes of `chunk`.
	// If chunk is a typed-array view (e.g. a subarray of a larger buffer),
	// chunk.buffer is the ENTIRE backing buffer — we must slice to the view bounds.
	_toArrayBuffer(chunk) {
		if (chunk instanceof ArrayBuffer) return chunk;
		return chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
	}

	sendFftChunk(chunk) {
		if (this.isHost) {
			const buf = this._toArrayBuffer(chunk);
			// Broadcast to all clients with per-client backpressure
			for (const [, client] of this.clients) {
				if (client.fft && client.fft.open) {
					if (client.fft.dataChannel) {
						const buffered = client.fft.dataChannel.bufferedAmount;
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
					const buffered = this.connFft.dataChannel.bufferedAmount;
					if (buffered > 2097152) this.connFftOverflow = true;
					else if (buffered < 524288) this.connFftOverflow = false;
					if (this.connFftOverflow) return;
				}
				this.connFft.send(this._toArrayBuffer(chunk));
			}
		}
	}

	sendAudioChunk(chunk) {
		// Client-side only (client doesn't send audio)
		if (this.connAudio && this.connAudio.open) {
			if (this.connAudio.dataChannel) {
				const buffered = this.connAudio.dataChannel.bufferedAmount;
				if (buffered > 1048576) this.connAudioOverflow = true;
				else if (buffered < 262144) this.connAudioOverflow = false;
				if (this.connAudioOverflow) return;
			}
			this.connAudio.send(this._toArrayBuffer(chunk));
		}
	}

	sendAudioChunkTo(clientId, chunk) {
		const client = this.clients.get(clientId);
		if (!client || !client.audio || !client.audio.open) return;
		if (client.audio.dataChannel) {
			const buffered = client.audio.dataChannel.bufferedAmount;
			if (buffered > 1048576) client.audioOverflow = true;
			else if (buffered < 262144) client.audioOverflow = false;
			if (client.audioOverflow) return;
		}
		client.audio.send(this._toArrayBuffer(chunk));
	}

	// ── Client management (host) ─────────────────────────────────────────

	kickClient(clientId) {
		const client = this.clients.get(clientId);
		if (!client) return;
		if (client.cmd) try { client.cmd.close(); } catch (_) {}
		if (client.fft) try { client.fft.close(); } catch (_) {}
		if (client.audio) try { client.audio.close(); } catch (_) {}
		this.clients.delete(clientId);
	}

	getConnectedClientIds() {
		return Array.from(this.clients.keys());
	}

	close() {
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
