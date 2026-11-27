const $ = id => document.getElementById(id);
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17]
];

let enabled = true;
let debugHands = false;
let debugHandsDirty = false;
let lastStatus = null;
let lastDebug = null;
let stopMeter = null;

function clearOverlay() {
  const canvas = $('overlay');
  canvas.hidden = true;
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function drawOverlay(dbg) {
  const canvas = $('overlay'), video = $('video');
  if (!debugHands || !window.practiceStream) { clearOverlay(); return; }
  canvas.hidden = false;
  const cw = canvas.clientWidth || 640, ch = canvas.clientHeight || 360;
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, cw, ch);

  const vw = video.videoWidth || cw, vh = video.videoHeight || ch;
  const scale = Math.min(cw / vw, ch / vh);
  const rw = vw * scale, rh = vh * scale;
  const ox = (cw - rw) / 2, oy = (ch - rh) / 2;
  const mirrored = $('mirror').checked;
  const mapX = nx => ox + (mirrored ? 1 - nx : nx) * rw;
  const mapY = ny => oy + ny * rh;

  const hands = dbg?.hands || [];
  const armed = !!dbg?.hand?.armed;
  const snapped = dbg?.snapAgo >= 0 && dbg.snapAgo < 1200;

  for (const entry of hands) {
    const pts = Array.isArray(entry) ? entry : entry?.pts;
    if (!pts || pts.length < 21) continue;
    const handArmed = Array.isArray(entry) ? armed : !!(entry?.armed ?? armed);
    const side = Array.isArray(entry) ? '' : (entry?.side || '');
    ctx.strokeStyle = (snapped || handArmed) ? '#6fd08c' : '#f09a45';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.moveTo(mapX(pts[a][0]), mapY(pts[a][1]));
      ctx.lineTo(mapX(pts[b][0]), mapY(pts[b][1]));
    }
    ctx.stroke();

    // Highlight thumb tip (4) to middle finger tip (12) pinch line
    ctx.strokeStyle = handArmed ? '#ffffff' : '#ffcf86';
    ctx.lineWidth = handArmed ? 3.5 : 2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(mapX(pts[4][0]), mapY(pts[4][1]));
    ctx.lineTo(mapX(pts[12][0]), mapY(pts[12][1]));
    ctx.stroke();
    ctx.setLineDash([]);

    for (let i = 0; i < pts.length; i++) {
      const x = mapX(pts[i][0]), y = mapY(pts[i][1]);
      const isSnapFinger = i === 4 || i === 12;
      ctx.beginPath();
      ctx.arc(x, y, isSnapFinger ? 6 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = isSnapFinger ? (handArmed ? '#6fd08c' : '#ff5f56') : '#f4eefa';
      ctx.fill();
    }

    if (side) {
      const tag = side[0].toUpperCase();
      const wx = mapX(pts[0][0]), wy = Math.min(ch - 6, mapY(pts[0][1]) + 18);
      ctx.font = '700 11px system-ui, sans-serif';
      const twTag = ctx.measureText(tag).width;
      ctx.fillStyle = 'rgba(23, 19, 28, 0.82)';
      ctx.fillRect(wx - twTag / 2 - 5, wy - 11, twTag + 10, 15);
      ctx.fillStyle = (snapped || handArmed) ? '#6fd08c' : '#f4eefa';
      ctx.fillText(tag, wx - twTag / 2, wy);
    }
  }

  // Top-left status pill (always readable left-to-right)
  const label = snapped
    ? 'HAND TRACKING ON · SNAP FIRED!'
    : armed
      ? 'HAND TRACKING ON · ARMED (READY TO SNAP)'
      : `HAND TRACKING ON · ${hands.length} hand${hands.length === 1 ? '' : 's'}`;
  ctx.font = '600 12px system-ui, sans-serif';
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(23, 19, 28, 0.78)';
  ctx.fillRect(10, 10, tw + 18, 26);
  ctx.fillStyle = (armed || snapped) ? '#6fd08c' : '#f09a45';
  ctx.fillText(label, 19, 27);
}

function updateControls() {
  const live = !!window.practiceStream?.getTracks().some(t => t.readyState === 'live');
  $('start').disabled = live;
  const s = lastStatus;
  $('snap').disabled = !live || !enabled || !s || s.phase === 'vanishing' || s.phase === 'returning' || (s.phase === 'idle' && !s.camera);
}

