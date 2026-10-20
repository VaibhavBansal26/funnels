import type { Editor } from 'grapesjs';

/** What the editor needs to know about the funnel it is editing. Passed to component types and commands (never read from the page content). */
export interface BuilderEnv {
  funnelId: string;
  stepId: string;
  steps: { id: string; name: string }[];
  /** May the signed-in user author scripts (custom code blocks)? Mirrors the server rule (owner and workspace flag); the server enforces it. */
  canScripts: boolean;
}

const KEY = '__fnEnv';
export const setEnv = (editor: Editor, env: BuilderEnv): void => void ((editor as unknown as Record<string, unknown>)[KEY] = env);
export const getEnv = (editor: Editor): BuilderEnv => (editor as unknown as Record<string, BuilderEnv>)[KEY]!;
