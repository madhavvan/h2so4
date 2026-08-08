// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE ACTUAL PRODUCT, DRIVEN THE WAY A PERSON WOULD.
//
//  Not the classes, not the protocol — the two real apps. A real phone
//  browser at 390×844 loads the real PWA, the real Electron desktop
//  hosts, and every claim below is read back out of the phone's DOM
//  after a real tap.
//
//  Tests pass on code that is wired to nothing. This is the check that
//  catches that.
//
//  Prerequisites (the script says so plainly if one is missing):
//    • API           node --env-file=.env src/index.js          :4000
//    • phone PWA     HTTPS=0 VITE_SERVER_URL=http://127.0.0.1:4000 vite --port 5175
//    • desktop app   node node_modules/electron/cli.js . --remote-debugging-port=9222
//
//  Run from the server/ directory:
//    node --env-file=.env scripts/verify-phone-remote.mjs
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const WS = require('ws');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');

const PHONE_URL = process.env.PHONE_URL || 'http://127.0.0.1:5175/';
const API = process.env.API_URL || 'http://127.0.0.1:4000';
const SHOTS = process.env.SHOT_DIR || path.join(process.cwd(), '..', '.phone-shots');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures.push(m); };
const failures = [];

// ── a CDP page driver, small enough to read ──────────────────────────
async function attach(wsUrl) {
  const ws = new WS(wsUrl, { maxPayload: 2 ** 28 });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  let id = 0; const pending = new Map();
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const call = (method, params = {}) => new Promise(res => {
    const i = ++id; pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async (expression, awaitPromise = false) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  return { ws, call, evaluate, close: () => ws.close() };
}

async function until(fn, ms, label) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try { last = await fn(); if (last) return last; } catch { /* keep polling */ }
    await sleep(150);
  }
  throw new Error(`timed out: ${label} (last=${JSON.stringify(last)})`);
}

async function preflight() {
  for (const [name, url] of [['API', `${API}/api/v1/geo/country`], ['phone PWA', PHONE_URL], ['desktop app', 'http://127.0.0.1:9222/json/version']]) {
    try {
      const r = await fetch(url);
      if (!r.ok && r.status >= 500) throw new Error(String(r.status));
    } catch (e) {
      console.error(`\n  ${name} is not running (${url}). See the header of this file.\n`);
      process.exit(1);
    }
  }
}

// ── identity ─────────────────────────────────────────────────────────
function identity() {
  const db = new Database(process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'minicaai.db'), { readonly: true });
  const email = (process.env.ADMIN_EMAILS || '').split(',')[0].trim();
  const u = db.prepare('SELECT id,email,name FROM users WHERE email = ?').get(email);
  if (!u) { console.error(`  no user for ADMIN_EMAILS="${email}"`); process.exit(1); }
  const lic = db.prepare('SELECT tier,status,expires_at,sessions_limit,sessions_used,credits_remaining_seconds,credits_expire_at,trial_remaining_seconds FROM licenses WHERE user_id = ?').get(u.id);
  db.close();
  return { u, lic, token: jwt.sign({ id: u.id, email: u.email }, process.env.JWT_SECRET, { expiresIn: '2h' }) };
}

// ━━ MAIN ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
await preflight();
fs.mkdirSync(SHOTS, { recursive: true });
const { u, lic, token } = identity();
console.log(`\nsigned in as ${u.email} (${lic?.tier})\n`);

// ── 1. the desktop takes the host role ───────────────────────────────
console.log('\x1b[1mDESKTOP\x1b[0m');
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const main = list.find(t => t.type === 'page' && t.url.includes('localhost:3005') && !t.url.includes('popout'));
if (!main) { console.error('  desktop window not found on :9222'); process.exit(1); }
const desk = await attach(main.webSocketDebuggerUrl);

await desk.evaluate(`(()=>{localStorage.setItem('minicaai_token',${JSON.stringify(token)});
  localStorage.setItem('minicaai_auth',${JSON.stringify(JSON.stringify({ id: u.id, email: u.email, name: u.name || 'A' }))});
  localStorage.setItem('minicaai_license',${JSON.stringify(JSON.stringify(lic))});return 1;})()`);
await desk.call('Page.reload', { ignoreCache: true });
await sleep(9000);
const hosting = await until(() => desk.evaluate('!!(window.__remoteHost && window.__remoteHost.isConnected)'), 25000, 'desktop to claim host');
ok('desktop is hosting');

// ── 2. a phone opens the app ─────────────────────────────────────────
console.log('\n\x1b[1mPHONE\x1b[0m');
const profile = path.join(SHOTS, 'profile');

