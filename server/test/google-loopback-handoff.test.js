// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE CODE REACHES THE APP WITHOUT THE OS'S HELP — the client half.
//
//  Production, 2026-09-06: Google sign-in on a VPN failed on a coin flip.
//  The browser page had the code, the app was asking for it, and the two
//  ways it could travel — the interview-copilot:// deep link (never
//  registered by the 4.0.22 macOS build) and a human retyping it (the page
//  closed itself first) — both failed. The server half is exercised for
//  real in google-handoff-page.test.js; this pins the client half, which
//  cannot boot under vitest, at the source.
//
//  Shape: the renderer starts a loopback listener before the browser opens
//  and puts its port on /google/start; main.cjs binds 127.0.0.1 only, serves
//  one route, hands a well-formed pair to the same door the deep link uses,
//  and closes on the first hand-off or after six minutes; the renderer
//  stops it when the attempt ends either way.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const codeOnly = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const main = codeOnly(read('electron/main.cjs'));
const preload = codeOnly(read('electron/preload.cjs'));
const gate = codeOnly(read('SubscriptionGate.tsx'));

describe('main.cjs — the loopback listener', () => {
  const block = main.slice(main.indexOf("ipcMain.handle('auth:google-loopback-start'"), main.indexOf("ipcMain.handle('auth:google-loopback-stop'"));

  it('binds 127.0.0.1 on an ephemeral port and reports it', () => {
    expect(block).toContain("server.listen(0, '127.0.0.1'");
    expect(block).toContain('const port = server.address().port;');
    expect(block).toContain('return { port };');
  });

  it('serves exactly one GET route and refuses anything else', () => {
    expect(block).toContain("req.method !== 'GET' || url.pathname !== '/google-handoff'");
    expect(block).toMatch(/res\.writeHead\(404/);
  });

  it('accepts only a server-shaped session id and code, through the same door as the deep link', () => {
    expect(block).toContain('/^[A-Za-z0-9_-]{21,64}$/.test(sessionId)');
    expect(block).toContain('/^[0-9A-Za-z-]{10,12}$/.test(code)');
    expect(block).toContain("acceptGoogleHandoff(sessionId, code, 'loopback');");
    // The protocol handler goes through the very same function.
    expect(main).toContain("acceptGoogleHandoff(sessionId, code, 'protocol');");
    const accept = main.slice(main.indexOf('function acceptGoogleHandoff('));
    expect(accept).toContain("win.webContents.send('auth:google-handoff', { sessionId, code });");
    expect(accept).toContain('pendingGoogleHandoff = { sessionId, code, receivedAt: Date.now() };');
  });

  it('closes on the first hand-off, after the TTL, and on request', () => {
    expect(main).toContain('const LOOPBACK_HANDOFF_TTL_MS = 6 * 60 * 1000;');
    expect(block).toContain("setTimeout(() => stopGoogleLoopback('handoff received'), 250);");
    expect(block).toContain("setTimeout(() => stopGoogleLoopback('ttl'), LOOPBACK_HANDOFF_TTL_MS);");
    expect(main).toContain("ipcMain.handle('auth:google-loopback-stop', () => { stopGoogleLoopback('renderer'); return true; });");
  });

  it('never logs the code', () => {
    const accept = main.slice(main.indexOf('function acceptGoogleHandoff('), main.indexOf('let mainWindow = null;'));
    expect(accept).not.toMatch(/electronLog\.[a-z]+\([^)]*\bcode\b/);
  });

  it('fails open — no listener means the deep link and the typed code remain', () => {
    expect(block).toContain('return { port: 0 };');
  });
});

describe('preload.cjs — the channels exist', () => {
  it('exposes start, stop and the settings opener to the renderer', () => {
    for (const ch of ['auth:google-loopback-start', 'auth:google-loopback-stop', 'open-screen-recording-settings']) {
      expect(preload).toContain(`'${ch}',`);
    }
  });
});

describe('SubscriptionGate.tsx — the renderer half', () => {
  it('starts the listener before the browser opens and registers the port at /google/start', () => {
    const start = gate.indexOf("invoke?.('auth:google-loopback-start')");
    const open = gate.indexOf('const authUrl = `${serverUrl}/api/v1/auth/google/start?session_id=${sessionId}');
    expect(start).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(start);
    expect(gate).toContain('const loopbackParam = loopbackPort ? `&lp=${loopbackPort}` : \'\';');
    expect(gate).toContain('${switchAccountParam}${loopbackParam}`;');
  });

  it('accepts only a real port and otherwise sends nothing', () => {
    expect(gate).toContain('if (r && Number.isInteger(r.port) && r.port > 0) loopbackPort = r.port;');
  });

  it('stops the listener whenever the attempt ends — success, cancel, error, timeout', () => {
    // Every terminal path flips googleSubmitting to false; the effect on that
    // flag is the single teardown site, so no exit can leave a listener open.
    const effect = gate.slice(gate.indexOf('if (googleSubmitting) return;'));
    expect(effect.slice(0, 900)).toContain("invoke?.('auth:google-loopback-stop')");
  });

  it('tells the user where the code is when it does have to be typed', () => {
    expect(gate).toContain('The browser tab that says “Signed in” shows a 10-character code — type it here.');
  });
});
