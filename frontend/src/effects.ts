/**
 * effects.ts
 *
 * WebGL post-processing pipeline for Captain Down Bad.
 * Translates GodotRetro shaders (CC0 / MIT) to WebGL 1.0:
 *
 *   AccurateCRT / TV.gdshader   → scanlines
 *   TV.gdshader                 → chromatic aberration (RGB offset)
 *   NTSCBasic.gdshader          → horizontal YIQ color bleed
 *   SimpleGrain.gdshader        → film grain
 *   LensDistortion.gdshader     → subtle barrel warp
 *   Glitch.gdshader             → scanline jitter + color drift (game-over)
 *   hit-flash                   → white overlay on damage taken
 *   defeat-flash                → cyan overlay on enemy kill
 */

// ── Vertex shader — fullscreen quad ──────────────────────────────────────────
const VERT_SRC = `
attribute vec2 aPos;
varying   vec2 vUV;
void main() {
  vUV         = aPos * 0.5 + 0.5;
  vUV.y       = 1.0 - vUV.y;   /* flip Y: Canvas2D origin is top-left */
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`

// ── Fragment shader — combined retro post-process ─────────────────────────────
const FRAG_SRC = `
precision mediump float;
varying vec2 vUV;

uniform sampler2D uTex;
uniform vec2      uRes;       /* source (game canvas) resolution */
uniform float     uTime;      /* seconds, for animated effects  */
uniform float     uHitFlash;  /* 0-1 white flash on damage       */
uniform float     uDefFlash;  /* 0-1 cyan flash on enemy kill    */
uniform float     uGlitch;    /* 0-1 glitch burst (game over)    */
uniform float     uCA;        /* chromatic aberration strength   */
uniform float     uGrain;     /* film grain amount               */
uniform float     uScanlines; /* scanline darkness 0-1           */

/* SimpleGrain.gdshader — fract(sin(dot)) noise */
float grain(vec2 uv, float t) {
  return fract(sin(dot(uv + vec2(t * 0.001), vec2(17.0, 180.0))) * 2500.0);
}

/* Glitch.gdshader — nrand helper */
float nrand(float x, float y) {
  return fract(sin(dot(vec2(x, y), vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 uv = vUV;

  /* ── LensDistortion.gdshader — subtle barrel warp ────────────────────── */
  float lens = 0.008;
  vec2  c    = (uv - 0.5) * 2.0;
  float asp  = uRes.x / uRes.y;
  uv.x -= (1.0 - c.y * c.y) * lens * asp * c.x;
  uv.y -= (1.0 - c.x * c.x) * lens * asp * c.y;

  /* ── Glitch.gdshader — per-row scanline jitter + color drift ─────────── */
  float jitter = 0.0;
  float drift  = 0.0;
  if (uGlitch > 0.0) {
    float row = floor(uv.y * uRes.y);
    float j   = nrand(row, uTime) * 2.0 - 1.0;
    jitter    = step(1.0 - uGlitch * 0.9, abs(j)) * 0.015 * uGlitch;
    drift     = sin(uv.y * 50.0 + uTime * 600.0) * 0.04 * uGlitch;
  }

  /* ── TV.gdshader — chromatic aberration (RGB channel offset) ─────────── */
  float ca = uCA + uGlitch * 0.006;
  float r  = texture2D(uTex, uv + vec2( ca + jitter, 0.0)).r;
  float g  = texture2D(uTex, uv + vec2(      jitter, 0.0)).g;
  float b  = texture2D(uTex, uv + vec2(-ca + jitter, 0.0)).b;

  /* Color drift on red channel only (Glitch.gdshader) */
  if (uGlitch > 0.0) {
    r = texture2D(uTex, uv + vec2(drift, 0.0)).r;
  }
  vec3 color = vec3(r, g, b);

  /* ── NTSCBasic.gdshader — horizontal YIQ color bleed ─────────────────── */
  vec3 yiq;
  yiq.x = dot(color, vec3( 0.299,  0.587,  0.114));
  yiq.y = dot(color, vec3( 0.596, -0.274, -0.322));
  yiq.z = dot(color, vec3( 0.211, -0.523,  0.312));

  float bleed = 0.012;
  float I2    = dot(texture2D(uTex, uv + vec2(-bleed, 0.0)).rgb, vec3( 0.596, -0.274, -0.322));
  float Q2    = dot(texture2D(uTex, uv + vec2( bleed, 0.0)).rgb, vec3( 0.211, -0.523,  0.312));
  yiq.y = (yiq.y + I2) * 0.5;
  yiq.z = (yiq.z + Q2) * 0.5;

  color.r = clamp(yiq.x + 0.956 * yiq.y + 0.621 * yiq.z, 0.0, 1.0);
  color.g = clamp(yiq.x - 0.272 * yiq.y - 0.647 * yiq.z, 0.0, 1.0);
  color.b = clamp(yiq.x - 1.106 * yiq.y + 1.703 * yiq.z, 0.0, 1.0);

  /* ── AccurateCRT / TV.gdshader — scanlines ───────────────────────────── */
  float scanRow  = mod(floor(vUV.y * uRes.y), 2.0);
  float scanline = scanRow < 1.0 ? 0.70 : 1.0;
  color         *= mix(1.0, scanline, uScanlines);

  /* ── SimpleGrain.gdshader — film grain ────────────────────────────────── */
  color = mix(color, vec3(grain(vUV, uTime)), uGrain);

  /* ── Hit flash — white on damage ─────────────────────────────────────── */
  color = mix(color, vec3(1.0), uHitFlash);

  /* ── Defeat flash — cyan on enemy kill ───────────────────────────────── */
  color = mix(color, vec3(0.0, 1.0, 0.82), uDefFlash * 0.55);

  gl_FragColor = vec4(color, 1.0);
}
`

