import { describe, expect, it } from 'vitest';
import { makeHarness, makeFunnel } from './helpers.js';

describe('smoke', () => {
  it('registers, creates a funnel and renders a preview', async () => {
    const h = makeHarness();
    const u = await h.register();
    const f = await makeFunnel(h, u.token);
    expect(f.steps).toHaveLength(1);
    const t = await h.call('POST', `/api/funnels/${f.id}/preview-token`, { token: u.token });
    expect(t.status).toBe(200);
    const page = await h.call('GET', t.json.url);
    expect(page.status).toBe(200);
    expect(page.text).toContain('<!doctype html>');
    const list = await h.call('GET', '/api/funnels', { token: u.token });
    expect(list.json.data).toHaveLength(1);
  });
});
