import { defineConfig, build, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';
import fs from 'fs';

// Plugin that runs after the main build to:
// 1. Bundle the dsp-worker properly (Vite doesn't bundle nested workers)
// 2. Copy WASM files to dist
// 3. Fix .ts → .js extensions in output filenames and references
function postBuildPlugin(): Plugin {
	return {
		name: 'post-build',
		async closeBundle() {
			const distDir = path.resolve(__dirname, 'dist');
			const assetsDir = path.join(distDir, 'assets');

			// Track all .ts → .js renames for reference updates
			const renames = new Map<string, string>();

			// --- Bundle nested workers (Vite doesn't bundle workers spawned from workers) ---
			for (const file of fs.readdirSync(assetsDir)) {
				const filePath = path.join(assetsDir, file);
				if (!file.endsWith('.ts') && !file.endsWith('.js')) continue;

				const content = fs.readFileSync(filePath, 'utf-8');
				if (content.includes("from './") || content.includes("from '../")) {
					console.log(`[post-build] Bundling nested worker: ${file}`);
					const jsName = file.replace(/\.ts$/, '.js');
					renames.set(file, jsName);

					await build({
						configFile: false,
						root: path.resolve(__dirname, 'src/client'),
						build: {
							outDir: assetsDir,
							emptyOutDir: false,
							lib: {
								entry: path.resolve(__dirname, 'src/client/dsp-worker.ts'),
								formats: ['es'],
								fileName: () => jsName,
							},
							rollupOptions: {
								external: [/\/hackrf-web\/pkg\//, /\/lib\/mbelib\//],
							},
							minify: true,
						},
						resolve: {
							alias: {
								'/hackrf-web/pkg': path.resolve(__dirname, 'hackrf-web/pkg'),
							},
						},
						logLevel: 'warn',
					});

					// Remove the unbundled original .ts if it differs from the output
					if (file !== jsName && fs.existsSync(filePath)) {
						fs.unlinkSync(filePath);
					}
				}
			}

			// --- Rename any remaining .ts output files to .js ---
			for (const file of fs.readdirSync(assetsDir)) {
				if (file.endsWith('.ts')) {
					const jsName = file.replace(/\.ts$/, '.js');
					renames.set(file, jsName);
					fs.renameSync(path.join(assetsDir, file), path.join(assetsDir, jsName));
				}
			}

			// --- Update all .ts → .js references in output files ---
			if (renames.size > 0) {
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
					if (changed) fs.writeFileSync(filePath, content);
				}

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
					if (changed) fs.writeFileSync(htmlPath, html);
				}
			}

			// --- Bundle whisper-worker (loaded via plain URL, not Vite worker syntax) ---
			const whisperEntry = path.resolve(__dirname, 'src/client/whisper-worker.ts');
			if (fs.existsSync(whisperEntry)) {
				console.log('[post-build] Bundling whisper-worker');
				await build({
					configFile: false,
					root: path.resolve(__dirname, 'src/client'),
					build: {
						outDir: distDir,
						emptyOutDir: false,
						lib: {
							entry: whisperEntry,
							formats: ['es'],
							fileName: () => 'whisper-worker.js',
						},
						rollupOptions: {
							external: [
								/^https?:\/\//,  // CDN imports stay external
							],
						},
						minify: true,
					},
					logLevel: 'warn',
				});
			}

			// --- Copy WASM files ---
			const wasmSrc = path.resolve(__dirname, 'hackrf-web/pkg');
			const wasmDest = path.resolve(distDir, 'hackrf-web/pkg');
			if (fs.existsSync(wasmSrc)) {
				fs.mkdirSync(wasmDest, { recursive: true });
				for (const file of fs.readdirSync(wasmSrc)) {
					fs.copyFileSync(path.join(wasmSrc, file), path.join(wasmDest, file));
				}
			}

			// --- Copy mbelib WASM files ---
			const mbelibSrc = path.resolve(__dirname, 'public/lib/mbelib');
			const mbelibDest = path.resolve(distDir, 'lib/mbelib');
			if (fs.existsSync(mbelibSrc)) {
				fs.mkdirSync(mbelibDest, { recursive: true });
				for (const file of fs.readdirSync(mbelibSrc)) {
					fs.copyFileSync(path.join(mbelibSrc, file), path.join(mbelibDest, file));
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
				/\/lib\/mbelib\//,
			],
		},
	},
	worker: {
		format: 'es',
		rollupOptions: {
			external: [
				/\/hackrf-web\/pkg\//,
				/\/lib\/mbelib\//,
			],
		},
	},
	plugins: [
		VitePWA({
			registerType: 'autoUpdate',
			injectRegister: 'script',
			workbox: {
				skipWaiting: true,
				clientsClaim: true,
				globPatterns: ['**/*.{js,css,html,wasm}'],
				navigateFallback: null,
				runtimeCaching: [
					{
						// API routes: network-first (only works online)
						urlPattern: /^.*\/api\/.*/i,
						handler: 'NetworkFirst',
						options: {
							cacheName: 'api-cache',
							networkTimeoutSeconds: 5,
							expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 },
						},
					},
				],
			},
			manifest: {
				name: 'BrowSDR – Web SDR Receiver',
				short_name: 'BrowSDR',
				description: 'A blazing-fast browser-based Software Defined Radio receiver.',
				theme_color: '#0f0f1a',
				background_color: '#0f0f1a',
				display: 'standalone',
				start_url: '/',
				icons: [
					{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
					{ src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
				],
			},
		}),
		postBuildPlugin(),
	],
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
