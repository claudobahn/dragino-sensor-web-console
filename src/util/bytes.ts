/** Byte/text helpers shared by the explorer and the console. */

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

export function toBytes(view: DataView | ArrayBuffer | Uint8Array): Uint8Array {
  if (view instanceof Uint8Array) return view;
  if (view instanceof ArrayBuffer) return new Uint8Array(view);
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

export function bytesToHex(bytes: Uint8Array, sep = ' '): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(sep);
}

/** Printable ASCII with non-printables shown as '.', CR/LF shown as ␍/␊. */
export function bytesToAsciiPreview(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    if (b === 0x0d) out += '␍';
    else if (b === 0x0a) out += '␊';
    else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
    else out += '.';
  }
  return out;
}

export function bytesToText(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function textToBytes(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text);
}

/**
 * Parse a loose hex string: accepts spaces, colons, dashes, commas and
 * optional 0x prefixes ("0x01 02:03-04" → [1,2,3,4]).
 */
export function hexToBytes(input: string): Uint8Array<ArrayBuffer> {
  const cleaned = input.replace(/0x/gi, '').replace(/[\s:,\-]/g, '');
  if (cleaned.length === 0) return new Uint8Array();
  if (!/^[0-9a-fA-F]+$/.test(cleaned)) throw new Error('Hex may only contain 0-9, A-F and separators');
  if (cleaned.length % 2 !== 0) throw new Error('Hex string must have an even number of digits');
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Split a payload into chunks no larger than `size` (BLE writes are often limited to 20 bytes). */
export function chunk(bytes: Uint8Array, size: number): Uint8Array[] {
  if (size <= 0) throw new Error('chunk size must be positive');
  const parts: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) parts.push(bytes.subarray(i, i + size));
  return parts;
}

export type LineEnding = 'none' | 'cr' | 'lf' | 'crlf';

export const LINE_ENDINGS: Record<LineEnding, string> = {
  none: '',
  cr: '\r',
  lf: '\n',
  crlf: '\r\n',
};
