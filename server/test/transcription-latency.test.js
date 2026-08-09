// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE THREE DELAYS THAT SIT BETWEEN "THEY STOPPED TALKING" AND
//  "THE MODEL WAS ASKED".
//
//  On 2026-08-08 a user reported both "the voice is getting transcribed
//  late" and "sometimes getting late responses". They were one chain:
//
//    Deepgram smart_format holds a final ...... up to 3,000ms
//    auto-send silence timer .................. 1,200ms
//    LLM cover, awaited before the main call ... up to 4,500ms
//    ------------------------------------------------------------
//    before the main model is even ISSUED ..... up to 8,700ms
//
//  Each was defensible alone. Together they are the product failing in a
//  live interview. These assertions exist because every one of them is a
//  single character away from coming back, and none of them fails a build.
//
//  Source-asserted: a renderer hook cannot be imported here, and a
//  WebSocket to Deepgram is not something a unit test should open.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const speechHook = readFileSync(join(ROOT, 'hooks', 'useSpeechRecognition.ts'), 'utf8');
const appTsx = readFileSync(join(ROOT, 'App.tsx'), 'utf8');

/** The querystring of the Deepgram live-listen socket, as shipped. */
function deepgramQuery() {
  const m = speechHook.match(/wss:\/\/api\.deepgram\.com\/v1\/listen\?([^'"`]+)/);
  return m ? new URLSearchParams(m[1]) : null;
}

describe('the Deepgram socket is configured for a live interview', () => {
  it('opens exactly one live-listen socket', () => {
    const hits = speechHook.match(/wss:\/\/api\.deepgram\.com\/v1\/listen/g) || [];
    expect(hits.length, 'two sockets means two configurations to keep in step').toBe(1);
  });

  it('sets no_delay — smart_format otherwise holds a final for up to 3s', () => {
    const q = deepgramQuery();
    expect(q, 'could not find the Deepgram URL at all').not.toBeNull();
    // Only meaningful BECAUSE smart_format is on; if smart_format ever goes
    // away this assertion should be revisited rather than blindly kept.
    expect(q.get('smart_format')).toBe('true');
    expect(
      q.get('no_delay'),
      'smart_format waits for entity completion or 3s of silence before it ' +
        'finalizes. Interview answers END on entities ("...at Evonik", ' +
        '"...from 2023"), and handleSpeechResult only arms the auto-send ' +
        'timer inside `if (final)` — so a held final delays the ANSWER too.'
    ).toBe('true');
  });

  it('still asks for interim results — they are what the user watches', () => {
    expect(deepgramQuery().get('interim_results')).toBe('true');
  });

  it('is on a current streaming model', () => {
    // nova-3 is Deepgram's recommended flagship for general streaming STT.
    // Flux is newer but is a voice-AGENT model with its own turn-taking, not
    // a drop-in for interim transcription — changing to it is a redesign,
    // not a version bump. Fail loudly if someone drops back to nova-2.
    expect(deepgramQuery().get('model')).toMatch(/^(nova-3|flux)/);
  });
});

describe('only the main window owns the server-side usage session', () => {
  it('the credit timer never starts or stops from the popout', () => {
    // The popout mirrors the mic via remoteIsListening and mounts the same
    // hook. Without this guard its start() SUPERSEDES the main window's
    // session and its stop() settles it, leaving the mic on with no live
    // session — which the session gate answers with 428.
    const hook = appTsx.slice(appTsx.indexOf('function useCreditTimer'));
    const body = hook.slice(0, hook.indexOf('acknowledgeHourBoundary'));
    expect(body).toContain('creditTimerService.start()');
    expect(
      (body.match(/if \(isPopoutMode\) return;/g) || []).length,
      'both the mic-driven effect AND the unmount settler must bail in the ' +
        'popout — closing the popout mid-interview is the normal way an ' +
        'overlay ends, and settling the shared row there is the same bug ' +
        'through a different door'
    ).toBeGreaterThanOrEqual(2);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE GHOST MAY LEAD THE TEXTAREA. IT MAY NOT DUPLICATE IT.
//
//  Both composers (pop-out and main) paint a muted layer BEHIND the
//  textarea so interim words show the instant Deepgram sends them, while
//  the textarea only updates on a final. That lead is deliberate.
//
//  What was not: the layer rendered `{inputText}{interimText}`, so the
//  FINALISED text was drawn twice — in the pop-out at 12px italic behind
//  0.9rem upright, two fonts that cannot align. Users reported "another
//  shadow normal text" racing ahead of the real one (2026-08-08).
//
//  The finals must reserve their width without being painted. Asserted on
//  source because this is a rendering property with no headless surface.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('the interim ghost never double-paints the finalised text', () => {
  it('no composer renders inputText and interimText both visibly', () => {
    // The exact shape of the bug: the two adjacent, both painted.
    const doubled = appTsx.match(/\{inputText\}\{interimText\}/g) || [];
    expect(
      doubled.length,
      'a ghost layer that paints {inputText} on top of the textarea\'s own ' +
        '{inputText} shows every finalised word twice, in two fonts'
    ).toBe(0);
  });

  it('every ghost layer hides the finals while keeping their width', () => {
    // visibility:hidden / .invisible keep the box (so the interim lands after
    // the finals); display:none would collapse it and misplace the interim.
    const ghosts = appTsx.match(/\{interimText && \([\s\S]{0,900}?\)\}/g) || [];
    expect(ghosts.length, 'expected the pop-out and main composers').toBeGreaterThanOrEqual(2);
    for (const g of ghosts) {
      expect(g).toContain('{interimText}');
      expect(
        /visibility:\s*'hidden'|className="invisible"/.test(g),
        'this ghost paints the finals — it must hide them:\n' + g.slice(0, 220)
      ).toBe(true);
      expect(g, 'display:none would collapse the reserved width').not.toMatch(/display:\s*'none'/);
    }
  });

  it('no ghost is italic while the textarea it sits behind is not', () => {
    const ghosts = appTsx.match(/\{interimText && \([\s\S]{0,900}?\)\}/g) || [];
    for (const g of ghosts) {
      expect(g, 'slanted glyphs cannot line up with upright ones').not.toMatch(/\bitalic\b/);
    }
  });
});
