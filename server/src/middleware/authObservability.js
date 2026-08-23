// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  AUTH ACCESS LOG — one greppable line per auth request
//
//  Why this exists: on 2026-08-14 we found that Google sign-in's handoff
//  code had NEVER been delivered to a single client, on any platform, since
//  the mechanism shipped. Nothing in production said so. The endpoints all
//  answered 200, the browser silently refused to run the page's script, and
//  the only trace anywhere was one ambiguous warning that was being read as
//  good news. A bug that reaches every user for weeks and leaves no log line
//  is a monitoring failure before it is a code failure.
//
//  So: every /api/v1/auth/* request now emits exactly one line, after the
//  response is finished, carrying the four things you need to triage from
//  logs alone — WHICH endpoint, WHAT status, HOW LONG, and WHY.
//
//    [auth] GET /google/poll?session_id=852413fd… 200 3ms outcome=awaiting_code:address_different_family client=4.0.22 ip=v6:2601:249:8000:abcd
//    [auth] GET /google/callback?code=<redacted>&state=852413fd… 200 412ms outcome=callback:success:new_user client=- ip=v4:73.102.55
//    [auth] GET /google/start 400 0ms outcome=start:missing_session_id client=- ip=v4:73.102.55
//    [auth] GET /api/v1/auth/does-not-exist 404 0ms outcome=unhandled_error client=- ip=v4:73.102.55
//
//  Handlers describe their own outcome by setting `res.locals.authOutcome`.
//  When they don't, the status code alone still tells you 200 vs 404 vs 500,
//  which is the floor this is meant to guarantee.
//
//  Log level follows the status: 5xx -> error, 4xx -> warn, else info — and
//  a 200 that is actually a FAILURE is promoted to warn, because "answered
//  200 while nobody got in" is the exact shape that hid the original bug.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Never log these, in any form. `code` is a bearer credential for a session
// and `token`/`password` speak for themselves.
const REDACT = new Set(['code', 'token', 'password', 'id_token', 'access_token', 'refresh_token']);

// ── Which HTTP-200s are really failures ──
// The first version of this anchored on ^(awaiting_code|pending_timeout|
// error), which missed every failure the callback reports — they are all
// prefixed `callback:` and every one of them returns 200 while the user does
// not get in: callback:account_banned, callback:not_configured,
// callback:google_account_has_no_email, callback:no_code_or_google_error:*,
// callback:exception:*. So did poll:no_such_session (the server restarted
// mid-flow and the client will now poll until it times out). Those were
// landing at info — i.e. invisible — which is precisely the failure mode
// this module was written to end. Unset GOOGLE_CLIENT_SECRET on a deploy and
// every sign-in in the fleet would have failed at info level.
const FAILURE_SHAPED_200 = /(^|:)(awaiting_code|pending_timeout|error|exception)|^callback:(?!success)|^poll:no_such_session/;

function shortSid(v) {
  const s = String(v || '');
  return s ? s.slice(0, 8) + '…' : '-';
}

// Strip anything that could forge a log line or break a log pipeline: CR/LF
// (which would inject a second, fake entry) and every other control byte.
//
// ⚠️ Written with ESCAPE SEQUENCES, never literal control characters. An
// earlier revision embedded the raw bytes, which made git and grep classify
// this file as binary — `grep -rn addressPrefix src/` answered "Binary file
// matches" instead of the line. A file whose entire purpose is greppable
// output must not itself be ungreppable.
function sanitizeForLog(s) {
  return String(s).replace(/[\r\n\t\x00-\x1f\x7f]/g, '');
}

