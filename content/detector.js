// Finger-snap detection. Pure logic, no browser APIs, so it can be unit tested.
// Vision decides; the microphone click only confirms.
(() => {
  const SV = (globalThis.__snapVanish ||= {});

  // MediaPipe z-depth is noisier than image x/y, so dampen dz to reduce tilt jitter.
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, ((a.z || 0) - (b.z || 0)) * 0.35);
  const lerp = (a, b, t) => a + (b - a) * t;

  // sensitivity: 1 (strict) .. 10 (forgiving)
  function params(sensitivity) {
    const s = (Math.min(10, Math.max(1, sensitivity)) - 1) / 9;
    return {
      touchOn: lerp(0.34, 0.46, s),      // thumb tip to middle tip, in palm lengths (always < releaseSep)
      releaseSep: lerp(0.58, 0.51, s),   // absolute separation threshold
      minSepJump: lerp(0.16, 0.08, s),   // relative separation from tightest pinch
      armMinPalm: 0.52,                  // middle finger must start away from the palm
      slapMax: lerp(0.84, 1.02, s),      // ...and move toward the palm
      minDrop: lerp(0.20, 0.11, s),      // minimum middle-finger drop toward the palm
      maxGapMs: lerp(260, 450, s),       // last "touching" frame to "released" frame
      armFrames: sensitivity >= 5 ? 1 : 2,
      clickRatio: lerp(9.5, 3.2, s),     // click loudness over background noise
      clickMinPeak: lerp(0.032, 0.005, s)
    };
  }

  // 21 MediaPipe landmarks: 0 wrist, 4 thumb tip, 9 middle knuckle, 12 middle tip
  function features(pts) {
    const scale = dist(pts[0], pts[9]) || 1e-6;
    const base = { x: 0, y: 0, z: 0 };
    for (const i of [0, 1, 2, 5]) {
      base.x += pts[i].x / 4; base.y += pts[i].y / 4; base.z += (pts[i].z || 0) / 4;
    }
    return { touch: dist(pts[4], pts[12]) / scale, palm: dist(pts[12], base) / scale };
  }

  class SnapDetector {
    constructor() { this.hands = []; this.smoothed = []; this.lastFire = -1e9; this.debug = null; this.lastNote = ''; }

    // hands: [{ world: [21 points in metres], norm: [21 points, 0..1 image coords], side?: 'Left'|'Right' }]
    update(hands, t, sensitivity = 5) {
      const p = params(sensitivity);
      this.hands = this.hands.filter(h => t - h.seen < 600);
      this.debug = null;
      const smoothed = [];
      let fired = null;
      const used = new Set();
      for (const hand of hands) {
        const wrist = hand.norm[0];
        const size = Math.hypot(hand.norm[9].x - wrist.x, hand.norm[9].y - wrist.y) || 0.05;
        const side = hand.side || '';
        let st = null, best = 0.35;
        for (const h of this.hands) {
          if (used.has(h)) continue;
          const d = Math.hypot(h.wrist.x - wrist.x, h.wrist.y - wrist.y);
          const mismatch = side && h.side && side !== h.side;
          if (mismatch && (hands.length > 1 || d >= 0.08)) continue;
          const score = d + (mismatch ? 0.27 : 0);
          if (score < best) { best = score; st = h; }
        }
        if (!st) { st = { count: 0, armed: null, side, smooth: null }; this.hands.push(st); }
        used.add(st);
        st.side = side || st.side || '';
        st.wrist = { x: wrist.x, y: wrist.y };
        st.seen = t;

        if (!st.smooth || st.smooth.length !== hand.norm.length) {
          st.smooth = hand.norm.map(pt => ({ x: pt.x, y: pt.y }));
        } else {
          for (let i = 0; i < hand.norm.length; i++) {
            const raw = hand.norm[i], prev = st.smooth[i];
            const move = Math.hypot(raw.x - prev.x, raw.y - prev.y) / size;
            const alpha = Math.min(1, 0.35 + (move / 0.14) * 0.65);
            prev.x = lerp(prev.x, raw.x, alpha);
            prev.y = lerp(prev.y, raw.y, alpha);
          }
        }

        const f = features(hand.world);
        const cur = { ...f, armed: false };

        if (f.touch < p.touchOn && f.palm > p.armMinPalm) {
          st.count++;
          if (st.count >= p.armFrames) {
            const prev = st.armed;
            st.armed = {
              at: t,
              palm: prev ? Math.max(prev.palm, f.palm) : f.palm,
              minTouch: prev ? Math.min(prev.minTouch, f.touch) : f.touch,
              wrist: st.wrist,
              size
            };
          }
        } else {
          st.count = 0;
          const a = st.armed;
          if (a) {
            const sepOk = f.touch > p.releaseSep || (f.touch - a.minTouch >= p.minSepJump && f.touch > p.touchOn);
            const dropOk = f.palm < p.slapMax && a.palm - f.palm >= p.minDrop;
            if (t - a.at > p.maxGapMs) {
              st.armed = null;                       // too slow to be a snap
              this.lastNote = 'Snap motion too slow';
            } else if (sepOk && dropOk) {
              const moved = Math.hypot(wrist.x - a.wrist.x, wrist.y - a.wrist.y) / a.size;
              st.armed = null;
              if (moved < 1.5 && !fired && t - this.lastFire > 700) { // waving moves the whole hand
                this.lastFire = t;
                fired = { armedAt: a.at, releasedAt: t };
                this.lastNote = 'Visual snap detected';
              } else if (moved >= 1.5) {
                this.lastNote = 'Hand moved too fast (waving)';
              }
            } else if (f.touch > p.touchOn && !sepOk) {
              this.lastNote = `Fingers didn't open enough (${f.touch.toFixed(2)})`;
            } else if (sepOk && !dropOk) {
              this.lastNote = `Middle finger didn't slap palm (drop ${(a.palm - f.palm).toFixed(2)})`;
            }
          }
        }
        cur.armed = !!st.armed;
        smoothed.push({
          side: st.side,
          armed: cur.armed,
          pts: st.smooth.map(pt => [Math.round(pt.x * 1000) / 1000, Math.round(pt.y * 1000) / 1000])
        });
        // Prefer reporting an armed hand (or closest-to-arming) instead of overwriting with a second idle hand.
        if (!this.debug || (cur.armed && !this.debug.armed) || (!this.debug.armed && cur.touch < this.debug.touch)) {
          this.debug = cur;
        }
      }
      this.smoothed = smoothed;
      return fired;
    }
  }

  // Finds short, sharp, high-frequency transients (a snap's "click").
  class ClickDetector {
    constructor(sampleRate, onClick) {
      this.sr = sampleRate;
      this.onClick = onClick;
      this.block = Math.max(1, Math.round(sampleRate * 0.0025));
      const w = 2 * Math.PI * 1500 / sampleRate, alpha = Math.sin(w) / (2 * Math.SQRT1_2), c = Math.cos(w), a0 = 1 + alpha;
      this.b0 = (1 + c) / 2 / a0; this.b1 = -(1 + c) / a0; this.b2 = this.b0;
      this.a1 = -2 * c / a0; this.a2 = (1 - alpha) / a0;
      this.x1 = this.x2 = this.y1 = this.y2 = 0;
      this.sum = 0; this.peak = 0; this.n = 0;
      this.floor = 0.002;
      this.history = [];
      this.cand = null;
      this.sensitivity = 5;
      this.diag = { peak: 0, floor: this.floor, ratio: 0, status: 'listening', at: 0 };
    }

    // endTime: timestamp (ms) of the last sample in this chunk
    process(samples, endTime) {
      const p = params(this.sensitivity);
      for (let i = 0; i < samples.length; i++) {
        const x = samples[i];
        if (!Number.isFinite(x)) { this.x1 = this.x2 = this.y1 = this.y2 = 0; continue; }
        const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
        if (!Number.isFinite(y)) { this.x1 = this.x2 = this.y1 = this.y2 = 0; continue; }
        this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
        this.sum += y * y;
        this.peak = Math.max(this.peak, Math.abs(y));
        if (++this.n === this.block) {
          this._block(Math.sqrt(this.sum / this.n), this.peak, endTime - (samples.length - i) / this.sr * 1000, p);
          this.sum = 0; this.peak = 0; this.n = 0;
        }
      }
    }

    _block(e, peak, t, p) {
      if (!Number.isFinite(e) || !Number.isFinite(peak)) return;
      // Exclude the last 2 blocks (5 ms) so pre-snap finger friction does not mask the click.
      const baseHist = this.history.length > 2 ? this.history.slice(0, -2) : this.history;
      const prev = baseHist.length ? baseHist.reduce((a, b) => a + b, 0) / baseHist.length : this.floor;
      if (!this.cand && e > this.floor * p.clickRatio && peak > p.clickMinPeak && e > 2.5 * prev) {
        this.cand = { t, max: e, maxPeak: peak, ratio: e / Math.max(this.floor, 1e-6), energies: [] };
      } else if (!this.cand && peak > 0.003 && e > this.floor * 2.5 && e > 2.0 * prev && (t - this.diag.at > 600 || peak > this.diag.peak * 0.5)) {
        this.diag = { peak, floor: this.floor, ratio: e / Math.max(this.floor, 1e-6), status: peak <= p.clickMinPeak ? `click too quiet (${peak.toFixed(3)})` : 'below snap threshold', at: t };
      }
      if (this.cand) {
        const c = this.cand;
        c.max = Math.max(c.max, e);
        c.maxPeak = Math.max(c.maxPeak, peak);
        c.ratio = Math.max(c.ratio, e / Math.max(this.floor, 1e-6));
        c.energies.push(e);
        if (c.energies.length >= 36) {          // 90 ms later it must have died away
          let loud = 0;
          for (const v of c.energies) if (v > 0.35 * c.max) loud++;
          let tailSum = 0;
          for (let i = c.energies.length - 8; i < c.energies.length; i++) tailSum += c.energies[i];
          const tail = tailSum / 8;
          const ok = tail < 0.36 * c.max && loud <= 16;
          this.diag = { peak: c.maxPeak, floor: this.floor, ratio: c.ratio, status: ok ? 'click heard' : (loud > 16 ? 'sound lasted too long' : 'too much echo'), at: c.t };
          if (ok) this.onClick(c.t);
          this.cand = null;
        }
      }
      this.floor += (e - this.floor) * (e < this.floor * 3 ? 0.02 : 0.0008);
      this.floor = Math.max(this.floor, 0.0004);
      this.history.push(e);
      if (this.history.length > 10) this.history.shift();
    }
  }

  // Accepts a visual snap only if a click was heard at the same moment.
  class SnapFusion {
    constructor(onSnap, onReject) { this.onSnap = onSnap; this.onReject = onReject; this.clicks = []; this.pending = null; this.lastMatch = ''; }
    addClick(t) {
      this.clicks.push(t);
      if (this.clicks.length > 20) this.clicks.shift();
      if (!this.pending) this.lastMatch = 'Click heard (no hand motion)';
      this._match();
    }
    addVisual(c) { this.pending = c; this.lastMatch = 'Visual snap (waiting for click)'; this._match(); }
    poll(now) {
      if (this.pending && now > this.pending.releasedAt + 650) {
        this.pending = null;
        this.lastMatch = 'Visual snap missed (no matching click)';
        this.onReject();
      }
    }
    _match() {
      const c = this.pending;
      if (!c) return;
      const i = this.clicks.findIndex(t => t >= c.armedAt - 200 && t <= c.releasedAt + 450);
      if (i >= 0) {
        this.clicks.splice(i, 1);
        this.pending = null;
        this.lastMatch = 'Snap matched!';
        this.onSnap();
      }
    }
  }

  Object.assign(SV, { SnapDetector, ClickDetector, SnapFusion, snapParams: params, handFeatures: features });
})();
