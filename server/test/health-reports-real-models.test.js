// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  /api/health MUST NOT LIE ABOUT WHICH MODELS ARE SERVING.
//
//  Why this endpoint reports models at all: the model name a user sees in
//  the app is a hardcoded CLIENT label (App.tsx MODEL_REGISTRY). It only
//  changes with an app release. So on 2026-08-08 the server had been
//  calling gpt-5.6 for hours while every installed client displayed
//  "GPT-5.5" — and there was no way, from outside, to establish which was
//  true. /api/health previously answered `version: '1.0.0'`, which is
//  server/package.json's version and identifies nothing.
//
//  A reported list is only useful if it cannot drift from reality. A stale
//  one is worse than no endpoint: it answers the question confidently and
//  wrongly. So this parses the `model:` literals out of the actual route
//  handlers and asserts the exported map matches.
//
//  If this fails, do not edit the test to agree — the export drifted from
//  what the handlers send, and the endpoint is about to start lying.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'health-models-test';
process.env.DATABASE_PATH = ':memory:';

const aiSrc = readFileSync(join(ROOT, 'server', 'src', 'routes', 'ai.js'), 'utf8');
const indexSrc = readFileSync(join(ROOT, 'server', 'src', 'index.js'), 'utf8');

/** Every `model: '…'` literal the handlers actually pass. */
function modelLiterals(src) {
  return new Set([...src.matchAll(/^\s+model:\s*'([^']+)'/gm)].map((m) => m[1]));
}

describe('the health endpoint reports the real serving models', () => {
  const { servingModels } = require('../src/routes/ai.js');

  it('exports a serving-model map at all', () => {
    expect(servingModels, 'routes/ai.js no longer exports servingModels — /api/health would go silent').toBeTruthy();
    expect(Object.keys(servingModels).length).toBeGreaterThan(0);
  });

  it('every reported model is one the handlers actually send', () => {
    const literals = modelLiterals(aiSrc);
    for (const [provider, id] of Object.entries(servingModels)) {
      expect(
        literals.has(id),
        `health reports ${provider}="${id}", but no handler in routes/ai.js passes model: '${id}'. ` +
          'The export has drifted — /api/health is about to report a model that is not being used.'
      ).toBe(true);
    }
  });

  it('covers every provider the routes expose', () => {
    // A provider missing from the map reads as "not served" to anyone
    // checking, which is its own kind of wrong answer.
    for (const p of ['openai', 'xai', 'gemini', 'groq', 'claude']) {
      expect(servingModels, `no serving model reported for ${p}`).toHaveProperty(p);
    }
  });

  it('reports the CURRENT generation, not the one before it', () => {
    // Pins the actual bump this endpoint exists to make checkable.
    expect(servingModels.openai).toBe('gpt-5.6');
    expect(servingModels.xai).toBe('grok-4.5');
    expect(servingModels.gemini).toBe('gemini-3.6-flash');
  });

  it('none of the retired ids survive anywhere in the routes', () => {
    const literals = modelLiterals(aiSrc);
    for (const dead of ['gpt-5.5', 'grok-4.3', 'gemini-3.5-flash']) {
      expect(
        literals.has(dead),
        `routes/ai.js still sends the retired model '${dead}' from some handler`
      ).toBe(false);
    }
  });
});

describe('the health endpoint identifies the build', () => {
  it('reads a commit from the platform build env, never from `git`', () => {
    // The deployed container has no repo; shelling out would throw or,
    // worse, silently report the wrong thing.
    expect(indexSrc).toMatch(/RAILWAY_GIT_COMMIT_SHA/);
    const healthBlock = indexSrc.slice(indexSrc.indexOf('const BUILD_COMMIT'), indexSrc.indexOf("app.get('/api/health'") + 900);
    expect(healthBlock).not.toMatch(/execSync|spawnSync|child_process/);
  });

  it('still answers when the model export is unavailable', () => {
    // A health check that can 500 is worse than useless — it turns a
    // reporting gap into a false outage signal.
    const healthBlock = indexSrc.slice(indexSrc.indexOf("app.get('/api/health'"), indexSrc.indexOf("app.get('/api/health'") + 900);
    expect(healthBlock).toMatch(/try\s*\{/);
    expect(healthBlock).toMatch(/catch/);
    expect(healthBlock).toMatch(/status:\s*'ok'/);
  });
});
