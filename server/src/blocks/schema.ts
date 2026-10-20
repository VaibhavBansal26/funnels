import { z } from 'zod';
import { COLOR_RE, parseVideoUrl, safeImageSrc, safeUrl } from './safe.js';

/** Current document schema version. Bump and extend `migrateDocument` when the shape changes. */
export const DOC_VERSION = 1;

export const LIMITS = {
  maxBlocks: 400,
  maxDepth: 4,
  maxText: 10_000,
  maxHtml: 50_000,
  maxItems: 50,
  maxDocBytes: 1_500_000,
} as const;

const blockId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'Block ids may only contain letters, digits, - and _');
const color = z.string().max(40).regex(COLOR_RE, 'Invalid color');
const align = z.enum(['left', 'center', 'right']);
const anchor = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/, 'Invalid anchor');
const linkUrl = z.string().max(2048).refine((u) => safeUrl(u) !== null, 'Invalid or unsafe URL');
const httpUrl = z.string().max(2048).refine((u) => safeUrl(u, ['http', 'https']) !== null, 'Must be an http(s) or relative URL');
const currency = z.string().regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter ISO code');

export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('next_step') }),
  z.object({ type: z.literal('step'), stepId: z.string().min(1).max(64) }),
  z.object({ type: z.literal('link'), url: linkUrl, newTab: z.boolean().optional() }),
  z.object({ type: z.literal('anchor'), anchor }),
]);
export type ButtonAction = z.infer<typeof ActionSchema>;

export const SuccessSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('next_step') }),
  z.object({ type: z.literal('url'), url: httpUrl }),
  z.object({ type: z.literal('message'), message: z.string().max(500) }),
]);
export type SuccessAction = z.infer<typeof SuccessSchema>;

export const FormFieldSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'Field ids are lowercase letters, digits and _'),
  type: z.enum(['name', 'email', 'phone', 'text', 'textarea', 'select', 'checkbox']),
  label: z.string().min(1).max(120),
  required: z.boolean().default(false),
  placeholder: z.string().max(120).optional(),
  options: z.array(z.string().min(1).max(80)).max(30).optional(),
  maxLength: z.number().int().min(1).max(5000).optional(),
});
export type FormField = z.infer<typeof FormFieldSchema>;

const MAX_SRC = 400_100;
const text = z.string().max(LIMITS.maxText);

const Heading = z.object({
  id: blockId,
  type: z.literal('heading'),
  text: z.string().max(500),
  level: z.number().int().min(1).max(4).default(2),
  align: align.optional(),
  color: color.optional(),
  anchor: anchor.optional(),
});
const Paragraph = z.object({ id: blockId, type: z.literal('paragraph'), text, align: align.optional(), color: color.optional(), anchor: anchor.optional() });
const Image = z.object({
  id: blockId,
  type: z.literal('image'),
  src: z.string().max(MAX_SRC).refine((s) => safeImageSrc(s) !== null, 'Invalid image URL'),
  alt: z.string().max(300).default(''),
  width: z.number().int().min(16).max(2000).optional(),
  align: align.optional(),
  href: linkUrl.optional(),
});
const Button = z.object({
  id: blockId,
  type: z.literal('button'),
  text: z.string().min(1).max(120),
  action: ActionSchema,
  style: z.enum(['primary', 'secondary', 'outline']).default('primary'),
  size: z.enum(['sm', 'md', 'lg']).default('md'),
  align: align.optional(),
  fullWidth: z.boolean().optional(),
});
const Video = z.object({
  id: blockId,
  type: z.literal('video'),
  url: z.string().max(2048).refine((u) => parseVideoUrl(u) !== null, 'Only YouTube, Vimeo and https .mp4 URLs are allowed'),
  title: z.string().max(200).default('Video'),
});
const Divider = z.object({ id: blockId, type: z.literal('divider') });
const Spacer = z.object({ id: blockId, type: z.literal('spacer'), height: z.number().int().min(4).max(240).default(32) });
const List = z.object({
  id: blockId,
  type: z.literal('list'),
  items: z.array(z.string().max(500)).max(LIMITS.maxItems),
  ordered: z.boolean().optional(),
  icon: z.enum(['check', 'dot']).default('check'),
});
const Faq = z.object({
  id: blockId,
  type: z.literal('faq'),
  items: z.array(z.object({ q: z.string().max(300), a: z.string().max(2000) })).max(LIMITS.maxItems),
});
const Countdown = z
  .object({
    id: blockId,
    type: z.literal('countdown'),
    mode: z.enum(['fixed', 'evergreen']),
    endsAt: z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date').optional(),
    minutes: z.number().int().min(1).max(60 * 24 * 30).optional(),
    label: z.string().max(200).optional(),
    expiredText: z.string().max(200).default('This offer has ended'),
  })
  .refine((c) => (c.mode === 'fixed' ? !!c.endsAt : !!c.minutes), 'Fixed countdowns need endsAt, evergreen ones need minutes');
