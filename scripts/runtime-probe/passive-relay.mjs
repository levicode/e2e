// Test-only, one synthetic HTTP500 case. No CDP commands, rewrites, retries or injections.
export const STARTUP_METHODS = Object.freeze(['Target.setAutoAttach', 'Fetch.enable', 'Network.enable', 'Runtime.enable', 'Runtime.runIfWaitingForDebugger']);
const LIMITS = Object.freeze({ connections: 4, contexts: 8, workers: 64, sessions: 64, pending: 128, errors: 64, message: 160 });
const fixedWords = new Set('a an and are as at autoattach browser can cannot closed command context could debugger detached does domain enable enabled error failed fetch find for found given has id in invalid is method network no not of only operation page parameters paused protocol request required running runtime service session setautoattach started state supported target the this to unavailable unknown was while with worker'.split(' '));
const validId = value => Number.isSafeInteger(value) && value >= 0;
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const key = packet => JSON.stringify([packet.sessionId ?? null, packet.id]);
function sanitizedMessage(message) {
  if (typeof message !== 'string') return '[redacted]';
  return (message.slice(0, 2048).replace(/(?:https?|wss?):\/\/\S+|["'`][^"'`]*["'`]/g, '[redacted]')
    .match(/[A-Za-z][A-Za-z0-9_.-]*|[^\s]/g) ?? []).map(token => fixedWords.has(token.toLowerCase()) || STARTUP_METHODS.includes(token) ? token : /^[.,:;!?()-]$/.test(token) ? token : '[redacted]')
    .join(' ').replace(/(?:\[redacted\]\s*)+/g, '[redacted] ').trim().slice(0, LIMITS.message) || '[redacted]';
}
export async function startPassiveRelay({ endpoint, fixtureOrigin, WebSocket, WebSocketServer }) {
  const upstream = new URL(endpoint), origin = new URL(fixtureOrigin);
  if (upstream.protocol !== 'ws:' || upstream.hostname !== '127.0.0.1' || upstream.username || upstream.password || upstream.search || upstream.hash || !/^\/devtools\/browser\/[^/]+$/.test(upstream.pathname)) throw Error('relay-endpoint-not-owned-loopback');
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw Error('relay-fixture-not-loopback');
  const fixtureWorker = origin.origin + '/bad-sw.js', sockets = new Set(), records = [], unknown = {};
  let connections = 0, closing = false, closePromise, droppedErrorRecords = 0, matchedRequests = 0, matchedResponses = 0, duplicateAttachments = 0, workersObserved = 0, sessionsObserved = 0;
  const mark = reason => { unknown[reason] = Math.min(65535, (unknown[reason] ?? 0) + 1); };
  const states = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: upstream.pathname });
  server.on('connection', down => {
    const connectionOrdinal = ++connections;
    const state = { contexts: new Set(), workers: new Map(), sessions: new Map(), pending: new Map() };
    const observing = connectionOrdinal <= LIMITS.connections;
    if (observing) states.push(state); else mark('connection-limit');
    const up = new WebSocket(upstream.href), earlyFrames = [];
    sockets.add(down); sockets.add(up); down.pause();
    up.once('open', () => { for (const [data, binary] of earlyFrames) up.send(data, { binary }); earlyFrames.length = 0; down.resume(); });
    for (const socket of [down, up]) {
      socket.on('error', () => { if (!closing) mark('transport-error'); down.terminate(); up.terminate(); });
      socket.on('close', () => sockets.delete(socket));
    }
    down.on('close', () => up.terminate()); up.on('close', () => down.terminate());
    const observe = (data, binary, outbound) => {
      if (!observing || binary) return;
      let packet; try { packet = JSON.parse(data.toString()); } catch { mark('non-json-frame'); return; }
      if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return;
      if (outbound) {
        const contextCommand = packet.method === 'Target.createBrowserContext' && packet.sessionId === undefined;
        if (!contextCommand && !STARTUP_METHODS.includes(packet.method)) return;
        if (!validId(packet.id) || (packet.sessionId !== undefined && !identity(packet.sessionId))) { mark('invalid-request-identity'); return; }
        const requestKey = key(packet);
        if (state.pending.has(requestKey)) { state.pending.set(requestKey, null); mark('ambiguous-request-key'); return; }
        if (state.pending.size >= LIMITS.pending) { mark('pending-limit'); return; }
        const attachment = state.sessions.get(packet.sessionId);
        const bound = attachment?.exact === true && !attachment.detached;
        if (!contextCommand && !bound) mark('startup-request-unbound');
        state.pending.set(requestKey, { contextCommand, id: packet.id, method: packet.method, attachment: bound ? attachment : null });
        if (bound) matchedRequests++;
        return;
      }
      if (validId(packet.id)) {
        if (packet.sessionId !== undefined && !identity(packet.sessionId)) { mark('invalid-response-identity'); return; }
        const requestKey = key(packet);
        if (!state.pending.has(requestKey)) return;
        const request = state.pending.get(requestKey); state.pending.delete(requestKey);
        if (!request) { mark('ambiguous-response-key'); return; }
        if (request.contextCommand) {
          const context = packet.result?.browserContextId;
          if (packet.error || !identity(context)) { mark('context-not-acknowledged'); return; }
          if (state.contexts.size >= LIMITS.contexts) { mark('context-limit'); return; }
          state.contexts.add(context); return;
        }
        if (!request.attachment?.exact) { mark('startup-response-unbound'); return; }
        matchedResponses++;
        if (!packet.error) return;
        if (!Number.isSafeInteger(packet.error.code)) { mark('invalid-error-code'); return; }
        if (records.length >= LIMITS.errors) { droppedErrorRecords++; return; }
        records.push({ method: request.method, requestId: request.id, connectionOrdinal, workerOrdinal: request.attachment.workerOrdinal, sessionOrdinal: request.attachment.sessionOrdinal, code: packet.error.code, message: sanitizedMessage(packet.error.message) });
        return;
      }
      if (packet.method === 'Target.attachedToTarget') {
        const info = packet.params?.targetInfo, session = packet.params?.sessionId;
        if (info?.type !== 'service_worker') { const previous = state.sessions.get(session); if (previous) { previous.exact = false; mark('attachment-session-conflict'); } return; }
        if (!identity(session) || !identity(info.targetId) || !identity(info.browserContextId)) { const previous = state.sessions.get(session); if (previous) previous.exact = false; mark('attachment-identity-missing'); return; }
        const workerKey = JSON.stringify([info.browserContextId, info.targetId]), previous = state.sessions.get(session);
        if (previous) {
          if (previous.workerKey === workerKey && !previous.detached && info.url === fixtureWorker) { duplicateAttachments++; return; }
          previous.exact = false; mark('attachment-session-conflict'); return;
        }
        if (state.sessions.size >= LIMITS.sessions) { mark('session-limit'); return; }
        if (!state.contexts.has(info.browserContextId) || info.url !== fixtureWorker) { mark('attachment-not-exact-fixture'); return; }
        let workerOrdinal = state.workers.get(workerKey);
        if (!workerOrdinal) {
          if (state.workers.size >= LIMITS.workers) { mark('worker-limit'); return; }
          workerOrdinal = state.workers.size + 1; state.workers.set(workerKey, workerOrdinal); workersObserved++;
        }
        sessionsObserved++; state.sessions.set(session, { workerKey, target: info.targetId, exact: true, detached: false, workerOrdinal, sessionOrdinal: state.sessions.size + 1 });
      }
      if (packet.method === 'Target.detachedFromTarget') {
        const attachment = state.sessions.get(packet.params?.sessionId); if (attachment) attachment.detached = true;
      }
      if (packet.method === 'Target.targetDestroyed') {
        for (const attachment of state.sessions.values()) if (attachment.target === packet.params?.targetId) attachment.detached = true;
      }
    };
    down.on('message', (data, binary) => {
      try { observe(data, binary, true); } catch { mark('observation-failed'); }
      // Forward the original bytes and binary bit, never a parsed/re-serialized packet.
      if (up.readyState === WebSocket.OPEN) up.send(data, { binary }); else if (up.readyState === WebSocket.CONNECTING) earlyFrames.push([data, binary]); else mark('upstream-already-closed');
    });
    up.on('message', (data, binary) => {
      try { observe(data, binary, false); } catch { mark('observation-failed'); }
      if (down.readyState === WebSocket.OPEN) down.send(data, { binary });
    });
  });
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const relayUrl = new URL(upstream); relayUrl.port = String(server.address().port);
  return {
    endpoint: relayUrl.href,
    facts: () => ({ schemaVersion: 1, topology: 'connect-isolated-passive-relay-not-original-launch', limits: LIMITS, connections, matchedRequests, matchedResponses, duplicateAttachments, workersObserved, sessionsObserved, errors: records.map(row => ({ ...row })), droppedErrorRecords, unknown: { ...unknown }, retained: { contexts: states.reduce((n, s) => n + s.contexts.size, 0), workers: states.reduce((n, s) => n + s.workers.size, 0), sessions: states.reduce((n, s) => n + s.sessions.size, 0), pending: states.reduce((n, s) => n + s.pending.size, 0) }, activeSockets: sockets.size, closing }),
    close: () => closePromise ??= (async () => {
      closing = true;
      const closed = [...sockets].map(socket => new Promise(resolve => { if (socket.readyState === WebSocket.CLOSED) resolve(); else { socket.once('close', resolve); socket.terminate(); } }));
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await Promise.all(closed);
      for (const state of states) { state.contexts.clear(); state.workers.clear(); state.sessions.clear(); state.pending.clear(); }
    })(),
  };
}
