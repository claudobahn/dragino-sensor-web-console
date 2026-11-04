/**
 * PS-LB / PS-LS (LoRaWAN pressure / water level sensor) profile.
 * Source: https://wiki.dragino.com/docs/LoRaWAN-End-Node/flow-pressure-weight-sensors/ps-lb-ps-ls/
 */
import { parseIntList, safeDownlink, uintHex } from './encode';
import type { DeviceContext, DeviceProfile, SettingDef } from './types';
import { decodeProbe } from './water-depth';

const intRange = (min: number, max: number) => (raw: string) => {
  if (!/^\d+$/.test(raw.trim())) return 'Must be a whole number';
  const n = Number(raw);
  return n < min || n > max ? `Must be between ${min} and ${max}` : null;
};

/** "EU868 v1.2" → [1, 2, 0]; "v1.2.8 EU868" → [1, 2, 8]. Undefined if no version is found. */
export function parseFirmwareVersion(ver?: string): [number, number, number] | undefined {
  // Prefer an explicit "v1.2.8"; fall back to the first bare number pair.
  const m = /\bv(\d+)\.(\d+)(?:\.(\d+))?/i.exec(ver ?? '') ?? /(\d+)\.(\d+)(?:\.(\d+))?/.exec(ver ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : undefined;
}

const atLeast = (v: [number, number, number], min: [number, number, number]) => {
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i];
  return true;
};

/**
 * Maximum on-time for AT+3V3T/5VT/12VT by firmware (Dragino changelog): 65535 ms before v1.2, 180 s from v1.2,
 * 360 s from v1.2.7. Unknown firmware gets the newest limit.
 */
export function maxPowerOnMs(ctx?: DeviceContext): number {
  const v = parseFirmwareVersion(ctx?.firmware);
  if (!v || atLeast(v, [1, 2, 7])) return 360000;
  return atLeast(v, [1, 2, 0]) ? 180000 : 65535;
}

const POWER_HELP = 'Max 360000 ms from firmware 1.2.7, 180000 ms on 1.2–1.2.6, 65535 ms before 1.2.';

function powerOutput(cmd: string, label: string, channel: number, help: string): SettingDef {
  return {
    cmd,
    label,
    help,
    kind: 'number',
    unit: 'ms',
    min: 0,
    max: 360000,
    step: 100,
    validate: (raw, ctx) => intRange(0, maxPowerOnMs(ctx))(raw),
    maxFor: maxPowerOnMs,
    downlink: (raw) => safeDownlink(() => `07${uintHex(channel, 1)}${uintHex(Number(raw), 3)}`),
  };
}

const TDC: SettingDef = {
  cmd: 'TDC',
  label: 'Uplink interval',
  help: 'How often the sensor samples and sends an uplink. Shorter intervals use more battery and airtime, so respect your network\'s fair-use limits.',
  kind: 'number',
  unit: 'min',
  min: 0.5,
  step: 0.5,
  // Up to 4 decimals (1.2333 min for 74 s); fromDisplay rounds back to the same whole second.
  toDisplay: (raw) => String(Number((Number(raw) / 60000).toFixed(4))),
  // Whole seconds only: the TDC downlink encodes seconds, so AT value and downlink must agree.
  fromDisplay: (d) => String(Math.round(Number(d) * 60) * 1000),
  validate: (raw) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 30000) return 'Must be at least 0.5 min';
    if (n % 1000 !== 0) return 'Must be a whole number of seconds';
    if (n / 1000 >= 2 ** 24) return 'Too large';
    return null;
  },
  describe: (raw) => {
    const s = Number(raw) / 1000;
    return Number.isFinite(s) ? `${raw} ms = ${s >= 3600 ? `${(s / 3600).toFixed(2)} h` : `${(s / 60).toFixed(1)} min`}` : undefined;
  },
  downlink: (raw) => safeDownlink(() => `01${uintHex(Math.round(Number(raw) / 1000), 3)}`),
};

