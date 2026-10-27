/** Actual adapter in a foreground process group, controlled through a separate IPC lane. */
import { connectNativeProcess } from '../../src/native/process.ts';
import { AcceptanceTrace, type AcceptanceRecord } from '../../src/native/acceptance-trace.ts';

const records: AcceptanceRecord[] = [];
const trace = new AcceptanceTrace(record => {
  records.push(record);
  process.send?.({ kind: 'trace', record });
});
let interrupts = 0;
process.on('SIGINT', () => process.send?.({ kind: 'interrupt', count: ++interrupts }));
const context = () => ({ signal: new AbortController().signal, timeoutMs: 5_000,
  runId: 'process-fixture', attemptId: 'process-fixture', origin: 'test' as const });
const executable = process.argv[2];
if (executable === undefined) throw new Error('Missing process fixture');
const client = await connectNativeProcess({ executable, cwd: process.cwd(),
  env: process.env, capabilities: [], acceptanceTrace: trace }, context(), () => {});
process.send?.({ kind: 'ready', proxyPid: records.find(record => record.phase === 'ProcessSpawned')?.proxyPid });
process.on('message', async message => {
  if (message !== 'close') return;
  let failure: { code: unknown; message: string } | undefined;
  try { await client.close(context()); }
  catch (error) {
    failure = { code: Reflect.get(error as object, 'code'), message: String(Reflect.get(error as object, 'message')) };
  }
  // Process close follows exit when all owned pipe handles have settled.
  if (!records.some(record => record.phase === 'ProcessClose')) {
    await new Promise<void>(resolve => {
      const check = () => {
        if (records.some(record => record.phase === 'ProcessClose')) resolve();
        else setTimeout(check, 10);
      };
      check();
    });
  }
  trace.finish();
  process.send?.({ kind: 'settled', ...(failure === undefined ? {} : { failure }), records });
  process.disconnect?.();
});
