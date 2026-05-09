// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Dev Login — mint a JWT for the local server so you can test the
//  Electron app pointed at localhost without going through signup.
//
//  Run: node --env-file=.env scripts/dev-login.mjs
//
//  Then in the Electron app's DevTools (Ctrl+Shift+I → Console),
//  paste the one-liner this prints. Refresh the app and you're
//  logged in as the admin email with Max tier.
//
//  This token is valid for 24h and signed with the LOCAL JWT_SECRET.
//  It won't work against the prod server (different secret).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import jwt from 'jsonwebtoken';

const ADMIN_EMAIL = (process.env.ADMIN_EMAILS || '').split(',')[0].trim();
const JWT_SECRET = process.env.JWT_SECRET;

if (!ADMIN_EMAIL || !JWT_SECRET) {
  console.error('Missing ADMIN_EMAILS or JWT_SECRET — did you run with --env-file=.env?');
  process.exit(1);
}

// Mint a Max-tier admin JWT, 24h expiry.
const token = jwt.sign(
  { id: 'dev-admin', user_id: 'dev-admin', email: ADMIN_EMAIL, tier: 'max' },
  JWT_SECRET,
  { expiresIn: '24h' },
);

console.log(`\n╔══════════════════════════════════════════════════════════╗`);
console.log(`║  Dev Login Token                                         ║`);
console.log(`║  Email: ${ADMIN_EMAIL.padEnd(48)}║`);
console.log(`║  Tier:  max                                              ║`);
console.log(`║  Valid: 24 hours                                         ║`);
console.log(`╚══════════════════════════════════════════════════════════╝\n`);

console.log(`Paste this ONE LINE into the Electron app's DevTools console`);
console.log(`(Ctrl+Shift+I → Console tab), then refresh the app:\n`);
console.log(`localStorage.setItem('minicaai_token', '${token}'); location.reload();`);
console.log(``);
console.log(`Or, if you prefer, just the raw token:`);
console.log(`${token}`);
console.log(``);
