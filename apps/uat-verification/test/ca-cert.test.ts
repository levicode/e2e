import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { uatCaCertFile } from '../src/settings.ts';

test('a named CA file is used, and a missing one is a setup error', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'uat-ca-'));
  const file = path.join(directory, 'internal-ca.pem');
  writeFileSync(file, '-----BEGIN CERTIFICATE-----\n');
  const previous = process.env['UAT_CA_CERT'];
  try {
    process.env['UAT_CA_CERT'] = file;
    assert.equal(uatCaCertFile(), file);
    process.env['UAT_CA_CERT'] = path.join(directory, 'absent.pem');
    assert.throws(() => uatCaCertFile(), /UAT_CA_CERT_MISSING/);
    process.env['UAT_CA_CERT'] = 'none';
    assert.equal(uatCaCertFile(), undefined);
  } finally {
    if (previous === undefined) delete process.env['UAT_CA_CERT'];
    else process.env['UAT_CA_CERT'] = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
