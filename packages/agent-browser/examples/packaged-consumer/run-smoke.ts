import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { run } from 'e2e/runner';
import { ENGINE_NAME, ENGINE_VERSION } from '@e2e-dev/agent-browser';

assert.ok(process.env.E2E_AGENT_BROWSER_EXECUTABLE, 'Set E2E_AGENT_BROWSER_EXECUTABLE to the reviewed native CLI build');
let commits = 0;
const server = createServer((request, response) => {
  if (request.url === '/commit') { commits++; response.end('ok'); return; }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><meta charset="utf-8"><title>Packaged consumer</title>
    <label>Text<input data-testid="text" value="old text"></label>
    <label>Area<textarea data-testid="area">old area</textarea></label>
    <div role="textbox" aria-label="Editable" contenteditable data-testid="editable">old editable</div>
    <button id="consumer-commit">Commit once</button><p data-testid="result">waiting</p>
    <script>globalThis.commitCount=0;globalThis.fillEvents=[];
    document.addEventListener('input',event=>globalThis.fillEvents.push({
      id:event.target.dataset.testid,trusted:event.isTrusted,
      value:'value' in event.target?event.target.value:event.target.textContent
    }));
    document.getElementById('consumer-commit').onclick=()=>{
      globalThis.commitCount++;document.querySelector('[data-testid="result"]').textContent='committed once';
      navigator.sendBeacon('/commit');
    };</script>`);
});
try {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  process.env.CONSUMER_FIXTURE_URL = `http://127.0.0.1:${address.port}`;
  const { default: config } = await import('./e2e.config.ts');
  const traces: string[] = [];
  const result = await run({ cwd: process.cwd(), config: {
    ...config,
    reporters: [{ name: 'packaged-consumer-artifacts', async onRunFinished(finished) { traces.push(...finished.traces.values()); } }],
  } });
  await mkdir('consumer-results', { recursive: true });
  await writeFile('consumer-results/report.json', `${JSON.stringify(result.report, null, 2)}\n`);
  assert.equal(result.exitCode, 0, JSON.stringify(result.report.run.results));
  assert.equal(result.report.run.status, 'passed');
  assert.equal(result.report.run.targets[0]?.engine.name, ENGINE_NAME);
  assert.equal(result.report.run.targets[0]?.engine.version, ENGINE_VERSION);
  assert.equal(result.report.run.usage.modelTokens, 0);
  const steps = result.report.run.results.flatMap(test => test.attempts.flatMap(attempt => attempt.steps));
  const action = steps.find(step => step.api === 'agent.act');
  assert.ok(action); assert.equal(action.status, 'passed'); assert.equal(action.metrics?.modelCalls, 0);
  assert.equal(traces.length, 1);
  const trace = await readFile(path.resolve(traces[0]!), 'utf8');
  assert.match(trace, /agent\.act/); assert.match(trace, /Commit once button/);
  await writeFile('consumer-results/trace.md', trace);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) { if (commits > 0) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(commits, 1, 'One observed action must produce exactly one fixture-side commit');
  await writeFile('consumer-results/browser-summary.json', `${JSON.stringify({ status: 'passed', commits, modelTokens: 0, engine: ENGINE_NAME, version: ENGINE_VERSION, fillContracts: ['input', 'textarea', 'contenteditable'], nativeCapabilities: 'required-before-browser-use' }, null, 2)}\n`);
  process.stdout.write('Installed package browser fill/clear, exact observation, native click, report, and trace passed with zero model calls.\n');
} finally {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
