/**
 * Discovery tab: inspect any BLE device's GATT table and test candidate serial channels.
 */
import {
  captureAdvertisement,
  connect,
  enumerate,
  errMsg,
  findUartCandidates,
  isWebBluetoothAvailable,
  propertyFlags,
  requestDevice,
  requestedServiceList,
  serialiseResult,
  shortUuid,
  type CharacteristicInfo,
  type DiscoveryResult,
  type UartCandidate,
} from '../ble/discovery';
import { normalizeUuid } from '../ble/known-uuids';
import { mayBePin } from '../at/response';
import { CONNECT_HINT, CONNECT_TIMEOUT_MS, DraginoLink, TimeoutError, withTimeout } from '../device/link';
import {
  bytesToAsciiPreview,
  bytesToHex,
  bytesToText,
  hexToBytes,
  LINE_ENDINGS,
  textToBytes,
  toBytes,
  type LineEnding,
} from '../util/bytes';
import { redactLiteral, redactRx, redactTx, type RedactOptions, type RedactState } from '../util/redact';
import { $, downloadText, el, h, input, storageGet, storageSet } from './dom';

// ---------------------------------------------------------------- state ----

interface TranscriptEntry {
  t: string;
  dir: 'tx' | 'rx' | 'sys';
  text: string;
  hex?: string;
}

let device: BluetoothDevice | null = null;
let result: DiscoveryResult | null = null;
let candidates: UartCandidate[] = [];
/**
 * The test console uses the same DraginoLink as the main connection (line assembly, response grouping, automatic
 * re-login, disconnect handling), attached to whichever write/notify pair is chosen here.
 */
const consoleLink = new DraginoLink();
/** The characteristic the test console receives on, while it is open. */
let consoleNotify: BluetoothRemoteGATTCharacteristic | null = null;
const transcript: TranscriptEntry[] = [];
const notifyListeners = new Map<BluetoothRemoteGATTCharacteristic, (ev: Event) => void>();

const QUICK_COMMANDS = ['AT+CFG', 'AT+VER=?', 'AT+DEUI=?', 'AT+PROBE=?', 'AT+TDC=?', 'AT+PLDTA=5', 'AT?'];

// -------------------------------------------------------------- logging ----

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

function eventLog(msg: string, cls = ''): void {
  const el = $('eventLog');
  el.append(h('span', { class: cls }, `${ts()}  ${msg}\n`));
  el.scrollTop = el.scrollHeight;
}

/** Rebuilding the redacted report is O(transcript); do it at most every 250 ms while output streams in. */
let reportTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleReport(): void {
  // Not visible: it is rebuilt when the tab is shown (and Copy/Download always build it fresh).
  if ($('tab-discovery').hidden) return;
  if (reportTimer !== undefined) return;
  reportTimer = setTimeout(() => {
    reportTimer = undefined;
    updateReport();
  }, 250);
}

/** Keep the test console (and its report transcript) bounded in long sessions. */
const MAX_CONSOLE_LINES = 5000;

function consoleLine(dir: TranscriptEntry['dir'], text: string, hex?: string, cls?: string): void {
  transcript.push({ t: new Date().toISOString(), dir, text, hex });
  const el = $('consoleLog');
  const prefix = dir === 'tx' ? '> ' : dir === 'rx' ? '< ' : '# ';
  el.append(h('span', { class: cls ?? dir }, `${ts()} ${prefix}${text}${hex ? `   [${hex}]` : ''}\n`));
  if (transcript.length > MAX_CONSOLE_LINES) {
    transcript.splice(0, transcript.length - MAX_CONSOLE_LINES);
    while (el.childElementCount > MAX_CONSOLE_LINES) el.firstElementChild?.remove();
  }
  el.scrollTop = el.scrollHeight;
  scheduleReport();
}

function setStatus(text: string, cls: '' | 'ok' | 'err' = ''): void {
  const el = $('status');
  el.textContent = text;
  el.className = `status ${cls}`;
}

// --------------------------------------------------------- environment ----

async function checkSupport(): Promise<void> {
  const banner = $('support');
  const problems: string[] = [];
  if (!window.isSecureContext) problems.push('This page must be served over HTTPS (or http://localhost).');
  if (!isWebBluetoothAvailable()) {
    problems.push('Web Bluetooth is not available. Use desktop Chrome or Edge. Firefox and Safari do not support it.');
  } else {
    try {
      if (!(await navigator.bluetooth.getAvailability())) problems.push('No Bluetooth adapter detected, or it is turned off.');
    } catch {
      /* getAvailability unsupported: ignore */
    }
  }
  if (problems.length) {
    banner.hidden = false;
    banner.replaceChildren(...problems.map((p) => h('div', {}, p)));
    el('scanBtn', HTMLButtonElement).disabled = !isWebBluetoothAvailable();
  }
}

