// Hidden extension frame: hand tracking and person cut-out (MediaPipe), room fill (worker).
// The extension's security policy blocks all outside network requests from here.
import { FilesetResolver, HandLandmarker, ImageSegmenter } from '../vendor/mediapipe/vision_bundle.mjs';

const url = path => new URL('../' + path, import.meta.url).href;

// MediaPipe's WASM glue routes C++ logs to globalThis.dbg, falling back to console.warn (which Chrome surfaces in extension Errors).
globalThis.dbg = text => {
  if (/gl_context\.cc:\d+\]\s*OpenGL error checking is disabled/.test(text)) return;
  if (/^I\d{4}\s/.test(text)) { console.log(text); return; }
  console.warn(text);
};

let port = null, hands = null, segmenter = null, worker = null, lastTs = 0;

// "GPU" on a computer without real graphics acceleration is far slower than the CPU path.
function softwareGraphics() {
  const gl = new OffscreenCanvas(1, 1).getContext('webgl2');
  if (!gl) return true;
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  return /swiftshader|llvmpipe|software|basic render/i.test(name);
}

async function createWithFallback(Task, fileset, options) {
  try {
    if (softwareGraphics()) throw new Error('software graphics');
    const task = await Task.createFromOptions(fileset, { ...options, baseOptions: { ...options.baseOptions, delegate: 'GPU' } });
    return [task, 'GPU'];
  } catch (e) {
    console.warn('GPU not available, using CPU:', e);
    return [await Task.createFromOptions(fileset, { ...options, baseOptions: { ...options.baseOptions, delegate: 'CPU' } }), 'CPU'];
  }
}

async function init() {
  try {
    const fileset = await FilesetResolver.forVisionTasks(url('vendor/mediapipe'));
    let delegate;
    [hands, delegate] = await createWithFallback(HandLandmarker, fileset, {
      baseOptions: { modelAssetPath: url('models/hand_landmarker.task') },
      runningMode: 'VIDEO', numHands: 2,
      minHandDetectionConfidence: 0.4, minHandPresenceConfidence: 0.35, minTrackingConfidence: 0.35
    });
    [segmenter] = await createWithFallback(ImageSegmenter, fileset, {
      baseOptions: { modelAssetPath: url('models/selfie_segmenter.tflite') },
      runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false
    });
    try {
      worker = new Worker(url('engine/inpaint-worker.js'), { type: 'module' });
      worker.onmessage = ({ data }) => port.postMessage(data, data.rgba ? [data.rgba] : []);
      worker.onerror = () => {
        worker?.terminate();
        worker = null;
        port?.postMessage({ type: 'use-offscreen-fill' });
      };
    } catch {
      worker = null;
      port?.postMessage({ type: 'use-offscreen-fill' });
    }
    port.postMessage({ type: 'ready', delegate });
  } catch (e) {
    port.postMessage({ type: 'error', message: String(e?.message || e) });
  }
}

function analyse({ id, bitmap, ts, wantMask }) {
  const out = { type: 'result', id, hands: [] };
  const transfer = [];
  try {
    const t = lastTs = Math.max(lastTs + 1, Math.round(ts));
    const h = hands.detectForVideo(bitmap, t);
    out.hands = h.landmarks.map((norm, i) => ({
      norm,
      world: h.worldLandmarks[i],
      side: h.handedness?.[i]?.[0]?.categoryName || h.handednesses?.[i]?.[0]?.categoryName || ''
    }));
    if (wantMask) {
      segmenter.segmentForVideo(bitmap, t, result => {
        const mask = result.confidenceMasks[0];
        const f = mask.getAsFloat32Array();
        const bytes = new Uint8Array(f.length);
        for (let i = 0; i < f.length; i++) bytes[i] = f[i] * 255;
        out.mask = bytes.buffer; out.mw = mask.width; out.mh = mask.height;
        transfer.push(bytes.buffer);
      });
    }
  } catch (e) {
    console.warn('analysis failed:', e);
  } finally {
    bitmap.close();
    port.postMessage(out, transfer);
  }
}

addEventListener('message', e => {
  if (e.data?.__snapVanishMsg !== 'engine-connect' || !e.ports[0] || port) return;
  port = e.ports[0];
  port.onmessage = ({ data }) => {
    if (data.type === 'init') init();
    else if (data.type === 'frame') analyse(data);
    else if (data.type === 'inpaint') {
      if (worker) worker.postMessage(data, [data.rgba]);
      else port?.postMessage({ type: 'use-offscreen-fill' });
    }
  };
});
