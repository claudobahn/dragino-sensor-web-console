# Payload decoders

## `ps-lb.js`: Dragino PS-LB / PS-LS

A decoder for The Things Stack (TTN v3) and ChirpStack v4. It produces the same field names and string values as
Dragino's `PS-LB_v1.2.7_decoder.txt`, so existing dashboards keep working, and adds:

- **Fault detection:** `Probe_fault` (`"True"`/`"False"`) plus a warning when the current is outside 3.6–21 mA. An
  open or unpowered probe no longer looks like an empty tank (`Water_deep_cm: 0`).
- **Signed current and voltage:** a negative reading decodes as negative, not about 65.5 mA.
- **Calibration:** `corrected = gain × raw + offset`, applied before depth is calculated, to live readings (port 2)
  and datalog entries (port 3). The raw value is kept as `IDC_raw_mA`. Port 7/8 samples stay raw, because the uplink
  doesn't say whether they are current or voltage.
- **Validation:** explicit ports 2, 3, 5, 7 and 8 with length checks. Anything else returns `errors` instead of a
  bogus reading.
- **Datalog (port 3):** empty records and trailing partial bytes are skipped, and times are UTC instead of server
  local time.
- **Structured extras:** `Water_deep_m`, `DATALOG2_entries`, `DATALOG_values`, `Mul_tdcdata_values`.
- **No undeclared globals.**

- **Tested:** confirmed running in ChirpStack v4 on a Dragino LPS8v2 (2026-11-03). Tested against real ChirpStack
  captures from a PS-LS-I4 (see `test/decoder-ps-lb.test.ts`).
- **Format:** plain ES5, and checked to parse as ES5.
- **License:** MIT. The SPDX header at the top keeps the notice with pasted copies.
- **Updating:** after updating the file, paste it into the device profile again.

### ChirpStack v4

1. Device profiles → your PS-LB profile → **Codec** → *JavaScript functions*.
2. Paste the contents of `ps-lb.js` and save.
3. Optional calibration: Devices → your sensor → **Configuration** → *Variables*. Add `idc_gain` and
   `idc_offset_mA` with the values from the console's calibration wizard. Variables are per device, so one profile
   can serve several sensors.

### The Things Stack (TTN v3)

1. End device (or application) → **Payload formatters** → *Uplink* → *Custom Javascript formatter*.
2. Paste the contents of `ps-lb.js`.
3. Optional calibration: TTN has no device variables. Edit `IDC_CALIBRATION` at the top of the file, and use a
   device-level formatter if sensors need different values.

### Output differences from Dragino's decoder

| Field | Dragino 1.2.7 | `ps-lb.js` |
|---|---|---|
| `Water_deep_cm` with a 0 mA reading | `0` | `0`, plus `Probe_fault: "True"` and a warning |
| Negative current, e.g. `0xFFF6` | `65.526` mA, depth about 1538 cm | `-0.01` mA, depth 0, fault |
| Unknown port | Decoded as a reading | `errors: ["Unsupported fPort …"]` |
| `DATALOG2` times | Server local time | UTC (same format) |
| Port 3 "no data" record | One 1970 entry | Empty |

The pressure probe fields (`Water_pressure_kPa`) keep Dragino's factors and name, although for types 1–9 the
values look like MPa.
