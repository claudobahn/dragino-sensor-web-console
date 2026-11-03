import { describe, expect, it } from 'vitest';
import { DraginoLink } from '../src/device/link';

const FFE0 = '0000ffe0-0000-1000-8000-00805f9b34fb';
const FFE1 = '0000ffe1-0000-1000-8000-00805f9b34fb';

/** Minimal fake BLE device whose startNotifications() we control. */
function fakeDevice() {
  const listeners = new Set<unknown>();
  let rejectStart!: (e: unknown) => void;
  const pendingStarts: (() => void)[] = [];
  const ch = Object.assign(new EventTarget(), {
    uuid: FFE1,
    properties: { write: true, writeWithoutResponse: true, notify: true },
    startNotifications: () => new Promise((res, rej) => { rejectStart = rej; pendingStarts.push(() => res(undefined)); }),
    stopNotifications: async () => undefined,
    writeValueWithoutResponse: async () => undefined,
  });
  const add = ch.addEventListener.bind(ch);
  const remove = ch.removeEventListener.bind(ch);
  ch.addEventListener = ((t: string, f: EventListener) => {
    if (t === 'characteristicvaluechanged') listeners.add(f);
    add(t, f);
  }) as typeof ch.addEventListener;
  ch.removeEventListener = ((t: string, f: EventListener) => {
    if (t === 'characteristicvaluechanged') listeners.delete(f);
    remove(t, f);
  }) as typeof ch.removeEventListener;
  const service = { getCharacteristic: async (u: string) => { if (u === FFE1) return ch; throw new DOMException('x', 'NotFoundError'); } };
  const gatt = {
    connected: false,
    connect: async () => { gatt.connected = true; return gatt; },
    disconnect: () => { gatt.connected = false; },
    getPrimaryService: async (u: string) => { if (u === FFE0) return service; throw new DOMException('x', 'NotFoundError'); },
  };
  const device = Object.assign(new EventTarget(), { id: 'd', name: 'dev', gatt });
  return { device: device as unknown as BluetoothDevice, listeners: () => listeners.size, rejectStart: (e: unknown) => rejectStart(e), resolveStart: () => pendingStarts.splice(0).forEach((r) => r()) };
}

describe('DraginoLink', () => {
  it('leaves no notification listener behind when cancelled while enabling notifications', async () => {
    const f = fakeDevice();
    const link = new DraginoLink();
    const logs: string[] = [];
    link.on('log', (m) => logs.push(m));
    const p = link.connect(f.device).catch((e) => e);
    while (!logs.some((l) => l.includes('Enabling notifications'))) await new Promise((r) => setTimeout(r, 5));
    await link.disconnect();
    f.rejectStart(new DOMException('GATT Server is disconnected.', 'NetworkError'));
    const err = await p;
    expect((err as Error).name).toBe('AbortError');
    expect(link.state).toBe('disconnected');
    expect(f.listeners()).toBe(0);
  });
});

describe('attach / BleUart races', () => {
  it('a second attach cancels the first, leaving one listener (no duplicate RX)', async () => {
    const f = fakeDevice();
    const link = new DraginoLink();
    const ch = await (f.device.gatt as unknown as { getPrimaryService: (u: string) => Promise<{ getCharacteristic: (u: string) => Promise<BluetoothRemoteGATTCharacteristic> }> })
      .getPrimaryService(FFE0)
      .then((s) => s.getCharacteristic(FFE1));
    const first = link.attach(f.device, ch, ch, 'FFE1').catch((e) => e);
    await new Promise((r) => setTimeout(r, 5));
    const second = link.attach(f.device, ch, ch, 'FFE1').catch((e) => e);
    await new Promise((r) => setTimeout(r, 5));
    f.resolveStart(); // both startNotifications calls succeed
    expect(((await first) as Error).name).toBe('AbortError');
    await second;
    expect(link.state).toBe('locked');
    expect(f.listeners()).toBe(1);
  });

  it('undoes a subscription that succeeds after stop()', async () => {
    const { BleUart } = await import('../src/ble/uart');
    let resolveStart!: () => void;
    let notifying = false;
    const ch = Object.assign(new EventTarget(), {
      properties: { write: true, writeWithoutResponse: true },
      startNotifications: () => new Promise<void>((r) => (resolveStart = () => { notifying = true; r(); })),
      stopNotifications: async () => { notifying = false; },
    }) as unknown as BluetoothRemoteGATTCharacteristic;
    const u = new BleUart({ write: ch, notify: ch, chunkSize: 20, withoutResponse: true, interChunkDelayMs: 0 });
    const started = u.start();
    await u.stop();
    resolveStart();
    await started;
    expect(notifying).toBe(false);
  });
});

