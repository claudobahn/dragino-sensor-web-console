/**
 * Minimal "serial over BLE" link: writes to one characteristic, listens for notifications on another. DraginoLink
 * uses it for the main connection and for the Discovery tab's test console (on any candidate pair).
 */
import { bytesToHex, chunk, toBytes } from '../util/bytes';

export interface UartOptions {
  write: BluetoothRemoteGATTCharacteristic;
  notify: BluetoothRemoteGATTCharacteristic;
  /** Max bytes per GATT write. 20 is the safe default (ATT MTU 23). */
  chunkSize: number;
  /** Prefer write-without-response if supported. */
  withoutResponse: boolean;
  /** Delay between chunks, ms (some modules drop data if written too fast). */
  interChunkDelayMs: number;
}

export type RxHandler = (bytes: Uint8Array, text: string) => void;

export class BleUart {
  private rxHandlers = new Set<RxHandler>();
  private started = false;
  private readonly decoder = new TextDecoder('utf-8');
  /** Bumped by stop(), so a start() that finishes after a stop() does not mark itself started. */
  private generation = 0;
  private readonly onValue = (ev: Event) => {
    const ch = ev.target as BluetoothRemoteGATTCharacteristic;
    if (!ch.value) return;
    const bytes = new Uint8Array(toBytes(ch.value)); // copy: the DataView may be reused
    // Streaming decode: a multi-byte character (e.g. "µ") can be split across two 20-byte notifications.
    const text = this.decoder.decode(bytes, { stream: true });
    for (const h of this.rxHandlers) h(bytes, text);
  };

  constructor(public opts: UartOptions) {}

  onRx(h: RxHandler): () => void {
    this.rxHandlers.add(h);
    return () => this.rxHandlers.delete(h);
  }

  async start(): Promise<void> {
    if (this.started) return;
    const gen = this.generation;
    this.opts.notify.addEventListener('characteristicvaluechanged', this.onValue);
    try {
      await this.opts.notify.startNotifications();
    } catch (e) {
      // Do not leave a listener behind on a characteristic we failed to subscribe to.
      this.opts.notify.removeEventListener('characteristicvaluechanged', this.onValue);
      throw e;
    }
    if (gen !== this.generation) {
      // stop() ran while subscribing (e.g. a timeout). The subscription has now succeeded anyway, so undo it on the
      // device too; stop() already removed the listener.
      try {
        await this.opts.notify.stopNotifications();
      } catch {
        // Device may already be disconnected.
      }
      return;
    }
    this.started = true;
  }

  async stop(): Promise<void> {
    // Always remove the listener (also if start() is still pending or failed); removing twice is harmless.
    this.generation++;
    this.opts.notify.removeEventListener('characteristicvaluechanged', this.onValue);
    if (!this.started) return;
    this.started = false;
    try {
      await this.opts.notify.stopNotifications();
    } catch {
      // Device may already be disconnected.
    }
  }

  async send(bytes: Uint8Array, log?: (msg: string) => void): Promise<void> {
    const { write, chunkSize, withoutResponse, interChunkDelayMs } = this.opts;
    const canWnR = write.properties.writeWithoutResponse;
    const canW = write.properties.write;
    for (const part of chunk(bytes, chunkSize)) {
      // Copy into a standalone buffer: some Chrome versions mishandle subarray views.
      const buf = part.slice();
      if ((withoutResponse && canWnR) || !canW) await write.writeValueWithoutResponse(buf);
      else await write.writeValueWithResponse(buf);
      log?.(`→ ${bytesToHex(buf)}`);
      if (interChunkDelayMs > 0) await new Promise((r) => setTimeout(r, interChunkDelayMs));
    }
  }
}
