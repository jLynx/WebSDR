# 📻 [BrowSDR](https://browsdr.jlynx.net)

[![BrowSDR Live](https://img.shields.io/badge/Live-browsdr.jlynx.net-success?style=for-the-badge&logo=cloudflare)](https://browsdr.jlynx.net)
[![Rust](https://img.shields.io/badge/Rust-High%20Performance-orange?style=for-the-badge&logo=rust)](https://www.rust-lang.org/)
[![WebAssembly](https://img.shields.io/badge/Wasm-Powered-blue?style=for-the-badge&logo=webassembly)](https://webassembly.org/)

A blazing fast, next-generation browser-based Software Defined Radio (SDR) receiver for [HackRF](https://greatscottgadgets.com/hackrf/). Connect a HackRF device directly to your browser via WebUSB and tune into FM, AM, SSB, CW, and more — **no drivers, no native software, no hassle.**

---

## ✨ Stellar Features

Enjoy the power of a desktop SDR platform fully within your web browser. 

* **🎯 Multi-VFO Mastery**
  Tune into multiple frequencies simultaneously! Create an unlimited number of Virtual Frequency Oscillators (VFOs), each with independent demodulation, volume, squelch, and DSP settings. Listen to multiple broadcasts without dropping a single packet.
* **⚡ High-Speed Rust & WASM Architecture**
  Built for raw performance. FFT and DSP pipelines are written in **Rust** and compiled to **WebAssembly (WASM)**. Running inside Web Workers off the main thread ensures a crystal-clear, smooth UI and buttery 60 FPS performance, even with multiple active VFOs.
* **🎙️ Live Transcribe**
  Built-in AI-powered live transcription of demodulated audio right in your browser. 
* **📟 POCSAG Decoder**
  Instantly decode paging networks straight from the UI.
* **📊 Frequency Activity**
  Visually spot active signals and quickly jump to transmissions using the dynamic frequency activity scanner and interactive waterfall display.
* **🔖 Advanced Bookmarking System**
  Save, organize, and quickly recall your favorite frequencies. Group your bookmarks into custom categories to effortlessly manage airbands, ham frequencies, repeaters, or emergency services.
* **🌊 Real-time WebGL Waterfall & Spectrum**
  Monitor the entire RF band visually with an ultra-responsive, GPU-accelerated waterfall and spectrum analyzer.
* **📻 Wide Demodulation Support**
  Supports WFM, NFM, AM, USB, LSB, DSB, CW, and raw IQ modes.
* **📡 RDS Decoding on the Fly**
  Instantly decode station name, programme type, and radiotext on WFM signals.
* **🎛️ Full DSP Toolset**
  Control squelch, noise reduction, de-emphasis, and stereo output per VFO.

---

## 🚀 How It Works

1. **WebUSB** — Communicates directly with your HackRF device from Google Chrome or Edge.
2. **WebAssembly** — Signal processing (FFT, filtering, decimation, mixer, demodulation) is handled by [RustFFT](https://github.com/awelkie/RustFFT) and highly optimized Rust code compiled to WASM.
3. **Web Workers** — Multi-threaded DSP keeps the event loop entirely free of blocking tasks.
4. **WebGL** — Hardware-accelerated FFT rendering.
5. **Vue 3** — A sleek, reactive UI powering complex per-VFO controls.
6. **Cloudflare Workers** — Fast edge-deployed static assets.

*(Note: WebUSB requires a secure context — HTTPS or `localhost`)*

---

## 🛠️ Prerequisites

| Tool | Purpose | Install |
|------|---------|---------|
| [Node.js](https://nodejs.org/) | Build & dev server | Download from website |
| [Rust](https://rustup.rs/) | Compile WASM module | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| `wasm32-unknown-unknown` target | Rust → WASM | `rustup target add wasm32-unknown-unknown` |
| [wasm-pack](https://rustwasm.github.io/wasm-pack/) | Build & package WASM | `cargo install wasm-pack` |
| [cargo-make](https://github.com/sagiegurari/cargo-make) | Task runner for Rust builds | `cargo install --force cargo-make` |
| A WebUSB-capable browser | Run the app (e.g., Google Chrome) | — |

---

## ⚙️ Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Build the WASM module (first time or after Rust changes)
cd hackrf-web && cargo make build && cd ..

# 3. Start the local dev server
npm run dev
```

Then open **[http://localhost:8787](http://localhost:8787)** in Google Chrome or any WebUSB-supported browser.

---

## 💻 Build Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Build client assets and start local dev server (http://localhost:8787) |
| `npm run build` | Build client assets into `dist/` |
| `npm run deploy` | Build and deploy to Cloudflare Workers |
| `npm run test` | Run tests with Vitest |

### Building the WASM Module

The Rust/WASM module must be built separately (requires Rust toolchain):

```bash
# From the project root
cd hackrf-web
cargo make build          # Build for web (output: hackrf-web/pkg/)
cargo make build-node     # Build for Node.js (output: hackrf-web/node/)
```

> **Note:** The WASM build outputs in `hackrf-web/pkg/` are committed to the repo, so `npm run deploy` works seamlessly even without Rust installed on the CI/deployment machine.

---

## 🎧 Running the App

1. Connect your HackRF to a USB port.
2. Open the application and click **Connect Device**.
3. Select your HackRF from the browser's USB device prompt.
4. Set your desired **Center Frequency** and hit **Play**.
5. Click anywhere on the spectrum or waterfall to instantly tune a new VFO, or manually add as many VFOs as you want!
6. Customize the demodulation mode (WFM, NFM, AM, USB, etc.) and DSP settings for each VFO.
7. Adjust gains (LNA, VGA, AMP) for optimal signal reception.

---

## 🧪 Testing

```bash
# Worker tests (Vitest + Cloudflare Workers pool)
npm run test

# Rust/WASM tests
cd hackrf-web
cargo make test
```

---

## 📁 Project Structure

```
.
├── src/
│   ├── index.js            # Cloudflare Worker entry (edge serving)
│   └── client/             # Frontend source (Vue 3, HTML, CSS, JS)
│       ├── index.html      # Main app entry point
│       ├── style.css       # UI styles
│       ├── script.js       # Core Vue 3 application logic
│       ├── hackrf.js       # WebUSB HackRF driver
│       ├── worker.js       # Multi-threaded DSP Web Worker
│       └── utils.js        # WebGL / Canvas Waterfall renderers
├── dist/                   # Production build output
├── hackrf-web/             # Rust WASM high-performance DSP module
│   ├── Cargo.toml
│   ├── Makefile.toml       # WASM build & test task configurations
│   ├── src/lib.rs          # Core DSP implementation in Rust
│   ├── pkg/                # wasm-pack web output (committed)
│   └── node/               # wasm-pack Node.js output (committed)
├── test/                   # Vitest unit tests
├── build.js                # Build script for client + WASM bundles
├── wrangler.jsonc          # Cloudflare Worker configuration
└── COPYING                 # License
```

---

## 📜 License

Licensed under the **AGPL-3.0** — see [LICENSE](LICENSE) for details.
