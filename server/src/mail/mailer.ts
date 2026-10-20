import { createHmac } from 'node:crypto';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';

/**
 * Outbound mail for invitations and password resets. No SMTP library is bundled: `webhook` posts `{from,to,subject,text}` as JSON (signed with
 * `X-Signature: sha256=<HMAC>` when MAIL_WEBHOOK_SECRET is set) to an endpoint you control, which hands it to any provider (SES, Postmark, SMTP relay).
 * `console` prints the message (development only: it contains the one-time link). `none` delivers nothing; the app then shows the invitation link to
 * the inviter and a password reset cannot be delivered.
 */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  readonly kind: 'none' | 'console' | 'webhook' | 'capture';
  /** Resolves true when the message was handed to a transport, false when this mailer delivers nothing. Rejects when the transport failed. */
  send(m: MailMessage): Promise<boolean>;
}

export class NoopMailer implements Mailer {
  readonly kind = 'none';
  async send(): Promise<boolean> {
    return false;
  }
}

export class ConsoleMailer implements Mailer {
  readonly kind = 'console';
  constructor(private log: Logger) {}
  async send(m: MailMessage): Promise<boolean> {
    this.log.info('mail (console transport, development only)', { to: m.to, subject: m.subject, text: m.text });
    return true;
  }
}

export class WebhookMailer implements Mailer {
  readonly kind = 'webhook';
  constructor(private o: { url: string; from: string; secret?: string; fetch?: typeof fetch }) {}
  async send(m: MailMessage): Promise<boolean> {
    const body = JSON.stringify({ from: this.o.from, ...m });
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.o.secret) headers['x-signature'] = `sha256=${createHmac('sha256', this.o.secret).update(body).digest('hex')}`;
    const res = await (this.o.fetch ?? fetch)(this.o.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`mail webhook answered ${res.status}`);
    return true;
  }
}

/** Test double: keeps what was sent. */
export class CaptureMailer implements Mailer {
  readonly kind = 'capture';
  sent: MailMessage[] = [];
  async send(m: MailMessage): Promise<boolean> {
    this.sent.push(m);
    return true;
  }
  /** The last one-time link (a URL with `token=`) sent to `to`. */
  linkTo(to: string): string | undefined {
    return [...this.sent].reverse().find((m) => m.to === to)?.text.match(/https?:\/\/\S+/)?.[0];
  }
}

export function createMailer(config: Config, log: Logger): Mailer {
  if (config.MAIL_TRANSPORT === 'webhook') return new WebhookMailer({ url: config.MAIL_WEBHOOK_URL!, from: config.MAIL_FROM, secret: config.MAIL_WEBHOOK_SECRET });
  if (config.MAIL_TRANSPORT === 'console') return new ConsoleMailer(log);
  return new NoopMailer();
}
