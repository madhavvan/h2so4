// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE CLOCK STOPS WHEN THE MACHINE SLEEPS — AND THE SERVER KNOWS WHO PROMISED
//
//  2026-09: the server bills a heartbeat gap in FULL for clients from
//  SESSION_GATE_MIN_CLIENT (routes/usage.js settleCapFor), closing the
//  slow-beat discount that a 90-second per-settle cap left open. That is only
//  fair because the same client generation stops its own usage session the
//  moment the machine suspends or the screen locks, and reopens it on wake —
//  so a laptop that slept fourteen minutes is never billed fourteen minutes.
//
//  The renderer half cannot run under vitest (Electron), so its contract is
//  pinned at the source: main.cjs relays powerMonitor events on two channels,
//  preload allowlists exactly those channels, and creditTimerService both
//  listens to them and identifies itself to the server with X-App-Version on
//  every usage call. The server half is exercised for real in
//  payments-usage-admin-e2e.test.js ("billed a silent gap in FULL").
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const codeLines = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('usage clock power hooks — client contract', () => {
  it('main.cjs relays powerMonitor suspend/resume (and lock/unlock) to every window on system:suspend / system:resume', () => {
    const src = codeLines(read('electron/main.cjs'));
    expect(src).toMatch(/require\('electron'\)/);
    expect(src.split('\n')[0]).toContain('powerMonitor');
    expect(src).toMatch(/powerMonitor\.on\('suspend',[\s\S]*?broadcastPower\('system:suspend'\)/);
    expect(src).toMatch(/powerMonitor\.on\('resume',[\s\S]*?broadcastPower\('system:resume'\)/);
    expect(src).toMatch(/powerMonitor\.on\('lock-screen',[\s\S]*?broadcastPower\('system:suspend'\)/);
    expect(src).toMatch(/powerMonitor\.on\('unlock-screen',[\s\S]*?broadcastPower\('system:resume'\)/);
    // Fan-out goes to every window, never to a single cached handle that may be gone.
    expect(src).toMatch(/const broadcastPower = \(channel\) => \{[\s\S]*?BrowserWindow\.getAllWindows\(\)/);
  });

  it('preload allowlists exactly those two receive channels (a channel missing here is a silent no-op)', () => {
    const src = read('electron/preload.cjs');
    const start = src.indexOf('RECEIVE_CHANNELS = new Set([');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf(']);', start));
    expect(block).toContain("'system:suspend'");
    expect(block).toContain("'system:resume'");
  });

  it('creditTimerService installs the hooks once, settles on suspend, restarts on resume, and never lets a power pause read as a server drop', () => {
    const src = read('services/creditTimerService.ts');
    expect(src).toMatch(/constructor\(\) \{\s*this\.installPowerHooks\(\);\s*\}/);
    expect(src).toMatch(/window\.electronAPI\.on\('system:suspend', \(\) => this\.onSystemSuspend\(\)\)/);
    expect(src).toMatch(/window\.electronAPI\.on\('system:resume', \(\) => this\.onSystemResume\(\)\)/);
    const suspend = src.slice(src.indexOf('private onSystemSuspend()'), src.indexOf('private onSystemResume()'));
    expect(suspend).toContain('this.powerSuspended = true;');
    expect(suspend).toContain('this.stopLocalOnly();');
    expect(suspend).toContain('void this.settleStop(sid);');
    // A power pause emits 'suspended', not 'stopped' — App's "session dropped,
    // reopen it" listener watches 'stopped' and must not reopen a session on
    // a machine that is going to sleep.
    expect(suspend).toContain("this.emit('suspended');");
    expect(suspend).not.toContain("this.emit('stopped')");
    const resume = src.slice(src.indexOf('private onSystemResume()'), src.indexOf('}', src.indexOf('void this.start();', src.indexOf('private onSystemResume()'))));
    expect(resume).toContain('if (!this.powerSuspended) return;');
    expect(resume).toContain('void this.start();');
    // An explicit stop outranks a pending resume.
    expect(src).toMatch(/stop\(\): void \{\s*this\.powerSuspended = false;/);
    expect(src).toMatch(/type EventName = [^\n]*'suspended'[^\n]*'resumed'/);
  });

  it('every usage call carries X-App-Version so the server can pick the full-gap cap for this client generation', () => {
    const src = read('services/creditTimerService.ts');
    for (const route of ['/api/v1/usage/start', '/api/v1/usage/stop', '/api/v1/usage/heartbeat']) {
      const at = src.indexOf(route);
      expect(at, `${route} must be called`).toBeGreaterThan(-1);
      const window = src.slice(at, at + 500);
      expect(window, `${route} must send X-App-Version`).toContain("'X-App-Version': licenseService.getAppVersion()");
    }
    // The stop that runs as the machine goes down must be allowed to outlive the renderer.
    const stopAt = src.indexOf('/api/v1/usage/stop');
    expect(src.slice(stopAt, stopAt + 600)).toContain('keepalive: true');
  });
});

describe('usage clock power hooks — server contract', () => {
  it('routes/usage.js settles start, heartbeat and stop with the per-client cap, keyed on the SAME constant as the session gate', () => {
    const src = codeLines(read('server/src/routes/usage.js'));
    expect(src).toMatch(/require\('\.\.\/middleware\/clientVersion'\)/);
    expect(src).toMatch(/function settleCapFor\(req\) \{\s*return clientAtLeast\(req, USAGE_FULL_GAP_MIN_CLIENT\) \? USAGE_FULL_GAP_CAP_S : USAGE_HEARTBEAT_CAP_S;/);
    expect(src.match(/settleCapFor\(req\)/g)).toHaveLength(4); // definition + start + heartbeat + stop
    expect(src).toContain('db.heartbeatUsageSession(req.user.id, sessionId, { capSeconds: capS })');
    expect(src).toContain('db.stopUsageSession(req.user.id, sessionId, { capSeconds: capS })');
    expect(src).toContain('settleOpenUsageSessions(req.user.id, now, settleCapFor(req))');
  });

  it('the thresholds have one home; ai.js imports the gate rather than declaring its own', () => {
    const cv = require('../src/middleware/clientVersion.js');
    // The power hooks shipped in 4.0.23, so full-gap billing starts there —
    // and it is NOT tied to the session gate, which is held ahead of the
    // shipping build until it is armed on purpose.
    expect(cv.USAGE_FULL_GAP_MIN_CLIENT).toBe('4.0.23');
    expect(cv.versionRank(cv.SESSION_GATE_MIN_CLIENT)).toBeGreaterThan(cv.versionRank(cv.USAGE_FULL_GAP_MIN_CLIENT));
    expect(typeof cv.clientAtLeast).toBe('function');
    const ai = codeLines(read('server/src/routes/ai.js'));
    expect(ai).not.toMatch(/const SESSION_GATE_MIN_CLIENT\s*=/);
    expect(ai).toMatch(/SESSION_GATE_MIN_CLIENT,\s*\} = require\('\.\.\/middleware\/clientVersion'\)/);
    // The full-gap cap IS the liveness window, and the conservative cap is unchanged.
    const db = require('../src/database.js');
    expect(db.USAGE_FULL_GAP_CAP_S).toBe(db.USAGE_STALE_AFTER_MS / 1000);
    expect(db.USAGE_HEARTBEAT_CAP_S).toBe(90);
    expect(db.settleCapSeconds(undefined)).toBe(90);
    expect(db.settleCapSeconds(0)).toBe(90);
    expect(db.settleCapSeconds(300)).toBe(300);
    expect(db.settleCapSeconds(99999)).toBe(db.USAGE_FULL_GAP_CAP_S);
    // clientAtLeast reads the header when the middleware did not run, and fails toward "old".
    expect(cv.clientAtLeast({ headers: { 'x-app-version': '4.0.23' } }, '4.0.23')).toBe(true);
    expect(cv.clientAtLeast({ headers: { 'x-app-version': '4.0.22' } }, '4.0.23')).toBe(false);
    expect(cv.clientAtLeast({ headers: {} }, '4.0.23')).toBe(false);
    expect(cv.clientAtLeast({ headers: { 'x-app-version': 'garbage' } }, '4.0.23')).toBe(false);
    expect(cv.clientAtLeast({ clientRank: 4000030 }, '4.0.23')).toBe(true);
  });
});
