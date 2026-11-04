/**
 * Fixtures transcribed from a real PS-LS-I4 (firmware "EU868 v1.2") over BLE.
 * Keys, EUIs and the PIN are replaced with fake values.
 */
import { describe, expect, it } from 'vitest';
import { parseConfigDump, parseHelpDescriptions, queryValue, ResponseCollector } from '../src/at/response';
import { redactRx, redactTx, type RedactState } from '../src/util/redact';

const CFG_OUTPUT = [
  '',
  '',
  'Stop Tx events,Please wait for all configurations to print',
  'AT+DEUI=A8 40 41 00 00 00 00 01',
  'AT+APPEUI=A8 40 41 00 00 00 01 01',
  'AT+APPKEY=11 22 33 44 55 66 77 88 99 AA BB CC DD EE FF 00',
  'AT+DADDR=00ABCDEF',
  'AT+APPSKEY=01 23 45 67 89 AB CD EF 01 23 45 67 89 AB CD EF',
  'AT+NWKSKEY=FE DC BA 98 76 54 32 10 FE DC BA 98 76 54 32 10',
  'AT+ADR=1',
  'AT+NJS=1',
  'AT+VER=EU868 v1.2',
  'AT+TDC=1200000',
  'AT+PWORD=ZZ9988',
  'AT+TIMESTAMP=systime= 2026/11/3 13:18:38 (1793711918)',
  '',
  'AT+12VT=500',
  'AT+PROBE=0000',
  '',
  '',
  'Start Tx events',
  '',
  '',
  'OK',
];

describe('real PS-LS-I4 output', () => {
  it('accepts "Correct Password"', () => {
    expect(new ResponseCollector('ZZ9988').push('Correct Password')).toMatchObject({ status: 'password-ok' });
  });

  it('parses a query reply with a blank line before OK', () => {
    const c = new ResponseCollector('AT+PROBE=?');
    for (const l of ['0000', '']) expect(c.push(l)).toBeUndefined();
    const r = c.push('OK')!;
    expect(queryValue('PROBE', r)).toBe('0000');
  });

  it('parses AT+CFG including its banner lines', () => {
    const c = new ResponseCollector('AT+CFG');
    let r;
    for (const l of CFG_OUTPUT) r = c.push(l);
    expect(r?.status).toBe('ok');
    const dump = parseConfigDump(r!.lines);
    expect(dump.get('TDC')).toBe('1200000');
    expect(dump.get('12VT')).toBe('500');
    expect(dump.get('PROBE')).toBe('0000');
    expect(dump.get('VER')).toBe('EU868 v1.2');
  });

  it('redacts every key and the PIN from AT+CFG output', () => {
    const state: RedactState = {};
    const opts = { pin: 'ZZ9988', redactIdentifiers: false };
    redactTx('AT+CFG', opts, state);
    const out = CFG_OUTPUT.map((l) => redactRx(l, opts, state)).join('\n');
    expect(out).not.toMatch(/11 22 33 44|01 23 45 67|FE DC BA 98|ZZ9988/);
    expect(out).toContain('AT+APPKEY=[REDACTED]');
    expect(out).toContain('AT+APPSKEY=[REDACTED]');
    expect(out).toContain('AT+NWKSKEY=[REDACTED]');
    expect(out).toMatch(/AT\+PWORD=\[(REDACTED|PIN)\]/);
    expect(out).toContain('AT+DEUI=A8 40 41 00 00 00 00 01'); // identifiers kept by default
  });

  it('redacts identifiers when asked', () => {
    const opts = { redactIdentifiers: true, identifierLiterals: ['A840410000000001'] };
    expect(redactRx('AT+DADDR=00ABCDEF', opts, {})).toBe('AT+DADDR=[REDACTED ID]');
    expect(redactRx('AT+DEUI=A8 40 41 00 00 00 00 01', opts, {})).toBe('AT+DEUI=[REDACTED ID]');
  });

  it('reads the supported command list from AT?', () => {
    const help = parseHelpDescriptions([
      'AT+DEBUG: Set more info output',
      'ATZ: Trig a reset of the MCU',
      'AT+TDC: Get or set the application data transmission interval in ms',
      'AT+12VT: Get or Set extend the time of 12V power',
      'AT+PROBE: Get or Set the probe model',
      'AT+GETSENSORVALUE: Get current sensor value',
      '',
      'OK',
    ]);
    expect(help.has('TDC')).toBe(true);
    expect(help.has('Z')).toBe(true);
    expect(help.has('GETSENSORVALUE')).toBe(true);
    expect(help.has('2PCALIDC')).toBe(false);
  });
});

describe('real PS-LS-I4 output (second capture)', () => {
  const SENSOR = ['', 'Bat_voltage:3.426 V', 'VDC_Input:0.000 V', 'IDC_Input:4.018 mA', 'GPIO_EXTI:0', 'IN1:0', 'IN2:0', '', 'OK'];

  it('parses AT+GETSENSORVALUE=0', async () => {
    const { parseSensorValues } = await import('../src/profiles/ps-lb');
    const c = new ResponseCollector('AT+GETSENSORVALUE=0');
    let r;
    for (const l of SENSOR) r = c.push(l);
    expect(r?.status).toBe('ok');
    const v = parseSensorValues(r!.lines.join('\n'));
    expect(v.batteryV).toBeCloseTo(3.426);
    expect(v.vdcV).toBe(0);
    expect(v.idcMa).toBeCloseTo(4.018);
  });

  it('keeps AT? help descriptions for secret commands', () => {
    const opts = { pin: 'ZZ9988', redactIdentifiers: true };
    for (const line of [
      'AT+APPKEY: Get or Set the Application Key',
      'AT+APPSKEY: Get or Set the Application Session Key',
      'AT+NWKSKEY: Get or Set the Network Session Key',
      'AT+PWORD: Get or set the password',
      'AT+DEUI: Get or Set the Device EUI',
    ]) {
      expect(redactRx(line, opts, {})).toBe(line);
    }
    // ...but a value after a colon is still redacted.
    expect(redactRx('AT+APPKEY: 11 22 33 44 55 66 77 88 99 AA BB CC DD EE FF 00', opts, {})).toBe('AT+APPKEY: [REDACTED]');
  });
});

describe('AT? descriptions (second real capture)', () => {
  it('keeps each command\'s firmware description', async () => {
    const { parseHelpDescriptions } = await import('../src/at/response');
    const d = parseHelpDescriptions([
      'AT+NJM: Get or Set the Network Join Mode. (0: ABP, 1: OTAA)',
      'AT+TDC: Get or set the application data transmission interval in ms',
      'ATZ: Trig a reset of the MCU',
      'AT+12VT: Get or Set extend the time of 12V power',
      '',
      'OK',
    ]);
    expect(d.get('NJM')).toBe('Get or Set the Network Join Mode. (0: ABP, 1: OTAA)');
    expect(d.get('TDC')).toBe('Get or set the application data transmission interval in ms');
    expect(d.get('Z')).toBe('Trig a reset of the MCU');
    expect(d.size).toBe(4);
  });
});
