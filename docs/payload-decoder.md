# Payload decoder notes (PS-LB/LS)

Dragino's decoders: <https://github.com/dragino/dragino-end-node-decoder/tree/main/PS-LB>

## Which file

This project's own decoder, [`decoders/ps-lb.js`](../decoders/ps-lb.js), is compatible with Dragino's 1.2.7
decoder and fixes the issues below. See [decoders/README.md](../decoders/README.md). If you use Dragino's files:

**Use `PS-LB_v1.2.7_decoder.txt`** for any v1.2.x firmware, including v1.2:
- The port 2, 5 and 7 layouts are unchanged since v1.2.
- Its additions (port 8, the pulse count) only apply to uplinks newer firmware sends.
- It defines `decodeUplink(input)`, which both TTN v3 and ChirpStack v4 call, so it runs on either as-is.

| File | Notes |
|---|---|
| `PS-LB_v1.2.7_decoder.txt` | Current. Ports 2, 3 (datalog), 5, 7 and 8 (`Mul_tdcdata`), the pulse count on 13-byte uplinks, and the report-on-change flags. |
| `PS-LB_v1.2_decoder.txt` | The same without port 8 and the pulse count. |
| `PS LB Chirpstack V4 decoder.txt` | **The old v1.0/v1.1 decoder** with a ChirpStack-style wrapper, despite its name. Avoid it. |
| `PS LB_TTN_V1.1_Decoder.txt` | The same old decoder with a TTN-style wrapper. |

Shortcomings of the old (V4 / V1.1) decoders:
- No port 3 handling. Datalog uplinks (`AT+PNACKMD=1`) fall into the port 2 branch and decode as nonsense, and so
  would port 8.
- No report-on-change flags (`IDC_Roc_flagL/H`, `VDC_Roc_flagL/H`), which you need for `AT+ROC` alarms.
- `Probe_mod` is a number taken from the first byte only, not the `"0004"` string.
- A 1-byte uplink returns nothing.

Common to all of them:
- The depth formula is the same in every file.
- Ports 3, 7 and 8 build their output in an undeclared global (`data_sum`). TTN and ChirpStack accept that, but a
  strict-mode engine would throw.
- For pressure probe types 1–9, the v1.2+ decoders label as `Water_pressure_kPa` the same numbers the old decoder
  labels `Water_pressure_MPa`. Type A gives 0.6 at 20 mA, which suggests MPa is the correct unit and the kPa label
  is wrong. This does not affect depth.

## How depth is calculated

The sensor sends raw current (bytes 4–5, in µA) and the `AT+PROBE` code (bytes 2–3). The decoder computes depth
from those, not the firmware:

```js
Water_deep_cm = IDC_intput_mA <= 4.0 ? 0 : (IDC_intput_mA - 4.0) * (range_m * 100 / 16)
```

- For an I4 probe (`AT+PROBE=0004`), that is 25 cm per mA above 4 mA.
- With `AT+PROBE=0000`, as shipped, the range is 0, so depth is always 0.
- The console's depth readout shows the same centimetre value (`draginoDepthCm` in `src/profiles/ps-lb-decoder.ts`).

## Calibration on firmware without AT+2PCALIDC

The calibration wizard gives a gain and an offset. In `PS-LB_v1.2.7_decoder.txt` or `PS-LB_v1.2_decoder.txt` (default / port 2 branch), replace:

```js
var IDC_intput_mA = (bytes[4]<<8 | bytes[5])/1000;
```

with the three lines the wizard generates:

```js
var IDC_raw_mA = (bytes[4]<<8 | bytes[5])/1000;
var IDC_intput_mA = parseFloat((GAIN * IDC_raw_mA + (OFFSET)).toFixed(3)); // two-point calibration
data.IDC_raw_mA = IDC_raw_mA;
```

`IDC_intput_mA` and `Water_deep_cm` then use the corrected current, and the raw value is kept as `IDC_raw_mA`.

- In the old decoders the line is `decode.IDC_intput_mA= (bytes[4]<<8 | bytes[5])/1000;`. Apply the same
  `GAIN * x + OFFSET` there.
- This patch does not correct port 3 datalog entries (`datalog2`). Datalog is off unless `AT+PNACKMD=1`.
- With `decoders/ps-lb.js`, set the `idc_gain` / `idc_offset_mA` device variables (ChirpStack) or `IDC_CALIBRATION`
  (TTN) instead of editing code. That decoder also corrects datalog entries.
