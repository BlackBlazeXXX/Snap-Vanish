// Runs the room-fill Web Worker outside website COEP/CSP limits when needed.
let worker = null;
let queue = Promise.resolve();

function encodeB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x2000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  }
  return btoa(bin);
}

function decodeB64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function runInWorker(msg) {
  return new Promise(resolve => {
    if (!worker) worker = new Worker(new URL('inpaint-worker.js', import.meta.url).href, { type: 'module' });
    const bytes = decodeB64(msg.b64);
    const cleanup = () => {
      worker.onmessage = null;
      worker.onerror = null;
    };
    worker.onmessage = ({ data }) => {
      cleanup();
      if (data?.type === 'filled' && data.rgba) {
        const b64 = encodeB64(new Uint8Array(data.rgba));
        resolve({ type: 'filled', generation: data.generation, w: data.w, h: data.h, b64, ms: data.ms });
      } else {
        resolve({ type: 'fill-error', generation: data?.generation ?? msg.generation, fatal: !!data?.fatal, message: data?.message || 'Room fill failed' });
      }
    };
    worker.onerror = e => {
      cleanup();
      worker?.terminate();
      worker = null;
      resolve({ type: 'fill-error', generation: msg.generation, message: e.message || 'Offscreen room fill worker failed' });
    };
    worker.postMessage({ type: 'inpaint', generation: msg.generation, w: msg.w, h: msg.h, rgba: bytes.buffer }, [bytes.buffer]);
  });
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.target !== 'snap-vanish-offscreen' || msg.type !== 'inpaint') return;
  const run = queue.then(() => runInWorker(msg));
  queue = run.catch(() => {});
  run.then(reply, err => reply({ type: 'fill-error', generation: msg.generation, message: String(err?.message || err) }));
  return true;
});
