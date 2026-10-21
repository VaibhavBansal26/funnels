import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Product } from '../api/types';
import { amountHint, exponentOf, parseAmount } from './money';
import { refToBody, refValid } from './PaymentsWizard';
import { Sparkline } from './Sparkline';
import { priceOptions } from './UseTemplateWizard';

const product = (over: Partial<Product>, prices: Product['prices']): Product => ({ id: 'prd_1', name: 'Course', description: '', images: [], status: 'active', type: 'one_time', taxCode: null, metadata: {}, defaultPriceId: null, prices, stripe: { productId: null, syncState: 'not_connected', error: null, syncedAt: null }, orderCount: 0, createdAt: '', updatedAt: '', archivedAt: null, ...over });
const price = (id: string, over: Partial<Product['prices'][number]> = {}): Product['prices'][number] => ({ id, productId: 'prd_1', currency: 'USD', unitAmount: 1000, exponent: 2, amount: 10, formatted: '$10.00', interval: null, intervalCount: 1, trialDays: 0, nickname: null, active: true, replacedBy: null, stripe: { priceId: null, status: 'local' }, createdAt: '', archivedAt: null, ...over });

describe('price input', () => {
  it('parses what people type with the decimals of the currency', () => {
    expect([exponentOf('USD'), exponentOf('JPY'), exponentOf('KWD')]).toEqual([2, 0, 3]);
    expect(parseAmount('12.5', 'USD')).toBe(12.5);
    expect(parseAmount('1,299.00', 'USD')).toBe(1299);
    expect(parseAmount('12.345', 'USD')).toBeNull(); // too many decimals for the currency
    expect(parseAmount('500', 'JPY')).toBe(500);
    expect(parseAmount('500.5', 'JPY')).toBeNull();
    expect(parseAmount('1.505', 'KWD')).toBe(1.505);
    expect(parseAmount('-1', 'USD')).toBeNull();
    expect(parseAmount('abc', 'USD')).toBeNull();
    expect(parseAmount('', 'USD')).toBeNull();
    expect(parseAmount('2000000', 'USD')).toBeNull();
    expect(amountHint('JPY')).toMatch(/no decimals/);
  });
});

describe('template product binding options', () => {
  it('lists active prices of active products and hides subscriptions for one-click offers', () => {
    const list = [
      product({}, [price('prc_a'), price('prc_b', { active: false }), price('prc_c', { interval: 'month', formatted: '$5.00' })]),
      product({ id: 'prd_2', name: 'Gone', status: 'archived' }, [price('prc_d')]),
    ];
    const slot = (role: 'main' | 'upsell') => ({ key: 'k', role, name: 'N', description: '', type: 'one_time' as const, amount: 1, currency: 'USD' });
    expect(priceOptions(list, slot('main')).map((o) => o.value)).toEqual(['prc_a', 'prc_c']);
    expect(priceOptions(list, slot('upsell')).map((o) => o.value)).toEqual(['prc_a']);
    expect(priceOptions(list, slot('main'))[1]!.label).toContain('/ month');
  });
});

describe('payments wizard references', () => {
  it('validates and serialises existing and new products', () => {
    expect(refValid({ mode: 'existing', priceId: '' })).toBe(false);
    expect(refToBody({ mode: 'existing', priceId: 'prc_1' })).toEqual({ priceId: 'prc_1' });
    const fresh = { mode: 'new' as const, name: ' Poster ', amount: '25', currency: 'USD', type: 'one_time' as const, interval: 'month' };
    expect(refValid(fresh)).toBe(true);
    expect(refToBody(fresh)).toEqual({ create: { name: 'Poster', amount: 25, currency: 'USD', type: 'one_time' } });
    expect(refToBody({ ...fresh, type: 'subscription' })).toEqual({ create: { name: 'Poster', amount: 25, currency: 'USD', type: 'subscription', interval: 'month' } });
    expect(refValid({ ...fresh, amount: '0' })).toBe(false);
    expect(refValid({ ...fresh, name: ' ' })).toBe(false);
    expect(refValid(null)).toBe(false);
  });
});

describe('Sparkline', () => {
  it('is an image with a text alternative that says what it shows, also for flat data', () => {
    render(<><Sparkline values={[0, 5, 10]} label="Net revenue of Course" /><Sparkline values={[0, 0, 0]} label="Net revenue of Empty" /></>);
    expect(screen.getByRole('img', { name: /Net revenue of Course: 3 points, total 15, peak 10/ })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Net revenue of Empty: 3 points, total 0/ })).toBeInTheDocument();
  });
});