describe('late replies', () => {
  it('a reply arriving after its command timed out is not taken as the next command\'s answer', async () => {
    const ch = Object.assign(new EventTarget(), {
      uuid: 'x',
      properties: { write: true, writeWithoutResponse: true, notify: true },
      startNotifications: async () => undefined,
      stopNotifications: async () => undefined,
      value: null as DataView | null,
      writeValueWithoutResponse: async (b: Uint8Array) => {
        const cmd = new TextDecoder().decode(b).trim();
        const say = (text: string, ms: number) =>
          setTimeout(() => {
            const bytes = new TextEncoder().encode(text);
            ch.value = new DataView(bytes.buffer);
            ch.dispatchEvent(new Event('characteristicvaluechanged'));
          }, ms);
        if (cmd === 'AT+TDC=?') say('1200000\r\n\r\nOK\r\n', 4500); // after the 4 s first-reply timeout
        if (cmd === 'AT+PROBE=?') say('0004\r\n\r\nOK\r\n', 300);
      },
    });
    const device = Object.assign(new EventTarget(), { id: 'd', name: 'dev', gatt: { connected: true, disconnect() {} } });
    const link = new DraginoLink();
    const c = ch as unknown as BluetoothRemoteGATTCharacteristic;
    await link.attach(device as unknown as BluetoothDevice, c, c, 'x');
    const a = await link.command('AT+TDC=?');
    const b = await link.command('AT+PROBE=?');
    expect(a.status).toBe('timeout');
    expect(b).toMatchObject({ status: 'ok', value: '0004' });
  }, 20000);
});

describe('stale connection attempts', () => {
  it('a superseded attempt failing late does not drop the newer connection', async () => {
    let call = 0;
    let rejectFirst!: (e: unknown) => void;
    const ch = Object.assign(new EventTarget(), {
      uuid: FFE1,
      properties: { write: true, writeWithoutResponse: true, notify: true },
      startNotifications: () => (++call === 1 ? new Promise((_, rej) => (rejectFirst = rej)) : Promise.resolve()),
      stopNotifications: async () => undefined,
      writeValueWithoutResponse: async () => undefined,
    });
    const service = { getCharacteristic: async () => ch };
    const device = Object.assign(new EventTarget(), { id: 'd', name: 'dev' }) as unknown as EventTarget & Record<string, unknown>;
    const gatt = {
      connected: false,
      connect: async () => { gatt.connected = true; return gatt; },
      disconnect: () => { gatt.connected = false; device.dispatchEvent(new Event('gattserverdisconnected')); },
      getPrimaryService: async (u: string) => { if (u === FFE0) return service; throw new DOMException('x', 'NotFoundError'); },
    };
    device.gatt = gatt;
    const link = new DraginoLink();
    const logs: string[] = [];
    link.on('log', (m) => logs.push(m));
    const first = link.connect(device as unknown as BluetoothDevice).catch((e) => e);
    while (!logs.some((l) => l.includes('Enabling notifications'))) await new Promise((r) => setTimeout(r, 5));
    await link.disconnect();
    await link.connect(device as unknown as BluetoothDevice);
    rejectFirst(new DOMException('timed out', 'NetworkError'));
    expect(((await first) as Error).name).toBe('AbortError');
    expect(link.state).toBe('locked');
    expect(gatt.connected).toBe(true);
  });
});

describe('ninth review fixes', () => {
  it('decodes a UTF-8 character split across two notifications', async () => {
    const { BleUart } = await import('../src/ble/uart');
    const ch = Object.assign(new EventTarget(), {
      properties: {},
      value: null as DataView | null,
      startNotifications: async () => undefined,
      stopNotifications: async () => undefined,
    });
    const c = ch as unknown as BluetoothRemoteGATTCharacteristic;
    const u = new BleUart({ write: c, notify: c, chunkSize: 20, withoutResponse: true, interChunkDelayMs: 0 });
    let got = '';
    u.onRx((_b, t) => (got += t));
    await u.start();
    for (const part of [[0x34, 0x20, 0xc2], [0xb5, 0x41]]) {
      ch.value = new DataView(new Uint8Array(part).buffer);
      ch.dispatchEvent(new Event('characteristicvaluechanged'));
    }
    expect(got).toBe('4 µA');
  });

  it('does not carry the late-reply wait over to the next connection', async () => {
    const writes: number[] = [];
    const mk = () =>
      Object.assign(new EventTarget(), {
        uuid: 'x',
        properties: { write: true, writeWithoutResponse: true, notify: true },
        startNotifications: async () => undefined,
        stopNotifications: async () => undefined,
        value: null,
        writeValueWithoutResponse: async () => {
          writes.push(Date.now());
        },
      }) as unknown as BluetoothRemoteGATTCharacteristic;
    const dev = Object.assign(new EventTarget(), { id: 'd', gatt: { connected: true, disconnect() {} } }) as unknown as BluetoothDevice;
    const link = new DraginoLink();
    const c1 = mk();
    await link.attach(dev, c1, c1, 'x');
    await link.command('AT+X', { timeoutMs: 200 }); // no reply at all
    await link.detach();
    const c2 = mk();
    await link.attach(dev, c2, c2, 'x');
    const t0 = Date.now();
    void link.command('AT+Y', { timeoutMs: 200 });
    while (writes.length < 2) await new Promise((r) => setTimeout(r, 10));
    expect(writes[1] - t0).toBeLessThan(500);
  });

  it('one PIN rule for every console', async () => {
    const { mayBePin } = await import('../src/at/response');
    expect(mayBePin('123456', '')).toBe(true);
    expect(mayBePin('AT+VER=?', '')).toBe(false);
    expect(mayBePin('AT12', 'AT12')).toBe(true);
    expect(mayBePin('AT+12VT=220', '22')).toBe(false); // a short PIN inside a command is not the PIN
  });
});

