/**
 * Terminal tab: send arbitrary AT commands and see everything the device prints.
 */
import { commandLines } from '../at/backup';
import { mayBePin } from '../at/response';
import type { DraginoLink } from '../device/link';
import type { DeviceProfile } from '../profiles/types';
import { redactRx, redactText, redactTx, type RedactOptions, type RedactState } from '../util/redact';
import { $, downloadText, h, input, storageGet, storageSet } from './dom';

interface Entry {
  t: Date;
  dir: 'tx' | 'rx' | 'sys';
  text: string;
  /** The rendered line, so a single entry can be updated without redrawing the terminal. */
  el?: HTMLElement;
}

/** Lines kept on screen and in the saved transcript; older ones are dropped in long sessions. */
const MAX_ENTRIES = 5000;

const HISTORY_KEY = 'termHistory';
const HISTORY_MAX = 100;

export interface TerminalDeps {
  link: DraginoLink;
  profile: DeviceProfile;
  getPin: () => string;
  /** Called with a PIN the user typed in the terminal and the sensor accepted (kept in memory for re-login). */
  setPin?: (pin: string) => void;
}

export function initTerminal({ link, profile, getPin, setPin }: TerminalDeps) {
  const term = $('term');
  const inputEl = $('termInput') as HTMLTextAreaElement;
  const sendBtn = $('termSend') as HTMLButtonElement;
  const entries: Entry[] = [];
  let history: string[] = loadHistory();
  let histIdx = history.length;
  let draft = '';
  let busy = false;

  function line(e: Entry): HTMLElement {
    const time = input('termTimestamps').checked ? `${e.t.toTimeString().slice(0, 8)} ` : '';
    const prefix = e.dir === 'tx' ? '> ' : e.dir === 'sys' ? '# ' : '';
    return h('span', { class: e.dir === 'rx' ? '' : e.dir }, h('span', { class: 'meta' }, time), `${prefix}${e.text}\n`);
  }

  function render(e: Entry): void {
    const atBottom = term.scrollTop + term.clientHeight >= term.scrollHeight - 4;
    e.el = line(e);
    term.append(e.el);
    if (atBottom) term.scrollTop = term.scrollHeight;
  }

  function add(dir: Entry['dir'], text: string): void {
    const e: Entry = { t: new Date(), dir, text };
    entries.push(e);
    render(e);
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES).forEach((old) => old.el?.remove());
  }

  link.on('line', (line) => add('rx', line));
  link.on('log', (msg) => add('sys', msg));
  link.on('tx', (text, redacted) => add('tx', redacted ? '[AT PIN]' : text));
  /** Names of devices connected in this session (the DevEUI), for redaction even after disconnecting. */
  const deviceNames = new Set<string>();
  link.on('state', (state, detail) => {
    if (state === 'connecting' && link.device?.name) deviceNames.add(link.device.name);
    const msg: Record<string, string> = {
      connecting: `Connecting to ${detail ?? 'device'}…`,
      locked: detail ? `Connected via ${detail}. Send the AT PIN to unlock the console.` : '',
      ready: 'Console unlocked.',
      disconnected: 'Disconnected.',
    };
    if (msg[state]) add('sys', msg[state]);
    setEnabled(link.connected);
  });

  /** While a run (e.g. a pasted restore) is in progress, nothing else may be sent, or commands would interleave. */
  function setEnabled(on: boolean): void {
    inputEl.disabled = !on;
    sendBtn.disabled = !on || busy;
    for (const b of $('snippets').querySelectorAll('button')) (b as HTMLButtonElement).disabled = !on || busy;
  }

  function loadHistory(): string[] {
    try {
      const v = JSON.parse(storageGet(HISTORY_KEY, '[]'));
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  function remember(cmd: string): void {
    // Never persist anything that would need redacting (PIN, keys).
    const opts: RedactOptions = { pin: getPin() || undefined, redactIdentifiers: false };
    if (redactTx(cmd, opts, {}) !== cmd) return;
    history = history.filter((c) => c !== cmd);
    history.push(cmd);
    if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
    storageSet(HISTORY_KEY, JSON.stringify(history));
    histIdx = history.length;
  }

  /** Remove a command from the persisted history (e.g. it turned out to be a PIN). */
  function forget(cmd: string): void {
    const before = history.length;
    history = history.filter((c) => c !== cmd);
    if (history.length !== before) {
      storageSet(HISTORY_KEY, JSON.stringify(history));
      histIdx = history.length;
    }
  }

  /** Replace the most recent TX entry with this text by the PIN placeholder and re-render. */
  function redactEntry(cmd: string): void {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].dir === 'tx' && entries[i].text === cmd) {
        const e: Entry = { ...entries[i], text: '[AT PIN]' };
        e.el = line(e);
        entries[i].el?.replaceWith(e.el);
        entries[i] = e;
        return;
      }
    }
  }

  /**
   * AT commands start with "AT"; anything else typed here is most likely the PIN (2–8 characters), even when the
   * connection bar's PIN field is empty. Such input is hidden on screen and never stored in history.
   */
  const looksLikePin = (cmd: string) => mayBePin(cmd, getPin());

  async function run(text: string): Promise<void> {
    const lines = commandLines(text); // skips blank lines and '#' comments (e.g. a settings backup)
    if (!lines.length || !link.connected || busy) return;
    busy = true;
    setEnabled(link.connected);
    try {
      for (let i = 0; i < lines.length; i++) {
        const cmd = lines[i];
        const isPin = looksLikePin(cmd);
        if (!isPin) remember(cmd);
        const isReset = /^ATZ$/i.test(cmd);
        // A PIN attempt must not trigger the automatic re-login, which would log in and then resend this input.
        const r = await link.command(cmd, { redact: isPin, noRelogin: isPin, timeoutMs: isReset ? 1500 : 4000 });
        if (r.status === 'password-ok') {
          // The sensor accepted this input as the PIN. Hide it if it was not hidden already, and keep it in memory
          // so the console can log in again by itself.
          if (!isPin) {
            forget(cmd);
            redactEntry(cmd);
          }
          if (cmd !== getPin()) setPin?.(cmd);
        }
        // 'password-bad' means the console is locked (a wrong PIN, or it re-locked and could not log in again). Every
        // further line would be treated as another wrong PIN attempt, so stop the rest of a pasted block here.
        if (r.status === 'password-bad') {
          const left = lines.length - i - 1;
          if (left > 0) add('sys', `Stopped: the console is locked, so the remaining ${left} line(s) were not sent. Log in and paste them again.`);
          break;
        }
        // After the PIN is changed on the device, keep the new one for automatic re-login.
        const newPin = /^AT\+PWORD=(.+)$/i.exec(cmd)?.[1]?.trim();
        if (newPin && r.status === 'ok') setPin?.(newPin);
        if (r.status === 'timeout' && r.lines.length === 0 && !isReset) add('sys', 'No reply.');
        if (r.status === 'disconnected') break;
      }
    } catch (e) {
      add('sys', `Send failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busy = false;
      setEnabled(link.connected);
    }
  }

  async function submit(): Promise<void> {
    const text = inputEl.value;
    if (!text.trim()) return;
    if (busy) {
      // Keep the text; sending now would interleave with the commands still running.
      add('sys', 'Busy: wait for the current commands to finish, then press Enter again.');
      return;
    }
    inputEl.value = '';
    draft = '';
    autoSize();
    await run(text);
    inputEl.focus();
  }

  function autoSize(): void {
    inputEl.rows = Math.min(8, Math.max(1, inputEl.value.split('\n').length));
  }

  inputEl.addEventListener('input', autoSize);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    } else if (e.key === 'ArrowUp' && !inputEl.value.includes('\n')) {
      if (histIdx === history.length) draft = inputEl.value;
      if (histIdx > 0) inputEl.value = history[--histIdx];
      e.preventDefault();
    } else if (e.key === 'ArrowDown' && !inputEl.value.includes('\n')) {
      if (histIdx < history.length) {
        histIdx++;
        inputEl.value = histIdx === history.length ? draft : history[histIdx];
      }
      e.preventDefault();
    }
  });
  sendBtn.addEventListener('click', () => void submit());

  $('snippets').append(
    ...profile.snippets.map((s) =>
      h('button', { class: 'small mono', title: s.title ?? s.command, disabled: true, onclick: () => void run(s.command) }, s.label),
    ),
  );

  $('termClear').addEventListener('click', () => {
    entries.length = 0;
    term.replaceChildren();
  });
  input('termTimestamps').addEventListener('change', () => {
    term.replaceChildren();
    entries.forEach(render);
  });
  $('termSave').addEventListener('click', () => {
    const opts: RedactOptions = {
      pin: getPin() || undefined,
      redactIdentifiers: input('termRedactIds').checked,
      identifierLiterals: [...deviceNames],
    };
    const state: RedactState = {};
    const text = entries
      .map((e) => {
        // Status lines are redacted too: e.g. "Connecting to <DevEUI>…".
        const body = e.dir === 'tx' ? redactTx(e.text, opts, state) : e.dir === 'rx' ? redactRx(e.text, opts, state) : redactText(e.text, opts);
        return `${e.t.toISOString()} ${e.dir === 'tx' ? '> ' : e.dir === 'sys' ? '# ' : '< '}${body}`;
      })
      .join('\n');
    downloadText(`dragino-terminal-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`, `${text}\n`, 'text/plain');
  });

  return { add, run };
}
