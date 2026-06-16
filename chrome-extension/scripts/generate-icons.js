'use strict';
/**
 * Ensures public/icons/iconNN.png exist before the build runs.
 *
 * The real icons (rasterized from assets/icon.svg) are checked into the repo
 * under public/icons/, so normally this is a no-op. If they're ever missing
 * (e.g. a fresh checkout before they're committed), it falls back to drawing
 * minimal placeholder PNGs using only Node.js built-ins — no extra
 * dependencies required — so the build never breaks for lack of icons.
 */

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// CRC32 lookup table (IEEE polynomial)
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[i] = c;
}
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(data.length, 0);
  const crcVal = crc32(Buffer.concat([typeBytes, data]));
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crcVal, 0);
  return Buffer.concat([len, typeBytes, data, crcBuf]);
}

function createPNG(size, r, g, b) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.allocUnsafe(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData.writeUInt8(8, 8);  // bit depth
  ihdrData.writeUInt8(2, 9);  // color type: RGB
  ihdrData.writeUInt8(0, 10); // compression
  ihdrData.writeUInt8(0, 11); // filter
  ihdrData.writeUInt8(0, 12); // interlace

  // Build raw scanlines: filter-byte + RGB per pixel
  const rowSize = 1 + size * 3;
  const raw = Buffer.allocUnsafe(size * rowSize);
  for (let y = 0; y < size; y++) {
    raw[y * rowSize] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      // Draw a rounded-square feel: solid fill with slightly lighter center
      const cx = Math.abs(x - size / 2) / (size / 2);
      const cy = Math.abs(y - size / 2) / (size / 2);
      const dist = Math.sqrt(cx * cx + cy * cy);
      const factor = dist < 0.5 ? 1.15 : 1.0;
      const offset = y * rowSize + 1 + x * 3;
      raw[offset]     = Math.min(255, Math.round(r * factor));
      raw[offset + 1] = Math.min(255, Math.round(g * factor));
      raw[offset + 2] = Math.min(255, Math.round(b * factor));
    }
  }

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdrData),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const iconsDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(iconsDir, { recursive: true });

const sizes = [16, 32, 48, 128];

// The real QALens logo (assets/icon.svg, rasterized to public/icons/iconNN.png)
// is checked into the repo — don't clobber it with the placeholder generator
// below. This only fires for a fresh checkout that's somehow missing an icon.
const allPresent = sizes.every(size => fs.existsSync(path.join(iconsDir, `icon${size}.png`)));
if (allPresent) {
  console.log('Icons already present — skipping placeholder generation.');
  process.exit(0);
}

// Brand color: indigo #6366f1
const [R, G, B] = [0x63, 0x66, 0xf1];

for (const size of sizes) {
  fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), createPNG(size, R, G, B));
  console.log(`  ✓ icon${size}.png`);
}
console.log('Icons generated.');
