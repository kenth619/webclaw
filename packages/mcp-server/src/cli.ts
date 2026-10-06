#!/usr/bin/env node
/**
 * WebClaw CLI entry point.
 *
 * Usage:
 *   npx webclaw-mcp          - Start the MCP server (stdio transport + WebSocket)
 *   npx webclaw-mcp install  - Output Claude Desktop config
 *   npx webclaw-mcp --help   - Show usage information
 */
import { createWebClawServer } from './server.js';
import { WebSocketClient } from './ws-client.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { install } from './installer.js';
import { WEBSOCKET_DEFAULT_PORT, WEBSOCKET_PORT_ENV, WEBSOCKET_PORT_RANGE_SIZE } from 'webclaw-shared';

const args = process.argv.slice(2);
const PORT_FALLBACK_ENV = 'WEBCLAW_PORT_FALLBACK';

if (args.includes('--help') || args.includes('-h')) {
  console.log(`webclaw-mcp - WebMCP-native browser agent

Usage:
  npx webclaw-mcp              Start the MCP server (stdio + WebSocket)
  npx webclaw-mcp install      Output Claude Desktop config
  npx webclaw-mcp --help       Show this help message

Description:
  WebClaw enables AI assistants like Claude to interact with web pages
  through a Chrome extension and MCP protocol. The MCP server communicates
  with the Chrome extension via a localhost WebSocket connection.

Environment variables:
  ${WEBSOCKET_PORT_ENV}    WebSocket port (default: ${WEBSOCKET_DEFAULT_PORT})
  WEBCLAW_PORT_FALLBACK  Comma-separated ports to try, in order, if WEBCLAW_PORT is in use

Claude Desktop config:
  {
    "mcpServers": {
      "webclaw": { "command": "npx", "args": ["-y", "webclaw-mcp"] }
    }
  }

More info: https://github.com/kuroko1t/webclaw`);
  process.exit(0);
} else if (args[0] === 'install') {
  await install();
} else {
  const explicitPort = process.env[WEBSOCKET_PORT_ENV] ? Number(process.env[WEBSOCKET_PORT_ENV]) : null;
  // PATCHED (port-fallback, 2026-10-06): Claude Desktop now starts each local
  // MCP server twice (its LocalMcpServerManager and the per-chat launcher). With
  // only a pinned port, the second copy hit EADDRINUSE and exited, and chats
  // lost webclaw. WEBCLAW_PORT_FALLBACK lists extra ports to try, in order. It
  // is an explicit list rather than a scan so that a copy can never land on a
  // port another browser profile's allowlist uses (that is what the pin is for).
  const fallbackPorts = (process.env[PORT_FALLBACK_ENV] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(Number)
    .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);

  let wsClient: WebSocketClient;

  if (explicitPort !== null) {
    // Explicit port first, then any WEBCLAW_PORT_FALLBACK ports in order
    const candidates = [explicitPort, ...fallbackPorts.filter((p) => p !== explicitPort)];
    let boundPort: number | null = null;
    wsClient = null!;
    for (const port of candidates) {
      try {
        wsClient = await WebSocketClient.create(port);
        boundPort = port;
        break;
      } catch (err) {
        const error = err as NodeJS.ErrnoException;
        if (error.code === 'EADDRINUSE') {
          console.error(`[WebClaw] Port ${port} is already in use.`);
          continue;
        }
        console.error(`[WebClaw] WebSocket server error: ${error.message}`);
        process.exit(1);
      }
    }
    if (boundPort === null) {
      console.error(
        `[WebClaw] Port(s) ${candidates.join(', ')} are all in use.\n` +
          `  Another WebClaw instance may be running. To fix, stop it, or set\n` +
          `  ${PORT_FALLBACK_ENV} to a free port that the browser extension's\n` +
          `  port allowlist includes.`,
      );
      process.exit(1);
    }
    if (boundPort !== explicitPort) {
      console.error(`[WebClaw] Fell back from port ${explicitPort} to ${boundPort} (${PORT_FALLBACK_ENV}).`);
    }
    console.error(`[WebClaw] WebSocket server listening on 127.0.0.1:${boundPort}`);
  } else {
    // Auto-scan port range
    let boundPort: number | null = null;
    wsClient = null!;
    for (let i = 0; i < WEBSOCKET_PORT_RANGE_SIZE; i++) {
      const port = WEBSOCKET_DEFAULT_PORT + i;
      try {
        wsClient = await WebSocketClient.create(port);
        boundPort = port;
        break;
      } catch (err) {
        const error = err as NodeJS.ErrnoException;
        if (error.code === 'EADDRINUSE') {
          continue;
        }
        console.error(`[WebClaw] WebSocket server error: ${error.message}`);
        process.exit(1);
      }
    }
    if (boundPort === null) {
      console.error(
        `[WebClaw] All ports in range ${WEBSOCKET_DEFAULT_PORT}–${WEBSOCKET_DEFAULT_PORT + WEBSOCKET_PORT_RANGE_SIZE - 1} are in use.\n` +
          `  ${WEBSOCKET_PORT_RANGE_SIZE} WebClaw instances may already be running.`,
      );
      process.exit(1);
    }
    console.error(`[WebClaw] WebSocket server listening on 127.0.0.1:${boundPort}`);
  }

  const cleanup = async () => {
    console.error('[WebClaw] Shutting down...');
    await wsClient.close();
    process.exit(0);
  };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  const server = createWebClawServer({ wsClient });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[WebClaw] MCP Server started (stdio transport)`);
}
