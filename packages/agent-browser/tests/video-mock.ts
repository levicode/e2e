import type { OperationContext } from 'e2e/engine';
import { CdpConnection } from '../src/cdp.ts';
export const operation = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 10_000, runId: 'test', attemptId: 'test', origin: 'test' });
export function mockScreencast(jpeg: Buffer = Buffer.from([0xff, 0xd8, 0xff, 0xd9])): {
  cdp: CdpConnection;
  calls: { method: string; params: Record<string, unknown>; session?: string }[];
  frame(data?: Buffer): void;
  disconnect(): void;
  listenerCount(): number;
} {
  const cdp = Object.create(CdpConnection.prototype) as CdpConnection;
  const listeners = new Map<string, Set<(event: object) => void>>();
  const closers = new Set<() => void>();
  const calls: { method: string; params: Record<string, unknown>; session?: string }[] = [];
  let active: string | undefined; let sessions = 0;
  cdp.attachTarget = async () => `session-${++sessions}`;
  cdp.on = <T extends object>(method: string, handler: (event: T) => void, session?: string): (() => void) => {
    const key = `${method}:${session ?? ''}`;
    let handlers = listeners.get(key); if (!handlers) { handlers = new Set(); listeners.set(key, handlers); }
    const wrapped = (event: object): void => handler(event as T); handlers.add(wrapped);
    return () => { handlers.delete(wrapped); };
  };
  cdp.onClose = handler => { closers.add(handler); return () => { closers.delete(handler); }; };
  const frame = (data: Buffer = jpeg): void => {
    for (const listener of listeners.get(`Page.screencastFrame:${active ?? ''}`) ?? []) listener({ data: data.toString('base64'), sessionId: 1 });
  };
  cdp.send = async <T>(method: string, params: Record<string, unknown>, _context: OperationContext, session?: string): Promise<T> => {
    calls.push({ method, params, ...(session ? { session } : {}) });
    if (method === 'Page.startScreencast') { active = session; queueMicrotask(() => frame()); }
    return (method === 'Page.getLayoutMetrics' ? { cssLayoutViewport: { clientWidth: 160, clientHeight: 100 } } : {}) as T;
  };
  return { cdp, calls, frame, disconnect: () => { for (const listener of closers) listener(); }, listenerCount: () => closers.size + [...listeners.values()].reduce((sum, handlers) => sum + handlers.size, 0) };
}