function renderInfo() {
  const live = !!window.practiceStream?.getTracks().some(t => t.readyState === 'live');
  if (!live) {
    $('info').textContent = 'Click “Start camera” and allow camera and microphone.';
    return;
  }
  if (!enabled) {
    $('info').textContent = 'Snap Vanish is turned off in the popup. Turn it back on to test snapping.';
    return;
  }
  const s = lastStatus;
  if (!s) return;
  const h = s.hand;
  const lines = [
    `State: ${s.phase}${s.muted ? ' (mic muted)' : ''}`,
    `AI: ${s.engine}${s.engineError ? ' – ' + s.engineError : ''}   Room: ${s.room} (${Math.round(s.known * 100)}% seen for real)   Mic listener: ${s.mic}`,
    h ? `Hand: thumb–middle gap ${h.touch.toFixed(2)}, middle–palm ${h.palm.toFixed(2)}${h.armed ? '  ● ready to snap' : ''}` : 'Hand: not in view',
    s.fps ? `Hand tracking: ${s.fps} frames per second (${s.delegate})${s.fps < 12 ? ' – too slow for reliable snaps, close other apps' : ''}` : '',
    s.countdown ? `Step out! Capturing in ${s.countdown}…` : s.note
  ];
  if (debugHands && lastDebug) {
    const c = lastDebug.click;
    lines.push(
      `Debug motion: ${lastDebug.note || 'none'}  |  Click: ${c ? `peak ${c.peak.toFixed(3)}, floor ${c.floor.toFixed(4)} (${c.status})` : 'listening…'}`
      + (lastDebug.fusion ? `  |  ${lastDebug.fusion}` : '')
      + (lastDebug.processed ? '  |  Warning: browser noise suppression active' : '')
    );
  }
  $('info').textContent = lines.filter(Boolean).join('\n');
}

chrome.storage?.local.get({ enabled: true, debugHands: false }).then(s => {
  enabled = !!s.enabled;
  if (!debugHandsDirty) {
    debugHands = !!s.debugHands;
    $('debugHands').checked = debugHands;
  }
  updateControls();
  renderInfo();
  drawOverlay(lastDebug);
});

chrome.storage?.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.enabled) enabled = !!changes.enabled.newValue;
  if (changes.debugHands) {
    debugHands = !!changes.debugHands.newValue;
    $('debugHands').checked = debugHands;
    if (!debugHands) lastDebug = null;
    drawOverlay(lastDebug);
  }
  updateControls();
  renderInfo();
});

$('debugHands').addEventListener('change', e => {
  debugHandsDirty = true;
  debugHands = e.target.checked;
  if (!debugHands) lastDebug = null;
  chrome.storage?.local.set({ debugHands });
  drawOverlay(lastDebug);
  renderInfo();
});

function stopStreamUI() {
  stopMeter?.();
  stopMeter = null;
  window.practiceStream = null;
  $('video').srcObject = null;
  lastStatus = null;
  lastDebug = null;
  clearOverlay();
  updateControls();
  renderInfo();
}

$('start').addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true });
    window.practiceStream = stream;
    $('video').srcObject = stream;
    for (const t of stream.getTracks()) {
      t.addEventListener('ended', () => {
        if (!stream.getTracks().some(tr => tr.readyState === 'live')) stopStreamUI();
      });
    }
    updateControls();
    renderInfo();
    meter(stream);
    drawOverlay(lastDebug);
  } catch (e) {
    $('info').textContent = 'Could not start camera/microphone: ' + e.message;
  }
});
$('mirror').addEventListener('change', e => {
  $('video').classList.toggle('mirror', e.target.checked);
  drawOverlay(lastDebug);
});
$('snap').addEventListener('click', () => window.postMessage({ __snapVanishMsg: 'to-main', type: 'command', command: 'snap' }, '*'));

// Level of the audio track a meeting would receive: it drops to zero while muted.
async function meter(stream) {
  stopMeter?.();
  const track = stream.getAudioTracks()[0];
  if (!track) return;
  let ctx = null, id = 0;
  try {
    ctx = new AudioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    const analyser = ctx.createAnalyser();
    ctx.createMediaStreamSource(new MediaStream([track])).connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    id = setInterval(() => {
      analyser.getFloatTimeDomainData(data);
      const rms = Math.sqrt(data.reduce((a, v) => a + v * v, 0) / data.length);
      const pct = Math.min(100, Math.round(rms * 500));
      $('level').style.width = pct + '%';
      $('level').setAttribute('aria-valuenow', String(pct));
    }, 60);
    stopMeter = () => {
      clearInterval(id);
      $('level').style.width = '0%';
      $('level').setAttribute('aria-valuenow', '0');
      ctx?.close().catch(() => {});
    };
  } catch (e) {
    console.warn('[Snap Vanish] meter:', e);
    ctx?.close().catch(() => {});
  }
}

window.addEventListener('message', e => {
  const d = e.data;
  if (e.source !== window || d?.__snapVanishMsg !== 'to-bridge') return;
  if (d.type === 'debug-hands') {
    if (!debugHands) return;
    lastDebug = d.debug;
    drawOverlay(lastDebug);
    renderInfo();
    return;
  }
  if (d.type !== 'status') return;
  if (!d.status) {
    if (!window.practiceStream?.getTracks().some(t => t.readyState === 'live')) stopStreamUI();
    else { lastStatus = null; updateControls(); }
    return;
  }
  lastStatus = d.status;
  if (d.status.debug) lastDebug = { ...d.status.debug, hand: d.status.hand };
  else if (!debugHands) lastDebug = null;
  updateControls();
  drawOverlay(lastDebug);
  renderInfo();
});
