/** The popup-joint diagnostic's closed source manifest: the binding names every file a gated run hashes. */
import assert from 'node:assert/strict';

/**
 * Fails unless every file the popup-joint diagnostic hashes still matches the digest the binding recorded.
 * The gated job calls this before it runs; the always-on `check` guard calls it too, so a changed workflow
 * or diagnostic source fails a normal pull request instead of waiting for the branch-gated job.
 */
export function assertBoundSourceHashes(binding: { sourceHashes: Record<string, string> }, digest: (file: string) => string): void {
 const files = Object.entries(binding.sourceHashes);
 assert.ok(files.length > 0, 'Popup binding names no diagnostic source');
 for (const [file, recorded] of files) assert.equal(digest(file), recorded, 'Stale popup binding digest for ' + file);
}
