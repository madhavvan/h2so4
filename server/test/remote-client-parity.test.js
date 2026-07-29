// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  DRIFT GUARD for the phone's copy of the protocol.
//
//  The phone app lives in a separate repo with a separate deploy
//  (Vercel), so it cannot import this one — it carries a copy of the
//  contract. A copy is fine. A copy that quietly disagrees is not: add a
//  command here, forget it there, and the button on the phone comes back
//  "unknown_command" with no clue why.
//
//  So this test asserts they agree, on the machine where both repos
//  actually live. If the phone project isn't checked out, it skips
//  rather than fails — a missing sibling repo is not a broken server.
//
//  It compares MEANING, not text: the version number, and every event
//  and command name. Formatting, comments and TypeScript syntax are
//  free to differ, because none of that goes over the wire.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const server = await import('../src/services/remoteProtocol.js');

// Where the companion app is expected to sit relative to this repo, plus
// the home-directory location it actually occupies on the dev machine.
const CANDIDATES = [
  path.resolve(process.cwd(), '../../interview-copilot-mobile/src/remote/protocol.ts'),
  path.resolve(process.cwd(), '../../../interview-copilot-mobile/src/remote/protocol.ts'),
  path.join(os.homedir(), 'interview-copilot-mobile', 'src', 'remote', 'protocol.ts'),
];

const phoneProtocolPath = CANDIDATES.find(p => fs.existsSync(p));
const phoneClientPath = phoneProtocolPath
  ? path.join(path.dirname(phoneProtocolPath), 'RemoteClient.ts')
  : null;
const desktopClientPath = path.resolve(process.cwd(), '../services/remoteClient.ts');

/** Pull `KEY: 'value'` pairs out of an exported object literal. Small
 *  and deliberately dumb — a parser here would be a second thing that
 *  can be wrong. */
function readMap(src, name) {
  const m = new RegExp(`export const ${name}\\s*=\\s*\\{([\\s\\S]*?)\\}\\s*as const`).exec(src);
  if (!m) return null;
  const out = {};
  const pair = /(\w+)\s*:\s*'([^']+)'/g;
  let p;
  while ((p = pair.exec(m[1])) !== null) out[p[1]] = p[2];
  return out;
}

describe('phone protocol copy stays in sync', () => {
  if (!phoneProtocolPath) {
    it.skip('phone app not checked out beside this repo — nothing to compare', () => {});
    return;
  }

  const src = fs.readFileSync(phoneProtocolPath, 'utf8');

  it('agrees on the protocol version', () => {
    const m = /export const PROTOCOL_VERSION\s*=\s*(\d+)/.exec(src);
    expect(m, 'PROTOCOL_VERSION not found in the phone copy').toBeTruthy();
    expect(Number(m[1])).toBe(server.PROTOCOL_VERSION);
  });

  it('knows every event the desktop can publish', () => {
    const phone = readMap(src, 'EVENT');
    expect(phone, 'EVENT map not found in the phone copy').toBeTruthy();
    // Same keys AND same wire values. A phone missing an event silently
    // ignores part of the mirror; a renamed value is worse, because both
    // sides think they handled it.
    expect(Object.keys(phone).sort()).toEqual(Object.keys(server.EVENT).sort());
    for (const [k, v] of Object.entries(server.EVENT)) expect(phone[k]).toBe(v);
  });

  it('knows every command the desktop can execute', () => {
    const phone = readMap(src, 'COMMAND');
    expect(phone, 'COMMAND map not found in the phone copy').toBeTruthy();
    expect(Object.keys(phone).sort()).toEqual(Object.keys(server.COMMAND).sort());
    for (const [k, v] of Object.entries(server.COMMAND)) expect(phone[k]).toBe(v);
  });

  it('runs the same client code the desktop repo tests', () => {
    // Not "equivalent" — IDENTICAL. The e2e suite exercises the desktop
    // copy; this assertion is what makes those results a statement about
    // the code actually running on the phone, rather than about a
    // lookalike that has since been edited.
    //
    // If this fails, the fix is a copy, not a merge:
    //   cp services/remoteClient.ts \
    //      ../../interview-copilot-mobile/src/remote/RemoteClient.ts
    const desktop = fs.readFileSync(desktopClientPath, 'utf8');
    const phone = fs.readFileSync(phoneClientPath, 'utf8');
    expect(phone).toBe(desktop);
  });

  it('does not ship a microphone', () => {
    // The product rule, enforced as a fact about the code rather than a
    // promise in a README. If capture ever appears in the phone app, this
    // fails before anyone ships it.
    const dir = path.dirname(path.dirname(phoneProtocolPath));   // src/
    const offenders = [];
    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        // Comments stripped first. A file that EXPLAINS why it never
        // calls getUserMedia is the opposite of a violation, and the
        // first version of this test failed on exactly that.
        const text = stripComments(fs.readFileSync(full, 'utf8'));
        // The old standalone app's files are still on disk but are not
        // reachable from the entry point; the check that matters is what
        // the shipped app imports, which App.tsx roots.
        if (/getUserMedia\s*\(|new\s+MediaRecorder|new\s+(webkit)?AudioContext/.test(text) && isReachable(full, dir)) {
          offenders.push(path.relative(dir, full));
        }
      }
    };
    walk(dir);
    expect(offenders, `capture APIs reachable from the phone app: ${offenders.join(', ')}`).toEqual([]);
  });
});

/** Block and line comments out, string literals left alone. Crude on
 *  purpose — it only has to be good enough that prose about an API does
 *  not read as a call to it. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Follow relative imports out from App.tsx and report whether `file` is
 *  among them. Cheap reachability — good enough to answer "does the
 *  shipped app include this". */
function isReachable(file, srcDir) {
  const entry = path.join(srcDir, 'App.tsx');
  if (!fs.existsSync(entry)) return true;        // can't prove otherwise
  const seen = new Set();
  const stack = [entry, path.join(srcDir, 'main.tsx')];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || seen.has(cur)) continue;
    seen.add(cur);
    if (!fs.existsSync(cur)) continue;
    const text = fs.readFileSync(cur, 'utf8');
    for (const m of text.matchAll(/from\s+'(\.[^']+)'/g)) {
      const base = path.resolve(path.dirname(cur), m[1]);
      for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
        const cand = base + ext;
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) { stack.push(cand); break; }
      }
    }
  }
  return seen.has(file);
}
