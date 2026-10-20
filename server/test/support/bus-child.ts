// Child process for the crash test: consumes one topic, marks itself started on stdout, then never acknowledges (the test SIGKILLs it).
import { Redis } from 'ioredis';
import { RedisStreamsBus } from '../../src/queue/eventbus.js';

const [url, prefix, topic] = process.argv.slice(2) as [string, string, string];
const bus = new RedisStreamsBus(new Redis(url, { maxRetriesPerRequest: null }), prefix, { partitions: 2, leaseMs: 500, pollMs: 50 });
await bus.subscribe({ group: 'g', topics: [topic], handler: (e) => { process.stdout.write(`started ${e.id}\n`); return new Promise<void>(() => undefined); } });
process.stdout.write('ready\n');