describe('tenth review fixes', () => {
  it('reports a real GATT failure during setup, not "no serial characteristic"', async () => {
    const device = Object.assign(new EventTarget(), { id: 'd', name: 'dev' }) as unknown as EventTarget & Record<string, unknown>;
    const gatt = {
      connected: false,
      connect: async () => { gatt.connected = true; return gatt; },
      disconnect: () => { gatt.connected = false; },
      getPrimaryService: async () => { throw new DOMException('x', 'NotFoundError'); },
      getPrimaryServices: async () => { throw new DOMException('GATT Server is disconnected.', 'NetworkError'); },
    };
    device.gatt = gatt;
    const e = (await new DraginoLink().connect(device as unknown as BluetoothDevice).catch((x) => x)) as Error;
    expect(e.message).not.toMatch(/No serial-style/);
  });

  it('reconnecting the same device is not cancelled by the old connection\'s disconnect event', async () => {
    const ch = Object.assign(new EventTarget(), {
      uuid: 'x', properties: { write: true, writeWithoutResponse: true, notify: true },
      startNotifications: () => new Promise((r) => setTimeout(r, 20)), stopNotifications: async () => undefined,
      writeValueWithoutResponse: async () => undefined,
    });
    const device = Object.assign(new EventTarget(), { id: 'd', name: 'dev' }) as unknown as EventTarget & Record<string, unknown>;
    const gatt = {
      connected: false,
      connect: async () => { gatt.connected = true; return gatt; },
      disconnect: () => { gatt.connected = false; setTimeout(() => device.dispatchEvent(new Event('gattserverdisconnected')), 0); },
      getPrimaryService: async (u: string) => { if (u === FFE0) return { getCharacteristic: async () => ch }; throw new DOMException('x', 'NotFoundError'); },
    };
    device.gatt = gatt;
    const link = new DraginoLink();
    await link.connect(device as unknown as BluetoothDevice);
    await link.connect(device as unknown as BluetoothDevice);
    expect(link.state).toBe('locked');
  });

  it('raw byte sends wait for a running command', async () => {
    const order: string[] = [];
    const ch = Object.assign(new EventTarget(), {
      uuid: 'x', properties: { write: true, writeWithoutResponse: true, notify: true },
      startNotifications: async () => undefined, stopNotifications: async () => undefined, value: null as DataView | null,
      writeValueWithoutResponse: async (b: Uint8Array) => {
        const t = new TextDecoder().decode(b).trim();
        order.push(t);
        if (t === 'AT+CFG') setTimeout(() => { const by = new TextEncoder().encode('AT+TDC=1\r\nOK\r\n'); ch.value = new DataView(by.buffer); ch.dispatchEvent(new Event('characteristicvaluechanged')); }, 100);
      },
    });
    const c = ch as unknown as BluetoothRemoteGATTCharacteristic;
    const link = new DraginoLink();
    await link.attach(Object.assign(new EventTarget(), { id: 'd', gatt: { connected: true, disconnect() {} } }) as unknown as BluetoothDevice, c, c, 'x');
    const cfg = link.command('AT+CFG');
    await new Promise((r) => setTimeout(r, 10));
    const raw = link.sendBytes(new TextEncoder().encode('RAW\r\n'));
    await Promise.all([cfg, raw]);
    expect(order).toEqual(['AT+CFG', 'RAW']);
    expect((await cfg).status).toBe('ok');
  });
});
