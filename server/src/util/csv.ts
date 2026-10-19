/** Prefix cells that spreadsheet apps would interpret as formulas (CSV injection). */
export function neutralizeCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

export function csvCell(value: unknown): string {
  const s = neutralizeCell(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/**
 * Streams a CSV built from keyset pages: `next(cursor)` returns up to one page of rows plus the cursor for the
 * following page (or null at the end). Memory stays bounded to one page regardless of the export size.
 */
export function csvStream<C>(headers: string[], next: (cursor: C | null) => Promise<{ rows: unknown[][]; cursor: C | null }>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let cursor: C | null = null;
  let started = false;
  let done = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(enc.encode(toCsv(headers, [])));
        return;
      }
      if (done) {
        controller.close();
        return;
      }
      const page = await next(cursor);
      cursor = page.cursor;
      if (page.cursor === null) done = true;
      if (page.rows.length) controller.enqueue(enc.encode(page.rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'));
      else if (done) controller.close();
    },
  });
}
