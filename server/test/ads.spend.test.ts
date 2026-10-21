import { describe, expect, it } from 'vitest';
import { parseCsv, CsvError } from '../src/util/csvparse.js';
import { parseMoney } from '../src/services/adspend.js';
import { adsWorld } from './support/adsworld.js';

describe('CSV reader', () => {
  it('handles BOM, CRLF, quotes, embedded commas and newlines, doubled quotes, trailing blank lines', () => {
    const p = parseCsv('﻿date,campaign,spend\r\n2026-03-01,"Spring, ""Big"" sale",10.5\r\n2026-03-02,"two\nlines",3\r\n\r\n');
    expect(p.header).toEqual(['date', 'campaign', 'spend']);
    expect(p.rows.map((r) => r.cells)).toEqual([['2026-03-01', 'Spring, "Big" sale', '10.5'], ['2026-03-02', 'two\nlines', '3']]);
    expect(p.rows[1]!.line).toBe(3);
  });
  it('detects semicolons and tabs', () => {
    expect(parseCsv('a;b\n1;2').rows[0]!.cells).toEqual(['1', '2']);
    expect(parseCsv('a\tb\n1\t2').rows[0]!.cells).toEqual(['1', '2']);
  });
  it('is strict about broken quoting, with the line number', () => {
    expect(() => parseCsv('a,b\n"open,1')).toThrow(CsvError);
    expect(() => parseCsv('a,b\nab"c,1')).toThrow(/quote inside an unquoted field/);
    expect(() => parseCsv('a,b\n"ab"c,1')).toThrow(/closing quote/);
    try {
      parseCsv('a,b\n1,2\nx"y,3');
    } catch (e) {
      expect((e as CsvError).line).toBe(3);
    }
    expect(() => parseCsv('')).toThrow(/empty/);
  });
  it('stops at the row cap', () => {
    const big = 'a\n' + '1\n'.repeat(50);
    expect(() => parseCsv(big, { maxRows: 10 })).toThrow(/more than 10 rows/);
  });
});

describe('money parsing', () => {
  it.each([['10', 10], ['10.5', 10.5], ['1,234.50', 1234.5], ['$1,234.50', 1234.5], [' 12 ', 12], ['€ 9.99', 9.99], ['0', 0], ['1 234.50', 1234.5], ['1,234,567', 1234567]] as const)('%s', (raw, want) => expect(parseMoney(raw)).toBe(want));
  it.each(['', 'abc', '-5', '1.234,50', '12,34', '1e5', '1..2', '--', '1,23'])('refuses %j', (raw) => expect(parseMoney(raw)).toBeNull());
});

