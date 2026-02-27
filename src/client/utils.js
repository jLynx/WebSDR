/*
Copyright (c) 2026, jLynx <https://github.com/jLynx>
Copyright (c) 2019, cho45 <cho45@lowreal.net>

All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
	Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
	Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the
	documentation and/or other materials provided with the distribution.
	Neither the name of Great Scott Gadgets nor the names of its contributors may be used to endorse or promote products derived from this software
	without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

const DEFAULT_COLOR_MAP = [
	[0x00, 0x00, 0x20],
	[0x00, 0x00, 0x30],
	[0x00, 0x00, 0x50],
	[0x00, 0x00, 0x91],
	[0x1E, 0x90, 0xFF],
	[0xFF, 0xFF, 0xFF],
	[0xFF, 0xFF, 0x00],
	[0xFE, 0x6D, 0x16],
	[0xFF, 0x00, 0x00],
	[0xC6, 0x00, 0x00],
	[0x9F, 0x00, 0x00],
	[0x75, 0x00, 0x00],
	[0x4A, 0x00, 0x00]
];

export function convertDecibelToRGB(dB, minDB = -70, maxDB = 0) {
	// Map dB into a 0.0 to 1.0 range
	let p = (dB - minDB) / (maxDB - minDB);
	p = Math.max(0.0, Math.min(1.0, p));

	const colorCount = DEFAULT_COLOR_MAP.length;
	const indexFloat = p * (colorCount - 1);
	const indexBase = Math.floor(indexFloat);
	const indexNext = Math.min(colorCount - 1, indexBase + 1);
	const weightNext = indexFloat - indexBase;
	const weightBase = 1.0 - weightNext;

	const c1 = DEFAULT_COLOR_MAP[indexBase];
	const c2 = DEFAULT_COLOR_MAP[indexNext];

	const r = Math.round(c1[0] * weightBase + c2[0] * weightNext);
	const g = Math.round(c1[1] * weightBase + c2[1] * weightNext);
	const b = Math.round(c1[2] * weightBase + c2[2] * weightNext);

	return { r, g, b };
}


/**
 * Fast waterfall display using WebGL
 *
 * [Design Intent]
 * By cycling two textures, we avoid shifting the entire texture (full transfer every frame).
 * If we tried to shift with a single texture, bandSize × historySize bytes would need to be
 * transferred every frame; with this approach only bandSize × 1 row is transferred at a time.
 *
 * [Texture Roles]
 * - textures[0]: The current write target (new data is written row by row starting at _current)
 * - textures[1]: The previously used texture (holds the remaining old data for display)
 *
 * [Shader Logic]
 * Two textures are displayed seamlessly, split at uOffsetY (the current write position):
 * - Upper half (screen.y >= uOffsetY): shows textures[1] (old data scrolling up from the bottom)
 * - Lower half (screen.y < uOffsetY):  shows textures[0] (new data accumulating from the bottom)
 *
 * [Rotation Timing]
 * When _current reaches historySize, textures[0] is "full", so:
 * 1. Rotate the textures array ([0,1] → [1,0]) — the full texture becomes textures[1]
 * 2. Reset _current to 0
 * 3. Resume writing from the start of the new textures[0]
 */
export class WaterfallGL {
	constructor(canvas, bandSize, historySize) {
		this.bandSize = bandSize;
		this.historySize = historySize;
		this.canvas = canvas;
		this.data = new Uint8Array(this.bandSize * 4);
		this.minDB = -70;
		this.maxDB = 0;
		this.initWebGL();
	}

	setRange(minDB, maxDB) {
		this.minDB = minDB;
		this.maxDB = maxDB;
	}