export const FormSchema = z
  .object({
    id: blockId,
    type: z.literal('form'),
    name: z.string().max(120).default('Form'),
    fields: z.array(FormFieldSchema).min(1).max(20),
    submitLabel: z.string().min(1).max(80).default('Submit'),
    consent: z.object({ enabled: z.boolean(), text: z.string().max(400).default('I agree to be contacted.') }).default({ enabled: false, text: 'I agree to be contacted.' }),
    success: SuccessSchema.default({ type: 'next_step' }),
  })
  .superRefine((f, ctx) => {
    const ids = new Set<string>();
    for (const field of f.fields) {
      if (ids.has(field.id)) ctx.addIssue({ code: 'custom', message: `Duplicate field id "${field.id}"` });
      ids.add(field.id);
      if (field.type === 'select' && !field.options?.length) ctx.addIssue({ code: 'custom', message: `Select field "${field.id}" needs options` });
    }
    if (!f.fields.some((x) => x.type === 'email')) ctx.addIssue({ code: 'custom', message: 'A form needs an email field' });
  });
/** Catalog link and offer options of a checkout component (docs/PRODUCTS.md). Shared by the legacy block schema and the page model props. */
export const CheckoutCatalogFields = {
  /** The server resolves the amount from the catalog price; `price`/`currency`/`productName` on the block are a display snapshot it refreshes on every save. */
  productId: z.string().regex(/^prd_[A-Za-z0-9_-]{6,60}$/).optional(),
  priceId: z.string().regex(/^prc_[A-Za-z0-9_-]{6,60}$/).optional(),
  /** Template placeholder key ("main", "bump", ...), bound to a catalog product when the template is used. */
  slot: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional(),
  /** A one-click offer shown after the buyer declined an upsell (behaves like an upsell; analytics tell them apart). */
  downsell: z.boolean().optional(),
  /** Quantity picker on the offer. `max` bounds what the server accepts. */
  quantity: z.object({ enabled: z.boolean(), min: z.number().int().min(1).max(99).default(1), max: z.number().int().min(1).max(99).default(10), default: z.number().int().min(1).max(99).default(1) }).optional(),
  /** Show Stripe's promotion code field on the hosted checkout. */
  allowPromotionCodes: z.boolean().optional(),
  /** Display snapshot of the catalog price's billing (refreshed on save): the offer shows "$29.00 / month" and the trial. */
  interval: z.enum(['day', 'week', 'month', 'year']).optional(),
  trialDays: z.number().int().min(0).max(730).optional(),
};
export const CheckoutSchema = z.object({
  id: blockId,
  type: z.literal('checkout'),
  productName: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  price: z.number().min(0).max(1_000_000),
  currency: currency.default('USD'),
  buttonLabel: z.string().min(1).max(80).default('Buy now'),
  orderBump: z.boolean().default(false),
  oneClickUpsell: z.boolean().default(false),
  success: SuccessSchema.default({ type: 'next_step' }),
  ...CheckoutCatalogFields,
});
const Html = z.object({ id: blockId, type: z.literal('html'), html: z.string().max(LIMITS.maxHtml) });

const SectionBase = z.object({
  id: blockId,
  type: z.literal('section'),
  background: color.optional(),
  padding: z.enum(['none', 'sm', 'md', 'lg', 'xl']).default('md'),
  width: z.enum(['narrow', 'medium', 'wide', 'full']).default('medium'),
  align: z.enum(['left', 'center']).default('left'),
  anchor: anchor.optional(),
});
const ColumnsBase = z.object({
  id: blockId,
  type: z.literal('columns'),
  gap: z.enum(['sm', 'md', 'lg']).default('md'),
});

export type LeafBlock =
  | z.infer<typeof Heading>
  | z.infer<typeof Paragraph>
  | z.infer<typeof Image>
  | z.infer<typeof Button>
  | z.infer<typeof Video>
  | z.infer<typeof Divider>
  | z.infer<typeof Spacer>
  | z.infer<typeof List>
  | z.infer<typeof Faq>
  | z.infer<typeof Countdown>
  | z.infer<typeof FormSchema>
  | z.infer<typeof CheckoutSchema>
  | z.infer<typeof Html>;
export type SectionBlock = z.infer<typeof SectionBase> & { children: Block[] };
export type Column = { id: string; width?: number; children: Block[] };
export type ColumnsBlock = z.infer<typeof ColumnsBase> & { columns: Column[] };
export type Block = LeafBlock | SectionBlock | ColumnsBlock;
export type BlockType = Block['type'];

export const BLOCK_TYPES: BlockType[] = [
  'section', 'columns', 'heading', 'paragraph', 'image', 'button', 'video', 'divider', 'spacer', 'list', 'faq', 'countdown', 'form', 'checkout', 'html',
];

export type FormBlock = z.infer<typeof FormSchema>;
export type CheckoutBlock = z.infer<typeof CheckoutSchema>;

const lazyBlock: z.ZodType<Block> = z.lazy(() => BlockSchema);

