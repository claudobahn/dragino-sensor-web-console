import { parse } from 'acorn';
import { describe, expect, it } from 'vitest';
import SOURCE from '../decoders/ps-lb.js?raw';


type Result = { data?: Record<string, unknown>; warnings?: string[]; errors?: string[] };
type Input = { fPort: number; bytes: number[]; variables?: Record<string, string> };

// The decoder is our own file; evaluate it the way TTN/ChirpStack do (a plain script defining decodeUplink).
const decodeUplink = new Function(`${SOURCE}\nreturn decodeUplink;`)() as (input: Input) => Result;

const hex = (s: string) => (s.replace(/\s/g, '').match(/../g) ?? []).map((b) => parseInt(b, 16));
const up = (fPort: number, payload: string, variables?: Record<string, string>) =>
  decodeUplink({ fPort, bytes: hex(payload), variables });

describe('PS-LB decoder: compatibility and syntax', () => {
  it('is plain ES5 (TTN script engine)', () => {
    expect(() => parse(SOURCE, { ecmaVersion: 5, sourceType: 'script' })).not.toThrow();
  });
});

describe('port 2: sensor value', () => {
  it('decodes a real PS-LS-I4 reading (probe in air)', () => {
    // Bat 3.420 V, PROBE 0004, IDC 4.017 mA, VDC 0, no flags
    const r = up(2, '0D5C 0004 0FB1 0000 00');
    expect(r.errors).toBeUndefined();
    expect(r.warnings).toBeUndefined();
    expect(r.data).toMatchObject({
      Node_type: 'PS-LB',
      Bat_V: 3.42,
      Probe_mod: '0004',
      IDC_intput_mA: 4.017,
      VDC_intput_V: 0,
      IN1_pin_level: 'Low',
      IN2_pin_level: 'Low',
      Exti_pin_level: 'Low',
      Exti_status: 'False',
      IDC_Roc_flagL: 'FALSE',
      IDC_Roc_flagH: 'FALSE',
      VDC_Roc_flagL: 'FALSE',
      VDC_Roc_flagH: 'FALSE',
      Water_deep_cm: 0.425,
      Water_deep_m: 0.004,
      Probe_fault: 'False',
    });
  });

  it('matches the manual example values and flag bits', () => {
    // BAT 0B45 = 2.885 V, IDC 27AE = 10.158 mA, VDC 138E = 5.006 V; flags: IN1, Exti level, interrupt, IDC ROC up
    const r = up(2, '0B45 0003 27AE 138E 4B');
    expect(r.data).toMatchObject({
      Bat_V: 2.885,
      IDC_intput_mA: 10.158,
      VDC_intput_V: 5.006,
      IN1_pin_level: 'High',
      IN2_pin_level: 'Low',
      Exti_pin_level: 'High',
      Exti_status: 'True',
      IDC_Roc_flagH: 'TRUE',
      IDC_Roc_flagL: 'FALSE',
    });
    expect(r.data!.Water_deep_cm as number).toBeCloseTo((10.158 - 4) * 18.75, 2);
  });

  it('flags an open or unpowered loop instead of silently reporting 0 cm', () => {
    const r = up(2, '0D5C 0004 0000 0000 00');
    expect(r.data).toMatchObject({ Water_deep_cm: 0, Probe_fault: 'True' });
    expect(r.warnings?.[0]).toMatch(/outside 3.6–21 mA/);
  });

  it('decodes a negative current as negative, not ~65.5 mA', () => {
    const r = up(2, '0D5C 0004 FFF6 0000 00');
    expect(r.data).toMatchObject({ IDC_intput_mA: -0.01, Water_deep_cm: 0, Probe_fault: 'True' });
    expect(r.warnings).toContain('Negative current reading (-0.01 mA)');
  });

  it('warns when AT+PROBE is not set', () => {
    const r = up(2, '0D5C 0000 2EE0 0000 00'); // 12 mA
    expect(r.data!.Water_deep_cm).toBe(0);
    expect(r.warnings?.join()).toMatch(/AT\+PROBE is 0000/);
  });

  it('applies calibration from ChirpStack device variables and keeps the raw value', () => {
    const r = up(2, '0D5C 0004 2EE0 0000 00', { idc_gain: '1.01', idc_offset_mA: '-0.05' });
    expect(r.data!.IDC_raw_mA).toBe(12);
    expect(r.data!.IDC_intput_mA).toBeCloseTo(12.07, 3);
    expect(r.data!.Water_deep_cm as number).toBeCloseTo((12.07 - 4) * 25, 2);
  });

  it('decodes the pulse count on 13-byte uplinks (firmware 1.2.1+)', () => {
    expect(up(2, '0D5C 0004 0FB1 0000 00 0000012C').data!.Pulse_counting).toBe(300);
  });

  it('decodes pressure probes with Dragino factors and field names', () => {
    expect(up(2, '0D5C 0101 4E20 0000 00').data!.Water_pressure_kPa).toBe(0.6); // type A at 20 mA
    expect(up(2, '0D5C 0204 2EE0 0000 00').data!.Differential_pressure_Pa).toBe(500); // 0–1 kPa at 12 mA
  });
});

