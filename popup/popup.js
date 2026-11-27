const DEFAULTS = { enabled: true, sensitivity: 5, duration: 2.5, direction: 'up-right', debugHands: false };
const $ = id => document.getElementById(id);
let settings = { ...DEFAULTS };
const dirty = new Set();
let targetTabId = null;

function showValues() {
  $('sensitivityOut').textContent = settings.sensitivity;
  $('durationOut').textContent = settings.duration + ' s';
}

function applySettingsToUI(s) {
  for (const k of ['enabled', 'debugHands']) {
    if (!dirty.has(k)) $(k).checked = !!s[k];
  }
  for (const k of ['sensitivity', 'duration', 'direction']) {
    if (!dirty.has(k)) $(k).value = s[k];
  }
  showValues();
}

chrome.storage.local.get(DEFAULTS).then(s => {
  for (const k of Object.keys(DEFAULTS)) {
    if (!dirty.has(k)) settings[k] = s[k];
  }
  applySettingsToUI(settings);
  refresh();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const [k, c] of Object.entries(changes)) {
    if (k in DEFAULTS) settings[k] = c.newValue ?? DEFAULTS[k];
  }
  applySettingsToUI(settings);
  if (changes.enabled || changes.debugHands) refresh();
});

for (const k of ['enabled', 'debugHands']) {
  $(k).addEventListener('change', e => {
    dirty.add(k);
    settings[k] = e.target.checked;
    chrome.storage.local.set({ [k]: settings[k] });
    refresh();
  });
}
for (const k of ['sensitivity', 'duration', 'direction']) {
  $(k).addEventListener('input', e => {
    dirty.add(k);
    settings[k] = k === 'direction' ? e.target.value : Number(e.target.value);
    chrome.storage.local.set({ [k]: settings[k] });
    showValues();
  });
}

// Talk to whichever single tab is using the camera (focused active tab first, including Practice Room).
async function ask(command) {
  const msg = { target: 'snap-vanish', command };
  if (command !== 'status' && targetTabId != null) {
    try {
      const r = await chrome.tabs.sendMessage(targetTabId, msg);
      if (r) return r;
    } catch {
      targetTabId = null;
    }
  }
  const urls = [...chrome.runtime.getManifest().host_permissions, chrome.runtime.getURL('practice/practice.html')];
  const [tabs, focusedActive] = await Promise.all([
    chrome.tabs.query({ url: urls }),
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => [])
  ]);
  const focusedId = focusedActive[0]?.id;
  tabs.sort((a, b) => ((b.id === focusedId) - (a.id === focusedId)) || (b.active - a.active));
  for (const tab of tabs) {
    try {
      const r = await chrome.tabs.sendMessage(tab.id, msg);
      if (r) { targetTabId = tab.id; return r; }
    } catch { /* tab without the camera */ }
  }
  targetTabId = null;
  return null;
}

const trigger = command => () => ask(command).then(() => { refresh(); setTimeout(refresh, 140); });
$('snap').addEventListener('click', trigger('snap'));
$('capture').addEventListener('click', trigger('capture'));
$('relearn').addEventListener('click', trigger('relearn'));
$('practice').addEventListener('click', async () => {
  const url = chrome.runtime.getURL('practice/practice.html');
  const existing = await chrome.tabs.query({ url });
  if (existing.length) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true }).catch(() => {});
  } else {
    chrome.tabs.create({ url });
  }
});
$('change').addEventListener('click', e => { e.preventDefault(); chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); });
chrome.commands.getAll().then(all => { $('shortcut').textContent = all.find(c => c.name === 'snap-now')?.shortcut || 'not set'; });

const PHASES = { idle: 'Visible', pending: 'Preparing the empty room…', vanishing: 'Turning to dust…', vanished: 'Vanished', returning: 'Coming back…' };

function setStatusText(text) {
  const el = $('status');
  if (el.textContent !== text) el.textContent = text;
}

let refreshing = false, refreshQueued = false;
async function refresh() {
  if (refreshing) { refreshQueued = true; return; }
  refreshing = true;
  try {
    if (!settings.enabled) {
      $('snap').disabled = $('capture').disabled = $('relearn').disabled = true;
      setStatusText('Off. Your camera passes through unchanged.');
      return;
    }
    const s = await ask('status').catch(() => null);
    $('snap').disabled = !s || s.phase === 'vanishing' || s.phase === 'returning' || (s.phase === 'idle' && !s.camera);
    $('capture').disabled = $('relearn').disabled = !s || s.phase !== 'idle' || !s.camera || s.countdown > 0;
    if (!s) {
      setStatusText('No camera in use.\nJoin a call (reload the tab if it was already open) or open the practice room.');
      return;
    }
    const lines = [`${PHASES[s.phase]} · mic ${s.muted ? 'muted by Snap Vanish' : 'normal'}`];
    if (!s.camera) lines.push('Camera is off.');
    else if (s.engine === 'error') lines.push('AI failed to load: ' + s.engineError);
    else if (s.engine === 'off') lines.push('AI engine standby.');
    else if (s.engine !== 'ready') lines.push('Loading AI models…');
    else lines.push(`Room: ${s.room === 'ready' ? 'ready' : 'learning…'} · mic listener: ${s.mic}`);
    if (s.camera && s.fps && s.fps < 12) lines.push(`Hand tracking is slow (${s.fps} fps). Use the shortcut if snaps are missed.`);
    if (s.countdown) lines.push(`Step out! Capturing in ${s.countdown}…`);
    else if (s.note) lines.push(s.note);
    if (settings.debugHands && s.debug) {
      const dbg = s.debug;
      const count = dbg.hands?.length || 0;
      const handPart = count
        ? `Debug: ${count} hand${count > 1 ? 's' : ''}${s.hand?.armed ? ' (ARMED)' : ''} · gap ${s.hand ? s.hand.touch.toFixed(2) : '-'}`
        : 'Debug: 0 hands';
      const clickPart = dbg.click ? `Click peak ${dbg.click.peak.toFixed(3)} (${dbg.click.status})` : 'Click: waiting';
      lines.push(handPart);
      lines.push(dbg.fusion ? `${clickPart} · ${dbg.fusion}` : clickPart);
      if (dbg.processed) lines.push('Mic browser noise filter is active (may dampen snaps).');
    }
    setStatusText(lines.join('\n'));
  } finally {
    refreshing = false;
    if (refreshQueued) { refreshQueued = false; refresh(); }
  }
}
setInterval(refresh, 500);
