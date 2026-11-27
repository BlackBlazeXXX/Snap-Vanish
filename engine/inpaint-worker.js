// Fills the never-seen parts of the room with MI-GAN, on this computer.
import * as ort from '../vendor/ort/ort.wasm.min.mjs';

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
let sessionPromise = null;
let initFailed = false;
let pendingJob = null;
let running = false;

async function getSession() {
  if (initFailed) throw new Error('Room fill model failed to initialize.');
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(
      new URL('../models/migan_pipeline_v2.onnx', import.meta.url).href,
      { executionProviders: ['wasm'] }
    ).catch(err => {
      initFailed = true;
      sessionPromise = null;
      throw err;
    });
  }
  return sessionPromise;
}

// Pull-push: average known pixels into smaller and smaller copies, then pour back into holes.
function smoothFill(colour, mask, w, h) {
  let level = { w, h, c: colour, k: Uint8Array.from(mask, v => (v ? 1 : 0)) };
  const levels = [level];
  while (level.w > 1 || level.h > 1) {
    const nw = Math.ceil(level.w / 2), nh = Math.ceil(level.h / 2);
    const next = { w: nw, h: nh, c: new Float32Array(nw * nh * 3), k: new Uint8Array(nw * nh) };
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      let count = 0;
      const i = y * nw + x;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const px = x * 2 + dx, py = y * 2 + dy;
        if (px >= level.w || py >= level.h || !level.k[py * level.w + px]) continue;
        count++;
        for (let c = 0; c < 3; c++) next.c[i * 3 + c] += level.c[(py * level.w + px) * 3 + c];
      }
      if (count) { next.k[i] = 1; for (let c = 0; c < 3; c++) next.c[i * 3 + c] /= count; }
    }
    levels.push(level = next);
  }
  for (let l = levels.length - 2; l >= 0; l--) {
    const fine = levels[l], coarse = levels[l + 1];
    for (let y = 0; y < fine.h; y++) for (let x = 0; x < fine.w; x++) {
      const i = y * fine.w + x;
      if (fine.k[i]) continue;
      const cx = Math.max(0, Math.min(coarse.w - 1, x / 2 - 0.25)), cy = Math.max(0, Math.min(coarse.h - 1, y / 2 - 0.25));
      const x0 = Math.floor(cx), y0 = Math.floor(cy), fx = cx - x0, fy = cy - y0;
      const x1 = Math.min(coarse.w - 1, x0 + 1), y1 = Math.min(coarse.h - 1, y0 + 1);
      for (let c = 0; c < 3; c++) {
        const at = (px, py) => coarse.c[(py * coarse.w + px) * 3 + c];
        fine.c[i * 3 + c] = (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) + (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy;
      }
    }
  }
}

async function runInpaint(data) {
  const { w, h, generation } = data;
  const started = performance.now();
  try {
    const rgba = new Uint8Array(data.rgba);
    const n = w * h;
    let holes = 0;
    for (let i = 0; i < n; i++) if (rgba[i * 4 + 3] <= 127) holes++;
    if (holes) {
      // The model works best on a square picture, so mirror the top and bottom edges.
      const side = Math.max(w, h), left = (side - w) >> 1, top = (side - h) >> 1, N = side * side;
      const mirror = (v, len) => { const m = ((v % (2 * len)) + 2 * len) % (2 * len); return m < len ? m : 2 * len - 1 - m; };
      const colour = new Float32Array(N * 3);
      const mask = new Uint8Array(N);          // 255 = keep, 0 = fill in
      for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
        const i = y * side + x, j = (mirror(y - top, h) * w + mirror(x - left, w)) * 4;
        if (rgba[j + 3] > 127) { mask[i] = 255; for (let c = 0; c < 3; c++) colour[i * 3 + c] = rgba[j + c]; }
      }
      // Give the holes a smooth starting colour; empty (black) holes leave a ghost outline.
      smoothFill(colour, mask, side, side);
      const image = new Uint8Array(N * 3);
      for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) image[c * N + i] = colour[i * 3 + c];
      const session = await getSession();
      const result = await session.run({
        image: new ort.Tensor('uint8', image, [1, 3, side, side]),
        mask: new ort.Tensor('uint8', mask, [1, 1, side, side])
      });
      const out = result[session.outputNames[0]].data;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y + top) * side + x + left, j = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) rgba[j + c] = out[c * N + i];
      }
    }
    for (let i = 0; i < n; i++) rgba[i * 4 + 3] = 255;
    self.postMessage({ type: 'filled', generation, w, h, rgba: rgba.buffer, ms: Math.round(performance.now() - started) }, [rgba.buffer]);
  } catch (e) {
    self.postMessage({ type: 'fill-error', generation, fatal: initFailed, message: String(e?.message || e) });
  }
}

self.onmessage = ({ data }) => {
  pendingJob = data;
  if (running) return;
  running = true;
  (async () => {
    while (pendingJob) {
      const job = pendingJob;
      pendingJob = null;
      await runInpaint(job);
    }
  })().finally(() => { running = false; });
};
