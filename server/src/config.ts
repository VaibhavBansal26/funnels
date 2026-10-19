import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(3000, 1, 65535),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_PATH: z.string().default('./data/funnels.db'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters').optional(),
  ACCESS_TOKEN_TTL_SECONDS: int(60 * 60 * 12, 60),
  PREVIEW_TOKEN_TTL_SECONDS: int(15 * 60, 30),
  APP_PUBLIC_URL: z.string().default('http://localhost:3000'),
  APP_PUBLIC_CNAME_TARGET: z.string().default('sites.funnels.example'),
  CORS_ORIGINS: csv,
  PLATFORM_ADMIN_EMAILS: csv,
  TRUST_PROXY: bool(false),
  WEB_DIST: z.string().default(fileURLToPath(new URL('../../web/dist', import.meta.url))),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),
  AI_DAILY_CAP: int(50, 0),
  AI_RATE_LIMIT_PER_MINUTE: int(10, 1),
  PUBLIC_EVENTS_PER_MINUTE: int(120, 1),
  PUBLIC_FORMS_PER_MINUTE: int(20, 1),
  AUTH_ATTEMPTS_PER_MINUTE: int(10, 1),
  WEBHOOK_MAX_ATTEMPTS: int(6, 1, 20),
  DOMAIN_VERIFY_TIMEOUT_HOURS: int(72, 1),
  EVENT_BUFFER_MS: int(250, 0),
  EVENT_BUFFER_MAX: int(5000, 1),
  REQUEST_TIMEOUT_MS: int(30_000, 100),
  EDGE_SHARED_SECRET: z.string().min(32, 'EDGE_SHARED_SECRET must be at least 32 characters').optional(),
  EDGE_SKEW_SECONDS: int(120, 5),
  CF_ORIGIN_SECRET: z.string().min(16).optional(),
  CF_API_TOKEN: z.string().optional(),
  CF_ZONE_ID: z.string().optional(),
  CF_API_BASE: z.string().default('https://api.cloudflare.com/client/v4'),
  DOMAIN_PROVIDER: z.enum(['manual', 'cloudflare']).default('manual'),
  METRICS_TOKEN: z.string().optional(),
  ENABLE_WORKER: bool(true),
  JOB_POLL_MS: int(1000, 50),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
});

export type Config = Omit<z.infer<typeof EnvSchema>, 'JWT_SECRET'> & { JWT_SECRET: string; JWT_SECRET_GENERATED: boolean };

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  const { JWT_SECRET, ...rest } = parsed.data;
  if (!JWT_SECRET && rest.NODE_ENV === 'production') {
    throw new Error('Invalid environment: JWT_SECRET is required in production');
  }
  return {
    ...rest,
    JWT_SECRET: JWT_SECRET ?? randomBytes(48).toString('base64url'),
    JWT_SECRET_GENERATED: !JWT_SECRET,
  };
}