// A headless Chrome left behind by a crashed run is still holding this
// port and this profile — and a second launch with the same
// --user-data-dir does not start a new browser, it opens a tab in the
// old one. That tab is signed in from last time, so the sign-in checks
// below silently test nothing. Close it, by browser id, so nothing but
// our own instance is touched. The user's own Chrome and Edge are never
// candidates: they are not on this port and not in this profile.
try {
  const v = await (await fetch('http://127.0.0.1:9444/json/version')).json();
  if (v?.webSocketDebuggerUrl) {
    const b = await attach(v.webSocketDebuggerUrl);
    await b.call('Browser.close');
    b.close();
    console.log('  · closed a leftover verification browser');
    await sleep(1200);
  }
} catch { /* nothing listening — the normal case */ }

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9444', `--user-data-dir=${profile}`,
  '--window-size=390,844', '--force-device-scale-factor=2',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  PHONE_URL,
], { stdio: 'ignore', detached: false });

let phonePage;
await until(async () => {
  const l = await (await fetch('http://127.0.0.1:9444/json/list')).json().catch(() => []);
  // Newest matching page, not the first: /json/list is ordered
  // most-recent-first, and picking the first stale tab is exactly the
  // bug the reset above exists to prevent.
  phonePage = l.filter(t => t.type === 'page' && t.url.startsWith(PHONE_URL.slice(0, 22)))[0];
  return !!phonePage;
}, 25000, 'headless phone browser');
const phone = await attach(phonePage.webSocketDebuggerUrl);
await phone.call('Emulation.setDeviceMetricsOverride', {
  width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
});

// Declared here rather than beside its first heavy use — the sign-in
// section below runs earlier and also wants to capture.
const shot = async (name) => {
  const r = await phone.call('Page.captureScreenshot', { format: 'png' });
  const f = path.join(SHOTS, name);
  fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
  return f;
};

