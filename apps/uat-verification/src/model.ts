/**
 * The private model settings behind the model-driven verification path.
 *
 * The scripted baseline needs no model. The model path constructs an AI SDK
 * model instance from `~/.config/e2e-uat/llm.json` (mode 0600, never in the
 * repository) and injects it into `agents.default.model`. The file names one
 * provider protocol and one model; a missing file, an unreadable one, a
 * provider this loop does not implement, or an unknown protocol fails loudly
 * with a `UAT_LLM_*` code. There is no silent fallback to the scripted path.
 *
 * The key is a live credential: it is read here and handed to the provider, and
 * never logged, echoed in an error, written to a report, or committed.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createOpenAI } from '@ai-sdk/openai';
import { wrapLanguageModel, type LanguageModel } from 'ai';

/** The provider protocol a model id is called through. */
export type UatModelApi = 'responses' | 'chat';

/** One private model setting; `baseUrl` points at a gateway when set. */
export interface UatModelSettings {
  readonly provider: 'openai';
  readonly api: UatModelApi;
  readonly model: string;
  readonly baseUrl: string | undefined;
  readonly apiKey: string;
}

/** The model instance injected into `agents.default.model`, with the label a report records. */
export interface UatModel {
  readonly model: LanguageModel;
  /** `openai.responses/<model>` or `openai.chat/<model>`, the provider label a report reads. */
  readonly label: string;
}

/** The fixed private model file, `UAT_LLM_FILE` for a different one. */
function uatLlmFile(): string {
  return process.env['UAT_LLM_FILE'] ?? path.join(homedir(), '.config', 'e2e-uat', 'llm.json');
}

/**
 * Reads and validates the private model settings.
 *
 * Environment variables override the file so a one-off run can point at
 * another model without editing it: `UAT_LLM_PROVIDER`, `UAT_LLM_API`,
 * `UAT_LLM_MODEL`, `UAT_LLM_BASE_URL`, `UAT_LLM_API_KEY`.
 */
export function loadUatModelSettings(): UatModelSettings {
  const file = uatLlmFile();
  if (!existsSync(file)) {
    throw new Error(
      `UAT_LLM_MISSING: write ${file} with {"provider":"openai","api":"responses","model":"<id>","baseUrl":"<gateway>","apiKey":"<key>"} (mode 0600) before running the model path`,
    );
  }
  assertPrivate(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (cause) {
    throw new Error(`UAT_LLM_INVALID: ${file} is not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`, { cause });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`UAT_LLM_INVALID: ${file} must hold a JSON object`);
  const stored = parsed as Record<string, unknown>;

  const provider = process.env['UAT_LLM_PROVIDER']?.trim() ?? storedString(stored, 'provider', file);
  if (provider !== 'openai') {
    throw new Error(`UAT_LLM_UNSUPPORTED: provider "${provider ?? '<missing>'}" is not implemented; this loop constructs openai.responses or openai.chat models`);
  }
  const api = apiSetting(process.env['UAT_LLM_API']?.trim() ?? storedString(stored, 'api', file));
  const model = process.env['UAT_LLM_MODEL']?.trim() ?? storedString(stored, 'model', file);
  if (model === undefined || model === '') throw new Error(`UAT_LLM_INVALID: ${file} needs a nonempty "model"`);
  const baseUrl = process.env['UAT_LLM_BASE_URL']?.trim() ?? storedString(stored, 'baseUrl', file);
  if (baseUrl !== undefined && baseUrl !== '') assertHttpUrl(baseUrl, 'baseUrl', file);
  const apiKey = process.env['UAT_LLM_API_KEY']?.trim() ?? storedString(stored, 'apiKey', file);
  if (apiKey === undefined || apiKey === '') throw new Error(`UAT_LLM_INVALID: ${file} needs a nonempty "apiKey"`);

  return {
    provider,
    api,
    model,
    baseUrl: baseUrl === undefined || baseUrl === '' ? undefined : baseUrl,
    apiKey,
  };
}

/** Builds the AI SDK model instance the model-driven config injects. */
export function createUatModel(settings: UatModelSettings): UatModel {
  const provider = createOpenAI({
    apiKey: settings.apiKey,
    ...(settings.baseUrl === undefined ? {} : { baseURL: settings.baseUrl }),
  });
  const raw = settings.api === 'responses' ? provider.responses(settings.model) : provider.chat(settings.model);
  return { model: freeToolChoice(raw), label: uatModelLabel(settings) };
}

/**
 * This internal gateway (MaaS, `code: 400001`) rejects a forced tool choice
 * with a generic 400. The agent's instructions already require tool calls, and
 * the runner itself falls back to `auto` when it recognizes such a refusal, so
 * the model path asks with `auto` from the first request and leaves every other
 * request untouched. A judgment call carries no tool choice and passes through.
 */
function freeToolChoice(model: Exclude<LanguageModel, string>): LanguageModel {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v4',
      transformParams: async ({ params }) => (params.toolChoice === undefined ? params : { ...params, toolChoice: { type: 'auto' } }),
    },
  });
}

/** The provider label a report records: `openai.responses/<model>` or `openai.chat/<model>`. */
export function uatModelLabel(settings: UatModelSettings): string {
  return `openai.${settings.api}/${settings.model}`;
}

/** A settings file any other local user can read is a leaked credential. */
function assertPrivate(file: string): void {
  const mode = statSync(file).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error(`UAT_LLM_INSECURE: ${file} is mode ${mode.toString(8)}; run chmod 600 ${file}`);
}

function apiSetting(value: string | undefined): UatModelApi {
  if (value === undefined || value === '') return 'responses';
  if (value === 'responses' || value === 'chat') return value;
  throw new Error(`UAT_LLM_UNSUPPORTED: api "${value}" is not implemented; use "responses" or "chat"`);
}

function storedString(stored: Record<string, unknown>, key: string, file: string): string | undefined {
  const candidate = stored[key];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== 'string') throw new Error(`UAT_LLM_INVALID: ${file} field "${key}" must be a string`);
  return candidate.trim();
}

function assertHttpUrl(candidate: string, name: string, file: string): void {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`UAT_LLM_INVALID: ${file} field "${name}" is not an absolute URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`UAT_LLM_INVALID: ${file} field "${name}" must be http or https`);
}
