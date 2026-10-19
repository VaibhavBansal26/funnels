import { fileURLToPath } from 'node:url';
import { generateFunnel } from './ai/service.js';
import { hashPassword } from './auth/password.js';
import type { Auth } from './auth/context.js';
import { createDeps } from './bootstrap.js';
import { loadConfig } from './config.js';
import type { Deps } from './deps.js';
import { register } from './services/accounts.js';
import { createFunnel, getFunnelDetail, updateFunnel } from './services/funnels.js';
import { useTemplate } from './services/templates.js';
import { createTag } from './services/tags.js';
import { newId } from './util/ids.js';

export const DEMO_EMAIL = 'demo@example.test';
export const DEMO_PASSWORD = 'demo-password-123';
export const DEMO_HOSTNAME = 'demo.funnels.example';

/** Small deterministic PRNG so the demo data looks the same on every machine. */
function prng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Ada', 'Grace', 'Alan', 'Linus', 'Margaret', 'Dennis', 'Barbara', 'Ken', 'Radia', 'Tim', 'Hedy', 'Claude', 'Katherine', 'Donald', 'Frances', 'Guido'];
const LAST = ['Lovelace', 'Hopper', 'Turing', 'Torvalds', 'Hamilton', 'Ritchie', 'Liskov', 'Thompson', 'Perlman', 'Berners-Lee', 'Lamarr', 'Shannon', 'Johnson', 'Knuth', 'Allen', 'van Rossum'];

export interface SeedResult {
  created: boolean;
  email: string;
  password: string;
  workspaceId?: string;
}

