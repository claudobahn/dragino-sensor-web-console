/**
 * Data-driven description of a device's AT settings, so the config UI can be generic and
 * model-specific value lives in profile files.
 */

/** What is known about the connected device, for limits that depend on firmware. */
export interface DeviceContext {
  /** AT+VER value, e.g. "EU868 v1.2" or "v1.2.8 EU868". */
  firmware?: string;
}

export interface SettingOption {
  value: string;
  label: string;
}

export interface SettingDef {
  /** AT command name without "AT+" (e.g. "TDC"). Queried with "AT+TDC=?", set with "AT+TDC=<raw>". */
  cmd: string;
  label: string;
  help?: string;
  /** How the value is edited in the UI. */
  kind: 'number' | 'text' | 'select';
  /** Unit shown next to the display value. */
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: SettingOption[];
  readOnly?: boolean;
  /** Device value → display value (default: identity). */
  toDisplay?: (raw: string) => string;
  /** Display value → device value (default: identity). */
  fromDisplay?: (display: string) => string;
  /** Return an error message for an invalid *device* value, or null. `ctx` describes the connected device. */
  validate?: (raw: string, ctx?: DeviceContext) => string | null;
  /** Upper limit that depends on the connected device (e.g. firmware); used for the input's max attribute. */
  maxFor?: (ctx?: DeviceContext) => number;
  /** Human description of a device value (e.g. "water depth, 0–4 m"). */
  describe?: (raw: string) => string | undefined;
  /** Equivalent LoRaWAN downlink as hex, or null if none. */
  downlink?: (raw: string) => string | null;
  /** The firmware needs ATZ (reboot) before the new value takes effect. */
  needsReset?: boolean;
}

export interface SettingGroup {
  title: string;
  description?: string;
  settings: SettingDef[];
}

export interface DeviceProfile {
  id: string;
  name: string;
  description: string;
  groups: SettingGroup[];
  /** Quick commands offered in the terminal. */
  snippets: { label: string; command: string; title?: string }[];
}
