/** Short random block ids. Uniqueness within a document is checked by the caller with `uniqueId`. */
export function randomId(prefix = 'b'): string {
  const bytes = new Uint8Array(5);
  (globalThis.crypto ?? { getRandomValues: (a: Uint8Array) => a.map(() => Math.floor(Math.random() * 256)) }).getRandomValues(bytes);
  return prefix + [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 8);
}

export function uniqueId(taken: Set<string>, prefix = 'b'): string {
  let id = randomId(prefix);
  while (taken.has(id)) id = randomId(prefix);
  taken.add(id);
  return id;
}
