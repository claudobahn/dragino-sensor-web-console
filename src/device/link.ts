/**
 * A connection to a Dragino sensor's BLE AT console.
 *
 * - Connects to service 0xFFE0 / characteristic 0xFFE1, as Dragino's Devices.Tool does, falling back to 0xFF00 /
 *   0xFF01 and then to any write+notify pair.
 * - Emits every received line (for the terminal), and runs AT commands one at a time, collecting each response.
 */
import { enumerate, findUartCandidates, requestDevice } from '../ble/discovery';
import { DRAGINO_CHARACTERISTIC, DRAGINO_SERVICE, uuid16 } from '../ble/known-uuids';
import { BleUart, type UartOptions } from '../ble/uart';
import { textToBytes } from '../util/bytes';
import { TimedLineBuffer } from '../util/line-buffer';
import { ResponseCollector, type AtResult } from '../at/response';

export type LinkUartOptions = Pick<UartOptions, 'chunkSize' | 'withoutResponse' | 'interChunkDelayMs'>;

export type LinkState = 'disconnected' | 'connecting' | 'locked' | 'ready';

export interface LinkEvents {
  line: (line: string) => void;
  /** Raw received bytes, before line assembly (for hex views). */
  rx: (bytes: Uint8Array) => void;
  /** Progress / diagnostic messages (connection steps, timeouts). */
  log: (msg: string) => void;
  tx: (text: string, redacted: boolean) => void;
  state: (state: LinkState, detail?: string) => void;
}

export interface CommandOptions {
  /** Give up if nothing at all is received within this long (ms). */
  timeoutMs?: number;
  /** Once output has started, finish after this much silence without a status line (ms). */
  idleMs?: number;
  /** Absolute cap on how long a command may run (ms). AT? and AT+CFG print for several seconds. */
  maxMs?: number;
  /** Do not show the command text in the TX log (e.g. the PIN). */
  redact?: boolean;
  /** Do not log in again and retry if the console has locked itself (used by login itself). */
  noRelogin?: boolean;
}


/** Chrome can wait indefinitely in gatt.connect() if the sensor has stopped advertising. */
export const CONNECT_TIMEOUT_MS = 15000;
const STEP_TIMEOUT_MS = 10000;

export const CONNECT_HINT =
  'Press the sensor button briefly to turn Bluetooth back on (it switches off 60 s after the last press when nothing is ' +
  'connected). Also make sure no phone app or other browser tab is still connected to it, then try again.';

