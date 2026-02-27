/**
 * SDR WebViewer - Cloudflare Worker
 *
 * Serves the static SDR WebViewer frontend from the public/ directory.
 * All static assets (HTML, JS, CSS, WASM) are served via the ASSETS binding.
 *
 * - Run `npm run dev` to start a development server on http://localhost:8787/
 * - Run `npm run deploy` to publish to Cloudflare
 */

export default {
	async fetch(request, env, ctx) {
		// The ASSETS binding automatically serves static files from ./public/
		// This handler is called for requests that don't match a static asset
		return env.ASSETS.fetch(request);
	},
};
