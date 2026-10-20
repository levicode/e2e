/** Bounded verification of the actual screenshot bytes; never rewrites an image. */
import { inflateSync } from 'node:zlib';

interface MaskRectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
interface ProofOptions {
  readonly expectedWidth: number;
  readonly expectedHeight: number;
  readonly rectangles: readonly MaskRectangle[];
}
type FailureReason = 'invalid-dimensions' | 'invalid-rectangles' | 'resource-limit'
  | 'invalid-png' | 'unsupported-png' | 'invalid-image-data' | 'nonblack-mask';
type Proof = { readonly ok: true; readonly verifiedRectangles: number; readonly verifiedPixels: number }
  | { readonly ok: false; readonly reason: FailureReason; readonly verifiedRectangles: 0; readonly verifiedPixels: 0 };
interface Edge { y: number; left: number; right: number; delta: number }

// Fixed ceilings bound work even if both the header and expected dimensions are untrusted.
const MAX_DIMENSION = 16_384;
const MAX_PIXELS = 16_777_216;
const MAX_RECTANGLES = 4_096;
const MAX_CHUNKS = 4_096;
const ENCODING_ALLOWANCE = 65_536;
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

/** CRC covers both the chunk type and its complete data. */
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of data) crc = CRC_TABLE[(crc ^ value) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
/** Keep failure diagnostics independent of image contents and page-controlled text. */
function fail(reason: FailureReason): Proof {
  return { ok: false, reason, verifiedRectangles: 0, verifiedPixels: 0 };
}
/** PNG's Paeth filter breaks ties in left, above, upper-left order. */
function paeth(left: number, above: number, upperLeft: number): number {
  const predicted = left + above - upperLeft;
  const a = Math.abs(predicted - left); const b = Math.abs(predicted - above); const c = Math.abs(predicted - upperLeft);
  return a <= b && a <= c ? left : b <= c ? above : upperLeft;
}

/**
 * Accepts only complete, noninterlaced, 8-bit RGB/RGBA PNGs from trusted CDP.
 * Expected dimensions must come from the verified screenshot/viewport mapping.
 *
 * Rectangles are in screenshot pixels. Their visible intersection is rounded
 * OUTWARD: every pixel square intersecting it must be exactly opaque black.
 * This intentionally refuses partially black antialiased edge pixels. Empty
 * input means the caller proved there are no visible masks; the PNG is still
 * fully validated. A supplied empty/offscreen/malformed rectangle never passes.
 * Unknown chunks (including transparency, profiles, and animation extensions)
 * are unsupported rather than guessed at. Only optional sRGB metadata is used
 * by the supported encoder. Overlaps count once in verifiedPixels.
 */
export function verifyPngMaskProof(png: Uint8Array, options: ProofOptions): Proof {
  const { expectedWidth: width, expectedHeight: height, rectangles } = options;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return fail('invalid-dimensions');
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) return fail('resource-limit');
  if (!Array.isArray(rectangles)) return fail('invalid-rectangles');
  if (rectangles.length > MAX_RECTANGLES) return fail('resource-limit');
  const edges: Edge[] = [];
  for (const rectangle of rectangles) {
    if (!rectangle || typeof rectangle !== 'object') return fail('invalid-rectangles');
    const { x, y, width: w, height: h } = rectangle;
    if (![x, y, w, h].every(value => Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) || w <= 0 || h <= 0) return fail('invalid-rectangles');
    const right = x + w; const bottom = y + h;
    if (!Number.isFinite(right) || !Number.isFinite(bottom) || Math.abs(right) > Number.MAX_SAFE_INTEGER || Math.abs(bottom) > Number.MAX_SAFE_INTEGER || right <= x || bottom <= y) return fail('invalid-rectangles');
    const left = Math.floor(Math.max(0, x)); const top = Math.floor(Math.max(0, y));
    const clippedRight = Math.ceil(Math.min(width, right)); const clippedBottom = Math.ceil(Math.min(height, bottom));
    if (left >= clippedRight || top >= clippedBottom) return fail('invalid-rectangles');
    edges.push({ y: top, left, right: clippedRight, delta: 1 }, { y: clippedBottom, left, right: clippedRight, delta: -1 });
  }
  edges.sort((a, b) => a.y - b.y);

  // Bound bytes before computing CRCs, concatenating IDAT, or inflating anything.
  const maximumRawBytes = (width * 4 + 1) * height;
  if (!(png instanceof Uint8Array) || png.byteLength < 45) return fail('invalid-png');
  if (png.byteLength > maximumRawBytes * 2 + ENCODING_ALLOWANCE) return fail('resource-limit');
  const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (!bytes.subarray(0, 8).equals(SIGNATURE)) return fail('invalid-png');
  const idat: Uint8Array[] = [];
  let offset = 8; let channels = 0; let chunkCount = 0; let compressedLength = 0;
  let seenData = false; let seenEnd = false; let seenSrgb = false;
  while (offset < bytes.length) {
    if (++chunkCount > MAX_CHUNKS) return fail('resource-limit');
    if (bytes.length - offset < 12) return fail('invalid-png');
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) return fail('invalid-png');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) return fail('invalid-png');
    // Compare raw bytes too: Buffer's ASCII decoder masks off the high bit.
    if (!bytes.subarray(offset + 4, offset + 8).equals(Buffer.from(type, 'ascii'))) return fail('invalid-png');
    if (!channels && type !== 'IHDR') return fail('invalid-png');
    if (type === 'IHDR') {
      if (channels || offset !== 8 || length !== 13) return fail('invalid-png');
      if (data.readUInt32BE(0) !== width || data.readUInt32BE(4) !== height) return fail('invalid-dimensions');
      if (data[8] !== 8 || (data[9] !== 2 && data[9] !== 6) || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) return fail('unsupported-png');
      channels = data[9] === 2 ? 3 : 4;
    } else if (type === 'IDAT') {
      seenData = true; compressedLength += length; idat.push(data);
    } else if (type === 'sRGB') {
      if (seenSrgb || seenData || length !== 1 || data[0]! > 3) return fail('invalid-png');
      seenSrgb = true;
    } else if (type === 'IEND') {
      if (!seenData || length !== 0 || offset + 12 !== bytes.length) return fail('invalid-png');
      seenEnd = true;
    } else return fail('unsupported-png');
    offset += length + 12;
  }
  if (!seenEnd || !channels || compressedLength === 0) return fail('invalid-png');

  const stride = width * channels; const rawLength = (stride + 1) * height;
  let raw: Buffer;
  try {
    // info exposes input consumed, including on supported Node versions which
    // predate rejectGarbageAfterEnd. Reject suffixes/concatenated zlib streams.
    const inflated: unknown = inflateSync(Buffer.concat(idat, compressedLength), { maxOutputLength: rawLength, info: true });
    if (!inflated || typeof inflated !== 'object' || !('buffer' in inflated) || !Buffer.isBuffer(inflated.buffer)
      || !('engine' in inflated) || !inflated.engine || typeof inflated.engine !== 'object' || !('bytesWritten' in inflated.engine)
      || inflated.buffer.length !== rawLength || inflated.engine.bytesWritten !== compressedLength) return fail('invalid-image-data');
    raw = inflated.buffer;
  } catch { return fail('invalid-image-data'); }

  // Sweep a union of rectangles. Work is O(decoded bytes + rectangle count log
  // rectangle count), even if thousands of required regions fully overlap.
  const coverage = new Int32Array(width + 1);
  let edgeIndex = 0; let verifiedPixels = 0;
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1); const filter = raw[row]!;
    if (filter > 4) return fail('invalid-image-data');
    for (let byte = 0; byte < stride; byte++) {
      const position = row + 1 + byte;
      const left = byte >= channels ? raw[position - channels]! : 0;
      const above = y > 0 ? raw[position - stride - 1]! : 0;
      const upperLeft = y > 0 && byte >= channels ? raw[position - stride - 1 - channels]! : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above
        : filter === 3 ? Math.floor((left + above) / 2) : paeth(left, above, upperLeft);
      raw[position] = (raw[position]! + predictor) & 255;
    }
    while (edgeIndex < edges.length && edges[edgeIndex]!.y === y) {
      const edge = edges[edgeIndex++]!;
      coverage[edge.left] = coverage[edge.left]! + edge.delta;
      coverage[edge.right] = coverage[edge.right]! - edge.delta;
    }
    let covered = 0;
    for (let x = 0; x < width; x++) {
      covered += coverage[x]!;
      if (covered === 0) continue;
      const pixel = row + 1 + x * channels;
      if (raw[pixel] !== 0 || raw[pixel + 1] !== 0 || raw[pixel + 2] !== 0 || (channels === 4 && raw[pixel + 3] !== 255)) return fail('nonblack-mask');
      verifiedPixels++;
    }
  }
  return { ok: true, verifiedRectangles: rectangles.length, verifiedPixels };
}
