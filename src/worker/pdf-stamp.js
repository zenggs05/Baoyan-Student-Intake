// Licence stamp for downloaded PDFs (docs/ARCHITECTURE.md §5.4).
//
// build-pdf draws a faint "LICENSED <code> · <day>" line on every page and writes the same text into the XMP
// metadata, but with fixed-width placeholders in place of the code and the day. The placeholders live in
// *uncompressed* streams, so their byte offsets are stable; build-pdf records them in pdfstamp__<p>.json
// (KV `pdfstamp:<p>`). At download time the Worker only overwrites those few bytes with the buyer's key code
// and the date — no PDF parsing, so it fits easily in the Workers CPU budget even for multi-MB files.
//
// Pure JS, no dependencies: imported by the Worker, scripts/ and the test servers.

/** Placeholder for the key code, same length as "ABCD-EFGH-JKMN". */
export const STAMP_CODE_SLOT = '####-####-####';
/** Placeholder for the date, same length as "2026-11-13". */
export const STAMP_DAY_SLOT = '~~~~-~~-~~';
export const STAMP_VERSION = 1;

const CODE_RE = /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SLOTS = 20000;

/** Visible stamp text (WinAnsi: ASCII + "·"). */
export function stampText(code, day) {
  return `LICENSED ${code} · ${day}`;
}

const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

function indexesOf(bytes, needle) {
  const out = [];
  const n = needle.length;
  const first = needle[0];
  for (let i = 0; i <= bytes.length - n; i++) {
    if (bytes[i] !== first) continue;
    let j = 1;
    while (j < n && bytes[i + j] === needle[j]) j++;
    if (j === n) { out.push(i); i += n - 1; }
  }
  return out;
}

/**
 * Build time: find every placeholder in a saved PDF. Returns the map stored in KV as `pdfstamp:<p>`.
 * Throws if the PDF has no placeholders (it was not prepared by build-pdf).
 */
export function findStampSlots(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const code = indexesOf(b, ascii(STAMP_CODE_SLOT));
  const day = indexesOf(b, ascii(STAMP_DAY_SLOT));
  if (!code.length || !day.length) throw new Error('PDF 里没有找到授权标识的占位符');
  if (code.length > MAX_SLOTS || day.length > MAX_SLOTS) throw new Error('PDF 里的授权标识占位符过多');
  return { v: STAMP_VERSION, size: b.length, code, day };
}

function slotsValid(bytes, offsets, slot) {
  if (!Array.isArray(offsets) || !offsets.length || offsets.length > MAX_SLOTS) return false;
  for (const at of offsets) {
    if (!Number.isInteger(at) || at < 0 || at + slot.length > bytes.length) return false;
    for (let i = 0; i < slot.length; i++) if (bytes[at + i] !== slot.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Download time: write `code` / `day` into the placeholders, in place.
 * Returns false (and leaves `bytes` untouched) when the map does not match this PDF — the caller must then
 * refuse the download instead of serving an unstamped file.
 * @param {Uint8Array} bytes  the PDF exactly as stored in KV
 * @param {{v:number,size:number,code:number[],day:number[]}} map
 * @param {{code:string, day:string}} values  code "ABCD-EFGH-JKMN", day "YYYY-MM-DD"
 */
export function applyPdfStamp(bytes, map, { code, day } = {}) {
  if (!(bytes instanceof Uint8Array) || !map || map.v !== STAMP_VERSION || map.size !== bytes.length) return false;
  if (!CODE_RE.test(String(code)) || !DAY_RE.test(String(day))) return false;
  if (!slotsValid(bytes, map.code, STAMP_CODE_SLOT) || !slotsValid(bytes, map.day, STAMP_DAY_SLOT)) return false;
  for (const at of map.code) for (let i = 0; i < code.length; i++) bytes[at + i] = code.charCodeAt(i);
  for (const at of map.day) for (let i = 0; i < day.length; i++) bytes[at + i] = day.charCodeAt(i);
  return true;
}
