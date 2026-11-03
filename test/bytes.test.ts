import { describe, expect, it } from 'vitest';
import { bytesToAsciiPreview, bytesToHex, chunk, hexToBytes, textToBytes } from '../src/util/bytes';
import { LineBuffer } from '../src/util/line-buffer';
import { normalizeUuid, uuid16 } from '../src/ble/known-uuids';

describe('hex helpers', () => {
  it('round-trips hex with assorted separators', () => {
    expect(Array.from(hexToBytes('0x01 02:0a-FF,10'))).toEqual([1, 2, 10, 255, 16]);
    expect(bytesToHex(new Uint8Array([1, 0xab]))).toBe('01 AB');
  });
  it('rejects malformed hex', () => {
    expect(() => hexToBytes('abc')).toThrow(/even/);
    expect(() => hexToBytes('zz')).toThrow(/Hex/);
  });
  it('previews ascii with CR/LF markers', () => {
    expect(bytesToAsciiPreview(textToBytes('OK\r\n\x01'))).toBe('OK␍␊.');
  });
  it('chunks to 20 bytes', () => {
    const parts = chunk(new Uint8Array(45), 20);
    expect(parts.map((p) => p.length)).toEqual([20, 20, 5]);
  });
});

describe('LineBuffer', () => {
  it('reassembles lines split across notifications', () => {
    const lb = new LineBuffer();
    expect(lb.push('Password Cor')).toEqual([]);
    expect(lb.push('rect\r')).toEqual(['Password Correct']);
    expect(lb.push('\nOK\r\n')).toEqual(['OK']); // CRLF split across fragments
    expect(lb.push('AT+TDC=1200000\nnext')).toEqual(['AT+TDC=1200000']);
    expect(lb.partial).toBe('next');
    expect(lb.flush()).toBe('next');
  });
  it('keeps empty lines', () => {
    expect(new LineBuffer().push('a\r\n\r\nb\n')).toEqual(['a', '', 'b']);
  });
});

describe('normalizeUuid', () => {
  it('expands short forms', () => {
    expect(normalizeUuid('FFE0')).toBe(uuid16(0xffe0));
    expect(normalizeUuid('0xffe1')).toBe('0000ffe1-0000-1000-8000-00805f9b34fb');
    expect(normalizeUuid('0000ffe0')).toBe(uuid16(0xffe0));
  });
  it('accepts 128-bit with or without dashes', () => {
    expect(normalizeUuid('6E400001-B5A3-F393-E0A9-E50E24DCCA9E')).toBe('6e400001-b5a3-f393-e0a9-e50e24dcca9e');
    expect(normalizeUuid('6e400001b5a3f393e0a9e50e24dcca9e')).toBe('6e400001-b5a3-f393-e0a9-e50e24dcca9e');
  });
  it('rejects junk', () => {
    expect(normalizeUuid('hello')).toBeNull();
    expect(normalizeUuid('12345')).toBeNull();
  });
});