	initWebGL() {
		this._current = 0;

		this.canvas.width = this.bandSize;
		this.canvas.height = this.historySize;

		try {
			this.gl = this.canvas.getContext("webgl") || this.canvas.getContext("experimental-webgl");
		} catch (e) {
		}

		if (!this.gl) {
			alert("Unable to initialize WebGL. Your browser may not support it.");
			return;
		}

		const gl = this.gl;

		gl.disable(gl.DEPTH_TEST);
		gl.disable(gl.CULL_FACE);
		gl.disable(gl.BLEND);

		gl.viewport(0, 0, this.canvas.width, this.canvas.height);
		gl.clearColor(0.0, 0.0, 0.0, 1.0);
		gl.clear(gl.COLOR_BUFFER_BIT);

		const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
		gl.shaderSource(fragmentShader, `
			// uTexture0: The current write texture (new data)
			// uTexture1: The previous texture (remaining old data)
			// uViewCoords: Viewport size (width, height)
			// uOffsetY: Current write position (0 to historySize-1)
			uniform sampler2D uTexture0;
			uniform sampler2D uTexture1;
			uniform highp vec2 uViewCoords;
			uniform highp float uOffsetY;
			uniform highp float uZoomOffset;
			uniform highp float uZoomScale;

			void main(void) {
				highp vec4 screen = gl_FragCoord;
				
				// Apply horizontal zoom
				highp float normalizedX = screen.x / uViewCoords.x;
				highp float zoomedX = (normalizedX / uZoomScale) + uZoomOffset;
				
				if (zoomedX < 0.0 || zoomedX > 1.0) {
					gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
					return;
				}
				
				// Re-map actual screen X coordinate back for texture lookup
				screen.x = zoomedX * uViewCoords.x;

				// Flow direction: Newest at the top, Oldest at bottom
				// gl_FragCoord.y goes from 0 (bottom) to uViewCoords.y (top)
				highp float sy = screen.y;
				highp float splitY = uViewCoords.y - uOffsetY;
				
				if (sy < splitY) {
					// Bottom part: oldest data from uTexture1
					highp float ty = uOffsetY + sy;
					gl_FragColor = texture2D(uTexture1, vec2(screen.x / uViewCoords.x, ty / uViewCoords.y));
				} else {
					// Top part: newer data from uTexture0
					highp float ty = sy - splitY;
					gl_FragColor = texture2D(uTexture0, vec2(screen.x / uViewCoords.x, ty / uViewCoords.y));
				}
			}
		`);
		gl.compileShader(fragmentShader);
		if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
			alert("An error occurred compiling the shaders: " + gl.getShaderInfoLog(fragmentShader));
			return;
		}

		const vertexShader = gl.createShader(gl.VERTEX_SHADER);
		gl.shaderSource(vertexShader, `
			attribute vec3 aVertexPosition;

			void main(void) {
				gl_Position = vec4(aVertexPosition, 1.0);
			}
		`);
		gl.compileShader(vertexShader);
		if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) {
			alert("An error occurred compiling the shaders: " + gl.getShaderInfoLog(vertexShader));
			return;
		}

		this.shaderProgram = gl.createProgram();
		gl.attachShader(this.shaderProgram, vertexShader);
		gl.attachShader(this.shaderProgram, fragmentShader);
		gl.linkProgram(this.shaderProgram);

		if (!gl.getProgramParameter(this.shaderProgram, gl.LINK_STATUS)) {
			alert("Unable to initialize the shader program.");
		}

		gl.useProgram(this.shaderProgram);

		this.vertexPositionAttribute = gl.getAttribLocation(this.shaderProgram, "aVertexPosition");
		gl.enableVertexAttribArray(this.vertexPositionAttribute);

		this.vertices1 = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, this.vertices1);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
			1.0, 1.0, 0.0,
			-1.0, 1.0, 0.0,
			1.0, -1.0, 0.0,
			-1.0, -1.0, 0.0
		]), gl.STATIC_DRAW);

		// texture sources
		this.textures = [gl.createTexture(), gl.createTexture()];

		// Initialize texture rounded up to the nearest power of two
		// (Workaround for older WebGL constraints; ensures compatibility with non-NPOT environments)
		this.canvas.width = Math.pow(2, Math.ceil(Math.log2(this.bandSize)));
		console.log({ glInit: this.canvas.width });
		this.canvas.height = this.historySize;
		console.log(this.canvas.width, this.bandSize);

		for (var i = 0, it; (it = this.textures[i]); i++) {
			gl.bindTexture(gl.TEXTURE_2D, it);
			gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
			gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
			gl.bindTexture(gl.TEXTURE_2D, null);
		}

		gl.uniform2f(gl.getUniformLocation(this.shaderProgram, 'uViewCoords'), this.canvas.width, this.canvas.height);

		// Initial zoom uniforms
		this.uZoomOffsetLocation = gl.getUniformLocation(this.shaderProgram, 'uZoomOffset');
		this.uZoomScaleLocation = gl.getUniformLocation(this.shaderProgram, 'uZoomScale');
		gl.uniform1f(this.uZoomOffsetLocation, 0.0);
		gl.uniform1f(this.uZoomScaleLocation, 1.0);

		gl.bindBuffer(gl.ARRAY_BUFFER, this.vertices1);
		gl.vertexAttribPointer(this.vertexPositionAttribute, 3, gl.FLOAT, false, 0, 0);

		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, this.textures[1]);
		gl.uniform1i(gl.getUniformLocation(this.shaderProgram, "uTexture1"), 1);

		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.textures[0]);
		gl.uniform1i(gl.getUniformLocation(this.shaderProgram, "uTexture0"), 0);

		gl.bindTexture(gl.TEXTURE_2D, this.textures[0]);

		this.canvas.width = this.bandSize;
		this.canvas.height = this.historySize;

		this.render();
	}

	setZoom(offset, scale) {
		const gl = this.gl;
		gl.uniform1f(this.uZoomOffsetLocation, offset);
		gl.uniform1f(this.uZoomScaleLocation, scale);
	}

	render() {
		const gl = this.gl;

		gl.uniform1f(gl.getUniformLocation(this.shaderProgram, 'uOffsetY'), this._current);

		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}

	renderLine(array) {
		const gl = this.gl;
		const data = this.data;

		for (let i = 0, len = this.bandSize; i < len; i++) {
			const n = i * 4;
			const rgb = convertDecibelToRGB(array[i], this.minDB, this.maxDB);

			data[n + 0] = rgb.r;
			data[n + 1] = rgb.g;
			data[n + 2] = rgb.b;
			data[n + 3] = 255;
		}

		const xoffset = 0, yoffset = this._current, width = this.bandSize, height = 1;
		gl.texSubImage2D(gl.TEXTURE_2D, 0, xoffset, yoffset, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);

		this._current++;

		if (this._current >= this.historySize) {
			// When the texture is full, rotate it
			// [A, B] → [B, A]: A (the full texture) becomes the "old data" texture
			this._current = 0;
			this.textures.push(this.textures.shift());

			gl.activeTexture(gl.TEXTURE1);
			gl.bindTexture(gl.TEXTURE_2D, this.textures[1]);
			gl.uniform1i(gl.getUniformLocation(this.shaderProgram, "uTexture1"), 1);

			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, this.textures[0]);
			gl.uniform1i(gl.getUniformLocation(this.shaderProgram, "uTexture0"), 0);

		}

		this.render();
	}
}

