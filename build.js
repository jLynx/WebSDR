/**
 * Build script — assembles the dist/ folder from source files.
 *
 * Copies:
 *   src/client/*          → dist/         (HTML, CSS, JS)
 *   node_modules vendors  → dist/lib/     (vue, comlink browser bundles)
 *   hackrf-web/pkg/       → dist/hackrf-web/pkg/  (WASM build outputs)
 *
 * Run: node build.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src', 'client');
const DIST = path.join(ROOT, 'dist');
const LIB = path.join(DIST, 'lib');
const WASM_SRC = path.join(ROOT, 'hackrf-web', 'pkg');
const WASM_DEST = path.join(DIST, 'hackrf-web', 'pkg');

// --- Helper: recursive copy directory ---
function copyDirSync(src, dest) {
	fs.mkdirSync(dest, { recursive: true });
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		const srcPath = path.join(src, entry.name);
		const destPath = path.join(dest, entry.name);
		if (entry.isDirectory()) {
			copyDirSync(srcPath, destPath);
		} else {
			fs.copyFileSync(srcPath, destPath);
		}
	}
}

// --- Clean dist/ ---
if (fs.existsSync(DIST)) {
	fs.rmSync(DIST, { recursive: true, force: true });
}
fs.mkdirSync(DIST, { recursive: true });

// --- Copy src/client/ → dist/ ---
const srcFiles = fs.readdirSync(SRC);
for (const file of srcFiles) {
	fs.copyFileSync(path.join(SRC, file), path.join(DIST, file));
}
console.log(`Copied ${srcFiles.length} client files → dist/`);

// --- Copy vendor browser bundles → dist/lib/ ---
fs.mkdirSync(LIB, { recursive: true });

const vendorFiles = [
	{ src: 'node_modules/vue/dist/vue.esm-browser.js', dest: 'vue.esm-browser.js' },
	{ src: 'node_modules/comlink/dist/esm/comlink.mjs', dest: 'comlink.mjs' },
];

for (const v of vendorFiles) {
	fs.copyFileSync(path.join(ROOT, v.src), path.join(LIB, v.dest));
}
console.log(`Copied ${vendorFiles.length} vendor bundles → dist/lib/`);

// --- Copy hackrf-web/pkg/ → dist/hackrf-web/pkg/ ---
if (fs.existsSync(WASM_SRC)) {
	copyDirSync(WASM_SRC, WASM_DEST);
	const wasmFiles = fs.readdirSync(WASM_SRC).length;
	console.log(`Copied ${wasmFiles} WASM files → dist/hackrf-web/pkg/`);
} else {
	console.warn('Warning: hackrf-web/pkg/ not found — skipping WASM copy');
}
