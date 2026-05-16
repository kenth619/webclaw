/**
 * WebClaw Chrome Extension Service Worker.
 *
 * Acts as the message hub between:
 * - WebSocket (MCP Server) <-> Content Scripts (page interaction)
 * - Content Scripts <-> Side Panel (activity logging)
 *
 * PATCHED (port-allowlist): bridges are constructed from a chrome.storage.local
 * allowlist instead of unconditionally scanning all 10 ports. Default (empty
 * allowlist) preserves upstream behavior of scanning 18080-18089.
 */
import {
  WEBSOCKET_DEFAULT_PORT,
  WEBSOCKET_PORT_RANGE_SIZE,
  KEEPALIVE_INTERVAL_MS,
} from 'webclaw-shared';
import { WebSocketBridge } from './ws-bridge';
import { TabManager } from './tab-manager';
import { MessageRouter } from './message-router';
import { DialogHandler } from './dialog-handler';

/** chrome.storage.local key for the port allowlist. Value: number[] (ports). */
const PORT_ALLOWLIST_KEY = 'webclaw_port_allowlist';

// --- State ---
const tabManager = new TabManager();
const messageRouter = new MessageRouter(tabManager);
const dialogHandler = new DialogHandler();
messageRouter.setDialogHandler(dialogHandler);

let wsBridges: WebSocketBridge[] = [];

/**
 * Resolve which ports to bridge to.
 * Empty/missing storage entry -> full default range (upstream behavior).
 * Invalid entries are filtered; if all are invalid, falls back to default.
 */
async function getActivePorts(): Promise<number[]> {
  const defaultPorts = Array.from(
    { length: WEBSOCKET_PORT_RANGE_SIZE },
    (_, i) => WEBSOCKET_DEFAULT_PORT + i,
  );
  try {
    const result = await chrome.storage.local.get(PORT_ALLOWLIST_KEY);
    const stored = result[PORT_ALLOWLIST_KEY];
    if (!Array.isArray(stored) || stored.length === 0) return defaultPorts;
    const valid = stored.filter(
      (p): p is number =>
        typeof p === 'number' &&
        p >= WEBSOCKET_DEFAULT_PORT &&
        p < WEBSOCKET_DEFAULT_PORT + WEBSOCKET_PORT_RANGE_SIZE,
    );
    return valid.length > 0 ? valid : defaultPorts;
  } catch (err) {
    console.error('[WebClaw] Failed to read port allowlist, using default:', err);
    return defaultPorts;
  }
}

/** Tear down existing bridges and rebuild from the current allowlist. */
async function initializeBridges(): Promise<void> {
  for (const bridge of wsBridges) bridge.disconnect();
  wsBridges = [];
  const ports = await getActivePorts();
  for (const port of ports) {
    wsBridges.push(
      new WebSocketBridge(`ws://127.0.0.1:${port}`, messageRouter),
    );
  }
  console.log(
    `[WebClaw] Initialized ${wsBridges.length} bridge(s) on port(s): ${ports.join(', ')}`,
  );
}

void initializeBridges();

// Reconfigure live when side panel updates the allowlist
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && PORT_ALLOWLIST_KEY in changes) {
    console.log('[WebClaw] Port allowlist changed, reinitializing bridges');
    void initializeBridges();
  }
});

// --- Keepalive ---
chrome.alarms.create('webclaw-keepalive', {
  periodInMinutes: KEEPALIVE_INTERVAL_MS / 60_000,
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'webclaw-keepalive') {
    void chrome.storage.session.get('keepalive');
  }
});

// --- Content Script Messages ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.channel === 'webclaw-content') {
    messageRouter.handleContentScriptMessage(message, sender, sendResponse);
    return true;
  }
  if (message.channel === 'webclaw-sidepanel') {
    broadcastToSidePanel(message);
    sendResponse({ ok: true });
    return false;
  }
});

// --- Side Panel ---
function broadcastToSidePanel(message: unknown): void {
  chrome.runtime.sendMessage({
    channel: 'webclaw-sidepanel-update',
    ...(message as object),
  }).catch(() => {
    // Side panel may not be open
  });
}

// --- Tab Events ---
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    dialogHandler.onTabNavigated(tabId);
  }
  if (changeInfo.status === 'complete') {
    tabManager.onTabReady(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabManager.onTabRemoved(tabId);
  dialogHandler.onTabRemoved(tabId);
});

// --- Side Panel Setup ---
chrome.sidePanel?.setOptions({ enabled: true }).catch(() => {});

// --- Action Click -> open side panel ---
chrome.action?.onClicked?.addListener((tab) => {
  if (tab.id) {
    chrome.sidePanel?.open({ tabId: tab.id }).catch(console.error);
  }
});

// --- Startup ---
console.log('[WebClaw] Service Worker started');

export { messageRouter, tabManager, wsBridges, broadcastToSidePanel };
