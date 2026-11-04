#!/usr/bin/env node
// Test-only protocol peer. It has no signal handlers: OS group delivery is real.
const { createInterface } = require('node:readline');
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'hello') {
    process.stdout.write(JSON.stringify({ type: 'ready', id: message.id,
      protocol: 'agent-browser-session/1', sessionId: 'process-fixture', generation: 1,
      capabilities: ['acceptance.faults/1'], scopeState: 'usable',
      limits: { maxFrameBytes: 1048576, maxPendingOperations: 64,
        maxPendingDecisions: 256, maxTimeoutMs: 3600000 } }) + '\n');
  } else if (message.type === 'close') {
    if (process.env.PROCESS_FIXTURE_EXIT === 'without-closed') process.exit(0);
    process.stdout.write(JSON.stringify({ type: 'closed', id: message.id,
      generation: 1, scopeState: 'closed' }) + '\n');
  }
});
input.on('close', () => {
  if (process.env.PROCESS_FIXTURE_EXIT === 'signalled') process.kill(process.pid, 'SIGTERM');
  else process.exit(process.env.PROCESS_FIXTURE_EXIT === 'nonzero' ? 7 : 0);
});
