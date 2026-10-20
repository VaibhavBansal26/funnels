import { z } from 'zod';
import { COLOR_RE, parseVideoUrl, safeUrl } from '../../blocks/safe.js';
import { FormFieldSchema, SuccessSchema } from '../../blocks/schema.js';

/**
 * Typed props of the dynamic components (stored on the GrapesJS component as `fnForm`, `fnProduct`, ...).
 * They are validated on save and are the ONLY source for what the server renders for those components,
 * so editor HTML can never change a price, a form field list or a form action.
 */
const anchor = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/, 'Invalid anchor');
const linkUrl = z.string().max(2048).refine((u) => safeUrl(u) !== null, 'Invalid or unsafe URL');

export const ButtonActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('next_step') }),
  z.object({ type: z.literal('step'), stepId: z.string().min(1).max(64) }),
  z.object({ type: z.literal('link'), url: linkUrl, newTab: z.boolean().optional() }),
  z.object({ type: z.literal('anchor'), anchor }),
  z.object({ type: z.literal('popup'), popupId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/) }),
]);
export type ButtonActionProps = z.infer<typeof ButtonActionSchema>;

export const FormPropsSchema = z
  .object({
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
export type FormProps = z.infer<typeof FormPropsSchema>;

export const ProductPropsSchema = z.object({
  productName: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  price: z.number().min(0).max(1_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter ISO code').default('USD'),
  buttonLabel: z.string().min(1).max(80).default('Buy now'),
  orderBump: z.boolean().default(false),
  oneClickUpsell: z.boolean().default(false),
  success: SuccessSchema.default({ type: 'next_step' }),
});
export type ProductProps = z.infer<typeof ProductPropsSchema>;

export const VideoPropsSchema = z.object({
  url: z.string().max(2048).refine((u) => parseVideoUrl(u) !== null, 'Only YouTube, Vimeo and https .mp4 URLs are allowed'),
  title: z.string().max(200).default('Video'),
});
export type VideoProps = z.infer<typeof VideoPropsSchema>;

export const CountdownPropsSchema = z
  .object({
    mode: z.enum(['fixed', 'evergreen']),
    endsAt: z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date').optional(),
    minutes: z.number().int().min(1).max(60 * 24 * 30).optional(),
    label: z.string().max(200).optional(),
    expiredText: z.string().max(200).default('This offer has ended'),
  })
  .refine((c) => (c.mode === 'fixed' ? !!c.endsAt : !!c.minutes), 'Fixed countdowns need a date, evergreen ones need minutes');
export type CountdownProps = z.infer<typeof CountdownPropsSchema>;

export const ProgressPropsSchema = z.object({ value: z.number().min(0).max(100), label: z.string().max(120).optional() });
export type ProgressProps = z.infer<typeof ProgressPropsSchema>;

export const CodePropsSchema = z.object({ html: z.string().max(50_000).default(''), css: z.string().max(20_000).default(''), js: z.string().max(50_000).default('') });
export type CodeProps = z.infer<typeof CodePropsSchema>;

export const PopupPropsSchema = z.object({ closeOnOverlay: z.boolean().default(true) });

export const accentColor = z.string().max(40).regex(COLOR_RE, 'Invalid color');
