// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ENTITLEMENT CLAIM — Ed25519-signed, offline-verifiable proof of tier
//
//  Why this exists: Auto-Type is the Ultra-only feature at $159/mo, and it
//  has to keep working offline — interviews happen on hotel wifi and on
//  monitored corporate networks where Local-Only mode suppresses outbound
//  calls on purpose. So the Electron main process proves entitlement with
//  the server once and caches the answer for seven days. That cache used to
//  be a plain {ok:true, at:...} JSON file under userData, which is a grant
//  anyone with a text editor can write for themselves. It was a note, not a
//  proof.
//
//  Why ASYMMETRIC and not an HMAC: the desktop app must be able to VERIFY a
//  claim without being able to MINT one. An HMAC needs the same secret on
//  both sides, and a secret shipped inside a binary that runs on the
//  attacker's machine is not a secret — anyone can pull it out with
//  `strings` and sign themselves an Ultra grant. Ed25519 splits that: the
//  private key stays in the server's env, the public key is embedded in the
//  desktop binary, and the worst an attacker can do with the embedded half
//  is check someone else's claim.
//
//  ── WHAT BYTES ARE SIGNED ────────────────────────────────────────────
//  The signature covers the ASCII bytes of the base64url payload STRING —
//  exactly the characters transmitted in `payload` — NOT the object, and
//  not a re-serialization of it. This matters more than anything else in
//  the file: JSON.stringify has no canonical key order across languages,
//  versions, or a well-meaning refactor that reorders a literal, so a
//  verifier that re-serializes the parsed object is a verifier that fails
//  intermittently and inexplicably. The verifying side must therefore:
//
//     1. take `claim.payload` verbatim, as received;
//     2. crypto.verify(null, Buffer.from(claim.payload, 'ascii'), pub, sig);
//     3. and only THEN base64url-decode it and JSON.parse it to read fields.
//
//  Decode-then-read, never read-then-re-encode.
//
//  ── KEY MATERIAL ─────────────────────────────────────────────────────
//  ENTITLEMENT_PRIVATE_KEY is a base64 PKCS8 DER Ed25519 private key. Mint
//  a pair with:
//
//    node -e "const c=require('crypto');const{publicKey,privateKey}=c.generateKeyPairSync('ed25519');
//      console.log('PRIV',privateKey.export({format:'der',type:'pkcs8'}).toString('base64'));
//      console.log('PUB ',publicKey.export({format:'der',type:'spki'}).toString('base64'))"
//
//  PRIV goes in the server env and nowhere else. PUB is a literal in the
//  desktop binary. Rotating the pair invalidates every cached claim in the
//  field, so a rotation is a client release, not a config flip.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const crypto = require('crypto');

// Envelope version. Describes the WIRE SHAPE of the object below, so a
// future format change is distinguishable from a corrupt one. It lives
// outside the signature by definition — the client hardcodes what it
// accepts, so an attacker rewriting this field buys nothing.
const CLAIM_ENVELOPE_VERSION = 1;

// undefined = not yet parsed, null = parsed and unusable (absent, malformed,
// wrong curve). Both "no key configured" states collapse to null so
// isConfigured() has exactly one falsy answer to check.
let cachedKey;

// Parsed LAZILY on first use, not at module load. Two reasons: routes require
// this module at boot, and a server that refuses to start because an env var
// is missing is a worse outage than a feature that degrades — the endpoint
// answers 501 and the desktop app falls back to its older unsigned probe.
// Lazy also means we don't care whether dotenv has run yet at require time.
// Parsed ONCE and memoized: the key is env config, and env config in this
// process is read at startup like ADMIN_EMAILS and everything else. Changing
// the variable requires a restart, which is what a deploy already is.
function loadPrivateKey() {
  const raw = (process.env.ENTITLEMENT_PRIVATE_KEY || '').trim();
  if (!raw) return null;
  try {
    const key = crypto.createPrivateKey({
      key: Buffer.from(raw, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    // Buffer.from(..., 'base64') silently discards anything that isn't
    // base64, so a truncated or line-wrapped paste can still produce a DER
    // blob that parses into SOMETHING. Insist on the curve we actually
    // signed the client against — an RSA or P-256 key here would sign
    // happily and then fail every verification in the field.
    if (key.asymmetricKeyType !== 'ed25519') return null;
    // And prove it can sign before we advertise it. isConfigured() promises
    // "a usable key", not "a parseable one"; one throwaway signature at
    // startup is cheap insurance against the endpoint 500ing per request.
    crypto.sign(null, Buffer.from('entitlement-selftest'), key);
    return key;
  } catch {
    // Malformed base64, wrong DER type, an OpenSSL build without Ed25519 —
    // every one of them means "not configured", never "crash the server".
    return null;
  }
}

function privateKey() {
  if (cachedKey === undefined) cachedKey = loadPrivateKey();
  return cachedKey;
}

// True only when the env var is present AND yields a key that actually
// signs. Callers gate on this to answer 501 instead of 500 — a deploy that
// hasn't been given the key yet must degrade, not brick Auto-Type.
function isConfigured() {
  return privateKey() !== null;
}

function base64url(buf) {
  // Node >= 15 encodes base64url natively (package.json pins node >= 20):
  // unpadded, '-' and '_' — URL- and header-safe, and stable across the
  // Node/Electron split.
  return buf.toString('base64url');
}

// signClaim(payload) -> { payload, sig, alg, v }
//
// `payload` in the RESULT is the base64url of the JSON bytes; `sig` is the
// base64url Ed25519 signature over those payload CHARACTERS (see the header
// note). The caller hands in a plain object and never sees the intermediate
// bytes, which is the point: there is exactly one place in this codebase
// that decides what gets serialized, so there is exactly one byte string to
// agree on.
function signClaim(payloadObject) {
  const key = privateKey();
  if (!key) {
    // Unreachable through the endpoint, which checks isConfigured() first.
    // Loud rather than silent if a future caller forgets: an unsigned claim
    // is worse than no claim.
    throw new Error('entitlement signing is not configured');
  }
  const encoded = base64url(Buffer.from(JSON.stringify(payloadObject), 'utf8'));
  // Ed25519 takes a null algorithm — the curve fixes the hash (SHA-512,
  // internally, over the whole message). Passing 'sha256' here throws.
  const sig = crypto.sign(null, Buffer.from(encoded, 'ascii'), key);
  return {
    payload: encoded,
    sig: base64url(sig),
    alg: 'ed25519',
    v: CLAIM_ENVELOPE_VERSION,
  };
}

module.exports = { isConfigured, signClaim, CLAIM_ENVELOPE_VERSION };
