/** All E2E node IDs use the same display grammar, independently of their engine. */
export function referenceText(id: string): string {
  return `#${id}`;
}

/**
 * The engine's spelling of a target id. A listing prints each id as `#@e123`
 * (the `#` the listing adds and the `@` an engine may mint), and a model
 * copies it without the `#`, or now and then without the `@` too. An id the
 * caller's screens do not list is retried with that `@` toggled, since a
 * screen lists ids under one spelling only: an id that names no node stays
 * as written, so its error repeats what was asked.
 */
export function listedReference(id: string, listed: (id: string) => boolean): string {
  if (listed(id)) return id;
  const toggled = id.startsWith('@') ? id.slice(1) : `@${id}`;
  return listed(toggled) ? toggled : id;
}
