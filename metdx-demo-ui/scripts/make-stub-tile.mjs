// Writes test/fixtures/basemap-tile.png: the 256x256 stand-in for every basemap tile in the mock e2e projects
// (test/e2e/engine.ts routes tile.openstreetmap.org to it, so those runs need no network).
// A flat pale blue-grey with a 1 px darker edge, so tile seams (and with them zoom/pan) are still visible in screenshots.
// Run: node scripts/make-stub-tile.mjs   (the PNG is committed; rerun only to change the look)
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const N = 256;
const fill = [221, 229, 236];
const edge = [190, 203, 215];
const raw = Buffer.alloc((N * 3 + 1) * N);
for (let y = 0; y < N; y++) {
  raw[y * (N * 3 + 1)] = 0; // filter: none
  for (let x = 0; x < N; x++) {
    const c = x === 0 || y === 0 ? edge : fill;
    raw.set(c, y * (N * 3 + 1) + 1 + x * 3);
  }
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../test/fixtures/basemap-tile.png', import.meta.url), png);
console.log(`test/fixtures/basemap-tile.png: ${png.length} bytes`);
