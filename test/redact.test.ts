import { describe, expect, it } from 'vitest';
import { redactRx, redactTx, type RedactOptions, type RedactState } from '../src/util/redact';

const opts: RedactOptions = { pin: 'A1B2C3', redactIdentifiers: false };
const ids: RedactOptions = { ...opts, redactIdentifiers: true };

describe('redaction', () => {
  it('removes the PIN anywhere', () => {
    const s: RedactState = {};
    expect(redactTx('A1B2C3', opts, s)).toBe('[PIN]');
    expect(redactRx('pin A1B2C3 ok', opts, s)).toBe('pin [PIN] ok');
  });

  it('redacts keys in AT+CFG style dumps', () => {
    const s: RedactState = {};
    expect(redactRx('AT+APPKEY=00 11 22 33 44 55 66 77 88 99 AA BB CC DD EE FF', opts, s)).toBe('AT+APPKEY=[REDACTED]');
    expect(redactRx('AT+NWKSKEY=00112233445566778899aabbccddeeff', opts, s)).toBe('AT+NWKSKEY=[REDACTED]');
    expect(redactRx('AT+APPSKEY=whatever', opts, s)).toBe('AT+APPSKEY=[REDACTED]');
  });

  it('redacts keys being set and PIN changes', () => {
    const s: RedactState = {};
    expect(redactTx('AT+APPKEY=00112233445566778899AABBCCDDEEFF', opts, s)).toBe('AT+APPKEY=[REDACTED]');
    expect(redactTx('AT+PWORD=123456', opts, s)).toBe('AT+PWORD=[REDACTED]');
  });

  it('redacts the bare value returned by a key query', () => {
    const s: RedactState = {};
    expect(redactTx('AT+APPKEY=?', opts, s)).toBe('AT+APPKEY=?');
    expect(redactRx('', opts, s)).toBe('');
    expect(redactRx('2B 7E 15 16 28 AE D2 A6', opts, s)).toBe('[REDACTED]');
    expect(redactRx('OK', opts, s)).toBe('OK');
  });

  it('catches unlabelled 16-byte hex', () => {
    expect(redactRx('key: 2b7e151628aed2a6abf7158809cf4f3c', opts, {})).toBe('key: [REDACTED KEY]');
  });

  it('keeps identifiers unless asked', () => {
    const line = 'AT+DEUI=A8 40 41 12 34 56 78 90';
    expect(redactRx(line, opts, {})).toBe(line);
    expect(redactRx(line, ids, {})).toBe('AT+DEUI=[REDACTED ID]');
    expect(redactRx('AT+DADDR=26 0B 12 34', ids, {})).toBe('AT+DADDR=[REDACTED ID]');
    const s: RedactState = {};
    redactTx('AT+DEUI=?', ids, s);
    expect(redactRx('A8 40 41 12 34 56 78 90', ids, s)).toBe('[REDACTED ID]');
  });

  it('does not touch ordinary output', () => {
    const line = '0001 2025/5/19 06:16:50 3246 in1:low vdc:3.352 idc:0.000 proble:0000 water_deep:0.000';
    expect(redactRx(line, ids, {})).toBe(line);
    expect(redactRx('AT+TDC=1200000', ids, {})).toBe('AT+TDC=1200000');
    expect(redactRx('AT+APPEUI=?', opts, {})).toBe('AT+APPEUI=?');
  });
});

describe('identifier literals and false positives', () => {
  it('hides the DevEUI anywhere when identifiers are redacted', () => {
    const o: RedactOptions = { redactIdentifiers: true, identifierLiterals: ['A840411234567890'] };
    expect(redactRx('name a8 40 41 12 34 56 78 90 seen', o, {})).toBe('name [REDACTED ID] seen');
    expect(redactRx('A840411234567890', { ...o, redactIdentifiers: false }, {})).toBe('A840411234567890');
  });
  it('leaves long decimal numbers alone', () => {
    expect(redactRx('AT+TDC=12000000', ids, {})).toBe('AT+TDC=12000000');
    expect(redactRx('AT+PDTA=1,416 8031000', ids, {})).toBe('AT+PDTA=1,416 8031000');
  });
});

describe('echoed queries', () => {
  it('does not let an echo use up the pending query', () => {
    const o: RedactOptions = { redactIdentifiers: true };
    const s: RedactState = {};
    redactTx('AT+APPEUI=?', o, s);
    expect(redactRx('AT+APPEUI=?', o, s)).toBe('AT+APPEUI=?');
    expect(redactRx('A8 40 41 00 00 00 01 01', o, s)).toBe('[REDACTED ID]');
  });
});

describe('order of redaction rules', () => {
  it('a short PIN inside a key does not stop the key being redacted', () => {
    expect(redactRx('11 22 33 44 55 66 77 88 99 AA BB CC DD EE FF 00', { pin: '22', redactIdentifiers: false }, {})).toBe('[REDACTED KEY]');
    expect(redactRx('AT+APPKEY=11 22 33 44 55 66 77 88 99 AA BB CC DD EE FF 00', { pin: '22', redactIdentifiers: false }, {})).toBe('AT+APPKEY=[REDACTED]');
  });
});

describe('ordinary output mentioning pins', () => {
  it('is not redacted', () => {
    expect(redactRx('Interrupt pin: PA8 rising', { redactIdentifiers: false }, {})).toBe('Interrupt pin: PA8 rising');
    expect(redactRx('GPIO_pin=1', { redactIdentifiers: false }, {})).toBe('GPIO_pin=1');
    expect(redactRx('AT+PWORD=123456', { redactIdentifiers: false }, {})).toBe('AT+PWORD=[REDACTED]');
  });
});