/** Creates the demo workspace with realistic sample data. Idempotent: does nothing when the demo user already exists. Never auto-run in production. */
export async function seedDemo(deps: Deps): Promise<SeedResult> {
  if (deps.db.get('SELECT 1 FROM users WHERE email = ?', DEMO_EMAIL)) return { created: false, email: DEMO_EMAIL, password: DEMO_PASSWORD };
  const owner = await register(deps, { email: DEMO_EMAIL, password: DEMO_PASSWORD, name: 'Demo Owner', workspaceName: 'Demo Studio' });
  const ws = owner.workspace.id;
  const auth: Auth = { userId: owner.user.id, workspaceId: ws, role: 'owner', email: DEMO_EMAIL, name: 'Demo Owner' };
  const at = deps.now();
  const iso = (d: Date) => d.toISOString();

  for (const [email, name, role] of [['demo-admin@example.test', 'Demo Admin', 'admin'], ['demo-member@example.test', 'Demo Member', 'member']] as const) {
    deps.db.run('INSERT INTO users (id, workspace_id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', newId('usr'), ws, email, name, await hashPassword(DEMO_PASSWORD), role, iso(at));
  }

  const tags = ['Evergreen', 'Promo', 'Webinar'].map((name) => createTag(deps, ws, { name }));
  const domainId = newId('dom');
  deps.db.run(
    `INSERT INTO domains (id, workspace_id, hostname, status, verification_token, verified_at, last_checked_at, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
    domainId, ws, DEMO_HOSTNAME, newId('tok'), iso(at), iso(at), iso(at), iso(at),
  );

  const leadMagnet = useTemplate(deps, auth, 'lead-magnet');
  const sales = useTemplate(deps, auth, 'sales-page-bump-upsell');
  const webinar = useTemplate(deps, auth, 'webinar-registration');
  const generated = (await generateFunnel(deps, auth, { business: 'A neighbourhood bakery selling sourdough subscriptions', goal: 'booking', tone: 'friendly', audience: 'Local food lovers', steps: 2 })).funnel;
  createFunnel(deps, auth, { name: 'Work in progress' });

  updateFunnel(deps, auth, leadMagnet.id, { domain_id: domainId, status: 'live', tags: [tags[0]!.id] });
  updateFunnel(deps, auth, sales.id, { domain_id: domainId, status: 'live', tags: [tags[1]!.id], conflicts: [] });
  updateFunnel(deps, auth, webinar.id, { tags: [tags[2]!.id] });
  updateFunnel(deps, auth, generated.id, { tags: [tags[0]!.id] });

  seedTraffic(deps, ws, getFunnelDetail(deps, ws, leadMagnet.id), 'lead');
  seedTraffic(deps, ws, getFunnelDetail(deps, ws, sales.id), 'sales');
  seedTraffic(deps, ws, getFunnelDetail(deps, ws, webinar.id), 'lead', 0.4);

  const secret = `whsec_${newId('demo')}`;
  deps.db.run('INSERT INTO webhooks (id, workspace_id, url, secret, events_json, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)', newId('whk'), ws, 'https://example.com/hooks/funnels', secret, JSON.stringify(['funnel.optin', 'funnel.purchase']), iso(at));
  return { created: true, email: DEMO_EMAIL, password: DEMO_PASSWORD, workspaceId: ws };
}

/** 14 days of page views, opt-ins, leads and orders spread over the funnel's steps, with a funnel-shaped drop-off. */
function seedTraffic(deps: Deps, ws: string, funnel: ReturnType<typeof getFunnelDetail>, kind: 'lead' | 'sales' | 'lead', scale = 1): void {
  const rand = prng(funnel.name.length * 7919 + funnel.steps.length);
  const now = deps.now().getTime();
  const insertEvent = (stepId: string, type: string, visitor: string, unique: number, at: number, extra: { leadId?: string; orderId?: string; cents?: number; ext?: string } = {}) =>
    deps.db.run(
      `INSERT INTO events (id, workspace_id, funnel_id, step_id, type, visitor_id, unique_visit, lead_id, order_id, external_id, amount_cents, currency, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId('evt'), ws, funnel.id, stepId, type, visitor, unique, extra.leadId ?? null, extra.orderId ?? null, extra.ext ?? null, extra.cents ?? 0, extra.cents ? 'USD' : null, new Date(at).toISOString(),
    );
  deps.db.tx(() => {
    for (let day = 13; day >= 0; day--) {
      const visitors = Math.round((30 + rand() * 50) * scale * (1 + (13 - day) * 0.03));
      for (let i = 0; i < visitors; i++) {
        const visitor = `demo${day}x${i}x${funnel.id.slice(-4)}`;
        const t = now - day * 86_400_000 - Math.floor(rand() * 20 * 3_600_000);
        insertEvent(funnel.steps[0]!.id, 'page_view', visitor, 1, t);
        if (rand() < 0.1) insertEvent(funnel.steps[0]!.id, 'page_view', visitor, 0, t + 60_000);
        if (rand() > (kind === 'sales' ? 0.55 : 0.35)) continue;
        // opt-in (lead magnet) or add-to-cart style progression (sales)
        const next = funnel.steps[1];
        if (next) insertEvent(next.id, 'page_view', visitor, 1, t + 90_000);
        if (kind === 'lead' && rand() < 0.9) {
          const first = FIRST[Math.floor(rand() * FIRST.length)]!;
          const last = LAST[Math.floor(rand() * LAST.length)]!;
          const email = `${first}.${last}.${day}${i}@example.com`.toLowerCase().replace(/[^a-z0-9.@-]/g, '');
          const leadId = newId('lead');
          deps.db.run(
            'INSERT INTO leads (id, workspace_id, email, name, data_json, first_funnel_id, submissions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
            leadId, ws, email, `${first} ${last}`, JSON.stringify({ name: `${first} ${last}`, email }), funnel.id, new Date(t + 120_000).toISOString(), new Date(t + 120_000).toISOString(),
          );
          insertEvent(funnel.steps[0]!.id, 'optin', visitor, 0, t + 120_000, { leadId });
        }
        if (kind === 'sales' && rand() < 0.35) {
          const first = FIRST[Math.floor(rand() * FIRST.length)]!;
          const email = `buyer.${day}.${i}@example.com`;
          const leadId = newId('lead');
          const cents = rand() < 0.25 ? 11400 : 9700;
          const ts = new Date(t + 150_000).toISOString();
          deps.db.run('INSERT INTO leads (id, workspace_id, email, name, first_funnel_id, submissions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)', leadId, ws, email, first, funnel.id, ts, ts);
          const orderId = newId('ord');
          deps.db.run(
            `INSERT INTO orders (id, workspace_id, funnel_id, step_id, block_id, lead_id, email, name, product_name, amount_cents, currency, is_bump, is_upsell, provider, provider_ref, created_at) VALUES (?, ?, ?, ?, 'demo', ?, ?, ?, ?, ?, 'USD', ?, 0, 'mock', ?, ?)`,
            orderId, ws, funnel.id, funnel.steps[0]!.id, leadId, email, first, 'Email Marketing Masterclass', cents, cents === 11400 ? 1 : 0, `mock_ch_${orderId}`, ts,
          );
          insertEvent(funnel.steps[0]!.id, 'order', visitor, 0, t + 150_000, { orderId, leadId, cents });
        }
      }
    }
    for (const [type, title, body] of [['new_lead', 'New lead', 'ada.lovelace@example.com opted in'], ['new_sale', 'New sale', 'buyer@example.com bought Email Marketing Masterclass']] as const) {
      deps.db.run('INSERT INTO notifications (id, workspace_id, type, title, body, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', newId('ntf'), ws, type, title, body, JSON.stringify({ funnelId: funnel.id }), new Date(now - 3_600_000).toISOString());
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  if (config.NODE_ENV === 'production') {
    process.stderr.write('Refusing to seed demo data when NODE_ENV=production\n');
    process.exit(1);
  }
  const deps = createDeps(config);
  const r = await seedDemo(deps);
  process.stdout.write(r.created ? `Seeded demo workspace.\n  email:    ${r.email}\n  password: ${r.password}\n` : `Demo workspace already exists.\n  email:    ${r.email}\n  password: ${r.password}\n`);
  deps.db.close();
}
