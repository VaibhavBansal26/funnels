import { describe, expect, it } from 'vitest';
import { validateResolutions } from '../components/ConflictDialog';
import { niceMax } from '../components/Charts';
import { wrapText } from '../components/FunnelThumb';
import { validateAi, validateBlank, slugify } from './NewFunnelPage';
import { moveItem, reorderKey, toOrders } from './reorder';
import { buildPatch, validateSettings } from './SettingsTab';
import { validateHostname } from './DomainsPage';
import { validateWebhook } from './WebhooksPage';
import { validatePageSettings } from '../builder/dialogs';
import { validateLogin, validateRegister } from '../auth/validate';

describe('step reordering', () => {
  it('moves items and clamps', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveItem(['a', 'b'], 0, 9)).toEqual(['b', 'a']);
    expect(moveItem(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
  });
  it('builds the contiguous order payload', () => {
    expect(toOrders([{ id: 'x' }, { id: 'y' }])).toEqual([{ stepId: 'x', order: 1 }, { stepId: 'y', order: 2 }]);
  });
  it('keyboard model: Alt+Arrow moves, plain arrows and edges do not', () => {
    expect(reorderKey({ key: 'ArrowDown', altKey: true }, 0, 3)).toEqual({ from: 0, to: 1 });
    expect(reorderKey({ key: 'ArrowUp', altKey: true }, 2, 3)).toEqual({ from: 2, to: 1 });
    expect(reorderKey({ key: 'ArrowUp', altKey: true }, 0, 3)).toBeNull();
    expect(reorderKey({ key: 'ArrowDown', altKey: true }, 2, 3)).toBeNull();
    expect(reorderKey({ key: 'ArrowDown', altKey: false }, 0, 3)).toBeNull();
    expect(reorderKey({ key: 'Home', altKey: true }, 2, 3)).toEqual({ from: 2, to: 0 });
    expect(reorderKey({ key: 'End', altKey: true }, 0, 3)).toEqual({ from: 0, to: 2 });
    expect(reorderKey({ key: 'x', altKey: true }, 1, 3)).toBeNull();
  });
});

describe('form validation helpers', () => {
  it('login and register', () => {
    expect(validateLogin({ email: '', password: '' })).toEqual({ email: 'Enter your email address', password: 'Enter your password' });
    expect(validateLogin({ email: 'nope', password: 'x' }).email).toBe('Enter a valid email address');
    expect(validateLogin({ email: 'a@b.co', password: 'x' })).toEqual({});
    expect(validateRegister({ name: '', email: 'a@b.co', password: 'short' })).toEqual({ name: 'Enter your name', password: 'Password must be at least 8 characters' });
    expect(validateRegister({ name: 'Ann', email: 'a@b.co', password: 'long-enough' })).toEqual({});
  });
  it('blank funnel and AI wizard', () => {
    expect(validateBlank({ name: ' ', path: '/ok' }).name).toBeDefined();
    for (const p of ['nope', '/a/b', '/a.html', '/a b', '/a?x']) expect(validateBlank({ name: 'n', path: p }).path, p).toBeDefined();
    expect(validateBlank({ name: 'n', path: '/good-1' })).toEqual({});
    expect(slugify('Spring Sale 2026!')).toBe('/spring-sale-2026');
    expect(slugify('***')).toBe('/funnel');
    expect(validateAi({ business: '  ' }).business).toBeDefined();
    expect(validateAi({ business: 'candles' })).toEqual({});
  });
  it('domain, webhook, settings, page settings, conflict resolutions', () => {
    for (const bad of ['', 'http://x.com', 'x.com/path', 'x.com:80', 'nodots', '1.2.3.4']) expect(validateHostname(bad), bad).not.toBeNull();
    expect(validateHostname('Offers.Example.com')).toBeNull();
    expect(validateWebhook({ url: 'nope', events: [] })).toEqual({ url: expect.any(String), events: expect.any(String) });
    expect(validateWebhook({ url: 'ftp://x.com', events: ['funnel.optin'] }).url).toBeDefined();
    expect(validateWebhook({ url: 'https://x.com/h', events: ['funnel.optin'] })).toEqual({});
    const base = { name: 'F', status: 'test' as const, domainId: '', tags: [], favicon: '', header: '', footer: '' };
    expect(validateSettings({ ...base, status: 'live' }).domainId).toBeDefined();
    expect(validateSettings({ ...base, favicon: 'javascript:x' }).favicon).toBeDefined();
    expect(validateSettings(base)).toEqual({});
    expect(validatePageSettings({ name: '', path: 'x', title: '', seo: '', css: '', header: '', footer: '', accent: 'red;x', background: '', font: '' })).toMatchObject({ name: expect.any(String), path: expect.any(String), accent: expect.any(String) });
    expect(validateResolutions([{ path: '/a', resolved_path: '/a-1' }, { path: '/b', resolved_path: '/A-1/' }])['/b']).toContain('Already used');
    expect(validateResolutions([{ path: '/a', resolved_path: 'bad' }])['/a']).toBeDefined();
    expect(validateResolutions([{ path: '/a', resolved_path: '/a-1' }])).toEqual({});
  });
  it('settings patch sends only what changed and lets status test detach the domain server-side', () => {
    const orig = { name: 'F', status: 'live' as const, domainId: 'd1', tags: ['t1'], favicon: '', header: '', footer: '' };
    expect(buildPatch(orig, { ...orig }, true)).toEqual({});
    expect(buildPatch(orig, { ...orig, status: 'test' }, true)).toEqual({ status: 'test' });
    expect(buildPatch(orig, { ...orig, domainId: 'd2', name: ' New ' }, true)).toEqual({ name: 'New', domain_id: 'd2' });
    expect(buildPatch(orig, { ...orig, tags: ['t1', 't2'], header: '<s>' }, false)).toEqual({ tags: ['t1', 't2'] });
    expect(buildPatch(orig, { ...orig, header: '<s>' }, true)).toEqual({ header_tracking_code: '<s>' });
  });
});

describe('chart and thumbnail helpers', () => {
  it('niceMax gives readable axis bounds, even for no data', () => {
    expect([0, -5, NaN].map(niceMax)).toEqual([1, 1, 1]);
    expect([1, 3, 7, 12, 99, 101, 4200].map(niceMax)).toEqual([1, 5, 10, 20, 100, 200, 5000]);
  });
  it('wraps headings into at most three lines with an ellipsis', () => {
    expect(wrapText('Short')).toEqual(['Short']);
    const lines = wrapText('Free guide: seven ways to double your email list this year and beyond', 22, 3);
    expect(lines).toHaveLength(3);
    expect(lines.at(-1)!.endsWith('…')).toBe(true);
    expect(wrapText('')).toEqual(['']);
  });
});
