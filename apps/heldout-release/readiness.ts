/** Reviewed full NativeSurface set, not the two foundation-only capabilities. */
const required = ['scope', 'lifecycle', 'evaluate', 'page', 'observe', 'query', 'actions', 'network', 'dialog', 'download', 'capture', 'state', 'recording', 'blobs'].map(name => `browser.${name}/1`);
interface Binding { entry: string; inventorySha256: string }
interface VerifiedCandidate {
  status: 'verified';
  manifestHash: string;
  nativeSha256: string;
  source: { commit: string; tree: string };
  protocol: string;
  capabilities: string[];
  installed: { core: Binding; web: Binding };
}
/** A verifier's mere return is not success: false, empty and blocked results must stop before model import. */
export function requireVerified(value: unknown, expected: { manifestHash: string; coreEntry: string; webEntry: string; nativeSha256: string }): VerifiedCandidate {
  if (!value || typeof value !== 'object') throw new Error('candidate-unverified');
  const proof = value as VerifiedCandidate;
  const hash = (input: unknown) => typeof input === 'string' && /^[a-f0-9]{64}$/.test(input);
  const commit = (input: unknown) => typeof input === 'string' && /^[a-f0-9]{40}$/.test(input);
  if (proof.status !== 'verified' || !hash(proof.manifestHash) || proof.manifestHash !== expected.manifestHash || !hash(proof.nativeSha256) || proof.nativeSha256 !== expected.nativeSha256 || !commit(proof.source?.commit) || !commit(proof.source?.tree) || typeof proof.protocol !== 'string' || !proof.protocol || !Array.isArray(proof.capabilities) || !required.every(capability => proof.capabilities.includes(capability))) throw new Error('candidate-unverified');
  if (proof.installed?.core?.entry !== expected.coreEntry || proof.installed?.web?.entry !== expected.webEntry || !hash(proof.installed.core.inventorySha256) || !hash(proof.installed.web.inventorySha256)) throw new Error('installed-packages-unverified');
  return proof;
}
