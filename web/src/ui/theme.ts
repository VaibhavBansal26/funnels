import { useCallback, useSyncExternalStore } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'funnels.theme';
const listeners = new Set<() => void>();

const read = (): ThemeChoice => {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
};

/** Applies the stored choice to <html data-theme>. "system" removes the attribute so prefers-color-scheme decides. Call once at startup. */
export function applyTheme(choice: ThemeChoice = read()): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

export function setTheme(choice: ThemeChoice): void {
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    /* private mode: the choice lasts until reload */
  }
  applyTheme(choice);
  listeners.forEach((l) => l());
}

export function useTheme(): [ThemeChoice, (c: ThemeChoice) => void] {
  const choice = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    read,
    () => 'system' as ThemeChoice,
  );
  return [choice, useCallback((c: ThemeChoice) => setTheme(c), [])];
}
