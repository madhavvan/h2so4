// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE WELCOME MAIL AND THE RAIL UNDER IT (2026-09-06)
//
//  Every new account gets one mail; it carries a signed unsubscribe link;
//  the link flips users.marketing_opt_out and the recipients query honours
//  it; signup refuses an address no mail can reach and hands back the
//  correction. Same harness as auth-endpoints.test.js.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));

process.env.JWT_SECRET = 'test-secret-welcome-mail';
process.env.DATABASE_PATH = ':memory:';
process.env.ADMIN_EMAILS = 'owner@minicaai.com';
process.env.SERVER_URL = 'https://api.test.minicaai.com/';
process.env.FRONTEND_URL = 'https://minicaai.com';
// A transport must LOOK configured for the welcome mail to be attempted;
// the actual send is replaced below.
process.env.RESEND_API_KEY = 'test-not-a-real-key';
delete process.env.SMTP_HOST;

const db = require('../src/database.js');
const authRouter = require('../src/routes/auth.js');
const marketing = require('../src/services/marketingMail.js');
const validity = require('../src/services/emailValidity.js');
const { renderWelcomeEmail } = require('../src/email.js');

let srv; let port;
const sent = [];
marketing._test.setSendMail(async (args) => { sent.push(args); return { ok: true, messageId: `m-${sent.length}` }; });
// Every domain in this file "has MX" unless a test says otherwise.
validity._test.setResolver({
  resolveMx: async (d) => (d === 'dead-domain.test' ? Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })) : [{ exchange: `mx.${d}`, priority: 10 }]),
  resolve4: async (d) => (d === 'dead-domain.test' ? Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })) : ['203.0.113.1']),
});

beforeAll(async () => {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', authRouter);
  srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  port = srv.address().port;
});
afterAll(() => { try { srv.close(); } catch { /* down */ } });
beforeEach(() => { sent.length = 0; });

function request(method, path, body) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {} }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch { /* html */ } resolve({ status: res.statusCode, json, text: data }); });
    });
    if (payload) req.write(payload);
    req.end();
  });
}
const settle = () => new Promise((r) => setTimeout(r, 30));

