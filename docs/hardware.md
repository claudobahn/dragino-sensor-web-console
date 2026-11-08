# PS-LB / PS-LS hardware notes

Observed on a PS-LS-I4 (solar model) with an SIB v1.3 main board and firmware `EU868 v1.2`, unless noted.

## Screw terminal (JP3)

From the pin-mapping figure in Dragino's PS-LB/LS manual (drawn for SIB v1.2; the v1.3 board uses the same
layout, and the manual only notes that the interrupt pin is now called GPIO_EXTI):

| Pin | Function | Pin | Function |
|---|---|---|---|
| 1 | +3V3_OUT | 7 | IDC_IN (4–20 mA input) |
| 2 | +5V_OUT | 8 | VDC_IN (0–30 V input) |
| 3 | GND | 9 | SDI-12_DATA |
| 4 | INT | 10 | +12V_OUT |
| 5 | IN1 | 11 | GND |
| 6 | IN2 | | |

**4–20 mA immersion probe (e.g. I4):** red wire (V+) to pin 10 (+12V_OUT), blue wire (V−) to pin 7 (IDC_IN). The
12 V output only switches on while the probe is sampled, for `AT+12VT` ms (shipped as 500).

`VDC_IN` measures 0–30 V with 1 mV resolution and ±0.02 V accuracy, according to the manual. Its input resistance
is not documented.

## Power on the PS-LS (solar model)

The PS-LS has a 3000 mAh rechargeable Li-ion battery and a solar panel. A small charger board sits between them
and the main board, with three connectors: solar, battery and load. The main board runs from the **load** output,
which is regulated.

Measured with a multimeter in sun, while the sensor reported `Bat_V` 3.420–3.426 V:

| Point | Voltage |
|---|---|
| Solar panel (while charging) | 4.46 V |
| Battery | 4.07 V |
| Load (main board supply) | 3.46 V |

So on the PS-LS:

- **`Bat_V` (port 2), `BAT` (port 5) and `Bat_voltage` in `AT+GETSENSORVALUE` are the regulated supply, not the
  battery.** They stay flat at about 3.42 V while the battery charges or discharges. ChirpStack's device-status
  battery level is derived from the same value, so it says nothing about the battery either.
- They only drop once the battery is nearly empty (around 3.5–3.6 V) and the regulator can no longer hold its
  output. A sustained drop below about 3.41 V is therefore a late low-battery warning.

## Optional upgrade: report the real battery voltage

Wire the battery voltage to `VDC_IN` (pin 8); `VDC_intput_V` in every uplink then reports the battery. The charger
board has an empty socket wired in parallel with the battery connector, which makes this easy:

1. Make a lead that fits the spare socket. **Check its polarity with a multimeter before connecting anything**:
   the plug can fit either way round on some leads, and wire colours are not a guarantee.
2. Check with the multimeter's continuity mode that the battery's negative terminal is connected to the main
   board's GND (pin 3 or 11). Only then connect the negative wire to GND; the positive wire goes to pin 8 (VDC_IN).
3. Confirm the next uplink: `VDC_intput_V` should match the multimeter's battery reading within a few hundredths of
   a volt. The first uplink after the change reported 4.044 V against 4.07 V measured on the battery a couple of
   hours earlier.

Since the input's resistance is not documented, it draws an unknown small current from the battery. A typical
divider draws tens of µA (about 1 mAh a day), which is negligible against 3000 mAh; measure it if in doubt.

For dashboards: graph and alert on `VDC_intput_V` (Li-ion: about 4.2 V full, below about 3.5 V nearly empty), and
keep `Bat_V` only as the last-resort alarm described above. Uplinks from before the change report
`VDC_intput_V: 0`.