describe('spend entry', () => {
  it('saves, replaces on the same key, lists, deletes; validates', async () => {
    const w = await adsWorld();
    const a = await w.spend({ day: '2026-03-01', source: 'Facebook', campaign: 'Spring', currency: 'usd', spend: 120.5, impressions: 1000, clicks: 50 });
    expect(a.status).toBe(200);
    expect(a.json).toMatchObject({ outcome: 'created', row: { source: 'facebook', currency: 'USD', spend: 120.5, impressions: 1000, clicks: 50 } });
    const b = await w.spend({ day: '2026-03-01', source: 'facebook', campaign: 'Spring', currency: 'USD', spend: 100 });
    expect(b.json.outcome).toBe('updated');
    const list = await w.h.call('GET', '/api/ads/spend', { token: w.owner.token });
    expect(list.json.data).toHaveLength(1);
    expect(list.json.data[0].spend).toBe(100);
    expect(list.json.data[0].impressions).toBeNull();
    for (const bad of [{ day: '2026-02-30' }, { day: 'yesterday' }, { currency: 'US' }, { currency: 'ZZZ' }, { spend: -1 }, { spend: 1e10 }, { campaign: '' }, { source: '  ' }, { impressions: -1 }, { clicks: 1.5 }, { funnelId: 'fn_nope' }]) {
      const r = await w.spend({ day: '2026-03-01', source: 'x', campaign: 'c', currency: 'USD', spend: 1, ...bad });
      expect(r.status, JSON.stringify(bad)).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
    }
    expect((await w.h.call('DELETE', `/api/ads/spend/${list.json.data[0].id}`, { token: w.owner.token })).status).toBe(204);
    expect((await w.h.call('GET', '/api/ads/spend', { token: w.owner.token })).json.data).toEqual([]);
  });
  it('keeps currencies apart (the same campaign in two currencies is two rows) and honours currency exponents', async () => {
    const w = await adsWorld();
    await w.spend({ day: '2026-03-01', source: 'meta', campaign: 'C', currency: 'USD', spend: 10 });
    await w.spend({ day: '2026-03-01', source: 'meta', campaign: 'C', currency: 'EUR', spend: 10 });
    await w.spend({ day: '2026-03-01', source: 'meta', campaign: 'C', currency: 'JPY', spend: 1500 });
    const list = (await w.h.call('GET', '/api/ads/spend', { token: w.owner.token })).json.data;
    expect(list).toHaveLength(3);
    expect(list.find((r: any) => r.currency === 'JPY').spend).toBe(1500);
    const raw = await w.h.deps.db.get<any>("SELECT spend_cents FROM ad_spend WHERE currency = 'JPY'");
    expect(Number(raw.spend_cents)).toBe(1500); // yen have no minor unit
  });
  it('permissions and tenancy', async () => {
    const w = await adsWorld();
    const viewer = await w.h.member(w.owner, 'viewer');
    const member = await w.h.member(w.owner, 'member');
    await w.spend({ day: '2026-03-01', source: 'x', campaign: 'c', currency: 'USD', spend: 5 });
    expect((await w.h.call('GET', '/api/ads/spend', { token: viewer.token })).status).toBe(200);
    expect((await w.h.call('GET', '/api/ads/performance', { token: member.token })).status).toBe(200);
    for (const t of [viewer.token, member.token]) {
      expect((await w.spend({ day: '2026-03-02', source: 'x', campaign: 'c', currency: 'USD', spend: 5 }, t)).status).toBe(403);
      expect((await w.csv('date,source,campaign,currency,spend\n2026-03-01,x,c,USD,1', '', t)).status).toBe(403);
    }
    const other = await w.h.register();
    expect((await w.h.call('GET', '/api/ads/spend', { token: other.token })).json.data).toEqual([]);
    const id = (await w.h.call('GET', '/api/ads/spend', { token: w.owner.token })).json.data[0].id;
    expect((await w.h.call('DELETE', `/api/ads/spend/${id}`, { token: other.token })).status).toBe(404);
    expect((await w.h.call('GET', '/api/ads/performance', { token: other.token })).json.rows).toEqual([]);
  });
});

