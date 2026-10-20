import { describe, expect, it } from 'vitest';
import { createEditor } from './editor/createEditor';
import { loadDoc } from './editor/load';
import { createPageBuilder } from '@pagemodel';

describe('headless', () => {
  it('boots', () => {
    const ed = createEditor(null, { funnelId: 'f', stepId: 's', steps: [], canScripts: true }, { headless: true });
    const pm = createPageBuilder('t');
    const project = pm.project([pm.section([pm.stack([pm.heading('Hi')])])]);
    const r = loadDoc(ed, { version: 2, project });
    expect(r.ok).toBe(true);
    expect(ed.getWrapper()!.components().length).toBe(1);
    expect(ed.Blocks.getAll().length).toBeGreaterThan(30);
    expect(ed.Layers.getComponents(ed.getWrapper()!).length).toBe(1);
  });
});
