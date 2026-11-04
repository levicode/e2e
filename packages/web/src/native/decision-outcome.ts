/** Private proof of an explicit native control rejection, never inferred from error text. */
const rejected = new WeakSet<Error>();
export function rejectedDecision(error: Error): Error { rejected.add(error); return error; }
export function isRejectedDecision(error: unknown): boolean { return error instanceof Error && rejected.has(error); }
