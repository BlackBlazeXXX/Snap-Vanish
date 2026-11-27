// WebGL2: learns the real room, composes the empty "plate", and draws the dust.
(() => {
  const SV = (globalThis.__snapVanish ||= {});

  // uv (0,0) is always the top-left of the picture.
  const QUAD_VS = `#version 300 es
  uniform float uFlip;
  out vec2 uv;
  void main() {
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    uv = p;
    gl_Position = vec4(p.x * 2.0 - 1.0, (p.y * 2.0 - 1.0) * uFlip, 0.0, 1.0);
  }`;

  const HEAD = `#version 300 es
  precision highp float;
  in vec2 uv;
  out vec4 o;`;

  // When each point of the body breaks off (0..0.57 of the effect).
  const FRONT = `
  uniform float uT, uAspect;
  uniform vec2 uDir;
  uniform vec4 uBox;
  float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + 1.0), f.x), f.y);
  }
  float front(vec2 p) {
    vec2 c = (uBox.xy + uBox.zw) * 0.5, s = vec2(uAspect, 1.0);
    vec2 half_ = max((uBox.zw - uBox.xy) * 0.5 * s, vec2(0.02));
    float along = dot((p - c) * s, uDir) / dot(abs(uDir), half_);
    float order = 0.5 - 0.5 * along;                       // downwind side goes first
    float n = 0.65 * noise(p * s * 14.0) + 0.35 * noise(p * s * 55.0);
    return 0.02 + 0.55 * clamp(0.68 * order + 0.5 * n - 0.09, 0.0, 1.0);
  }`;

  const COPY_FS = `${HEAD}
  uniform sampler2D uTex;
  void main() { o = texture(uTex, uv); }`;

  // Alpha = confidence that this pixel is real background (needs 3 clean sightings).
  const ACCUM_FS = `${HEAD}
  uniform sampler2D uPrev, uFrame, uMask;
  uniform vec4 uHands[2];
  uniform float uForce, uAspect;
  void main() {
    vec4 prev = texture(uPrev, uv);
    vec3 cur = texture(uFrame, uv).rgb;
    if (uForce > 0.5) { o = vec4(cur, 1.0); return; }
    float m = texture(uMask, uv).r;
    for (int i = 0; i < 24; i++) {
      float r = i < 8 ? 0.012 : (i < 16 ? 0.024 : 0.036);
      float a = float(i) * 0.785398 + (i >= 8 && i < 16 ? 0.3927 : 0.0);
      m = max(m, texture(uMask, uv + vec2(cos(a) / uAspect, sin(a)) * r).r);
    }
    for (int i = 0; i < 2; i++) {
      vec4 h = uHands[i];
      if (uv.x > h.x && uv.y > h.y && uv.x < h.z && uv.y < h.w) m = 1.0;
    }
    if (m < 0.2) o = vec4(prev.a > 0.99 ? mix(prev.rgb, cur, 0.25) : cur, min(prev.a + 0.34, 1.0));
    else o = prev.a > 0.99 ? prev : vec4(prev.rgb, 0.0);
  }`;

  const REQUEST_FS = `${HEAD}
  uniform sampler2D uAccum;
  uniform vec2 uPx;
  void main() {
    float known = 1.0;
    for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++)
      known = min(known, step(0.99, texture(uAccum, uv + vec2(x, y) * uPx).a));
    o = vec4(texture(uAccum, uv).rgb, known);
  }`;

  // Real pixels where we have them, AI fill everywhere else, soft seam between.
  const PLATE_FS = `${HEAD}
  uniform sampler2D uAccum, uFill;
  uniform vec2 uPx;
  void main() {
    vec4 a = texture(uAccum, uv);
    float w = 0.0;
    for (int i = 0; i < 16; i++) {
      float ang = float(i) * 0.3927, r = i % 2 == 0 ? 5.0 : 10.0;
      w += step(0.99, texture(uAccum, uv + vec2(cos(ang), sin(ang)) * r * uPx).a);
    }
    float k = step(0.99, a.a) * smoothstep(0.4, 1.0, w / 16.0);
    o = vec4(mix(texture(uFill, uv).rgb, a.rgb, k), 1.0);
  }`;

  const EMPTY_FS = `${HEAD}
  uniform sampler2D uPlate;
  uniform float uTime;
  uniform vec2 uRes;
  float hash(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
  void main() {   // faint sensor noise so the empty room does not look frozen
    float g = hash(vec3(floor(uv * uRes), mod(uTime, 97.0))) - 0.5;
    o = vec4(texture(uPlate, uv).rgb + g * 0.016, 1.0);
  }`;

  const BODY_FS = `${HEAD}
  uniform sampler2D uPlate, uSrc, uLive, uMask;
  uniform float uLiveMix;
  ${FRONT}
  void main() {
    float m = texture(uMask, uv).r;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.785398;
      m = max(m, texture(uMask, uv + vec2(cos(a) / uAspect, sin(a)) * 0.009).r);
    }
    float person = smoothstep(0.12, 0.45, m);
    float f = front(uv);
    float gone = smoothstep(f - 0.012, f + 0.012, uT);
    float keep = mix(1.0 - smoothstep(0.1, 0.7, uT), 1.0 - gone, person);
    vec3 src = mix(texture(uSrc, uv).rgb, texture(uLive, uv).rgb, uLiveMix);
    float d = (uT - f + 0.012) / 0.018;
    float ember = person * exp(-d * d) * step(0.001, uT);
    vec3 col = mix(texture(uPlate, uv).rgb, src, keep);
    col = mix(col, col * vec3(0.75, 0.5, 0.35) + vec3(0.16, 0.07, 0.02), ember * 0.7);
    o = vec4(col, 1.0);
  }`;

  const DUST_VS = `#version 300 es
  precision highp float;
  uniform sampler2D uSrc, uMask;
  uniform ivec2 uGrid;
  uniform float uCell, uLayer;
  out vec4 vColor;
  out float vSeed;
  ${FRONT}
  void main() {
    vec2 cell = vec2(gl_VertexID % uGrid.x, gl_VertexID / uGrid.x);
    vec2 k = cell + uLayer * 191.7;
    vec4 r = vec4(hash(k + 1.1), hash(k + 7.3), hash(k + 13.9), hash(k + 29.2));
    vec2 home = (cell + r.xy) / vec2(uGrid);
    float m = textureLod(uMask, home, 0.0).r;
    float p = (uT - front(home)) / (0.2 + 0.22 * r.z);
    if (m < 0.4 || p <= 0.0 || p >= 1.0) { gl_Position = vec4(3.0, 3.0, 0.0, 1.0); gl_PointSize = 0.0; return; }
    vec2 side = vec2(-uDir.y, uDir.x);
    float travel = (0.12 + 0.75 * r.w * r.w) * pow(p, 1.45);
    float swirl = sin(p * 8.0 + noise(home * 9.0) * 12.0) * 0.045 * p + (r.y - 0.5) * 0.22 * p;
    vec2 off = uDir * travel + side * swirl + vec2(0.0, -0.05 * p * p);
    vec2 pos = home + off / vec2(uAspect, 1.0);
    gl_Position = vec4(pos.x * 2.0 - 1.0, 1.0 - pos.y * 2.0, 0.0, 1.0);
    gl_PointSize = max(1.0, uCell * mix(1.9, 0.55, p) * (0.55 + 0.9 * r.x));
    vec3 c = textureLod(uSrc, home, 0.0).rgb;
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    vec3 ash = vec3(l) * vec3(0.78, 0.58, 0.42) + vec3(0.07, 0.035, 0.015);
    vColor = vec4(mix(c, ash, 0.85 * smoothstep(0.02, 0.4, p)), 1.0 - smoothstep(0.5, 1.0, p));
    vSeed = r.z;
  }`;

  const DUST_FS = `#version 300 es
  precision highp float;
  in vec4 vColor;
  in float vSeed;
  out vec4 o;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float a = vSeed * 6.2831;
    c = mat2(cos(a), -sin(a), sin(a), cos(a)) * c;
    if (abs(c.x) + abs(c.y) * (1.0 + vSeed) > 0.6) discard;   // irregular flakes
    o = vColor;
  }`;

  const DIRECTIONS = {
    'up-right': [0.86, -0.5], right: [1, -0.08], left: [-1, -0.08],
    'up-left': [-0.86, -0.5], up: [0.08, -1], down: [0.05, 1]
  };

  class Renderer {
    constructor() {
      this.canvas = new OffscreenCanvas(2, 2);
      const gl = this.gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false });
      if (!gl) throw new Error('WebGL2 is not available');
      this.programs = {};
      for (const [name, fs] of Object.entries({ copy: COPY_FS, accum: ACCUM_FS, request: REQUEST_FS, plate: PLATE_FS, empty: EMPTY_FS, body: BODY_FS })) {
        this.programs[name] = this._program(QUAD_VS, fs);
      }
      this.programs.dust = this._program(DUST_VS, DUST_FS);
      this.vao = gl.createVertexArray();
      this.w = this.h = 0;
      this.tex = {};
      this.box = [0.2, 0.1, 0.8, 1];
      this.hasFill = false;
      this.analysisAt = 0;
      this.analysisCount = 0;
    }

    get lost() { return this.gl.isContextLost(); }

    _program(vs, fs) {
      const gl = this.gl, p = gl.createProgram();
      for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader: ' + gl.getShaderInfoLog(s));
        gl.attachShader(p, s);
      }
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Program: ' + gl.getProgramInfoLog(p));
      p.loc = {};
      return p;
    }

    _texture(w, h, internal = this.gl.RGBA8, format = this.gl.RGBA) {
      const gl = this.gl, t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, gl.UNSIGNED_BYTE, null);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) {
        gl.texParameteri(gl.TEXTURE_2D, k, v);
      }
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      return { t, fb, w, h };
    }

    _free(x) { if (x) { this.gl.deleteTexture(x.t); this.gl.deleteFramebuffer(x.fb); } }

    setSize(w, h) {
      if (w === this.w && h === this.h) return false;
      const old = this.tex, sameShape = this.w && Math.abs(w / h - this.w / this.h) < 0.02;
      this.w = w; this.h = h;
      this.canvas.width = w; this.canvas.height = h;
      const names = ['staged', 'frame', 'live', 'dustFrame', 'accumA', 'accumB', 'plate'];
      this.tex = Object.fromEntries(names.map(n => [n, this._texture(w, h)]));
      this.tex.fill = old.fill || this._texture(2, 2);
      this.tex.mask = old.mask || this._texture(2, 2, this.gl.R8, this.gl.RED);
      this.tex.dustMask = old.dustMask || this._texture(2, 2, this.gl.R8, this.gl.RED);
      if (sameShape) {   // same camera at a new resolution: keep what we learned
        for (const n of ['accumA', 'plate', 'dustFrame', 'frame']) this._draw('copy', this.tex[n], { uTex: old[n] });
      } else {
        this.hasFill = false;
        this.analysisAt = 0;
        this.analysisCount = 0;
      }
      for (const n of names) this._free(old[n]);
      return true;
    }

    _upload(target, source) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, target.t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }

    _uniforms(p, uniforms) {
      const gl = this.gl;
      let unit = 0;
      for (const [name, v] of Object.entries(uniforms)) {
        const loc = p.loc[name] ??= gl.getUniformLocation(p, name);
        if (loc === null) continue;
        if (v && v.t) {
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, v.t);
          gl.uniform1i(loc, unit++);
        } else if (typeof v === 'number') gl.uniform1f(loc, v);
        else if (v.int) gl.uniform2i(loc, v.int[0], v.int[1]);
        else if (v.length === 2) gl.uniform2fv(loc, v);
        else if (v.length === 4) gl.uniform4fv(loc, v);
        else gl.uniform4fv(loc, v);
      }
      gl.activeTexture(gl.TEXTURE0);
    }

    _draw(name, target, uniforms) {
      const gl = this.gl, p = this.programs[name];
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
      gl.viewport(0, 0, target ? target.w : this.w, target ? target.h : this.h);
      gl.disable(gl.BLEND);
      gl.useProgram(p);
      gl.bindVertexArray(this.vao);
      this._uniforms(p, { uFlip: target ? 1 : -1, ...uniforms });
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // Keep the exact frame that is being analysed, so mask and picture line up.
    stage(videoFrame) { this._upload(this.tex.staged, videoFrame); }

    commit(maskBytes, mw, mh, handBoxes, force) {
      const gl = this.gl, T = this.tex;
      [T.staged, T.frame] = [T.frame, T.staged];
      if (T.mask.w !== mw || T.mask.h !== mh) {
        this._free(T.mask);
        T.mask = this._texture(mw, mh, gl.R8, gl.RED);
      }
      gl.bindTexture(gl.TEXTURE_2D, T.mask.t);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, mw, mh, gl.RED, gl.UNSIGNED_BYTE, maskBytes);

      let x0 = mw, y0 = mh, x1 = -1, y1 = -1;
      for (let y = 0; y < mh; y += 3) for (let x = 0; x < mw; x += 3) {
        if (maskBytes[y * mw + x] > 127) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      }
      if (x1 >= 0) this.box = [x0 / mw, y0 / mh, x1 / mw, y1 / mh];

      const hands = new Float32Array(8).fill(-1);
      handBoxes.slice(0, 2).forEach((b, i) => hands.set(b, i * 4));
      const p = this.programs.accum;
      gl.useProgram(p);
      gl.uniform4fv(gl.getUniformLocation(p, 'uHands[0]'), hands);
      this._draw('accum', T.accumB, { uPrev: T.accumA, uFrame: T.frame, uMask: T.mask, uForce: force ? 1 : 0, uAspect: this.w / this.h });
      [T.accumA, T.accumB] = [T.accumB, T.accumA];
      this.analysisAt = performance.now();
      this.analysisCount++;
    }

    // Downscaled copy of what we know about the room, for the AI to complete.
    inpaintRequest(maxWidth = 640) {
      const gl = this.gl, w = Math.min(maxWidth, this.w), h = Math.round(w * this.h / this.w);
      if (!this.small || this.small.w !== w || this.small.h !== h) { this._free(this.small); this.small = this._texture(w, h); }
      this._draw('request', this.small, { uAccum: this.tex.accumA, uPx: [1 / w, 1 / h] });
      const rgba = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      let known = 0;
      for (let i = 3; i < rgba.length; i += 4) if (rgba[i] > 127) known++;
      return { w, h, rgba, known: known / (w * h) };
    }

    setFill(rgba, w, h) {
      const gl = this.gl;
      if (this.tex.fill.w !== w || this.tex.fill.h !== h) { this._free(this.tex.fill); this.tex.fill = this._texture(w, h); }
      gl.bindTexture(gl.TEXTURE_2D, this.tex.fill.t);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      this.hasFill = true;
    }

    forgetRoom() {
      const gl = this.gl;
      for (const n of ['accumA', 'accumB']) {
        if (!this.tex[n]) continue;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.tex[n].fb);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      this.hasFill = false;
      this.analysisCount = 0;
    }

    composePlate() {
      this._draw('plate', this.tex.plate, { uAccum: this.tex.accumA, uFill: this.tex.fill, uPx: [1 / this.w, 1 / this.h] });
    }

    // Freeze the picture of you that will turn to dust.
    beginVanish() {
      const gl = this.gl, T = this.tex;
      this.composePlate();
      this._draw('copy', T.dustFrame, { uTex: T.frame });
      if (T.dustMask.w !== T.mask.w || T.dustMask.h !== T.mask.h) { this._free(T.dustMask); T.dustMask = this._texture(T.mask.w, T.mask.h, gl.R8, gl.RED); }
      this._draw('copy', T.dustMask, { uTex: T.mask });
      this.vanishBox = [...this.box];
    }

    beginReturn() { this.returnBox = [...this.box]; }

    renderEmpty() {
      this._draw('empty', null, { uPlate: this.tex.plate, uTime: Math.floor(performance.now() / 33), uRes: [this.w, this.h] });
    }

    // t: 0 = fully here, 1 = fully gone. returning: dust flies back onto the live you.
    renderDust(t, direction, returning, liveFrame) {
      const gl = this.gl, T = this.tex;
      const src = returning ? T.frame : T.dustFrame, mask = returning ? T.mask : T.dustMask;
      let liveMix = 0;
      if (returning && t < 0.16) { this._upload(T.live, liveFrame); liveMix = 1 - t / 0.16; }
      const d = DIRECTIONS[direction] || DIRECTIONS['up-right'], len = Math.hypot(d[0], d[1]);
      const shared = {
        uT: t, uAspect: this.w / this.h, uDir: [d[0] / len, d[1] / len],
        uBox: (returning ? this.returnBox : this.vanishBox) || this.box
      };
      this._draw('body', null, { uPlate: T.plate, uSrc: src, uLive: T.live, uMask: mask, uLiveMix: liveMix, ...shared });

      const cols = 300, rows = Math.max(1, Math.round(cols * this.h / this.w)), p = this.programs.dust;
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(p);
      for (let layer = 0; layer < 2; layer++) {
        this._uniforms(p, { uSrc: src, uMask: mask, uGrid: { int: [cols, rows] }, uCell: this.w / cols, uLayer: layer, ...shared });
        gl.drawArrays(gl.POINTS, 0, cols * rows);
      }
      gl.disable(gl.BLEND);
    }
  }

  SV.Renderer = Renderer;
})();
