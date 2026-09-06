// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  A CAPTURE FAILURE MUST NOT LEAVE THE MIC OFF.
//
//  Field report, macOS, 2026-09-06 (screenshot): "Capture Error: Error
//  invoking remote method 'get-desktop-sources': Failed to get sources",
//  mic OFF, "Listening for interviewer…" beneath it. Screen Recording was
//  off for the app; desktopCapturer threw; the throw reached startListening
//  and the button never turned on. The one sentence the user saw named an
//  IPC method.
//
//  Two changes, pinned here at the source because neither file boots under
//  vitest:
//    • main.cjs reads the permission state first and says what to turn on,
//      and wraps the Chromium failure in a sentence that names the pane.
//    • the hook falls back to the microphone when meeting-audio capture
//      fails for any reason, and reports that as a NOTICE (mic ON, amber),
//      never as the red error over an OFF button. App.tsx renders the
//      notice beside the button and mirrors it to the pop-out like the
//      error, with a one-click route to the Screen Recording pane.
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
const hook = codeOnly(read('hooks/useSpeechRecognition.ts'));
const app = read('App.tsx');
const docs = read('docs/public/TROUBLESHOOTING.md');

describe('main.cjs — get-desktop-sources explains itself', () => {
  const handler = main.slice(main.indexOf("ipcMain.handle('get-desktop-sources'"), main.indexOf("ipcMain.handle('open-screen-recording-settings'"));

  it('checks the macOS Screen Recording permission before asking Chromium', () => {
    expect(handler).toContain("systemPreferences.getMediaAccessStatus('screen')");
    expect(handler).toContain("if (status === 'denied' || status === 'restricted')");
    expect(handler).toContain('Screen Recording permission is ${status} for Interview Copilot.');
    expect(handler).toContain("err.code = 'SCREEN_RECORDING_DENIED';");
  });

  it('wraps a Chromium failure in a sentence that names the pane', () => {
    expect(handler).toMatch(/try \{\s*sources = await desktopCapturer\.getSources\(/);
    expect(handler).toContain('Screen & System Audio Recording');
    expect(handler).toContain("err.code = 'DESKTOP_SOURCES_UNAVAILABLE';");
  });

  it('offers the one-click route to that pane, on macOS only', () => {
    const opener = main.slice(main.indexOf("ipcMain.handle('open-screen-recording-settings'"));
    expect(opener).toContain("if (process.platform !== 'darwin') return false;");
    expect(opener).toContain("shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')");
  });
});

describe('the hook — microphone-only fallback', () => {
  it('any failure of the desktop path falls back to the microphone instead of throwing', () => {
    const legacy = hook.slice(hook.indexOf("invoke<any[]>('get-desktop-sources'"), hook.indexOf('} else {', hook.indexOf("invoke<any[]>('get-desktop-sources'")));
    expect(legacy).toContain('return micOnlyCapture(captureErr);');
    // The BlackHole throw still exists — inside the try, so it now lands in the fallback.
    expect(legacy).toContain("throw new Error('No system audio detected. On macOS you may need a virtual audio driver (e.g. BlackHole).');");
  });

  it('the fallback opens the microphone only, and says why it is the microphone', () => {
    const fb = hook.slice(hook.indexOf('async function micOnlyCapture('), hook.indexOf('async function getAudioStream('));
    expect(fb).toContain('video: false,');
    expect(fb).toContain("const permission = /screen recording/i.test(why);");
    expect(fb).toContain('Microphone only — meeting audio needs Screen Recording permission.');
    expect(fb).toContain('return { stream: mic, audioStream: mic, notice };');
    // A mic that cannot be opened either is a real error, and it carries both reasons.
    expect(fb).toContain('and the microphone could not be opened either');
  });

  it('a notice is not an error: the mic goes ON and the notice is exposed separately', () => {
    const start = hook.slice(hook.indexOf('const startListening = useCallback'));
    expect(start).toContain("const { stream, audioStream, notice: captureNotice } = captureResult.value;");
    expect(start).toContain('setNotice(captureNotice || null);');
    expect(start).toContain('if (captureNotice) onNotice?.(captureNotice);');
    expect(hook).toMatch(/return \{ isListening, isStarting, isReconnecting, error, notice, startListening, stopListening, stream: currentStream \};/);
    // Cleared on stop, refreshed on re-acquire.
    const stop = hook.slice(hook.indexOf('const stopListening = useCallback'), hook.indexOf('const connectDeepgram'));
    expect(stop).toContain('setNotice(null);');
    expect(hook).toContain('const { stream, audioStream, notice: reNotice } = await getAudioStream();');
  });
});

describe('App.tsx — the notice reaches both windows', () => {
  it('reads the notice from the hook and mirrors it to the pop-out like the error', () => {
    expect(app).toContain('notice: _rawSpeechNotice,');
    expect(app).toContain('const speechNotice = isPopoutThinClient ? remoteSpeechNotice : _rawSpeechNotice;');
    expect(app).toContain('speechNotice: _rawSpeechNotice,');
    expect(app).toContain('speechNotice: rawSpeechNoticeRef.current,');
    expect(app).toContain('setRemoteSpeechNotice(data.speechNotice ?? null);');
    expect(app).toMatch(/speechError, speechNotice, isMicStarting, isMicReconnecting, toggleAutoSend/);
  });

  it('renders amber beside the mic, yields to a real error, and offers the settings button for the permission case', () => {
    expect((app.match(/\{!speechError && speechNotice && \(/g) || []).length).toBe(2);
    expect(app).toContain('bg-amber-500/90');
    expect(app).toContain("/screen recording/i.test(speechNotice)");
    expect(app).toContain("invoke?.('open-screen-recording-settings')");
  });
});

describe('the troubleshooting page says the same thing', () => {
  it('names the exact error text and the fix', () => {
    expect(docs).toContain("Capture Error: Error invoking remote method 'get-desktop-sources': Failed to get sources");
    expect(docs).toContain('microphone-only');
    expect(docs).toContain('Google sign-in asks for a code.');
  });
});