// ----------------------------------------------------------- UUID input ----

function parseExtraUuids(): string[] {
  const raw = el('extraUuids', HTMLTextAreaElement).value;
  const bad: string[] = [];
  const ok: string[] = [];
  for (const line of raw.split(/[\n,]+/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const n = normalizeUuid(trimmed);
    if (n) ok.push(n);
    else bad.push(trimmed);
  }
  $('uuidErrors').textContent = bad.length ? `Ignored invalid UUID(s): ${bad.join(', ')}` : '';
  return ok;
}

// ------------------------------------------------------------ discovery ----

/** The main connection bar's link; Discovery must not run alongside it (they would share the same GATT objects). */
let mainLink: DraginoLink | null = null;
/** True while Discovery itself holds the connection (the device object may be shared with the main link). */
let connectedHere = false;

/** Discovery must not connect while the connection bar is connected; returns true (and says so) if blocked. */
function blockedByMainLink(): boolean {
  if (mainLink && mainLink.state !== 'disconnected') {
    setStatus('Disconnect in the connection bar first: Discovery and the main connection cannot use the sensor at the same time.', 'err');
    return true;
  }
  return false;
}

async function scan(): Promise<void> {
  if (blockedByMainLink()) return;
  const extra = parseExtraUuids();
  storageSet('extraUuids', el('extraUuids', HTMLTextAreaElement).value);
  storageSet('namePrefix', input('namePrefix').value);
  try {
    await disconnect();
    setStatus('Choose a device…');
    const namePrefix = input('namePrefix').value.trim() || undefined;
    device = await requestDevice({ namePrefix, extraServices: extra });
    device.addEventListener('gattserverdisconnected', onDisconnected);
    eventLog(`Selected "${device.name ?? '(no name)'}" id=${device.id}`);

    let adv;
    let advNote: string | undefined;
    if (input('captureAdv').checked) {
      setStatus('Listening for advertisement…');
      const r = await captureAdvertisement(device);
      adv = r.adv;
      advNote = r.note;
      eventLog(adv ? `Advertisement: ${JSON.stringify(adv)}` : `Advertisement: ${advNote}`, adv ? '' : 'sys');
    }

    await discover(extra, adv, advNote);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotFoundError' && /cancel/i.test(e.message)) {
      setStatus('Scan cancelled');
    } else {
      setStatus(errMsg(e), 'err');
      eventLog(errMsg(e), 'err');
    }
  }
}

async function discover(
  extra: string[] = parseExtraUuids(),
  advertisement?: DiscoveryResult['advertisement'],
  advertisementNote?: string,
): Promise<void> {
  if (!device || blockedByMainLink()) return;
  setStatus('Connecting…');
  // Claim the sensor from the start, so the connection bar cannot connect while this attempt is pending.
  connectedHere = true;
  let server: BluetoothRemoteGATTServer;
  try {
    // gatt.connect() can wait indefinitely once the sensor has stopped advertising.
    server = await withTimeout(connect(device), CONNECT_TIMEOUT_MS, 'Bluetooth connection');
  } catch (e) {
    connectedHere = false;
    device.gatt?.disconnect(); // cancel the pending attempt
    setConnectedUi(false);
    throw e instanceof TimeoutError ? new Error(`${e.message} ${CONNECT_HINT}`) : e;
  }
  setStatus('Enumerating services…');
  eventLog('Connected; enumerating');
  const services = await enumerate(server, (m) => eventLog(m), input('readValues').checked);
  result = {
    deviceName: device.name ?? undefined,
    deviceId: device.id,
    requestedServices: requestedServiceList(extra),
    services,
    advertisement: advertisement ?? result?.advertisement,
    advertisementNote: advertisementNote ?? result?.advertisementNote,
    discoveredAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
  };
  candidates = findUartCandidates(services);
  const nChars = services.reduce((n, s) => n + s.characteristics.length, 0);
  setStatus(
    services.length
      ? `Connected: ${services.length} service(s), ${nChars} characteristic(s)`
      : 'Connected, but none of the requested services were found. Add UUIDs from nRF Connect and re-scan.',
    services.length ? 'ok' : 'err',
  );
  renderTree();
  renderCandidates();
  setConnectedUi(true);
  updateReport();
}

