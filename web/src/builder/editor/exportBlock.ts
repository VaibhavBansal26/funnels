import type { Component, Editor } from 'grapesjs';

/**
 * A component subtree as reusable block content. Component styles live in project-level rules (by id), so they are folded back into
 * each node's `style` and the ids are dropped: the new copy gets fresh ids and its own rules when it is inserted.
 */
export function exportComponent(editor: Editor, root: Component): Record<string, unknown> {
  const json = root.toJSON() as Record<string, unknown>;
  const walk = (comp: Component, node: Record<string, unknown>) => {
    const rule = editor.Css.getRule(`#${comp.getId()}`);
    const style = rule?.getStyle() as Record<string, string> | undefined;
    if (style && Object.keys(style).length) node.style = { ...style };
    const attrs = { ...((node.attributes as Record<string, string> | undefined) ?? {}) };
    delete attrs.id;
    if (Object.keys(attrs).length) node.attributes = attrs;
    else delete node.attributes;
    const kids = comp.components().models;
    ((node.components as Record<string, unknown>[] | undefined) ?? []).forEach((n, i) => kids[i] && walk(kids[i]!, n));
  };
  walk(root, json);
  return json;
}
