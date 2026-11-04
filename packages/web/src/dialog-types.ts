/** Public dialog callback contracts, independent of the browser backend. */
/** A native dialog as a test's handler sees it. */
export interface Dialog {
  /** The native dialog kind, independent of its message. */
  readonly type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  /** The dialog's text. */
  readonly message: string;
  /** Accepts the dialog once. */
  accept(text?: string): Promise<void>;
  /** Dismisses the dialog once. */
  dismiss(): Promise<void>;
}

export type DialogHandler = 'accept' | 'dismiss' | ((dialog: Dialog) => void | Promise<void>);