async function disconnect(): Promise<void> {
  await closeConsole();
  for (const [ch, fn] of notifyListeners) {
    ch.removeEventListener('characteristicvaluechanged', fn);
  }
  notifyListeners.clear();
  const wasHere = connectedHere;
  connectedHere = false;
  if (wasHere && device?.gatt?.connected) device.gatt.disconnect();
  // onDisconnected() ignores the event now that connectedHere is false, so reset the UI here.
  if (wasHere) markDisconnected();
}

function onDisconnected(): void {
  // The device object can be shared with the main connection; ignore its disconnects unless Discovery was connected.
  if (!connectedHere) return;
  connectedHere = false;
  markDisconnected();
}

function markDisconnected(): void {
  eventLog('Device disconnected', 'sys');
  setStatus('Disconnected');
  notifyListeners.clear();
  setConnectedUi(false);
  setConsoleUi(false);
}

function setConnectedUi(connected: boolean): void {
  el('rescanBtn', HTMLButtonElement).disabled = !device;
  el('disconnectBtn', HTMLButtonElement).disabled = !connected;
  el('pairSelect', HTMLSelectElement).disabled = !connected || candidates.length === 0;
  el('openConsoleBtn', HTMLButtonElement).disabled = !connected || candidates.length === 0;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tree button')) b.disabled = !connected;
}

// ----------------------------------------------------------- GATT tree ----

function formatValue(bytes: Uint8Array): string {
  return `${bytesToHex(bytes)}  "${bytesToAsciiPreview(bytes)}"`;
}

function renderTree(): void {
  const tree = $('tree');
  if (!result || result.services.length === 0) {
    tree.replaceChildren(h('p', { class: 'muted' }, 'No accessible services.'));
    return;
  }
  const candidateChars = new Set(candidates.flatMap((c) => [c.write.uuid, c.notify.uuid]));
  tree.replaceChildren(
    ...result.services.map((svc) =>
      h(
        'div',
        { class: 'svc' },
        h(
          'div',
          { class: 'svc-head' },
          h('span', { class: 'uuid' }, svc.uuid),
          svc.name ? h('span', { class: 'name' }, svc.name) : null,
          svc.error ? h('span', { class: 'error' }, svc.error) : null,
        ),
        ...svc.characteristics.map((c) => renderChar(c, candidateChars.has(c.uuid))),
      ),
    ),
  );
}

