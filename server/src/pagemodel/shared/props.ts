import { z } from 'zod';
import { COLOR_RE, parseVideoUrl, safeUrl } from '../../blocks/safe.js';
import { CheckoutCatalogFields, FormFieldSchema, SuccessSchema } from '../../blocks/schema.js';

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
  ...CheckoutCatalogFields,
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

/** A Google place id (Places API (New) ids look like "ChIJ..." and are URL-safe; the empty string means "the workspace's default place"). */
export const placeId = z.string().max(200).regex(/^[A-Za-z0-9_-]{10,200}$|^$/, 'Invalid place id');

/**
 * "Google reviews" block. Review content is never stored here: the server fetches it (Places API (New)) and shows it with the attribution Google requires. `fallback`
 * are testimonials the author typed, shown when there is no key, no place or no result; they are labelled as the author's own, never as Google's.
 */
export const ReviewsPropsSchema = z.object({
  placeId: placeId.default(''),
  placeName: z.string().max(120).default(''),
  variant: z.enum(['list', 'carousel', 'badge']).default('list'),
  count: z.number().int().min(1).max(5).default(3),
  minRating: z.number().int().min(1).max(5).default(4),
  showText: z.boolean().default(true),
  layout: z.enum(['grid', 'stack']).default('grid'),
  fallback: z.array(z.object({ name: z.string().trim().min(1).max(80), text: z.string().trim().min(1).max(400), rating: z.number().int().min(1).max(5).optional() })).max(6).default([]),
});
export type ReviewsProps = z.infer<typeof ReviewsPropsSchema>;

/** Delays the review prompt can wait before it appears (a CSS animation, so it works without scripts). */
export const REVIEW_DELAYS = [0, 5, 10, 15, 30, 60, 90, 120];

/** "Ask for a Google review" button: links to the review form of the place, optionally revealed after a delay. */
export const ReviewCtaPropsSchema = z.object({
  placeId: placeId.default(''),
  label: z.string().trim().min(1).max(60).default('Leave us a Google review'),
  prompt: z.string().max(200).default(''),
  delaySeconds: z.number().int().refine((n) => REVIEW_DELAYS.includes(n), 'Choose 0, 5, 10, 15, 30, 60, 90 or 120 seconds').default(0),
});
export type ReviewCtaProps = z.infer<typeof ReviewCtaPropsSchema>;

// ---- cart and payment form (docs/PRODUCTS.md#cart, docs/STRIPE.md#embedded-payment-form) ----------------------------------------------------------

