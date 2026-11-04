import { afterEach, describe, expect, it, vi } from 'vitest';
import DECODER_SOURCE from '../decoders/ps-lb.js?raw';
import { maxPowerOnMs, parseFirmwareVersion, PS_LB_PROFILE } from '../src/profiles/ps-lb';
import { FAULT_HIGH_MA, FAULT_LOW_MA } from '../src/profiles/water-depth';
import { PARTIAL_FLUSH_MS, TimedLineBuffer } from '../src/util/line-buffer';

describe('TimedLineBuffer', () => {
  afterEach(() => vi.useRealTimers());

  it('does not split a line paused for a burst gap (~350 ms)', () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const b = new TimedLineBuffer((l) => lines.push(l));
    b.push('AT+RX2FQ: Get or Set the Rx2 window freq');
    vi.advanceTimersByTime(350);
    b.push('uency\r\n');
    expect(lines).toEqual(['AT+RX2FQ: Get or Set the Rx2 window frequency']);
  });

  it('emits unterminated text after the flush delay', () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const b = new TimedLineBuffer((l) => lines.push(l));
    b.push('Correct Password');
    vi.advanceTimersByTime(PARTIAL_FLUSH_MS - 1);
    expect(lines).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(lines).toEqual(['Correct Password']);
  });
});

describe('firmware-dependent power-output limits', () => {
  const twelveVt = PS_LB_PROFILE.groups.flatMap((g) => g.settings).find((s) => s.cmd === '12VT')!;

  it('parses AT+VER formats', () => {
    expect(parseFirmwareVersion('EU868 v1.2')).toEqual([1, 2, 0]);
    expect(parseFirmwareVersion('v1.2.8 EU868')).toEqual([1, 2, 8]);
    expect(parseFirmwareVersion(undefined)).toBeUndefined();
    expect(parseFirmwareVersion('LoRaWAN 1.0.3 PS-LB v1.2.7 EU868')).toEqual([1, 2, 7]);
  });

  it('uses the limit for the connected firmware', () => {
    expect(maxPowerOnMs({ firmware: 'EU868 v1.1' })).toBe(65535);
    expect(maxPowerOnMs({ firmware: 'EU868 v1.2' })).toBe(180000);
    expect(maxPowerOnMs({ firmware: 'EU868 v1.2.6' })).toBe(180000);
    expect(maxPowerOnMs({ firmware: 'EU868 v1.2.7' })).toBe(360000);
    expect(maxPowerOnMs({})).toBe(360000);
    expect(twelveVt.validate!('200000', { firmware: 'EU868 v1.2' })).toMatch(/between 0 and 180000/);
    expect(twelveVt.validate!('200000', { firmware: 'v1.2.8 EU868' })).toBeNull();
  });
});

describe('probe fault thresholds', () => {
  it('match between the console and decoders/ps-lb.js', () => {
    const num = (name: string) => Number(new RegExp(`var ${name} = ([\\d.]+);`).exec(DECODER_SOURCE)?.[1]);
    expect(num('FAULT_LOW_MA')).toBe(FAULT_LOW_MA);
    expect(num('FAULT_HIGH_MA')).toBe(FAULT_HIGH_MA);
  });
});

describe('second review fixes', () => {
  it('TDC: AT value and downlink agree (whole seconds)', async () => {
    const { PS_LB_PROFILE: P } = await import('../src/profiles/ps-lb');
    const tdc = P.groups.flatMap((g) => g.settings).find((s) => s.cmd === 'TDC')!;
    expect(tdc.fromDisplay!('1.234')).toBe('74000');
    expect(tdc.downlink!('74000')).toBe('01 00 00 4A');
    expect(tdc.validate!('74040')).toMatch(/whole number of seconds/);
    expect(tdc.toDisplay!('74000')).toBe('1.2333');
    expect(tdc.fromDisplay!(tdc.toDisplay!('74000'))).toBe('74000'); // round trip is stable
    expect(tdc.toDisplay!('1200000')).toBe('20');
  });

  it('isAtCommand separates commands from possible PINs', async () => {
    const { isAtCommand } = await import('../src/at/response');
    for (const c of ['AT', 'ATZ', 'AT?', 'at+cfg', 'AT+TDC=?']) expect(isAtCommand(c), c).toBe(true);
    for (const c of ['123456', 'AT12', 'ATX', 'hello']) expect(isAtCommand(c), c).toBe(false);
  });
});
