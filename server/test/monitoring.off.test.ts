import { describe, expect, it, vi } from 'vitest';
import { NOOP_MONITOR, createMonitor } from '../src/monitoring/index.js';
import { loadConfig } from '../src/config.js';
import { makeHarness } from './helpers.js';

// Without SENTRY_DSN error monitoring must cost nothing: the SDK is not even imported (this mock throws if it is), and no request leaves the process.
vi.mock('@sentry/node', () => {
  throw new Error('@sentry/node must not be imported when SENTRY_DSN is unset');
});

describe('error monitoring is off unless configured', () => {
  it('returns the inert monitor, imports nothing and sends nothing, even when the app has a 500', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const config = loadConfig({ NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(40) });
    expect(config.SENTRY_DSN).toBeUndefined();
    expect(config.SENTRY_TRACES_SAMPLE_RATE).toBe(0.05);
    const monitor = await createMonitor(config);
    expect(monitor).toBe(NOOP_MONITOR);
    expect(monitor.enabled).toBe(false);
    expect(monitor.captureError(new Error('x'))).toBeNull();
    expect(monitor.startRequest('GET')).toBeNull();
    expect(await monitor.flush()).toBe(true);
    expect(await monitor.close()).toBe(true);
    // an empty value counts as unset
    expect(await createMonitor(loadConfig({ NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(40), SENTRY_DSN: '  ' }))).toBe(NOOP_MONITOR);

    const h = await makeHarness({});
    const owner = await h.register();
    const real = h.deps.db.get.bind(h.deps.db);
    vi.spyOn(h.deps.db, 'get').mockImplementation(((sql: string, ...p: any[]) => {
      if (/SELECT COUNT\(\*\) AS n FROM funnels f WHERE/.test(sql)) throw new Error('db exploded');
      return real(sql, ...p);
    }) as never);
    expect((await h.call('GET', '/api/funnels', { token: owner.token })).status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.deps.monitor).toBe(NOOP_MONITOR);
  });

  it('the generated documentation and the schema agree on the defaults', () => {
    const c = loadConfig({ NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(40), SENTRY_TRACES_SAMPLE_RATE: '0.25', SENTRY_ENVIRONMENT: 'staging' });
    expect(c.SENTRY_TRACES_SAMPLE_RATE).toBe(0.25);
    expect(() => loadConfig({ NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(40), SENTRY_TRACES_SAMPLE_RATE: '2' })).toThrow(/SENTRY_TRACES_SAMPLE_RATE/);
  });
});
