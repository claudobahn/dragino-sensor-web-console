/**
 * Settings tab: read/edit/write profile settings, live depth reading, and the
 * two-point calibration wizard for 4–20 mA immersion probes.
 */
import { buildBackup } from '../at/backup';
import { parseConfigDump, parseHelpDescriptions, queryValue, type AtResult } from '../at/response';
import type { DraginoLink } from '../device/link';
import { parseSensorValues } from '../profiles/ps-lb';
import { DECODER_CURRENT_LINE, decoderCalibrationPatch, draginoDepthCm } from '../profiles/ps-lb-decoder';
import type { DeviceContext, DeviceProfile, SettingDef } from '../profiles/types';
import {
  decodeProbe,
  depthFromMa,
  FAULT_HIGH_MA,
  FAULT_LOW_MA,
  twoPointCalibration,
  type TwoPointCal,
} from '../profiles/water-depth';
import { $, downloadText, h, input } from './dom';

interface Row {
  def: SettingDef;
  el: HTMLElement;
  control: HTMLInputElement | HTMLSelectElement;
  meta: HTMLElement;
  /** Value last read from (or confirmed on) the device. */
  deviceRaw?: string;
  error?: string;
  note?: { text: string; cls: 'ok' | 'err' };
  /** The firmware's AT? listing does not include this command. */
  unsupported?: boolean;
  /** Where the firmware's own description of the command (from AT?) is shown. */
  fwHelp: HTMLElement;
}

const LOCKED_MSG = 'Console locked: enter the AT PIN and log in, then try again.';

/**
 * A locked console answers every command with "Incorrect Password" (and counts it as a wrong PIN). Stop at the first
 * one instead of sending more commands, and say why.
 */
function assertUnlocked(r: AtResult): AtResult {
  if (r.status === 'password-bad') throw new Error(LOCKED_MSG);
  return r;
}

const display = (def: SettingDef, raw: string) => (def.toDisplay ? def.toDisplay(raw) : raw);
const toRaw = (def: SettingDef, disp: string) => (def.fromDisplay ? def.fromDisplay(disp) : disp.trim());

