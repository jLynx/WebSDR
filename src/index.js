/**
 * BrowSDR - Cloudflare Worker
 *
 * Serves the static BrowSDR frontend from the public/ directory.
 * All static assets (HTML, JS, CSS, WASM) are served via the ASSETS binding.
 *
 * - Run `npm run dev` to start a development server on http://localhost:8787/
 * - Run `npm run deploy` to publish to Cloudflare
 */

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		// Return the caller's country code (from Cloudflare headers)
		if (url.pathname === '/api/geo') {
			return new Response(
				JSON.stringify({ country: request.headers.get('CF-IPCountry') || 'XX' }),
				{ headers: { 'Content-Type': 'application/json' } }
			);
		}

		// Generate short-lived TURN credentials via Cloudflare Calls
		// Requires TURN_KEY_ID and TURN_KEY_API_TOKEN secrets set on the Worker
		if (url.pathname === '/api/turn') {
			if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
				return new Response(
					JSON.stringify({ iceServers: [] }),
					{ headers: { 'Content-Type': 'application/json' } }
				);
			}
			try {
				const turnResp = await fetch(
					`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
					{
						method: 'POST',
						headers: {
							'Authorization': `Bearer ${env.TURN_KEY_API_TOKEN}`,
							'Content-Type': 'application/json',
						},
						body: JSON.stringify({ ttl: 14400 }), // 4 hours
					}
				);
				const data = await turnResp.json();
				return new Response(
					JSON.stringify(data),
					{ headers: { 'Content-Type': 'application/json' } }
				);
			} catch (err) {
				return new Response(
					JSON.stringify({ iceServers: [], error: err.message }),
					{ status: 500, headers: { 'Content-Type': 'application/json' } }
				);
			}
		}

		// Proxy HuggingFace model downloads to avoid CORS issues
		if (url.pathname.startsWith('/hf-proxy/')) {
			const hfPath = url.pathname.slice('/hf-proxy/'.length) + url.search;
			const hfUrl = `https://huggingface.co/${hfPath}`;

			const hfResponse = await fetch(hfUrl, {
				method: request.method,
				headers: {
					'User-Agent': 'BrowSDR-Worker',
				},
			});

			const response = new Response(hfResponse.body, {
				status: hfResponse.status,
				headers: hfResponse.headers,
			});
			response.headers.set('Access-Control-Allow-Origin', '*');
			response.headers.delete('Set-Cookie');
			return response;
		}

		// The ASSETS binding automatically serves static files from ./public/
		// This handler is called for requests that don't match a static asset
		return env.ASSETS.fetch(request);
	},
};
