/**
 * Redaction of secrets from console transcripts before they are exported.
 *
 * Secret on a Dragino LoRaWAN node:
 *  - the BLE AT PIN (and AT+PWORD, which sets it)
 *  - AppKey (OTAA root key), NwkSKey and AppSKey (ABP / session keys)
 *  - for LoRaWAN 1.1-style firmware: NwkKey, FNwkSIntKey, SNwkSIntKey, NwkSEncKey
 *
 * Identifiers, not secrets (DevEUI is the BLE name, so it is broadcast anyway):
 *  - DevEUI, AppEUI/JoinEUI, DevAddr. They are optionally redacted for people who
 *    want to share reports publicly without linking them to a device.
 */

const SECRET_COMMANDS = [
  'APPKEY',
  'NWKKEY',
  'NWKSKEY',
  'APPSKEY',
  'FNWKSINTKEY',
  'SNWKSINTKEY',
  'NWKSENCKEY',
  'PWORD',
];
const ID_COMMANDS = ['DEUI', 'APPEUI', 'JOINEUI', 'DADDR'];

export interface RedactOptions {
  pin?: string;
  redactIdentifiers: boolean;
  /** Known identifier strings (e.g. the DevEUI used as the BLE name) to hide when redactIdentifiers is set. */
  identifierLiterals?: string[];
}

export interface RedactState {
  /** Set after a query like "AT+APPKEY=?" so the bare value line that follows is hidden. */
  pendingQuery?: 'secret' | 'id';
  /** The query text, so an echo of it is not mistaken for the reply. */
  pendingText?: string;
}

/** "AT+APPKEY: Get or Set the Application Key" (AT? help text) is a description, not a value. */
const isHelpText = (sep: string, value: string) => sep.includes(':') && /\b(get|set|print|clear)\b/i.test(value);

function cmdRegex(names: string[]): RegExp {
  // Matches "AT+APPKEY=<value>", "AT+APPKEY:<value>", "APPKEY = <value>" etc.
  // Value runs to end of line. The command name must not be followed by another letter.
  // The name must start a word ("AT+APPKEY=", " APPKEY:"), so e.g. "GPIO_APPKEYX" or "…xpin:" never match.
  return new RegExp(`(?<![A-Z0-9_])((?:AT\\+)?(?:${names.join('|')}))(?![A-Z])(\\s*[=:]\\s*)(?!\\?)(.+)$`, 'i');
}

const SECRET_ASSIGN = cmdRegex(SECRET_COMMANDS);
const ID_ASSIGN = cmdRegex(ID_COMMANDS);
const SECRET_QUERY = new RegExp(`^\\s*AT\\+(${SECRET_COMMANDS.join('|')})\\s*=\\s*\\?\\s*$`, 'i');
const ID_QUERY = new RegExp(`^\\s*AT\\+(${ID_COMMANDS.join('|')})\\s*=\\s*\\?\\s*$`, 'i');

/** 16 bytes of hex (a key): 32 contiguous digits, or 16 pairs separated by single spaces/colons. */
const KEY_HEX = /\b[0-9a-f]{32}\b|\b[0-9a-f]{2}(?:[ :][0-9a-f]{2}){15}\b/gi;

const isBlank = (s: string) => s.trim() === '';
const isStatusLine = (s: string) => /^\s*(OK|ERROR|AT_[A-Z_]+|(?:Password Correct|Correct Password)|(?:Incorrect Password|Password Incorrect|Password Error|Wrong Password))\s*$/i.test(s);

function replacePin(text: string, pin?: string): string {
  return pin ? text.split(pin).join('[PIN]') : text;
}

/** Redact a command typed by the user (TX direction). Updates `state` for the reply. */
export function redactTx(text: string, opts: RedactOptions, state: RedactState): string {
  state.pendingQuery = SECRET_QUERY.test(text) ? 'secret' : ID_QUERY.test(text) ? 'id' : undefined;
  state.pendingText = state.pendingQuery ? text.trim().toUpperCase() : undefined;
  return redactCommon(text, opts);
}

/** Redact a line received from the device (RX direction). */
export function redactRx(text: string, opts: RedactOptions, state: RedactState): string {
  // Some firmware echoes the command; the echo must not use up the pending query, or the real value slips through.
  const isEcho = state.pendingText !== undefined && text.trim().toUpperCase() === state.pendingText;
  if (state.pendingQuery && !isBlank(text) && !isStatusLine(text) && !isEcho) {
    const kind = state.pendingQuery;
    state.pendingQuery = undefined;
    if (kind === 'secret') return '[REDACTED]';
    if (opts.redactIdentifiers) return '[REDACTED ID]';
  }
  if (isStatusLine(text)) state.pendingQuery = undefined;
  return redactCommon(text, opts);
}

function redactCommon(text: string, opts: RedactOptions): string {
  // Keys and labelled values first: replacing a (possibly 2-character) PIN first could split a key so that the
  // 16-byte pattern no longer matches.
  let out = text.replace(SECRET_ASSIGN, (m, cmd: string, sep: string, value: string) =>
    isHelpText(sep, value) ? m : `${cmd}${sep}[REDACTED]`,
  );
  if (opts.redactIdentifiers) {
    out = out.replace(ID_ASSIGN, (m, cmd: string, sep: string, value: string) =>
      isHelpText(sep, value) ? m : `${cmd}${sep}[REDACTED ID]`,
    );
  }
  // Catch-all: anything shaped like a 128-bit key, whatever label (or none) it has.
  out = out.replace(KEY_HEX, '[REDACTED KEY]');
  if (opts.redactIdentifiers) {
    for (const lit of opts.identifierLiterals ?? []) out = redactLiteral(out, lit);
  }
  return replacePin(out, opts.pin);
}

/** Redact a line that is neither a command nor its reply (e.g. a status message mentioning the device). */
export function redactText(text: string, opts: RedactOptions): string {
  return redactCommon(text, opts);
}

/** Replace an identifier wherever it appears, ignoring case and byte separators. */
export function redactLiteral(text: string, literal: string): string {
  const hex = literal.replace(/[\s:\-]/g, '');
  if (hex.length < 4) return text;
  if (/^[0-9a-f]+$/i.test(hex) && hex.length % 2 === 0) {
    const pairs = hex.match(/../g)!.join('[\\s:\\-]?');
    return text.replace(new RegExp(pairs, 'gi'), '[REDACTED ID]');
  }
  return text.split(literal).join('[REDACTED ID]');
}