export function initConfig(link: DraginoLink, profile: DeviceProfile) {
  const rows = new Map<string, Row>();
  const status = $('cfgStatus');
  let busy = false;
  /** Commands listed by AT?; null until read (or if the listing could not be parsed). */
  let supported: Set<string> | null = null;
  /**
   * True once Read from device has completed on the current connection. Writing is only allowed after that, so
   * changes are compared against this device's values and firmware limits come from its AT+VER.
   */
  let haveRead = false;
  /** Listed by AT? (or AT? couldn't be parsed, so assume yes). */
  const listedInHelp = (cmd: string) => !supported || supported.has(cmd);
  /** Usable on this firmware: listed by AT? and not answered with AT_ERROR during the read. */
  const isSupported = (cmd: string) => listedInHelp(cmd) && !rows.get(cmd)?.unsupported;
  /** Firmware-dependent limits use the AT+VER value read from the device. */
  const deviceContext = (): DeviceContext => ({ firmware: rows.get('VER')?.deviceRaw });
  const validate = (row: Row, raw: string) => row.def.validate?.(raw, deviceContext()) ?? null;

  // ------------------------------------------------------------ render --
  const groupsEl = $('cfgGroups');
  for (const group of profile.groups) {
    const rowEls = group.settings.map((def) => {
      const control =
        def.kind === 'select'
          ? h('select', {}, ...(def.options ?? []).map((o) => h('option', { value: o.value }, o.label)))
          : h('input', {
              type: def.kind === 'number' ? 'number' : 'text',
              min: def.min,
              max: def.max,
              step: def.step ?? 'any',
              readonly: def.readOnly,
              spellcheck: 'false',
              placeholder: def.readOnly ? '—' : 'read first',
            });
      const meta = h('div', { class: 'meta' });
      const fwHelp = h('small', { class: 'fw-help', title: 'Description from the firmware (AT?)' });
      const el = h(
        'div',
        { class: 'setting' },
        h(
          'div',
          { class: 'lbl' },
          def.label,
          h('small', {}, `AT+${def.cmd}${def.help ? ` · ${def.help}` : ''}`),
          fwHelp,
        ),
        h('div', { class: 'ctl' }, control, def.unit ? h('span', { class: 'muted' }, def.unit) : null),
        meta,
      );
      const row: Row = { def, el, control, meta, fwHelp };
      control.addEventListener('input', () => {
        row.note = undefined;
        refreshRow(row);
        refreshPending();
      });
      rows.set(def.cmd, row);
      return el;
    });
    groupsEl.append(
      h('div', { class: 'group' }, h('h3', {}, group.title), group.description ? h('p', { class: 'hint' }, group.description) : null, ...rowEls),
    );
  }

  /**
   * The device value the field currently stands for. If the field still shows exactly how the device value is
   * displayed, it *is* the device value, even when display → raw would not reproduce it (e.g. 1200500 ms shown as
   * 20.0083 min). Otherwise reading alone could create a change.
   */
  function currentRaw(row: Row): string | undefined {
    const v = row.control.value.trim();
    if (v === '') return row.deviceRaw;
    if (row.deviceRaw !== undefined && v === display(row.def, row.deviceRaw).trim()) return row.deviceRaw;
    return toRaw(row.def, row.control.value);
  }

  function pendingRaw(row: Row): string | undefined {
    if (row.def.readOnly || row.unsupported) return undefined;
    if (row.control.value.trim() === '') return undefined;
    const raw = currentRaw(row);
    return raw === row.deviceRaw ? undefined : raw;
  }

  function refreshRow(row: Row): void {
    const { def } = row;
    const raw = currentRaw(row);
    const invalid = !def.readOnly && raw !== undefined && raw !== row.deviceRaw ? validate(row, raw) : null;
    const changed = pendingRaw(row) !== undefined;
    row.el.classList.toggle('changed', changed && !invalid);
    row.el.classList.toggle('invalid', !!invalid);
    const parts: (Node | string)[] = [];
    if (row.error) parts.push(h('div', { class: 'err' }, row.error));
    if (invalid) parts.push(h('div', { class: 'err' }, invalid));
    if (raw !== undefined && raw !== '') {
      const desc = def.describe?.(raw);
      if (desc) parts.push(h('div', {}, desc));
      if (!def.readOnly) {
        if (changed && !invalid) parts.push(h('div', {}, 'Will send ', h('code', {}, `AT+${def.cmd}=${raw}`)));
        const dl = !invalid ? def.downlink?.(raw) : null;
        if (dl) parts.push(h('div', {}, 'Downlink ', h('code', {}, dl)));
      }
    }
    if (row.note) parts.push(h('div', { class: row.note.cls }, row.note.text));
    row.meta.replaceChildren(...parts);
  }

  function setUnsupported(row: Row, unsupported: boolean): void {
    row.unsupported = unsupported;
    row.control.disabled = unsupported;
    row.el.classList.toggle('unsupported', unsupported);
    if (unsupported) {
      row.deviceRaw = undefined;
      row.control.value = '';
      row.error = 'Not supported by this firmware (not listed by AT?).';
    }
    refreshRow(row);
  }

  function setDeviceValue(cmd: string, raw: string | undefined, error?: string): void {
    const row = rows.get(cmd);
    if (!row || row.unsupported) return;
    row.deviceRaw = raw;
    row.error = error;
    row.control.value = raw === undefined ? '' : display(row.def, raw);
    refreshRow(row);
    if (cmd === 'PROBE' && raw) {
      const p = decodeProbe(raw);
      if (p.kind === 'water-depth' && p.rangeM) {
        input('i4Range').value = String(p.rangeM);
        updateDepth();
        updateCal();
      }
    }
  }

  /**
   * Read a setting back after writing it. If the read-back fails, the device's value is unknown, so writing is
   * disabled again until Read from device succeeds (otherwise a typed value would be written blind).
   */
  async function readBack(cmd: string): Promise<string | undefined> {
    const back = queryValue(cmd, await link.command(`AT+${cmd}=?`));
    if (back !== undefined) setDeviceValue(cmd, back);
    else haveRead = false;
    return back;
  }

  // --------------------------------------------------------- read/write --
  function setBusy(b: boolean, msg = ''): void {
    busy = b;
    status.textContent = msg;
    status.className = 'status';
    refreshButtons();
  }

  function refreshButtons(): void {
    const on = link.connected && !busy;
    for (const id of ['cfgRead', 'cfgBackup', 'cfgReset', 'i4ReadNow']) ($(id) as HTMLButtonElement).disabled = !on;
    ($('cfgWrite') as HTMLButtonElement).disabled = !on || !haveRead || writes().length === 0;
    ($('calWrite') as HTMLButtonElement).disabled = !on || !haveRead || !currentCal || !isSupported('2PCALIDC');
    ($('calClear') as HTMLButtonElement).disabled = !on || !haveRead || !(isSupported('2PCALIDC') || isSupported('CALIBRATION'));
  }

  /**
   * Run a device action with the tab marked busy. Whatever happens (including a rejected BLE write), busy is cleared
   * and the status shows the outcome, so the buttons never stay disabled.
   */
  async function runTask(startMsg: string, fn: () => Promise<string>): Promise<void> {
    setBusy(true, startMsg);
    let msg: string;
    try {
      msg = await fn();
    } catch (e) {
      msg = `Failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    setBusy(false, link.connected || /disconnect/i.test(msg) ? msg : `${msg} (disconnected)`);
    refreshPending();
  }

  async function readAll(): Promise<void> {
    // Until this read completes, the form no longer reflects a complete read of the device.
    haveRead = false;
    setBusy(true, 'Reading supported commands (AT?)…');
    try {
      const descriptions = parseHelpDescriptions(assertUnlocked(await link.command('AT?')).lines);
      const help = new Set(descriptions.keys());
      for (const row of rows.values()) {
        const d = descriptions.get(row.def.cmd);
        row.fwHelp.textContent = d ? `Firmware: ${d}` : '';
      }
      supported = help.size > 5 ? help : null;
      for (const row of rows.values()) setUnsupported(row, !listedInHelp(row.def.cmd));
      status.textContent = 'Reading AT+CFG…';
      const cfg = assertUnlocked(await link.command('AT+CFG'));
      const dump = parseConfigDump(cfg.lines);
      for (const [cmd, row] of rows) {
        if (row.unsupported) continue;
        if (dump.has(cmd)) {
          setDeviceValue(cmd, dump.get(cmd));
          continue;
        }
        status.textContent = `Reading AT+${cmd}…`;
        const r = assertUnlocked(await link.command(`AT+${cmd}=?`));
        if (r.status === 'disconnected') throw new Error('Disconnected');
        if (r.status === 'error' && r.error === 'AT_ERROR') {
          // AT_ERROR = unknown command: this firmware doesn't have it (also when AT? could not be parsed).
          setUnsupported(row, true);
          row.error = 'Not supported by this firmware (AT_ERROR).';
          refreshRow(row);
          continue;
        }
        const v = queryValue(cmd, r);
        setDeviceValue(cmd, v, v === undefined ? (r.error ?? (r.status === 'timeout' ? 'No reply' : r.status)) : undefined);
      }
      // Only allow writing once this device's writable settings were actually read; otherwise every typed value would
      // look like a change and be written blind.
      const writable = [...rows.values()].filter((r) => !r.def.readOnly && !r.unsupported);
      const unread = writable.filter((r) => r.deviceRaw === undefined).map((r) => `AT+${r.def.cmd}`);
      haveRead = writable.length > 0 && unread.length === 0;
      applyLimits();
      const ver = rows.get('VER')?.deviceRaw;
      const missing = [...rows.values()].filter((r) => r.unsupported).map((r) => `AT+${r.def.cmd}`);
      const notSupported = missing.length ? ` Not supported here: ${missing.join(', ')}.` : '';
      setBusy(
        false,
        haveRead
          ? `Read complete${ver ? ` (firmware ${ver})` : ''}.${notSupported}`
          : `Read incomplete: no reply for ${unread.join(', ')}. Writing stays disabled; check the connection and read again.`,
      );
      updateCal();
    } catch (e) {
      setBusy(false, e instanceof Error ? e.message : String(e));
    }
    refreshPending();
  }

  function writes(): { row: Row; raw: string }[] {
    const out: { row: Row; raw: string }[] = [];
    for (const row of rows.values()) {
      const raw = pendingRaw(row);
      if (raw !== undefined && !validate(row, raw)) out.push({ row, raw });
    }
    return out;
  }

  function refreshPending(): void {
    const w = writes();
    const el = $('cfgPending');
    el.hidden = w.length === 0;
    el.replaceChildren(
      h('b', {}, `${w.length} change${w.length === 1 ? '' : 's'} to write:`),
      h('pre', {}, w.map(({ row, raw }) => `AT+${row.def.cmd}=${raw}`).join('\n')),
      w.some(({ row }) => row.def.needsReset) ? h('div', { class: 'hint' }, 'Some changes take effect only after a restart (ATZ).') : '',
      haveRead ? '' : h('div', { class: 'hint' }, 'Press Read from device first; writing is enabled once this sensor\'s current settings are loaded.'),
    );
    refreshButtons();
  }

  function writeAll(): Promise<void> {
    const w = writes();
    if (!w.length) return Promise.resolve();
    return runTask('Writing…', async () => {
      let failed = 0;
      for (const { row, raw } of w) {
        status.textContent = `Writing AT+${row.def.cmd}…`;
        const r = await link.command(`AT+${row.def.cmd}=${raw}`);
        if (r.status === 'disconnected' || r.status === 'password-bad') {
          failed++;
          row.note = { text: r.status === 'disconnected' ? 'Not written: disconnected' : `Not written. ${LOCKED_MSG}`, cls: 'err' };
          refreshRow(row);
          if (r.status === 'password-bad') return LOCKED_MSG;
          break;
        }
        // Confirm by reading back.
        const back = await readBack(row.def.cmd);
        // Only a matching read-back confirms the write; an OK without a read-back is not a confirmation.
        const ok = r.status === 'ok' && back !== undefined && (back === raw || toRaw(row.def, display(row.def, back)) === raw);
        if (!ok) failed++;
        row.note = ok
          ? { text: 'Written ✓', cls: 'ok' }
          : {
              text:
                r.status === 'error'
                  ? `Write failed (${r.error})`
                  : r.status === 'ok' && back === undefined
                    ? 'Sent, but not confirmed: the read-back got no reply'
                    : r.status === 'ok'
                      ? `Write read back as "${back}"`
                      : 'Write got no confirmation',
              cls: 'err',
            };
        refreshRow(row);
      }
      const reread = haveRead ? '' : ' Some values could not be read back: read from device again before writing more.';
      return (failed ? `${failed} setting(s) failed. Check the terminal for details.` : 'All changes written.') + reread;
    });
  }

  $('cfgRead').addEventListener('click', () => void readAll());
  $('cfgWrite').addEventListener('click', () => void writeAll());
  $('cfgBackup').addEventListener('click', async () => {
    const ok = confirm(
      'The backup file will contain your LoRaWAN AppKey, session keys and the AT PIN, unredacted, ' +
        'because a backup without them cannot restore the sensor.\n\n' +
        'Store it somewhere private and do not share it or commit it to a repository.\n\nContinue?',
    );
    if (!ok) return;
    await runTask('Reading AT+CFG for backup…', async () => {
      const r = assertUnlocked(await link.command('AT+CFG'));
      if (r.status !== 'ok') throw new Error(`Backup failed: AT+CFG ${r.error ?? r.status}`);
      const name = link.device?.name ?? undefined;
      const b = buildBackup({ cfgLines: r.lines, deviceName: name });
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      downloadText(`dragino-backup-${(name ?? 'device').replace(/[^\w-]+/g, '_')}-${stamp}.txt`, b.text, 'text/plain');
      return `Backup saved: ${b.settingCount} settings, ${b.restoreCount} restore commands${b.firmware ? ` (firmware ${b.firmware})` : ''}.`;
    });
  });
  $('cfgReset').addEventListener('click', async () => {
    if (!confirm('Restart the sensor now? This ends the BLE connection. Press the button again to reconnect.')) return;
    await runTask('Restarting…', async () => {
      await link.command('ATZ', { timeoutMs: 1500 });
      return 'Restart sent.';
    });
  });

  // ------------------------------------------------------- live reading --
  function updateDepth(): void {
    const ma = Number(input('i4Ma').value);
    const range = Number(input('i4Range').value);
    const out = $('i4Depth');
    if (!input('i4Ma').value || !(range > 0)) {
      out.textContent = '';
      return;
    }
    const d = depthFromMa(ma, range);
    const warn =
      ma < FAULT_LOW_MA ? ` (below ${FAULT_LOW_MA} mA: probe unpowered or disconnected?)` : ma > FAULT_HIGH_MA ? ` (above ${FAULT_HIGH_MA} mA: over range or faulty?)` : '';
    out.textContent = `≈ ${d.toFixed(3)} m · decoder reports ${draginoDepthCm(ma, range)} cm${warn}`;
  }
  input('i4Ma').addEventListener('input', updateDepth);
  input('i4Range').addEventListener('input', () => {
    updateDepth();
    updateCal();
  });

  $('i4ReadNow').addEventListener('click', () =>
    runTask('Reading sensor…', async () => {
      const r = assertUnlocked(await link.command('AT+GETSENSORVALUE=0', { timeoutMs: 8000, idleMs: 2500 }));
      if (r.status === 'disconnected') return 'Disconnected before the sensor replied.';
      const raw = $('i4Raw');
      raw.hidden = false;
      raw.textContent = r.lines.join('\n') || `(no output: ${r.error ?? r.status})`;
      const v = parseSensorValues(r.lines.join('\n'));
      $('i4Extra').textContent = [
        v.batteryV !== undefined ? `Battery ${v.batteryV.toFixed(3)} V${v.batteryV < 3.3 ? ' (low)' : ''}` : '',
        v.vdcV !== undefined ? `VDC input ${v.vdcV.toFixed(3)} V` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      if (v.idcMa === undefined) return 'Could not find a current reading in the output. Enter it manually.';
      input('i4Ma').value = v.idcMa.toFixed(3);
      updateDepth();
      return `Current ${v.idcMa.toFixed(3)} mA`;
    }),
  );

  // -------------------------------------------------------- calibration --
  let currentCal: TwoPointCal | null = null;

  function updateCal(): void {
    const out = $('calResult');
    const vals = ['calDepthA', 'calMaA', 'calDepthB', 'calMaB'].map((id) => input(id).value);
    currentCal = null;
    if (vals.some((v) => v.trim() === '')) {
      out.replaceChildren(h('p', { class: 'muted' }, 'Fill in both points to compute the calibration.'));
    } else {
      try {
        const [dA, mA, dB, mB] = vals.map(Number);
        const cal = twoPointCalibration({ depthM: dA, measuredMa: mA }, { depthM: dB, measuredMa: mB }, Number(input('i4Range').value));
        currentCal = cal;
        const dl = rows.get('2PCALIDC')?.def.downlink?.(`${cal.r1},${cal.s1},${cal.r2},${cal.s2}`);
        const onDevice = isSupported('2PCALIDC');
        const gain = cal.gain.toFixed(6);
        const offMa = (cal.offsetUa / 1000).toFixed(4);
        out.replaceChildren(
          onDevice
            ? h('p', {}, 'Command: ', h('code', {}, cal.command))
            : h(
                'div',
                { class: 'pending' },
                h('b', {}, 'This firmware has no AT+2PCALIDC, so apply the correction in your payload decoder instead.'),
                h(
                  'div',
                  { class: 'hint' },
                  "In Dragino's PS-LB decoder (PS-LB_v1.2.7_decoder.txt or PS-LB_v1.2_decoder.txt), replace this line in the default (port 2) branch:",
                ),
                h('pre', {}, DECODER_CURRENT_LINE),
                h('div', { class: 'hint' }, 'with:'),
                h('pre', {}, decoderCalibrationPatch(cal.gain, cal.offsetUa / 1000)),
                h(
                  'div',
                  { class: 'hint' },
                  `Water_deep_cm then uses the corrected current. This patch does not correct datalog uplinks (port 3), which are only sent when AT+PNACKMD=1. Using this project's decoders/ps-lb.js instead? Set the ChirpStack device variables idc_gain = ${gain} and idc_offset_mA = ${offMa} (or IDC_CALIBRATION on TTN). Any other decoder: corrected_mA = ${gain} × raw_mA + (${offMa}).`,
                ),
                h('div', { class: 'hint' }, 'Or update the sensor firmware to 1.2.8 or later and write it to the device.'),
              ),
          onDevice && dl ? h('p', {}, 'Downlink: ', h('code', {}, dl)) : '',
          h(
            'p',
            { class: 'muted' },
            `R1 = ${cal.r1} µA (expected at ${dA} m), S1 = ${cal.s1} µA measured · R2 = ${cal.r2} µA (expected at ${dB} m), S2 = ${cal.s2} µA measured. ` +
              `Correction: ×${cal.gain.toFixed(4)} ${cal.offsetUa >= 0 ? '+' : '−'} ${Math.abs(cal.offsetUa).toFixed(0)} µA.`,
          ),
          Math.abs(cal.gain - 1) > 0.2
            ? h('p', { class: 'error' }, 'The gain is more than 20% off. Check that the depths and readings are right and calibration was cleared.')
            : '',
        );
      } catch (e) {
        out.replaceChildren(h('p', { class: 'error' }, e instanceof Error ? e.message : String(e)));
      }
    }
    refreshButtons();
  }
  for (const id of ['calDepthA', 'calMaA', 'calDepthB', 'calMaB']) input(id).addEventListener('input', updateCal);
  const useLive = (target: string) => () => {
    // The current field holds the latest Read now value, or whatever the user typed over it.
    const text = input('i4Ma').value.trim();
    const v = text === '' ? undefined : Number(text);
    if (v === undefined || !Number.isFinite(v)) {
      alert('Take a reading first (Read now) or enter the current manually.');
      return;
    }
    input(target).value = v.toFixed(3);
    updateCal();
  };
  $('calUseA').addEventListener('click', useLive('calMaA'));
  $('calUseB').addEventListener('click', useLive('calMaB'));

  $('calClear').addEventListener('click', () =>
    runTask('Clearing calibration…', async () => {
      const problems: string[] = [];
      for (const [cmd, value] of [['2PCALIDC', '0,0,0,0'], ['CALIBRATION', '1000,1000']]) {
        if (!isSupported(cmd)) continue;
        const r = assertUnlocked(await link.command(`AT+${cmd}=${value}`));
        if (r.status !== 'ok') problems.push(`${cmd}: ${r.error ?? r.status}`);
        if ((await readBack(cmd)) === undefined) problems.push(`${cmd}: no read-back`);
      }
      const reread = haveRead ? '' : ' Read from device again before writing.';
      return (problems.length ? `Clear failed (${problems.join('; ')}).` : 'Calibration cleared.') + reread;
    }),
  );

  $('calWrite').addEventListener('click', () => {
    const cal = currentCal;
    if (!cal) return;
    void runTask('Writing calibration…', async () => {
      const r = assertUnlocked(await link.command(cal.command));
      const back = await readBack('2PCALIDC');
      const reread = back === undefined ? ' The read-back failed: read from device again before writing.' : '';
      return (r.status === 'ok' ? 'Calibration written. Take a fresh reading to check it.' : `Calibration write: ${r.error ?? r.status}`) + reread;
    });
  });

  /** Set firmware-dependent input limits (max attribute) from the AT+VER that was read. */
  function applyLimits(): void {
    for (const row of rows.values()) {
      if (row.def.maxFor && row.control instanceof HTMLInputElement) row.control.max = String(row.def.maxFor(deviceContext()));
    }
  }

  /** Forget everything read from the previous connection, so nothing is compared against another device's values. */
  function resetRows(): void {
    supported = null;
    haveRead = false;
    for (const row of rows.values()) {
      row.deviceRaw = undefined;
      row.error = undefined;
      row.note = undefined;
      row.control.value = '';
      row.fwHelp.textContent = '';
      setUnsupported(row, false);
    }
    applyLimits();
    status.textContent = 'New connection: press Read from device to load this sensor\'s settings.';
    status.className = 'status';
    refreshPending();
  }

  link.on('state', (s) => {
    if (s === 'connecting') resetRows();
    else if (s === 'disconnected') supported = null;
    refreshButtons();
  });
  updateCal();
  refreshButtons();
}
