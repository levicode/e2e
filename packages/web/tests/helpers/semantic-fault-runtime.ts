/** A separate verified runtime, selected only by the semantic fault fixture. */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export const SEMANTIC_FAULT_EXECUTABLE_ENV = 'E2E_SEMANTIC_FAULT_FIXTURE_EXECUTABLE';
export const SEMANTIC_FAULT_BINDING_ENV = 'E2E_SEMANTIC_FAULT_FIXTURE_BINDING';
export const SEMANTIC_FAULT_CAPABILITY = 'acceptance.faults/1';
interface SemanticFaultRuntimeBinding {
  purpose: 'semantic-fallback-faults'; binarySha256: string; negotiationProofSha256: string;
}
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && !/^0+$/.test(value);

/** Remove stale fixture settings before selecting a suite or its children. */
export function cleanSemanticFaultEnvironment(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...inherited };
  delete env[SEMANTIC_FAULT_EXECUTABLE_ENV]; delete env[SEMANTIC_FAULT_BINDING_ENV];
  return env;
}

/** Bind an already probed secondary identity without replacing the production executable. */
export function semanticFaultEnvironment(inherited: NodeJS.ProcessEnv, runtime: { binary: string; binding: { binarySha256: string; negotiationProofSha256: string } } | undefined): NodeJS.ProcessEnv {
  const env = cleanSemanticFaultEnvironment(inherited);
  if (runtime) {
    const binding: SemanticFaultRuntimeBinding = { purpose: 'semantic-fallback-faults', binarySha256: runtime.binding.binarySha256, negotiationProofSha256: runtime.binding.negotiationProofSha256 };
    env[SEMANTIC_FAULT_EXECUTABLE_ENV] = runtime.binary;
    env[SEMANTIC_FAULT_BINDING_ENV] = JSON.stringify(binding);
  }
  return env;
}

/** Rehash the canonical executable immediately before the fixture negotiates it. */
export function semanticFaultRuntimeFromEnvironment(env: NodeJS.ProcessEnv): { binary: string; binding: SemanticFaultRuntimeBinding } {
  const binary = env[SEMANTIC_FAULT_EXECUTABLE_ENV];
  const value: unknown = JSON.parse(env[SEMANTIC_FAULT_BINDING_ENV] ?? 'null');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Missing verified semantic fault fixture runtime');
  const binding = value as Record<string, unknown>;
  if (!binary || !isAbsolute(binary) || realpathSync(binary) !== binary
    || Object.keys(binding).toSorted().join(',') !== 'binarySha256,negotiationProofSha256,purpose'
    || binding['purpose'] !== 'semantic-fallback-faults' || !digest(binding['binarySha256']) || !digest(binding['negotiationProofSha256'])
    || createHash('sha256').update(readFileSync(binary)).digest('hex') !== binding['binarySha256']) throw new Error('Missing or changed verified semantic fault fixture runtime');
  return { binary, binding: { purpose: 'semantic-fallback-faults', binarySha256: binding['binarySha256'], negotiationProofSha256: binding['negotiationProofSha256'] } };
}