describe('port 5: device status', () => {
  it('decodes model, firmware, band and battery', () => {
    expect(up(5, '16 0128 01 00 0D5C').data).toEqual({
      SENSOR_MODEL: 'PS-LB',
      FIRMWARE_VERSION: '1.2.8',
      FREQUENCY_BAND: 'EU868',
      SUB_BAND: 0,
      BAT: 3.42,
      Node_type: 'PS-LB',
    });
    expect(up(5, '16 0120 0F FF 0D5C').data).toMatchObject({ FREQUENCY_BAND: 'AS923_4', SUB_BAND: 'NULL' });
  });
});

describe('port 3: datalog', () => {
  it('decodes the manual example entry in UTC', () => {
    const r = up(3, '0000 0D10 0000 40 6788DB63');
    expect(r.data!.DATALOG2).toBe('[0000,3.344,0,Low,Low,Low,False,0,2025-01-16 10:11:47]');
    expect(r.data!.PNACKMD).toBe('False');
    expect(r.data!.DATALOG2_entries).toEqual([
      expect.objectContaining({ VDC_intput_V: 3.344, IDC_intput_mA: 0, Poll_message: 'True', Time: '2025-01-16T10:11:47.000Z' }),
    ]);
  });

  it('skips the all-zero "no data" record and trailing partial bytes', () => {
    expect(up(3, '0000000000000000000000').data).toMatchObject({ DATALOG2: '', DATALOG2_entries: [] });
    expect((up(3, '0004 0000 2EE0 80 6788DB63 0004').data!.DATALOG2_entries as unknown[]).length).toBe(1);
    expect(up(3, '0004 0000 2EE0 80 6788DB63').data!.PNACKMD).toBe('True');
  });
});

describe('ports 7 and 8: multiple samples', () => {
  it('keeps Dragino strings and adds number arrays', () => {
    expect(up(7, '0D5C 0FB1 0FB2').data).toMatchObject({ Bat_V: 3.42, DATALOG: '[4.017][4.018]', DATALOG_values: [4.017, 4.018] });
    expect(up(8, '0D5C 2EE0').data).toMatchObject({ Mul_tdcdata: '[12.000]', Mul_tdcdata_values: [12] });
  });
});

describe('errors', () => {
  it('rejects unknown ports and short payloads', () => {
    expect(up(1, '00').errors?.[0]).toMatch(/Unsupported fPort 1/);
    expect(up(2, '0D5C 0004').errors?.[0]).toMatch(/too short/);
  });

  it('does not leak globals', () => {
    up(7, '0D5C 0FB1');
    up(3, '0000 0D10 0000 40 6788DB63');
    expect('data_sum' in globalThis).toBe(false);
  });
});

/**
 * Real uplinks from a PS-LS-I4 (firmware EU868 v1.2) captured in ChirpStack v4, with the `object` that Dragino's
 * PS-LB_v1.2.7 decoder produced for each. Device identifiers are omitted.
 */