function renderChar(c: CharacteristicInfo, isCandidate: boolean): HTMLElement {
  const valueEl = h(
    'div',
    { class: 'val' },
    c.valueHex !== undefined ? `value: ${c.valueHex}  "${c.valueAscii}"` : c.readError ? `read error: ${c.readError}` : '',
  );
  const writeIn = h('input', { placeholder: 'text, or hex if "hex" is ticked', spellcheck: 'false' });
  const hexChk = h('input', { type: 'checkbox' });
  const ch = c.handle;
  const p = c.properties;

  const readBtn = p.read
    ? h('button', {
        class: 'small',
        onclick: async () => {
          try {
            const v = toBytes(await ch.readValue());
            valueEl.textContent = `value: ${formatValue(v)}`;
            eventLog(`Read ${shortUuid(c.uuid)}: ${formatValue(v)}`);
          } catch (e) {
            valueEl.textContent = `read error: ${errMsg(e)}`;
          }
        },
      }, 'Read')
    : null;

  const notifyBtn =
    p.notify || p.indicate
      ? h('button', {
          class: 'small',
          onclick: async (ev: Event) => {
            const btn = ev.currentTarget as HTMLButtonElement;
            if (consoleNotify === ch && consoleLink.connected) {
              // stopNotifications() here would also cut off the open test console.
              eventLog(`${shortUuid(c.uuid)} is in use by the test console; close the console to subscribe here.`, 'sys');
              return;
            }
            try {
              const existing = notifyListeners.get(ch);
              if (existing) {
                ch.removeEventListener('characteristicvaluechanged', existing);
                notifyListeners.delete(ch);
                await ch.stopNotifications();
                btn.textContent = 'Subscribe';
                eventLog(`Unsubscribed ${shortUuid(c.uuid)}`);
              } else {
                const fn = () => {
                  if (!ch.value) return;
                  const v = toBytes(ch.value);
                  valueEl.textContent = `notify: ${formatValue(v)}`;
                  eventLog(`Notify ${shortUuid(c.uuid)}: ${formatValue(v)}`);
                };
                ch.addEventListener('characteristicvaluechanged', fn);
                notifyListeners.set(ch, fn);
                await ch.startNotifications();
                btn.textContent = 'Unsubscribe';
                eventLog(`Subscribed ${shortUuid(c.uuid)}`);
              }
            } catch (e) {
              eventLog(`Notify ${shortUuid(c.uuid)}: ${errMsg(e)}`, 'err');
            }
          },
        }, 'Subscribe')
      : null;

  const canWrite = p.write || p.writeWithoutResponse;
  const writeBtn = canWrite
    ? h('button', {
        class: 'small',
        onclick: async () => {
          try {
            const bytes = hexChk.checked ? hexToBytes(writeIn.value) : textToBytes(writeIn.value);
            if (p.write) await ch.writeValueWithResponse(bytes);
            else await ch.writeValueWithoutResponse(bytes);
            eventLog(`Wrote ${shortUuid(c.uuid)}: ${bytesToHex(bytes)}`);
          } catch (e) {
            eventLog(`Write ${shortUuid(c.uuid)}: ${errMsg(e)}`, 'err');
          }
        },
      }, 'Write')
    : null;

  return h(
    'div',
    { class: 'char' },
    h(
      'div',
      { class: 'char-head' },
      h('span', { class: 'uuid' }, c.uuid),
      h('span', { class: 'flags', title: 'R=read W=write WnR=write-without-response N=notify I=indicate' }, propertyFlags(p)),
      c.name ? h('span', { class: 'name' }, c.name) : null,
      isCandidate ? h('span', { class: 'uart-badge' }, 'UART candidate') : null,
    ),
    valueEl,
    ...c.descriptors.map((d) =>
      h('div', { class: 'desc' }, `descriptor ${d.uuid}${d.valueHex ? `: ${d.valueHex} "${d.valueAscii}"` : ''}${d.error ? ` (${d.error})` : ''}`),
    ),
    h(
      'div',
      { class: 'actions' },
      readBtn,
      notifyBtn,
      canWrite ? writeIn : null,
      canWrite ? h('label', { class: 'chk' }, hexChk, 'hex') : null,
      writeBtn,
    ),
  );
}

// --------------------------------------------------------- test console ----

function renderCandidates(): void {
  const sel = el('pairSelect', HTMLSelectElement);
  sel.replaceChildren(
    ...(candidates.length
      ? candidates.map((c, i) => h('option', { value: i }, c.label))
      : [h('option', {}, 'No writable + notifying characteristic found')]),
  );
}

function consoleOpts() {
  return {
    chunkSize: Math.max(1, Number(input('chunkSize').value) || 20),
    interChunkDelayMs: Math.max(0, Number(input('chunkDelay').value) || 0),
    withoutResponse: input('wnr').checked,
  };
}

function applyConsoleSettings(): void {
  consoleLink.setUartOptions(consoleOpts());
  consoleLink.lineEnding = LINE_ENDINGS[el('lineEnding', HTMLSelectElement).value as LineEnding];
}

async function openConsole(): Promise<void> {
  await closeConsole();
  const idx = Number(el('pairSelect', HTMLSelectElement).value);
  const cand = candidates[idx];
  if (!cand || !device) return;
  // Release a manual tree subscription on the same characteristic to avoid double logging.
  const manual = notifyListeners.get(cand.notify);
  if (manual) {
    cand.notify.removeEventListener('characteristicvaluechanged', manual);
    notifyListeners.delete(cand.notify);
  }
  applyConsoleSettings();
  try {
    await consoleLink.attach(device, cand.write, cand.notify, cand.label);
    consoleNotify = cand.notify;
    consoleLine('sys', `Console open on ${cand.label}`);
  } catch (e) {
    consoleLine('sys', `Failed to start notifications: ${errMsg(e)}`, undefined, 'err');
  }
}

async function closeConsole(): Promise<void> {
  // Also while 'connecting': detach() cancels an attach that is still in progress.
  if (consoleLink.state === 'disconnected') return;
  await consoleLink.detach(); // the link's 'disconnected' state logs "Console closed"
}

function setConsoleUi(open: boolean): void {
  for (const id of ['sendBtn', 'sendPinBtn', 'cmdInput', 'closeConsoleBtn']) {
    (document.getElementById(id) as HTMLButtonElement).disabled = !open;
  }
  for (const b of $('quick').querySelectorAll('button')) (b as HTMLButtonElement).disabled = !open;
}

