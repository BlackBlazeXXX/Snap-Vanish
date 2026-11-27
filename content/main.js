// Runs inside the meeting page. Sits between your camera/mic and the meeting.
(() => {
  const SV = (globalThis.__snapVanish ||= {});
  if (SV.started || !navigator.mediaDevices?.getUserMedia || !globalThis.MediaStreamTrackProcessor || !globalThis.MediaStreamTrackGenerator) return;
  SV.started = true;

  const TAG = '__snapVanishMsg';
  const nativeGUM = MediaDevices.prototype.getUserMedia;
  const proto = MediaStreamTrack.prototype;
  const nativeEnabled = Object.getOwnPropertyDescriptor(proto, 'enabled');
  const nativeStop = proto.stop;
  const nativeClone = proto.clone;
  const nativeStreamClone = MediaStream.prototype.clone;

  const settings = { enabled: true, sensitivity: 5, duration: 2.5, direction: 'up-right', debugHands: false };
  const state = {
    phase: 'idle',      // idle -> pending -> vanishing -> vanished -> returning -> idle
    since: 0,
    muted: false,
    note: '',
    captureAt: 0
  };

  const send = (msg, transfer) => window.postMessage({ [TAG]: 'to-bridge', ...msg }, '*', transfer);
  const say = note => { state.note = note; };

  // ───────────────────────── Microphone ─────────────────────────
  const micTracks = new Set();   // every audio track the meeting holds

  function applyMute(track) {
    nativeEnabled.set.call(track, track.__svWanted && !state.muted);
  }

  function guardAudio(track) {
    if (track.__svGuarded) return track;
    track.__svGuarded = true;
    track.__svWanted = nativeEnabled.get.call(track);
    Object.defineProperty(track, 'enabled', {
      configurable: true,
      get() { return this.__svWanted; },           // the meeting's own mute still works
      set(v) { this.__svWanted = !!v; applyMute(this); }
    });
    Object.defineProperty(track, 'stop', { configurable: true, writable: true, value() { micTracks.delete(this); nativeStop.call(this); syncListener(); } });
    Object.defineProperty(track, 'clone', { configurable: true, writable: true, value() { const c = nativeClone.call(this); const wanted = this.__svWanted; nativeEnabled.set.call(c, wanted); return guardAudio(c); } });
    track.addEventListener('ended', () => { micTracks.delete(track); syncListener(); });
    micTracks.add(track);
    applyMute(track);
    return track;
  }

  function setMuted(m) {
    state.muted = m;
    for (const t of micTracks) {
      if (t.readyState === 'ended') micTracks.delete(t);
      else applyMute(t);
    }
  }

  // A separate, unprocessed copy of the mic that only listens for the click.
  const listener = { track: null, busy: false, resync: false, epoch: 0, retryAt: 0, deviceId: '', processed: false, clicks: null, state: 'off' };
  let lastHands = [];
  let lastSnapAt = 0;
  const detector = new SV.SnapDetector();
  const fusion = new SV.SnapFusion(
    () => { lastSnapAt = performance.now(); snap('gesture'); },
    () => say(listener.track ? 'Saw a snap motion but heard no click.' : 'Saw a snap motion, but the mic is not available.')
  );

  async function syncListener() {
    const needed = settings.enabled && livePipelines().length > 0;
    if (!needed) {
      listener.epoch++;
      if (listener.track) nativeStop.call(listener.track);
      listener.track = null; listener.clicks = null; listener.deviceId = ''; listener.processed = false;
      listener.state = 'off';
      return;
    }
    const page = [...micTracks].find(t => t.readyState === 'live');
    const pageDeviceId = page?.getSettings?.().deviceId || '';
    if (listener.track?.readyState === 'live') {
      if (pageDeviceId && listener.deviceId && pageDeviceId !== listener.deviceId) {
        nativeStop.call(listener.track);
        listener.track = null; listener.clicks = null; listener.deviceId = '';
      } else {
        return;
      }
    }
    if (listener.busy) { listener.resync = true; return; }
    listener.busy = true;
    const epoch = listener.epoch;
    const stale = () => epoch !== listener.epoch || !settings.enabled || !livePipelines().length;
    try {
      if (!page) {
        const perm = await navigator.permissions.query({ name: 'microphone' }).catch(() => null);
        if (stale()) { listener.state = 'off'; return; }
        if (perm?.state !== 'granted') {
          listener.state = 'waiting for mic';
          listener.retryAt = performance.now() + 3000;
          return;
        }
      }
      const rawAudio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
      let stream = null, track = null;
      if (pageDeviceId) {
        stream = await nativeGUM.call(navigator.mediaDevices, { audio: { ...rawAudio, deviceId: { exact: pageDeviceId } } }).catch(() => null);
      }
      if (!stream && !stale()) {
        stream = await nativeGUM.call(navigator.mediaDevices, { audio: rawAudio }).catch(() => null);
      }
      if (stale()) {
        stream?.getTracks().forEach(t => nativeStop.call(t));
        listener.state = 'off';
        return;
      }
      if (stream) {
        const tracks = stream.getAudioTracks();
        track = tracks[0] || null;
        for (let i = 1; i < tracks.length; i++) nativeStop.call(tracks[i]);
      } else if (page) {
        track = nativeClone.call(page);
      } else {
        throw new Error('Microphone unavailable');
      }
      if (!track) throw new Error('No microphone track');
      nativeEnabled.set.call(track, true);
      const tSettings = track.getSettings?.() || {};
      listener.deviceId = tSettings.deviceId || pageDeviceId;
      listener.processed = !!(tSettings.noiseSuppression || tSettings.echoCancellation);
      listener.clicks = null;
      listener.track = track;
      listener.state = 'listening';
      listener.retryAt = 0;
      listen(track).catch(e => console.warn('[Snap Vanish] listen:', e));
    } catch (e) {
      if (!stale()) {
        listener.state = 'unavailable';
        listener.retryAt = performance.now() + 4000;
      }
      console.warn('[Snap Vanish] mic:', e);
    } finally {
      listener.busy = false;
      if (listener.resync) {
        listener.resync = false;
        syncListener();
      }
    }
  }

  async function listen(track) {
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    let buf = new Float32Array(480);
    try {
      for (;;) {
        const { value: data, done } = await reader.read();
        if (done || listener.track !== track) { data?.close(); break; }
        const n = data.numberOfFrames;
        if (buf.length < n) buf = new Float32Array(n);
        data.copyTo(buf, { planeIndex: 0, format: 'f32-planar' });
        if (!listener.clicks || listener.clicks.sr !== data.sampleRate) {
          listener.clicks = new SV.ClickDetector(data.sampleRate, t => fusion.addClick(t));
        }
        listener.clicks.sensitivity = settings.sensitivity;
        listener.clicks.process(buf.subarray(0, n), performance.now());
        data.close();
      }
    } finally {
      reader.cancel().catch(() => {});
      if (listener.track === track) {
        listener.track = null;
        listener.clicks = null;
        listener.deviceId = '';
        listener.processed = false;
        listener.state = 'off';
        listener.retryAt = performance.now() + 1500;
      }
    }
  }

  // ───────────────────────── AI engine (extension iframe) ─────────────────────────
  const engine = { port: null, status: 'off', error: '', delegate: '', inFlight: null, filling: 0, fillErrorAt: 0, offscreenFill: false, lastSend: 0, count: 0, timeouts: 0, askedAt: 0, errorAt: 0, fillMs: 0, lastResult: 0, fps: 0 };
  let renderer = null;
  let lastFillCheck = 0, lastFillSent = 0, lastKnown = -1;

  function ensureEngine() {
    if (engine.status === 'ready' || (engine.status === 'loading' && performance.now() - engine.askedAt < 60000)) return;
    if (engine.status === 'error' && performance.now() - engine.errorAt < 15000) return;
    engine.status = 'loading'; engine.askedAt = performance.now(); engine.error = '';
    send({ type: 'need-engine' });
  }

  function handleFillResult(kind, d) {
    if (kind === 'filled') {
      engine.filling = 0; engine.fillErrorAt = 0; engine.fillMs = d.ms;
      if (renderer && d.generation === roomGeneration) renderer.setFill(new Uint8Array(d.rgba), d.w, d.h);
      return;
    }
    if (d.generation != null && d.generation !== roomGeneration) return;
    engine.filling = 0; engine.fillErrorAt = performance.now(); engine.error = d.message;
    console.warn('[Snap Vanish] room fill:', d.message);
  }

  function attachEngine(port) {
    engine.port?.close();
    engine.port = port; engine.inFlight = null; engine.filling = 0; engine.timeouts = 0; engine.offscreenFill = false;
    port.onmessage = ({ data: d }) => {
      if (d.type === 'ready') { engine.status = 'ready'; engine.delegate = d.delegate; }
      else if (d.type === 'error') { engine.status = 'error'; engine.error = d.message; engine.errorAt = performance.now(); console.warn('[Snap Vanish] engine:', d.message); }
      else if (d.type === 'result') onResult(d);
      else if (d.type === 'filled' || d.type === 'fill-error') handleFillResult(d.type, d);
      else if (d.type === 'use-offscreen-fill') {
        engine.offscreenFill = true; engine.filling = 0; engine.fillErrorAt = 0; engine.error = '';
        lastKnown = -1; lastFillSent = 0;
        safeTick();
      }
    };
    port.postMessage({ type: 'init' });
  }

  let roomGeneration = 0;
  function forgetRoom() {
    roomGeneration++;
    renderer?.forgetRoom();
    lastKnown = -1; lastFillSent = 0; engine.filling = 0; engine.fillErrorAt = 0;
  }

  function requestFill(now, force) {
    if (!renderer || engine.status !== 'ready' || engine.filling || renderer.analysisCount < 4) return;
    if (engine.fillErrorAt && now - engine.fillErrorAt < 3000) return;
    if (!force && now - lastFillCheck < (renderer.hasFill ? 8000 : 300)) return;
    lastFillCheck = now;
    const req = renderer.inpaintRequest();
    if (!force && renderer.hasFill && Math.abs(req.known - lastKnown) < 0.015 && now - lastFillSent < 40000) return;
    lastKnown = req.known; lastFillSent = now; engine.filling = now;
    if (engine.offscreenFill) {
      send({ type: 'offscreen-inpaint', generation: roomGeneration, w: req.w, h: req.h, rgba: req.rgba.buffer }, [req.rgba.buffer]);
    } else {
      engine.port.postMessage({ type: 'inpaint', generation: roomGeneration, w: req.w, h: req.h, rgba: req.rgba.buffer }, [req.rgba.buffer]);
    }
  }

  function analyse(frame, now) {
    if (engine.inFlight) {
      if (now - engine.inFlight.at > 6000) { engine.inFlight = null; if (++engine.timeouts >= 3) { engine.status = 'off'; ensureEngine(); } }
      return;
    }
    if (engine.status !== 'ready' || now - engine.lastSend < 33) return;
    if (frame.displayWidth <= 0 || frame.displayHeight <= 0) return;
    engine.lastSend = now;
    const frameIdx = engine.count++;
    const needLearn = !renderer.hasFill || renderer.analysisCount < 6 || !!state.captureAt;
    const wantMask = needLearn
      || state.phase === 'pending'
      || state.phase === 'returning'
      || (state.phase === 'vanished' || state.phase === 'vanishing'
        ? (now - renderer.analysisAt >= 850)
        : (frameIdx % 10 === 0 || now - renderer.analysisAt >= 450));
    const request = engine.inFlight = { id: engine.count, at: now, wantMask };
    if (wantMask) renderer.stage(frame);
    const copy = frame.clone();
    const isFast = engine.delegate === 'GPU' ? (engine.fps === 0 || engine.fps >= 14) : engine.fps >= 18;
    const targetW = (engine.fps > 0 && engine.fps < 12) ? 512 : isFast ? 896 : 640;
    const width = Math.min(targetW, copy.displayWidth);
    createImageBitmap(copy, {
      resizeWidth: width,
      resizeHeight: Math.max(1, Math.round(width * copy.displayHeight / copy.displayWidth)),
      resizeQuality: 'medium'
    })
      .then(bitmap => {
        if (engine.inFlight !== request || engine.status !== 'ready' || !engine.port) {
          bitmap.close();
          return;
        }
        try {
          engine.port.postMessage({ type: 'frame', id: request.id, bitmap, ts: now, wantMask }, [bitmap]);
        } catch {
          bitmap.close();
          if (engine.inFlight === request) engine.inFlight = null;
        }
      })
      .catch(() => { if (engine.inFlight === request) engine.inFlight = null; })
      .finally(() => copy.close());
  }

  function onResult(d) {
    const req = engine.inFlight;
    if (!req || req.id !== d.id) return;
    engine.inFlight = null; engine.timeouts = 0;
    const gap = performance.now() - engine.lastResult;
    engine.lastResult = performance.now();
    if (gap < 3000) engine.fps = engine.fps ? engine.fps * 0.9 + 100 / gap : 1000 / gap;
    if (!renderer || !settings.enabled) { lastHands = []; return; }
    const candidate = detector.update(d.hands, req.at, settings.sensitivity);
    if (candidate) fusion.addVisual(candidate);
    lastHands = settings.debugHands ? detector.smoothed : [];
    if (settings.debugHands) {
      const nowDbg = performance.now();
      send({
        type: 'debug-hands',
        debug: {
          hands: lastHands,
          hand: detector.debug,
          snapAgo: lastSnapAt ? Math.round(nowDbg - lastSnapAt) : -1,
          note: detector.lastNote,
          fusion: fusion.lastMatch,
          processed: listener.processed,
          click: listener.clicks?.diag || null
        }
      });
    }
    if (d.mask && !renderer.lost) {
      const boxes = d.hands.map(h => {
        const xs = h.norm.map(p => p.x), ys = h.norm.map(p => p.y);
        const b = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
        const mx = (b[2] - b[0]) * 0.25, my = (b[3] - b[1]) * 0.25;
        return [b[0] - mx, b[1] - my, b[2] + mx, b[3] + my];
      });
      const now = performance.now();
      const capturing = state.captureAt && now >= state.captureAt;
      renderer.commit(new Uint8Array(d.mask), d.mw, d.mh, boxes, capturing);
      if (capturing && now >= state.captureAt + 800) {
        state.captureAt = 0;
        say('Empty room captured. You can sit down again.');
        requestFill(now, true);
      }
    }
  }

  // ───────────────────────── Snap state machine ─────────────────────────
  function go(phase) { state.phase = phase; state.since = performance.now(); }
  function clearLastOutput() { lastOutput?.close(); lastOutput = null; }

  function restore(note) {
    go('idle');
    clearLastOutput();
    setMuted(false);
    if (note) say(note);
  }

  function snap(source) {
    if (!settings.enabled) return;
    const now = performance.now();
    if (source === 'gesture' && now - state.since < 800) return;
    const camera = livePipelines().length > 0;
    switch (state.phase) {
      case 'idle':
        if (!camera) return say('Turn your camera on first.');
        if (engine.status === 'error') return say('AI engine failed to load: ' + engine.error);
        state.captureAt = 0;
        setMuted(true);
        go('pending');
        say('Snap!');
        ensureEngine();
        safeTick();
        break;
      case 'pending':
        restore('Cancelled.');
        break;
      case 'vanished':
        if (camera && renderer && !renderer.lost && now - renderer.analysisAt < 1500) {
          renderer.beginReturn();
          go('returning');
          say('Snap! Coming back.');
        } else restore('You are back.');
        break;
    }
  }

  function tick() {
    const now = performance.now(), elapsed = now - state.since, dur = settings.duration * 1000;
    if (settings.enabled) fusion.poll(now);
    if (state.phase === 'pending') {
      if (renderer && !renderer.lost && renderer.hasFill && now - renderer.analysisAt < 1500) {
        renderer.beginVanish();
        clearLastOutput();
        go('vanishing');
        say('Vanished. Mic muted.');
      } else if (engine.status === 'error') restore('AI engine failed to load: ' + engine.error);
      else if (elapsed > 30000) restore('Could not build the empty room in time. Try again.');
      else requestFill(now, !renderer?.hasFill);
    } else if (state.phase === 'vanishing' && elapsed >= dur) go('vanished');
    else if (state.phase === 'returning' && elapsed >= dur) restore('You are back. Mic restored.');
    else if (state.phase === 'idle' && settings.enabled) requestFill(now, false);
    if (engine.filling && now - engine.filling > 90000) engine.filling = 0;
  }

  function safeTick() {
    try { tick(); } catch (e) { console.warn('[Snap Vanish] tick:', e); }
  }

  // ───────────────────────── Camera pipeline ─────────────────────────
  const pipelines = new Set();
  const livePipelines = () => [...pipelines].filter(p => p.source.readyState === 'live');
  let primary = null;
  let lastOutput = null;   // newest composed frame, shared with any extra camera tracks

  function pickPrimary(p, now) {
    if (primary === p) return true;
    if (!primary || !pipelines.has(primary) || now - primary.lastFrame > 700 || p.area > primary.area) {
      primary = p;
      return true;
    }
    return false;
  }

  // Returns the frame to send to the meeting, or null to hold the previous one.
  function processFrame(p, frame) {
    const now = performance.now();
    p.lastFrame = now;
    p.area = frame.displayWidth * frame.displayHeight;
    const active = () => state.phase === 'vanishing' || state.phase === 'vanished' || state.phase === 'returning';
    try {
      if (!settings.enabled) return frame;
      ensureEngine();
      const isPrimary = pickPrimary(p, now);
      if (isPrimary) {
        if (!renderer || (renderer.lost && !active())) { renderer = new SV.Renderer(); lastKnown = -1; }
        if (renderer.lost) return null;
        if (renderer.setSize(frame.displayWidth, frame.displayHeight)) engine.inFlight = null;
        analyse(frame, now);
        tick();
      }
      if (!active()) return frame;
      const meta = { timestamp: frame.timestamp };
      if (frame.duration != null) meta.duration = frame.duration;
      if (!isPrimary) {
        const out = lastOutput ? new VideoFrame(lastOutput, meta) : null;
        return out;
      }
      const progress = Math.min(1, (now - state.since) / (settings.duration * 1000));
      if (state.phase === 'vanished') renderer.renderEmpty();
      else if (state.phase === 'vanishing') renderer.renderDust(progress, settings.direction, false, frame);
      else renderer.renderDust(1 - progress, settings.direction, true, frame);
      const out = new VideoFrame(renderer.canvas, meta);
      lastOutput?.close();
      lastOutput = out.clone();
      return out;
    } catch (e) {
      console.warn('[Snap Vanish] frame:', e);
      say('Video error: ' + e.message);
      // Never show you by accident: while vanished, freeze instead of passing the camera through.
      return active() ? null : frame;
    }
  }

  function createPipeline(source) {
    const generator = new MediaStreamTrackGenerator({ kind: 'video' });
    const reader = new MediaStreamTrackProcessor({ track: source }).readable.getReader();
    const writer = generator.writable.getWriter();
    const p = { source, generator, lastFrame: 0, area: 0 };
    pipelines.add(p);

    const close = () => {
      if (!pipelines.delete(p)) return;
      nativeStop.call(source);
      reader.cancel().catch(() => {});
      writer.close().catch(() => {});
      if (primary === p) primary = null;
      if (!pipelines.size) {
        clearLastOutput();
        state.captureAt = 0;
        lastHands = [];
      }
      syncListener();
    };

    const define = (name, value) => Object.defineProperty(generator, name, { configurable: true, writable: true, value });
    Object.defineProperty(generator, 'label', { configurable: true, get: () => source.label });
    define('getSettings', () => source.getSettings());
    define('getCapabilities', () => source.getCapabilities?.() ?? {});
    define('getConstraints', () => source.getConstraints());
    define('applyConstraints', c => source.applyConstraints(c));
    define('stop', () => { nativeStop.call(generator); close(); });
    define('clone', () => {
      const twin = createPipeline(nativeClone.call(source));
      twin.enabled = generator.enabled;
      return twin;
    });

    (async () => {
      try {
        for (;;) {
          const { value: frame, done } = await reader.read();
          if (done) break;
          if (generator.readyState === 'ended') { frame.close(); break; }
          const out = processFrame(p, frame);
          if (out !== frame) frame.close();
          if (out) {
            try { await writer.write(out); } catch (writeErr) { out.close(); throw writeErr; }
          }
        }
      } catch (e) {
        if (pipelines.has(p)) console.warn('[Snap Vanish] pipeline:', e);
      } finally {
        const wasLive = pipelines.has(p);
        close();
        if (wasLive) generator.dispatchEvent(new Event('ended'));
      }
    })();
    return generator;
  }

  const isScreenCapture = c => !!(c?.video?.mandatory?.chromeMediaSource || c?.video?.chromeMediaSource);

  MediaDevices.prototype.getUserMedia = async function getUserMedia(constraints) {
    const stream = await nativeGUM.call(this, constraints);
    try {
      const tracks = stream.getTracks().map(t => {
        if (t.kind === 'audio') return guardAudio(t);
        return isScreenCapture(constraints) ? t : createPipeline(t);
      });
      syncListener();
      if (settings.enabled && stream.getVideoTracks().length) ensureEngine();
      return new MediaStream(tracks);
    } catch (e) {
      console.warn('[Snap Vanish] could not attach:', e);
      return stream;
    }
  };

  MediaStream.prototype.clone = function clone() {
    const ours = this.getTracks().some(t => Object.prototype.hasOwnProperty.call(t, 'clone'));
    return ours ? new MediaStream(this.getTracks().map(t => t.clone())) : nativeStreamClone.call(this);
  };

  // ───────────────────────── Messages from the popup ─────────────────────────
  window.addEventListener('message', e => {
    const d = e.data;
    if (e.source !== window || !d || d[TAG] !== 'to-main') return;
    if (d.type === 'engine-port' && e.ports[0]) attachEngine(e.ports[0]);
    else if (d.type === 'offscreen-filled') handleFillResult('filled', d);
    else if (d.type === 'offscreen-fill-error') handleFillResult('fill-error', d);
    else if (d.type === 'engine-error') {
      engine.status = 'error';
      engine.error = d.message || 'AI engine failed to load';
      engine.errorAt = performance.now();
    } else if (d.type === 'settings') {
      const wasEnabled = settings.enabled;
      Object.assign(settings, d.settings);
      if (!settings.enabled) {
        state.captureAt = 0;
        lastHands = [];
        fusion.pending = null;
        fusion.clicks.length = 0;
        if (state.phase !== 'idle') restore('Turned off.');
      }
      if (!settings.debugHands) lastHands = [];
      if (wasEnabled !== settings.enabled) { listener.retryAt = 0; syncListener(); }
    } else if (d.type === 'command') {
      if (d.command === 'snap') snap('manual');
      else if (d.command === 'relearn' && state.phase === 'idle') { state.captureAt = 0; forgetRoom(); say('Learning the room again.'); }
      else if (d.command === 'capture' && state.phase === 'idle' && livePipelines().length) {
        forgetRoom();
        state.captureAt = performance.now() + 5000;
        say('Step out of the picture now.');
      }
    }
  });

  let wasStatusActive = false;
  setInterval(() => {
    const activeFrame = pipelines.size > 0 || state.phase !== 'idle';
    if (!activeFrame) {
      if (wasStatusActive) { wasStatusActive = false; send({ type: 'status', status: null }); }
      return;
    }
    wasStatusActive = true;
    safeTick();
    const now = performance.now();
    if (livePipelines().length && settings.enabled && listener.state !== 'listening' && now >= listener.retryAt) syncListener();
    send({
      type: 'status',
      status: {
        phase: state.phase,
        muted: state.muted,
        note: state.note,
        camera: livePipelines().length > 0,
        mic: listener.state,
        engine: engine.status,
        engineError: engine.error,
        room: renderer?.hasFill ? 'ready' : 'learning',
        known: Math.max(0, lastKnown),
        fillMs: engine.fillMs,
        analyses: engine.count,
        fps: Math.round(engine.fps),
        delegate: engine.delegate,
        countdown: state.captureAt > now ? Math.ceil((state.captureAt - now) / 1000) : 0,
        hand: detector.debug,
        debug: settings.debugHands ? {
          hands: lastHands,
          snapAgo: lastSnapAt ? Math.round(now - lastSnapAt) : -1,
          note: detector.lastNote,
          fusion: fusion.lastMatch,
          processed: listener.processed,
          click: listener.clicks?.diag || null
        } : null
      }
    });
  }, 300);

  send({ type: 'hello' });
})();
