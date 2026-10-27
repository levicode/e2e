/** Renders an engine ID without changing a canonical, sigil-prefixed reference. */
export function referenceText(id: string): string {
  return id.startsWith('@') ? id : `#${id}`;
}