describe('signup refuses an address no mail can reach', () => {
  it('a big-five slip comes back as the corrected address, and no account is created', async () => {
    const r = await request('POST', '/api/v1/auth/signup', { email: 'venu@gmail.con', password: 'longenough1', name: 'Venu' });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('Did you mean venu@gmail.com?');
    expect(r.json.suggestion).toBe('venu@gmail.com');
    expect(db.getUserByEmail('venu@gmail.con')).toBeNull();
    expect(sent.length).toBe(0);
  });
  it('a domain with no mail records is refused with a plain message', async () => {
    const r = await request('POST', '/api/v1/auth/signup', { email: 'someone@dead-domain.test', password: 'longenough1', name: 'X' });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain("dead-domain.test doesn't accept email");
    expect(db.getUserByEmail('someone@dead-domain.test')).toBeNull();
  });
  it('the format check still runs first', async () => {
    const r = await request('POST', '/api/v1/auth/signup', { email: 'not-an-email', password: 'longenough1' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('Invalid email format');
  });
});

describe('a new account gets one welcome mail with a working unsubscribe link', () => {
  let userId; let unsubscribe;

  it('signup sends it, to the right address, from the right template', async () => {
    const r = await request('POST', '/api/v1/auth/signup', { email: 'New.Person@Lilly.com', password: 'longenough1', name: 'New <b>Person' });
    expect(r.status, r.text).toBe(201);
    await settle();
    expect(sent.length).toBe(1);
    const m = sent[0];
    userId = r.json.user.id;
    expect(m.to).toBe('new.person@lilly.com');
    expect(m.subject).toBe('Welcome to minicaai — your account is ready');
    expect(m.replyTo).toBe('support@minicaai.com');
    // Name is escaped in both bodies; the unsubscribe link is signed for THIS user.
    expect(m.html).toContain('New &lt;b>Person');
    expect(m.text).toContain('Hi New &lt;b>Person');
    unsubscribe = `https://api.test.minicaai.com/api/v1/auth/unsubscribe?u=${encodeURIComponent(userId)}&t=${marketing.unsubscribeToken(userId)}`;
    expect(m.text).toContain(unsubscribe);
    expect(m.html).toContain(unsubscribe);
    // Nothing promised that differs by region.
    expect(m.text).not.toMatch(/\b10 minutes\b|free trial minutes/i);
  });

  it('the account starts opted IN and appears in the recipients list', () => {
    const u = db.getUserById(userId);
    expect(u.marketing_opt_out).toBe(0);
    expect(db.getMarketingRecipients().map((x) => x.id)).toContain(userId);
  });

  it('the link opts out; the recipients list honours it; the page says so', async () => {
    const path = unsubscribe.replace('https://api.test.minicaai.com', '');
    const r = await request('GET', path);
    expect(r.status).toBe(200);
    expect(r.text).toContain("You're unsubscribed");
    expect(db.getUserById(userId).marketing_opt_out).toBe(1);
    expect(db.getMarketingRecipients().map((x) => x.id)).not.toContain(userId);
  });

  it('a forged or stale token does nothing; an unknown user is a 404', async () => {
    const bad = await request('GET', `/api/v1/auth/unsubscribe?u=${encodeURIComponent(userId)}&t=${'0'.repeat(32)}`);
    expect(bad.status).toBe(400);
    expect(bad.text).toContain("This link isn't valid");
    const none = await request('GET', `/api/v1/auth/unsubscribe?u=ghost&t=${marketing.unsubscribeToken('ghost')}`);
    expect(none.status).toBe(404);
    expect(await request('GET', '/api/v1/auth/unsubscribe')).toMatchObject({ status: 400 });
  });

  it('a mail outage never fails the signup', async () => {
    marketing._test.setSendMail(async () => { throw new Error('resend down'); });
    const r = await request('POST', '/api/v1/auth/signup', { email: 'second@lilly.com', password: 'longenough1', name: 'Two' });
    expect(r.status, r.text).toBe(201);
    marketing._test.setSendMail(async (args) => { sent.push(args); return { ok: true }; });
  });

  it('with no transport configured the mail is skipped quietly', async () => {
    const saved = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    const r = await marketing.sendWelcomeMail({ user: { id: 'u1', email: 'a@b.co', name: 'A' }, req: null, via: 'test' });
    expect(r).toEqual({ ok: false, reason: 'no_transport_configured' });
    process.env.RESEND_API_KEY = saved;
  });
});

describe('the token', () => {
  it('is per user, fixed length, and verified in constant time against a same-length string', () => {
    const a = marketing.unsubscribeToken('user-a'); const b = marketing.unsubscribeToken('user-b');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(marketing.verifyUnsubscribeToken('user-a', a)).toBe(true);
    expect(marketing.verifyUnsubscribeToken('user-a', b)).toBe(false);
    expect(marketing.verifyUnsubscribeToken('user-a', a.slice(0, 31))).toBe(false);
    expect(marketing.verifyUnsubscribeToken('', a)).toBe(false);
    expect(marketing.verifyUnsubscribeToken('user-a', null)).toBe(false);
  });
});

describe('every account-creation path sends the welcome mail (source pins)', () => {
  const auth = readFileSync(join(HERE, '..', 'src', 'routes', 'auth.js'), 'utf8');
  it('password signup and BOTH Google new-user paths', () => {
    expect(auth).toContain("sendWelcomeMail({ user, req, via: 'signup' });");
    expect(auth).toContain("sendWelcomeMail({ user, req, via: 'google' });");
    expect(auth).toContain("sendWelcomeMail({ user, req, via: 'google-callback' });");
    expect((auth.match(/sendWelcomeMail\(\{ user, req, via: /g) || []).length).toBe(3);
  });
  it('the reachability check sits in signup only, after the format check, and is awaited', () => {
    const signup = auth.slice(auth.indexOf("router.post('/signup'"), auth.indexOf("router.post('/login'"));
    expect(signup).toContain('const reach = await checkEmailDeliverable(email);');
    expect(signup.indexOf('checkEmailDeliverable')).toBeGreaterThan(signup.indexOf("error: 'Invalid email format'"));
    expect((auth.match(/checkEmailDeliverable\(/g) || []).length).toBe(1);
  });
  it('the template renders text and html for a missing name too', () => {
    const m = renderWelcomeEmail({ name: '', signInUrl: 'https://minicaai.com', unsubscribeUrl: 'https://x/u' });
    expect(m.text).toContain('Hi there,');
    expect(m.html).toContain('Welcome, there');
    expect(m.html).toContain('href="https://x/u"');
  });
});
