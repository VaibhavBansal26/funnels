import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { idProblem, money, ratio } from '../../api/growth';
import { accountProblem, tokenProblem } from './ConnectionCard';
import { bodyOf, draftOf, problems } from './PixelForm';
import { kb, validProjectName } from './PublishingCard';
import { checkCsvFile, ImportErrors, SAMPLE_CSV } from './SpendView';

describe('pixel ids', () => {
  it('accepts the documented shapes and says what is wrong otherwise', () => {
    expect(idProblem('metaPixel', '123456789012345')).toBeUndefined();
    expect(idProblem('metaPixel', '')).toBeUndefined();
    expect(idProblem('metaPixel', "1');alert(1)")).toContain('Meta Pixel ID');
    expect(idProblem('ga4', 'g-abc')).toContain('GA4');
    expect(idProblem('tiktok', 'CABCDEF1234567890ABC')).toBeUndefined();
    expect(idProblem('uet', '12')).toContain('UET');
  });
  it('the form reports every bad field and a label without its conversion id', () => {
    const d = draftOf(null);
    d.meta = 'nope';
    d.gaAdsPurchase = 'PurchaseLabel1';
    const p = problems(d);
    expect(p.meta).toBeTruthy();
    expect(p.gaAds).toContain('conversion ID');
    d.consent.policyUrl = 'javascript:alert(1)';
    expect(problems(d).consent).toBeTruthy();
  });
  it('builds the PUT body from filled fields only, null for switched-off inherited networks', () => {
    const d = draftOf(null);
    d.meta = ' 123456789012345 ';
    d.lead = true;
    expect(bodyOf(d)).toEqual({ meta: { pixelId: '123456789012345' }, events: { lead: true } });
    d.off = ['tiktok'];
    expect(bodyOf(d).tiktok).toBeNull();
    expect(bodyOf(draftOf(null))).toEqual({});
  });
  it('round-trips stored settings', () => {
    const stored = { ga4: { measurementId: 'G-ABC123XYZ9' }, googleAds: { conversionId: 'AW-123456789', purchaseLabel: 'Lbl12345', leadLabel: null }, consent: { enabled: true, mode: 'opt_in' as const } };
    const body = bodyOf(draftOf(stored));
    expect(body.ga4).toEqual(stored.ga4);
    expect(body.googleAds).toEqual({ conversionId: 'AW-123456789', purchaseLabel: 'Lbl12345', leadLabel: null });
    expect(body.consent?.enabled).toBe(true);
  });
});

describe('publishing inputs', () => {
  it('validates the account id, token and project name', () => {
    expect(accountProblem('0123456789abcdef0123456789abcdef')).toBeUndefined();
    expect(accountProblem('short')).toBeTruthy();
    expect(tokenProblem('x'.repeat(30))).toBeUndefined();
    expect(tokenProblem('short')).toBeTruthy();
    expect(tokenProblem('has a space in it, long enough')).toBeTruthy();
    expect(validProjectName('my-offer')).toBeUndefined();
    for (const bad of ['-a', 'a-', 'UPPER', 'under_score', 'a', 'x'.repeat(60)]) expect(validProjectName(bad), bad).toBeTruthy();
    expect(kb(2048)).toBe('2 KB');
    expect(kb(5 * 1_048_576)).toBe('5.0 MB');
  });
});

describe('spend import', () => {
  it('rejects empty, huge and wrong-type files before uploading', () => {
    expect(checkCsvFile({ name: 'a.csv', size: 0 })).toContain('empty');
    expect(checkCsvFile({ name: 'a.csv', size: 3_000_000 })).toContain('2 MB');
    expect(checkCsvFile({ name: 'a.exe', size: 10 })).toContain('.csv');
    expect(checkCsvFile({ name: 'ok.CSV', size: 1000 })).toBeNull();
    expect(SAMPLE_CSV.split('\n')[0]).toContain('campaign');
  });
  it('lists problems with line and column, as text', () => {
    const { container } = render(<ImportErrors r={{ dryRun: true, rows: 3, valid: 1, created: 0, updated: 0, skipped: 2, errors: [{ line: 3, field: 'spend', message: '"<b>x</b>" is not an amount' }, { line: 4, field: 'date', message: 'bad date' }], moreErrors: true }} />);
    expect(container.textContent).toContain('1 of 3 rows are valid');
    expect(screen.getByText('"<b>x</b>" is not an amount')).toBeTruthy(); // rendered as text, not markup
    expect(screen.getByText('spend')).toBeTruthy();
    expect(screen.getByText(/More problems exist/)).toBeTruthy();
    expect(screen.getByText(/Nothing has been saved yet/)).toBeTruthy();
  });
});

describe('formatting', () => {
  it('shows missing ratios as a dash and money in its own currency', () => {
    expect(money(null, 'USD')).toBe('—');
    expect(ratio(null)).toBe('—');
    expect(ratio(2.5)).toBe('2.50');
    expect(money(1234.5, 'USD')).toContain('1,234.50');
    expect(money(1500, 'JPY')).toContain('1,500');
    expect(money(1, 'XXX1')).toContain('XXX1');
  });
});
