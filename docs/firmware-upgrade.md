# Firmware upgrades for -LB/-LS sensors

This web console does not upgrade firmware. -LB/-LS sensors such as the PS-LS-I4 **cannot be upgraded over their
own Bluetooth**. Dragino documents Bluetooth upgrades only for NB-IoT/LTE-M (-NB/-CB) models. The LB upgrade
screen in Devices.Tool v1.11.0 drives an LA66 adapter over USB and drops any Bluetooth connection before it starts.

## Supported routes

- **Over LoRa with an LA66 USB adapter:** <https://wiki.dragino.com/docs/LoRaWAN-Firmware-Update/lorawan-ota-upgrade-mode/>
  - Flash the LA66 with `OTA_DONGLE`. Connect it to a phone with a USB-C OTG adapter (using Devices.Tool) or
    to a PC (using the OTA tool).
  - The password is the last 8 bytes (16 hex characters) of the AppSKey, or the OTA password on the label. On an
    OTAA device the AppSKey is a session key, so it presumably changes at every join (an inference, not
    confirmed). Read it fresh from `AT+CFG` just before upgrading, or use the label's OTA password.
  - This only rewrites the application area (from `0x0800D000`), so a failed attempt can be retried after a reset.
- **Wired, with a USB-to-TTL adapter:** <https://wiki.dragino.com/docs/LoRaWAN-Firmware-Update/uart-ttl-upgrade-mode/>
  - Uses the Dragino Sensor Manager Utility or TremoProgrammer. Match the "with bootloader" or "without
    bootloader" file to the tool, or you can overwrite the bootloader.

## Choosing the file

The PS-LB firmware folder (linked from the PS-LB manual) has one folder per version and one `.bin` per band. For an
EU868 PS-LS-I4, use `PS-LB_v1.2.8/EU868.bin`.

- It is an application-only image: its vector table points into `0x0800Dxxx` and it carries a
  `dragino_6601_ota` marker. That is the form the OTA route expects.
- SHA-256 of the copy checked on 2026-11-03:
  `0129f8b2ffcebd4e51a1aff0f7829ee978acf059fea32f963897b0861f034a09`.

Changes since v1.2 that matter for a 4–20 mA immersion probe:
- 1.2.2: `AT+CALIBRATION`.
- 1.2.3: fix for `IDC_INPUT`/`VDC_INPUT` going out of range.
- 1.2.7: power output on-time maximum raised to 360 s.
- 1.2.8: `AT+2PCALIDC`/`AT+2PCALVDC`.

## Checklist

1. **Before:** on the settings tab, click **Back up settings…** and store the file privately. It contains the keys
   and the PIN.
2. Upgrade using one of the routes above.
3. **After:**
   - Reconnect and run `AT+VER=?`.
   - Click **Read from device** and compare the settings with the backup.
   - If anything was reset, log in, then paste the backup file into the terminal. It runs the restore commands and
     skips the `#` comments. (If the console is locked, a paste stops at the first `Incorrect Password`.)
   - Finish with `ATZ`.
4. `AT?` should now list `AT+2PCALIDC`, so the calibration wizard can write to the sensor.
