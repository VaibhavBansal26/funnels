import type { Editor } from 'grapesjs';
import { cleanProject, emptyProject, type CleanFailure, type CleanResult } from '@pagemodel';
import { setNormalizing, setWrapperRules } from './normalize';

/** Loads a stored page document (version 2) into the editor. The project is rebuilt from the allow-list first: nothing unexpected reaches the canvas. */
export function loadDoc(editor: Editor, doc: unknown): { ok: true; notes: string[] } | { ok: false; issues: string[] } {
  const project = (doc as { project?: unknown } | null)?.project;
  const cleaned = cleanProject(project);
  setNormalizing(editor, false);
  try {
    return load(editor, cleaned);
  } finally {
    setNormalizing(editor, true);
  }
}

function load(editor: Editor, cleaned: CleanResult | CleanFailure): { ok: true; notes: string[] } | { ok: false; issues: string[] } {
  if (!cleaned.ok) {
    editor.loadProjectData(emptyProject() as never);
    setWrapperRules(editor);
    editor.UndoManager.clear();
    return { ok: false, issues: cleaned.issues.map((i) => `${i.path}: ${i.message}`) };
  }
  editor.loadProjectData(cleaned.project as never);
  setWrapperRules(editor);
  editor.UndoManager.clear();
  editor.clearDirtyCount?.();
  return { ok: true, notes: cleaned.notes };
}

/** The editable source of truth: GrapesJS project data. The server renders the published page from it; the editor never sends HTML. */
export const readProject = (editor: Editor): unknown => editor.getProjectData();

/** Validates what would be saved, with the same function the server runs (limits, allow-lists, form and product props). */
export function checkProject(editor: Editor): CleanResult | CleanFailure {
  return cleanProject(readProject(editor));
}
