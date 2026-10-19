/** Returns a new list with the item at `from` moved to index `to` (clamped). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length) return [...list];
  const clamped = Math.max(0, Math.min(list.length - 1, to));
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(clamped, 0, item as T);
  return next;
}

/** The payload for PUT /steps/order: every step exactly once with contiguous 1..n positions. */
export const toOrders = (steps: readonly { id: string }[]): { stepId: string; order: number }[] => steps.map((s, i) => ({ stepId: s.id, order: i + 1 }));

/** Keyboard model for reordering rows: Alt+ArrowUp/Down moves the focused row, Alt+Home/End jumps to the ends. Returns the move or null. */
export function reorderKey(e: { key: string; altKey: boolean }, index: number, length: number): { from: number; to: number } | null {
  if (!e.altKey) return null;
  let to: number;
  switch (e.key) {
    case 'ArrowUp': to = index - 1; break;
    case 'ArrowDown': to = index + 1; break;
    case 'Home': to = 0; break;
    case 'End': to = length - 1; break;
    default: return null;
  }
  if (to < 0 || to >= length || to === index) return null;
  return { from: index, to };
}
