import { describe, expect, it } from 'vitest';
import { buildBackup, commandLines } from '../src/at/backup';

// Shape of real PS-LS-I4 v1.2 AT+CFG output, with fake keys/identifiers.
const CFG = [
  '',
  'Stop Tx events,Please wait for all configurations to print',
  'AT+DEUI=A8 40 41 00 00 00 00 01',
  'AT+APPEUI=A8 40 41 00 00 00 01 01',
  'AT+APPKEY=11 22 33 44 55 66 77 88 99 AA BB CC DD EE FF 00',
  'AT+DADDR=00ABCDEF',
  'AT+APPSKEY=01 23 45 67 89 AB CD EF 01 23 45 67 89 AB CD EF',
  'AT+NWKSKEY=FE DC BA 98 76 54 32 10 FE DC BA 98 76 54 32 10',
  'AT+ADR=1',
  'AT+NJM=1',
  'AT+FCU=68',
  'AT+NJS=1',
  'AT+VER=EU868 v1.2',
  'AT+TDC=1200000',
  'AT+PWORD=ZZ9988',
  'AT+TIMESTAMP=systime= 2026/11/3 13:18:38 (1793711918)',
  'AT+12VT=500',
  'AT+PROBE=0004',
  'Start Tx events',
];

describe('buildBackup', () => {
  const b = buildBackup({ cfgLines: CFG, deviceName: 'A840410000000001', date: new Date('2026-11-03T12:00:00Z') });
  const cmds = commandLines(b.text);

  it('restores settings and identity, in that order', () => {
    expect(cmds).toEqual([
      'AT+ADR=1',
      'AT+TDC=1200000',
      'AT+12VT=500',
      'AT+PROBE=0004',
      'AT+DEUI=A8 40 41 00 00 00 00 01',
      'AT+APPEUI=A8 40 41 00 00 00 01 01',
      'AT+APPKEY=11 22 33 44 55 66 77 88 99 AA BB CC DD EE FF 00',
      'AT+NJM=1',
    ]);
    expect(b.firmware).toBe('EU868 v1.2');
  });

  it('never replays status, counters, OTAA session keys or the PIN', () => {
    for (const c of ['AT+VER', 'AT+NJS', 'AT+FCU', 'AT+TIMESTAMP', 'AT+DADDR', 'AT+APPSKEY', 'AT+NWKSKEY', 'AT+PWORD']) {
      expect(cmds.some((l) => l.startsWith(c + '='))).toBe(false);
    }
    expect(b.text).toContain('# AT+PWORD=ZZ9988');
  });

  it('restores ABP session values when NJM=0', () => {
    const abp = commandLines(buildBackup({ cfgLines: CFG.map((l) => (l === 'AT+NJM=1' ? 'AT+NJM=0' : l)) }).text);
    expect(abp).toContain('AT+DADDR=00ABCDEF');
    expect(abp.some((l) => l.startsWith('AT+APPSKEY='))).toBe(true);
  });

  it('warns about secrets and keeps the raw dump as comments', () => {
    expect(b.text).toMatch(/CONTAINS SECRETS \(AT\+APPKEY, AT\+APPSKEY, AT\+NWKSKEY, AT\+PWORD\)/);
    expect(b.text).toContain('# Stop Tx events,Please wait for all configurations to print');
  });

  it('rejects output with no settings', () => {
    expect(() => buildBackup({ cfgLines: ['AT_ERROR'] })).toThrow(/No settings/);
  });
});

describe('commandLines', () => {
  it('skips comments and blanks', () => {
    expect(commandLines('# hi\n\nAT+TDC=?\r\n  # indented\nAT+VER=?')).toEqual(['AT+TDC=?', 'AT+VER=?']);
  });
});
