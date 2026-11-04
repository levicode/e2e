/** Shared public fixture: input and frame button have distinct hit targets. */
export function primitiveFixtureDocument(path: string): string {
  return `<!doctype html><title>Fixture ${path}</title><script>
  globalThis.fixtureAtFirstScript = globalThis.fixtureInit?.marker ?? '';
  globalThis.fixtureKeys = []; globalThis.fixturePointer = [];
  sessionStorage.setItem('loads', String(Number(sessionStorage.getItem('loads') ?? 0) + 1));
  addEventListener('keydown', event => fixtureKeys.push('keydown:' + event.key));
  addEventListener('keyup', event => fixtureKeys.push('keyup:' + event.key));
  addEventListener('mousedown', event => fixturePointer.push('down:' + event.clientX + ':' + event.clientY + ':' + event.buttons));
  addEventListener('mouseup', event => fixturePointer.push('up:' + event.clientX + ':' + event.clientY + ':' + event.buttons));
  addEventListener('wheel', event => { if (event.isTrusted) fixturePointer.push('wheel:' + event.deltaY); });
  </script><body data-init=""><input id="input" class="fixture-input" style="position:absolute;left:10px;top:10px"><button id="frame-button" style="position:absolute;left:10px;top:50px" onclick="this.dataset.clicked='yes'">Inside frame</button>${path === '/a' ? '<iframe src="/frame" style="position:absolute;left:400px;top:100px"></iframe>' : ''}<script>document.body.dataset.init = globalThis.fixtureAtFirstScript;</script>`;
}

/** Snapshot only DOM-delivered events; returning a copy also fixes the observation instant. */
export function pointerEvents(): string[] {
  return [...(globalThis as unknown as { fixturePointer: string[] }).fixturePointer];
}

/**
 * A wheel command can return before DOM delivery on both backends. Observe the
 * real listener for at most one second, never dispatch an event or retry input.
 * Return the unchanged ledger on timeout so the exact event assertion still fails.
 * This callback must be self-contained because both browser APIs serialize it.
 */
export function waitForPointerWheel(timeoutMs: number): Promise<string[]> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 1_000) {
    throw new RangeError('Wheel witness must be bounded by 1,000 ms');
  }
  const page = globalThis as unknown as {
    fixturePointer: string[];
    addEventListener(type: 'wheel', listener: (event: { isTrusted: boolean }) => void): void;
    removeEventListener(type: 'wheel', listener: (event: { isTrusted: boolean }) => void): void;
  };
  const snapshot = (): string[] => [...page.fixturePointer];
  const events = snapshot();
  if (events.some(value => value.startsWith('wheel:'))) return Promise.resolve(events);
  return new Promise(resolve => {
    const finish = (): void => {
      clearTimeout(timer);
      page.removeEventListener('wheel', onWheel);
      resolve(snapshot());
    };
    const onWheel = (event: { isTrusted: boolean }): void => { if (event.isTrusted) finish(); };
    const timer = setTimeout(finish, timeoutMs);
    page.addEventListener('wheel', onWheel);
  });
}