const SectionSchema: z.ZodType<SectionBlock> = SectionBase.extend({ children: z.array(lazyBlock).max(LIMITS.maxBlocks) });
const ColumnsSchema: z.ZodType<ColumnsBlock> = ColumnsBase.extend({
  columns: z
    .array(z.object({ id: blockId, width: z.number().int().min(1).max(12).optional(), children: z.array(lazyBlock).max(LIMITS.maxBlocks) }))
    .min(1)
    .max(5),
});

export const BlockSchema: z.ZodType<Block> = z.union([
  Heading, Paragraph, Image, Button, Video, Divider, Spacer, List, Faq, Countdown, FormSchema, CheckoutSchema, Html, SectionSchema, ColumnsSchema,
]);

export interface PageDocument {
  version: number;
  settings: { background?: string; accent?: string; font: 'system' | 'serif' | 'mono' };
  blocks: Block[];
}

const SettingsSchema = z.object({
  background: color.optional(),
  accent: color.optional(),
  font: z.enum(['system', 'serif', 'mono']).default('system'),
});

export function children(b: Block): Block[][] {
  if (b.type === 'section') return [b.children];
  if (b.type === 'columns') return b.columns.map((c) => c.children);
  return [];
}

/** Total block count, deepest nesting level (top level = 1) and whether ids are unique. */
export function measure(blocks: Block[]): { count: number; depth: number; duplicateId: string | null } {
  let count = 0;
  let depth = 0;
  let duplicateId: string | null = null;
  const seen = new Set<string>();
  const walk = (list: Block[], d: number) => {
    depth = Math.max(depth, d);
    for (const b of list) {
      count++;
      if (seen.has(b.id) && !duplicateId) duplicateId = b.id;
      seen.add(b.id);
      for (const group of children(b)) walk(group, d + 1);
    }
  };
  walk(blocks, 1);
  return { count, depth, duplicateId };
}

export const PageDocumentSchema: z.ZodType<PageDocument> = z
  .object({
    version: z.literal(DOC_VERSION),
    settings: SettingsSchema.default({ font: 'system' }),
    blocks: z.array(BlockSchema).max(LIMITS.maxBlocks),
  })
  .superRefine((doc, ctx) => {
    const m = measure(doc.blocks);
    if (m.count > LIMITS.maxBlocks) ctx.addIssue({ code: 'custom', message: `Documents may contain at most ${LIMITS.maxBlocks} blocks` });
    if (m.depth > LIMITS.maxDepth) ctx.addIssue({ code: 'custom', message: `Blocks may be nested at most ${LIMITS.maxDepth} levels deep` });
    if (m.duplicateId) ctx.addIssue({ code: 'custom', message: `Duplicate block id "${m.duplicateId}"` });
  });

/** Upgrades older stored documents to the current version. Unknown future versions are rejected. */
export function migrateDocument(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Document must be an object');
  const doc = input as Record<string, unknown>;
  const v = doc.version ?? 0;
  if (typeof v !== 'number' || v > DOC_VERSION) throw new Error(`Unsupported document version ${String(v)}`);
  if (v === 0) return { version: DOC_VERSION, settings: { font: 'system' }, blocks: doc.blocks ?? [] };
  return doc;
}

/** Iterative nesting check so hostile documents are rejected before the recursive zod walk runs. */
function nestingTooDeep(input: unknown): boolean {
  const stack: [unknown, number][] = [[input, 0]];
  let visited = 0;
  while (stack.length) {
    const [node, d] = stack.pop()!;
    if (d > LIMITS.maxDepth * 2 + 2 || ++visited > LIMITS.maxBlocks * 4) return true;
    if (typeof node !== 'object' || node === null) continue;
    const o = node as Record<string, unknown>;
    for (const key of ['blocks', 'children', 'columns']) {
      const list = o[key];
      if (Array.isArray(list)) for (const item of list) stack.push([item, d + 1]);
    }
  }
  return false;
}

export function parseDocument(input: unknown): { ok: true; doc: PageDocument } | { ok: false; issues: { path: string; message: string }[] } {
  let migrated: unknown;
  try {
    migrated = migrateDocument(input);
  } catch (e) {
    return { ok: false, issues: [{ path: 'version', message: (e as Error).message }] };
  }
  if (nestingTooDeep(migrated)) return { ok: false, issues: [{ path: 'blocks', message: 'Document is too large or too deeply nested' }] };
  const r = PageDocumentSchema.safeParse(migrated);
  if (r.success) return { ok: true, doc: r.data };
  return { ok: false, issues: r.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })) };
}

export function findBlock(blocks: Block[], id: string): Block | null {
  for (const b of blocks) {
    if (b.id === id) return b;
    for (const group of children(b)) {
      const hit = findBlock(group, id);
      if (hit) return hit;
    }
  }
  return null;
}

export function collectBlocks(blocks: Block[], out: Block[] = []): Block[] {
  for (const b of blocks) {
    out.push(b);
    for (const group of children(b)) collectBlocks(group, out);
  }
  return out;
}

export function firstHeading(doc: Pick<PageDocument, 'blocks'>): string | null {
  const h = collectBlocks(doc.blocks).find((b) => b.type === 'heading') as { text?: string } | undefined;
  return h?.text?.trim() || null;
}
