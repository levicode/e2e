import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { verifyPngMaskProof } from '../src/png-mask-proof.ts';

type Rectangle = { x: number; y: number; width: number; height: number };
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Independent bit-at-a-time fixture CRC, without the production lookup table. */
function chunk(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const name = Buffer.from(type, 'ascii');
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length); name.copy(result, 4); data.copy(result, 8);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([name, data])) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
  return result;
}
/** The supported header uses 8-bit, noninterlaced truecolor or truecolor-alpha. */
function header(width: number, height: number, channels = 4): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width); data.writeUInt32BE(height, 4);
  data[8] = 8; data[9] = channels === 3 ? 2 : 6;
  return data;
}
/** Encode raw RGB(A) scanlines using an independently written PNG filter. */
function filtered(width: number, height: number, channels: number, pixels: Uint8Array, filters: readonly number[]): Buffer {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const filter = filters[y % filters.length]!;
    raw[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i++) {
      const a = i < channels ? 0 : pixels[y * stride + i - channels]!;
      const b = y === 0 ? 0 : pixels[(y - 1) * stride + i]!;
      const c = y === 0 || i < channels ? 0 : pixels[(y - 1) * stride + i - channels]!;
      let predictor = 0;
      if (filter === 1) predictor = a;
      if (filter === 2) predictor = b;
      if (filter === 3) predictor = Math.floor((a + b) / 2);
      if (filter === 4) {
        const p = a + b - c;
        const candidates = [a, b, c];
        let distance = Infinity;
        for (const candidate of candidates) {
          const next = Math.abs(p - candidate);
          if (next < distance) { predictor = candidate; distance = next; }
        }
      }
      raw[y * (stride + 1) + 1 + i] = (pixels[y * stride + i]! - predictor + 256) % 256;
    }
  }
  return raw;
}
/** Synthetic encoder fixtures are test data only, never processed screenshots. */
function png(width: number, height: number, channels = 4, pixels = black(width, height, channels), filters = [0]): Buffer {
  return Buffer.concat([signature, chunk('IHDR', header(width, height, channels)), chunk('IDAT', deflateSync(filtered(width, height, channels, pixels, filters))), chunk('IEND')]);
}
/** Build opaque-black samples, leaving RGB images implicitly opaque. */
function black(width: number, height: number, channels = 4): Buffer {
  const pixels = Buffer.alloc(width * height * channels);
  if (channels === 4) for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  return pixels;
}
/** Default proof covers the complete expected image. */
function proof(data: Uint8Array, width: number, height: number, rectangles: readonly Rectangle[] = [{ x: 0, y: 0, width, height }]) {
  return verifyPngMaskProof(data, { expectedWidth: width, expectedHeight: height, rectangles });
}
/** Reassemble valid chunks so negative tests target parsing rather than stale CRCs. */
function fromCompressed(width: number, height: number, compressed: Buffer): Buffer {
  return Buffer.concat([signature, chunk('IHDR', header(width, height)), chunk('IDAT', compressed), chunk('IEND')]);
}

for (const channels of [3, 4]) for (const filter of [0, 1, 2, 3, 4]) {
  test(`proves every interior black pixel with ${channels === 3 ? 'RGB' : 'RGBA'} filter ${filter}`, () => {
    const width = 7; const height = 5;
    const samples = black(width, height, channels);
    const region = { x: 2, y: 1, width: 3, height: 3 };
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (x >= 2 && x < 5 && y >= 1 && y < 4) continue;
      for (let c = 0; c < 3; c++) samples[(y * width + x) * channels + c] = (x * 107 + y * 53 + c * 31 + 1) % 256;
    }
    assert.deepEqual(proof(png(width, height, channels, samples, [filter]), width, height, [region]), {
      ok: true, verifiedRectangles: 1, verifiedPixels: 9,
    });
    // A single nonblack pixel anywhere in the region must fail; no sampling.
    for (let y = 1; y < 4; y++) for (let x = 2; x < 5; x++) for (let c = 0; c < 3; c++) {
      const changed = Buffer.from(samples); changed[(y * width + x) * channels + c] = 1;
      assert.deepEqual(proof(png(width, height, channels, changed, [filter]), width, height, [region]), {
        ok: false, reason: 'nonblack-mask', verifiedRectangles: 0, verifiedPixels: 0,
      });
    }
  });
}

test('decodes changing filters on consecutive scanlines and a sliced Uint8Array', () => {
  const data = png(3, 10, 4, black(3, 10), [0, 1, 2, 3, 4]);
  const padded = Buffer.concat([Buffer.from('prefix'), data, Buffer.from('suffix')]);
  const slice = new Uint8Array(padded.buffer, padded.byteOffset + 6, data.length);
  assert.deepEqual(proof(slice, 3, 10), { ok: true, verifiedRectangles: 1, verifiedPixels: 30 });
});

