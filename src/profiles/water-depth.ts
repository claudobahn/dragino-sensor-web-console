/**
 * Maths for 4–20 mA immersion (water level) probes such as the PS-LB/LS-Ixx.
 *
 * A probe with range R metres outputs 4 mA at 0 m and 20 mA at R m (linear).
 * AT+PROBE=00bb selects "water depth" with bb = range in metres (hex): I4 → 0004.
 */

export const MA_MIN = 4;
/**
 * Outside this band a 4–20 mA loop is open, unpowered or faulty (NAMUR NE43). decoders/ps-lb.js uses the same values
 * (a test keeps them in sync).
 */
export const FAULT_LOW_MA = 3.6;
export const FAULT_HIGH_MA = 21.0;
export const MA_SPAN = 16;

export function depthFromMa(ma: number, rangeM: number): number {
  return ((ma - MA_MIN) / MA_SPAN) * rangeM;
}

export function maFromDepth(depthM: number, rangeM: number): number {
  return MA_MIN + (depthM / rangeM) * MA_SPAN;
}

export interface ProbeInfo {
  kind: 'unset' | 'water-depth' | 'pressure' | 'differential' | 'unknown';
  /** For water-depth probes: range in metres. */
  rangeM?: number;
  /** For pressure / differential: the type code byte. */
  code?: number;
  text: string;
}

const PRESSURE_TYPES = 'ABCDEFGHIJKL';
const DIFF_TYPES = ['0–100 Pa', '0–200 Pa', '0–300 Pa', '0–1 kPa', '0–2 kPa', '0–3 kPa', '0–4 kPa', '0–5 kPa', '0–10 kPa', '±100 Pa', '±200 Pa', '±1 kPa'];

/** Decode an AT+PROBE value ("0004", "4", "0x0004"). */
export function decodeProbe(raw: string): ProbeInfo {
  const s = raw.trim().replace(/^0x/i, '');
  if (!/^[0-9a-f]{1,4}$/i.test(s)) return { kind: 'unknown', text: `unrecognised value "${raw}"` };
  const v = parseInt(s, 16);
  const aa = v >> 8;
  const bb = v & 0xff;
  if (v === 0) return { kind: 'unset', text: 'not set (the decoder will report depth as 0)' };
  if (aa === 0) return { kind: 'water-depth', rangeM: bb, text: `water depth, 0–${bb} m immersion probe` };
  if (aa === 1) {
    const t = PRESSURE_TYPES[bb - 1];
    return { kind: 'pressure', code: bb, text: t ? `pressure probe, type ${t}` : `pressure probe, code ${bb}` };
  }
  if (aa === 2) {
    const t = DIFF_TYPES[bb - 1];
    return { kind: 'differential', code: bb, text: t ? `differential pressure, ${t}` : `differential, code ${bb}` };
  }
  return { kind: 'unknown', text: `unknown probe class 0x${aa.toString(16)}` };
}

/**
 * Two-point current calibration for AT+2PCALIDC=R1,S1,R2,S2 (µA).
 * R = the current the probe *should* output at a known depth, S = what the sensor actually reported there.
 * Raw readings must be taken with calibration cleared (AT+2PCALIDC=0,0,0,0 and AT+CALIBRATION=1000,1000).
 */
export interface CalPoint {
  depthM: number;
  measuredMa: number;
}

export interface TwoPointCal {
  r1: number;
  s1: number;
  r2: number;
  s2: number;
  command: string;
  /** Gain and offset the firmware will apply (corrected = gain * raw + offset), for display. */
  gain: number;
  offsetUa: number;
}

export function twoPointCalibration(a: CalPoint, b: CalPoint, rangeM: number): TwoPointCal {
  if (!(rangeM > 0)) throw new RangeError('Probe range must be positive');
  const ua = (ma: number) => Math.round(ma * 1000);
  const r1 = ua(maFromDepth(a.depthM, rangeM));
  const r2 = ua(maFromDepth(b.depthM, rangeM));
  const s1 = ua(a.measuredMa);
  const s2 = ua(b.measuredMa);
  for (const [name, v] of [['R1', r1], ['S1', s1], ['R2', r2], ['S2', s2]] as const) {
    if (v < 0 || v > 65535) throw new RangeError(`${name} = ${v} µA is outside 0–65535`);
  }
  if (s1 === s2) throw new RangeError('The two measured currents must differ');
  if (r1 === r2) throw new RangeError('The two reference depths must differ');
  const gain = (r2 - r1) / (s2 - s1);
  const offsetUa = r1 - gain * s1;
  return { r1, s1, r2, s2, command: `AT+2PCALIDC=${r1},${s1},${r2},${s2}`, gain, offsetUa };
}
