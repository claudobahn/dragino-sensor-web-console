// SPDX-License-Identifier: MIT
// Copyright (c) 2026 claudobahn. https://github.com/claudobahn/dragino-sensor-web-console
/**
 * Payload decoder for Dragino PS-LB / PS-LS (LoRaWAN pressure / water level sensor).
 *
 * Works on The Things Stack (TTN v3) and ChirpStack v4: both call decodeUplink(input) and accept
 * { data, warnings, errors } (LoRa Alliance TS013 codec API). Written in ES5 for TTN's JavaScript engine.
 *
 * Output field names and string values match Dragino's PS-LB_v1.2.7 decoder, so existing dashboards keep
 * working. Changes from that decoder:
 *  - Explicit port 2 with a length check; unknown ports return an error instead of being decoded as readings.
 *  - Current and voltage are decoded as signed values (older firmware could send a negative current, which
 *    decoded as ~65.5 mA); a fault flag and warning are added for currents outside the 4–20 mA band.
 *  - Optional two-point calibration of the probe current (for firmware without AT+2PCALIDC).
 *  - No undeclared globals; empty datalog records are skipped; timestamps are UTC.
 *  - Additional structured fields alongside Dragino's string fields: Water_deep_m, Probe_fault,
 *    DATALOG2_entries, DATALOG_values, Mul_tdcdata_values, IDC_raw_mA (when calibrated).
 *
 * Calibration: corrected_mA = gain * raw_mA + offset_mA, applied to live readings (port 2) and datalog entries (port 3).
 * Port 7/8 samples are left raw: depending on AT+STDC / AT+MULTDCDATA they are current or voltage, which the uplink
 * does not say. Set the defaults below (TTN), or on ChirpStack v4 set
 * device variables "idc_gain" and "idc_offset_mA", which take precedence.
 *
 * Source: https://github.com/claudobahn/dragino-sensor-web-console (decoders/ps-lb.js)
 */

var IDC_CALIBRATION = { gain: 1, offset_mA: 0 };

/** Outside this band a 4–20 mA loop is open, unpowered or faulty (NAMUR NE43 uses 3.6 / 21 mA). */
var FAULT_LOW_MA = 3.6;
var FAULT_HIGH_MA = 21.0;

var FREQUENCY_BANDS = {
  0x01: 'EU868', 0x02: 'US915', 0x03: 'IN865', 0x04: 'AU915', 0x05: 'KZ865', 0x06: 'RU864', 0x07: 'AS923',
  0x08: 'AS923_1', 0x09: 'AS923_2', 0x0a: 'AS923_3', 0x0b: 'CN470', 0x0c: 'EU433', 0x0d: 'KR920', 0x0e: 'MA869',
  0x0f: 'AS923_4'
};

function u16(b, i) {
  return (b[i] << 8) | b[i + 1];
}

function s16(b, i) {
  var v = u16(b, i);
  return v >= 0x8000 ? v - 0x10000 : v;
}

function u32(b, i) {
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
}

function hex2(n) {
  return (n < 16 ? '0' : '') + n.toString(16);
}

