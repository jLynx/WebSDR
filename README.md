# Web SDR

A browser-based spectrum analyzer for [HackRF](https://greatscottgadgets.com/hackrf/), built with WebUSB, WebAssembly (Rust), and WebGL.

<img src="./doc/screenshot.avif">

## How It Works

1. **WebUSB** — communicates directly with the HackRF device from the browser.
2. **WebAssembly** — runs FFT in Rust (via [RustFFT](https://github.com/awelkie/RustFFT)), compiled to WASM for near-native performance.
3. **WebGL** — renders a real-time waterfall display.

---

## Prerequisites

| Tool | Purpose | Install |
|------|---------|---------|
| [Rust](https://rustup.rs/) | Compile WASM module | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| `wasm32-unknown-unknown` target | Rust → WASM compilation | `rustup target add wasm32-unknown-unknown` |
| [wasm-pack](https://rustwasm.github.io/wasm-pack/) | Build & package WASM | `cargo install wasm-pack` |
| [cargo-make](https://github.com/sagiegurari/cargo-make) | Task runner for Rust builds | `cargo install --force cargo-make` |
| [Node.js](https://nodejs.org/) (optional) | Install JS dependencies & run JS-binding tests | Download from website |
| A WebUSB-capable browser | Run the app (e.g. Google Chrome) | — |

---

## Building

### 1. Build the WASM Module (Rust)

From the **project root**:

```bash
cargo make build
```

This runs `wasm-pack build --target web --out-dir pkg` inside the `hackrf-web/` directory, producing the WASM binary and JS glue code in `hackrf-web/pkg/`.

You can also build directly from the `hackrf-web/` folder:

```bash
cd hackrf-web
cargo make build
```

#### Build for Node.js (optional)

If you need a Node.js-compatible build (e.g. for testing):

```bash
cd hackrf-web
cargo make build-node
```

This outputs to `hackrf-web/node/`.

### 2. Install JavaScript Dependencies

```bash
npm install
```

This installs [Vue 3](https://vuejs.org/) and [Comlink](https://github.com/GoogleChromeLabs/comlink) from `package.json`.

---

## Running

### Serving Locally

The app is a static site — serve the project root with any HTTP server. For example:

```bash
# Using Python
python -m http.server 8080

# Or using Node.js
npx http-server . -p 8080
```

> **Note:** WebUSB requires a **secure context** (HTTPS or `localhost`). Serving from `localhost` works for development.

Then open [http://localhost:8080](http://localhost:8080) in Google Chrome.

### Using the App

1. Connect your HackRF to a USB port.
2. Click **Connect Device** and select the HackRF from the browser prompt.
3. Set the frequency range for analysis.
4. Click the **Play** button to start sweeping.
5. Adjust gains (LNA, VGA, AMP) as needed.

---

## Testing

Run the full test suite (Rust unit tests, WASM tests, and JS binding tests) from the project root:

```bash
cargo make test
```

This executes three test tasks inside `hackrf-web/`:

| Task | Command | Description |
|------|---------|-------------|
| `test-cargo` | `cargo test` | Rust unit tests |
| `test-wasm` | `wasm-pack test --node` | WASM-bindgen tests in Node.js |
| `test-js` | `node test-js-binding.mjs` | JS binding integration tests (builds Node target first) |

You can run them individually from `hackrf-web/`:

```bash
cd hackrf-web
cargo make test-cargo
cargo make test-wasm
cargo make test-js
```

---

## Project Structure

```
.
├── index.html          # Main app entry point
├── script.js           # Vue 3 application logic
├── style.css           # UI styles
├── hackrf.js           # WebUSB HackRF driver
├── worker.js           # Web Worker for FFT processing
├── utils.js            # Utility functions
├── package.json        # JS dependencies (Vue, Comlink)
├── Makefile.toml       # Root cargo-make tasks (delegates to hackrf-web/)
└── hackrf-web/         # Rust WASM module
    ├── Cargo.toml      # Rust dependencies (wasm-bindgen, rustfft)
    ├── Makefile.toml   # WASM build & test tasks
    ├── src/
    │   └── lib.rs      # FFT implementation in Rust
    ├── pkg/            # wasm-pack output (web target)
    └── node/           # wasm-pack output (Node.js target)
```

---

## License

GPL-2.0 — see [COPYING](COPYING) for details.
