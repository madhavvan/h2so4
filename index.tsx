import React from 'react';
import ReactDOM from 'react-dom/client';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  TELL THE SERVER WHICH GENERATION OF CLIENT IS CALLING.
//
//  The server updates in ninety seconds; this app updates over days. Five
//  production incidents have come from a server assuming both halves ship
//  together — see server/src/middleware/clientVersion.js for the list. The
//  server can only avoid that if it knows who is calling, and it cannot
//  know unless every request says so.
//
//  ── WHY THIS IS ONE PATCH AND NOT SEVENTY EDITS ──
//  There are ~70 fetch() call sites across 11 files and no shared wrapper.
//  Adding a header to each would be a large risky diff that STILL misses
//  the seventy-first one somebody writes next month — and a header that is
//  only mostly sent is worse than none, because the server would read the
//  gaps as "old client" and silently stop enforcing for a modern app.
//  So it is intercepted once, here, before anything else runs.
//
//  ── SCOPED BY PATH, DELIBERATELY ──
//  Only URLs containing `/api/v1/` are touched. Our server is the only
//  thing using that prefix (checked against every external URL in the
//  source: google, github, jquery docs — none match). Broadcasting the app
//  version to Stripe, Google or a provider would leak fleet composition to
//  third parties and could disturb request signing.
//
//  ── IT CANNOT BREAK A REQUEST ──
//  A Request object is passed straight through rather than cloned; an
//  already-present header is never overwritten; and anything unexpected
//  falls through to the original fetch inside a try/catch. The failure
//  mode of this block is "no header", never "no request".
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
(() => {
  try {
    const original = globalThis.fetch;
    if (typeof original !== 'function') return;

    globalThis.fetch = function patchedFetch(input: any, init?: any) {
      try {
        // Only the simple (string | URL, init) form. A Request carries its
        // own immutable headers; rewriting it means cloning, and a clone
        // that gets a body wrong breaks uploads. Not worth it — nothing in
        // this app calls fetch with a Request.
        const url =
          typeof input === 'string' ? input :
          (input && typeof input.href === 'string') ? input.href :
          null;

        if (url && url.includes('/api/v1/')) {
          const headers = new Headers((init && init.headers) || undefined);
          if (!headers.has('X-App-Version')) headers.set('X-App-Version', __APP_VERSION__);
          return original.call(this, input, { ...(init || {}), headers });
        }
      } catch {
        // fall through to an untouched call
      }
      return original.call(this, input, init);
    } as typeof fetch;
  } catch {
    // If anything here throws the app must still boot and still talk to the
    // server — it just looks like an old client, which is the safe default.
  }
})();

if (typeof (Promise as any).withResolvers === 'undefined') {
  (Promise as any).withResolvers = function () {
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

import App from './App';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);