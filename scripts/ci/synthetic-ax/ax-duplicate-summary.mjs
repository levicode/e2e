import { isDeepStrictEqual } from 'node:util';
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const categories = ['nodeId', 'backendDOMNodeId', 'frameId', 'parentId', 'childIds', 'ignored', 'role', 'other'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function keyOf(row) {
  if (!object(row)) throw new Error('schema');
  if (typeof row.nodeId === 'string') return row.nodeId;
  if (typeof row.nodeId === 'number' && Number.isSafeInteger(row.nodeId)) return String(row.nodeId);
  throw new Error('schema');
}
function idClass(key) {
  if (key === '') return 'empty';
  if (key === '0') return 'zero';
  if (/^-[0-9]+$/.test(key)) return 'negative';
  return 'other';
}
function presence(left, right, field) {
  const a = own(left, field), b = own(right, field);
  if (!a && !b) return 'bothAbsent';
  if (!a || !b) return 'onePresent';
  return isDeepStrictEqual(left[field], right[field]) ? 'bothPresentEqual' : 'bothPresentDifferent';
}
export function summarizeAX(reply) {
  if (!object(reply) || !Array.isArray(reply.nodes) || reply.nodes.length > 100_000) throw new Error('schema');
  const bytes = Buffer.byteLength(JSON.stringify(reply));
  if (bytes > 16 * 1024 * 1024) throw new Error('budget');
  const out = {
    rowCount: reply.nodes.length, reserializedReplyBytes: bytes, uniqueKeys: 0,
    duplicateKeys: 0, duplicateRows: 0, parsedIdenticalRows: 0, conflictingRows: 0,
    keyWireTypeCollisionRows: 0,
    frameRelation: { bothAbsent: 0, onePresent: 0, bothPresentEqual: 0, bothPresentDifferent: 0 },
    idCategory: { empty: 0, zero: 0, negative: 0, other: 0 },
    ignored: { bothTrue: 0, bothFalse: 0, mixed: 0, missingOrOther: 0 },
    rolePresence: { both: 0, one: 0, neither: 0 },
    differingFields: Object.fromEntries(categories.map(key => [key, 0])),
  };
  const first = new Map(), duplicates = new Set();
  for (const row of reply.nodes) {
    const key = keyOf(row);
    if (!first.has(key)) { first.set(key, row); continue; }
    duplicates.add(key); out.duplicateRows++;
    const previous = first.get(key);
    if (isDeepStrictEqual(previous, row)) out.parsedIdenticalRows++;
    else out.conflictingRows++;
    if (typeof previous.nodeId !== typeof row.nodeId) out.keyWireTypeCollisionRows++;
    out.idCategory[idClass(key)]++;
    out.frameRelation[presence(previous, row, 'frameId')]++;
    if (previous.ignored === true && row.ignored === true) out.ignored.bothTrue++;
    else if (previous.ignored === false && row.ignored === false) out.ignored.bothFalse++;
    else if (typeof previous.ignored === 'boolean' && typeof row.ignored === 'boolean') out.ignored.mixed++;
    else out.ignored.missingOrOther++;
    const roles = Number(own(previous, 'role')) + Number(own(row, 'role'));
    out.rolePresence[roles === 2 ? 'both' : roles === 1 ? 'one' : 'neither']++;
    const different = new Set();
    for (const field of new Set([...Object.keys(previous), ...Object.keys(row)])) {
      if (own(previous, field) !== own(row, field) || !isDeepStrictEqual(previous[field], row[field])) {
        different.add(categories.includes(field) ? field : 'other');
      }
    }
    for (const category of different) out.differingFields[category]++;
  }
  out.uniqueKeys = first.size; out.duplicateKeys = duplicates.size;
  return out;
}
