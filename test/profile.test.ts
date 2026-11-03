import { describe, expect, it } from 'vitest';
import { parseConfigDump, queryValue, ResponseCollector } from '../src/at/response';
import { parseCurrentMa, PS_LB_PROFILE } from '../src/profiles/ps-lb';
import { decodeProbe, depthFromMa, twoPointCalibration } from '../src/profiles/water-depth';

const setting = (cmd: string) => PS_LB_PROFILE.groups.flatMap((g) => g.settings).find((s) => s.cmd === cmd)!;

describe('ResponseCollector', () => {
  it('handles echo + value + OK', () => {
    const c = new ResponseCollector('AT+TDC=?');
    expect(c.push('AT+TDC=?')).toBeUndefined();
    expect(c.push('1200000')).toBeUndefined();
    const r = c.push('OK')!;
    expect(r.status).toBe('ok');
    expect(r.value).toBe('1200000');
  });
  it('handles a value glued to OK', () => {
    const r = new ResponseCollector('AT+2PCALIDC=?').push('0,0,0,0OK')!;
    expect(r).toMatchObject({ status: 'ok', value: '0,0,0,0' });
    expect(new ResponseCollector('AT+TDC=?').push('30000 OK')).toMatchObject({ value: '30000' });
  });
  it('does not treat words ending in OK as status', () => {
    const c = new ResponseCollector('AT+X');
    expect(c.push('Join OK')).toBeUndefined();
  });
  it('recognises errors and password replies', () => {
    expect(new ResponseCollector('AT+FOO=1').push('AT_PARAM_ERROR')).toMatchObject({ status: 'error', error: 'AT_PARAM_ERROR' });
    expect(new ResponseCollector('123456').push('Password Correct')).toMatchObject({ status: 'password-ok' });
    expect(new ResponseCollector('123456').push('Incorrect Password')).toMatchObject({ status: 'password-bad' });
  });
  it('collects multi-line output', () => {
    const c = new ResponseCollector('AT+CFG');
    c.push('AT+TDC=1200000');
    c.push('AT+PROBE=0004');
    const r = c.push('OK')!;
    expect(parseConfigDump(r.lines)).toEqual(
      new Map([
        ['TDC', '1200000'],
        ['PROBE', '0004'],
      ]),
    );
  });
});

describe('queryValue', () => {
  it('accepts labelled and bare values', () => {
    const r = (lines: string[]) => ({ command: '', status: 'ok' as const, lines, value: lines.join('\n') });
    expect(queryValue('TDC', r(['1200000']))).toBe('1200000');
    expect(queryValue('TDC', r(['AT+TDC=1200000']))).toBe('1200000');
    expect(queryValue('TDC', { ...r(['x']), status: 'error' })).toBeUndefined();
  });
});

describe('PS-LB settings', () => {
  it('converts TDC minutes and encodes the downlink', () => {
    const tdc = setting('TDC');
    expect(tdc.toDisplay!('1200000')).toBe('20');
    expect(tdc.fromDisplay!('0.5')).toBe('30000');
    expect(tdc.downlink!('30000')).toBe('01 00 00 1E');
    expect(tdc.validate!('1000')).toMatch(/0.5/);
  });
  it('encodes PROBE and power outputs', () => {
    expect(setting('PROBE').downlink!('0004')).toBe('08 00 04');
    expect(setting('PROBE').validate!('4')).not.toBeNull();
    // Typing "4" in the field means 0004, as it is displayed.
    expect(setting('PROBE').fromDisplay!('4')).toBe('0004');
    expect(setting('PROBE').fromDisplay!('0x4')).toBe('0004');
    expect(setting('PROBE').fromDisplay!('0004')).toBe('0004');
    expect(setting('PROBE').fromDisplay!('zz')).toBe('ZZ');
    expect(setting('3V3T').downlink!('120000')).toBe('07 01 01 D4 C0'); // example from the manual
    expect(setting('5VT').validate!('400000')).toMatch(/between/);
  });
  it('encodes calibration downlinks', () => {
    expect(setting('CALIBRATION').downlink!('1000,1000')).toBe('0C 03 E8 03 E8');
    expect(setting('CALIBRATION').describe!('1005,1008')).toBe('current ×1.005, voltage ×1.008');
    expect(setting('2PCALIDC').downlink!('4000,4100,20000,19800')).toBe('0D 01 0F A0 10 04 4E 20 4D 58');
    expect(setting('2PCALIDC').validate!('1,5,2,5')).toMatch(/differ/);
    expect(setting('2PCALIDC').describe!('0,0,0,0')).toBe('off');
  });
});

describe('water depth', () => {
  it('decodes probe codes', () => {
    expect(decodeProbe('0004')).toMatchObject({ kind: 'water-depth', rangeM: 4 });
    expect(decodeProbe('000A')).toMatchObject({ kind: 'water-depth', rangeM: 10 });
    expect(decodeProbe('0101').text).toMatch(/type A/);
    expect(decodeProbe('0').kind).toBe('unset');
  });
  it('converts current to depth', () => {
    expect(depthFromMa(4, 4)).toBe(0);
    expect(depthFromMa(12, 4)).toBe(2);
    expect(depthFromMa(20, 4)).toBe(4);
  });
  it('computes a two-point calibration', () => {
    const cal = twoPointCalibration({ depthM: 0, measuredMa: 4.05 }, { depthM: 2, measuredMa: 11.9 }, 4);
    expect(cal.command).toBe('AT+2PCALIDC=4000,4050,12000,11900');
    expect(cal.gain).toBeCloseTo(8000 / 7850, 6);
    expect(() => twoPointCalibration({ depthM: 0, measuredMa: 5 }, { depthM: 1, measuredMa: 5 }, 4)).toThrow(/differ/);
  });
  it('parses current readings from sensor output', () => {
    expect(parseCurrentMa('IDC_IN:10.158mA VDC_IN:5.006V')).toBeCloseTo(10.158);
    expect(parseCurrentMa('vdc:3.352 idc:4.012 proble:0004')).toBeCloseTo(4.012);
    expect(parseCurrentMa('IDC=10158uA')).toBeCloseTo(10.158);
    expect(parseCurrentMa('no reading')).toBeUndefined();
  });
});
