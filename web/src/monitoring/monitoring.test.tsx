import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scrubEvent } from '@monitoring-scrub';
import { ErrorBoundary, RouteErrorPage } from '../components/ErrorBoundary';
import { hashWorkspace, monitoringActive, reportRenderError, resetMonitoringForTests, setMonitoringWorkspace, startMonitoring } from '.';

afterEach(() => resetMonitoringForTests());

const json = (body: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => body }) as Response);
const fakeSentry = () => {
  const calls = { init: [] as any[], captured: [] as any[], tags: [] as [string, string][] };
  const mod = { init: (o: any) => void calls.init.push(o), captureException: (e: unknown, ctx: unknown) => void calls.captured.push([e, ctx]), setTag: (k: string, v: string) => void calls.tags.push([k, v]) };
  return { calls, load: async () => mod as never };
};

describe('browser monitoring is off unless the server enables it', () => {
  it('no DSN: only /api/config is requested and no Sentry code is loaded', async () => {
    const f = json({ monitoring: null });
    const load = vi.fn();
    expect(await startMonitoring({ fetchImpl: f as never, load })).toBe(false);
    expect(f).toHaveBeenCalledTimes(1);
    expect((f.mock.calls as unknown as unknown[][])[0]![0]).toBe('/api/config');
    expect(load).not.toHaveBeenCalled();
    expect(monitoringActive()).toBe(false);
    reportRenderError(new Error('ignored')); // does nothing, throws nothing
  });

  it('a failing config request or an unloadable SDK never breaks the app', async () => {
    expect(await startMonitoring({ fetchImpl: vi.fn(async () => { throw new Error('offline'); }) as never })).toBe(false);
    expect(await startMonitoring({ fetchImpl: json({}, false) as never })).toBe(false);
    expect(await startMonitoring({ fetchImpl: json({ monitoring: { dsn: 'https://k@o1.ingest.example.test/1', environment: 'x', release: null, tracesSampleRate: 0 } }) as never, load: async () => { throw new Error('chunk failed'); } })).toBe(false);
    expect(monitoringActive()).toBe(false);
  });

  it('with a DSN: lazy-loads the SDK with everything personal switched off, no replay, no breadcrumbs, own scripts only', async () => {
    const s = fakeSentry();
    const cfg = { monitoring: { dsn: 'https://k@o1.ingest.example.test/1', environment: 'production', release: 'abc123', tracesSampleRate: 0 } };
    expect(await startMonitoring({ fetchImpl: json(cfg) as never, load: s.load, origin: 'https://app.example.com' })).toBe(true);
    const o = s.calls.init[0];
    expect(o).toMatchObject({ dsn: cfg.monitoring.dsn, environment: 'production', release: 'abc123', sendDefaultPii: false, maxBreadcrumbs: 0, allowUrls: ['https://app.example.com/assets/'] });
    expect(o.dataCollection).toMatchObject({ userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false });
    expect(o).not.toHaveProperty('replaysSessionSampleRate');
    expect(o).not.toHaveProperty('tracesSampleRate');
    expect(o.beforeBreadcrumb({ message: 'x' })).toBeNull();
    const kept = o.integrations([{ name: 'Breadcrumbs' }, { name: 'GlobalHandlers' }, { name: 'Replay' }, { name: 'BrowserSession' }, { name: 'HttpContext' }, { name: 'Dedupe' }]).map((i: any) => i.name);
    expect(kept).toEqual(['GlobalHandlers', 'Dedupe']);
    const scrubbed = o.beforeSend({ message: 'oops for ada@example.com', user: { email: 'ada@example.com' }, request: { url: 'https://app.example.com/funnels/fn_1?token=abc', headers: { cookie: 'x' } }, extra: { html: '<h1>offer</h1>' }, breadcrumbs: [{ message: 'click' }] });
    expect(JSON.stringify(scrubbed)).not.toMatch(/ada@example\.com|token=abc|cookie|offer|click/);
    reportRenderError(new Error('render failed'));
    expect(s.calls.captured).toHaveLength(1);
    expect(s.calls.captured[0][1]).toEqual({ tags: { surface: 'react' } });
  });

  it('the workspace is a hash, the same one the server uses; no user identity is set', async () => {
    const h = await hashWorkspace('ws_example');
    expect(h).toMatch(/^[0-9a-f]{12}$/);
    expect(h).toBe(createHash('sha256').update('workspace:ws_example').digest('hex').slice(0, 12)); // the server's workspaceTag
    const s = fakeSentry();
    await setMonitoringWorkspace('ws_example'); // before start: remembered
    await startMonitoring({ fetchImpl: json({ monitoring: { dsn: 'https://k@o1.ingest.example.test/1', environment: 'e', release: null, tracesSampleRate: 0 } }) as never, load: s.load });
    expect(s.calls.tags).toContainEqual(['workspace', h]);
    expect(JSON.stringify(s.calls)).not.toContain('ws_example');
    expect(s.calls.init[0]).not.toHaveProperty('initialScope');
  });

  it('the shared scrubber also handles browser file names', () => {
    const e = scrubEvent({ exception: { values: [{ type: 'TypeError', value: 'x', stacktrace: { frames: [{ filename: 'https://app.example.com/assets/index-Ab12.js?v=1', function: 'a', in_app: true }] } }] } } as never) as any;
    expect(e.exception.values[0].stacktrace.frames[0].filename).toBe('assets/index-Ab12.js');
  });
});

function Boom(): never {
  throw new Error('render exploded');
}

describe('error boundaries', () => {
  it('show a plain fallback with a reload button and report the error when monitoring is on', async () => {
    const s = fakeSentry();
    await startMonitoring({ fetchImpl: json({ monitoring: { dsn: 'https://k@o1.ingest.example.test/1', environment: 'e', release: null, tracesSampleRate: 0 } }) as never, load: s.load });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.getByRole('button', { name: 'Reload the page' })).toBeInTheDocument();
    expect(s.calls.captured).toHaveLength(1);
    spy.mockRestore();
  });

  it('the router error element reports and renders the same fallback', async () => {
    const s = fakeSentry();
    await startMonitoring({ fetchImpl: json({ monitoring: { dsn: 'https://k@o1.ingest.example.test/1', environment: 'e', release: null, tracesSampleRate: 0 } }) as never, load: s.load });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const router = createMemoryRouter([{ path: '/', element: <Boom />, errorElement: <RouteErrorPage /> }]);
    render(<RouterProvider router={router} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    expect(s.calls.captured.length).toBeGreaterThan(0);
    spy.mockRestore();
  });

  it('without monitoring the boundary still protects the screen and reports nothing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    spy.mockRestore();
  });
});
