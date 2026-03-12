import type { AppInstance } from './types';
import * as Comlink from 'comlink';
import { HackRF } from '../hackrf';

export const connectionMethods = {
	async connect(this: AppInstance) {
		if (!this.backend) return;
		this._initAudioCtx(); // create AudioContext within user gesture
		this.showMsg("Connecting...");
		try {
			let ok = await this.backend.open();
			if (!ok) {
				const device = await HackRF.requestDevice();
				if (!device) return;
				ok = await this.backend.open({
					vendorId: device.vendorId,
					productId: device.productId,
					serialNumber: device.serialNumber
				});
			}
			if (ok) {
				this.connected = true;
				const info = await this.backend.info();
				this.info.boardName = HackRF.BOARD_ID_NAME.get(info.boardId);
				this.showMsg("Connected to " + this.info.boardName);
				await this.startStream();
			} else {
				this.showMsg("Failed to open device.");
			}
		} catch (e: any) {
			this.showMsg("Connect Error: " + e.message);
		}
	},
	async connectMock(this: AppInstance) {
		if (!this.backend) return;
		this._initAudioCtx(); // create AudioContext within user gesture
		this.showMsg("Connecting Mock SDR...");
		try {
			const ok = await this.backend.open("mock");
			if (ok) {
				this.connected = true;
				this.info.boardName = "Mock SDR (Signal Gen)";
				this.showMsg("Connected to Mock SDR");
				await this.startStream();
			} else {
				this.showMsg("Failed to open Mock SDR.");
			}
		} catch (e: any) {
			this.showMsg("Mock Connect Error: " + e.message);
		}
	},
	async disconnect(this: AppInstance) {
		if (this.remoteMode === 'client' && this._webrtc) {
			this._webrtc.close();
			this._webrtc = null;
			this.remoteMode = 'none';
			if (this.running) await this.togglePlay();
			this.connected = false;
			this.showMsg("Disconnected from remote device");
			// Clear the URL
			window.history.replaceState({}, document.title, "/");
			return;
		}

		if (this.remoteMode === 'host' && this._webrtc) {
			this._webrtc.close();
			this._webrtc = null;
			this.remoteMode = 'none';
			this.remoteClients = [];
			this.showRemoteClientsDialog = false;
			this.showMsg("Remote sharing stopped");
		}

		if (this.running) await this.togglePlay();
		await this.backend.close();
		this.connected = false;
		this.showMsg("Disconnected");
	},
	async togglePlay(this: AppInstance, isRestart = false) {
		if (this.running) {
			await this.backend.stopRx();
			this.running = false;
			if (this._statsTimer) { clearInterval(this._statsTimer); this._statsTimer = null; }
			this.dspStats = null;
			if (this.audioCtx) {
				try { await this.audioCtx.close(); } catch (_: any) { }
				this.audioCtx = null;
				this.gainNode = null;
			}
		} else {
			this.startStream(isRestart);
		}
	},
	async startStream(this: AppInstance, isRestart = false) {
		if (this.running) return;

		this.initCanvas();

		// Set running=true synchronously so drawSpectrum() isn't blocked by the
		// `if (!this.running)` guard while we're awaiting startRxStream(). For
		// remote clients, WebRTC FFT chunks can arrive before that await resolves.
		this.running = true;

		const opts = {
			centerFreq: this.radio.centerFreq,
			sampleRate: this.radio.sampleRate,
			fftSize: this.radio.fftSize,
			lnaGain: this.gains.lna,
			vgaGain: this.gains.vga,
			ampEnabled: this.gains.ampEnabled,
		};

		try {
			await this.backend.startRxStream(opts,
				Comlink.proxy((spectrumData: any) => this.drawSpectrum(spectrumData)),
				Comlink.proxy((audioSamples: any) => this.playAudio(audioSamples)),
				Comlink.proxy((vfoIndex: number, freq: number, samples: any) => this._feedWhisperVfo(vfoIndex, freq, samples)),
				Comlink.proxy((vfoIndex: number, freq: number, msg: any) => this._onPocsagMessage(vfoIndex, freq, msg))
			);
		} catch (e: any) {
			console.error('Error starting RX stream:', e);
			this.showMsg("Error starting stream.");
			this.running = false;
			return;
		}

		this._statsTimer = setInterval(async () => {
			if (this.backend && this.running) {
				this.dspStats = await this.backend.getDspStats();
				// Remote clients receive squelch state via WebRTC 'squelchState'
				// commands (see remote.ts). Skip local polling so the host-provided
				// data isn't overwritten with stale all-false values from the mock backend.
				if (this.remoteMode === 'client') return;
				if (this.dspStats && this.dspStats.squelchOpen) {
					const now = Date.now();
					const squelchStates = this.dspStats.squelchOpen.slice();
					for (let i = 0; i < squelchStates.length; i++) {
						if (squelchStates[i]) {
							this.vfoSquelchHangUntil[i] = now + 1000;
						} else if (this.vfoSquelchHangUntil[i] && now < this.vfoSquelchHangUntil[i]) {
							squelchStates[i] = true;
						}
					}
					this.vfoSquelchOpen = squelchStates;
					// ── Frequency activity tracker ──
					// Uses raw (pre-hang) states to count true squelch-open events
					const rawOpen = this.dspStats.squelchOpen;
					for (let i = 0; i < rawOpen.length; i++) {
						if (!this.vfoActivityStats[i]) {
							this.vfoActivityStats[i] = { count: 0, totalMs: 0, squelchOpenSince: null };
						}
						const stat = this.vfoActivityStats[i];
						// Only track activity for VFOs that are not muted
						if (rawOpen[i] && this.vfos[i]?.enabled) {
							if (stat.squelchOpenSince === null) {
								// Squelch just opened – start a new event
								stat.squelchOpenSince = now;
								stat.count++;
							}
						} else {
							if (stat.squelchOpenSince !== null) {
								// Squelch just closed – accumulate duration
								stat.totalMs += now - stat.squelchOpenSince;
								stat.squelchOpenSince = null;
							}
						}
					}
					// Bump reactive tick so sortedVfoActivity recomputes
					this.activityNow = now;
				}
			}
		}, 500);

		// Add additional VFOs beyond the first (which is created by default in the worker).
		// In client mode, notify the host via WebRTC instead of calling the mock backend.
		for (let i = 1; i < this.vfos.length; i++) {
			if (this.remoteMode === 'client' && this._webrtc) {
				this._webrtc.sendCommand({ type: 'addRemoteVfo' });
			} else {
				await this.backend.addVfo();
			}
		}

		// Enable first VFO by default only on initial start (not restart).
		// During a restart (e.g. center freq change), preserve existing mute states.
		if (!isRestart) {
			this.vfos[0].enabled = true;
		}
		this.toggleVfoCheckbox(0);

		// Send all VFO params to worker (or host in client mode)
		for (let i = 0; i < this.vfos.length; i++) {
			this.updateBackendVfoParams(i);
		}
	},
};
