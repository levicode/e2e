import { prepareWebCaseNativeCapture } from './case-cleanup-capture.ts';
/** Enable closed diagnostics only around the original P32 workload, including its cleanup. */
export async function withLifecycleOpenCancelDiagnostics<T>(run: (env?: NodeJS.ProcessEnv) => Promise<T>, captureOriginalCase = false): Promise<T> {
  const capture = captureOriginalCase ? prepareWebCaseNativeCapture('lifecycle-open-cancel') : undefined;
  if (process.env['E2E_LIFECYCLE_OPEN_CANCEL_CAPTURE'] !== '1' && capture === undefined) return run();
  if (process.env['E2E_LIFECYCLE_OPEN_CANCEL_CAPTURE'] !== '1') {
    try { return await run(capture?.env); } finally { capture?.finish(); }
  }
  const previous = process.env['E2E_LIFECYCLE_OPEN_CANCEL_DIAGNOSTIC'];
  process.env['E2E_LIFECYCLE_OPEN_CANCEL_DIAGNOSTIC'] = 'lifecycle-open-cancel';
  try { return await run(capture?.env); }
  finally {
    capture?.finish();
    if (previous === undefined) delete process.env['E2E_LIFECYCLE_OPEN_CANCEL_DIAGNOSTIC'];
    else process.env['E2E_LIFECYCLE_OPEN_CANCEL_DIAGNOSTIC'] = previous;
  }
}
