// Passes the keyboard shortcut to every tab that is using the camera, and hosts the offscreen fill relay.
chrome.commands.onCommand.addListener(async command => {
  if (command !== 'snap-now') return;
  const { enabled = true } = await chrome.storage.local.get('enabled');
  if (!enabled) return;
  const msg = { target: 'snap-vanish', command: 'snap' };
  const tabs = await chrome.tabs.query({ url: chrome.runtime.getManifest().host_permissions });
  for (const tab of tabs) chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
  chrome.runtime.sendMessage(msg).catch(() => {});   // practice room
});

let creatingOffscreen = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'engine/offscreen.html',
      reasons: [chrome.offscreen.Reason?.WORKERS || 'WORKERS'],
      justification: 'Run local AI room-fill worker when a call site blocks in-frame workers.'
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.target !== 'snap-vanish-bg' || msg.type !== 'inpaint') return;
  (async () => {
    await ensureOffscreen();
    return await chrome.runtime.sendMessage({ ...msg, target: 'snap-vanish-offscreen' });
  })().then(reply, err => reply({ type: 'fill-error', generation: msg.generation, message: String(err?.message || err) }));
  return true;
});