const PROBE: SettingDef = {
  cmd: 'PROBE',
  label: 'Probe model',
  help: 'Sent in every uplink so the payload decoder knows how to turn current into depth or pressure. The sensor itself only measures current. For immersion probes it is 00 followed by the range in metres in hex (I4 → 0004). With 0000, Dragino\'s decoder reports a depth of 0.',
  kind: 'text',
  validate: (raw) => (/^[0-9a-f]{4}$/i.test(raw.trim()) ? null : 'Four hex digits, e.g. 0004'),
  toDisplay: (raw) => raw.trim().replace(/^0x/i, '').padStart(4, '0').toUpperCase(),
  // "4" or "0x4" means 0004, as the field displays it; anything else is left for validate() to reject.
  fromDisplay: (d) => {
    const t = d.trim().replace(/^0x/i, '').toUpperCase();
    return /^[0-9A-F]{1,3}$/.test(t) ? t.padStart(4, '0') : t;
  },
  describe: (raw) => {
    const p = decodeProbe(raw);
    return p.kind === 'unset' ? `${p.text}. For a PS-LS-I4 (0–4 m) enter 0004.` : p.text;
  },
  downlink: (raw) => safeDownlink(() => `08${uintHex(parseInt(raw, 16), 2)}`),
};

const CALIBRATION: SettingDef = {
  cmd: 'CALIBRATION',
  label: 'Linear scale factors',
  help: '"IDC,VDC" multipliers × 1000. 1000,1000 means no correction. Needs newer firmware (not in v1.2).',
  kind: 'text',
  validate: (raw) => {
    const v = parseIntList(raw, 2);
    if (!v) return 'Two whole numbers: IDC,VDC (e.g. 1000,1000)';
    return v.some((n) => n < 0 || n > 65535) ? 'Each must be 0–65535' : null;
  },
  describe: (raw) => {
    const v = parseIntList(raw, 2);
    return v ? `current ×${(v[0] / 1000).toFixed(3)}, voltage ×${(v[1] / 1000).toFixed(3)}` : undefined;
  },
  downlink: (raw) =>
    safeDownlink(() => {
      const v = parseIntList(raw, 2)!;
      return `0C${uintHex(v[0], 2)}${uintHex(v[1], 2)}`;
    }),
};

const PCAL_IDC: SettingDef = {
  cmd: '2PCALIDC',
  label: 'Two-point current calibration',
  help: 'R1,S1,R2,S2 in µA (R = reference current, S = raw reading). 0,0,0,0 = off. Use the wizard below to compute it. Needs firmware 1.2.8 or later.',
  kind: 'text',
  validate: (raw) => {
    const v = parseIntList(raw, 4);
    if (!v) return 'Four whole numbers: R1,S1,R2,S2';
    if (v.some((n) => n < 0 || n > 65535)) return 'Each must be 0–65535';
    if (v.every((n) => n === 0)) return null;
    if (v[1] === v[3]) return 'S1 and S2 must differ';
    return null;
  },
  describe: (raw) => {
    const v = parseIntList(raw, 4);
    if (!v) return undefined;
    if (v.every((n) => n === 0)) return 'off';
    const gain = (v[2] - v[0]) / (v[3] - v[1]);
    return `corrected = ${gain.toFixed(4)} × raw ${gain * -v[1] + v[0] >= 0 ? '+' : '−'} ${Math.abs(v[0] - gain * v[1]).toFixed(0)} µA`;
  },
  downlink: (raw) =>
    safeDownlink(() => {
      const v = parseIntList(raw, 4)!;
      return `0D01${v.map((n) => uintHex(n, 2)).join('')}`;
    }),
};

const info = (cmd: string, label: string, help?: string): SettingDef => ({ cmd, label, help, kind: 'text', readOnly: true });

