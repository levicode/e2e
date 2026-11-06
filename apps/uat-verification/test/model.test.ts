import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createUatModel, loadUatModelSettings, uatModelLabel } from '../src/model.ts';

const ENV_NAMES = ['UAT_LLM_FILE', 'UAT_LLM_PROVIDER', 'UAT_LLM_API', 'UAT_LLM_MODEL', 'UAT_LLM_BASE_URL', 'UAT_LLM_API_KEY'] as const;

/** Writes one private model file and points the loader at it; the returned function restores the environment. */
function withModelFile(contents: unknown, mode = 0o600): () => void {
  const directory = mkdtempSync(path.join(tmpdir(), 'uat-model-'));
  const file = path.join(directory, 'llm.json');
  writeFileSync(file, `${JSON.stringify(contents)}\n`, { mode });
  chmodSync(file, mode);
  const saved = ENV_NAMES.map(name => [name, process.env[name]] as const);
  process.env['UAT_LLM_FILE'] = file;
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  };
}

test('a responses model is the default protocol and labels the report provider', () => {
  const done = withModelFile({ provider: 'openai', model: 'deepseek-v4.1-flash', baseUrl: 'http://llm.example.test/v1', apiKey: 'secret-key' });
  try {
    const settings = loadUatModelSettings();
    assert.equal(settings.api, 'responses');
    assert.equal(settings.model, 'deepseek-v4.1-flash');
    assert.equal(settings.baseUrl, 'http://llm.example.test/v1');
    assert.equal(settings.apiKey, 'secret-key');
    assert.equal(uatModelLabel(settings), 'openai.responses/deepseek-v4.1-flash');
    assert.equal(createUatModel(settings).label, 'openai.responses/deepseek-v4.1-flash');
  } finally {
    done();
  }
});

test('the chat protocol is explicit and labelled as openai.chat', () => {
  const done = withModelFile({ provider: 'openai', api: 'chat', model: 'some-model', apiKey: 'secret-key' });
  try {
    const settings = loadUatModelSettings();
    assert.equal(settings.api, 'chat');
    assert.equal(settings.baseUrl, undefined);
    assert.equal(createUatModel(settings).label, 'openai.chat/some-model');
  } finally {
    done();
  }
});

test('environment variables override the file without naming the key in an error', () => {
  const done = withModelFile({ provider: 'openai', model: 'from-file', apiKey: 'secret-key' });
  try {
    process.env['UAT_LLM_MODEL'] = 'from-environment';
    process.env['UAT_LLM_API_KEY'] = 'environment-key';
    const settings = loadUatModelSettings();
    assert.equal(settings.model, 'from-environment');
    assert.equal(settings.apiKey, 'environment-key');
  } finally {
    done();
  }
});

test('a missing file names the private path and the expected shape', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'uat-model-'));
  const saved = process.env['UAT_LLM_FILE'];
  process.env['UAT_LLM_FILE'] = path.join(directory, 'missing.json');
  try {
    assert.throws(() => loadUatModelSettings(), /UAT_LLM_MISSING: write .*missing\.json/);
  } finally {
    if (saved === undefined) delete process.env['UAT_LLM_FILE'];
    else process.env['UAT_LLM_FILE'] = saved;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an insecure mode, a missing key, and an unknown api fail without a silent fallback', () => {
  const insecure = withModelFile({ provider: 'openai', model: 'm', apiKey: 'secret-key' }, 0o644);
  try {
    assert.throws(() => loadUatModelSettings(), /UAT_LLM_INSECURE: .* chmod 600/);
  } finally {
    insecure();
  }

  const missingKey = withModelFile({ provider: 'openai', model: 'm' });
  try {
    assert.throws(() => loadUatModelSettings(), /UAT_LLM_INVALID: .* "apiKey"/);
  } finally {
    missingKey();
  }

  const unknownApi = withModelFile({ provider: 'openai', api: 'completions', model: 'm', apiKey: 'secret-key' });
  try {
    assert.throws(() => loadUatModelSettings(), /UAT_LLM_UNSUPPORTED: api "completions"/);
  } finally {
    unknownApi();
  }

  const unknownProvider = withModelFile({ provider: 'anthropic', model: 'm', apiKey: 'secret-key' });
  try {
    assert.throws(() => loadUatModelSettings(), /UAT_LLM_UNSUPPORTED: provider "anthropic"/);
  } finally {
    unknownProvider();
  }
});

test('a malformed base url is rejected before a model call', () => {
  const done = withModelFile({ provider: 'openai', model: 'm', baseUrl: 'file:///tmp/llm', apiKey: 'secret-key' });
  try {
    assert.throws(() => loadUatModelSettings(), /UAT_LLM_INVALID: .* "baseUrl" must be http or https/);
  } finally {
    done();
  }
});
