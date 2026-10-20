/** Transparent CDP forwarding for real-browser isolation assertions; no browser responses are fabricated. */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

export interface WireCommand {
  readonly connection: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly targetId?: string;
  readonly sessionId?: string;
}
export interface WireAttachment {
  readonly connection: number;
  readonly targetId: string;
  readonly waitingForDebugger: boolean;
}

function frame(payload: Buffer, opcode = 1): Buffer {
  const header = Buffer.alloc(payload.length < 126 ? 2 : payload.length < 65_536 ? 4 : 10);
  header[0] = 0x80 | opcode;
  if (header.length === 2) header[1] = payload.length;
  else if (header.length === 4) { header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  else { header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
  return Buffer.concat([header, payload]);
}

/** The peer may finish its close handshake before queued upstream events drain. */
export function auditConnectionLifecycle(connection: number, errors: string[]) {
  let closing = false;
  return {
    get closing() { return closing; },
    close() { closing = true; },
    fail(stage: string, error: unknown) {
      if (closing) return;
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      errors.push(`CDP forwarding connection ${connection} failed (${stage}): ${detail}`);
      closing = true;
    },
  };
}

export async function cdpAuditProxy(upstreamEndpoint: string) {
  const commands: WireCommand[] = [];
  const attachments: WireAttachment[] = [];
  const createdContexts = new Set<string>();
  const errors: string[] = [];
  const sockets = new Set<Duplex>();
  const upstreams = new Set<WebSocket>();
  const lifecycles = new Set<ReturnType<typeof auditConnectionLifecycle>>();
  let nextConnection = 0;
  let stopping = false;
  const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
  server.on('upgrade', (request, socket, head) => {
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') { socket.destroy(); return; }
    const connection = ++nextConnection;
    const upstream = new WebSocket(upstreamEndpoint);
    upstreams.add(upstream); sockets.add(socket); socket.pause();
    const sessions = new Map<string, string>();
    const pending = new Map<number, { method: string; params: Record<string, unknown> }>();
    let buffered: Buffer = Buffer.alloc(0);
    let fragments: Buffer[] = [];
    let open = false;
    const lifecycle = auditConnectionLifecycle(connection, errors);
    lifecycles.add(lifecycle);
    const fail = (stage: string, error: unknown) => {
      if (stopping) lifecycle.close();
      lifecycle.fail(stage, error);
      socket.destroy(); upstream.close();
    };
    const forward = (payload: Buffer) => {
      const value = JSON.parse(payload.toString('utf8')) as { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string };
      if (typeof value.id !== 'number' || typeof value.method !== 'string') throw new Error('Invalid client CDP message');
      const params = value.params ?? {};
      pending.set(value.id, { method: value.method, params });
      const targetId = typeof params.targetId === 'string' ? params.targetId
        : sessions.get(value.sessionId ?? (typeof params.sessionId === 'string' ? params.sessionId : ''));
      commands.push({ connection, method: value.method, params,
        ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
        ...(targetId === undefined ? {} : { targetId }),
      });
      upstream.send(payload.toString('utf8'));
    };
    const consume = (chunk: Buffer) => {
      if (lifecycle.closing) return;
      try {
        buffered = Buffer.concat([buffered, chunk]);
        while (buffered.length >= 2) {
          const first = buffered[0]!; const second = buffered[1]!;
          if ((first & 0x70) !== 0 || (second & 0x80) === 0) throw new Error('Unsupported websocket frame');
          let length = second & 0x7f; let offset = 2;
          if (length === 126) { if (buffered.length < 4) return; length = buffered.readUInt16BE(2); offset = 4; }
          else if (length === 127) {
            if (buffered.length < 10) return;
            const wide = buffered.readBigUInt64BE(2);
            if (wide > 16n * 1024n * 1024n) throw new Error('Oversized websocket frame');
            length = Number(wide); offset = 10;
          }
          if (buffered.length < offset + 4 + length) return;
          const mask = buffered.subarray(offset, offset + 4); offset += 4;
          const payload = Buffer.from(buffered.subarray(offset, offset + length));
          for (let index = 0; index < payload.length; index++) payload[index] = payload[index]! ^ mask[index % 4]!;
          buffered = buffered.subarray(offset + length);
          const opcode = first & 0x0f;
          if (opcode === 8) { lifecycle.close(); socket.end(frame(payload, 8)); upstream.close(); return; }
          if (opcode === 9) { socket.write(frame(payload, 10)); continue; }
          if (opcode === 10) continue;
          if (opcode !== 0 && opcode !== 1) throw new Error('Only text CDP messages are supported');
          if (opcode === 1 && fragments.length !== 0) throw new Error('Overlapping websocket message');
          fragments.push(payload);
          if ((first & 0x80) !== 0) { forward(Buffer.concat(fragments)); fragments = []; }
        }
      } catch (error) { fail('client frame', error); }
    };
    socket.on('data', consume);
    socket.on('error', error => { fail('client socket', error); });
    socket.on('close', () => {
      if (!stopping) lifecycle.fail('client close', new Error('Unexpected client socket close without a WebSocket close frame'));
      lifecycle.close(); sockets.delete(socket); upstream.close();
    });
    upstream.addEventListener('open', () => {
      if (stopping || lifecycle.closing || socket.destroyed) { upstream.close(); return; }
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      open = true;
      if (head.length > 0) consume(head);
      socket.resume();
    });
    upstream.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (lifecycle.closing) return;
      try {
        if (typeof event.data !== 'string' || !open) throw new Error('Invalid upstream CDP message');
        const value = JSON.parse(event.data) as { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> };
        if (value.method === 'Target.attachedToTarget') {
          const params = value.params!;
          const info = params.targetInfo as { targetId: string };
          if (typeof info.targetId !== 'string' || typeof params.sessionId !== 'string') throw new Error('Invalid target attachment');
          sessions.set(params.sessionId, info.targetId);
          attachments.push({ connection, targetId: info.targetId, waitingForDebugger: params.waitingForDebugger === true });
        }
        if (value.id !== undefined) {
          const original = pending.get(value.id); pending.delete(value.id);
          if (original?.method === 'Target.attachToTarget' && typeof value.result?.sessionId === 'string' && typeof original.params.targetId === 'string') sessions.set(value.result.sessionId, original.params.targetId);
          if (original?.method === 'Target.createBrowserContext' && typeof value.result?.browserContextId === 'string') createdContexts.add(value.result.browserContextId);
        }
        socket.write(frame(Buffer.from(event.data)));
      } catch (error) { fail('upstream message', error); }
    });
    upstream.addEventListener('error', event => fail('upstream socket', (event as ErrorEvent).error ?? (event as ErrorEvent).message));
    upstream.addEventListener('close', event => {
      if (!stopping) lifecycle.fail('upstream close', new Error(`Unexpected close ${event.code}: ${event.reason}`));
      lifecycle.close(); lifecycles.delete(lifecycle); upstreams.delete(upstream); socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/devtools/browser/audit`,
    commands, attachments, createdContexts, errors,
    async close() {
      stopping = true;
      for (const lifecycle of lifecycles) lifecycle.close();
      for (const socket of sockets) socket.destroy();
      for (const upstream of upstreams) upstream.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
