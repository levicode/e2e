/**
 * Records the explicit agent-browser binary as a build of the commit
 * `.github/native-candidate.json` pins, so the redacted report can name a
 * commit that its sha256 actually proves instead of the HEAD of whichever git
 * checkout happens to contain the binary.
 *
 * Run it right after building the pinned source:
 *
 *   E2E_AGENT_BROWSER_EXECUTABLE=/absolute/path/to/agent-browser \
 *     pnpm --filter @e2e-dev/uat-verification native:record
 */
import { appRoot } from '../src/e2e-cli.ts';
import { recordNativeBuild } from '../src/identity.ts';

try {
  const { file, record } = recordNativeBuild(appRoot, process.env);
  console.log(`Recorded agent-browser ${record.commit} · sha256 ${record.sha256}`);
  console.log(`Native build record: ${file}`);
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exit(2);
}
