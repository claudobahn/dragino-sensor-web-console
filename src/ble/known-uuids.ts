/**
 * Web Bluetooth only exposes services that were listed (in `filters` or
 * `optionalServices`) when the device was requested. Since Dragino does not
 * publish the GATT layout of its -LB/-LS BLE console, we request a broad set of
 * services commonly used by BLE "transparent UART" modules, plus any custom
 * UUIDs the user enters.
 *
 * NOTE: Chrome rejects the whole requestDevice() call if a *blocklisted* UUID
 * is listed (e.g. HID 0x1812), so those are deliberately absent.
 */

export interface KnownService {
  uuid: string;
  name: string;
}

/** Expand a 16-bit UUID to its full 128-bit Bluetooth base form. */
export function uuid16(short: number): string {
  return `0000${short.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
}

/**
 * Dragino's own Devices.Tool Android app (v1.11.0) connects to service 0xFFE0 and
 * uses characteristic 0xFFE1 for both writes and notifications. It also looks
 * for 0xFF00/0xFF01, and its BLE library defaults to 0xFEE9 with the d44bc439
 * characteristics. Commands are terminated with CR LF. See docs/ble-protocol.md.
 */
export const DRAGINO_SERVICE = uuid16(0xffe0);
export const DRAGINO_CHARACTERISTIC = uuid16(0xffe1);

export const KNOWN_SERVICES: KnownService[] = [
  { uuid: DRAGINO_SERVICE, name: 'Dragino AT console 0xFFE0 (HM-10 style transparent UART)' },
  { uuid: uuid16(0xff00), name: 'Dragino alternate 0xFF00 (probed by Devices.Tool)' },
  { uuid: uuid16(0xfee9), name: 'Vendor 0xFEE9 (BLE library default in Devices.Tool)' },
  // --- Other common "serial over BLE" services ---
  { uuid: '6e400001-b5a3-f393-e0a9-e50e24dcca9e', name: 'Nordic UART Service (NUS)' },
  { uuid: uuid16(0xfff0), name: 'Vendor 0xFFF0 (TI SimpleProfile / many modules)' },
  { uuid: uuid16(0xffb0), name: 'Vendor 0xFFB0' },
  { uuid: uuid16(0xffc0), name: 'Vendor 0xFFC0' },
  { uuid: uuid16(0xffd0), name: 'Vendor 0xFFD0' },
  { uuid: uuid16(0xfee0), name: 'Vendor 0xFEE0' },
  { uuid: uuid16(0xfee7), name: 'Vendor 0xFEE7' },
  { uuid: uuid16(0xff10), name: 'Vendor 0xFF10' },
  { uuid: uuid16(0xae00), name: 'Vendor 0xAE00 (AC63xx / JL)' },
  { uuid: uuid16(0xae30), name: 'Vendor 0xAE30' },
  { uuid: uuid16(0x18f0), name: 'Vendor 0x18F0 (serial printers)' },
  { uuid: uuid16(0xfe59), name: 'Nordic Secure DFU 0xFE59' },
  { uuid: '0783b03e-8535-b5a0-7140-a304d2495cb7', name: 'Dialog/Renesas Serial Port Service (SPS)' },
  { uuid: '49535343-fe7d-4ae5-8fa9-9fafd205e455', name: 'Microchip/ISSC Transparent UART (RN4870/BM70)' },
  { uuid: '0000fefb-0000-1000-8000-00805f9b34fb', name: 'Telit/Stollmann Terminal I/O 0xFEFB' },
  { uuid: '569a1101-b87f-490c-92cb-11ba5ea5167c', name: 'Laird VSP' },
  { uuid: '0003cdd0-0000-1000-8000-00805f9b0131', name: 'Ublox/Bluegiga Serial' },
  { uuid: '0000abf0-0000-1000-8000-00805f9b34fb', name: 'Espressif SPP 0xABF0' },
  { uuid: '0000180a-0000-1000-8000-00805f9b34fb', name: 'Device Information 0x180A' },
  { uuid: uuid16(0x180f), name: 'Battery Service 0x180F' },
  { uuid: uuid16(0x1800), name: 'Generic Access 0x1800' },
  { uuid: uuid16(0x1801), name: 'Generic Attribute 0x1801' },
  // Silicon Labs / Bluegiga "BGX" serial
  { uuid: '331a36f5-2459-45ea-9d95-6142f0c4b307', name: 'Silabs BGX Serial' },
];

/** Friendly names for characteristics we are likely to meet. */
export const KNOWN_CHARACTERISTICS: Record<string, string> = {
  '6e400002-b5a3-f393-e0a9-e50e24dcca9e': 'NUS RX (write to device)',
  '6e400003-b5a3-f393-e0a9-e50e24dcca9e': 'NUS TX (notify from device)',
  [DRAGINO_CHARACTERISTIC]: 'Dragino AT console data 0xFFE1 (write + notify)',
  [uuid16(0xff01)]: 'Dragino alternate data 0xFF01',
  'd44bc439-abfd-45a2-b575-925416129600': '0xFEE9 write',
  'd44bc439-abfd-45a2-b575-925416129601': '0xFEE9 notify',
  [uuid16(0xffe2)]: '0xFFE2',
  [uuid16(0xfff1)]: '0xFFF1',
  [uuid16(0xfff2)]: '0xFFF2',
  [uuid16(0xfff3)]: '0xFFF3',
  [uuid16(0xfff4)]: '0xFFF4',
  [uuid16(0xfff6)]: '0xFFF6',
  [uuid16(0x2a00)]: 'Device Name',
  [uuid16(0x2a19)]: 'Battery Level',
  [uuid16(0x2a24)]: 'Model Number',
  [uuid16(0x2a25)]: 'Serial Number',
  [uuid16(0x2a26)]: 'Firmware Revision',
  [uuid16(0x2a27)]: 'Hardware Revision',
  [uuid16(0x2a28)]: 'Software Revision',
  [uuid16(0x2a29)]: 'Manufacturer Name',
  [uuid16(0x2a05)]: 'Service Changed',
  '0783b03e-8535-b5a0-7140-a304d2495cb8': 'SPS Server TX (notify from device)',
  '0783b03e-8535-b5a0-7140-a304d2495cba': 'SPS Server RX (write to device)',
  '0783b03e-8535-b5a0-7140-a304d2495cb9': 'SPS Flow Control',
  '49535343-1e4d-4bd9-ba61-23c647249616': 'ISSC TX (notify from device)',
  '49535343-8841-43f4-a8d4-ecbe34729bb3': 'ISSC RX (write to device)',
};

const SERVICE_NAMES = new Map(KNOWN_SERVICES.map((s) => [s.uuid, s.name]));

export function serviceName(uuid: string): string | undefined {
  return SERVICE_NAMES.get(uuid.toLowerCase());
}

export function characteristicName(uuid: string): string | undefined {
  return KNOWN_CHARACTERISTICS[uuid.toLowerCase()];
}

/**
 * Normalise a user-entered UUID: accepts 16-bit ("ffe0", "0xFFE0"),
 * 32-bit ("0000ffe0") or full 128-bit forms. Returns null if invalid.
 */
export function normalizeUuid(input: string): string | null {
  const s = input.trim().toLowerCase().replace(/^0x/, '');
  if (/^[0-9a-f]{4}$/.test(s)) return uuid16(parseInt(s, 16));
  if (/^[0-9a-f]{8}$/.test(s)) return `${s}-0000-1000-8000-00805f9b34fb`;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)) return s;
  if (/^[0-9a-f]{32}$/.test(s)) {
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  }
  return null;
}
