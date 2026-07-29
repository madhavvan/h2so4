import { useState, useEffect, useCallback, useRef } from 'react';
import { Message, ContextFile } from '../types';
import { syncConversationMessage, syncConversationRename } from '../services/aiProxyService';
import { pullPhoneConversations } from '../services/phoneConversations';

const isElectron = typeof window !== 'undefined'
  && !!window.electronAPI?.isElectron;

// Thin wrapper that mimics the old ipcRenderer surface using the
// contextBridge-exposed electronAPI. Returns null in browser context;
// callers must guard. We map ipc.on/.removeListener pairs through
// disposers — see Electron preload.cjs for the shape.
function getIPC(): {
  invoke: (channel: string, ...args: any[]) => Promise<any>;
  on: (channel: string, callback: (data: any) => void) => () => void;
} | null {
  if (!isElectron || !window.electronAPI) return null;
  const api = window.electronAPI;
  return {
    invoke: (channel, ...args) => api.invoke(channel, ...args),
    on: (channel, callback) => api.on(channel, callback),
  };
}

export interface SessionSummary {
  id: string;
  name: string;
  created_at: number;
  is_active: number;
  message_count: number;
  preview: string | null;
}

export function useDatabase(userId: string | null) {
  const ipc = getIPC();
  const sessionRef = useRef<any>(null);
  const userIdRef = useRef<string | null>(userId);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [contextFiles, setContextFiles] = useState<ContextFile[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [ready, setReady] = useState(false);
  const [restoredCount, setRestoredCount] = useState(0);

  useEffect(() => { userIdRef.current = userId; }, [userId]);

  // Load active session once a userId is known. Without a user we do not
  // read or write sessions — this is what prevents one user's history from
  // leaking into another account on the same device.
  useEffect(() => {
    if (!ipc) { setReady(true); return; }
    if (!userId) { setReady(false); return; }

    let cancelled = false;
    (async () => {
      // One-time migration claim: existing installs had sessions with no
      // owner. The first user to sign in after upgrading takes ownership
      // of those pre-upgrade conversations. Subsequent users get a clean
      // account because orphan rows no longer exist.
      const claimed: number = await ipc.invoke('db:claim-orphan-sessions', userId);
      if (cancelled) return;
      if (claimed > 0) setRestoredCount(claimed);

      const session = await ipc.invoke('db:get-active-session', userId);
      if (cancelled) return;
      sessionRef.current = session;
      setSessionId(session.id);

      const [msgs, files, list] = await Promise.all([
        ipc.invoke('db:get-messages', session.id, userId),
        ipc.invoke('db:get-context-files', session.id, userId),
        ipc.invoke('db:list-sessions', userId),
      ]);
      if (cancelled) return;
      setMessages(msgs);
      setContextFiles(files);
      setSessions(list);

      setReady(true);
    })();

    return () => { cancelled = true; };
  }, [userId]);

  // ── Conversations the phone wrote while this machine was off ──────
  // Runs after `ready` so it can never delay first paint — the sidebar
  // is on screen with local history before this makes a single request.
  // See services/phoneConversations.ts for why it pulls only `phone-`
  // ids and why it polls rather than being pushed to.
  useEffect(() => {
    if (!ipc || !userId || !ready) return;
    let cancelled = false;

    const pull = async () => {
      const n = await pullPhoneConversations(userId).catch(() => 0);
      if (cancelled || !n) return;
      // The import itself broadcasts db:sessions-updated, which the
      // listener below turns into a list refresh — but that listener is
      // registered once with no userId in scope, so refresh here too
      // rather than rely on ordering.
      ipc.invoke('db:list-sessions', userId).then((l: SessionSummary[]) => {
        if (!cancelled) setSessions(l);
      });
    };

    void pull();
    const timer = setInterval(pull, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [userId, ready]);

  // Cross-window event listeners. Each renderer (main + popout) subscribes
  // and the main process fans out the relevant channels via broadcastToAllWindows.
  // The contextBridge `on` returns a disposer; we collect them and run all
  // on cleanup. Handler args are now (data) — the bridge strips the Electron
  // event arg before delivering.
  useEffect(() => {
    if (!ipc) return;

    const onMessagesUpdated = (sid: string) => {
      if (sid === sessionRef.current?.id) {
        const uid = userIdRef.current;
        if (uid) ipc.invoke('db:get-messages', sid, uid).then(setMessages);
      }
    };

    const onFilesUpdated = (sid?: string) => {
      const id = sid || sessionRef.current?.id;
      if (id) {
        const uid = userIdRef.current;
        if (uid) ipc.invoke('db:get-context-files', id, uid).then(setContextFiles);
      }
    };

    const onSessionCleared = (sid: string) => {
      if (sid === sessionRef.current?.id) {
        setMessages([]);
        setContextFiles([]);
      }
    };

    const onSessionsUpdated = () => {
      const uid = userIdRef.current;
      if (!uid) return;
      ipc.invoke('db:list-sessions', uid).then(setSessions);
    };

    // Fired when the active session changes from another window (popout)
    // or from a delete that promoted a different session. Pull the new
    // messages/files so the UI switches in place.
    const onActiveSessionChanged = async (newId: string) => {
      if (!newId || newId === sessionRef.current?.id) return;
      const uid = userIdRef.current;
      if (!uid) return;
      const session = await ipc.invoke('db:get-active-session', uid);
      sessionRef.current = session;
      setSessionId(session.id);
      const [msgs, files] = await Promise.all([
        ipc.invoke('db:get-messages', session.id, uid),
        ipc.invoke('db:get-context-files', session.id, uid),
      ]);
      setMessages(msgs);
      setContextFiles(files);
    };

    const disposers = [
      ipc.on('db:messages-updated', onMessagesUpdated),
      ipc.on('db:files-updated', onFilesUpdated),
      ipc.on('db:session-cleared', onSessionCleared),
      ipc.on('db:sessions-updated', onSessionsUpdated),
      ipc.on('db:active-session-changed', onActiveSessionChanged),
    ];

    return () => { disposers.forEach(d => d()); };
  }, []);

  const addMessage = useCallback(async (msg: Message) => {
    if (!ipc || !sessionRef.current || !userIdRef.current) return;
    const session = sessionRef.current;
    setMessages(prev => [...prev, msg]);
    await ipc.invoke('db:add-message', session.id, msg, userIdRef.current);
    // Best-effort cloud sync so admin can see the conversation in the
    // dashboard. Fire-and-forget — never blocks the UI, never surfaces
    // errors to the candidate. See services/aiProxyService.ts header
    // comment on syncConversationMessage for privacy boundaries.
    syncConversationMessage({
      sessionId: session.id,
      sessionName: session.name || 'Interview session',
      message: {
        id: String(msg.id),
        role: String(msg.role),
        content: String(msg.content || ''),
        timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : Date.now(),
      },
    }).catch(() => { /* swallow */ });
  }, []);

  const addContextFile = useCallback(async (file: ContextFile) => {
    if (!ipc || !sessionRef.current || !userIdRef.current) return;
    setContextFiles(prev => [...prev, file]);
    await ipc.invoke('db:add-context-file', sessionRef.current.id, file, userIdRef.current);
  }, []);

  const removeContextFile = useCallback(async (fileId: string) => {
    if (!ipc || !userIdRef.current) return;
    setContextFiles(prev => prev.filter(f => f.id !== fileId));
    await ipc.invoke('db:remove-context-file', fileId, userIdRef.current);
  }, []);

  const newSession = useCallback(async (name?: string) => {
    // Clear the VISIBLE session FIRST, unconditionally. Previously this
    // early-returned when ipc/userId weren't ready (browser mode, or a
    // userId race right after sign-in) — leaving the previous session's
    // uploaded files and messages on screen, which read as "files carried
    // into the new chat". New chat must always look fresh, whether or not
    // we can persist the new row.
    setMessages([]);
    setContextFiles([]);
    if (!ipc || !userIdRef.current) return;
    const session = await ipc.invoke('db:new-session', name, userIdRef.current);
    sessionRef.current = session;
    setSessionId(session.id);
  }, []);

  const switchSession = useCallback(async (targetId: string) => {
    if (!ipc || !userIdRef.current) return;
    if (targetId === sessionRef.current?.id) return;
    const session = await ipc.invoke('db:switch-session', targetId, userIdRef.current);
    if (!session) return;
    sessionRef.current = session;
    setSessionId(session.id);
    const [msgs, files] = await Promise.all([
      ipc.invoke('db:get-messages', session.id, userIdRef.current),
      ipc.invoke('db:get-context-files', session.id, userIdRef.current),
    ]);
    setMessages(msgs);
    setContextFiles(files);
  }, []);

  const renameSession = useCallback(async (targetId: string, newName: string) => {
    if (!ipc || !userIdRef.current) return false;
    const ok: boolean = await ipc.invoke('db:rename-session', targetId, userIdRef.current, newName);
    if (ok) {
      // Mirror the rename to the server so admin sees the up-to-date title.
      // The auto-titler also flows through here once the AI generates a name.
      syncConversationRename({ sessionId: targetId, newName }).catch(() => {});
    }
    return ok;
  }, []);

  const deleteSession = useCallback(async (targetId: string) => {
    if (!ipc || !userIdRef.current) return;
    const result = await ipc.invoke('db:delete-session', targetId, userIdRef.current);
    if (!result?.ok) return;
    // If the deleted session was the active one, the main process has
    // already promoted (or minted) a replacement — load it into view.
    if (result.newActiveSession) {
      sessionRef.current = result.newActiveSession;
      setSessionId(result.newActiveSession.id);
      const [msgs, files] = await Promise.all([
        ipc.invoke('db:get-messages', result.newActiveSession.id, userIdRef.current),
        ipc.invoke('db:get-context-files', result.newActiveSession.id, userIdRef.current),
      ]);
      setMessages(msgs);
      setContextFiles(files);
    }
  }, []);

  const clearSession = useCallback(async () => {
    if (!ipc || !sessionRef.current || !userIdRef.current) return;
    await ipc.invoke('db:clear-session', sessionRef.current.id, userIdRef.current);
    setMessages([]);
    setContextFiles([]);
  }, []);

  const dismissRestoredToast = useCallback(() => setRestoredCount(0), []);

  return {
    ready,
    sessionId,
    messages,
    setMessages,
    contextFiles,
    setContextFiles,
    sessions,
    addMessage,
    addContextFile,
    removeContextFile,
    newSession,
    switchSession,
    renameSession,
    deleteSession,
    clearSession,
    isElectron: !!ipc,
    restoredCount,
    dismissRestoredToast,
  };
}
