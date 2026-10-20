import type { Component } from 'grapesjs';

/**
 * A "class group" is a set of mutually exclusive CSS classes with one model property that mirrors which one is active
 * (e.g. section width: fn-w-small | fn-w-medium | fn-w-wide | fn-w-full). Traits edit the property; the classes follow, and the
 * property is read back from the classes when a component is created or loaded, so project data stays plain classes.
 */
export interface ClassGroup {
  prop: string;
  prefix: string;
  values: string[];
  /** The value used when no class of the group is present. */
  fallback: string;
  /** A value that is represented by NO class (the CSS default), e.g. button size "md". */
  none?: string;
}

const has = (c: Component, cls: string): boolean => c.getClasses().includes(cls);

export function bindClassGroups(model: Component, groups: ClassGroup[]): void {
  for (const g of groups) {
    const found = g.values.find((v) => v !== g.none && has(model, `${g.prefix}${v}`));
    model.set(g.prop, found ?? g.fallback, { silent: true });
    model.on(`change:${g.prop}`, () => {
      const next = String(model.get(g.prop) ?? g.fallback);
      for (const v of g.values) if (v !== g.none) model.removeClass(`${g.prefix}${v}`);
      if (next !== g.none) model.addClass(`${g.prefix}${next}`);
    });
  }
}

/** A boolean flag mirrored by a single class (e.g. fn-btn-block). */
export function bindClassFlag(model: Component, prop: string, className: string): void {
  model.set(prop, has(model, className), { silent: true });
  model.on(`change:${prop}`, () => (model.get(prop) ? model.addClass(className) : model.removeClass(className)));
}
