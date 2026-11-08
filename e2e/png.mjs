// A tiny PNG encoder for test and screenshot fixtures (product photos without binary files in the repository): a diagonal gradient between two colours
// with a soft disc in the middle, so a card image is recognisably an image.
import { crc32, deflateSync } from 'node:zlib';

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
};

/** @param {number} w @param {number} h @param {string} a `#rrggbb` @param {string} b `#rrggbb` @returns {Buffer} */
export function gradientPng(w, h, a, b) {
  const [ar, ag, ab] = hex(a);
  const [br, bg, bb] = hex(b);
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / h) / 2;
      const d = Math.hypot(x - w / 2, y - h / 2) / (Math.min(w, h) / 3);
      const light = d < 1 ? 0.35 * (1 - d) : 0;
      const mix = (p, q) => Math.round(Math.min(255, p + (q - p) * t + (255 - (p + (q - p) * t)) * light));
      row[1 + x * 3] = mix(ar, br);
      row[2 + x * 3] = mix(ag, bg);
      row[3 + x * 3] = mix(ab, bb);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