const stepRef = z.string().min(1).max(64);
/** Catalog link of a commerce block: the same fields as a checkout block, so the save-time catalog link and template slots treat them alike. */
const catalogLink = {
  productName: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  /** Display snapshot only: the server prices from the catalog price (`priceId`), refreshed on every save. */
  price: z.number().min(0).max(1_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter ISO code').default('USD'),
  productId: CheckoutCatalogFields.productId,
  priceId: CheckoutCatalogFields.priceId,
  slot: CheckoutCatalogFields.slot,
  interval: CheckoutCatalogFields.interval,
  trialDays: CheckoutCatalogFields.trialDays,
};
const QuantitySchema = z.object({ enabled: z.boolean(), min: z.number().int().min(1).max(99).default(1), max: z.number().int().min(1).max(99).default(10), default: z.number().int().min(1).max(99).default(1) });

/** "Add to cart" button: a catalog price, an optional quantity picker, and where to go after adding (stay on the page by default). */
export const CartAddPropsSchema = z.object({
  ...catalogLink,
  label: z.string().min(1).max(80).default('Add to cart'),
  showPrice: z.boolean().default(true),
  quantity: QuantitySchema.default({ enabled: false, min: 1, max: 10, default: 1 }),
  then: z.discriminatedUnion('type', [z.object({ type: z.literal('stay') }), z.object({ type: z.literal('next_step') }), z.object({ type: z.literal('step'), stepId: stepRef })]).default({ type: 'stay' }),
});
export type CartAddProps = z.infer<typeof CartAddPropsSchema>;

/** Most cards one Product catalog block shows (and most products it can hand-pick). */
export const CATALOG_MAX_ITEMS = 24;

/** A hand-picked product of a Product catalog block: a catalog product (optionally one of its prices), or a template slot bound when the template is used. */
export const CatalogPickSchema = z
  .object({
    productId: CheckoutCatalogFields.productId,
    /** A chosen price of the product (default: its default price). A replaced price is followed to its successor. */
    priceId: CheckoutCatalogFields.priceId,
    slot: CheckoutCatalogFields.slot,
  })
  .refine((p) => !!p.productId || !!p.slot, 'A picked product needs a product (or a template slot)');
export type CatalogPick = z.infer<typeof CatalogPickSchema>;

/**
 * "Product catalog": a grid of product cards filled from the owner's catalog when the page is rendered (docs/PRODUCTS.md#product-catalog-block). Only active
 * one-time products with an active price are listed; every card adds to the same server-side cart as Add to cart (the server re-reads the price on add).
 * `action: buy` adds the product and goes to the checkout step (`checkoutStepId`, default the next step); `add` follows `then` like Add to cart.
 */
export const CatalogPropsSchema = z
  .object({
    source: z.enum(['all', 'picked']).default('all'),
    picks: z.array(CatalogPickSchema).max(CATALOG_MAX_ITEMS).default([]),
    sort: z.enum(['catalog', 'price_asc', 'price_desc', 'newest']).default('catalog'),
    limit: z.number().int().min(1).max(CATALOG_MAX_ITEMS).default(12),
    columns: z.number().int().min(1).max(4).default(3),
    showImage: z.boolean().default(true),
    showDescription: z.boolean().default(true),
    showPrice: z.boolean().default(true),
    buttonLabel: z.string().trim().min(1).max(80).default('Add to cart'),
    action: z.enum(['add', 'buy']).default('add'),
    checkoutStepId: stepRef.optional(),
    quantity: QuantitySchema.default({ enabled: false, min: 1, max: 10, default: 1 }),
    then: z.discriminatedUnion('type', [z.object({ type: z.literal('stay') }), z.object({ type: z.literal('next_step') }), z.object({ type: z.literal('step'), stepId: stepRef })]).default({ type: 'stay' }),
    emptyText: z.string().max(200).default('No products are available right now.'),
  })
  .superRefine((p, ctx) => {
    const q = p.quantity;
    if (q.enabled && (q.min > q.max || q.default < q.min || q.default > q.max)) ctx.addIssue({ code: 'custom', path: ['quantity'], message: 'The quantity must start between the least and the most' });
  });
export type CatalogProps = z.infer<typeof CatalogPropsSchema>;

/** "Cart": line items with quantity and remove, the order bumps of the checkout step, totals, and a Checkout button to the step that holds the Payment form. */
export const CartPropsSchema = z.object({
  title: z.string().max(120).default('Your cart'),
  emptyText: z.string().max(200).default('Your cart is empty.'),
  checkoutLabel: z.string().min(1).max(80).default('Checkout'),
  /** The step with the Payment form (default: the next step). */
  checkoutStepId: stepRef.optional(),
  /** Offer the order bumps of the checkout step in the cart (they are pre-selected on the payment page). */
  showBumps: z.boolean().default(true),
});
export type CartProps = z.infer<typeof CartPropsSchema>;

/** Small "Cart (n)" badge, linking to the cart step. */
export const CartCountPropsSchema = z.object({
  label: z.string().max(40).default('Cart'),
  cartStepId: stepRef.optional(),
});
export type CartCountProps = z.infer<typeof CartCountPropsSchema>;

/**
 * "Payment form": order summary plus the card fields on the page. `source: cart` pays the visitor's cart; `product` pays one catalog price (with the page's
 * order bumps). `embedded` shows the Stripe Payment Element (or the TEST form without Stripe); `hosted` keeps the Stripe Checkout redirect.
 */
export const PaymentPropsSchema = z.object({
  source: z.enum(['cart', 'product']).default('cart'),
  mode: z.enum(['embedded', 'hosted']).default('embedded'),
  // Used when source = product (kept as a display snapshot otherwise).
  ...catalogLink,
  productName: z.string().min(1).max(200).default('Your order'),
  price: z.number().min(0).max(1_000_000).default(0),
  quantity: QuantitySchema.optional(),
  title: z.string().max(120).default('Complete your order'),
  buttonLabel: z.string().min(1).max(80).default('Pay now'),
  collectName: z.boolean().default(true),
  collectAddress: z.boolean().default(false),
  success: SuccessSchema.default({ type: 'next_step' }),
});
export type PaymentProps = z.infer<typeof PaymentPropsSchema>;
