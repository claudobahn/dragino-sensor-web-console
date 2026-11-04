/** Helpers for encoding Dragino downlink payloads (big-endian hex). */

export function uintHex(value: number, bytes: number): string {
  if (!Number.isInteger(value) || value < 0 || value >= 2 ** (8 * bytes)) {
    throw new RangeError(`${value} does not fit in ${bytes} byte(s)`);
  }
  return value.toString(16).toUpperCase().padStart(bytes * 2, '0');
}

/** Format a hex string as space-separated bytes: "0100001E" → "01 00 00 1E". */
export function spaced(hex: string): string {
  return (hex.match(/../g) ?? []).join(' ');
}

/** Parse "a,b,c" into integers; returns null if any part is not an integer. */
export function parseIntList(raw: string, count: number): number[] | null {
  const parts = raw.split(',').map((p) => p.trim());
  if (parts.length !== count) return null;
  const nums = parts.map((p) => (/^-?\d+$/.test(p) ? Number(p) : NaN));
  return nums.some((n) => Number.isNaN(n)) ? null : nums;
}

export function safeDownlink(fn: () => string): string | null {
  try {
    return spaced(fn());
  } catch {
    return null;
  }
}
