// An in-process fake of the Stripe API pieces Funnels uses, plus the two pages a buyer or account owner would see on stripe.com (onboarding, hosted checkout), so the
// e2e suite can walk the connect flow and a test-mode purchase in a real browser. Started by server.mjs when E2E_FAKE_STRIPE_PORT is set; the app reaches it through
// STRIPE_API_BASE. It is NOT Stripe: it follows the documented request and response shapes (the same ones server/test/support/fakestripe.ts models).
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';

export function startFakeStripe({ port, appBase, connectSecret }) {
  let n = 0;
  const id = (p) => `${p}_${String(++n).padStart(6, '0')}`;
  const accounts = new Map();
  const products = new Map();
  const prices = new Map();
  const sessions = new Map();
  const intents = new Map();
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const html = (res, body, status = 200) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><meta charset="utf-8"><title>Fake Stripe</title><body style="font-family:system-ui;max-width:32rem;margin:3rem auto">${body}</body>`); };
  const form = (text) => Object.fromEntries(new URLSearchParams(text));
  const send = async (type, object, account) => {
    const body = JSON.stringify({ id: id('evt'), type, account, data: { object } });
    const t = Math.floor(Date.now() / 1000);
    const sig = `t=${t},v1=${createHmac('sha256', connectSecret).update(`${t}.${body}`).digest('hex')}`;
    await fetch(`${appBase}/api/stripe/connect-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body });
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const p = form(Buffer.concat(chunks).toString());
    const account = req.headers['stripe-account'];
    let m;
    try {
      if (req.method === 'POST' && url.pathname === '/v1/accounts') {
        const a = { id: id('acct_e2e'), country: 'US', default_currency: 'usd', capabilities: {}, charges_enabled: false, payouts_enabled: false, details_submitted: false, requirements: { currently_due: ['external_account'] }, settings: { payments: { statement_descriptor: 'E2E STORE' }, dashboard: { display_name: 'E2E Store' } } };
        accounts.set(a.id, a);
        return json(res, 200, a);
      }
      if (req.method === 'GET' && (m = url.pathname.match(/^\/v1\/accounts\/(\w+)$/))) return accounts.has(m[1]) ? json(res, 200, accounts.get(m[1])) : json(res, 404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such account' } });
      if (req.method === 'POST' && url.pathname === '/v1/account_links') return json(res, 200, { url: `http://127.0.0.1:${port}/onboard/${p.account}?return=${encodeURIComponent(p.return_url)}` });
      if (req.method === 'GET' && url.pathname === '/v1/tax/settings') return json(res, 200, { status: 'pending' });
      if (req.method === 'POST' && url.pathname === '/v1/products') { const o = { id: id('prod'), name: p.name, active: true, account }; products.set(o.id, o); return json(res, 200, o); }
      if ((m = url.pathname.match(/^\/v1\/products\/(\w+)$/))) { const o = products.get(m[1]); if (!o) return json(res, 404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such product' } }); if (p.name) o.name = p.name; if (p.active) o.active = p.active === 'true'; return json(res, 200, o); }
      if (req.method === 'POST' && url.pathname === '/v1/prices') { const o = { id: id('price'), product: p.product, currency: p.currency, unit_amount: Number(p.unit_amount), active: true, account }; prices.set(o.id, o); return json(res, 200, o); }
      if (req.method === 'POST' && (m = url.pathname.match(/^\/v1\/prices\/(\w+)$/))) { const o = prices.get(m[1]); if (o && p.active) o.active = p.active === 'true'; return json(res, 200, o ?? {}); }
      if (req.method === 'POST' && url.pathname === '/v1/checkout/sessions') {
        let total = 0;
        for (let i = 0; p[`line_items[${i}][quantity]`] !== undefined; i++) total += Number(p[`line_items[${i}][quantity]`]) * (prices.get(p[`line_items[${i}][price]`])?.unit_amount ?? Number(p[`line_items[${i}][price_data][unit_amount]`] ?? 0));
        const s = { id: id('cs_test'), url: `http://127.0.0.1:${port}/pay/${n + 1}`, mode: p.mode, status: 'open', payment_status: 'unpaid', amount_total: total, amount_subtotal: total, total_details: { amount_discount: 0, amount_tax: 0 }, currency: p['line_items[0][price_data][currency]'] ?? 'usd', customer: null, payment_intent: null, params: p, account };
        s.url = `http://127.0.0.1:${port}/pay/${s.id}`;
        sessions.set(s.id, s);
        return json(res, 200, s);
      }
      if (req.method === 'GET' && (m = url.pathname.match(/^\/v1\/checkout\/sessions\/(\w+)$/))) {
        const s = sessions.get(m[1]);
        if (!s) return json(res, 404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such session' } });
        return json(res, 200, { ...s, payment_intent: s.payment_intent && url.search.includes('payment_intent') ? intents.get(s.payment_intent) : s.payment_intent });
      }
      if (req.method === 'GET' && (m = url.pathname.match(/^\/onboard\/(\w+)$/))) return html(res, `<h1>Stripe onboarding (fake)</h1><p>Account ${m[1]}</p><form method="post"><input type="hidden" name="return" value="${url.searchParams.get('return') ?? ''}"><button type="submit">Finish onboarding</button></form>`);
      if (req.method === 'POST' && (m = url.pathname.match(/^\/onboard\/(\w+)$/))) {
        Object.assign(accounts.get(m[1]), { charges_enabled: true, payouts_enabled: true, details_submitted: true, requirements: { currently_due: [] }, capabilities: { card_payments: 'active', link_payments: 'active' } });
        res.writeHead(303, { location: p.return }); return res.end();
      }
      if (req.method === 'GET' && (m = url.pathname.match(/^\/pay\/(\w+)$/))) {
        const s = sessions.get(m[1]);
        return html(res, `<h1>Pay ${(s.amount_total / 100).toFixed(2)} ${s.currency.toUpperCase()} (fake Stripe Checkout)</h1><p>Test mode</p><form method="post"><button name="card" value="4242424242424242">Pay with 4242 4242 4242 4242</button> <button name="card" value="4000000000000002">Pay with 4000 0000 0000 0002 (declined)</button></form>`);
      }
      if (req.method === 'POST' && (m = url.pathname.match(/^\/pay\/(\w+)$/))) {
        const s = sessions.get(m[1]);
        // A real Stripe page sends the browser back with a redirect; this one answers with a page that does it, so the browser makes a fresh navigation that a test can intercept
        // (the e2e domains are only served over plain http on the app port, while the app builds https addresses).
        const back = (u) => html(res, `<meta http-equiv="refresh" content="0;url=${u}"><p>Returning to the merchant… <a href="${u}">Continue</a></p>`);
        const plain = (u) => u.replace(/^https:\/\/([^/]+\.e2e\.test)/, `http://$1:${new URL(appBase).port}`);
        if (p.card !== '4242424242424242') return back(plain(s.params.cancel_url));
        const pi = id('pi');
        intents.set(pi, { id: pi, payment_method: id('pm'), status: 'succeeded' });
        Object.assign(s, { status: 'complete', payment_status: 'paid', payment_intent: pi, customer: id('cus') });
        await send('checkout.session.completed', { id: s.id }, s.account);
        return back(s.params.success_url.replace('{CHECKOUT_SESSION_ID}', s.id));
      }
      json(res, 404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: `Unknown ${req.method} ${url.pathname}` } });
    } catch (e) {
      json(res, 500, { error: { type: 'api_error', message: String(e) } });
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
