import type { Deps } from '../deps.js';

/**
 * Runs `fn` in a transaction with a Deps whose `db` (and queue) are bound to the transaction handle, so every
 * service function called with the scoped deps takes part in the transaction without knowing it.
 *
 * Effects that must not be visible before commit (page-cache invalidation, SSE notifications) are collected and
 * run only after COMMIT; if the transaction is retried or rolled back they are discarded. Nested calls become
 * savepoints and hand their deferred effects to the outermost transaction.
 */
export async function inTx<T>(deps: Deps, fn: (d: Deps) => Promise<T>): Promise<T> {
  if (deps.defer) return deps.db.transaction((tx) => fn({ ...deps, db: tx, jobs: deps.jobs.using(tx) }));
  let after: (() => void)[] = [];
  const result = await deps.db.transaction(async (tx) => {
    after = [];
    const defer = (f: () => void) => void after.push(f);
    const scoped: Deps = {
      ...deps,
      db: tx,
      jobs: deps.jobs.using(tx),
      defer,
      pageCache: Object.assign(Object.create(deps.pageCache), { invalidate: (ids: string[]) => defer(() => deps.pageCache.invalidate(ids)) }),
      bus: Object.assign(Object.create(deps.bus), { publish: (ws: string, e: Parameters<Deps['bus']['publish']>[1]) => defer(() => deps.bus.publish(ws, e)) }),
    };
    return fn(scoped);
  });
  for (const f of after) f();
  return result;
}
