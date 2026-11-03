/**
 * Simulated Dragino PS-LS-I4 for end-to-end tests, injected into the page before the app loads.
 *
 * It replaces navigator.bluetooth with one fake device that behaves like the real sensor on firmware EU868 v1.2:
 * service FFE0 / characteristic FFE1, PIN login ("Correct Password" / "Incorrect Password"), replies sent in 20-byte
 * notifications, long output paused mid-line like the real ~300 ms bursts, AT? / AT+CFG / AT+GETSENSORVALUE=0 output
 * in the real format, no AT+CALIBRATION / AT+2PCALIDC.
 *
 * Tests steer it through window.fakeBle (see the `ctl` object below). The AppKey in AT+CFG is a public AES test
 * vector, not a real key.
 */
(() => {
  const FFE0 = '0000ffe0-0000-1000-8000-00805f9b34fb';
  const FFE1 = '0000ffe1-0000-1000-8000-00805f9b34fb';
  const FAKE_APPKEY = '2B 7E 15 16 28 AE D2 A6 AB F7 15 88 09 CF 4F 3C';
  const PAUSE = '\x00'; // in reply text: a 350 ms gap, like the real device's output bursts

  const ctl = {
    /** Every command the device received, in order. */
    sent: [],
    /** Current AT PIN (AT+PWORD changes it). */
    pin: '123456',
    unlocked: false,
    /** Device settings, as AT+CFG prints them. */
    state: {
      TDC: '1200000', PROBE: '0000', '5VT': '0', '12VT': '500', '3V3T': '0', VER: 'EU868 v1.2',
      DEUI: 'A8 40 41 00 00 00 AB CD', APPEUI: '00 00 00 00 00 00 00 00', NJM: '1', NJS: '0', ADR: '1', DR: '5', CLASS: 'A',
    },
    /** Fault injection, all off by default. */
    failNextWrite: false, // next GATT write rejects (NetworkError)
    failNotify: false, // startNotifications rejects
    slowNotify: false, // startNotifications takes 1.5 s
    slowServices: false, // getPrimaryService takes 1.5 s (and fails if disconnected meanwhile)
    slowReplies: false, // every reply starts 1.5 s late
    hangConnect: false, // gatt.connect() never completes (sensor stopped advertising); disconnect() aborts it
    silent: false, // once unlocked, answer nothing except AT?
    shortHelp: false, // AT? prints no command list
    /** The console re-locks itself (as after ~1 min idle on the real device). */
    lock() {
      ctl.unlocked = false;
    },
    /** The device drops the Bluetooth connection. */
    drop() {
      gatt.disconnect();
    },
  };
  window.fakeBle = ctl;

  const ch = new EventTarget();
  Object.assign(ch, {
    uuid: FFE1,
    value: null,
    notifying: false,
    properties: {
      read: false, write: true, writeWithoutResponse: true, notify: true, indicate: false, broadcast: false,
      authenticatedSignedWrites: false, reliableWrite: false, writableAuxiliaries: false,
    },
    async startNotifications() {
      if (ctl.failNotify) throw new DOMException('GATT operation failed', 'NetworkError');
      if (ctl.slowNotify) await new Promise((r) => setTimeout(r, 1500));
      ch.notifying = true;
      return ch;
    },
    async stopNotifications() {
      ch.notifying = false;
      return ch;
    },
    async writeValueWithoutResponse(b) {
      if (ctl.failNextWrite) {
        ctl.failNextWrite = false;
        throw new DOMException('GATT operation failed', 'NetworkError');
      }
      receive(b);
    },
    async writeValueWithResponse(b) {
      receive(b);
    },
  });

  /** Send text to the app as 20-byte notifications (only while connected and subscribed). */
  function reply(text, startMs = 5) {
    let delay = startMs + (ctl.slowReplies ? 1500 : 0);
    for (const segment of text.split(PAUSE)) {
      const bytes = new TextEncoder().encode(segment);
      for (let i = 0; i < bytes.length; i += 20) {
        const part = bytes.slice(i, i + 20);
        setTimeout(() => {
          if (!gatt.connected || !ch.notifying) return;
          ch.value = new DataView(part.buffer);
          ch.dispatchEvent(new Event('characteristicvaluechanged'));
        }, (delay += 5));
      }
      delay += 350;
    }
  }

  let rxBuffer = '';
  function receive(b) {
    rxBuffer += new TextDecoder().decode(b);
    let i;
    while ((i = rxBuffer.indexOf('\r\n')) >= 0) {
      const cmd = rxBuffer.slice(0, i);
      rxBuffer = rxBuffer.slice(i + 2);
      handle(cmd);
    }
  }

  function handle(cmd) {
    ctl.sent.push(cmd);
    if (!ctl.unlocked) {
      if (cmd === ctl.pin) {
        ctl.unlocked = true;
        return reply('Correct Password\r\n');
      }
      return reply('Incorrect Password\r\n');
    }
    if (ctl.silent && cmd !== 'AT?') return;
    const { state } = ctl;
    if (cmd === 'AT?') {
      if (ctl.shortHelp) return reply('\r\nOK\r\n');
      return reply(
        'AT+DEBUG: Set more info output\r\nATZ: Trig a reset of the MCU\r\n' +
          'AT+APPKEY: Get or Set the Application Key\r\n' +
          `AT+RX2FQ: Get or Set the Rx2 window freq${PAUSE}uency\r\n` +
          Object.keys(state).map((k) => `AT+${k}: Get or Set ${k}`).join('\r\n') +
          '\r\nAT+GETSENSORVALUE: Get current sensor value\r\n\r\nOK\r\n',
      );
    }
    if (cmd === 'AT+CFG') {
      return reply(
        '\r\n\r\nStop Tx events,Please wait for all configurations to print\r\n' +
          Object.entries(state).map(([k, v]) => `AT+${k}=${v}`).join('\r\n') +
          `\r\nAT+APPKEY=${FAKE_APPKEY}\r\n\r\n\r\nStart Tx events\r\n\r\n\r\nOK\r\n`,
      );
    }
    if (cmd === 'AT+GETSENSORVALUE=0') {
      return reply(
        `\r\nBat_voltage:3.426 V\r\nVDC_Input:0.000 V\r\nIDC_Input:10.158 mA\r\nGPIO_EXTI:0\r\nIN1:0\r\nIN2:0\r\n${PAUSE}\r\nOK\r\n`,
        2000,
      );
    }
    if (/^AT\+PWORD=/.test(cmd)) {
      ctl.pin = cmd.slice('AT+PWORD='.length);
      return reply('OK\r\n');
    }
    let m = /^AT\+(\w+)=\?$/.exec(cmd);
    if (m) return m[1] in state ? reply(`${state[m[1]]}\r\n\r\nOK\r\n`) : reply('AT_ERROR\r\n');
    m = /^AT\+(\w+)=(.+)$/.exec(cmd);
    if (m && m[1] in state) {
      state[m[1]] = m[2];
      return reply('OK\r\n');
    }
    reply('AT_ERROR\r\n');
  }

  const service = {
    uuid: FFE0,
    isPrimary: true,
    async getCharacteristic(u) {
      if (u === FFE1) return ch;
      throw new DOMException('Not found', 'NotFoundError');
    },
    async getCharacteristics() {
      return [ch];
    },
  };
  const device = new EventTarget();
  const gatt = {
    connected: false,
    device,
    async connect() {
      if (ctl.hangConnect) {
        await new Promise((_, reject) =>
          device.addEventListener('gattserverdisconnected', () => reject(new DOMException('Connection attempt aborted.', 'AbortError')), { once: true }),
        );
      }
      gatt.connected = true;
      return gatt;
    },
    disconnect() {
      gatt.connected = false;
      device.dispatchEvent(new Event('gattserverdisconnected'));
    },
    async getPrimaryService(u) {
      if (ctl.slowServices) {
        await new Promise((r) => setTimeout(r, 1500));
        if (!gatt.connected) throw new DOMException('GATT Server is disconnected.', 'NetworkError');
      }
      if (u === FFE0) return service;
      throw new DOMException('Not found', 'NotFoundError');
    },
    async getPrimaryServices() {
      return [service];
    },
  };
  Object.assign(device, { id: 'fake-ps-ls-i4', name: 'A840410000ABCD00', gatt });
  Object.defineProperty(navigator, 'bluetooth', {
    value: { requestDevice: async () => device, getAvailability: async () => true },
  });
})();
