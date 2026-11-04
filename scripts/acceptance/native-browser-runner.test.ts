import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { NATIVE_BROWSER_CONTRACTS } from './manifest.ts';

test('browser diagnostics execute later cases but aggregate any failure as red', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'native-runner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'cli'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'cargo'), `#!${process.execPath}\nconst args=process.argv.slice(2); const name=args[6]; if(args.includes('--list')) console.log(name+': test'); else { require('node:fs').appendFileSync(process.env.CALLS,name+'\\n'); const failed=name.includes('client_browser'); console.log('test result: '+(failed?'FAILED':'ok')+'. '+(failed?0:1)+' passed; '+(failed?1:0)+' failed; 0 ignored;'); process.exit(failed?1:0); }\n`, { mode: 0o700 });
  const calls = join(root, 'calls');
  const output = join(root, 'output');
  const result = spawnSync(process.execPath, [resolve('scripts/acceptance/run-native-browser.ts'), root, output], { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, CALLS: calls }, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), [...NATIVE_BROWSER_CONTRACTS]);
  const summary = JSON.parse(readFileSync(join(output, 'browser-contract-summary.json'), 'utf8')) as { failures: string[] };
  assert.deepEqual(summary.failures, [NATIVE_BROWSER_CONTRACTS[0]]);
});
