// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE MIC SHOWS ON IN ONE BREATH, NOT FIVE SECONDS
//
//  Field report (2026-09-05): the mic button took 4-5 s to show ON. Measured
//  cause: a strictly serial start (key mint → every desktop source with a
//  thumbnail → desktop capture with an unused 1080p video track → socket),
//  zero feedback until the very last step, the key thrown away on every stop
//  and re-minted on every reconnect.
//
//  These pins hold the shape of the fix at the source, because the renderer
//  hook and electron/main.cjs cannot be imported under vitest. The server
//  half — one mint per user per window — is exercised for real in
//  deepgram-key-cache.test.js.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const codeOnly = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const hook = read('hooks/useSpeechRecognition.ts');
const hookCode = codeOnly(hook);
const app = read('App.tsx');
const main = codeOnly(read('electron/main.cjs'));
const keyModule = read('services/deepgramKey.ts');

describe('the click is acknowledged at once', () => {
  it('the hook exposes isStarting / isReconnecting and sets isStarting before any await', () => {
    expect(hookCode).toMatch(/return \{ isListening, isStarting, isReconnecting, error, notice, startListening, stopListening, stream: currentStream \};/);
    const start = hookCode.slice(hookCode.indexOf('const startListening = useCallback'));
    const firstAwait = start.indexOf('await ');
    const setStarting = start.indexOf('setIsStarting(true);');
    expect(setStarting).toBeGreaterThan(-1);
    expect(setStarting).toBeLessThan(firstAwait);
  });

  it('both mic buttons render STARTING… (spinner) and RECONNECTING… and are disabled while starting', () => {
    expect((app.match(/'STARTING…'/g) || []).length).toBe(2);
    expect((app.match(/'RECONNECTING…'/g) || []).length).toBe(2);
    expect((app.match(/disabled=\{isMicStarting\}/g) || []).length).toBe(2);
  });

  it('the popout mirrors both states through the state-sync payload (live and request-state replies)', () => {
    expect(app).toMatch(/isStarting: _rawIsStarting,\s*\n\s*isReconnecting: _rawIsReconnecting,/);
    expect(app).toMatch(/isStarting: rawIsStartingRef\.current,\s*\n\s*isReconnecting: rawIsReconnectingRef\.current,/);
    expect(app).toContain('setRemoteIsStarting(!!data.isStarting);');
    expect(app).toContain('setRemoteIsReconnecting(!!data.isReconnecting);');
    expect(app).toMatch(/speechError, speechNotice, isMicStarting, isMicReconnecting, toggleAutoSend/); // sharedProps → ChatInterface
  });
});