const CAPTURED: { payload: string; dragino: Record<string, unknown> }[] = [
  { payload: '0d5c00000fb1000000', dragino: { Bat_V: 3.42, Probe_mod: '0000', IDC_intput_mA: 4.017, Water_deep_cm: 0 } },
  { payload: '0d6200000fb1000000', dragino: { Bat_V: 3.426, Probe_mod: '0000', IDC_intput_mA: 4.017, Water_deep_cm: 0 } },
  { payload: '0d6200000fb0000000', dragino: { Bat_V: 3.426, Probe_mod: '0000', IDC_intput_mA: 4.016, Water_deep_cm: 0 } },
  { payload: '0d6200040fb0000000', dragino: { Bat_V: 3.426, Probe_mod: '0004', IDC_intput_mA: 4.016, Water_deep_cm: 0.4 } },
  { payload: '0d6200040faf000000', dragino: { Bat_V: 3.426, Probe_mod: '0004', IDC_intput_mA: 4.015, Water_deep_cm: 0.375 } },
  { payload: '0d6200040fad000000', dragino: { Bat_V: 3.426, Probe_mod: '0004', IDC_intput_mA: 4.013, Water_deep_cm: 0.325 } },
  { payload: '0d620004110b000000', dragino: { Bat_V: 3.426, Probe_mod: '0004', IDC_intput_mA: 4.363, Water_deep_cm: 9.075 } },
];
const COMMON = {
  Node_type: 'PS-LB', VDC_intput_V: 0, Exti_pin_level: 'Low', Exti_status: 'False', IN1_pin_level: 'Low',
  IN2_pin_level: 'Low', IDC_Roc_flagH: 'FALSE', IDC_Roc_flagL: 'FALSE', VDC_Roc_flagH: 'FALSE', VDC_Roc_flagL: 'FALSE',
};

describe('captured ChirpStack uplinks', () => {
  for (const { payload, dragino } of CAPTURED) {
    it(`returns the same Dragino fields for ${payload}`, () => {
      const data = up(2, payload).data!;
      const expected = { ...COMMON, ...dragino };
      for (const [k, v] of Object.entries(expected)) expect(data[k], k).toEqual(v);
    });
  }
});

describe('output of decoders/ps-lb.js as run by ChirpStack v4 (real uplink)', () => {
  it('matches the local decode exactly', () => {
    // Probe back in air after an immersion test; decoded in ChirpStack with this file, no calibration variables.
    const chirpstackObject = {
      Node_type: 'PS-LB', Bat_V: 3.426, Probe_mod: '0004', IDC_intput_mA: 4.005, VDC_intput_V: 0,
      IN1_pin_level: 'Low', IN2_pin_level: 'Low', Exti_pin_level: 'Low', Exti_status: 'False',
      IDC_Roc_flagL: 'FALSE', IDC_Roc_flagH: 'FALSE', VDC_Roc_flagL: 'FALSE', VDC_Roc_flagH: 'FALSE',
      Probe_fault: 'False', Water_deep_cm: 0.125, Water_deep_m: 0.001,
    };
    expect(up(2, '0d6200040fa5000000').data).toEqual(chirpstackObject);
  });
});

describe('calibration covers datalog entries', () => {
  it('port 3 uses the same correction as port 2', () => {
    const vars = { idc_gain: '0.994365', idc_offset_mA: '0.0066' };
    const live = up(2, '0D62 0004 2742 0000 00', vars).data!; // 10.050 mA raw
    const entry = (up(3, '0004 0000 2742 00 6788DB63', vars).data!.DATALOG2_entries as Record<string, unknown>[])[0];
    expect(entry.IDC_intput_mA).toBe(live.IDC_intput_mA);
    expect(entry.Water_deep_cm).toBe(live.Water_deep_cm);
    expect(entry.IDC_raw_mA).toBe(10.05);
    // Without calibration there is no IDC_raw_mA, as before.
    expect((up(3, '0004 0000 2742 00 6788DB63').data!.DATALOG2_entries as Record<string, unknown>[])[0]).not.toHaveProperty('IDC_raw_mA');
  });
});
