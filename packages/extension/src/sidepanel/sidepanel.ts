/**
 * Side Panel - Real-time display of agent tool call activity.
 *
 * PATCHED (port-allowlist): adds a Settings panel for configuring which
 * WebSocket ports the service worker should bridge to.
 */

const PORT_ALLOWLIST_KEY = 'webclaw_port_allowlist';
const WEBSOCKET_MIN_PORT = 18080;
const WEBSOCKET_MAX_PORT = 18089;

const logContainer = document.getElementById('logContainer')!;
const emptyState = document.getElementById('emptyState')!;
const statusEl = document.getElementById('status')!;
const clearBtn = document.getElementById('clearBtn')!;
const settingsBtn = document.getElementById('settingsBtn')!;
const settingsPanel = document.getElementById('settingsPanel')!;
const portInput = document.getElementById('portInput') as HTMLInputElement;
const saveBtn = document.getElementById('saveBtn')!;
const settingsStatus = document.getElementById('settingsStatus')!;

let entries: LogEntry[] = [];

interface LogEntry {
  action: string;
  timestamp: number;
  url?: string;
  [key: string]: unknown;
}

// --- Settings: load current allowlist into the input ---
chrome.storage.local.get(PORT_ALLOWLIST_KEY).then((result) => {
  const stored = result[PORT_ALLOWLIST_KEY];
  if (Array.isArray(stored) && stored.length > 0) {
    portInput.value = stored.join(',');
  }
});

// Toggle settings panel
settingsBtn.addEventListener('click', () => {
  settingsPanel.style.display =
    settingsPanel.style.display === 'none' ? 'block' : 'none';
});

// Save allowlist
saveBtn.addEventListener('click', () => {
  const raw = portInput.value.trim();
  if (raw === '') {
    chrome.storage.local.remove(PORT_ALLOWLIST_KEY).then(() => {
      settingsStatus.textContent = 'Cleared - using default range';
      settingsStatus.className = 'settings-status ok';
    });
    return;
  }
  const ports = raw.split(',').map((s) => Number(s.trim()));
  const invalid = ports.some(
    (p) => isNaN(p) || p < WEBSOCKET_MIN_PORT || p > WEBSOCKET_MAX_PORT,
  );
  if (invalid) {
    settingsStatus.textContent =
      `Invalid: ports must be ${WEBSOCKET_MIN_PORT}-${WEBSOCKET_MAX_PORT}`;
    settingsStatus.className = 'settings-status error';
    return;
  }
  chrome.storage.local.set({ [PORT_ALLOWLIST_KEY]: ports }).then(() => {
    settingsStatus.textContent = `Saved: ${ports.join(', ')}`;
    settingsStatus.className = 'settings-status ok';
  });
});

// --- Existing: log entries ---
chrome.runtime.onMessage.addListener((message) => {
  if (
    message.channel === 'webclaw-sidepanel-update' &&
    message.type === 'activity'
  ) {
    addLogEntry(message.data as LogEntry);
  }
});

clearBtn.addEventListener('click', () => {
  entries = [];
  logContainer.innerHTML = '';
  emptyState.style.display = 'flex';
  logContainer.appendChild(emptyState);
});

function addLogEntry(entry: LogEntry): void {
  entries.push(entry);
  if (emptyState.parentElement) emptyState.style.display = 'none';
  statusEl.textContent = 'Active';
  statusEl.classList.add('connected');

  const el = document.createElement('div');
  el.className = 'log-entry';

  const timeSpan = document.createElement('span');
  timeSpan.className = 'timestamp';
  timeSpan.textContent = new Date(entry.timestamp).toLocaleTimeString();
  el.appendChild(timeSpan);

  const actionSpan = document.createElement('span');
  actionSpan.className = 'action-name';
  actionSpan.textContent = entry.action;
  el.appendChild(actionSpan);

  const detailKeys = Object.keys(entry).filter(
    (k) => !['action', 'timestamp', 'url'].includes(k),
  );
  if (detailKeys.length > 0) {
    const detailsDiv = document.createElement('div');
    detailsDiv.className = 'details';
    detailsDiv.textContent = detailKeys
      .map((k) => `${k}: ${JSON.stringify(entry[k])}`)
      .join(' | ');
    el.appendChild(detailsDiv);
  }

  logContainer.appendChild(el);
  el.scrollIntoView({ behavior: 'smooth' });
}
