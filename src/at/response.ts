/**
 * Groups console lines into the response to one AT command.
 *
 * Dragino output is not strictly framed. The firmware may or may not echo the command, a value can arrive on its
 * own line or glued to the status ("0,0,0,0OK"), and some commands print many lines. So a response ends at the
 * first status line, or at a timeout.
 */

export type AtStatus =
  | 'ok'
  | 'error'
  | 'password-ok'
  | 'password-bad'
  | 'timeout'
  | 'disconnected';

export interface AtResult {
  command: string;
  status: AtStatus;
  /** Error token when status is 'error' (e.g. AT_PARAM_ERROR). */
  error?: string;
  /** Non-echo, non-status lines, in order. */
  lines: string[];
  /** Convenience: lines joined with '\n' and trimmed. */
  value: string;
}

const ERROR_RE = /^(AT_[A-Z_]*ERROR[A-Z_]*|AT_TEST_PARAM_OVERFLOW|AT_NO_NETWORK_JOINED|ERROR|Invalid command.*|Command not found.*)$/i;

export class ResponseCollector {
  readonly lines: string[] = [];
  private result?: AtResult;

  constructor(public readonly command: string) {}

  get done(): boolean {
    return this.result !== undefined;
  }

  /** Feed one line. Returns the result once the response is complete. */
  push(raw: string): AtResult | undefined {
    if (this.result) return this.result;
    const line = raw.trim();
    if (line === '') return undefined;
    if (line.toUpperCase() === this.command.trim().toUpperCase()) return undefined; // echo

    // PS-LB firmware v1.2 replies "Correct Password"; Devices.Tool checks for "Password Correct".
    if (/^(?:Password Correct|Correct Password)/i.test(line)) return this.finish('password-ok');
    if (/^(?:Incorrect Password|Password Incorrect|Password Error|Wrong Password)/i.test(line)) return this.finish('password-bad');
    if (line.toUpperCase() === 'OK') return this.finish('ok');
    const err = ERROR_RE.exec(line);
    if (err) return this.finish('error', err[1]);

    // Value glued to the status, e.g. "0,0,0,0OK" or "1200000 OK". Only numeric/hex-looking values qualify, so
    // text such as "Join OK" is not mistaken for a status.
    const glued = /^((?:AT\+[A-Z0-9_]+=)?[0-9A-Fa-f.,:\s-]*[0-9A-Fa-f])\s*OK$/i.exec(line);
    if (glued) {
      this.lines.push(glued[1]);
      return this.finish('ok');
    }
    this.lines.push(line);
    return undefined;
  }

  finish(status: AtStatus, error?: string): AtResult {
    this.result ??= {
      command: this.command,
      status,
      error,
      lines: [...this.lines],
      value: this.lines.join('\n').trim(),
    };
    return this.result;
  }
}

/**
 * Parse "AT+KEY=value" lines (AT+CFG output) into a map keyed by upper-case command name.
 * Lines that are not assignments are ignored.
 */
export function parseConfigDump(lines: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of lines) {
    const m = /^\s*AT\+([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(l);
    if (m && m[2] !== '?') out.set(m[1].toUpperCase(), m[2]);
  }
  return out;
}

/**
 * Parse the AT? help listing ("AT+TDC: Get or set …", "ATZ: Trig a reset") into a map from command name, upper-case
 * and without "AT+" ("TDC", "Z"), to the firmware's own description. Its keys are the commands this firmware has.
 */
export function parseHelpDescriptions(lines: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of lines) {
    const m = /^\s*AT\+?([A-Z0-9_]+)\s*:\s*(.*?)\s*$/i.exec(l);
    if (m) out.set(m[1].toUpperCase(), m[2]);
  }
  return out;
}

/** Extract the value from a query response, tolerating "AT+TDC=1200000" or bare "1200000". */
export function queryValue(cmd: string, result: AtResult): string | undefined {
  if (result.status !== 'ok' || result.lines.length === 0) return undefined;
  const name = cmd.toUpperCase();
  for (const l of result.lines) {
    const m = /^\s*(?:AT\+)?([A-Z0-9_]+)\s*[=:]\s*(.+)$/i.exec(l);
    if (m && m[1].toUpperCase() === name) return m[2].trim();
  }
  return result.lines[result.lines.length - 1].trim();
}

/**
 * True for AT commands ("AT", "ATZ", "AT?", "AT+..."). Anything else typed into a console is treated as a possible
 * PIN (2–8 characters) and hidden, even when the PIN field is empty.
 */
export function isAtCommand(text: string): boolean {
  return /^AT(?:[+?]|Z?$)/i.test(text.trim());
}

/**
 * Whether console input may be the AT PIN and must be hidden: it equals the known PIN, or it is not an AT command
 * at all (PINs are 2–8 characters and the PIN field may be empty). The one rule used by every console.
 */
export function mayBePin(text: string, pin: string): boolean {
  const t = text.trim();
  return (pin !== '' && t === pin) || !isAtCommand(t);
}
