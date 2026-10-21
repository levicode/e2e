/** Only existing test fakes may back the retained legacy ownership assertions. */
import type { Browser } from 'playwright-core';

export function scriptedConnection(acquire: () => Promise<Browser>) {
  return {
    acquire,
    dispose: async (): Promise<void> => undefined,
    connectCdp: async (): Promise<Browser> => { throw new Error('Unexpected CDP dial in a scripted connection test'); },
  };
}
