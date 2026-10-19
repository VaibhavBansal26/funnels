import { promises as dns } from 'node:dns';

export interface DnsResolver {
  /** CNAME targets for the host (lowercase, no trailing dot). Empty when the record does not exist. */
  resolveCname(hostname: string): Promise<string[]>;
  /** TXT record values for the host, each record's chunks joined. Empty when none exist. */
  resolveTxt(hostname: string): Promise<string[]>;
}

const EMPTY_CODES = new Set(['ENODATA', 'ENOTFOUND', 'ENOENT']);
const norm = (s: string) => s.toLowerCase().replace(/\.$/, '');

export class NodeDnsResolver implements DnsResolver {
  async resolveCname(hostname: string): Promise<string[]> {
    try {
      return (await dns.resolveCname(hostname)).map(norm);
    } catch (e) {
      if (EMPTY_CODES.has((e as NodeJS.ErrnoException).code ?? '')) return [];
      throw e;
    }
  }

  async resolveTxt(hostname: string): Promise<string[]> {
    try {
      return (await dns.resolveTxt(hostname)).map((chunks) => chunks.join(''));
    } catch (e) {
      if (EMPTY_CODES.has((e as NodeJS.ErrnoException).code ?? '')) return [];
      throw e;
    }
  }
}