function round3(x) {
  return parseFloat(x.toFixed(3));
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

/** "YYYY-MM-DD HH:MM:SS" in UTC (Dragino's format, but not dependent on the server's time zone). */
function utcString(unixSeconds) {
  var d = new Date(unixSeconds * 1000);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + ' ' +
    pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
}

function levelString(bit) {
  return bit ? 'High' : 'Low';
}

/** True when a calibration other than gain 1 / offset 0 is configured. */
function isCalibrated(cal) {
  return cal.gain !== 1 || cal.offset_mA !== 0;
}

/** Apply the two-point correction (callers skip it when !isCalibrated(cal)). */
function correct(rawMa, cal) {
  return round3(cal.gain * rawMa + cal.offset_mA);
}

function calibration(input) {
  var v = (input && input.variables) || {};
  var gain = parseFloat(v.idc_gain);
  var offset = parseFloat(v.idc_offset_mA);
  return {
    gain: isFinite(gain) ? gain : IDC_CALIBRATION.gain,
    offset_mA: isFinite(offset) ? offset : IDC_CALIBRATION.offset_mA
  };
}

/**
 * Convert probe current to a measurement, exactly as Dragino's decoder does (including clamping to 0 at or
 * below 4 mA). Returns undefined for unknown probe codes.
 */
function transform(mA, probeClass, code) {
  if (probeClass === 0x00) {
    return mA <= 4.0 ? 0 : round3((mA - 4.0) * (code * 100 / 16));
  }
  // Factors per probe type, copied from Dragino's decoder. [offset_mA, factor]
  var pressure = {
    1: [4, 0.0375], 2: [4, 0.0625], 3: [4, 0.1], 4: [4, 0.15625], 5: [4, 0.625], 6: [4, 2.5], 7: [4, 3.75],
    8: [4, -0.00625], 9: [12, 0.0125], 10: [4, 0.3125], 11: [4, 3.125], 12: [4, 6.25]
  };
  var differential = {
    1: [4, 6.25], 2: [4, 12.5], 3: [4, 18.75], 4: [4, 62.5], 5: [4, 125], 6: [4, 187.5], 7: [4, 250],
    8: [4, 312.5], 9: [4, 625], 10: [12, 12.5], 11: [12, 25], 12: [12, 125]
  };
  var table = probeClass === 0x01 ? pressure : probeClass === 0x02 ? differential : null;
  if (!table || !table[code]) return undefined;
  if (mA <= 4.0) return 0;
  return round3((mA - table[code][0]) * table[code][1]);
}

function decodeSensor(bytes, input, data, warnings) {
  var cal = calibration(input);
  var probeClass = bytes[2];
  var probeCode = bytes[3];
  var rawMa = s16(bytes, 4) / 1000;
  var calibrated = isCalibrated(cal);
  var mA = calibrated ? correct(rawMa, cal) : rawMa;
  if (calibrated) data.IDC_raw_mA = rawMa;
  var status = bytes[8];

  data.Node_type = 'PS-LB';
  data.Bat_V = u16(bytes, 0) / 1000;
  data.Probe_mod = hex2(probeClass) + hex2(probeCode);
  data.IDC_intput_mA = mA;
  data.VDC_intput_V = s16(bytes, 6) / 1000;
  data.IN1_pin_level = levelString(status & 0x08);
  data.IN2_pin_level = levelString(status & 0x04);
  data.Exti_pin_level = levelString(status & 0x02);
  data.Exti_status = status & 0x01 ? 'True' : 'False';
  data.IDC_Roc_flagL = status & 0x80 ? 'TRUE' : 'FALSE';
  data.IDC_Roc_flagH = status & 0x40 ? 'TRUE' : 'FALSE';
  data.VDC_Roc_flagL = status & 0x20 ? 'TRUE' : 'FALSE';
  data.VDC_Roc_flagH = status & 0x10 ? 'TRUE' : 'FALSE';

  var fault = mA < FAULT_LOW_MA || mA > FAULT_HIGH_MA;
  if (probeClass <= 0x02) {
    data.Probe_fault = fault ? 'True' : 'False';
    if (fault) {
      warnings.push('Probe current ' + mA + ' mA is outside ' + FAULT_LOW_MA + '–' + FAULT_HIGH_MA +
        ' mA: probe unpowered, disconnected or faulty');
    }
  }
  if (rawMa < 0) warnings.push('Negative current reading (' + rawMa + ' mA)');

  var value = transform(mA, probeClass, probeCode);
  if (probeClass === 0x00) {
    data.Water_deep_cm = value;
    data.Water_deep_m = round3(value / 100);
    if (probeCode === 0) warnings.push('AT+PROBE is 0000 (not set): depth is always 0. Set AT+PROBE=00xx (range in m).');
  } else if (probeClass === 0x01) {
    // Dragino's decoder labels this kPa; for types 1–9 the values look like MPa. Kept as-is for compatibility.
    data.Water_pressure_kPa = value;
  } else if (probeClass === 0x02) {
    data.Differential_pressure_Pa = value;
  }
  if (value === undefined && probeClass <= 0x02) warnings.push('Unknown probe code ' + data.Probe_mod);

  if (bytes.length >= 13) data.Pulse_counting = u32(bytes, 9);
}

function decodeStatus(bytes, data) {
  if (bytes[0] === 0x16) data.SENSOR_MODEL = 'PS-LB';
  data.FIRMWARE_VERSION = (bytes[1] & 0x0f) + '.' + ((bytes[2] >> 4) & 0x0f) + '.' + (bytes[2] & 0x0f);
  data.FREQUENCY_BAND = FREQUENCY_BANDS[bytes[3]];
  data.SUB_BAND = bytes[4] === 0xff ? 'NULL' : bytes[4];
  data.BAT = u16(bytes, 5) / 1000;
  data.Node_type = 'PS-LB';
}

function decodeDatalog(bytes, input, data) {
  var cal = calibration(input);
  var calibrated = isCalibrated(cal);
  var entries = [];
  var text = '';
  for (var i = 0; i + 11 <= bytes.length; i += 11) {
    var allZero = true;
    for (var k = 0; k < 11; k++) if (bytes[i + k] !== 0) allZero = false;
    if (allZero) continue; // "no stored data" placeholder

    var probe = hex2(bytes[i]) + hex2(bytes[i + 1]);
    var vdc = s16(bytes, i + 2) / 1000;
    var rawIdc = s16(bytes, i + 4) / 1000;
    var idc = calibrated ? correct(rawIdc, cal) : rawIdc; // same calibration as live (port 2) readings
    var flags = bytes[i + 6];
    var ts = u32(bytes, i + 7);
    var value = transform(idc, bytes[i], bytes[i + 1]);
    var e = {
      Probe_mod: probe,
      VDC_intput_V: vdc,
      IDC_intput_mA: idc,
      IN1_pin_level: levelString(flags & 0x08),
      IN2_pin_level: levelString(flags & 0x04),
      Exti_pin_level: levelString(flags & 0x02),
      Exti_status: flags & 0x01 ? 'True' : 'False',
      No_ACK: (flags >> 7) & 0x01 ? 'True' : 'False',
      Poll_message: (flags >> 6) & 0x01 ? 'True' : 'False',
      Unix_time: ts,
      Time: new Date(ts * 1000).toISOString()
    };
    if (calibrated) e.IDC_raw_mA = rawIdc;
    if (bytes[i] === 0x00) e.Water_deep_cm = value;
    entries.push(e);
    // Same text format as Dragino's DATALOG2 (times in UTC rather than server-local).
    text += '[' + probe + ',' + vdc + ',' + idc + ',' + e.IN1_pin_level + ',' + e.IN2_pin_level + ',' +
      e.Exti_pin_level + ',' + e.Exti_status + ',' + value + ',' + utcString(ts) + ']';
  }
  data.Node_type = 'PS-LB';
  data.DATALOG2 = text;
  data.PNACKMD = bytes.length > 6 && (bytes[6] >> 7) & 0x01 ? 'True' : 'False';
  data.DATALOG2_entries = entries;
}

/** Ports 7 (AT+STDC multi-sample) and 8 (AT+MULTDCDATA history): battery then 2-byte values in thousandths. */
function decodeSamples(bytes, data, textField, listField) {
  var values = [];
  var text = '';
  for (var i = 2; i + 2 <= bytes.length; i += 2) {
    var v = s16(bytes, i) / 1000;
    values.push(v);
    text += '[' + v.toFixed(3) + ']';
  }
  data.Node_type = 'PS-LB';
  data.Bat_V = u16(bytes, 0) / 1000;
  data[textField] = text;
  data[listField] = values;
}

function decodeUplink(input) {
  var bytes = input.bytes || [];
  var data = {};
  var warnings = [];
  var minLength = { 2: 9, 3: 0, 5: 7, 7: 2, 8: 2 };
  var port = input.fPort;

  if (!(port in minLength)) {
    return { errors: ['Unsupported fPort ' + port] };
  }
  if (bytes.length < minLength[port]) {
    return { errors: ['Payload too short for fPort ' + port + ': ' + bytes.length + ' bytes'] };
  }

  if (port === 2) decodeSensor(bytes, input, data, warnings);
  else if (port === 5) decodeStatus(bytes, data);
  else if (port === 3) decodeDatalog(bytes, input, data);
  else if (port === 7) decodeSamples(bytes, data, 'DATALOG', 'DATALOG_values');
  else if (port === 8) decodeSamples(bytes, data, 'Mul_tdcdata', 'Mul_tdcdata_values');

  var result = { data: data };
  if (warnings.length) result.warnings = warnings;
  return result;
}
