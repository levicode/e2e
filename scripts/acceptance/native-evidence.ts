import { createHash } from 'node:crypto';

export const nativeContractLogName = (name: string): string => `browser-${createHash('sha256').update(name).digest('hex')}.log`;

/** Default upstream inventory can contain ignored browser tests: preserve, never hide them. */
export function nativeTestEvidence(log: string): { passed: number; ignored: number } {
  const summaries = [...log.matchAll(/test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/g)];
  if (!summaries.length || summaries.some((match) => match[1] !== 'ok' || Number(match[3]) !== 0)) throw new Error('Native test execution was not successful');
  const passed = summaries.reduce((count, match) => count + Number(match[2]), 0);
  if (passed === 0) throw new Error('Native tests executed zero passing cases');
  return { passed, ignored: summaries.reduce((count, match) => count + Number(match[4]), 0) };
}