// ── 3. the real sign-in form, with a real account ────────────────────
// A throwaway user, created and deleted by this script, so the form,
// the CORS preflight and the JWT round-trip are all genuinely exercised
// rather than short-circuited by writing a token into localStorage.
const throwaway = { email: `phone-verify-${Date.now()}@example.invalid`, password: 'Verify-Phone-9x!' };
// The account is created THROUGH THE PHONE'S OWN FORM further down —
// this only mints a token for the gate checks that come first.
const signupRes = await fetch(`${API}/api/v1/auth/signup`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5175' },
  body: JSON.stringify({ email: `gate-${Date.now()}@example.invalid`, password: throwaway.password, name: 'Gate Probe' }),
});
const signup = { ok: signupRes.ok, body: await signupRes.json().catch(() => ({})) };
if (signup.ok) {
  // ── The answering gate, on a real non-admin account ──
  // Straight HTTP, before any UI: the models must refuse to answer while
  // the clock is not running. This is the leak that let a trial user type
  // questions all day for free, so it is checked against the actual
  // endpoint rather than trusted from a unit test of the predicate.
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${signup.body?.token}` };
  const ask = () => fetch(`${API}/api/v1/ai/stream/gemini`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ prompt: 'say hi', systemInstruction: 'be brief' }),
  }).then(r => r.status);

  const cold = await ask();
  if (cold === 428) ok('models refuse to answer with no session running (428)');
  else bad(`expected 428 with no session, got ${cold}`);

  const started = await (await fetch(`${API}/api/v1/usage/start`, {
    method: 'POST', headers: H, body: JSON.stringify({ device_id: 'verify' }),
  })).json().catch(() => ({}));
  const warm = await ask();
  if (warm !== 428) ok(`and answer once the session is running (${started.source}, ${started.remaining}s)`);
  else bad('models still refused with a session open');

  await fetch(`${API}/api/v1/usage/stop`, {
    method: 'POST', headers: H, body: JSON.stringify({ session_id: started.session_id }),
  });
  const cooled = await ask();
  if (cooled === 428) ok('and refuse again the moment it stops');
  else bad(`expected 428 after stopping, got ${cooled}`);

  // Sign the phone out from a BLANK page, not from the running app.
  // Clearing localStorage while the app is live races its own boot: the
  // session check re-saves the token the moment it resolves, so the
  // keys reappear a few hundred milliseconds after being wiped and the
  // reload lands right back on the signed-in screen. With no app
  // running there is nobody to write them back.
  await phone.call('Page.navigate', { url: 'about:blank' });
  await sleep(400);
  await phone.call('Storage.clearDataForOrigin', {
    origin: new URL(PHONE_URL).origin,
    storageTypes: 'local_storage,cookies,indexeddb,cache_storage,service_workers',
  });
  await phone.call('Page.navigate', { url: PHONE_URL });
  await sleep(1800);
  try {
    await until(() => phone.evaluate(`!!document.querySelector('.signin')`), 12000, 'sign-in screen');
    ok('signed-out phone lands on the sign-in screen');
  } catch (e) {
    // Say what the screen actually is. A bare timeout here sends you
    // hunting the socket when the answer is usually one line of DOM.
    const dump = await phone.evaluate(`JSON.stringify({
      url: location.href,
      keys: Object.keys(localStorage),
      root: (document.querySelector('#root > *')||{}).className || '(empty)',
      text: (document.body.textContent||'').replace(/\\s+/g,' ').slice(0,160),
    })`).catch(() => '(page unreachable)');
    bad(`sign-in screen never appeared — ${dump}`);
    throw e;
  }

  // ── Creating an account, from the phone ──
  // Without this a new user — or an App Store reviewer, who arrives with
  // nothing — installs the app and cannot get in at all.
  // Stepwise rather than one async block: each step's result is visible,
  // so a failure says WHICH part broke instead of returning undefined
  // from an opaque promise.
  const openedSignup = await phone.evaluate(`(()=>{
    const alt=[...document.querySelectorAll('.signin-alt button')].find(b=>/create an account/i.test(b.textContent));
    if(!alt) return 'no-create-link';
    alt.click(); return 'opened';
  })()`);
  await sleep(600);
  const madeAccount = openedSignup !== 'opened' ? openedSignup : await phone.evaluate(`(()=>{
    const set=(el,v)=>{const p=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;p.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};
    const i=document.querySelectorAll('.signin input');
    if(i.length<3) return 'signup-fields-missing:'+i.length;
    set(i[0],'Phone Verify'); set(i[1],${JSON.stringify(throwaway.email)}); set(i[2],${JSON.stringify(throwaway.password)});
    const b=document.querySelector('.signin .btn-gold');
    if(!b) return 'no-submit-button';
    b.click(); return 'ok';
  })()`);
  if (madeAccount !== 'ok') bad(`could not drive the sign-up form (${madeAccount})`);
  else {
    try {
      await until(() => phone.evaluate(`!!document.querySelector('.hdr')`), 20000, 'sign-up to complete');
      ok("a new account can be created FROM THE PHONE (the reviewer's first screen)");
    } catch (e) { bad(`sign-up did not complete: ${e.message}`); }
  }

  // ── Password recovery ──
  // On a phone this may be someone's only device; no path back in is not
  // an option. The server answers identically for unknown addresses, so
  // the phone must confirm without implying the address was recognised.
  await phone.call('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  await phone.call('Storage.clearDataForOrigin', { origin: new URL(PHONE_URL).origin, storageTypes: 'local_storage' });
  await phone.call('Page.navigate', { url: PHONE_URL });
  await sleep(1600);
  const reset = await phone.evaluate(`(async () => {
    const set=(el,v)=>{const p=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;p.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};
    const link=[...document.querySelectorAll('.signin-alt button')].find(b=>/forgot/i.test(b.textContent));
    if(!link) return 'no-forgot-link';
    link.click();
    await new Promise(r=>setTimeout(r,400));
    const i=document.querySelectorAll('.signin input');
    if(!i.length) return 'no-email-field';
    set(i[0],${JSON.stringify(throwaway.email)});
    document.querySelector('.signin .btn-gold').click();
    await new Promise(r=>setTimeout(r,2500));
    const b=document.querySelector('.banner-ok');
    return b ? b.textContent.trim() : 'no-confirmation';
  })()`, true);
  if (/reset link/i.test(reset)) ok('forgot-password sends a link and confirms without leaking whether the address exists');
  else bad(`password reset did not confirm (${reset})`);

  // Back to a signed-out state for the sign-in check below.
  await phone.call('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  await phone.call('Storage.clearDataForOrigin', { origin: new URL(PHONE_URL).origin, storageTypes: 'local_storage' });
  await phone.call('Page.navigate', { url: PHONE_URL });
  await sleep(1600);

  const typed = await phone.evaluate(`(()=>{
    const set=(el,v)=>{const p=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;p.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};
    const i=document.querySelectorAll('.signin input');
    if(i.length<2)return 'no-inputs';
    set(i[0],${JSON.stringify(throwaway.email)}); set(i[1],${JSON.stringify(throwaway.password)});
    document.querySelector('.signin .btn-gold').click(); return 'ok';
  })()`);
  if (typed !== 'ok') bad(`could not drive the sign-in form (${typed})`);
  else {
    try {
      await until(() => phone.evaluate(`!!document.querySelector('.hdr')`), 15000, 'sign-in to complete');
      ok('real email+password sign-in works (CORS + JWT + socket join)');
      const state = await until(() => phone.evaluate(`(()=>{const e=document.querySelector('.hdr-presence');return e&&e.textContent.trim()})()`), 8000, 'presence');
      // This account has no computer, so the honest answer is "offline"
      // and the controls must be visibly dead.
      const solveOff = await phone.evaluate(`!!document.querySelector('.ctl.solve:disabled')`);
      if (/offline/i.test(state) && solveOff) ok(`an account with no computer shows "${state}", Auto-Solve disabled`);
      else bad(`expected offline + Auto-Solve disabled, got "${state}" / solve disabled=${solveOff}`);

      // ── THE APP ON ITS OWN ────────────────────────────────────────
      // Exactly what an App Store reviewer gets: a fresh account, no
      // computer anywhere, ten minutes of trial. If this does not work
      // the app is "incomplete" to them no matter what else it does.
      console.log('\n\x1b[1mPHONE ALONE (no computer — the reviewer\'s path)\x1b[0m');
      await phone.evaluate(`(()=>{
        const set=(el,v)=>{const p=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;p.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};
        const t=document.querySelector('.composer textarea'); t.focus(); set(t,'Give me a one-line answer: what is a hash map?');
        return 1;
      })()`);
      const soloPrompt = await until(() => phone.evaluate(
        `(()=>{const e=document.querySelector('.sheet-title');return e&&/start your session/i.test(e.textContent)})()`
      ), 6000, 'start-session prompt with no computer').catch(() => false);
      if (soloPrompt) ok('typing asks for a session even with no computer connected');
      else bad('no session prompt on the solo path');

      await phone.evaluate(`(()=>{const b=[...document.querySelectorAll('.sheet .btn-gold')].pop(); if(b) b.click(); return 1})()`);
      const soloClock = await until(() => phone.evaluate(
        // Keyed to the running CLASS, not the label. Labels are copy and get
        // reworded; `.on` is the state itself, and a check that breaks every
        // time someone improves a button teaches people to ignore it.
        `(()=>{const b=document.querySelector('.ctl.clock.on');return b&&b.textContent.replace(/\\s+/g,' ').trim()})()`
      ), 15000, 'the phone to open its own session').catch(() => null);
      if (soloClock) ok(`the phone runs its own clock: "${soloClock.slice(0, 46)}"`);
      else bad('the phone could not start a session on its own');

      await phone.evaluate(`document.querySelector('.composer .send').click()`);
      const soloAnswer = await until(() => phone.evaluate(
        `(()=>{const all=[...document.querySelectorAll('.msg.model')];
          if(!all.length) return false;
          const t=all[all.length-1].textContent||'';
          return t.length>30 && t;})()`
      ), 60000, 'an answer with no computer in the loop').catch(e => { bad(e.message); return null; });
      if (soloAnswer) {
        ok(`the phone answered by itself: "${soloAnswer.replace(/\s+/g, ' ').slice(0, 64)}…"`);
        console.log(`  · ${await shot('phone-solo.png')}`);
      }
      // Give the minutes back — this account is about to be deleted, but
      // a session left open would keep charging a user that no longer
      // exists until the sweeper notices.
      await phone.evaluate(`(()=>{const b=document.querySelector('.ctl.clock.on'); if(b) b.click(); return 1})()`);
    } catch (e) { bad(`sign-in did not complete: ${e.message}`); }
  }
} else {
  console.log('  (skipping the sign-in form — signup unavailable)');
}

// ── 4. the phone mirrors the computer ────────────────────────────────
await phone.evaluate(`(()=>{localStorage.setItem('minicaai_token',${JSON.stringify(token)});
  localStorage.setItem('minicaai_user',${JSON.stringify(JSON.stringify({ id: u.id, email: u.email, name: u.name || 'A' }))});return 1})()`);
await phone.call('Page.reload', { ignoreCache: true });
await sleep(2200);

const presence = await until(() => phone.evaluate(
  `(()=>{const e=document.querySelector('.hdr-presence');return e&&/connected|answering/i.test(e.textContent)&&e.textContent.trim()})()`
), 25000, 'phone to see the computer');
ok(`phone sees the computer: "${presence}"`);

const rule = await phone.evaluate(`(()=>{const e=document.querySelector('.micrule');return e&&e.textContent})()`);
if (rule && /never listens/i.test(rule)) ok('the mic rule is on screen, permanently');
else bad('the mic rule is missing from the main screen');

console.log(`  · ${await shot('phone-connected.png')}`);

// ── 5. a button on the phone runs on the computer ────────────────────
console.log('\n\x1b[1mREMOTE CONTROL\x1b[0m');
const question = 'From the phone: write a Python function that reverses a linked list.';
// Count first. The phone has already replayed this session's history, so
// "is there a model answer on screen" is trivially true and would pass
// against a mirror that never received anything new — the first version
// of this check did exactly that, and reported an answer from an earlier
// conversation as proof.
// ── The clock must be started first ──────────────────────────────────
// Typing with it off should stop you politely, right there, rather than
// letting you compose a question and press send into a refusal.
const promptShown = await phone.evaluate(`(()=>{
  const set=(el,v)=>{const p=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;p.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};
  const t=document.querySelector('.composer textarea'); if(!t) return 'no-composer';
  t.focus(); set(t,'typing with the clock off');
  return 'ok';
})()`);
if (promptShown === 'ok') {
  const sheet = await until(() => phone.evaluate(
    `(()=>{const e=document.querySelector('.sheet-title');return e&&/start your session/i.test(e.textContent)&&e.textContent.trim()})()`
  ), 6000, 'the start-session prompt').catch(() => null);
  if (sheet) {
    ok('typing with the clock off asks you to start your session');
    await sleep(450);
    console.log(`  · ${await shot('phone-start-session.png')}`);
  } else bad('typing with no session did not prompt');

  // Press it. With the computer connected this asks THAT machine to
  // listen — the phone never opens a microphone of its own.
  await phone.evaluate(`(()=>{const b=[...document.querySelectorAll('.sheet .btn-gold')].pop(); if(b) b.click(); return 1})()`);
  const running = await until(() => phone.evaluate(
    // Keyed to the running CLASS, not the label. Labels are copy and get
        // reworded; `.on` is the state itself, and a check that breaks every
        // time someone improves a button teaches people to ignore it.
        `(()=>{const b=document.querySelector('.ctl.clock.on');return b&&b.textContent.replace(/\\s+/g,' ').trim()})()`
  ), 20000, 'the clock to start').catch(() => null);
  if (running) ok(`session running — the button now reads "${running.slice(0, 42)}"`);
  else bad('the session never started from the phone');
}

const before = await phone.evaluate(`document.querySelectorAll('.msg.model').length`);
const sent = await phone.evaluate(`(()=>{
  const set=(el,v)=>{const p=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;p.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};
  const t=document.querySelector('.composer textarea'); if(!t) return 'no-composer';
  set(t, ${JSON.stringify(question)});
  const b=document.querySelector('.composer .send'); if(!b||b.disabled) return 'send-disabled';
  b.click(); return 'ok';
})()`);
if (sent !== 'ok') bad(`could not press Send on the phone (${sent})`);
else ok('pressed Send on the phone');

// The computer should now be working — proven on the DESKTOP, not the phone.
const deskBusy = await until(() => desk.evaluate(
  `(()=>{const m=[...document.querySelectorAll('*')].map(e=>e.textContent||'');return m.some(t=>t.includes('reverses a linked list'))})()`
), 30000, 'the question to appear on the computer').catch(e => { bad(e.message); return false; });
if (deskBusy) ok('the question arrived on the computer and it is answering');

// …and the NEW answer comes back to the phone: one more model bubble
// than there was, and its text is a response to what we just asked.
const answered = await until(() => phone.evaluate(
  `(()=>{const all=[...document.querySelectorAll('.msg.model')];
    if(all.length <= ${before}) return false;
    const t=all[all.length-1].textContent||'';
    return t.length>40 && t;})()`
), 90000, 'a NEW answer to reach the phone').catch(e => { bad(e.message); return null; });
if (answered) {
  const relevant = /revers|linked ?list|def |node/i.test(answered);
  ok(`a new answer mirrored to the phone: "${answered.replace(/\s+/g, ' ').slice(0, 70)}…"`);
  if (relevant) ok('and it answers the question the phone asked');
  else bad(`the new answer does not look related to the question asked`);
}

// Give the stream a moment to settle so the screenshot shows a real answer.
await sleep(6000);
console.log(`  · ${await shot('phone-answer.png')}`);

const codeBtn = await phone.evaluate(`(()=>{const b=document.querySelector('.ab-type');return b&&b.textContent.trim()})()`);
if (codeBtn) ok(`code blocks offer "${codeBtn}"`);
else console.log('  · (no code block in this answer — Auto-Type button not shown)');

// Nothing on this screen may be smaller than a thumb. The landing page
// shipped with 20 of 27 targets under 44px once; this is the check that
// stops that happening on the surface people use one-handed.
const small = await phone.evaluate(`(()=>{
  const out=[];
  for (const el of document.querySelectorAll('button')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;      // hidden
    if (r.height < 44 || r.width < 44) out.push((el.className||el.tagName)+' '+Math.round(r.width)+'x'+Math.round(r.height));
  }
  return JSON.stringify(out);
})()`);
const smallList = JSON.parse(small || '[]');
if (!smallList.length) ok('every control is at least 44×44');
else bad(`controls under 44px: ${smallList.join(', ')}`);

// The rule, in full, on demand.
await phone.evaluate(`document.querySelector('.micrule').click()`);
await sleep(500);
const sheetText = await phone.evaluate(`(()=>{const e=document.querySelector('.sheet');return e&&e.textContent})()`);
if (sheetText && /never listens/i.test(sheetText)) {
  ok('tapping the rule explains why, in full');
  await sleep(450);
  console.log(`  · ${await shot('phone-mic-rule.png')}`);
} else bad('the mic-rule sheet did not open');
await phone.evaluate(`document.querySelector('.sheet-backdrop').click()`);
await sleep(300);

// ── 6. Auto-Type, started from the phone and stopped before it types ─
// The single best reason for this app to exist: you are looking at the
// editor, you tap your phone, the computer types. Proving it end to end
// means genuinely entering the desktop's Auto-Type flow — so this aborts
// during the countdown, twice, before a single keystroke is synthesised.
// Nothing is typed into whatever window happens to be focused.
console.log('\n\x1b[1mAUTO-TYPE FROM THE PHONE\x1b[0m');
const abort = () => desk.evaluate(`(()=>{try{window.electronAPI.send('auto-type:abort');return 1}catch(e){return 0}})()`);
if (codeBtn) {
  const blocks = await desk.evaluate(`document.querySelectorAll('.ab-type, [aria-label*="Types this code"]').length`);
  const tapped = await phone.evaluate(`(()=>{const b=document.querySelector('.ab-type');if(!b)return 'no-button';b.click();return 'ok'})()`);
  if (tapped !== 'ok') bad(`could not tap Auto-Type on the phone (${tapped})`);
  else {
    let phase = null;
    try {
      // Watch for the desktop's own phase, mirrored back here.
      phase = await until(() => phone.evaluate(
        // `.autotype span`, not `.autotype`: the brand mark inlines its
        // stylesheet inside the SVG, so the parent's textContent is
        // several hundred characters of CSS with the message at the end.
        `(()=>{const e=document.querySelector('.autotype span');return e&&e.textContent.trim()})()`
      ), 12000, 'the desktop to start typing');
    } finally {
      await abort();
      await sleep(250);
      await abort();          // belt and braces — nothing may reach an editor
    }
    if (phase) ok(`the phone started the computer's Auto-Type: "${phase}"`);
    console.log(`  · desktop had ${blocks} typeable block(s) on screen`);

    const stopped = await until(() => phone.evaluate(
      `(()=>{const e=document.querySelector('.autotype span');return !e||/done/i.test(e.textContent)})()`
    ), 12000, 'the run to stop').catch(() => false);
    if (stopped) ok('and stopping it from the desktop cleared the phone too');
    else bad('the phone still shows a typing run after the desktop aborted');
  }
} else {
  console.log('  · (no code block in the answer — nothing to type)');
}

