/**
 * HyperLogLog with 4,096 registers (p = 12): standard error 1.04 / sqrt(4096) = 1.6%. A funnel-day sketch is 4 KB dense (about 5.5 KB as base64) and
 * far smaller while sparse. Sketches merge by taking the maximum of each register, so they can be combined across days, batches and processes.
 * Hashing is two seeded 32-bit murmur3 passes (index from one, rank from the other), which is plenty for string ids.
 */
export const P = 12;
export const M = 1 << P;

function murmur3(key: Buffer, seed: number): number {
  let h = seed >>> 0;
  const len = key.length;
  const blocks = len >> 2;
  for (let i = 0; i < blocks; i++) {
    let k = key.readUInt32LE(i * 4);
    k = Math.imul(k, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  let k = 0;
  const tail = blocks * 4;
  const rem = len & 3;
  if (rem === 3) k ^= key[tail + 2]! << 16;
  if (rem >= 2) k ^= key[tail + 1]! << 8;
  if (rem >= 1) {
    k ^= key[tail]!;
    k = Math.imul(k, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
  }
  h ^= len;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const ALPHA = 0.7213 / (1 + 1.079 / M);

export class HyperLogLog {
  constructor(readonly regs: Uint8Array = new Uint8Array(M)) {}

  add(id: string): void {
    const b = Buffer.from(id, 'utf8');
    const idx = murmur3(b, 0x9747b28c) >>> (32 - P);
    const w = murmur3(b, 0x85ebca6b);
    const rank = w === 0 ? 33 : Math.clz32(w) + 1;
    if (rank > this.regs[idx]!) this.regs[idx] = rank;
  }

  merge(other: HyperLogLog): this {
    for (let i = 0; i < M; i++) if (other.regs[i]! > this.regs[i]!) this.regs[i] = other.regs[i]!;
    return this;
  }

  clone(): HyperLogLog {
    return new HyperLogLog(this.regs.slice());
  }

  estimate(): number {
    let sum = 0;
    let zeros = 0;
    for (let i = 0; i < M; i++) {
      const r = this.regs[i]!;
      sum += 2 ** -r;
      if (r === 0) zeros++;
    }
    let e = (ALPHA * M * M) / sum;
    if (e <= 2.5 * M && zeros > 0) e = M * Math.log(M / zeros); // linear counting for small cardinalities
    return Math.round(e);
  }

  /** Dense (type 0): all registers. Sparse (type 1): 3 bytes per non-zero register, used while it is smaller. */
  serialize(): string {
    const nz: number[] = [];
    for (let i = 0; i < M; i++) if (this.regs[i]) nz.push(i);
    if (nz.length * 3 + 1 < M + 1) {
      const out = Buffer.alloc(1 + nz.length * 3);
      out[0] = 1;
      nz.forEach((idx, j) => {
        out.writeUInt16LE(idx, 1 + j * 3);
        out[3 + j * 3] = this.regs[idx]!;
      });
      return out.toString('base64');
    }
    const out = Buffer.alloc(1 + M);
    out[0] = 0;
    out.set(this.regs, 1);
    return out.toString('base64');
  }

  static deserialize(s: string): HyperLogLog {
    const b = Buffer.from(s, 'base64');
    const h = new HyperLogLog();
    if (b.length === 0) return h;
    if (b[0] === 0) h.regs.set(b.subarray(1, 1 + M));
    else for (let o = 1; o + 2 < b.length; o += 3) h.regs[b.readUInt16LE(o)] = b[o + 2]!;
    return h;
  }
}

/** Standard error of the estimate, as a percentage. */
export const STANDARD_ERROR_PCT = (1.04 / Math.sqrt(M)) * 100;
