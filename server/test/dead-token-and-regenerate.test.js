// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  TWO CLIENT BUGS THE 2026-09 AUDITS LEFT OPEN, PINNED AT THE SOURCE.
//
//  1. A DEAD TOKEN RENDERED THE SIGNED-IN UI. Production, 2026-09-02: a
//     client whose JWT had expired while the app was closed came back up,
//     showed the interview screen, and then 45 answers, the mic key and 14
//     minutes of heartbeats all 401'd with nothing but generic errors.
//     validateWithServer deliberately never degrades the cached licence (it
//     runs mid-interview too) — so it now RECORDS a 401, the launch path
//     signs the user out cleanly, and App shows one persistent bar with the
//     one action that fixes it.
//
//  2. REGENERATE ROUTED ON THE PICKER VALUE. executeSend resolves the model
//     around a provider that is cooling after a refusal; Regenerate read
//     settings.selectedModel and re-hit the provider that had just failed.
//
//  Source-pinned because neither the renderer nor the services boot under
//  vitest; the server half of (1) — 401 on a dead/revoked token — is real
//  and exercised in token-revocation.test.js and auth-endpoints.test.js.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const codeOnly = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const license = codeOnly(read('services/licenseService.ts'));
const proxy = codeOnly(read('services/aiProxyService.ts'));
const timer = codeOnly(read('services/creditTimerService.ts'));
const gate = codeOnly(read('SubscriptionGate.tsx'));
const app = read('App.tsx');
const appCode = codeOnly(app);

describe('a dead token is recorded, not hidden', () => {
  it('validateWithServer keeps its never-degrade contract but records the status and reports a 401', () => {
    const fn = license.slice(license.indexOf('async validateWithServer()'));
    expect(fn).toContain('this.lastValidateStatus = null;');
    expect(fn).toContain('this.lastValidateStatus = response.status;');
    // Still hands back the cached licence on any failure…
    expect(fn).toMatch(/if \(!response\.ok\) \{[\s\S]{0,300}return license;/);
    // …but a 401 — and only a 401 — is reported.
    expect(fn).toContain("if (response.status === 401) this.noteAuthRejected('validate');");
    expect(license).toContain("noteAuthRejected(source: 'validate' | 'stream' | 'heartbeat'): void {");
    expect(license).toContain("new CustomEvent('minicaai-auth-rejected', { detail: { source } })");
  });

  it('the answer stream and the usage heartbeat report it too (three beats in a row, not one blip)', () => {
    // Whitespace-tolerant: this file is CRLF on disk.
    expect(proxy).toMatch(/if \(response\.status === 401\) \{\s*try \{ licenseService\.noteAuthRejected\('stream'\); \} catch \{ \/\* best effort \*\/ \}\s*\}/);
    expect(timer).toContain('private unauthorizedBeats = 0;');
    const hb = timer.slice(timer.indexOf('private async heartbeat()'));
    expect(hb).toContain('if (resp.status === 401) {');
    expect(hb).toContain('this.unauthorizedBeats += 1;');
    expect(hb).toContain("if (this.unauthorizedBeats === 3) {");
    expect(hb).toContain("licenseService.noteAuthRejected('heartbeat');");
    expect(hb).toContain('this.unauthorizedBeats = 0;');
  });

  it('at LAUNCH a 401 signs the user out with a reason, instead of rendering the app over it', () => {
    const init = gate.slice(gate.indexOf('async function init()'), gate.indexOf('async function init()') + 2500);
    expect(init).toContain('const validated = await licenseService.validateWithServer();');
    const check = init.indexOf('if (licenseService.lastValidateStatus === 401) {');
    expect(check).toBeGreaterThan(-1);
    // The refusal is acted on BEFORE the cached licence is used.
    expect(check).toBeLessThan(init.indexOf('if (validated && licenseService.isLicenseValid(validated)) {'));
    const branch = init.slice(check, check + 400);
    expect(branch).toContain('licenseService.logout();');
    expect(branch).toContain("setAuthError('Your session has expired. Please sign in again.');");
    expect(branch).toContain('setIsLoading(false);');
  });

  it('mid-interview, App shows ONE persistent bar with a sign-in action, cleared on any auth change', () => {
    expect(appCode).toContain('const [authRejected, setAuthRejected] = useState(false);');
    expect(appCode).toContain("window.addEventListener('minicaai-auth-rejected', onRejected);");
    expect(appCode).toContain("window.addEventListener('minicaai-auth-changed', onChanged);");
    expect(app).toContain('Your sign-in has expired. Answers and the mic will keep failing until you sign in again.');
    expect(app).toMatch(/onClick=\{\(\) => onLogout\(\)\}[\s\S]{0,300}Sign in again/);
  });
});

describe('Regenerate calls the model the send would have called', () => {
  it('resolves around a cooling provider exactly as executeSend does', () => {
    const regen = appCode.slice(appCode.indexOf('const handleRegenerate = async () => {'));
    const body = regen.slice(0, regen.indexOf('setStreamingMsg({ id: pendingId'));
    expect(body).not.toContain('streamers[currentSettings.selectedModel]');
    expect(body).toContain('const chosenModel = currentSettings.selectedModel as ModelKey;');
    expect(body).toContain('isModelCooling(chosenModel)');
    expect(body).toContain('pickFallbackModel(chosenModel, gateRef.current?.allowedModels || [], isModelCooling) || chosenModel');
    expect(body).toContain('const gen = streamers[regenModel] || streamGemini;');
    // Nothing anywhere routes on the raw picker value any more.
    expect(appCode).not.toContain('streamers[currentSettings.selectedModel]');
  });
});