describe('the start does the two slow things at the same time and never mints twice', () => {
  it('key fetch and capture run in parallel; a capture that succeeded while the key failed is released', () => {
    expect(hookCode).toContain('await Promise.allSettled([getDeepgramKeyCached(), getAudioStream()])');
    const afterAll = hookCode.slice(hookCode.indexOf('Promise.allSettled(['));
    expect(afterAll).toMatch(/keyResult\.status === 'rejected'[\s\S]{0,200}stream\.getTracks\(\)\.forEach/);
  });

  it('stopping the mic no longer throws the key away; the key module owns its lifetime', () => {
    expect(hookCode).not.toContain('deepgramKeyRef');
    expect(hookCode).toMatch(/import \{ getDeepgramKeyCached, invalidateDeepgramKey \} from '\.\.\/services\/deepgramKey';/);
    for (const fn of ['export function peekDeepgramKey', 'export function invalidateDeepgramKey', 'export async function getDeepgramKeyCached', 'export function prefetchDeepgramKey', 'function scheduleRefresh']) {
      expect(keyModule, `${fn} must exist`).toContain(fn);
    }
    // The key is prefetched when the interview screen mounts, main window only.
    expect(app).toMatch(/if \(isPopoutThinClient\) return;\s*\n\s*prefetchDeepgramKey\(\);/);
    // aiProxyService keeps its export as an alias onto the cache.
    expect(read('services/aiProxyService.ts')).toMatch(/export async function getDeepgramKey\(\): Promise<string> \{\s*return getDeepgramKeyCached\(\);\s*\}/);
  });

  it('a key Deepgram rejected is invalidated; an ordinary drop reuses the cached one', () => {
    const onclose = hookCode.slice(hookCode.indexOf('socket.onclose = (event) => {'), hookCode.indexOf('socket.onerror = (e) => {'));
    expect(onclose).toContain('const fastFail = !gotDataRef.current;');
    expect(onclose).toMatch(/if \(fastFail \|\| event\.code === 1008 \|\| \(event\.code >= 4000 && event\.code < 5000\)\) \{\s*invalidateDeepgramKey\(\);/);
    expect(onclose).toContain('getDeepgramKeyCached({ force: fastFail })');
  });
});

describe('reconnects keep the interview going', () => {
  it('the first retry is immediate and the button is not flipped OFF while reconnecting', () => {
    const onclose = hookCode.slice(hookCode.indexOf('socket.onclose = (event) => {'), hookCode.indexOf('socket.onerror = (e) => {'));
    expect(onclose).toContain('const delay = n <= 1 ? 0 : Math.min(1000 * Math.pow(2, n - 2), 5000);');
    const reconnectBlock = onclose.slice(onclose.indexOf('reconnectAttemptsRef.current += 1;'));
    expect(reconnectBlock).not.toContain('setIsListening(false)');
    expect(reconnectBlock).toContain('setIsReconnecting(true);');
    // The give-up path (five closes with no data) is the one place the button goes OFF.
    const giveUp = onclose.slice(onclose.indexOf('fastFailStreakRef.current >= 5'), onclose.indexOf('const audioLive'));
    expect(giveUp).toContain('setIsListening(false);');
  });
});

describe('the capture is cheap', () => {
  it('the desktop-source lookup asks for the screen only, with no thumbnails, from every renderer caller', () => {
    expect(hookCode).toContain("invoke<any[]>('get-desktop-sources', { screenOnly: true, thumbnails: false })");
    expect((app.match(/electronIPC\.invoke\('get-desktop-sources', \{ screenOnly: true, thumbnails: false \}\)/g) || []).length).toBe(2);
    expect(app).not.toMatch(/invoke\('get-desktop-sources'\)/);
  });

  it('main.cjs honours screenOnly / thumbnails on get-desktop-sources', () => {
    const handler = main.slice(main.indexOf("ipcMain.handle('get-desktop-sources'"), main.indexOf("ipcMain.handle('open-external-robust'"));
    expect(handler).toContain("types: screenOnly ? ['screen'] : ['window', 'screen']");
    expect(handler).toContain('thumbnailSize: thumbnails ? { width: 150, height: 150 } : { width: 0, height: 0 }');
  });

  it('Windows takes the getDisplayMedia + OS loopback path and drops the unused video track', () => {
    const fast = hookCode.slice(hookCode.indexOf('if (isWindows && navigator.mediaDevices?.getDisplayMedia)'), hookCode.indexOf("invoke<any[]>('get-desktop-sources'"));
    expect(fast).toContain('await navigator.mediaDevices.getDisplayMedia({');
    expect(fast).toContain('audio: true,');
    expect(fast).toMatch(/stream\.getVideoTracks\(\)\.forEach\(v => \{ try \{ v\.stop\(\); \}/);
    // …and falls back to the legacy capture on any failure (macOS, no audio track).
    expect(fast).toContain('falling back to desktop capture');
  });

  it('main.cjs answers getDisplayMedia with the primary screen, loopback audio on win32 only, app frames only', () => {
    const start = main.indexOf('session.defaultSession.setDisplayMediaRequestHandler(');
    expect(start).toBeGreaterThan(-1);
    const handler = main.slice(start, main.indexOf('{ useSystemPicker: false }', start));
    expect(handler).toContain("desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })");
    expect(handler).toContain("if (request.audioRequested && process.platform === 'win32') grant.audio = 'loopback';");
    expect(handler).toContain('if (!isAppUrl(frameUrl))');
    // The permission allowlist already carries display-capture for the app origin.
    expect(main).toContain("'display-capture',");
  });

  it('the Deepgram socket itself is untouched: one listen URL, no_delay still on', () => {
    const urls = hook.match(/wss:\/\/api\.deepgram\.com\/v1\/listen\?[^'"`]+/g) || [];
    expect(urls).toHaveLength(1);
    expect(new URLSearchParams(urls[0].split('?')[1]).get('no_delay')).toBe('true');
  });
});
