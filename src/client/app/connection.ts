import type { AppInstance } from './types';
import * as Comlink from 'comlink';
import { getAllCatalogFilters, lookupDevice } from '../device-catalog';

export const connectionMethods = {
	async connect(this: AppInstance) {
		if (!this.backend) return;
		this._initAudioCtx(); // create AudioContext within user gesture

		// Get already-paired USB devices and filter to recognized SDR devices
		const allPaired = await navigator.usb.getDevices();
		type PairedSdr = { device: USBDevice; driverName: string; productName: string };
		const sdrDevices: PairedSdr[] = [];
		for (const device of allPaired) {
			const driver = lookupDevice(device);
			if (driver) {
				sdrDevices.push({ device, driverName: driver.name, productName: device.productName || '' });
			}
		}

		if (sdrDevices.length === 0) {
			// No paired SDR devices — go straight to browser USB picker
			await this.pairNewDevice();
		} else {
			// Show our custom picker dialog
			this.devicePicker.devices = sdrDevices;
			this.devicePicker.show = true;
		}
	},

	async pairNewDevice(this: AppInstance) {
		this.devicePicker.show = false;
		const device = await navigator.usb.requestDevice({
			filters: getAllCatalogFilters()
		}).catch(() => null);
		if (!device) return;
		await this.connectToDevice(device);
	},

	async connectToDevice(this: AppInstance, device: USBDevice) {
		this.devicePicker.show = false;
		this.showMsg("Connecting...");
		try {
			const ok = await this.backend.open({
				vendorId: device.vendorId,
				productId: device.productId,
				serialNumber: device.serialNumber
			});
			if (ok) {
				this.connected = true;
				const info = await this.backend.info();
				this.info.boardName = info.name;

				// Populate device capabilities for dynamic UI
				const caps = await this.backend.getDeviceCapabilities();
				this.deviceCapabilities = caps;
				if (caps) {
					// Initialize gains from device defaults
					const newGains: Record<string, number> = {};
					for (const gc of caps.gainControls) {
						newGains[gc.name] = gc.default;
					}
					this.gains = newGains;

					// If current sample rate isn't in the device's supported list, pick the closest
					if (!caps.sampleRates.includes(this.radio.sampleRate)) {
						this.radio.sampleRate = caps.sampleRates[caps.sampleRates.length - 1];
					}
				}

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
				const info = await this.backend.info();
				this.info.boardName = info.name;

				const caps = await this.backend.getDeviceCapabilities();
				this.deviceCapabilities = caps;
				if (caps) {
					const newGains: Record<string, number> = {};
					for (const gc of caps.gainControls) {
						newGains[gc.name] = gc.default;
					}
					this.gains = newGains;
				}

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
			this.deviceCapabilities = null;
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
		this.deviceCapabilities = null;
		this.showMsg("Disconnected");
	},
	_releaseWakeLock(this: AppInstance) {
		if (this._wakeLock) {
			this._wakeLock.release().catch(() => {});
			this._wakeLock = null;
		}
	},
	async _acquireWakeLock(this: AppInstance) {
		if ('wakeLock' in navigator) {
			try {
				this._wakeLock = await (navigator as any).wakeLock.request('screen');
			} catch (_) {}
		}
	},
	async togglePlay(this: AppInstance, isRestart = false) {
		if (this.running) {
			await this.backend.stopRx();
			this.running = false;
			if (this._statsTimer) { clearInterval(this._statsTimer); this._statsTimer = null; }
			this.dspStats = null;
			if (this._mediaAudioEl) {
				this._mediaAudioEl.pause();
				this._mediaAudioEl.srcObject = null;
				this._mediaAudioEl.remove();
				this._mediaAudioEl = null;
			}
			if (this.audioCtx) {
				try { await this.audioCtx.close(); } catch (_: any) { }
				this.audioCtx = null;
				this.gainNode = null;
			}
			this._releaseWakeLock();
			if ('mediaSession' in navigator) {
				navigator.mediaSession.playbackState = 'paused';
				navigator.mediaSession.setActionHandler('play', null);
				navigator.mediaSession.setActionHandler('pause', null);
				navigator.mediaSession.setActionHandler('stop', null);
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
			gains: { ...this.gains },
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

		await this._acquireWakeLock();
		if ('mediaSession' in navigator) {
			navigator.mediaSession.metadata = new MediaMetadata({ title: 'WebSDR', artist: 'Receiving' });
			navigator.mediaSession.playbackState = 'playing';
			// Action handlers are REQUIRED for Chrome on Android to show the media notification.
			// Without at least play+pause registered, the notification never appears.
			navigator.mediaSession.setActionHandler('play', () => {
				if (this._mediaAudioEl) this._mediaAudioEl.play().catch(() => {});
				if (this.audioCtx?.state === 'suspended') this.audioCtx.resume().catch(() => {});
				navigator.mediaSession.playbackState = 'playing';
			});
			navigator.mediaSession.setActionHandler('pause', () => {
				// Don't actually pause — just keep showing the notification (user can stop from the UI)
				navigator.mediaSession.playbackState = 'playing';
			});
			navigator.mediaSession.setActionHandler('stop', () => { this.togglePlay(); });
		}

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
