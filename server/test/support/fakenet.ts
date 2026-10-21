/** A scripted `fetch` for outbound calls (ad networks, Cloudflare): records every request and answers from a queue or a default. Tests never reach the network. */
export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  json: any;
}
export type Answer = { status: number; body?: unknown } | Error | ((c: Call) => { status: number; body?: unknown } | Error);

export class FakeNet {
  calls: Call[] = [];
  queue: Answer[] = [];
  /** Answers by URL substring when the queue is empty. */
  routes: [string, Answer][] = [];
  fallback: Answer = { status: 200, body: {} };

  fetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = typeof init?.body === 'string' ? init.body : init?.body ? '[binary]' : '';
    let json: any = null;
    try {
      json = body ? JSON.parse(body) : null;
    } catch {
      /* not JSON */
    }
    const call: Call = { url, method: init?.method ?? 'GET', headers, body, json };
    this.calls.push(call);
    let answer: Answer = this.queue.length ? this.queue.shift()! : (this.routes.find(([k]) => url.includes(k))?.[1] ?? this.fallback);
    if (typeof answer === 'function') answer = answer(call);
    if (answer instanceof Error) throw answer;
    const text = answer.body === undefined ? '' : typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
    return new Response([204, 205, 304].includes(answer.status) ? null : text, { status: answer.status, headers: { 'content-type': 'application/json' } });
  };

  reset() {
    this.calls = [];
    this.queue = [];
    this.routes = [];
  }
}
