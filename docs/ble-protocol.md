# Dragino -LB/-LS BLE console: what we know

Status: **confirmed on a PS-LS-I4 (firmware `EU868 v1.2`) on 2026-11-03.**

## From the Dragino wiki

Source: <https://wiki.dragino.com/docs/LoRaWAN-General-Configuration/ble-configuration/>

- Every model ending in -LB, -LS, -NB, -NS, -CB, -CS, -KN or -KS has the same BLE console.
- BLE switches on only after one of these:
  - a power-on or reset,
  - a short button press (1–3 s, which also sends an uplink),
  - the long-press activation.
- BLE switches off again after **60 s** with no connection.
- The advertised name is the device's **DevEUI**.
- You unlock the console by sending the **AT PIN** printed on the label (2–8 characters, per `AT+PWORD` help; usually 6). The device answers `Password Correct` or `Incorrect Password`. After that it behaves like the sensor's UART AT console.

## From Dragino's Devices.Tool app

Dragino's Android app (v1.11.0) was the source for the console's Bluetooth layout before it was confirmed on a
device. Two details from it are still relevant:

- It also tries service `FF00` / characteristic `FF01`, so this tool falls back to that pair when `FFE0`/`FFE1` is
  missing.
- It checks for the reply `Password Correct`, while the PS-LS-I4 replies `Correct Password`, so both wordings are
  accepted.

## Confirmed on a PS-LS-I4

**BLE module:** DX-smart DX-BT24, module firmware `+VERSION=V2.1.0`. The module's Device Information service
(0x180A) is readable.

**GATT layout:**
- Service `FFE0`:
  - `FFE1` ("TX & RX"): read, write, write-without-response, notify. This is the console.
  - `FFE2` ("TX"): write and write-without-response only.

**Behaviour:**
- 20-byte chunks with a 20 ms gap, ending in CR LF, work.
- **PIN reply wording:** a correct PIN gets `Correct Password`. Devices.Tool checks for `Password Correct`, so both
  orders are accepted.
- **The console locks itself again after inactivity, even while connected.** After about 54 s without commands,
  `AT+PROBE=0004` got `Incorrect Password` and was not applied. A locked console treats every line as a PIN attempt.
  The tool detects this, logs in again with the PIN in memory, and retries the command once. The exact timeout is
  unknown, somewhere under 54 s.
- **The console stays unlocked after Bluetooth disconnects.** Sending the PIN to an already unlocked console
  gets a blank line and `AT_ERROR`, because it is treated as an unknown command. The tool then checks with
  `AT+VER=?` and treats an `OK` as unlocked.
- **Query replies** (`AT+TDC=?`): the value, then a blank line, then `OK`.
- **`AT?`** prints one `AT+CMD: description` line per command over about 4 s, then `OK`. On v1.2 the list does not
  include `AT+CALIBRATION`, `AT+2PCALIDC`, `AT+MAPPING`, `AT+COUNTMOD` or `AT+MULTDCDATA`, so the tool checks
  `AT?` before offering a setting. An unknown command answers `AT_ERROR`, which the tool also treats as
  "not supported". The settings tab shows each command's description next to the setting.
- **`AT+CFG`** prints `Stop Tx events,Please wait for all configurations to print`, then one `AT+KEY=value` line
  per setting, then `Start Tx events`, then `OK`. That output includes **AppKey, AppSKey, NwkSKey and
  `AT+PWORD`, which is the PIN itself**.
- **`AT+GETSENSORVALUE=0`** takes about 2 s (the probe is powered and sampled). Then it prints:
  ```
  Bat_voltage:3.426 V
  VDC_Input:0.000 V
  IDC_Input:4.018 mA
  GPIO_EXTI:0
  IN1:0
  IN2:0

  OK
  ```
  4.018 mA with the probe in air is about 0 m on a 0–4 m probe.
- **Long output arrives in bursts** about 250–300 ms apart, which can split a line (`…window freq` / `uency`).
  The tool waits 1 s before treating unterminated text as a line.
- **`AT?` help lines use `AT+CMD: description`.** Redaction leaves those descriptions alone and only redacts values.

**As shipped:**

| Setting | Value | Meaning |
|---|---|---|
| `AT+PROBE` | `0000` | Not set; `0004` is right for a 0–4 m I4 probe |
| `AT+12VT` | `500` | The 4–20 mA probe is powered from the 12 V output |
| `AT+5VT`, `AT+3V3T` | `0` | |
| `AT+TDC` | `1200000` | 20 min |
| `AT+INTMOD` | `2` | Interrupt on falling edge |

**Bluetooth idle timer:** the 60 s switch-off only applies while nothing is connected. A connection stayed up for
over 3 minutes without being dropped. While connected, only the console re-lock above applies.

## Still to verify

- [ ] The exact console re-lock timeout (under 54 s).
- [ ] Whether repeated wrong PINs lock the console out.