function safePath(req) {
  // Keep the route, drop the payload. Query keys are kept (they tell you
  // which shape of call it was) but values are redacted unless harmless.
  const raw = req.originalUrl || req.url || '';
  const [path, qs] = raw.split('?');
  // Bound the length: a multi-KB URL must not become a multi-KB log line.
  const safePathPart = sanitizeForLog(path).slice(0, 200);
  if (!qs) return safePathPart;
  const kept = [];
  for (const pair of qs.split('&').slice(0, 20)) {
    const k = sanitizeForLog(pair.split('=')[0]).slice(0, 40);
    if (!k) continue;
    if (REDACT.has(k)) kept.push(`${k}=<redacted>`);
    else if (k === 'session_id' || k === 'state') {
      // ⚠️ decodeURIComponent THROWS on a malformed escape ("%ZZ"). This
      // runs from a res 'finish' listener — outside Express's dispatch
      // stack — so a throw here is an UNCAUGHT EXCEPTION that kills the
      // process, taking every in-flight sign-in in pendingGoogleSessions
      // with it. One unauthenticated request was enough. Express's own
      // query parser swallows bad escapes, so the handler answers 200
      // and only the logger dies. Never decode without a guard.
      let v = pair.slice(k.length + 1) || '';
      try { v = decodeURIComponent(v); } catch { /* keep it encoded */ }
      kept.push(`${k}=${sanitizeForLog(shortSid(v))}`);
    } else kept.push(k);
  }
  return `${safePathPart}?${kept.join('&')}`;
}

// Coarse client address, family-tagged, never the full address — enough to
// correlate a consent with its poll, not enough to be a location record.
//
// ⚠️ This deliberately DELEGATES to routes/auth.js's addressPrefix instead of
// carrying its own copy. The first version of this file reimplemented the
// prefix logic — including, verbatim, the compressed-IPv6 bug that
// addressPrefix had just been rewritten to remove (`split(':').slice(0,4)`
// mangles `2601:249:8000::5`). Two copies of one rule is how the log ends up
// disagreeing with the decision it is supposed to explain, which is worse
// than no log at all: you would be reading "the addresses matched" next to a
// refusal. One implementation, one answer.
let _addressPrefix = null;
function getAddressPrefix() {
  if (_addressPrefix === null) {
    // Required lazily: routes/auth.js requires THIS module at load time, so a
    // top-level require here would be a cycle.
    try { _addressPrefix = require('../routes/auth.js').addressPrefix || false; }
    catch { _addressPrefix = false; }
  }
  return _addressPrefix;
}

function coarseIp(ip) {
  const fn = getAddressPrefix();
  if (typeof fn === 'function') {
    const p = fn(ip);
    return p ? `${p.family}:${p.prefix}` : '-';
  }
  return '-';   // never guess with a second implementation
}

function authAccessLog(req, res, next) {
  const started = Date.now();
  let finished = false;

  // A logger invoked from an event listener must be incapable of throwing:
  // there is no error handler above it, and an uncaught throw here takes the
  // whole process down. Belt on top of the specific decode guard in
  // safePath, because the next person to edit this function will not know.
  const emit = (suffix) => {
    if (finished) return;
    finished = true;
    try {
      const ms = Date.now() - started;
      const status = res.statusCode;
      const outcome = sanitizeForLog(res.locals?.authOutcome || (status >= 400 ? 'unhandled_error' : 'ok')).slice(0, 120);
      const line =
        `[auth] ${sanitizeForLog(req.method)} ${safePath(req)} ${status} ${ms}ms ` +
        `outcome=${outcome} client=${sanitizeForLog(req.clientVersion || '-').slice(0, 20)} ` +
        `ip=${coarseIp(req.ip || req.connection?.remoteAddress)}` +
        (suffix ? ` ${suffix}` : '');

      if (status >= 500) console.error(line);
      else if (status >= 400 || FAILURE_SHAPED_200.test(String(outcome))) console.warn(line);
      else console.log(line);
    } catch (e) {
      try { console.warn('[auth] access log failed (request itself was unaffected):', e && e.message); } catch { /* give up quietly */ }
    }
  };

  res.on('finish', () => emit(''));
  // A dropped connection never fires 'finish'. Without this, a client that
  // walks away mid-request leaves no trace at all.
  res.on('close', () => { if (!res.writableEnded) emit('closed=client_disconnected'); });

  next();
}

module.exports = { authAccessLog, coarseIp, shortSid, FAILURE_SHAPED_200 };
