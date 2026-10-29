/** Enable closed diagnostics only around the original P32 workload, including its cleanup. */
export async function withLifecycleOpenCancelDiagnostics<T>(run: () => Promise<T>): Promise<T> {
  if (process.env['E2E_LIFECYCLE_OPEN_CANCEL_CAPTURE'] !== '1') return run();
  const previous = process.env['E2E_LIFECYCLE_OPEN_CANCEL_DIAGNOSTIC'];
  process.env['E2E_LIFECYCLE_OPEN_CANCEL_DIAGNOSTIC'] = 'lifecycle-open-cancel';
  try { return await run(); }
  finally {
    if (previous === undefined) delete process.env['E2E_LIFECYCLE_OPEN_CANCEL_DIAGNOSTIC'];
    else process.env['E2E_LIFECYCLE_OPEN_CANCEL_DIAGNOSTIC'] = previous;
  }
}
