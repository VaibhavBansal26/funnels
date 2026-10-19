export type ProviderStatus = 'pending' | 'active' | 'failed';

export interface ProviderDomain {
  externalId: string;
  status: ProviderStatus;
  reason?: string;
  /** Extra DNS records the customer must create, when the provider needs any. */
  records?: { type: string; name: string; value: string }[];
}

/** A way of connecting customer hostnames. `manual` (default) uses our own TXT + CNAME verification. */
export interface DomainProvider {
  readonly name: 'manual' | 'cloudflare';
  create(hostname: string): Promise<ProviderDomain | null>;
  get(externalId: string): Promise<ProviderDomain>;
  remove(externalId: string): Promise<void>;
}

export class ManualDomainProvider implements DomainProvider {
  readonly name = 'manual' as const;
  async create(): Promise<null> {
    return null;
  }
  async get(): Promise<ProviderDomain> {
    throw new Error('manual domains are verified through DNS lookups');
  }
  async remove(): Promise<void> {}
}

interface CfHostname {
  id: string;
  status: string;
  verification_errors?: string[];
  ownership_verification?: { type: string; name: string; value: string };
  ssl?: { status?: string; validation_errors?: { message: string }[]; validation_records?: { txt_name?: string; txt_value?: string }[] };
}

/** Maps Cloudflare's hostname + certificate status to ours. Active only when both are active. */
export function mapCloudflareStatus(h: CfHostname): ProviderDomain {
  const ssl = h.ssl?.status ?? 'initializing';
  const records: ProviderDomain['records'] = [];
  if (h.ownership_verification) records.push({ type: h.ownership_verification.type.toUpperCase(), name: h.ownership_verification.name, value: h.ownership_verification.value });
  for (const r of h.ssl?.validation_records ?? []) if (r.txt_name && r.txt_value) records.push({ type: 'TXT', name: r.txt_name, value: r.txt_value });
  const errors = [...(h.verification_errors ?? []), ...(h.ssl?.validation_errors ?? []).map((e) => e.message)];
  let status: ProviderStatus = 'pending';
  if (h.status === 'active' && ssl === 'active') status = 'active';
  else if (['blocked', 'deleted', 'moved', 'pending_deletion'].includes(h.status) || ['validation_timed_out', 'expired', 'deleted', 'issuance_timed_out'].includes(ssl)) status = 'failed';
  return { externalId: h.id, status, reason: status === 'active' ? undefined : errors[0] ?? (status === 'failed' ? `Cloudflare reports ${h.status} / ${ssl}` : undefined), records };
}

/** Cloudflare for SaaS custom hostnames. */
export class CloudflareDomainProvider implements DomainProvider {
  readonly name = 'cloudflare' as const;
  constructor(private opts: { zoneId: string; token: string; base: string; fetch?: typeof fetch }) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const f = this.opts.fetch ?? fetch;
    const res = await f(`${this.opts.base}/zones/${this.opts.zoneId}/custom_hostnames${path}`, {
      method,
      headers: { authorization: `Bearer ${this.opts.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as { success?: boolean; result?: T; errors?: { message: string }[] } | null;
    if (!res.ok || json?.success === false) throw new Error(`Cloudflare API error (${res.status}): ${json?.errors?.[0]?.message ?? 'unknown'}`);
    return json?.result as T;
  }

  async create(hostname: string): Promise<ProviderDomain> {
    return mapCloudflareStatus(await this.call<CfHostname>('POST', '', { hostname, ssl: { method: 'txt', type: 'dv', settings: { min_tls_version: '1.2' } } }));
  }
  async get(externalId: string): Promise<ProviderDomain> {
    return mapCloudflareStatus(await this.call<CfHostname>('GET', `/${encodeURIComponent(externalId)}`));
  }
  async remove(externalId: string): Promise<void> {
    await this.call('DELETE', `/${encodeURIComponent(externalId)}`);
  }
}
