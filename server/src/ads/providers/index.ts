import { ga4Provider } from './ga4.js';
import { metaProvider } from './meta.js';
import { tiktokProvider } from './tiktok.js';
import type { ConversionsProvider, ProviderId } from './types.js';

export const PROVIDERS_BY_ID: Record<ProviderId, ConversionsProvider> = { meta: metaProvider, ga4: ga4Provider, tiktok: tiktokProvider };
export const providerFor = (id: string): ConversionsProvider | undefined => (id in PROVIDERS_BY_ID ? PROVIDERS_BY_ID[id as ProviderId] : undefined);
export type { ConversionEvent, ConversionsProvider, ProviderId } from './types.js';
