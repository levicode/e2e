/** Shared public fixture: input and frame button have distinct hit targets. */
export function primitiveFixtureDocument(path: string): string {
  return `<!doctype html><title>Fixture ${path}</title><script>
  globalThis.fixtureAtFirstScript = globalThis.fixtureInit?.marker ?? '';
  (() => {
    const kind = ${JSON.stringify(path === '/popup' ? 'popup' : path === '/frame' ? 'frame' : 'main')};
    const send = phase => {
      try {
      const marker = globalThis.fixtureAtFirstScript === 'synthetic' ? 'match' : globalThis.fixtureAtFirstScript === '' ? 'absent' : 'other';
      navigator.sendBeacon('/__pair_facts', JSON.stringify({kind, phase, marker, ready: document.readyState}));
      } catch { /* Diagnostic failure never changes fixture behavior. */ }
    };
    send('first-script');
    const dispose = () => { try { removeEventListener('DOMContentLoaded', loaded); } catch {} try { removeEventListener('pagehide', dispose); } catch {} };
    const loaded = () => { try { send('dom-content-loaded'); } finally { dispose(); } };
    try {
      addEventListener('DOMContentLoaded', loaded, { once: true, passive: true });
      addEventListener('pagehide', dispose, { once: true, passive: true });
    } catch { dispose(); }
  })();
  globalThis.fixtureKeys = []; globalThis.fixturePointer = [];
  sessionStorage.setItem('loads', String(Number(sessionStorage.getItem('loads') ?? 0) + 1));
  addEventListener('keydown', event => fixtureKeys.push('keydown:' + event.key));
  addEventListener('keyup', event => fixtureKeys.push('keyup:' + event.key));
  addEventListener('mousedown', event => fixturePointer.push('down:' + event.clientX + ':' + event.clientY + ':' + event.buttons));
  addEventListener('mouseup', event => fixturePointer.push('up:' + event.clientX + ':' + event.clientY + ':' + event.buttons));
  addEventListener('wheel', event => { if (event.isTrusted) fixturePointer.push('wheel:' + event.deltaY); });
  </script><body data-init=""><input id="input" class="fixture-input" style="position:absolute;left:10px;top:10px"><button id="frame-button" style="position:absolute;left:10px;top:50px" onclick="this.dataset.clicked='yes'">Inside frame</button>${path === '/a' ? '<iframe src="/frame" style="position:absolute;left:400px;top:100px"></iframe>' : ''}<script>document.body.dataset.init = globalThis.fixtureAtFirstScript;</script>`;
}