test('rejects translucent black and transparent black for every filter', () => {
  for (const alpha of [0, 1, 254]) for (const filter of [0, 1, 2, 3, 4]) {
    const samples = black(2, 2); samples[15] = alpha;
    assert.equal(proof(png(2, 2, 4, samples, [filter]), 2, 2).ok, false);
  }
});

test('outward rounding checks even fractionally intersected edge pixels', () => {
  const samples = black(4, 4);
  const region = { x: 1.8, y: 1.1, width: 0.4, height: 1.1 };
  assert.deepEqual(proof(png(4, 4, 4, samples), 4, 4, [region]), { ok: true, verifiedRectangles: 1, verifiedPixels: 4 });
  samples[(1 * 4 + 1) * 4] = 1;
  assert.equal(proof(png(4, 4, 4, samples), 4, 4, [region]).ok, false);
  assert.deepEqual(proof(png(1, 1), 1, 1, [{ x: 0.1, y: 0.1, width: Number.EPSILON, height: Number.EPSILON }]), { ok: true, verifiedRectangles: 1, verifiedPixels: 1 });
});

test('clips partial regions to visible pixels and counts overlapping pixels once', () => {
  const regions = [{ x: -2, y: -1, width: 4.1, height: 3 }, { x: 1, y: 1, width: 7, height: 7 }];
  assert.deepEqual(proof(png(4, 4), 4, 4, regions), { ok: true, verifiedRectangles: 2, verifiedPixels: 13 });
  const samples = black(4, 4); samples[(3 * 4 + 3) * 4 + 2] = 255;
  assert.equal(proof(png(4, 4, 4, samples), 4, 4, regions).ok, false);
});

test('rejects wholly offscreen, zero, negative, non-finite, overflowing and subprecision geometry', () => {
  const regions: Rectangle[] = [
    { x: 4, y: 0, width: 1, height: 1 }, { x: 0, y: 4, width: 1, height: 1 },
    { x: -2, y: 0, width: 2, height: 1 }, { x: 0, y: -2, width: 1, height: 2 },
    { x: 0, y: 0, width: 0, height: 1 }, { x: 0, y: 0, width: 1, height: 0 },
    { x: 0, y: 0, width: -1, height: 1 }, { x: 0, y: 0, width: 1, height: -1 },
    { x: NaN, y: 0, width: 1, height: 1 }, { x: 0, y: Infinity, width: 1, height: 1 },
    { x: 0, y: 0, width: Infinity, height: 1 }, { x: 0, y: 0, width: 1, height: NaN },
    { x: Number.MAX_SAFE_INTEGER, y: 0, width: 2, height: 1 },
    { x: 1, y: 0, width: Number.MIN_VALUE, height: 1 },
  ];
  for (const region of regions) assert.deepEqual(proof(png(4, 4), 4, 4, [region]), { ok: false, reason: 'invalid-rectangles', verifiedRectangles: 0, verifiedPixels: 0 });
  for (const malformed of [null, {}, [null], [{}], Array(1)]) {
    const untyped: unknown = malformed;
    assert.equal(proof(png(4, 4), 4, 4, untyped as Rectangle[]).ok, false);
  }
});

test('empty coverage succeeds only for a fully valid PNG, without claiming masked pixels', () => {
  const white = Buffer.alloc(16, 255);
  assert.deepEqual(proof(png(2, 2, 4, white), 2, 2, []), { ok: true, verifiedRectangles: 0, verifiedPixels: 0 });
  assert.equal(proof(Buffer.alloc(33), 2, 2, []).ok, false);
  assert.equal(proof(png(2, 2, 4, white, [5]), 2, 2, []).ok, false);
});

test('validates dimensions against caller expectations and fixed resource bounds', () => {
  for (const [width, height] of [[0, 1], [-1, 1], [1.5, 1], [1, NaN], [Infinity, 1], [2, 1], [1, 2], [16_385, 1], [4097, 4096]]) {
    assert.equal(proof(png(1, 1), width!, height!, []).ok, false);
  }
  const tooMany = Array.from({ length: 4097 }, () => ({ x: 0, y: 0, width: 1, height: 1 }));
  assert.deepEqual(proof(png(1, 1), 1, 1, tooMany), { ok: false, reason: 'resource-limit', verifiedRectangles: 0, verifiedPixels: 0 });
  assert.equal(proof(Buffer.alloc(65_547), 1, 1).ok, false);
});

test('rejects truncated PNGs and CRC corruption in header, pixels, and end chunks', () => {
  const data = png(2, 2);
  for (let length = 0; length < data.length; length++) assert.equal(proof(data.subarray(0, length), 2, 2).ok, false);
  for (const index of [0, 12, 20, 29, 41, data.length - 1]) {
    const broken = Buffer.from(data); broken[index] = broken[index]! ^ 1;
    assert.equal(proof(broken, 2, 2).ok, false);
  }
});

