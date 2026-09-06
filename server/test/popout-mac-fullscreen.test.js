// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE POP-OUT MUST FLOAT OVER A FULL-SCREEN APP ON macOS.
//
//  Field report (2026-09-05): Mac users could not get the pop-out on top of
//  a full-screen Zoom / Chrome assessment while Windows users could. The
//  mechanism, verified against Electron 41's native_window_mac.mm and
//  browser_mac.mm:
//
//    • Since macOS 10.14 a normal Dock app's window may not float over
//      ANOTHER app's full-screen Space. Electron's
//      setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
//      therefore calls app.dock.hide() internally, and the `false` form
//      calls app.dock.show() — unless { skipTransformProcessType: true }.
//    • Four unrelated code paths in main.cjs drove that hidden transform
//      (the pop-out's 2 s re-assert, the main window's blur/hide Spaces-pin
//      release, and the session-active hide/show). Every "show" demoted the
//      app and threw the pop-out off the full-screen Space; DockHide is
//      ignored for 1 s after a DockShow, so the next tick did not rescue it.
//    • Electron issue #36364: the plain-window combination does not
//      surface above a full-screen app until the user manually drags the
//      window — which a focusable:false window cannot receive.
//
//  The fix: the pop-out is a `type: 'panel'` window on darwin (Electron's
//  documented "float on top of full-screened apps" type — ElectronNSPanel
//  ORs canJoinAllSpaces + fullScreenAuxiliary into every collection-
//  behavior write and never activates the app), EVERY
//  setVisibleOnAllWorkspaces call carries skipTransformProcessType, and one
//  function (syncMacDockIcon) owns app.dock from state.
//
//  These assertions are source-pinned because electron/main.cjs boots the
//  Electron app on require and cannot be imported in vitest. They pin the
//  contract, not the prose: which flags each call carries and who is
//  allowed to touch app.dock. A future refactor that keeps the contract
//  can restyle freely.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const src = readFileSync(join(ROOT, 'electron', 'main.cjs'), 'utf8');

// Lines of real code only — a comment that merely mentions an API must not
// satisfy (or fail) a call-site assertion.
const codeLines = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));

function functionBody(name) {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `function ${name} must exist in electron/main.cjs`).toBeGreaterThan(-1);
  // Body ends at the next top-level `function ` or top-level `ipcMain.` / `let ` at column 0.
  const rest = src.slice(start + 1);
  const m = /\n(?:function |ipcMain\.|let |const |app\.)/.exec(rest);
  return m ? src.slice(start, start + 1 + m.index) : src.slice(start);
}

describe('pop-out on macOS floats over full-screen apps', () => {
  it('creates the pop-out as an NSPanel on darwin (Electron type: panel)', () => {
    // The panel type is what pins canJoinAllSpaces + fullScreenAuxiliary
    // permanently and makes show()/focus()/clicks non-activating.
    expect(src).toMatch(/\.\.\.\(process\.platform === 'darwin' \? \{ type: 'panel' \} : \{\}\),/);
    // And only for the pop-out — the main window must stay a normal window.
    const mainWin = src.slice(src.indexOf('mainWindow = new BrowserWindow({'), src.indexOf('mainWindow.setContentProtection'));
    expect(mainWin).not.toMatch(/type: 'panel'/);
  });

  it('every setVisibleOnAllWorkspaces call passes skipTransformProcessType: true', () => {
    const calls = codeLines.filter((l) => l.includes('setVisibleOnAllWorkspaces('));
    // pop-out re-assert, main-window pin, main-window release
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const line of calls) {
      expect(line, `process-type transform must be skipped: ${line.trim()}`)
        .toMatch(/skipTransformProcessType:\s*true/);
    }
  });

  it('only syncMacDockIcon (via applyMacDockPolicy) ever calls app.dock.hide()/show()', () => {
    const owner = functionBody('applyMacDockPolicy');
    const countIn = (text, needle) => text.split(needle).length - 1;
    expect(countIn(owner, 'app.dock.hide()')).toBe(1);
    expect(countIn(owner, 'app.dock.show()')).toBe(1);
    // Nowhere else in real code — comments may still explain the history.
    const codeOnly = codeLines.join('\n');
    expect(countIn(codeOnly, 'app.dock.hide()')).toBe(1);
    expect(countIn(codeOnly, 'app.dock.show()')).toBe(1);
    // And the policy is a function of the three states, not of the caller.
    const sync = functionBody('syncMacDockIcon');
    expect(sync).toMatch(/sessionActive \|\| popoutOpen \|\| _macMainWindowSpacesPinned/);
  });

  it('the session-active handler, the pop-out lifecycle and the main-window pin all go through the policy owner', () => {
    expect(src).toMatch(/syncMacDockIcon\('session-start'\)/);
    expect(src).toMatch(/syncMacDockIcon\('session-end'\)/);
    expect(src).toMatch(/syncMacDockIcon\('popout-open'\)/);
    // closed handler: null the window first so popoutOpen reads false.
    expect(src).toMatch(/popoutWindow = null;\s*\n(?:\s*\/\/[^\n]*\n)*\s*syncMacDockIcon\('popout-closed'\)/);
    expect(src).toMatch(/_macMainWindowSpacesPinned = true;\s*\n\s*syncMacDockIcon\('main-window-spaces-pin'\)/);
    expect(src).toMatch(/_macMainWindowSpacesPinned = false;\s*\n\s*syncMacDockIcon\(why\)/);
  });

  it('enforceAlwaysOnTop keeps the screen-saver level and re-asserts Spaces AFTER it', () => {
    const body = functionBody('enforceAlwaysOnTop');
    const level = body.indexOf("setAlwaysOnTop(true, 'screen-saver')");
    const spaces = body.indexOf('setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })');
    expect(level).toBeGreaterThan(-1);
    expect(spaces).toBeGreaterThan(level);
  });

  it('shows the pop-out without activating the app on darwin', () => {
    expect(src).toMatch(/if \(process\.platform === 'darwin'\) popoutWindow\.showInactive\(\);\s*\n\s*else popoutWindow\.show\(\);/);
  });

  it('keeps the stealth flags that made the Windows pop-out work', () => {
    const popout = src.slice(src.indexOf('popoutWindow = new BrowserWindow({'), src.indexOf('popoutWindow.setContentProtection(true)'));
    for (const flag of ['transparent: true', 'frame: false', 'hasShadow: false', 'alwaysOnTop: true', 'resizable: false', 'skipTaskbar: true', 'focusable: false']) {
      expect(popout, `pop-out must still declare ${flag}`).toContain(flag);
    }
    expect(src).toContain('popoutWindow.setContentProtection(true)');
  });
});
