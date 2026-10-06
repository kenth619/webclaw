import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// PATCHED (port-fallback, 2026-10-06): Claude Desktop starts each local MCP
// server twice, so a single pinned WEBCLAW_PORT leaves the second copy with
// EADDRINUSE. These tests drive the built CLI (dist/cli.js) with real ports
// held by a plain TCP server, so build before running them.

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, '../../dist/cli.js');

const holders: Server[] = [];
const children: ChildProcess[] = [];

function holdPort(port: number): Promise<void> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(port, '127.0.0.1', () => {
      holders.push(s);
      res();
    });
  });
}

interface CliResult {
  stderr: string;
  exitCode: number | null;
  listeningPort: number | null;
}

function runCli(env: Record<string, string>): Promise<CliResult> {
  return new Promise((res) => {
    const child = spawn('node', [cliPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    children.push(child);
    let stderr = '';
    let settled = false;
    const done = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const m = stderr.match(/listening on 127\.0\.0\.1:(\d+)/);
      res({ stderr, exitCode, listeningPort: m ? Number(m[1]) : null });
    };
    const timer = setTimeout(() => done(child.exitCode), 6000);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.includes('MCP Server started')) done(null);
    });
    child.on('exit', (code) => done(code));
  });
}

afterEach(async () => {
  for (const c of children.splice(0)) {
    if (c.exitCode === null) c.kill();
  }
  await Promise.all(holders.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe('WEBCLAW_PORT_FALLBACK', () => {
  it('falls back to the fallback port when WEBCLAW_PORT is in use', async () => {
    await holdPort(19081);
    const r = await runCli({ WEBCLAW_PORT: '19081', WEBCLAW_PORT_FALLBACK: '19082' });
    expect(r.exitCode).toBeNull();
    expect(r.listeningPort).toBe(19082);
    expect(r.stderr).toContain('Fell back from port 19081 to 19082');
  }, 15000);

  it('tries fallbacks in order and skips a busy one', async () => {
    await holdPort(19083);
    await holdPort(19084);
    const r = await runCli({ WEBCLAW_PORT: '19083', WEBCLAW_PORT_FALLBACK: '19084, 19085' });
    expect(r.exitCode).toBeNull();
    expect(r.listeningPort).toBe(19085);
  }, 15000);

  it('uses the pinned port when it is free and does not fall back', async () => {
    const r = await runCli({ WEBCLAW_PORT: '19089', WEBCLAW_PORT_FALLBACK: '19090' });
    expect(r.exitCode).toBeNull();
    expect(r.listeningPort).toBe(19089);
    expect(r.stderr).not.toContain('Fell back');
  }, 15000);

  it('exits 1 when the pinned port is in use and no fallback is set', async () => {
    await holdPort(19086);
    const r = await runCli({ WEBCLAW_PORT: '19086', WEBCLAW_PORT_FALLBACK: '' });
    expect(r.exitCode).toBe(1);
    expect(r.listeningPort).toBeNull();
  }, 15000);

  it('exits 1 when the pinned port and every fallback are in use', async () => {
    await holdPort(19087);
    await holdPort(19088);
    const r = await runCli({ WEBCLAW_PORT: '19087', WEBCLAW_PORT_FALLBACK: '19088' });
    expect(r.exitCode).toBe(1);
    expect(r.listeningPort).toBeNull();
  }, 15000);
});
