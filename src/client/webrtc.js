export class WebRTCHandler {
	constructor(isHost, remoteId = null) {
		this.isHost = isHost;
		this.peer = null;
		this.connCmd = null;
		this.connFft = null;
		this.connAudio = null;
		this.connFftOverflow = false;
		this.connAudioOverflow = false;

		this.remoteId = remoteId; // Used by client to connect to host

		this.onStatusChange = null;
		this.onCommand = null;
		this.onFftChunk = null;
		this.onAudioChunk = null;
	}

	async init() {
		// Import peerjs dynamically from window.Peer since it's loaded as a script
		if (!window.Peer) {
			console.error("PeerJS not loaded!");
			return false;
		}

		return new Promise((resolve, reject) => {
			if (this.isHost) {
				// Host generates a random alphabet id
				const id = 'browsdr-' + Math.random().toString(36).substring(2, 8);
				this.peer = new window.Peer(id);
			} else {
				// Client generates random id, will connect to this.remoteId
				this.peer = new window.Peer();
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

	_connectToHost() {
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

		this._setupConnectionListeners(this.connCmd, 'cmd');
		this._setupConnectionListeners(this.connFft, 'fft');
		this._setupConnectionListeners(this.connAudio, 'audio');
	}

	_handleIncomingConnection(conn) {
		// Host receives incoming connection on whichever label the client opened.
		if (conn.label === 'cmd') {
			this.connCmd = conn;
			this._setupConnectionListeners(conn, 'cmd');
		} else if (conn.label === 'fft') {
			this.connFft = conn;
			this._setupConnectionListeners(conn, 'fft');
		} else if (conn.label === 'audio') {
			this.connAudio = conn;
			this._setupConnectionListeners(conn, 'audio');
		}
	}

	_setupConnectionListeners(conn, type) {
		conn.on('open', () => {
			console.log(`[WebRTC] ${type} channel opened.`);
			if (this.connCmd && this.connCmd.open && this.connFft && this.connFft.open && this.connAudio && this.connAudio.open) {
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

		conn.on('close', () => {
			console.log(`[WebRTC] ${type} channel closed.`);
			this._setStatus({ status: 'disconnected' });
		});
	}

	sendCommand(cmd) {
		if (this.connCmd && this.connCmd.open) {
			this.connCmd.send(cmd);
		}
	}

	// Returns an ArrayBuffer that contains exactly the bytes of `chunk`.
	// If chunk is a typed-array view (e.g. a subarray of a larger buffer),
	// chunk.buffer is the ENTIRE backing buffer \u2014 we must slice to the view bounds.
	_toArrayBuffer(chunk) {
		if (chunk instanceof ArrayBuffer) return chunk;
		return chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
	}

	sendFftChunk(chunk) {
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
	
	sendAudioChunk(chunk) {
		if (this.connAudio && this.connAudio.open) {
			if (this.connAudio.dataChannel) {
				const buffered = this.connAudio.dataChannel.bufferedAmount;
				if (buffered > 1048576) this.connAudioOverflow = true;  // 1MB HW mark for audio
				else if (buffered < 262144) this.connAudioOverflow = false; // 250KB LW mark
				
				if (this.connAudioOverflow) return;
			}
			this.connAudio.send(this._toArrayBuffer(chunk));
		}
	}
	
	close() {
		if (this.connCmd) this.connCmd.close();
		if (this.connFft) this.connFft.close();
		if (this.connAudio) this.connAudio.close();
		if (this.peer) this.peer.destroy();
	}
}
