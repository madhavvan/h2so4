// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  BRINGING PHONE CONVERSATIONS ONTO THE COMPUTER.
//
//  The phone can answer questions on its own while this machine is off,
//  and saves them to the account. This is the other half: on launch, ask
//  the account what the phone wrote and put it in the sidebar.
//
//  ── WHY ONLY `phone-` IDS ──
//  This app already pushes EVERY conversation to the same store, for
//  admin visibility. Pulling the whole store back would mean re-reading
//  our own history on every launch, and — because the server keeps rows
//  this machine has deleted — quietly resurrecting conversations the
//  user threw away. So the pull is narrowed to ids the phone minted.
//  The prefix is the contract; it is set in the phone app's
//  prepSessionId() and read here.
//
//  ── WHY A POLL AND NOT A PUSH ──
//  The phone only works alone when this machine is OFF, so nearly all of
//  it is already waiting by the time we launch, and the launch pull gets
//  it. The interval covers the narrow case where this app is running but
//  its socket is not — signed out, network dropped — during which the
//  phone believes it is alone and is right to.
//
//  Silent by construction. A failed pull is not something to interrupt
//  anyone about; the next one gets it.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { licenseService } from './licenseService';

const PHONE_PREFIX = 'phone-';

// Bounded so a heavily-used account cannot turn a launch into a hundred
// sequential fetches. Newest first, so what you asked this morning is
// what arrives.
const MAX_IMPORT_PER_PULL = 15;

interface RemoteConversation {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
}

async function getJSON(path: string, token: string): Promise<any | null> {
  try {
    const res = await fetch(`${licenseService.getApiBase()}/api/v1${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;                       // offline; the next pull will do
  }
}

/**
 * Pull once. Returns how many conversations were newly imported, so a
 * caller can refresh the sidebar only when something changed.
 */
export async function pullPhoneConversations(userId: string | null): Promise<number> {
  const ipc = (window as any).electronAPI;
  if (!ipc || !userId) return 0;                 // web build has no local store
  const token = licenseService.getToken();
  if (!token) return 0;

  const all: RemoteConversation[] | null = await getJSON('/conversations', token);
  if (!Array.isArray(all)) return 0;

  const fromPhone = all
    .filter(c => typeof c?.id === 'string' && c.id.startsWith(PHONE_PREFIX))
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
    .slice(0, MAX_IMPORT_PER_PULL);
  if (!fromPhone.length) return 0;

  // Ask the local store which of these it already has (or the user has
  // deleted) BEFORE fetching any messages — on a normal launch that is
  // all of them, and the pull costs exactly one request.
  const known: string[] = await ipc.invoke(
    'db:known-session-ids', fromPhone.map(c => c.id), userId
  );
  const knownSet = new Set(known || []);
  const wanted = fromPhone.filter(c => !knownSet.has(c.id));
  if (!wanted.length) return 0;

  let imported = 0;
  for (const conv of wanted) {
    const messages = await getJSON(`/conversations/${encodeURIComponent(conv.id)}/messages`, token);
    if (!Array.isArray(messages) || !messages.length) continue;
    const result = await ipc.invoke('db:import-remote-session', {
      id: conv.id,
      name: conv.name,
      createdAt: conv.created_at,
      userId,
      messages: messages.map((m: any) => ({
        id: String(m.id),
        role: m.role,
        content: String(m.content ?? ''),
        timestamp: Number(m.timestamp) || Date.now(),
      })),
    });
    if (result?.ok && result.added > 0) imported++;
  }
  return imported;
}