async function sendText(text: string, redact = false): Promise<void> {
  if (!consoleLink.connected) return;
  applyConsoleSettings();
  if (input('showHex').checked && !redact) eventLog(`TX ${bytesToHex(textToBytes(text + consoleLink.lineEnding))}`);
  try {
    // A PIN attempt must not trigger the automatic re-login (which would resend it after logging in).
    const r = await consoleLink.command(text, { redact, noRelogin: redact });
    // An accepted PIN typed into the command box: keep it (in memory) for redaction and automatic re-login.
    if (r.status === 'password-ok' && text !== input('pin').value.trim()) input('pin').value = text;
    if (r.status === 'timeout' && r.lines.length === 0) consoleLine('sys', 'No reply.');
  } catch (e) {
    consoleLine('sys', `Write failed: ${errMsg(e)}`, undefined, 'err');
  }
}

async function sendRaw(): Promise<void> {
  if (!consoleLink.connected) return;
  const cmd = input('cmdInput');
  const value = cmd.value;
  if (!value) return;
  if (input('cmdHex').checked) {
    try {
      const bytes = hexToBytes(value);
      applyConsoleSettings();
      // Same rule as text input: anything that is not an AT command may be the PIN, so hide text and hex.
      if (mayBePin(bytesToText(bytes), input('pin').value.trim())) consoleLine('tx', '[AT PIN redacted]');
      else consoleLine('tx', bytesToText(bytes), bytesToHex(bytes));
      await consoleLink.sendBytes(bytes);
    } catch (e) {
      consoleLine('sys', errMsg(e), undefined, 'err');
    }
  } else {
    // Like the terminal: anything that is not an AT command is treated as a possible PIN and hidden.
    const v = value.trim();
    await sendText(v, mayBePin(v, input('pin').value.trim()));
  }
  cmd.select();
}

// --------------------------------------------------------------- report ----

function redactOptions(): RedactOptions {
  return {
    pin: input('pin').value.trim() || undefined,
    redactIdentifiers: input('redactIds').checked,
    identifierLiterals: result?.deviceName ? [result.deviceName] : [],
  };
}

/**
 * Transcript with secrets removed: AT PIN, AppKey/NwkSKey/AppSKey (labelled, unlabelled
 * 16-byte hex, or the bare reply to a key query) and, optionally, DevEUI/AppEUI/DevAddr.
 * The on-screen console still shows real values; only exports are redacted.
 */
function redactedTranscript(): TranscriptEntry[] {
  const opts = redactOptions();
  const state: RedactState = {};
  return transcript.map((e) => {
    if (e.dir === 'sys') return e;
    const text = e.dir === 'tx' ? redactTx(e.text, opts, state) : redactRx(e.text, opts, state);
    return text === e.text ? e : { ...e, text, hex: undefined };
  });
}

function buildReport(): string {
  if (!result) return '';
  const opts = redactOptions();
  const base = JSON.parse(serialiseResult(result)) as DiscoveryResult;
  if (opts.redactIdentifiers) {
    if (base.deviceName) base.deviceName = '[REDACTED ID]';
    // Values read from the device (e.g. Device Name 0x2A00 = the DevEUI) and advertisement payloads can carry
    // identifiers too; hide any value that contains the device name, and the raw advertisement data.
    const names = opts.identifierLiterals ?? [];
    for (const svc of base.services) {
      for (const c of svc.characteristics) {
        const hit = c.uuid === '00002a00-0000-1000-8000-00805f9b34fb' ||
          names.some((n) => (c.valueAscii ?? '').includes(n) || redactLiteral(c.valueHex ?? '', n) !== (c.valueHex ?? ''));
        if (hit && (c.valueHex !== undefined || c.valueAscii !== undefined)) {
          c.valueHex = '[REDACTED ID]';
          c.valueAscii = '[REDACTED ID]';
        }
      }
    }
    if (base.advertisement) {
      base.advertisement.manufacturerData = base.advertisement.manufacturerData.map((m) => ({ ...m, hex: '[REDACTED ID]' }));
      base.advertisement.serviceData = base.advertisement.serviceData.map((d) => ({ ...d, hex: '[REDACTED ID]' }));
    }
  }
  return JSON.stringify(
    {
      ...base,
      redaction: {
        secrets: 'AT PIN, AppKey, NwkSKey, AppSKey and other 16-byte keys removed',
        identifiers: opts.redactIdentifiers ? 'DevEUI/AppEUI/DevAddr removed' : 'kept',
      },
      uartCandidates: candidates.map((c) => ({
        service: c.service,
        write: c.write.uuid,
        notify: c.notify.uuid,
        writeWithoutResponseOnly: c.writeWithoutResponse,
      })),
      consoleSettings: {
        ...consoleOpts(),
        lineEnding: el('lineEnding', HTMLSelectElement).value,
      },
      transcript: redactedTranscript(),
    },
    null,
    2,
  );
}

