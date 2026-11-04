/**
 * GATT discovery: request a device, connect, and enumerate every service,
 * characteristic and descriptor that Web Bluetooth lets us see.
 */
import { bytesToAsciiPreview, bytesToHex, toBytes } from '../util/bytes';
import { characteristicName, DRAGINO_CHARACTERISTIC, DRAGINO_SERVICE, KNOWN_SERVICES, serviceName } from './known-uuids';

export interface CharacteristicProps {
  broadcast: boolean;
  read: boolean;
  writeWithoutResponse: boolean;
  write: boolean;
  notify: boolean;
  indicate: boolean;
  authenticatedSignedWrites: boolean;
  reliableWrite: boolean;
  writableAuxiliaries: boolean;
}

export interface DescriptorInfo {
  uuid: string;
  valueHex?: string;
  valueAscii?: string;
  error?: string;
}

export interface CharacteristicInfo {
  uuid: string;
  name?: string;
  properties: CharacteristicProps;
  valueHex?: string;
  valueAscii?: string;
  readError?: string;
  descriptors: DescriptorInfo[];
  descriptorError?: string;
  /** Live handle — not serialised into reports. */
  handle: BluetoothRemoteGATTCharacteristic;
}

export interface ServiceInfo {
  uuid: string;
  name?: string;
  isPrimary: boolean;
  characteristics: CharacteristicInfo[];
  error?: string;
}

export interface AdvertisementInfo {
  rssi?: number;
  txPower?: number;
  serviceUuids: string[];
  manufacturerData: { companyId: string; hex: string }[];
  serviceData: { uuid: string; hex: string }[];
}

export interface DiscoveryResult {
  deviceName?: string;
  deviceId: string;
  requestedServices: string[];
  services: ServiceInfo[];
  advertisement?: AdvertisementInfo;
  advertisementNote?: string;
  discoveredAt: string;
  userAgent: string;
}

export interface UartCandidate {
  service: string;
  serviceName?: string;
  /** Characteristic we write commands to. */
  write: BluetoothRemoteGATTCharacteristic;
  /** Characteristic we receive notifications/indications on. */
  notify: BluetoothRemoteGATTCharacteristic;
  writeWithoutResponse: boolean;
  label: string;
}

export function isWebBluetoothAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}

export interface RequestOptions {
  /** If set, only show devices whose name starts with this prefix. */
  namePrefix?: string;
  /** Extra service UUIDs (already normalised) to request access to. */
  extraServices: string[];
}

export function requestedServiceList(extra: string[]): string[] {
  return Array.from(new Set([...KNOWN_SERVICES.map((s) => s.uuid), ...extra]));
}

export async function requestDevice(opts: RequestOptions): Promise<BluetoothDevice> {
  const optionalServices = requestedServiceList(opts.extraServices);
  const options: RequestDeviceOptions = opts.namePrefix
    ? { filters: [{ namePrefix: opts.namePrefix }], optionalServices }
    : { acceptAllDevices: true, optionalServices };
  return navigator.bluetooth.requestDevice(options);
}