test('rejects malformed chunk streams, trailing bytes, missing image data, and duplicate headers', () => {
  const ihdr = chunk('IHDR', header(1, 1)); const idat = chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 255]))); const end = chunk('IEND');
  const bodies = [
    [idat, ihdr, end], [ihdr, ihdr, idat, end], [ihdr, end], [ihdr, idat],
    [ihdr, idat, end, end], [ihdr, idat, chunk('IEND', Buffer.from([0]))],
    [ihdr, idat, end, Buffer.from([0])], [ihdr, chunk('IDAT'), end],
    [ihdr, idat, chunk('sRGB', Buffer.from([0])), idat, end],
    [chunk('IHDR', Buffer.alloc(12)), idat, end],
    [chunk('ÉHDR', header(1, 1)), idat, end],
  ];
  for (const body of bodies) assert.equal(proof(Buffer.concat([signature, ...body]), 1, 1).ok, false);
  const oversizedChunk = Buffer.from(png(1, 1)); oversizedChunk.writeUInt32BE(0xffffffff, 33);
  assert.equal(proof(oversizedChunk, 1, 1).ok, false);
  const tooManyChunks = Buffer.concat([signature, ihdr, ...Array.from({ length: 4094 }, () => chunk('IDAT')), idat, end]);
  assert.equal(proof(tooManyChunks, 1, 1).ok, false);
});

test('accepts multiple consecutive IDAT chunks and valid optional sRGB metadata', () => {
  const compressed = deflateSync(Buffer.from([0, 0, 0, 0, 255]));
  const bytes = Buffer.concat([signature, chunk('IHDR', header(1, 1)), chunk('sRGB', Buffer.from([0])), chunk('IDAT', compressed.subarray(0, 3)), chunk('IDAT'), chunk('IDAT', compressed.subarray(3)), chunk('IEND')]);
  assert.deepEqual(proof(bytes, 1, 1), { ok: true, verifiedRectangles: 1, verifiedPixels: 1 });
  for (const metadata of [[chunk('sRGB')], [chunk('sRGB', Buffer.from([4]))], [chunk('sRGB', Buffer.from([0, 0]))], [chunk('sRGB', Buffer.from([0])), chunk('sRGB', Buffer.from([0]))]]) {
    const bad = Buffer.concat([signature, chunk('IHDR', header(1, 1)), ...metadata, chunk('IDAT', compressed), chunk('IEND')]);
    assert.equal(proof(bad, 1, 1).ok, false);
  }
});

test('rejects unsupported bit depths, colors, compression, filters, interlace and interpretation-changing chunks', () => {
  for (const [offset, value] of [[8, 16], [8, 1], [9, 0], [9, 3], [9, 4], [10, 1], [11, 1], [12, 1]]) {
    const data = header(1, 1); data[offset!] = value!;
    const unsupported = Buffer.concat([signature, chunk('IHDR', data), chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 255]))), chunk('IEND')]);
    assert.equal(proof(unsupported, 1, 1).ok, false);
  }
  for (const type of ['tRNS', 'acTL', 'fcTL', 'fdAT', 'iCCP', 'PLTE', 'ABCD', 'abcd']) {
    const unsupported = Buffer.concat([signature, chunk('IHDR', header(1, 1, 3)), chunk(type, Buffer.alloc(6)), chunk('IDAT', deflateSync(Buffer.alloc(4))), chunk('IEND')]);
    assert.equal(proof(unsupported, 1, 1).ok, false);
  }
});

test('rejects short, oversized, invalid, truncated, trailing, and concatenated zlib streams', () => {
  const raw = Buffer.from([0, 0, 0, 0, 255]); const valid = deflateSync(raw);
  for (const compressed of [
    deflateSync(raw.subarray(0, 4)), deflateSync(Buffer.concat([raw, Buffer.from([0])])),
    deflateSync(Buffer.alloc(1_048_576)), Buffer.from([1, 2, 3]), valid.subarray(0, valid.length - 1),
    Buffer.concat([valid, Buffer.from([0])]), Buffer.concat([valid, valid]),
  ]) assert.deepEqual(proof(fromCompressed(1, 1, compressed), 1, 1), { ok: false, reason: 'invalid-image-data', verifiedRectangles: 0, verifiedPixels: 0 });
});

test('invalid filter anywhere is rejected even outside required coverage', () => {
  assert.equal(proof(png(2, 2, 4, black(2, 2), [0, 255]), 2, 2, [{ x: 0, y: 0, width: 1, height: 1 }]).ok, false);
});