function updateReport(): void {
  const text = buildReport();
  $('report').textContent = text;
  el('copyReportBtn', HTMLButtonElement).disabled = !text;
  el('downloadReportBtn', HTMLButtonElement).disabled = !text;
}

// ---------------------------------------------------------------- wire up ----

/** Wire up the Discovery tab (element ids are defined in index.html). */
export function initDiscovery(main?: DraginoLink): { isConnected: () => boolean; onShown: () => void } {
  mainLink = main ?? null;
  consoleLink.pinProvider = () => input('pin').value.trim();
  consoleLink.on('line', (line) => consoleLine('rx', line));
  consoleLink.on('tx', (text, redacted) => consoleLine('tx', redacted ? '[AT PIN redacted]' : text));
  consoleLink.on('log', (msg) => consoleLine('sys', msg));
  consoleLink.on('rx', (bytes) => {
    if (input('showHex').checked) eventLog(`RX ${bytesToHex(bytes)}`);
  });
  let consoleWasOpen = false;
  consoleLink.on('state', (state) => {
    const open = state === 'locked' || state === 'ready';
    setConsoleUi(open);
    // No second Open while one is still being set up.
    el('openConsoleBtn', HTMLButtonElement).disabled = state === 'connecting' || !device?.gatt?.connected || candidates.length === 0;
    if (state === 'disconnected') {
      consoleNotify = null;
      // Only report "closed" for a console that was actually open (not after a failed open).
      if (consoleWasOpen) consoleLine('sys', 'Console closed');
    }
    consoleWasOpen = open;
  });

  el('extraUuids', HTMLTextAreaElement).value = storageGet('extraUuids');
  input('namePrefix').value = storageGet('namePrefix');

  $('scanBtn').addEventListener('click', scan);
  $('rescanBtn').addEventListener('click', async () => {
    try {
      await closeConsole();
      await discover();
    } catch (e) {
      setStatus(errMsg(e), 'err');
    }
  });
  $('disconnectBtn').addEventListener('click', disconnect);
  $('openConsoleBtn').addEventListener('click', openConsole);
  $('closeConsoleBtn').addEventListener('click', closeConsole);
  $('sendBtn').addEventListener('click', sendRaw);
  input('cmdInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendRaw();
  });
  $('sendPinBtn').addEventListener('click', () => {
    const pin = input('pin').value.trim();
    if (pin) sendText(pin, true);
  });
  $('quick').append(
    ...QUICK_COMMANDS.map((c) =>
      h('button', { class: 'small', disabled: true, onclick: () => sendText(c) }, c),
    ),
  );
  $('clearLogBtn').addEventListener('click', () => {
    $('consoleLog').replaceChildren();
    transcript.length = 0;
    updateReport();
  });
  $('saveLogBtn').addEventListener('click', () => {
    const prefix = { tx: '> ', rx: '< ', sys: '# ' } as const;
    const text = redactedTranscript()
      .map((e) => `${e.t} ${prefix[e.dir]}${e.text}${e.hex ? `   [${e.hex}]` : ''}`)
      .join('\n');
    downloadText(`dragino-console-${Date.now()}.txt`, `${text}\n`, 'text/plain');
  });
  $('copyReportBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(buildReport());
      eventLog('Report copied to clipboard');
    } catch (e) {
      eventLog(`Clipboard: ${errMsg(e)}`, 'err');
    }
  });
  $('downloadReportBtn').addEventListener('click', () => {
    const name = (result?.deviceName ?? 'device').replace(/[^\w-]+/g, '_');
    downloadText(`dragino-discovery-${name}.json`, buildReport());
  });
  input('pin').addEventListener('input', updateReport);
  input('redactIds').addEventListener('change', updateReport);

  checkSupport();
  return { isConnected: () => connectedHere, onShown: () => updateReport() };
}
