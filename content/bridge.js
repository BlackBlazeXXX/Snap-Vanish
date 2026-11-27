// Connects the in-page code to the extension: settings, popup commands, AI engine frame.
(() => {
  const TAG = '__snapVanishMsg';
  const DEFAULTS = { enabled: true, sensitivity: 5, duration: 2.5, direction: 'up-right', debugHands: false };
  let status = null;
  let frame = null;

  const toMain = (msg, transfer) => window.postMessage({ [TAG]: 'to-main', ...msg }, '*', transfer);
  const pushSettings = () => chrome.storage.local.get(DEFAULTS).then(settings => toMain({ type: 'settings', settings })).catch(() => {});

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

  function startEngine() {
    if (!document.documentElement) return document.addEventListener('DOMContentLoaded', startEngine, { once: true });
    frame?.remove();
    const el = document.createElement('iframe');
    frame = el;
    el.src = chrome.runtime.getURL('engine/engine.html');
    el.setAttribute('aria-hidden', 'true');
    el.tabIndex = -1;
    el.style.cssText = 'position:fixed;width:1px;height:1px;left:-10px;top:-10px;border:0;opacity:0;pointer-events:none';
    el.addEventListener('error', () => {
      if (el === frame) toMain({ type: 'engine-error', message: 'Could not load AI engine frame.' });
    }, { once: true });
    el.addEventListener('load', () => {
      if (el !== frame || !el.contentWindow) return;
      try {
        const channel = new MessageChannel();
        el.contentWindow.postMessage({ [TAG]: 'engine-connect' }, chrome.runtime.getURL('').slice(0, -1), [channel.port1]);
        toMain({ type: 'engine-port' }, [channel.port2]);
      } catch (err) {
        toMain({ type: 'engine-error', message: String(err?.message || err) });
      }
    }, { once: true });
    document.documentElement.appendChild(el);
  }

  window.addEventListener('message', e => {
    const d = e.data;
    if (e.source !== window || !d || d[TAG] !== 'to-bridge') return;
    if (d.type === 'hello') pushSettings();
    else if (d.type === 'need-engine') { try { startEngine(); } catch (err) { console.warn('[Snap Vanish] reload this tab:', err); } }
    else if (d.type === 'status') status = d.status;
    else if (d.type === 'offscreen-inpaint' && d.rgba) {
      const b64 = encodeB64(new Uint8Array(d.rgba));
      chrome.runtime.sendMessage({ target: 'snap-vanish-bg', type: 'inpaint', generation: d.generation, w: d.w, h: d.h, b64 })
        .then(res => {
          if (res?.type === 'filled' && res.b64) {
            const bytes = decodeB64(res.b64);
            toMain({ type: 'offscreen-filled', generation: res.generation, w: res.w, h: res.h, rgba: bytes.buffer, ms: res.ms }, [bytes.buffer]);
          } else {
            toMain({ type: 'offscreen-fill-error', generation: res?.generation ?? d.generation, fatal: !!res?.fatal, message: res?.message || 'Offscreen room fill failed' });
          }
        })
        .catch(err => toMain({ type: 'offscreen-fill-error', generation: d.generation, message: String(err?.message || err) }));
    }
  });

  chrome.storage.onChanged.addListener(pushSettings);
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg?.target !== 'snap-vanish' || !status || (!status.camera && status.phase === 'idle')) return;   // only the frame using the camera answers
    if (msg.command === 'status') reply(status);
    else { toMain({ type: 'command', command: msg.command }); reply({ ok: true }); }
  });
  pushSettings();
})();