export const PS_LB_PROFILE: DeviceProfile = {
  id: 'ps-lb',
  name: 'PS-LB / PS-LS pressure & water level',
  description: 'Settings for Dragino PS-LB/LS sensors with a 4–20 mA probe.',
  groups: [
    {
      title: 'Device',
      description: 'Read-only identity and LoRaWAN state. Change these in the terminal if you need to.',
      settings: [
        info('VER', 'Firmware / band'),
        info('DEUI', 'DevEUI'),
        info('APPEUI', 'AppEUI / JoinEUI'),
        info('NJM', 'Join mode', '1 = OTAA, 0 = ABP'),
        info('NJS', 'Joined', '1 = joined the network'),
        info('ADR', 'ADR'),
        info('DR', 'Data rate'),
        info('CLASS', 'Class'),
      ],
    },
    { title: 'Uplink', settings: [TDC] },
    {
      title: 'Probe',
      description:
        'The probe is only powered while it is being sampled. The output on-time is how long that power stays on before the reading, which gives the probe time to settle. On a PS-LS-I4 the 4–20 mA probe runs from the 12 V output (shipped as AT+12VT=500). Leave the other outputs at 0 unless something is wired to them.',
      settings: [
        PROBE,
        powerOutput('5VT', '5 V output on-time', 2, POWER_HELP),
        powerOutput('12VT', '12 V output on-time', 3, POWER_HELP),
        powerOutput('3V3T', '3.3 V output on-time', 1, POWER_HELP),
      ],
    },
    { title: 'Calibration', settings: [CALIBRATION, PCAL_IDC] },
  ],
  snippets: [
    { label: 'AT+CFG', command: 'AT+CFG', title: 'Print all settings (output includes keys)' },
    { label: 'AT+VER=?', command: 'AT+VER=?' },
    { label: 'AT+PROBE=?', command: 'AT+PROBE=?' },
    { label: 'AT+TDC=?', command: 'AT+TDC=?' },
    { label: 'AT+2PCALIDC=?', command: 'AT+2PCALIDC=?' },
    { label: 'AT+GETSENSORVALUE=0', command: 'AT+GETSENSORVALUE=0', title: 'Read battery, voltage input and probe current now' },
    { label: 'AT?', command: 'AT?', title: 'List the commands this firmware supports' },
    { label: 'AT+NJS=?', command: 'AT+NJS=?', title: 'Joined the LoRaWAN network? (1 = yes)' },
    { label: 'ATZ', command: 'ATZ', title: 'Reboot. This ends the BLE connection.' },
  ],
};

export interface SensorValues {
  batteryV?: number;
  vdcV?: number;
  idcMa?: number;
}

/**
 * Parse AT+GETSENSORVALUE=0 output. Firmware v1.2 prints:
 *   Bat_voltage:3.426 V / VDC_Input:0.000 V / IDC_Input:4.018 mA / GPIO_EXTI:0 / IN1:0 / IN2:0 / OK
 */
export function parseSensorValues(text: string): SensorValues {
  const num = (re: RegExp) => {
    const m = re.exec(text);
    return m ? Number(m[1]) : undefined;
  };
  return {
    batteryV: num(/Bat(?:_voltage|tery)?\s*[:=]\s*(\d+(?:\.\d+)?)/i),
    vdcV: num(/VDC(?:_Input|_IN)?\s*[:=]\s*(\d+(?:\.\d+)?)/i),
    idcMa: parseCurrentMa(text),
  };
}

/** Parse a current reading (mA) out of free-form sensor output, e.g. "IDC_IN:10.158mA" or "idc:10.158". */
export function parseCurrentMa(text: string): number | undefined {
  const m = /IDC(?:_IN)?[^0-9\n-]{0,12}(-?\d+(?:\.\d+)?)\s*(mA|uA|µA)?/i.exec(text);
  if (!m) return undefined;
  const v = Number(m[1]);
  const unit = m[2]?.toLowerCase();
  if (unit === 'ua' || unit === 'µa') return v / 1000;
  // Without a unit, a value above 30 is almost certainly µA.
  return !unit && v > 30 ? v / 1000 : v;
}
