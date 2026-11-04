import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Only a reviewed immutable revision, never a branch, URL, or caller-selected repository. */
export function foundationSource(lock: unknown, event: string, manualSha: string | undefined): string {
  if (lock === null || typeof lock !== 'object') throw new Error('Missing foundation source lock');
  const value = lock as Record<string, unknown>;
  if (value['schemaVersion'] !== 1 || value['repository'] !== 'levicode/agent-browser') throw new Error('Unexpected native source repository');
  if (event !== 'push' && event !== 'workflow_dispatch') throw new Error('Foundation is not a PR or external-event execution route');
  if (event !== 'workflow_dispatch' && manualSha) throw new Error('Only manual dispatch may override the locked SHA');
  const sha = event === 'workflow_dispatch' && manualSha ? manualSha : value['commit'];
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha) || /^0+$/.test(sha)) throw new Error('Coordinator must pin a real full native commit before running foundation');
  return sha;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sha = foundationSource(JSON.parse(readFileSync('.github/native-foundation.json', 'utf8')), process.env['GITHUB_EVENT_NAME'] ?? '', process.env['INPUT_NATIVE_SHA']);
  const output = process.env['GITHUB_OUTPUT'];
  if (!output) throw new Error('Missing GitHub output file');
  appendFileSync(output, `sha=${sha}\n`);
}
