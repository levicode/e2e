/** One discovery source for local acceptance and hosted consumer verification. */
export const WEB_ACCEPTANCE = [
  {
    id: 'core-reference', package: 'e2e', project: 'integration', directory: 'tests/integration',
    requiredFiles: ['canonical-reference-roundtrip.test.ts'], onlyRequiredFiles: true,
    prerequisites: [], evidence: 'deterministic-synthetic-engine',
  },
  { id: 'web-unit', package: 'web', project: 'unit', directory: 'tests/unit', requiredFiles: [], prerequisites: [], evidence: 'deterministic-contract' },
  {
    id: 'web-browser', package: 'web', project: 'integration', directory: 'tests/integration',
    requiredFiles: ['native-state-roundtrip.test.ts', 'native-capture-contract.test.ts', 'protected-app.test.ts', 'lifecycle.test.ts', 'routes.test.ts', 'observation.test.ts', 'keyboard.test.ts', 'media.test.ts', 'wait-for-response.test.ts'],
    prerequisites: ['CROSSCHECK_BENCHMARK_URL'], evidence: 'real-browser',
  },
  {
    id: 'public-callbacks', package: 'e2e', project: 'integration', directory: 'tests/integration',
    requiredFiles: ['web-callback-contract.test.ts', 'web-native-primitives-contract.test.ts'], onlyRequiredFiles: true,
    prerequisites: [], evidence: 'real-browser-public-consumer',
  },
] as const;

export type AcceptanceSuite = (typeof WEB_ACCEPTANCE)[number];

/** Backend-specific proof, separate from universal protocol and public consumer contracts. */
export const NATIVE_BROWSER_CONTRACTS = [
  'native::client_browser::tests::chromium_owned_scope_isolation_and_cleanup',
  'native::client_observation::tests::chromium_native_observation_query_exact_and_secure_contract',
] as const;

/** Narrow first checkpoint only. This does not advertise full Web/state/capture support. */
export const FOUNDATION_CAPABILITIES = ['browser.scope/1', 'browser.evaluate/1'] as const;
