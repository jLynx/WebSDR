import { defineConfig, type Plugin } from 'vite';
import path from 'path';
import fs from 'fs';

// Plugin to copy WASM files to dist on build and fix .ts → .js output filenames
function postBuildPlugin(): Plugin {
	return {
		name: 'post-build',
		closeBundle() {
			const distDir = path.resolve(__dirname, 'dist');

			// Copy WASM files
			const wasmSrc = path.resolve(__dirname, 'hackrf-web/pkg');
			const wasmDest = path.resolve(distDir, 'hackrf-web/pkg');
			if (fs.existsSync(wasmSrc)) {
				fs.mkdirSync(wasmDest, { recursive: true });
				for (const file of fs.readdirSync(wasmSrc)) {
					fs.copyFileSync(path.join(wasmSrc, file), path.join(wasmDest, file));
				}
			}

			// Rename .ts output files to .js and update references
			// (Vite preserves .ts extensions for worker chunks which causes MIME type issues)
			const assetsDir = path.join(distDir, 'assets');
			if (!fs.existsSync(assetsDir)) return;

			const renames: [string, string][] = [];
			for (const file of fs.readdirSync(assetsDir)) {
				if (file.endsWith('.ts')) {
					const newName = file.replace(/\.ts$/, '.js');
					renames.push([file, newName]);
					fs.renameSync(path.join(assetsDir, file), path.join(assetsDir, newName));
				}
			}

			if (renames.length === 0) return;

			// Update references in all JS files
			for (const file of fs.readdirSync(assetsDir)) {
				if (!file.endsWith('.js')) continue;
				const filePath = path.join(assetsDir, file);
				let content = fs.readFileSync(filePath, 'utf-8');
				let changed = false;
				for (const [oldName, newName] of renames) {
					if (content.includes(oldName)) {
						content = content.replaceAll(oldName, newName);
						changed = true;
					}
				}
				if (changed) {
					fs.writeFileSync(filePath, content);
				}
			}

			// Also update references in index.html
			const htmlPath = path.join(distDir, 'index.html');
			if (fs.existsSync(htmlPath)) {
				let html = fs.readFileSync(htmlPath, 'utf-8');
				let changed = false;
				for (const [oldName, newName] of renames) {
					if (html.includes(oldName)) {
						html = html.replaceAll(oldName, newName);
						changed = true;
					}
				}
				if (changed) {
					fs.writeFileSync(htmlPath, html);
				}
			}
		},
	};
}

export default defineConfig({
	root: 'src/client',
	build: {
		outDir: path.resolve(__dirname, 'dist'),
		emptyOutDir: true,
		rollupOptions: {
			external: [
				/\/hackrf-web\/pkg\//,
			],
		},
	},
	worker: {
		format: 'es',
		rollupOptions: {
			external: [
				/\/hackrf-web\/pkg\//,
			],
		},
	},
	plugins: [postBuildPlugin()],
	publicDir: path.resolve(__dirname, 'public'),
	define: {
		__VUE_OPTIONS_API__: true,
		__VUE_PROD_DEVTOOLS__: false,
		__VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
	},
	resolve: {
		alias: {
			'vue': 'vue/dist/vue.esm-bundler.js',
			'/hackrf-web/pkg': path.resolve(__dirname, 'hackrf-web/pkg'),
		},
	},
	server: {
		proxy: {
			'/api': 'http://localhost:8787',
			'/hf-proxy': 'http://localhost:8787',
		},
	},
});
