/** Native protocol compatibility and semantic replay epochs are pinned independently. */
export const AGENT_BROWSER_VERSION = '0.39.1-e2e.5';
export const AGENT_BROWSER_CONTRACT = 'e2e-exact-1';
export const AGENT_BROWSER_ENGINE_EPOCH = 'agent-browser-exact-6';
export const REQUIRED_NATIVE_CAPABILITIES = ['exact-refs', 'passive-scoped-cdp', 'pre-dispatch-stale', 'outcome-unknown'] as const;

/** Require the whole control/identity bundle before any browser or daemon command. */
export function supportsNativeContract(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as Record<string, unknown>;
  if (data.contractVersion !== AGENT_BROWSER_CONTRACT || data.nativeVersion !== AGENT_BROWSER_VERSION) return false;
  const capabilities = data.capabilities;
  if (!Array.isArray(capabilities) || !capabilities.every(entry => typeof entry === 'string')
    || !REQUIRED_NATIVE_CAPABILITIES.every(required => capabilities.includes(required))) return false;
  if (!Array.isArray(data.refModes) || !data.refModes.every(entry => typeof entry === 'string')
    || !data.refModes.includes('exact') || !data.refModes.includes('semantic')) return false;
  if (typeof data.passiveScope !== 'object' || data.passiveScope === null) return false;
  const scope = data.passiveScope as Record<string, unknown>;
  return scope.requiresDedicatedEndpoint === true && scope.requiresTargetAndContext === true
    && scope.ownsDebuggerPause === false && scope.ownsFetch === false;
}
