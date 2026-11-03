# Dragino Sensor Web Console

A browser tool for configuring Dragino LoRaWAN sensors over Bluetooth, using Web Bluetooth and the sensors' AT
commands. It targets the -LB/-LS family, starting with the PS-LB/PS-LS pressure and water-level sensors.

**Open the console: <https://claudobahn.github.io/dragino-sensor-web-console/>** (Chrome or Edge on a desktop
computer; nothing to install).

It has three tabs:

- **Terminal:** connect to the sensor's console on Bluetooth service `FFE0` / characteristic `FFE1`, log in with
  the AT PIN, and send any AT command. It keeps command history (↑/↓), runs pasted multi-line input one command at
  a time, offers quick-command buttons, and saves transcripts with the PIN and keys removed.
  - The console locks itself after under a minute without commands. If the PIN is entered in the connection bar,
    the tool logs in again by itself and retries the command.
  - If the console is locked and cannot log in again, a pasted block stops at the first `Incorrect Password`.
    Otherwise every remaining line would count as another wrong PIN attempt.
- **PS-LB/LS settings:** read all settings in one go (`AT?` to see what the firmware supports, then `AT+CFG`, with
  individual queries as fallback), edit uplink interval, probe model, probe power-on times and calibration, and
  write only what changed.
  - **Write changes** is enabled only after **Read from device** has completed on the current connection.
  - Each value is read back to confirm it. A write is only marked ✓ when the read-back matches. If a read-back
    fails, writing is disabled until the next **Read from device**.
  - Each setting shows the firmware's own description of the command (from `AT?`), and the equivalent LoRaWAN
    downlink, so you can make the same change over the air after deployment.
  - Limits that depend on the firmware (such as the probe power-on time) follow the `AT+VER` that was read.

  The tab also has:
  - a live current-to-depth readout for 4–20 mA immersion probes (PS-LS-I4 = 0–4 m),
  - a two-point calibration wizard. It writes `AT+2PCALIDC` on firmware 1.2.8 and later. On older firmware it gives
    the gain and offset for your payload decoder instead,
  - **Back up settings…** (see below).
- **Discovery:** a low-level GATT explorer, kept as a fallback for sensors that don't use FFE0/FFE1. It and the
  connection bar can't be connected at the same time. See [docs/ble-protocol.md](docs/ble-protocol.md).

Settings for each model live in data files under `src/profiles/` (`ps-lb.ts` today), so other Dragino -LB/-LS
models can be added as new profiles.

## Hardware status

Tested on a PS-LS-I4 with firmware `EU868 v1.2`. Details are in [docs/ble-protocol.md](docs/ble-protocol.md).
That firmware has no `AT+CALIBRATION` or `AT+2PCALIDC`. The settings tab detects this from `AT?` (or from an
`AT_ERROR` reply, if `AT?` can't be read), and the calibration wizard then gives a formula for your payload decoder
instead. **Read now** uses
`AT+GETSENSORVALUE=0`, which prints battery voltage, VDC input and probe current.

## Backups and firmware upgrades

**Back up settings…** on the settings tab saves `AT+CFG` as a text file. It doubles as a restore script: log in, then
paste it into the terminal, and it skips `#` comments and replays the settings. **The file is not redacted.** It
contains the LoRaWAN keys and the AT PIN, so keep it private.

[`decoders/ps-lb.js`](decoders/ps-lb.js) is a payload decoder for TTN v3 and ChirpStack v4. It is compatible with
Dragino's, and adds probe-fault detection, calibration and stricter parsing ([decoders/README.md](decoders/README.md)).
For which Dragino decoder to use, how it calculates depth, and the calibration patch, see
[docs/payload-decoder.md](docs/payload-decoder.md).

This tool does not upgrade firmware. -LB/-LS sensors can't be upgraded over Bluetooth. See
[docs/firmware-upgrade.md](docs/firmware-upgrade.md) for the LA66 (LoRa) and USB-to-TTL routes.

## Requirements

- Chrome or Edge on a desktop computer (Windows, macOS, Linux or ChromeOS). Firefox and Safari have no Web Bluetooth.
- The page must be served from `https://` or `http://localhost`.
- On Linux, Web Bluetooth may need `chrome://flags/#enable-experimental-web-platform-features` (not verified for
  this project).
- Optional: the same flag enables advertisement capture on the Discovery tab.

## Run it

```bash
npm install
```

```bash
npm run dev
```

Open the printed `http://localhost:5173` URL in Chrome.

```bash
npm test
```

```bash
npm run e2e
```

`npm run e2e` builds the app and runs it in headless Chromium against a simulated PS-LS-I4 (`e2e/fake-ble.js`),
covering login, settings, re-lock handling, PIN redaction, backup and restore, and the Discovery tab. It uses the
Playwright Chromium (`npx playwright install chromium` once).

```bash
npm run build
```

`npm run build` writes a static site to `dist/` that can be hosted anywhere with HTTPS.

`.github/workflows/pages.yml` runs the unit tests, builds the site, runs the end-to-end tests against that build,
and deploys it to GitHub Pages on every push to `main`. It needs Pages enabled in the repository settings, with
*GitHub Actions* as the source.

## Using the Discovery tab

1. Disconnect in the connection bar first. Discovery makes its own connection.
2. Wake the sensor's BLE with a short button press (1–3 s) or a reset. You then have **60 s** to connect.
3. Click **Scan & connect** and pick the device. Its name is the DevEUI.
4. Check the GATT tree. The pair marked *UART candidate* should be `FFE0` / `FFE1`.
5. In **Test console**, click **Open** and enter the AT PIN from the label. Click **Send PIN** and wait for
   `Correct Password` (the PS-LS-I4's wording), then try `AT+CFG`.
6. Optionally download the JSON report. It is useful when adding support for another sensor, and it is redacted
   as described below.

## What gets redacted

The JSON report and the saved transcript always remove:

- **the AT PIN**, including `AT+PWORD=…`, which changes it. Anything typed (or sent as hex) into a console that is
  not an `AT` command is treated as a possible PIN and hidden, even when the PIN field is empty,
- **LoRaWAN keys**: AppKey, NwkSKey, AppSKey, and the LoRaWAN 1.1 key names. These are caught in `AT+KEY=…`
  lines such as `AT+CFG` output, in the bare reply to a query like `AT+APPKEY=?`, and in any unlabelled 16-byte
  hex string.

The terminal's command history (kept in the browser) never stores the PIN or anything with a key in it.

DevEUI, AppEUI/JoinEUI and DevAddr are identifiers, not secrets. The DevEUI is broadcast as the BLE name anyway.
They are kept unless you tick **Hide DevEUI/AppEUI/DevAddr in saved file** (terminal) or **Also hide DevEUI /
AppEUI / DevAddr** (Discovery report). Then they are also removed from status lines such as
`Connecting to <DevEUI>…`, and the Discovery report hides characteristic values that contain the device name and the raw
advertisement data.

The on-screen console and the event log show unredacted traffic and are never exported. Check the report before
posting it publicly anyway.

## License

[MIT](LICENSE) © 2026 claudobahn.
