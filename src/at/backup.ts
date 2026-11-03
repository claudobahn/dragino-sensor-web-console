/**
 * Settings backup: turns AT+CFG output into a text file that is both a record and a restore script.
 *
 * Every line except the restore commands starts with '#', so the file can be pasted straight into the terminal,
 * which skips comment lines and runs the commands one at a time.
 *
 * The backup is NOT redacted. It contains the LoRaWAN keys and the AT PIN, because a backup without them cannot
 * restore the device.
 */
import { parseConfigDump } from './response';

/** Read-only, status, counter or action commands that must not be replayed. */
const NEVER_RESTORE = new Set([
  'VER', 'NJS', 'RECV', 'RECVB', 'SNR', 'RSSI', 'TIMESTAMP', 'UUID', 'CFG', 'DEBUG', 'JOIN', 'SLEEP',
  // Frame counters: replaying old values after a rejoin would break the network session.
  'FCU', 'FCD',
]);

/** OTAA session values: derived at join, so only restored for ABP devices (NJM=0). */
const ABP_SESSION = new Set(['DADDR', 'APPSKEY', 'NWKSKEY']);

/** Commands whose values are secret, called out in the file so the reader knows what to protect. */
const SECRET = new Set(['APPKEY', 'APPSKEY', 'NWKSKEY', 'PWORD']);

/** Settings that change how the device joins or the PIN; restored last so a mistake is easy to spot. */
const RESTORE_LAST = ['DEUI', 'APPEUI', 'APPKEY', 'NJM'];

export interface BackupInput {
  cfgLines: string[];
  deviceName?: string;
  date?: Date;
}

export interface Backup {
  text: string;
  /** Number of AT+KEY=value lines found in the dump. */
  settingCount: number;
  restoreCount: number;
  firmware?: string;
}

export function buildBackup({ cfgLines, deviceName, date = new Date() }: BackupInput): Backup {
  const dump = parseConfigDump(cfgLines);
  if (dump.size === 0) throw new Error('No settings found in the AT+CFG output.');
  const firmware = dump.get('VER');
  const abp = dump.get('NJM') === '0';

  const restore: string[] = [];
  const skipped: string[] = [];
  const later: string[] = [];
  for (const [cmd, value] of dump) {
    const line = `AT+${cmd}=${value}`;
    if (NEVER_RESTORE.has(cmd)) skipped.push(`#   ${line}    (read-only or status)`);
    else if (ABP_SESSION.has(cmd) && !abp) skipped.push(`#   ${line}    (OTAA session value, set at join)`);
    else if (cmd === 'PWORD') skipped.push(`#   ${line}    (AT PIN: remove the leading "# " below to restore it)`);
    else if (RESTORE_LAST.includes(cmd)) later.push(line);
    else restore.push(line);
  }
  later.sort((a, b) => RESTORE_LAST.indexOf(a.slice(3).split('=')[0]) - RESTORE_LAST.indexOf(b.slice(3).split('=')[0]));

  const secrets = [...dump.keys()].filter((k) => SECRET.has(k)).map((k) => `AT+${k}`);
  const pword = dump.get('PWORD');
  const text = [
    '# Dragino sensor settings backup',
    `# Device:   ${deviceName ?? 'unknown'}`,
    `# Firmware: ${firmware ?? 'unknown'}`,
    `# Saved:    ${date.toISOString()}`,
    '#',
    `# !! CONTAINS SECRETS (${secrets.join(', ') || 'none found'}). Store it privately; do not share or commit it.`,
    '#',
    '# To restore: connect, log in, review the commands below, then paste this whole file into the terminal.',
    '# Lines starting with # are ignored. Finish with ATZ so every setting takes effect.',
    '# Some values may not be accepted by a different firmware version; check the terminal for AT_PARAM_ERROR.',
    '#',
    '# ---- Not restored ----',
    ...skipped,
    '#',
    '# ---- Restore: device settings ----',
    ...restore,
    '#',
    '# ---- Restore: LoRaWAN identity and join mode ----',
    ...later,
    ...(pword !== undefined ? ['#', '# ---- Optional: AT PIN ----', `# AT+PWORD=${pword}`] : []),
    '#',
    '# ---- Raw AT+CFG output ----',
    ...cfgLines.map((l) => `# ${l}`.trimEnd()),
    '',
  ].join('\n');

  return { text, settingCount: dump.size, restoreCount: restore.length + later.length, firmware };
}

/** Terminal input: drop blank lines and '#' comments. */
export function commandLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}
