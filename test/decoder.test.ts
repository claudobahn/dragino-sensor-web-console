import { describe, expect, it } from 'vitest';
import { decoderCalibrationPatch, draginoDepthCm } from '../src/profiles/ps-lb-decoder';

describe("Dragino PS-LB decoder compatibility", () => {
  it('matches the decoder depth formula for an I4 probe', () => {
    expect(draginoDepthCm(4.017, 4)).toBe(0.425); // (4.017-4) * 25
    expect(draginoDepthCm(12, 4)).toBe(200);
    expect(draginoDepthCm(3.9, 4)).toBe(0); // clamped
    expect(draginoDepthCm(12, 0)).toBe(0); // PROBE=0000
  });

  it('produces a patch that evaluates like the decoder', () => {
    const patch = decoderCalibrationPatch(1.01, -0.05);
    const bytes = [0, 0, 0, 4, 0x2f, 0xa8]; // 12.200 mA raw
    const data: Record<string, number> = {};
    // eslint-disable-next-line no-new-func
    const run = new Function('bytes', 'data', `${patch}\nreturn IDC_intput_mA;`);
    expect(run(bytes, data)).toBeCloseTo(1.01 * 12.2 - 0.05, 3);
    expect(data.IDC_raw_mA).toBe(12.2);
  });
});
