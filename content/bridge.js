// Connects the in-page code to the extension: settings, popup commands, AI engine frame.
(() => {
  const TAG = '__snapVanishMsg';
  const DEFAULTS = { enabled: true, sensitivity: 5, duration: 2.5, direction: 'up-right', debugHands: false };
  let status = null;
  let frame = null;
  let alive = true;

  const toMain = (msg, transfer) => window.postMessage({ [TAG]: 'to-main', ...msg }, '*', transfer);
  const isCtxError = err => /context invalidated/i.test(String(err?.message || err || ''));

  function invalidate() {
    if (!alive) return;
    alive = false;
    window.removeEventListener('message', onPageMessage);
    try { chrome.storage?.onChanged?.removeListener(pushSettings); } catch {}
    try { chrome.runtime?.onMessage?.removeListener(onRuntimeMessage); } catch {}
    try { frame?.remove(); } catch {}
    frame = null;
    toMain({
      type: 'context-invalidated',
      message: 'Snap Vanish was updated or reloaded. Refresh this tab to reconnect.'
    });
  }

  function isAlive() {
    if (!alive) return false;
    try {
      if (chrome.runtime?.id) return true;
    } catch {}
    invalidate();
    return false;
  }

  function pushSettings() {
    if (!isAlive()) return;
    try {
      chrome.storage.local.get(DEFAULTS)
        .then(settings => { if (alive) toMain({ type: 'settings', settings }); })
        .catch(err => { if (isCtxError(err) || !isAlive()) invalidate(); });
    } catch {
      invalidate();
    }
  }

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
    if (!isAlive()) return;
    if (!document.documentElement) return document.addEventListener('DOMContentLoaded', startEngine, { once: true });
    frame?.remove();
    const el = document.createElement('iframe');
    frame = el;
    try {
      el.src = chrome.runtime.getURL('engine/engine.html');
    } catch {
      invalidate();
      return;
    }
    el.setAttribute('aria-hidden', 'true');
    el.tabIndex = -1;
    el.style.cssText = 'position:fixed;width:1px;height:1px;left:-10px;top:-10px;border:0;opacity:0;pointer-events:none';
    el.addEventListener('error', () => {
      if (el === frame && alive) toMain({ type: 'engine-error', message: 'Could not load AI engine frame.' });
    }, { once: true });
    el.addEventListener('load', () => {
      if (el !== frame || !el.contentWindow || !isAlive()) return;
      try {
        const channel = new MessageChannel();
        el.contentWindow.postMessage({ [TAG]: 'engine-connect' }, chrome.runtime.getURL('').slice(0, -1), [channel.port1]);
        toMain({ type: 'engine-port' }, [channel.port2]);
      } catch (err) {
        if (isCtxError(err) || !isAlive()) invalidate();
        else toMain({ type: 'engine-error', message: String(err?.message || err) });
      }
    }, { once: true });
    document.documentElement.appendChild(el);
  }

  function onPageMessage(e) {
    const d = e.data;
    if (e.source !== window || !d || d[TAG] !== 'to-bridge' || !isAlive()) return;
    if (d.type === 'hello') pushSettings();
    else if (d.type === 'need-engine') {
      try {
        startEngine();
      } catch (err) {
        if (isCtxError(err) || !isAlive()) invalidate();
        else console.warn('[Snap Vanish] reload this tab:', err);
      }
    } else if (d.type === 'status') status = d.status;
    else if (d.type === 'offscreen-inpaint' && d.rgba) {
      const b64 = encodeB64(new Uint8Array(d.rgba));
      try {
        chrome.runtime.sendMessage({ target: 'snap-vanish-bg', type: 'inpaint', generation: d.generation, w: d.w, h: d.h, b64 })
          .then(res => {
            if (!alive) return;
            if (res?.type === 'filled' && res.b64) {
              const bytes = decodeB64(res.b64);
              toMain({ type: 'offscreen-filled', generation: res.generation, w: res.w, h: res.h, rgba: bytes.buffer, ms: res.ms }, [bytes.buffer]);
            } else {
              toMain({ type: 'offscreen-fill-error', generation: res?.generation ?? d.generation, fatal: !!res?.fatal, message: res?.message || 'Offscreen room fill failed' });
            }
          })
          .catch(err => {
            if (isCtxError(err) || !isAlive()) {
              invalidate();
              toMain({ type: 'offscreen-fill-error', generation: d.generation, fatal: true, message: 'Snap Vanish was updated or reloaded. Refresh this tab to reconnect.' });
              return;
            }
            toMain({ type: 'offscreen-fill-error', generation: d.generation, message: String(err?.message || err) });
          });
      } catch (err) {
        if (isCtxError(err) || !isAlive()) {
          invalidate();
          toMain({ type: 'offscreen-fill-error', generation: d.generation, fatal: true, message: 'Snap Vanish was updated or reloaded. Refresh this tab to reconnect.' });
        } else {
          toMain({ type: 'offscreen-fill-error', generation: d.generation, message: String(err?.message || err) });
        }
      }
    }
  }

  function onRuntimeMessage(msg, sender, reply) {
    if (!isAlive() || msg?.target !== 'snap-vanish' || !status || (!status.camera && status.phase === 'idle')) return;   // only the frame using the camera answers
    if (msg.command === 'status') reply(status);
    else { toMain({ type: 'command', command: msg.command }); reply({ ok: true }); }
  }

  window.addEventListener('message', onPageMessage);
  try {
    chrome.storage.onChanged.addListener(pushSettings);
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
  } catch {
    invalidate();
  }
  pushSettings();
})();