// ── Public types ─────────────────────────────────────────────────────────────

export interface RetroUniforms {
  time:      number
  hitFlash:  number   // 0-1 white flash (player takes damage)
  defFlash:  number   // 0-1 cyan flash  (enemy defeated)
  glitch:    number   // 0-1 glitch burst (game over / strong hit)
  ca:        number   // chromatic aberration (default 0.003)
  grain:     number   // film grain amount   (default 0.018)
  scanlines: number   // scanline darkness   (default 0.65)
}

export const DEFAULT_RETRO: RetroUniforms = {
  time:      0,
  hitFlash:  0,
  defFlash:  0,
  glitch:    0,
  ca:        0.003,
  grain:     0.018,
  scanlines: 0.65,
}

export interface RetroGL {
  render:  (src: HTMLCanvasElement, u: RetroUniforms) => void
  dispose: () => void
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
    throw new Error(`Shader compile error:\n${gl.getShaderInfoLog(sh)}`)
  return sh
}

// ── initRetroGL ───────────────────────────────────────────────────────────────

export function initRetroGL(canvas: HTMLCanvasElement): RetroGL {
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false })
  if (!gl) {
    console.warn('[RetroGL] WebGL unavailable — effects disabled')
    return { render: () => {}, dispose: () => {} }
  }

  const prog = gl.createProgram()!
  gl.attachShader(prog, compileShader(gl, gl.VERTEX_SHADER,   VERT_SRC))
  gl.attachShader(prog, compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC))
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
    throw new Error(`Shader link error:\n${gl.getProgramInfoLog(prog)}`)

  // Fullscreen quad (triangle strip)
  const buf = gl.createBuffer()!
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER,
    new Float32Array([-1, -1,  1, -1,  -1, 1,  1, 1]),
    gl.STATIC_DRAW)

  gl.useProgram(prog)
  const aPos = gl.getAttribLocation(prog, 'aPos')
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

  // Source texture (game canvas pixels uploaded each frame)
  const tex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  // Cache uniform locations
  const L = (n: string) => gl.getUniformLocation(prog, n)
  const loc = {
    uTex:      L('uTex'),
    uRes:      L('uRes'),
    uTime:     L('uTime'),
    uHitFlash: L('uHitFlash'),
    uDefFlash: L('uDefFlash'),
    uGlitch:   L('uGlitch'),
    uCA:       L('uCA'),
    uGrain:    L('uGrain'),
    uScanlines: L('uScanlines'),
  }

  function render(src: HTMLCanvasElement, u: RetroUniforms) {
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src)
    gl.uniform1i(loc.uTex,      0)
    gl.uniform2f(loc.uRes,      src.width, src.height)
    gl.uniform1f(loc.uTime,     u.time)
    gl.uniform1f(loc.uHitFlash, u.hitFlash)
    gl.uniform1f(loc.uDefFlash, u.defFlash)
    gl.uniform1f(loc.uGlitch,   u.glitch)
    gl.uniform1f(loc.uCA,       u.ca)
    gl.uniform1f(loc.uGrain,    u.grain)
    gl.uniform1f(loc.uScanlines, u.scanlines)
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  function dispose() {
    gl.deleteTexture(tex)
    gl.deleteProgram(prog)
    gl.deleteBuffer(buf)
  }

  return { render, dispose }
}
