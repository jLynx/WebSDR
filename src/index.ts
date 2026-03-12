/**
 * BrowSDR - Cloudflare Worker
 *
 * Serves the static BrowSDR frontend from the public/ directory.
 * All static assets (HTML, JS, CSS, WASM) are served via the ASSETS binding.
 *
 * - Run `npm run dev` to start a development server on http://localhost:8787/
 * - Run `npm run deploy` to publish to Cloudflare
 */

interface Env {
	EXPRESS_TURN_URL: string;
	EXPRESS_TURN_USER: string;
	EXPRESS_TURN_PASS: string;
	TURN_KEY_ID: string;
	TURN_KEY_API_TOKEN: string;
	ASSETS: {
		fetch(request: Request): Promise<Response>;
	};
}

interface IceServerEntry {
	urls: string[];
	username?: string;
	credential?: string;
}

interface TurnApiResponse {
	iceServers?: IceServerEntry[];
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Cross-origin isolation headers (required for SharedArrayBuffer)
		const coopHeaders = {
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp',
		};

		// Return the caller's country code (from Cloudflare headers)
		if (url.pathname === '/api/geo') {
			return new Response(
				JSON.stringify({ country: request.headers.get('CF-IPCountry') || 'XX' }),
				{ headers: { 'Content-Type': 'application/json', ...coopHeaders } }
			);
		}

		// Return TURN/STUN ICE servers for WebRTC connectivity.
		// Uses ExpressTURN (free) as primary, Cloudflare TURN as fallback.
		if (url.pathname === '/api/turn') {
			const iceServers: IceServerEntry[] = [];

			// Primary: ExpressTURN (free, static credentials)
			if (env.EXPRESS_TURN_URL && env.EXPRESS_TURN_USER && env.EXPRESS_TURN_PASS) {
				iceServers.push({
					urls: [`turn:${env.EXPRESS_TURN_URL}`, `stun:${env.EXPRESS_TURN_URL}`],
					username: env.EXPRESS_TURN_USER,
					credential: env.EXPRESS_TURN_PASS,
				});
			}

			// Fallback: Cloudflare TURN (paid beyond 1TB free tier)
			if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
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
					const data: TurnApiResponse = await turnResp.json();
					if (data.iceServers) iceServers.push(...data.iceServers);
				} catch (_) {}
			}

			return new Response(
				JSON.stringify({ iceServers }),
				{ headers: { 'Content-Type': 'application/json', ...coopHeaders } }
			);
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

		// Serve static assets with cross-origin isolation headers
		const response = await env.ASSETS.fetch(request);
		const newResponse = new Response(response.body, response);
		newResponse.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
		newResponse.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
		return newResponse;
	},
};
