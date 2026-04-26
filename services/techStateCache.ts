// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  TECH-STATE CACHE — neutral home for the "Train Model" cache.
//
//  Lives in its own file (not inside claudeService) so both
//  claudeService.ts (which writes the cache during training) AND
//  aiProxyService.ts (which reads it when building prompts for
//  Gemini/GPT/Grok/Groq) can import without a circular dependency.
//
//  The cached card is just opaque text — ANY model can have it
//  injected into its system prompt to answer with fresh tech facts.
//  Training is paid for once via Claude's web_search; the value
//  propagates to every other model the user might switch to.
//
//  Persisted in localStorage with a 24h TTL. Key is hash(resume+JD).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const TECH_STATE_TTL_MS = 24 * 60 * 60 * 1000;
const TECH_STATE_KEY_PREFIX = 'claude_tech_state_v1_';

interface TechStateCacheEntry {
  hash: string;
  card: string;
  timestamp: number;
  techCount: number;
}

export function readTechStateCache(hash: string): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(TECH_STATE_KEY_PREFIX + hash);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TechStateCacheEntry;
    if (Date.now() - parsed.timestamp > TECH_STATE_TTL_MS) {
      localStorage.removeItem(TECH_STATE_KEY_PREFIX + hash);
      return null;
    }
    return parsed.card;
  } catch {
    return null;
  }
}

export function writeTechStateCache(hash: string, card: string, techCount: number): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const entry: TechStateCacheEntry = { hash, card, timestamp: Date.now(), techCount };
    localStorage.setItem(TECH_STATE_KEY_PREFIX + hash, JSON.stringify(entry));
  } catch {
    // localStorage full or disabled — non-fatal, training just won't persist.
  }
}

export function hasTechStateCache(hash: string): boolean {
  return readTechStateCache(hash) !== null;
}