export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${ms / 1000} s.`);
    this.name = 'TimeoutError';
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(what, ms)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export class DraginoLink {
  device: BluetoothDevice | null = null;
  state: LinkState = 'disconnected';
  /** "FFE0/FFE1" etc., for display. */
  channel = '';
  lineEnding = '\r\n';
  /** Write settings for the serial channel (20-byte chunks, 20 ms apart, as for Dragino's DX-BT24 module). */
  uartOptions: LinkUartOptions = {
    chunkSize: 20,
    withoutResponse: true,
    interChunkDelayMs: 20,
  };
  /**
   * Supplies the AT PIN (kept in memory by the UI) so the link can log in again when the console locks itself
   * after inactivity. Returns '' if unknown.
   */
  pinProvider: () => string = () => '';

  private uart: BleUart | null = null;
  private lines = new TimedLineBuffer((line) => this.onLine(line));
  private collector: ResponseCollector | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** Resolves the command currently waiting for a reply (used to end it at once on disconnect). */
  private pendingEnd: ((r: AtResult) => void) | null = null;
  /**
   * Bumped by every connect/attach/detach. A connection attempt is only "current" while its number is the latest,
   * so a detach() (or a newer attempt on the same device object) cancels it.
   */
  private attemptId = 0;
  /** Why the last in-progress attempt was abandoned: the user (detach/disconnect) or the device dropping. */
  private abortReason: 'user' | 'dropped' = 'user';
  /** After a command timed out, its reply may still arrive; wait for that before the next command (see runCommand). */
  private settleAfterTimeout = false;
  private lastRxAt = 0;
  private listeners: { [K in keyof LinkEvents]: Set<LinkEvents[K]> } = {
    line: new Set(),
    rx: new Set(),
    tx: new Set(),
    log: new Set(),
    state: new Set(),
  };

  on<K extends keyof LinkEvents>(ev: K, fn: LinkEvents[K]): () => void {
    this.listeners[ev].add(fn);
    return () => this.listeners[ev].delete(fn);
  }

  private emit<K extends keyof LinkEvents>(ev: K, ...args: Parameters<LinkEvents[K]>): void {
    for (const fn of this.listeners[ev]) (fn as (...a: Parameters<LinkEvents[K]>) => void)(...args);
  }

  private setState(s: LinkState, detail?: string): void {
    this.state = s;
    this.emit('state', s, detail);
  }

  get connected(): boolean {
    return this.state !== 'disconnected' && this.state !== 'connecting';
  }

  /** Ask the user to pick a device, then connect. */
  async requestAndConnect(namePrefix?: string): Promise<void> {
    await this.connect(await requestDevice({ namePrefix, extraServices: [] }));
  }

  /**
   * Start a connection attempt on `device`. Disconnect()/detach(), a newer attempt or the device dropping all make it
   * stale; `ensureCurrent` throws once that has happened, and `fail` turns whatever error ended the attempt into the
   * right one to report (cancelled by the user, dropped by the sensor, or timed out).
   */
  private beginAttempt(device: BluetoothDevice, label: string) {
    const id = ++this.attemptId;
    this.device = device;
    device.addEventListener('gattserverdisconnected', this.onGattDisconnected);
    this.setState('connecting', label);
    const superseded = () => this.attemptId !== id;
    return {
      /** True once this attempt has been replaced (disconnect, newer attempt or device drop). */
      isStale: superseded,
      ensureCurrent: () => {
        if (superseded()) throw new DOMException('Connection cancelled', 'AbortError');
      },
      /** Clean up after a failed attempt and return the error to throw. */
      fail: (e: unknown): unknown => {
        if (!superseded()) {
          this.uart = null;
          this.cleanup();
          if (e instanceof TimeoutError) return new Error(`${e.message} ${CONNECT_HINT}`);
          return e;
        }
        // A Disconnect press makes pending GATT calls fail; that is a cancellation. A device that dropped out during
        // setup is a real failure, though.
        return this.abortReason === 'user'
          ? new DOMException('Connection cancelled', 'AbortError')
          : new Error(`The sensor disconnected during setup. ${CONNECT_HINT}`);
      },
    };
  }

  async connect(device: BluetoothDevice): Promise<void> {
    await this.disconnect();
    // Let a gattserverdisconnected event queued by that disconnect be delivered now, while no listener is attached,
    // so it cannot cancel the new attempt on the same device object.
    await new Promise((r) => setTimeout(r, 0));
    const attempt = this.beginAttempt(device, device.name ?? device.id);
    try {
      if (!device.gatt) throw new Error('Device has no GATT server');
      this.emit('log', 'Opening Bluetooth connection…');
      const server = await withTimeout(device.gatt.connect(), CONNECT_TIMEOUT_MS, 'Bluetooth connection');
      attempt.ensureCurrent();
      this.emit('log', 'Connected. Looking for the AT console (FFE0/FFE1)…');
      const { write, notify, channel } = await withTimeout(this.findChannel(server), STEP_TIMEOUT_MS, 'Service discovery');
      attempt.ensureCurrent();
      this.emit('log', `Found ${channel}. Enabling notifications…`);
      await this.openChannel(write, notify, channel, attempt.ensureCurrent);
    } catch (e) {
      const stale = attempt.isStale();
      const err = attempt.fail(e);
      // Only drop the connection for a current attempt: a stale one may share the device object with a newer,
      // working connection (and was already disconnected by whatever replaced it).
      if (!stale) device.gatt?.disconnect();
      throw err;
    }
  }

  /**
   * Use a specific write/notify pair on a device that is already connected (e.g. one chosen in the Discovery tab).
   * The Bluetooth connection itself is left alone by detach().
   */
  async attach(device: BluetoothDevice, write: BluetoothRemoteGATTCharacteristic, notify: BluetoothRemoteGATTCharacteristic, channel: string): Promise<void> {
    await this.detach();
    const attempt = this.beginAttempt(device, channel);
    try {
      await this.openChannel(write, notify, channel, attempt.ensureCurrent);
    } catch (e) {
      throw attempt.fail(e);
    }
  }

  /** Subscribe to the channel and become 'locked'. this.uart is only set once the channel is fully open. */
  private async openChannel(
    write: BluetoothRemoteGATTCharacteristic,
    notify: BluetoothRemoteGATTCharacteristic,
    channel: string,
    ensureCurrent: () => void,
  ): Promise<void> {
    const uart = new BleUart({ write, notify, ...this.uartOptions });
    const lines = new TimedLineBuffer((line) => this.onLine(line));
    uart.onRx((bytes, text) => {
      this.lastRxAt = Date.now();
      this.emit('rx', bytes);
      lines.push(text);
    });
    try {
      await withTimeout(uart.start(), STEP_TIMEOUT_MS, 'Enabling notifications');
      ensureCurrent();
    } catch (e) {
      await uart.stop();
      throw e;
    }
    this.channel = channel;
    this.lines = lines;
    this.uart = uart;
    this.setState('locked', channel);
  }

  /** Change chunk size / write mode / delay; applies to the open channel too. */
  setUartOptions(opts: Partial<LinkUartOptions>): void {
    Object.assign(this.uartOptions, opts);
    if (this.uart) Object.assign(this.uart.opts, opts);
  }

  /** Write raw bytes (no line ending), e.g. hex typed in the Discovery console. */
  sendBytes(bytes: Uint8Array): Promise<void> {
    // Through the command queue, so raw bytes never go out in the middle of a running command.
    const run = async () => {
      if (!this.uart) throw new Error('Not connected');
      await this.uart.send(bytes);
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async findChannel(server: BluetoothRemoteGATTServer) {
    const tryPair = async (svc: string, ch: string) => {
      try {
        const s = await server.getPrimaryService(svc);
        const c = await s.getCharacteristic(ch);
        return { write: c, notify: c };
      } catch (e) {
        // NotFoundError means this service/characteristic does not exist. Anything else (e.g. NetworkError after a
        // disconnect) is a real failure and must not be mistaken for "try the next channel".
        if (e instanceof DOMException && e.name === 'NotFoundError') return null;
        throw e;
      }
    };
    const primary = await tryPair(DRAGINO_SERVICE, DRAGINO_CHARACTERISTIC);
    if (primary) return { ...primary, channel: 'FFE0/FFE1' };
    const alt = await tryPair(uuid16(0xff00), uuid16(0xff01));
    if (alt) return { ...alt, channel: 'FF00/FF01' };
    // enumerate() logs and swallows errors; check first that listing services works at all, so a real GATT failure
    // (e.g. NetworkError after a disconnect) is reported as such and not as "no serial characteristic".
    try {
      await server.getPrimaryServices();
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'NotFoundError')) throw e;
    }
    const services = await enumerate(server, () => undefined, false);
    const cand = findUartCandidates(services)[0];
    if (!cand) {
      throw new Error('No serial-style characteristic found. Use the Discovery tab to inspect this device.');
    }
    return { write: cand.write, notify: cand.notify, channel: cand.label };
  }

  /** Stop using the serial channel without dropping the Bluetooth connection. */
  async detach(): Promise<void> {
    this.attemptId++; // cancels a connect/attach that is still in progress
    this.abortReason = 'user';
    const uart = this.uart;
    this.uart = null;
    if (uart) {
      try {
        await withTimeout(uart.stop(), 2000, 'Stopping notifications');
      } catch {
        // Ignore: the link may already be dead.
      }
    }
    this.cleanup();
  }

  async disconnect(): Promise<void> {
    const dev = this.device;
    await this.detach();
    // Also cancels a connection attempt that is still in progress.
    dev?.gatt?.disconnect();
  }

  private readonly onGattDisconnected = () => {
    this.attemptId++; // the device went away: a connect/attach still in progress must not carry on
    this.abortReason = 'dropped';
    this.cleanup();
  };

  private cleanup(): void {
    this.lines.flush();
    this.settleAfterTimeout = false; // a late reply can't arrive on the next connection
    this.device?.removeEventListener('gattserverdisconnected', this.onGattDisconnected);
    this.uart = null;
    if (this.collector) {
      const r = this.collector.finish('disconnected');
      this.pendingEnd?.(r); // resolve the waiting command now instead of after its timeout
    }
    this.collector = null;
    if (this.state !== 'disconnected') this.setState('disconnected');
    this.device = null;
  }

  private onLine(line: string): void {
    this.collector?.push(line); // before listeners, so command() sees completion
    this.emit('line', line);
  }

  /** Write text plus the line ending without waiting for a response. */
  async sendRaw(text: string, redact = false): Promise<void> {
    if (!this.uart) throw new Error('Not connected');
    this.emit('tx', text, redact);
    await this.uart.send(textToBytes(text + this.lineEnding));
  }

  /**
   * Send a command and resolve with its response. Commands are serialised: a command
   * waits until the previous one has finished.
   */
  command(cmd: string, opts: CommandOptions = {}): Promise<AtResult> {
    const run = () => this.runWithRelogin(cmd, opts);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /**
   * The console locks itself again after under a minute without commands, even while BLE stays connected. A locked
   * console treats any input as a PIN attempt and replies "Incorrect Password" without running the command. In that
   * case, log in again once with the known PIN and retry. The retry is safe because the first attempt was not run.
   */
  private async runWithRelogin(cmd: string, opts: CommandOptions): Promise<AtResult> {
    const r = await this.runCommand(cmd, opts);
    const pin = this.pinProvider();
    if (r.status !== 'password-bad' || opts.noRelogin || cmd === pin) return r;
    this.setState('locked');
    if (!pin) {
      this.emit('log', 'The console locked itself after a period of inactivity. Enter the AT PIN and log in again.');
      return r;
    }
    this.emit('log', 'The console locked itself after a period of inactivity. Logging in again…');
    const login = await this.runCommand(pin, { redact: true, timeoutMs: 3000 });
    if (login.status !== 'password-ok') {
      this.emit('log', 'Automatic login failed. Check the AT PIN.');
      return r;
    }
    return this.runCommand(cmd, opts);
  }

  /**
   * After a timeout the device may still be answering the old command. Give it a grace period and wait for the line to
   * go quiet, so a late reply is shown in the terminal but not taken as this command's response.
   */
  private async settle(): Promise<void> {
    if (!this.settleAfterTimeout) return;
    this.settleAfterTimeout = false;
    const start = Date.now();
    const GRACE_MS = 1500;
    const QUIET_MS = 500;
    const MAX_MS = 4000;
    while (this.uart && Date.now() - start < MAX_MS) {
      const now = Date.now();
      if (now - start >= GRACE_MS && now - this.lastRxAt >= QUIET_MS) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private async runCommand(cmd: string, opts: CommandOptions): Promise<AtResult> {
    const { timeoutMs = 4000, idleMs = 1500, maxMs = 20000, redact = false } = opts;
    const collector = new ResponseCollector(cmd);
    await this.settle();
    if (!this.uart) return collector.finish('disconnected');
    this.collector = collector;
    let end!: (r: AtResult) => void;
    const done = new Promise<AtResult>((resolve) => {
      // finish() returns the existing result if the collector already completed.
      const timeout = () => end(collector.finish('timeout'));
      let waitTimer = setTimeout(timeout, timeoutMs); // first reply, then idle gap
      const maxTimer = setTimeout(timeout, maxMs);
      const unsub = this.on('line', () => {
        if (collector.done) return end(collector.finish('ok'));
        clearTimeout(waitTimer);
        waitTimer = setTimeout(timeout, idleMs);
      });
      // Any received bytes (even an unterminated line still being assembled) show the device is answering.
      const unsubRx = this.on('rx', () => {
        clearTimeout(waitTimer);
        waitTimer = setTimeout(timeout, idleMs);
      });
      end = (r: AtResult) => {
        clearTimeout(waitTimer);
        clearTimeout(maxTimer);
        unsub();
        unsubRx();
        resolve(r);
      };
    });
    this.pendingEnd = end;
    try {
      try {
        await this.sendRaw(cmd, redact);
      } catch (e) {
        end(collector.finish('disconnected'));
        throw e;
      }
      const result = await done;
      // Only a command that got no reply at all may still be answered late; one that went quiet after output is done.
      if (result.status === 'timeout' && result.lines.length === 0) this.settleAfterTimeout = true;
      if (result.status === 'password-ok') this.setState('ready');
      return result;
    } finally {
      if (this.collector === collector) this.collector = null;
      if (this.pendingEnd === end) this.pendingEnd = null;
    }
  }

  /**
   * Send the AT PIN. Resolves true on "Correct Password" (or "Password Correct").
   *
   * The console stays unlocked across BLE reconnects (until the sensor sleeps or resets). An unlocked console treats
   * the PIN as an unknown AT command and answers AT_ERROR, so on an error reply we check with a harmless query.
   */
  async login(pin: string): Promise<boolean> {
    const r = await this.command(pin, { redact: true, timeoutMs: 3000, noRelogin: true });
    if (r.status === 'password-ok') return true;
    if (r.status === 'error') {
      const probe = await this.command('AT+VER=?', { timeoutMs: 3000, noRelogin: true });
      if (probe.status === 'ok') {
        this.emit('log', 'The console was still unlocked from an earlier connection, so no PIN was needed.');
        this.setState('ready');
        return true;
      }
    }
    return false;
  }
}