// ── 7. the computer goes away; the phone carries on ──────────────────
// The real sequence this is all built for: laptop shuts, you keep
// preparing on the phone with your resume in hand, and what you did is
// waiting on the computer when you open it again.
console.log('\n\x1b[1mCOMPUTER OFF — PREP ON THE PHONE\x1b[0m');
const MARKER = 'ORCHID-7741';
{
  // Same account on both sides, unlike the throwaway sign-in earlier —
  // the import is per-user, so proving it needs one identity.
  await desk.evaluate(`(()=>{ try { window.__remoteHost.stop(); return 1 } catch(e){ return 0 } })()`);
  const wentOffline = await until(() => phone.evaluate(
    `(()=>{const e=document.querySelector('.hdr-presence');return e&&/offline/i.test(e.textContent)})()`
  ), 20000, 'the phone to notice the computer left').catch(() => false);
  if (wentOffline) ok('the computer closes and the phone says so');
  else bad('the phone did not notice the computer going offline');

  // A plain-text resume proves the whole path: picked → read → stored →
  // used in the prompt. PDF and Word take the same road through
  // remote/files.ts the moment extraction returns text.
  const resume = [
    'ALEX MORGAN — Data Engineer',
    'Fidelity Investments — built a Kafka to Snowflake pipeline moving 40M events a day.',
    `Internal project codename: ${MARKER}.`,
  ].join('\n');

  await phone.evaluate(`(()=>{const b=[...document.querySelectorAll('.icon-btn')].find(e=>/document|resume/i.test(e.getAttribute('aria-label')||'')); if(b) b.click(); return 1})()`);
  await sleep(400);
  // Drives the real <input type=file> with a real File — the path a
  // person's picker takes, not a shortcut into localStorage.
  const stored = await phone.evaluate(`(async () => {
    const input = document.querySelector('.sheet input[type=file]');
    if (!input) return 'no-input';
    const file = new File([${JSON.stringify(resume)}], 'my-resume.txt', { type: 'text/plain' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 1500));
    return document.querySelector('.filerow span')?.textContent || 'not-listed';
  })()`, true);
  if (stored === 'my-resume.txt') {
    ok('a document picked on the phone is read on the handset and kept');
    console.log(`  · ${await shot('phone-files.png')}`);
  } else bad(`the document did not land (${stored})`);
  await phone.evaluate(`(()=>{const b=[...document.querySelectorAll('.sheet-title button')].pop(); if(b) b.click(); return 1})()`);
  await sleep(300);

  const badge = await phone.evaluate(`(()=>{const e=document.querySelector('.icon-btn.has');return e&&e.textContent.trim()})()`);
  if (badge === '1') ok('the header shows the answers are grounded (1 document)');
  else bad(`expected a document count in the header, got "${badge}"`);

  // Start a fresh prep conversation so the import check below is
  // unambiguous about what it found.
  await phone.evaluate(`(()=>{const c=[...document.querySelectorAll('.chip')].find(e=>e.textContent.trim()==='New'); if(c) c.click(); return 1})()`);
  await sleep(600);

  // Pick a model with real headroom. Gemini is the phone's default
  // because it is the one model on every plan — and on this dev project
  // it is a FREE-TIER key capped at 20 requests a day, which a few runs
  // of this script exhaust. That is an environment limit, not a product
  // one, but leaving the check on it makes the whole run fail for a
  // reason that has nothing to do with the code under test.
  const picked = await phone.evaluate(`(()=>{
    // EXACT label match. Matching on the title substring picked Groq for
    // "openai", because Groq's title is "GPT-OSS 120B · Groq" — and Groq
    // is the one with the tight per-minute token limit here.
    const want=['GPT','Claude','Grok'];
    const chips=[...document.querySelectorAll('.chip')];
    for (const w of want) {
      const c = chips.find(e => e.textContent.trim() === w);
      if (c) { c.click(); return w; }
    }
    return null;
  })()`);
  if (picked) console.log(`  · asking ${picked} (Gemini's free-tier day quota is spent)`);
  await sleep(400);

  const beforeSolo = await phone.evaluate(`document.querySelectorAll('.msg.model').length`);
  await phone.evaluate(`(()=>{
    const set=(el,v)=>{const p=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;p.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};
    const t=document.querySelector('.composer textarea'); t.focus();
    set(t,'What is the internal project codename on my resume? Answer with just the codename.');
    return 1;
  })()`);
  // The clock may already be running from the earlier section; start it
  // only if it is not.
  const needStart = await phone.evaluate(`!document.querySelector('.ctl.clock.on')`);
  if (needStart) {
    await phone.evaluate(`(()=>{const b=[...document.querySelectorAll('.sheet .btn-gold')].pop(); if(b) b.click(); return 1})()`);
    await until(() => phone.evaluate(`!!document.querySelector('.ctl.clock.on')`), 15000, 'the phone clock').catch(() => {});
  } else {
    await phone.evaluate(`(()=>{const b=[...document.querySelectorAll('.sheet-title button')].pop(); if(b) b.click(); return 1})()`);
  }
  await sleep(400);
  const preSend = await phone.evaluate(`JSON.stringify({
    clockOn: !!document.querySelector('.ctl.clock.on'),
    clockLabel: (document.querySelector('.ctl.clock')||{}).textContent?.replace(/\\s+/g,' ').trim(),
    sheetOpen: !!document.querySelector('.sheet'),
    draft: (document.querySelector('.composer textarea')||{}).value,
    sendDisabled: (document.querySelector('.composer .send')||{}).disabled,
    presence: (document.querySelector('.hdr-presence')||{}).textContent?.trim(),
  })`);
  console.log(`  · state before send: ${preSend}`);
  await phone.evaluate(`document.querySelector('.composer .send').click()`);

  // Catch an error toast while it is still on screen — say() clears
  // itself after ~4s, so reading it at the end of a 90s wait finds
  // whatever came last, not what actually went wrong.
  const earlyToast = await until(() => phone.evaluate(
    `(()=>{const t=document.querySelector('.toast');return t&&t.textContent.trim()})()`
  ), 6000, 'early toast').catch(() => null);
  if (earlyToast) console.log(`  · phone said immediately: "${earlyToast}"`);

  // Wait for the answer to SETTLE, not merely to start. The expected
  // answer here is a single codename, so reading the first few
  // characters off the stream caught "ORCH" and called it a miss.
  const grounded = await until(() => phone.evaluate(
    `(()=>{const all=[...document.querySelectorAll('.msg.model')];
      if(all.length <= ${beforeSolo}) return false;
      if(document.querySelector('.msg.model.streaming')) return false;   // still writing
      const t=all[all.length-1].textContent||'';
      return t.trim().length>3 && t;})()`
  ), 90000, 'an answer grounded in the document').catch(async e => {
    // Whatever went wrong, the phone told the user something. Read it,
    // rather than making the next person guess from a timeout.
    const shown = await phone.evaluate(`JSON.stringify({
      toast: (document.querySelector('.toast')||{}).textContent,
      sheet: (document.querySelector('.sheet-title')||{}).textContent,
      models: [...document.querySelectorAll('.msg.model')].length,
      streaming: !!document.querySelector('.msg.model.streaming'),
    })`).catch(() => '(unreadable)');
    bad(`${e.message} — phone showed: ${shown}`);
    return null;
  });
  if (grounded) {
    if (grounded.includes(MARKER)) ok(`the answer is built from the document — it found "${MARKER}"`);
    else bad(`the answer did not use the document: "${grounded.replace(/\s+/g, ' ').slice(0, 90)}"`);
  }

  // ── and it is waiting on the computer ──
  // The phone saved that conversation to the account under a `phone-`
  // id; the desktop pulls those on launch. Reloading is exactly what
  // opening the laptop does.
  await sleep(1500);
  await desk.call('Page.reload', { ignoreCache: true });
  const found = await until(() => desk.evaluate(`
    (async () => {
      const list = await window.electronAPI.invoke('db:list-sessions', ${JSON.stringify(u.id)});
      const hit = (list || []).find(s => String(s.id).startsWith('phone-'));
      return hit ? hit.name + ' :: ' + hit.message_count : false;
    })()
  `, true), 45000, 'the computer to pull the phone conversation').catch(e => { bad(e.message); return null; });
  if (found) ok(`the computer picked it up: "${found.split(' :: ')[0]}" (${found.split(' :: ')[1]} messages)`);

  // ── The document reaches the computer ──
  // Until this existed the two devices had different pictures of the
  // candidate: the phone's answers used the resume, the computer's did
  // not. Only the extracted TEXT crosses — the file never leaves the
  // handset — so there is no storage or retention to explain.
  //
  // Runs here, after the computer is back, because sending needs it
  // online. Ground truth is the desktop's OWN database, not a renderer
  // hook: an earlier version asked for window.__dev_sessionId, which does
  // not exist, and read an empty list as a failure.
  await until(() => phone.evaluate(
    `(()=>{const e=document.querySelector('.hdr-presence');return e&&/connected|answering/i.test(e.textContent)})()`
  ), 30000, 'the computer to come back before sharing a file').catch(() => {});

  await phone.evaluate(`(()=>{const b=[...document.querySelectorAll('.icon-btn')].find(e=>/document|resume/i.test(e.getAttribute('aria-label')||'')); if(b) b.click(); return 1})()`);
  await sleep(600);
  const sentFile = await phone.evaluate(`(()=>{
    const b=[...document.querySelectorAll('.filerow-send')][0];
    if(!b) return 'no-send-button';
    b.click(); return 'clicked';
  })()`);
  if (sentFile !== 'clicked') bad(`no way to send the document to the computer (${sentFile})`);
  else {
    console.log(`  · ${await shot('phone-file-shared.png')}`);
    const desktopDb = path.join(process.env.APPDATA || '', 'interview-copilot-ai', 'copilot.db');
    const landed = await until(() => {
      try {
        const d = new Database(desktopDb, { readonly: true });
        const row = d.prepare(
          "SELECT content FROM context_files WHERE name = 'my-resume.txt' ORDER BY rowid DESC LIMIT 1"
        ).get();
        d.close();
        return row && String(row.content).includes(MARKER);
      } catch { return false; }
    }, 20000, "the document to appear in the computer's files").catch(e => { bad(e.message); return false; });
    if (landed) ok("the document is now in the COMPUTER's own files, marker and all");
  }

  // Put the host back for the sections that follow.
  await until(() => desk.evaluate('!!(window.__remoteHost && window.__remoteHost.isConnected)'), 30000, 'the desktop to host again').catch(() => {});
}