describe('CSV import', () => {
  const head = 'date,source,account,campaign,currency,spend,impressions,clicks\n';

  it('imports a clean file, and importing it again changes nothing but updates', async () => {
    const w = await adsWorld();
    const csv = `${head}2026-03-01,facebook,acct1,Spring,USD,100.50,1000,40\n2026-03-02,facebook,acct1,Spring,USD,"1,200.00",2000,80\n2026-03-01,google,,Brand,EUR,50,,\n`;
    const r = await w.csv(csv);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ rows: 3, valid: 3, created: 3, updated: 0, skipped: 0, errors: [] });
    const again = await w.csv(csv);
    expect(again.json).toMatchObject({ created: 0, updated: 3 });
    const list = (await w.h.call('GET', '/api/ads/spend', { token: w.owner.token })).json.data;
    expect(list).toHaveLength(3);
    expect(list.find((x: any) => x.day === '2026-03-02').spend).toBe(1200);
  });

  it('accepts BOM, CRLF, quoted commas and newlines, header synonyms, case, defaults for source and currency', async () => {
    const w = await adsWorld();
    const csv = '﻿Date,Campaign name,Amount spent,Impr.,Clicks\r\n2026-03-01,"Spring, 2026 ""sale""",12.34,"1,500",7\r\n2026-03-01T10:00:00Z,"Line one\nline two",5,,\r\n';
    const r = await w.csv(csv, 'source=Facebook&currency=gbp');
    expect(r.json).toMatchObject({ valid: 2, created: 2, errors: [] });
    const list = (await w.h.call('GET', '/api/ads/spend', { token: w.owner.token })).json.data;
    expect(list.map((x: any) => x.campaign).sort()).toEqual(['Line one line two', 'Spring, 2026 "sale"']);
    expect(list[0]).toMatchObject({ source: 'facebook', currency: 'GBP' });
    expect(list.find((x: any) => x.campaign.startsWith('Spring')).impressions).toBe(1500);
  });

  it('refuses the whole file by default when a row is invalid, and tells every problem with its line', async () => {
    const w = await adsWorld();
    const csv = `${head}2026-03-01,fb,,Ok,USD,10,,\n2026-13-01,fb,,BadDate,USD,10,,\n2026-03-01,fb,,BadCur,XXQ,10,,\n2026-03-01,fb,,Neg,USD,-3,,\n2026-03-01,fb,,Euro,USD,"1.234,50",,\n2026-03-01,fb,,Imp,USD,3,abc,\n2026-03-01,fb,,,USD,3,,\n2026-03-01,fb,,Extra,USD,3,,,oops\n`;
    const r = await w.csv(csv);
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe('IMPORT_INVALID');
    const lines = r.json.error.details?.errors ?? r.json.error.errors;
    expect(lines.map((e: any) => `${e.line}:${e.field}`)).toEqual(['3:date', '4:currency', '5:spend', '6:spend', '7:impressions', '8:campaign', '9:*']);
    expect((await w.h.call('GET', '/api/ads/spend', { token: w.owner.token })).json.data).toEqual([]);
  });

  it('skipInvalid imports the valid rows; dryRun writes nothing', async () => {
    const w = await adsWorld();
    const csv = `${head}2026-03-01,fb,,Ok,USD,10,,\n2026-03-01,fb,,Bad,USD,xx,,\n`;
    const dry = await w.csv(csv, 'dryRun=true');
    expect(dry.status).toBe(200);
    expect(dry.json).toMatchObject({ dryRun: true, valid: 1, skipped: 1, created: 0 });
    expect((await w.h.call('GET', '/api/ads/spend', { token: w.owner.token })).json.data).toEqual([]);
    const real = await w.csv(csv, 'skipInvalid=true');
    expect(real.json).toMatchObject({ created: 1, skipped: 1 });
    expect((await w.h.call('GET', '/api/ads/spend', { token: w.owner.token })).json.data).toHaveLength(1);
  });

  it('duplicates inside a file are refused, or summed on request', async () => {
    const w = await adsWorld();
    const csv = `${head}2026-03-01,fb,,Same,USD,10,100,5\n2026-03-01,FB,,same,USD,15,50,2\n`;
    const r = await w.csv(csv);
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.json)).toContain('Duplicate of line 2');
    const sum = await w.csv(csv, 'duplicates=sum');
    expect(sum.json).toMatchObject({ valid: 1, created: 1 });
    const row = (await w.h.call('GET', '/api/ads/spend', { token: w.owner.token })).json.data[0];
    expect(row).toMatchObject({ spend: 25, impressions: 150, clicks: 7 });
  });

  it('rejects missing columns, wrong content type, broken quoting, too many rows and oversized files', async () => {
    const w = await adsWorld({ ADS_IMPORT_MAX_ROWS: '50' });
    expect((await w.csv('date,spend\n2026-03-01,1')).json.error.code).toBe('MISSING_COLUMNS');
    expect((await w.h.call('POST', '/api/ads/spend/import', { token: w.owner.token, raw: head, headers: { 'content-type': 'application/json' } })).status).toBe(400);
    expect((await w.csv(`${head}2026-03-01,fb,,"unterminated,USD,1,,`)).json.error.code).toBe('INVALID_CSV');
    const many = head + Array.from({ length: 60 }, (_, i) => `2026-03-01,fb,,C${i},USD,1,,`).join('\n');
    expect((await w.csv(many)).json.error.message).toContain('more than 50 rows');
    const huge = head + '2026-03-01,fb,,' + 'x'.repeat(2_100_000) + ',USD,1,,';
    expect((await w.csv(huge)).status).toBe(413);
    expect((await w.csv('')).status).toBe(400);
  });

  it('a 20,000 row file imports in one transaction within the limits', async () => {
    const w = await adsWorld();
    const rows = Array.from({ length: 20_000 }, (_, i) => `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')},fb,,C${i},USD,1.5,,`);
    const csv = head + rows.join('\n');
    expect(Buffer.byteLength(csv)).toBeLessThan(2_000_000);
    const r = await w.csv(csv);
    expect(r.json).toMatchObject({ created: 20_000, errors: [] });
  }, 120_000);

  it('formula-like text is stored as data and neutralised on every export', async () => {
    const w = await adsWorld();
    await w.csv(`${head}2026-03-01,fb,,"=HYPERLINK(""http://evil.example"",""x"")",USD,10,,\n`);
    const stored = (await w.h.call('GET', '/api/ads/spend', { token: w.owner.token })).json.data[0];
    expect(stored.campaign).toBe('=HYPERLINK("http://evil.example","x")');
    await w.order({ at: '2026-03-01T10:00:00Z', cents: 5000, last: { source: 'fb', campaign: '=HYPERLINK("http://evil.example","x")' } });
    const exp = await w.h.call('GET', '/api/ads/performance/export?from=2026-03-01&to=2026-03-01', { token: w.owner.token });
    expect(exp.headers.get('content-type')).toContain('text/csv');
    expect(exp.text).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
    expect(exp.text).not.toMatch(/(^|,)"?=HYPERLINK/m);
  });
});