export class Waterfall {
	constructor(canvas, bandSize, historySize) {
		this.bandSize = bandSize;
		this.historySize = historySize;
		this.canvas = canvas;
		this.data = new Uint8Array(this.bandSize * 4);
		this.canvas.width = this.bandSize;
		this.canvas.height = this.historySize;
		this.ctx = this.canvas.getContext('2d');
		this.ctx.imageSmoothingEnabled = true;

		this.minDB = -70;
		this.maxDB = 0;

		// internal buffer for drawing full width
		this.offscreen = document.createElement('canvas');
		this.offscreen.width = this.bandSize;
		this.offscreen.height = this.historySize;
		this.offCtx = this.offscreen.getContext('2d');

		this.zoomOffset = 0.0;
		this.zoomScale = 1.0;
	}

	setZoom(offset, scale) {
		this.zoomOffset = offset;
		this.zoomScale = scale;
	}

	setRange(minDB, maxDB) {
		this.minDB = minDB;
		this.maxDB = maxDB;
	}

	renderLine(array) {
		const { canvas, ctx, offCtx, offscreen } = this;

		// shift data to down on offscreen
		offCtx.drawImage(
			offscreen,
			0, 0, offscreen.width, offscreen.height - 1,
			0, 1, offscreen.width, offscreen.height - 1
		);

		var imageData = offCtx.getImageData(0, 0, offscreen.width, 1);
		var data = imageData.data; // rgba

		for (var i = 0, len = offscreen.width; i < len; i++) {
			var n = i * 4;
			var rgb = convertDecibelToRGB(array[i], this.minDB, this.maxDB);

			data[n + 0] = rgb.r;
			data[n + 1] = rgb.g;
			data[n + 2] = rgb.b;
			data[n + 3] = 255;
		}

		offCtx.putImageData(imageData, 0, 0);

		// Now draw from offscreen to main canvas with zoom applied
		ctx.fillStyle = 'black';
		ctx.fillRect(0, 0, canvas.width, canvas.height);

		const sourceX = this.zoomOffset * offscreen.width;
		const sourceWidth = offscreen.width / this.zoomScale;

		ctx.drawImage(offscreen,
			sourceX, 0, sourceWidth, offscreen.height,
			0, 0, canvas.width, canvas.height
		);
	}
}