// ── 8. catch-up: a phone that was closed sees the same thing ─────────
console.log('\n\x1b[1mCATCH-UP\x1b[0m');
// PUT, not GET — Chrome rejects the GET form of /json/new outright, and
// its refusal is plain text, so the failure surfaces as a JSON parse
// error a long way from the cause.
const opened = await (await fetch('http://127.0.0.1:9444/json/new?' + encodeURIComponent(PHONE_URL), { method: 'PUT' })).json();
const fresh = await attach(opened.webSocketDebuggerUrl);
await fresh.evaluate(`(()=>{localStorage.setItem('minicaai_token',${JSON.stringify(token)});
  localStorage.setItem('minicaai_user',${JSON.stringify(JSON.stringify({ id: u.id, email: u.email }))});return 1})()`);
await fresh.call('Page.reload', { ignoreCache: true });
const caught = await until(() => fresh.evaluate(
  `(()=>{const n=document.querySelectorAll('.msg').length;return n>0&&n})()`
), 30000, 'a fresh phone to replay the conversation').catch(e => { bad(e.message); return 0; });
if (caught) ok(`a phone opening fresh replayed ${caught} message(s) — same conversation, no pairing`);
fresh.close();

// ── clean up the throwaway account ───────────────────────────────────
try {
  const dbw = new Database(process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'minicaai.db'));
  const row = dbw.prepare('SELECT id FROM users WHERE email = ?').get(throwaway.email);
  if (row) {
    for (const t of ['licenses', 'devices', 'login_history', 'conversations']) {
      try { dbw.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(row.id); } catch { /* table may not exist */ }
    }
    dbw.prepare('DELETE FROM users WHERE id = ?').run(row.id);
    ok('throwaway verification account removed');
  }
  dbw.close();
} catch (e) { console.log(`  · could not remove the throwaway account: ${e.message}`); }

phone.close(); desk.close();
try { chrome.kill(); } catch { /* already gone */ }

console.log('\n' + '═'.repeat(64));
if (failures.length) {
  console.log(`\x1b[31m${failures.length} check(s) failed\x1b[0m`);
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('\x1b[32mthe phone drives the computer, and mirrors it — verified live\x1b[0m');
console.log('═'.repeat(64) + '\n');
process.exit(0);
