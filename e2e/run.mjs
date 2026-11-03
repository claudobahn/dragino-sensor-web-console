/**
 * End-to-end tests: the built app in headless Chromium against the simulated sensor in e2e/fake-ble.js.
 *
 *   npm run e2e            (builds, serves dist/ with vite preview, runs every scenario)
 *   npm run e2e -- relock  (only scenarios whose name contains "relock")
 *
 * Each scenario gets a fresh browser context, so the fake sensor starts from its default state.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const FAKE = readFileSync(new URL('./fake-ble.js', import.meta.url), 'utf8');
const PORT = 4179;
const BASE = `http://localhost:${PORT}/`;
const PIN = '123456';
const FAKE_KEY = '2B 7E 15 16';

// ------------------------------------------------------------------ helpers ----

async function openPage(browser) {
  const ctx = await browser.newContext({ acceptDownloads: true });
  await ctx.addInitScript({ content: FAKE });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(BASE);
  return { page, errors, close: () => ctx.close() };
}

const fake = (page, fn, arg) => page.evaluate(fn, arg);
const sent = (page) => fake(page, () => window.fakeBle.sent.slice());
const clearSent = (page) => fake(page, () => (window.fakeBle.sent.length = 0));

async function waitFor(page, fn, arg, timeout = 10000) {
  await page.waitForFunction(fn, arg, { timeout });
}
const text = (page, sel) => page.locator(sel).innerText();
const waitText = (page, sel, re, timeout) =>
  waitFor(page, ([s, src]) => new RegExp(src).test(document.querySelector(s)?.textContent ?? ''), [sel, re.source], timeout);

async function connect(page, pin = PIN) {
  await page.fill('#connPin', pin);
  await page.click('#connBtn');
  await waitText(page, '#connStatus', /unlocked/);
}

async function terminal(page, command) {
  await waitFor(page, () => !document.querySelector('#termSend').disabled, undefined, 20000);
  await page.fill('#termInput', command);
  await page.press('#termInput', 'Enter');
}

async function readSettings(page) {
  await page.click('[data-tab=config]');
  await page.click('#cfgRead');
  await waitText(page, '#cfgStatus', /Read complete|Read incomplete|Failed|locked/, 30000);
}

async function download(page, selector) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click(selector)]);
  return readFileSync(await dl.path(), 'utf8');
}

async function discoveryScan(page) {
  await page.click('[data-tab=discovery]');
  await page.click('#scanBtn');
  await waitText(page, '#status', /Connected:/);
}

// ---------------------------------------------------------------- scenarios ----

const scenarios = {
  async 'terminal: login, AT?, paste, redacted transcript'({ page }) {
    await connect(page);
    await terminal(page, 'AT?');
    await waitText(page, '#term', /GETSENSORVALUE: Get/);
    const t = await text(page, '#term');
    assert.match(t, /AT\+RX2FQ: Get or Set the Rx2 window frequency/, 'line split across bursts must be joined');
    assert.doesNotMatch(t, /\nuency/);
    await terminal(page, 'AT+CFG');
    await waitText(page, '#term', /AT\+APPKEY=2B/);
    await terminal(page, 'AT+TDC=?\nAT+BOGUS');
    await waitText(page, '#term', /AT_ERROR/);
    const saved = await download(page, '#termSave');
    assert.ok(!saved.includes(PIN), 'PIN in saved transcript');
    assert.ok(!saved.includes(FAKE_KEY), 'key in saved transcript');
  },

  async 'settings: read before write, write with read-back, phantom changes, limits'({ page }) {
    await connect(page);
    await page.click('[data-tab=config]');
    await page.fill('.setting:has-text("Uplink interval") input', '15');
    assert.ok(await page.locator('#cfgWrite').isDisabled(), 'Write must be disabled before a read');
    await fake(page, () => (window.fakeBle.state.TDC = '1200500')); // not a whole number of seconds
    await readSettings(page);
    assert.match(await text(page, '#cfgStatus'), /Read complete \(firmware EU868 v1\.2\)/);
    assert.match(await text(page, '.setting:has-text("Uplink interval") .lbl'), /Firmware: Get or Set TDC/, 'AT? description shown');
    assert.ok(await page.locator('#cfgPending').isHidden(), 'reading alone must not create a change');
    assert.equal(await page.getAttribute('.setting:has-text("12 V output on-time") input', 'max'), '180000');
    await page.fill('.setting:has-text("Uplink interval") input', '10');
    await page.fill('.setting:has-text("Probe model") input', '0004');
    await page.click('#cfgWrite');
    await waitText(page, '#cfgStatus', /All changes written|failed/);
    assert.equal(await text(page, '#cfgStatus'), 'All changes written.');
    assert.deepEqual(await fake(page, () => [window.fakeBle.state.TDC, window.fakeBle.state.PROBE]), ['600000', '0004']);
  },

  async 'settings: read now, depth and decoder calibration on v1.2'({ page }) {
    await connect(page);
    await readSettings(page);
    await page.click('#i4ReadNow');
    await waitText(page, '#i4Depth', /m/);
    assert.match(await text(page, '#i4Extra'), /Battery 3\.426 V/);
    await page.fill('#i4Range', '4');
    await page.fill('#calMaA', '4.02');
    await page.fill('#calDepthB', '1.5');
    await page.click('#calUseB');
    const cal = await text(page, '#calResult');
    assert.match(cal, /idc_gain = [\d.]+ and idc_offset_mA = -?[\d.]+/);
    assert.ok(await page.locator('#calWrite').isDisabled(), 'no on-device calibration on v1.2');
  },

  async 'settings: values cleared on a new connection'({ page }) {
    await connect(page);
    await readSettings(page);
    await page.click('#disconnBtn');
    await waitText(page, '#connStatus', /Not connected/);
    await fake(page, () => (window.fakeBle.state.TDC = '600000'));
    await connect(page);
    assert.equal(await page.inputValue('.setting:has-text("Uplink interval") input'), '');
    assert.ok(await page.locator('#cfgWrite').isDisabled());
  },

  async 'settings: failed write does not leave the tab stuck'({ page }) {
    await connect(page);
    await readSettings(page);
    await fake(page, () => (window.fakeBle.failNextWrite = true));
    await page.click('#i4ReadNow');
    await waitText(page, '#cfgStatus', /Failed/);
    assert.ok(await page.locator('#cfgRead').isEnabled());
  },

  async 'settings: unsupported command does not block writes or enable calibration'({ page }) {
    await connect(page);
    await fake(page, () => (window.fakeBle.shortHelp = true)); // AT? unparseable
    await readSettings(page);
    assert.match(await text(page, '#cfgStatus'), /Read complete/);
    await page.fill('#calMaA', '4.02');
    await page.fill('#calDepthB', '1.5');
    await page.fill('#calMaB', '10.158');
    assert.match(await text(page, '#calResult'), /no AT\+2PCALIDC/, 'wizard must give decoder values on firmware without AT+2PCALIDC');
    assert.ok(await page.locator('#calWrite').isDisabled());
    assert.ok(await page.locator('#calClear').isDisabled());
  },

  async 'settings: a write without read-back is not shown as confirmed'({ page }) {
    await connect(page);
    await readSettings(page);
    await fake(page, () => {
      const c = window.fakeBle;
      const iv = setInterval(() => {
        if (c.sent.includes('AT+TDC=600000')) {
          c.silent = true;
          clearInterval(iv);
        }
      }, 2);
    });
    await page.fill('.setting:has-text("Uplink interval") input', '10');
    await page.click('#cfgWrite');
    await waitText(page, '#cfgStatus', /failed|read back/, 30000);
    const note = await text(page, '.setting:has-text("Uplink interval") .meta');
    assert.match(note, /not confirmed/);
    assert.doesNotMatch(note, /Written ✓/);
  },

  async 'settings: a failed re-read disables writing again'({ page }) {
    await connect(page);
    await page.fill('#connPin', ''); // no automatic re-login
    await fake(page, () => (window.fakeBle.shortHelp = true));
    await readSettings(page);
    assert.match(await text(page, '#cfgStatus'), /Read complete/);
    // Second read: the console locks right after AT?, so AT+CFG gets "Incorrect Password".
    await fake(page, () => {
      const ctl = window.fakeBle;
      const n = ctl.sent.length;
      const iv = setInterval(() => {
        if (ctl.sent.slice(n).includes('AT?')) {
          ctl.lock();
          clearInterval(iv);
        }
      }, 5);
    });
    await page.click('#cfgRead');
    await waitText(page, '#cfgStatus', /locked/, 30000);
    await page.fill('.setting:has-text("Uplink interval") input', '15');
    assert.ok(await page.locator('#cfgWrite').isDisabled(), 'writing must stay disabled after a failed read');
  },

  async 'settings: a failed read-back after Clear calibration disables writing'({ page }) {
    await fake(page, () => {
      window.fakeBle.state.CALIBRATION = '1000,1000';
      window.fakeBle.state['2PCALIDC'] = '0,0,0,0';
    });
    await connect(page);
    await readSettings(page);
    await fake(page, () => {
      const ctl = window.fakeBle;
      const iv = setInterval(() => {
        if (ctl.sent.includes('AT+2PCALIDC=0,0,0,0')) {
          ctl.silent = true; // the read-back gets no reply
          clearInterval(iv);
        }
      }, 5);
    });
    await page.click('#calClear');
    await waitText(page, '#cfgStatus', /Read from device again/, 30000);
    await fake(page, () => (window.fakeBle.silent = false));
    await page.fill('.setting:has-text("Two-point current calibration") input', '4000,4100,20000,19800');
    assert.ok(await page.locator('#cfgWrite').isDisabled(), 'a value with an unknown device value must not be written');
  },

  async 'export: identifiers hidden in status lines of a saved transcript'({ page }) {
    await connect(page);
    await page.click('#disconnBtn');
    await waitText(page, '#connStatus', /Not connected/);
    await page.check('#termRedactIds');
    const saved = await download(page, '#termSave');
    assert.ok(!saved.includes('A840410000ABCD00'), 'DevEUI (device name) in a saved status line');
    assert.match(saved, /Connecting to \[REDACTED ID\]/);
  },

  async 'reconnect: console still unlocked'({ page }) {
    await connect(page);
    await page.click('#disconnBtn');
    await waitText(page, '#connStatus', /Not connected/);
    await connect(page);
    assert.match(await text(page, '#term'), /still unlocked from an earlier connection/);
  },

  async 'relock: automatic login, and stopping when no PIN is known'({ page }) {
    await connect(page);
    await fake(page, () => window.fakeBle.lock());
    await clearSent(page);
    await terminal(page, 'AT+PROBE=0004');
    await waitText(page, '#term', /Logging in again/);
    await waitFor(page, () => window.fakeBle.sent.length >= 3);
    assert.deepEqual(await sent(page), ['AT+PROBE=0004', PIN, 'AT+PROBE=0004']);

    await page.fill('#connPin', '');
    await fake(page, () => window.fakeBle.lock());
    await clearSent(page);
    await terminal(page, 'AT+TDC=600000\nAT+PROBE=0004\nAT+ADR=1');
    await waitText(page, '#term', /Stopped: the console is locked/);
    assert.deepEqual(await sent(page), ['AT+TDC=600000'], 'a locked console must get only one wrong-PIN attempt');
    assert.match(await text(page, '#term'), /> AT\+TDC=600000/, 'the AT command stays visible');
  },

  async 'PIN: typed in the terminal is hidden, never stored, and remembered for re-login'({ page }) {
    await page.click('#connBtn');
    await waitText(page, '#connStatus', /enter the AT PIN/);
    await terminal(page, PIN);
    await waitText(page, '#term', /Correct Password/);
    assert.ok(!(await text(page, '#term')).includes(`> ${PIN}`));
    assert.ok(!((await fake(page, () => localStorage.getItem('termHistory'))) ?? '').includes(PIN));
    assert.ok(!(await download(page, '#termSave')).includes(PIN));
    assert.equal(await page.inputValue('#connPin'), PIN);
  },

  async 'PIN: wrong typed PIN is not resent; AT+PWORD updates the stored PIN'({ page }) {
    await connect(page);
    await fake(page, () => window.fakeBle.lock());
    await clearSent(page);
    await terminal(page, '654321');
    await waitText(page, '#term', /Incorrect Password/);
    assert.deepEqual(await sent(page), ['654321']);
    await terminal(page, PIN);
    await waitText(page, '#term', /Correct Password/);
    await terminal(page, 'AT+PWORD=112233');
    await waitFor(page, () => window.fakeBle.pin === '112233');
    await fake(page, () => window.fakeBle.lock());
    await clearSent(page);
    await terminal(page, 'AT+TDC=?');
    await waitFor(page, () => window.fakeBle.sent.length >= 3);
    assert.deepEqual(await sent(page), ['AT+TDC=?', '112233', 'AT+TDC=?']);
  },

  async 'terminal: nothing interleaves with a running paste'({ page }) {
    await connect(page);
    await fake(page, () => (window.fakeBle.slowReplies = true));
    await clearSent(page);
    await terminal(page, 'AT+TDC=?\nAT+PROBE=?');
    await page.waitForTimeout(300);
    assert.ok(await page.locator('#snippets button:has-text("AT+VER=?")').isDisabled());
    await page.fill('#termInput', 'AT+VER=?');
    await page.press('#termInput', 'Enter');
    await waitText(page, '#term', /Busy: wait/);
    await waitFor(page, () => !document.querySelector('#termSend').disabled, undefined, 20000);
    assert.deepEqual(await sent(page), ['AT+TDC=?', 'AT+PROBE=?']);
  },

  async 'backup: restore by pasting into the terminal'({ page }) {
    await connect(page);
    await page.click('[data-tab=config]');
    const backup = await download(page, '#cfgBackup');
    assert.match(backup, /CONTAINS SECRETS/);
    await page.click('[data-tab=terminal]');
    await clearSent(page);
    await terminal(page, backup);
    await waitFor(page, () => window.fakeBle.sent.includes('AT+NJM=1'), undefined, 30000);
    assert.ok(!(await sent(page)).some((c) => c.startsWith('#')), 'comment lines must not be sent');
  },

  async 'connection: cancel and device drop during setup'({ page }) {
    await fake(page, () => (window.fakeBle.slowServices = true));
    await page.click('#connBtn');
    await waitText(page, '#term', /Looking for the AT console/);
    await page.click('#disconnBtn');
    await waitText(page, '#connStatus', /Connection cancelled/);
    await page.click('#connBtn');
    await waitText(page, '#term', /Looking for the AT console[\s\S]*Looking for the AT console/);
    await fake(page, () => window.fakeBle.drop());
    await waitText(page, '#connStatus', /disconnected during setup/);
  },

  async 'connection: a drop mid-command is reported at once'({ page }) {
    await connect(page);
    await readSettings(page);
    await page.click('#i4ReadNow');
    await page.waitForTimeout(300);
    await fake(page, () => window.fakeBle.drop());
    await waitText(page, '#cfgStatus', /Disconnected before the sensor replied/, 3000);
  },

  async 'discovery: console, tree, and exclusivity with the connection bar'({ page }) {
    await discoveryScan(page);
    await page.click('#openConsoleBtn');
    await waitText(page, '#consoleLog', /Console open/);
    await page.fill('#cmdInput', PIN);
    await page.click('#sendBtn');
    await waitText(page, '#consoleLog', /Correct Password/);
    await page.locator('.tree .char:has-text("ffe1") button:has-text("Subscribe")').click();
    await waitText(page, '#eventLog', /in use by the test console/);
    await page.click('#quick button:has-text("AT?")');
    await waitText(page, '#consoleLog', /GETSENSORVALUE: Get/);
    assert.ok(!(await text(page, '#consoleLog')).includes(PIN));
    assert.ok(!(await text(page, '#report')).includes(PIN));

    await page.click('[data-tab=terminal]');
    await page.click('#connBtn');
    assert.match(await text(page, '#connStatus'), /Disconnect on the Discovery tab first/);

    await page.click('[data-tab=discovery]');
    await page.click('#disconnectBtn');
    await page.click('[data-tab=terminal]');
    await connect(page);
    await page.click('[data-tab=discovery]');
    await page.click('#scanBtn');
    assert.match(await text(page, '#status'), /Disconnect in the connection bar first/);
    await page.click('#rescanBtn');
    assert.match(await text(page, '#status'), /Disconnect in the connection bar first/);
    await page.evaluate(() => (document.getElementById('eventLog').textContent = ''));
    await page.click('[data-tab=terminal]');
    await page.click('#disconnBtn');
    await waitText(page, '#connStatus', /Not connected/);
    assert.equal((await text(page, '#eventLog')).trim(), '', "Discovery must ignore the main link's disconnects");
  },

  async 'discovery: a connect that never completes times out and blocks the connection bar meanwhile'({ page }) {
    await fake(page, () => (window.fakeBle.hangConnect = true));
    await page.click('[data-tab=discovery]');
    await page.click('#scanBtn');
    await waitText(page, '#status', /Connecting/);
    // While Discovery's attempt is pending, the connection bar must not connect to the same sensor.
    await page.click('[data-tab=terminal]');
    await page.click('#connBtn');
    await waitText(page, '#connStatus', /Disconnect on the Discovery tab first/);
    await page.click('[data-tab=discovery]');
    await waitText(page, '#status', /timed out after 15 s/, 20000);
    assert.ok(await page.locator('#disconnectBtn').isDisabled(), 'Disconnect enabled after a failed connect');
    // Once it has given up, the connection bar may connect again.
    await fake(page, () => (window.fakeBle.hangConnect = false));
    await page.click('[data-tab=terminal]');
    await page.click('#connBtn');
    await waitText(page, '#connStatus', /Connected/);
  },

  async 'discovery: Disconnect resets the tab; hex and typed PINs stay hidden'({ page }) {
    await discoveryScan(page);
    await page.click('#openConsoleBtn');
    await waitText(page, '#consoleLog', /Console open/);
    await page.check('#cmdHex');
    await page.fill('#cmdInput', '31 32 33 34 35 36 0D 0A'); // the PIN, as hex
    await page.click('#sendBtn');
    await waitText(page, '#consoleLog', /Correct Password/);
    await page.waitForTimeout(400);
    assert.ok(!(await text(page, '#consoleLog')).includes(PIN), 'hex PIN shown in console');
    assert.ok(!(await text(page, '#report')).includes(PIN), 'hex PIN in report');

    await page.uncheck('#cmdHex');
    await fake(page, () => window.fakeBle.lock());
    await page.fill('#cmdInput', PIN);
    await page.click('#sendBtn');
    await waitText(page, '#consoleLog', /Correct Password[\s\S]*Correct Password/);
    assert.equal(await page.inputValue('#pin'), PIN, 'accepted typed PIN is kept for re-login and redaction');

    await page.click('#disconnectBtn');
    await waitText(page, '#status', /Disconnected/);
    for (const sel of ['#disconnectBtn', '#openConsoleBtn', '#sendBtn']) assert.ok(await page.locator(sel).isDisabled(), `${sel} still enabled`);
    assert.ok(await page.locator('.tree button').first().isDisabled(), 'tree buttons still enabled');
  },
};

// ------------------------------------------------------------------- runner ----

async function waitForServer(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Preview server did not start on ${url}`);
}

const filter = process.argv[2];
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
let failed = 0;
try {
  await waitForServer(BASE);
  const browser = await chromium.launch();
  for (const [name, run] of Object.entries(scenarios)) {
    if (filter && !name.includes(filter)) continue;
    const t0 = Date.now();
    const ctx = await openPage(browser);
    try {
      await run(ctx);
      assert.deepEqual(ctx.errors, [], 'page errors');
      console.log(`  ✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${name}\n      ${String(e.message).split('\n').join('\n      ')}`);
    } finally {
      await ctx.close();
    }
  }
  await browser.close();
} finally {
  server.kill();
}
console.log(failed ? `\n${failed} scenario(s) failed` : '\nAll scenarios passed');
process.exit(failed ? 1 : 0);
