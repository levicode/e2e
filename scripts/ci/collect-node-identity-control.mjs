/** Pure model parameters only; does not spoof process.version or run a loader test. */
import { collectNodeIdentity } from '../../packages/e2e/tests/helpers/collect-fs-applicability.ts';
const matrix = JSON.parse(process.argv[2]);
const results = matrix.map(([requested, actual]) => { try { return { accepted: true, full: collectNodeIdentity(requested, actual) }; } catch { return { accepted: false }; } });
process.stdout.write(JSON.stringify(results));
