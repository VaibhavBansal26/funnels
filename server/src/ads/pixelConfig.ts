import { z } from 'zod';
import { ID_FORMATS, ID_HINTS, type IdKind } from './ids.js';

const id = (kind: IdKind) => z.string().trim().regex(ID_FORMATS[kind], `Enter ${ID_HINTS[kind]}`);
const nullable = <T extends z.ZodType>(t: T) => t.nullable().optional();

const text = (max: number) => z.string().trim().max(max);

const consentShape = {
  /** Pixels and tags load only after the visitor accepts. */
  enabled: z.boolean(),
  /** `opt_in`: nothing loads until Accept. `opt_out`: loads at once and the banner lets visitors switch it off (only sensible outside GDPR regions). */
  mode: z.enum(['opt_in', 'opt_out']),
  /** `everyone`, or `eu_uk`: the banner and the wait for consent apply only to visitors whose browser time zone is in Europe (unknown = treated as Europe). */
  regions: z.enum(['everyone', 'eu_uk']),
  /** Honour the browser's Do Not Track and Global Privacy Control signals: nothing loads and no banner is shown. */
  respectDnt: z.boolean(),
  title: text(80),
  message: text(400),
  acceptLabel: text(30),
  rejectLabel: text(30),
  policyUrl: z.string().trim().max(500).refine((u) => u === '' || /^https?:\/\/[^\s"'<>]+$/i.test(u) || /^\/[^\s"'<>]*$/.test(u), 'Use an http(s) address or a path starting with /'),
  position: z.enum(['bottom', 'bottom-left', 'center']),
};
export const ConsentPatch = z.object(consentShape).partial();
export const ConsentConfig = z.object(consentShape);
export type ConsentConfigT = z.infer<typeof ConsentConfig>;
export const CONSENT_DEFAULTS: ConsentConfigT = {
  enabled: false, mode: 'opt_in', regions: 'everyone', respectDnt: true, title: 'We value your privacy',
  message: 'We use cookies and similar technologies to measure and improve our pages and to measure advertising. You can accept or decline.',
  acceptLabel: 'Accept', rejectLabel: 'Decline', policyUrl: '', position: 'bottom',
};

export const PixelSettings = z.object({
  meta: nullable(z.object({ pixelId: id('metaPixel') })),
  ga4: nullable(z.object({ measurementId: id('ga4') })),
  googleAds: nullable(z.object({ conversionId: id('googleAds'), purchaseLabel: nullable(id('googleAdsLabel')), leadLabel: nullable(id('googleAdsLabel')) })),
  tiktok: nullable(z.object({ pixelId: id('tiktok') })),
  linkedin: nullable(z.object({ partnerId: id('linkedinPartner'), purchaseConversionId: nullable(id('linkedinConversion')), leadConversionId: nullable(id('linkedinConversion')) })),
  uet: nullable(z.object({ tagId: id('uet') })),
  /** `Lead` is opt-in because many funnels already count the opt-in as another event. */
  events: z.object({ lead: z.boolean().default(false) }).optional(),
  consent: ConsentPatch.optional(),
});
export type PixelSettingsT = z.infer<typeof PixelSettings>;

export const PROVIDERS = ['meta', 'ga4', 'googleAds', 'tiktok', 'linkedin', 'uet'] as const;
export type PixelProvider = (typeof PROVIDERS)[number];

/** The effective settings of a page: workspace defaults, overridden per provider by the funnel, overridden by the step. `null` at a lower level switches a provider off. */
export interface EffectivePixels {
  meta: { pixelId: string } | null;
  ga4: { measurementId: string } | null;
  googleAds: { conversionId: string; purchaseLabel: string | null; leadLabel: string | null } | null;
  tiktok: { pixelId: string } | null;
  linkedin: { partnerId: string; purchaseConversionId: string | null; leadConversionId: string | null } | null;
  uet: { tagId: string } | null;
  events: { lead: boolean };
  consent: ConsentConfigT;
}

export function resolvePixels(levels: (PixelSettingsT | null | undefined)[]): EffectivePixels {
  const out: EffectivePixels = {
    meta: null, ga4: null, googleAds: null, tiktok: null, linkedin: null, uet: null,
    events: { lead: false },
    consent: { ...CONSENT_DEFAULTS },
  };
  for (const level of levels) {
    if (!level) continue;
    for (const p of PROVIDERS) {
      const v = (level as Record<string, unknown>)[p];
      if (v === null) (out as unknown as Record<string, unknown>)[p] = null;
      else if (v !== undefined) {
        // A level is trusted only after it passes the strict formats again: stored JSON may predate a tightened rule or have been edited by hand.
        const parsed = PixelSettings.safeParse({ [p]: v });
        if (parsed.success) (out as unknown as Record<string, unknown>)[p] = (parsed.data as Record<string, unknown>)[p] ?? null;
      }
    }
    if (level.events?.lead !== undefined) out.events.lead = level.events.lead;
    if (level.consent) out.consent = ConsentConfig.parse({ ...out.consent, ...stripUndefined(level.consent) });
  }
  return out;
}

const stripUndefined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export const hasAnyPixel = (e: EffectivePixels): boolean => PROVIDERS.some((p) => e[p] !== null);
