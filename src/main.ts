import { isWebBluetoothAvailable } from './ble/discovery';
import { DraginoLink, type LinkState } from './device/link';
import { PS_LB_PROFILE } from './profiles/ps-lb';
import { initConfig } from './ui/config';
import { initDiscovery } from './ui/discovery';
import { $, input, storageGet, storageSet } from './ui/dom';
import { initTerminal } from './ui/terminal';

const link = new DraginoLink();
const profile = PS_LB_PROFILE;
const getPin = () => input('connPin').value.trim();
link.pinProvider = getPin;

// ------------------------------------------------------------------ tabs ----
/** Set once the Discovery tab is initialised; rebuilds its report when the tab is shown. */
let onDiscoveryShown: (() => void) | undefined;

function showTab(name: string): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs [data-tab]')) {
    b.setAttribute('aria-selected', String(b.dataset.tab === name));
  }
  for (const p of document.querySelectorAll<HTMLElement>('.tab-panel')) p.hidden = p.id !== `tab-${name}`;
  $('connBar').hidden = name === 'discovery';
  storageSet('tab', name);
  if (name === 'discovery') onDiscoveryShown?.();
}
for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs [data-tab]')) {
  b.addEventListener('click', () => showTab(b.dataset.tab!));
}
showTab(storageGet('tab', 'terminal'));

// ------------------------------------------------------------ connection ----
const terminal = initTerminal({ link, profile, getPin, setPin: (pin) => (input('connPin').value = pin) });
initConfig(link, profile);
const discovery = initDiscovery(link);
onDiscoveryShown = discovery.onShown;

const connBtn = $('connBtn') as HTMLButtonElement;
const disconnBtn = $('disconnBtn') as HTMLButtonElement;
const loginBtn = $('loginBtn') as HTMLButtonElement;
const statusEl = $('connStatus');

function showState(state: LinkState): void {
  const name = link.device?.name ?? '';
  const text: Record<LinkState, string> = {
    disconnected: 'Not connected',
    connecting: 'Connecting…',
    locked: `Connected ${name}: enter the AT PIN and click Log in`,
    ready: `Connected ${name}: unlocked`,
  };
  statusEl.textContent = text[state];
  statusEl.className = `status ${state === 'ready' ? 'ok' : ''}`;
  connBtn.disabled = state !== 'disconnected' || !isWebBluetoothAvailable();
  disconnBtn.disabled = state === 'disconnected';
  loginBtn.disabled = !(state === 'locked' || state === 'ready');
}
link.on('state', showState);
showState('disconnected');

async function login(): Promise<void> {
  const pin = getPin();
  if (!pin) {
    input('connPin').focus();
    return;
  }
  let ok: boolean;
  try {
    ok = await link.login(pin);
  } catch (e) {
    // The connection is up; only sending the PIN failed (e.g. a GATT write error).
    terminal.add('sys', `Login failed: ${e instanceof Error ? e.message : String(e)}`);
    statusEl.textContent = 'Connected, but sending the PIN failed. Click Log in to try again.';
    statusEl.className = 'status err';
    return;
  }
  if (!ok && link.connected) {
    statusEl.textContent = 'PIN not accepted (or no reply). Check the AT PIN on the label (2–8 characters).';
    statusEl.className = 'status err';
  }
}

connBtn.addEventListener('click', async () => {
  if (discovery.isConnected()) {
    statusEl.textContent = 'Disconnect on the Discovery tab first: both cannot use the sensor at the same time.';
    statusEl.className = 'status err';
    return;
  }
  try {
    await link.requestAndConnect();
  } catch (e) {
    const cancelled = e instanceof DOMException && e.name === 'NotFoundError' && /cancel/i.test(e.message);
    showState(link.state);
    if (e instanceof DOMException && e.name === 'AbortError') {
      statusEl.textContent = 'Connection cancelled.';
    } else if (!cancelled) {
      const msg = e instanceof Error ? e.message : String(e);
      terminal.add('sys', `Connect failed: ${msg}`);
      statusEl.textContent = /timed out/.test(msg)
        ? 'Connection timed out. Wake the sensor and try again.'
        : /disconnected during setup/.test(msg)
          ? 'The sensor disconnected during setup. Wake it and try again.'
          : 'Connection failed. See the terminal.';
      statusEl.className = 'status err';
    }
    return;
  }
  // Connected. A failure from here on is a login problem, not a connection problem.
  if (!getPin()) {
    input('connPin').focus();
    return;
  }
  await login();
});
disconnBtn.addEventListener('click', () => void link.disconnect());
loginBtn.addEventListener('click', () => void login());
input('connPin').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && link.connected) void login();
});

if (!isWebBluetoothAvailable()) connBtn.disabled = true;
