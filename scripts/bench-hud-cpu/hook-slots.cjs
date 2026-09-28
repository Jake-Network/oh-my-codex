const [sessionId, windowId, leaderPaneId] = process.argv.slice(2);

if (!/^\$\d+$/.test(sessionId ?? '') || !/^@\d+$/.test(windowId ?? '') || !/^%\d+$/.test(leaderPaneId ?? '')) {
  process.exit(2);
}

const normalize = value => value.trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
const hookName = ['omx_hud_resize', sessionId, windowId, leaderPaneId].map(normalize).join('_');
let hash = 0;
for (let index = 0; index < hookName.length; index += 1) {
  hash = (Math.imul(hash, 31) + hookName.charCodeAt(index)) | 0;
}
const slot = Math.abs(hash) % 2147483647;
const slots = [`client-resized[${slot}]`, `window-layout-changed[${slot}]`, `after-split-window[${slot}]`];
const identityToken = hookSlot => {
  let identityHash = 2166136261;
  for (const char of `${hookName}:${hookSlot}`) {
    identityHash = Math.imul(identityHash ^ char.charCodeAt(0), 16777619);
  }
  return `omx-${(identityHash >>> 0).toString(16)}`;
};
process.stdout.write(`${slots.join(' ')} ${slots.map(identityToken).join(' ')}\n`);