function props(p: BluetoothCharacteristicProperties): CharacteristicProps {
  return {
    broadcast: p.broadcast,
    read: p.read,
    writeWithoutResponse: p.writeWithoutResponse,
    write: p.write,
    notify: p.notify,
    indicate: p.indicate,
    authenticatedSignedWrites: p.authenticatedSignedWrites,
    reliableWrite: p.reliableWrite,
    writableAuxiliaries: p.writableAuxiliaries,
  };
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/**
 * Listen for one advertisement packet. Requires
 * chrome://flags/#enable-experimental-web-platform-features in most Chrome
 * versions; returns a note explaining why if unavailable.
 */
export async function captureAdvertisement(
  device: BluetoothDevice,
  timeoutMs = 4000,
): Promise<{ adv?: AdvertisementInfo; note?: string }> {
  if (typeof device.watchAdvertisements !== 'function') {
    return {
      note: 'watchAdvertisements() not available; enable chrome://flags/#enable-experimental-web-platform-features to capture advertisement data.',
    };
  }
  const controller = new AbortController();
  try {
    const adv = await new Promise<AdvertisementInfo | undefined>((resolve, reject) => {
      const timer = setTimeout(() => resolve(undefined), timeoutMs);
      device.addEventListener(
        'advertisementreceived',
        (ev) => {
          clearTimeout(timer);
          const e = ev as BluetoothAdvertisingEvent;
          const manufacturerData: AdvertisementInfo['manufacturerData'] = [];
          e.manufacturerData.forEach((v, k) =>
            manufacturerData.push({ companyId: `0x${k.toString(16).padStart(4, '0')}`, hex: bytesToHex(toBytes(v)) }),
          );
          const serviceData: AdvertisementInfo['serviceData'] = [];
          e.serviceData.forEach((v, k) => serviceData.push({ uuid: String(k), hex: bytesToHex(toBytes(v)) }));
          resolve({
            rssi: e.rssi ?? undefined,
            txPower: e.txPower ?? undefined,
            serviceUuids: e.uuids.map(String),
            manufacturerData,
            serviceData,
          });
        },
        { once: true },
      );
      device.watchAdvertisements({ signal: controller.signal }).catch(reject);
    });
    return adv ? { adv } : { note: `No advertisement received within ${timeoutMs} ms (device may stop advertising once connected).` };
  } catch (e) {
    return { note: `watchAdvertisements failed: ${errMsg(e)}` };
  } finally {
    controller.abort();
  }
}

export async function connect(device: BluetoothDevice): Promise<BluetoothRemoteGATTServer> {
  if (!device.gatt) throw new Error('Device has no GATT server');
  return device.gatt.connected ? device.gatt : device.gatt.connect();
}

export async function enumerate(
  server: BluetoothRemoteGATTServer,
  log: (msg: string) => void,
  readValues = true,
): Promise<ServiceInfo[]> {
  const services: ServiceInfo[] = [];
  let primary: BluetoothRemoteGATTService[] = [];
  try {
    primary = await server.getPrimaryServices();
  } catch (e) {
    // NotFoundError means none of the requested services exist on the device.
    log(`getPrimaryServices(): ${errMsg(e)}`);
    return services;
  }
  for (const svc of primary) {
    const info: ServiceInfo = {
      uuid: svc.uuid,
      name: serviceName(svc.uuid),
      isPrimary: svc.isPrimary,
      characteristics: [],
    };
    log(`Service ${svc.uuid}${info.name ? ` (${info.name})` : ''}`);
    try {
      const chars = await svc.getCharacteristics();
      for (const ch of chars) {
        const ci: CharacteristicInfo = {
          uuid: ch.uuid,
          name: characteristicName(ch.uuid),
          properties: props(ch.properties),
          descriptors: [],
          handle: ch,
        };
        if (readValues && ch.properties.read) {
          try {
            const v = toBytes(await ch.readValue());
            ci.valueHex = bytesToHex(v);
            ci.valueAscii = bytesToAsciiPreview(v);
          } catch (e) {
            ci.readError = errMsg(e);
          }
        }
        try {
          const descs = await ch.getDescriptors();
          for (const d of descs) {
            const di: DescriptorInfo = { uuid: d.uuid };
            if (readValues) {
              try {
                const v = toBytes(await d.readValue());
                di.valueHex = bytesToHex(v);
                di.valueAscii = bytesToAsciiPreview(v);
              } catch (e) {
                di.error = errMsg(e);
              }
            }
            ci.descriptors.push(di);
          }
        } catch (e) {
          // NotFoundError simply means no descriptors.
          if (!(e instanceof DOMException && e.name === 'NotFoundError')) ci.descriptorError = errMsg(e);
        }
        log(`  Char ${ch.uuid} [${propertyFlags(ci.properties)}]${ci.name ? ` ${ci.name}` : ''}`);
        info.characteristics.push(ci);
      }
    } catch (e) {
      info.error = errMsg(e);
      log(`  getCharacteristics(): ${info.error}`);
    }
    services.push(info);
  }
  return services;
}

export function propertyFlags(p: CharacteristicProps): string {
  const flags: string[] = [];
  if (p.read) flags.push('R');
  if (p.write) flags.push('W');
  if (p.writeWithoutResponse) flags.push('WnR');
  if (p.notify) flags.push('N');
  if (p.indicate) flags.push('I');
  if (p.broadcast) flags.push('B');
  if (p.authenticatedSignedWrites) flags.push('ASW');
  if (p.reliableWrite) flags.push('RW');
  return flags.join(' ') || '-';
}

/**
 * Heuristically find "serial port" pairs: within one service, a characteristic
 * that can be written and one that notifies/indicates (possibly the same one,
 * as with HM-10's 0xFFE1). Ranked so the most likely pair comes first.
 */
export function findUartCandidates(services: ServiceInfo[]): UartCandidate[] {
  const out: (UartCandidate & { score: number })[] = [];
  for (const svc of services) {
    const writers = svc.characteristics.filter((c) => c.properties.write || c.properties.writeWithoutResponse);
    const notifiers = svc.characteristics.filter((c) => c.properties.notify || c.properties.indicate);
    for (const w of writers) {
      for (const n of notifiers) {
        let score = 0;
        if (svc.uuid === DRAGINO_SERVICE && w.uuid === DRAGINO_CHARACTERISTIC && n.uuid === DRAGINO_CHARACTERISTIC) score += 100;
        else if (svc.name?.startsWith('Dragino')) score += 20;
        if (w.uuid === n.uuid) score += 2; // single-char UART (FFE1 style)
        if (svc.name && /uart|serial|sps|vsp|spp|terminal|console/i.test(svc.name)) score += 5;
        if (w.name && /RX|write/i.test(w.name)) score += 2;
        if (n.name && /TX|notify/i.test(n.name)) score += 2;
        if (/^0000180[01a]-|^0000180f-/.test(svc.uuid)) score -= 10; // standard services
        out.push({
          service: svc.uuid,
          serviceName: svc.name,
          write: w.handle,
          notify: n.handle,
          writeWithoutResponse: w.properties.writeWithoutResponse && !w.properties.write,
          label: `${svc.name ?? svc.uuid}: write ${shortUuid(w.uuid)} / notify ${shortUuid(n.uuid)}`,
          score,
        });
      }
    }
  }
  return out.sort((a, b) => b.score - a.score).map(({ score: _score, ...c }) => c);
}

/** "0000ffe1-0000-1000-8000-00805f9b34fb" → "FFE1"; leaves 128-bit vendor UUIDs intact. */
export function shortUuid(uuid: string): string {
  const m = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/i.exec(uuid);
  return m ? m[1].toUpperCase() : uuid;
}

/** Strip live handles so the result can be copied as JSON. */
export function serialiseResult(r: DiscoveryResult): string {
  return JSON.stringify(
    r,
    (key, value) => (key === 'handle' ? undefined : value),
    2,
  );
}
