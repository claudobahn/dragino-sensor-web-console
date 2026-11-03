/**
 * Helpers that match Dragino's PS-LB payload decoder
 * (https://github.com/dragino/dragino-end-node-decoder/tree/main/PS-LB, file PS-LB_v1.2_decoder.txt).
 *
 * The sensor sends raw current plus the AT+PROBE code. The decoder, not the firmware, computes depth:
 *   Water_deep_cm = IDC_intput_mA <= 4 ? 0 : (IDC_intput_mA - 4) * (range_m * 100 / 16)
 */

/** Depth exactly as Dragino's decoder reports it (cm, 3 decimals, clamped to 0 at or below 4 mA). */
export function draginoDepthCm(ma: number, rangeM: number): number {
  if (ma <= 4.0) return 0;
  return Number(((ma - 4.0) * ((rangeM * 100) / 16)).toFixed(3));
}

/** The line in Dragino's decoder that reads the current (default / port 2 branch). */
export const DECODER_CURRENT_LINE = 'var IDC_intput_mA = (bytes[4]<<8 | bytes[5])/1000;';

/**
 * Replacement for DECODER_CURRENT_LINE that applies a linear calibration
 * (corrected = gain × raw + offset), the same correction AT+2PCALIDC would apply on firmware ≥ 1.2.8.
 * Water_deep_cm and IDC_intput_mA then use the corrected value. The raw value is kept as IDC_raw_mA.
 */
export function decoderCalibrationPatch(gain: number, offsetMa: number): string {
  const g = gain.toFixed(6);
  const o = offsetMa.toFixed(4);
  return [
    `var IDC_raw_mA = (bytes[4]<<8 | bytes[5])/1000;`,
    `var IDC_intput_mA = parseFloat((${g} * IDC_raw_mA + (${o})).toFixed(3)); // two-point calibration`,
    `data.IDC_raw_mA = IDC_raw_mA;`,
  ].join('\n');
}
