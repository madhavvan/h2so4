import { useState, useEffect, useCallback, useRef } from 'react';
import { Message, ContextFile } from '../types';
import { syncConversationMessage, syncConversationRename } from '../services/aiProxyService';

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
        ipc.invoke('db:get-messages', session.id),
        ipc.invoke('db:get-context-files', session.id),
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

  // Cross-window event listeners. Each renderer (main + popout) subscribes
  // and the main process fans out the relevant channels via broadcastToAllWindows.
  // The contextBridge `on` returns a disposer; we collect them and run all
  // on cleanup. Handler args are now (data) — the bridge strips the Electron
  // event arg before delivering.
  useEffect(() => {
    if (!ipc) return;

    const onMessagesUpdated = (sid: string) => {
      if (sid === sessionRef.current?.id) {
        ipc.invoke('db:get-messages', sid).then(setMessages);
      }
    };

    const onFilesUpdated = (sid?: string) => {
      const id = sid || sessionRef.current?.id;
      if (id) {
        ipc.invoke('db:get-context-files', id).then(setContextFiles);
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
        ipc.invoke('db:get-messages', session.id),
        ipc.invoke('db:get-context-files', session.id),
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
    if (!ipc || !sessionRef.current) return;
    const session = sessionRef.current;
    setMessages(prev => [...prev, msg]);
    await ipc.invoke('db:add-message', session.id, msg);
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
    if (!ipc || !sessionRef.current) return;
    setContextFiles(prev => [...prev, file]);
    await ipc.invoke('db:add-context-file', sessionRef.current.id, file);
  }, []);

  const removeContextFile = useCallback(async (fileId: string) => {
    if (!ipc) return;
    setContextFiles(prev => prev.filter(f => f.id !== fileId));
    await ipc.invoke('db:remove-context-file', fileId);
  }, []);

  const newSession = useCallback(async (name?: string) => {
    if (!ipc || !userIdRef.current) return;
    const session = await ipc.invoke('db:new-session', name, userIdRef.current);
    sessionRef.current = session;
    setSessionId(session.id);
    setMessages([]);
    setContextFiles([]);
  }, []);

  const switchSession = useCallback(async (targetId: string) => {
    if (!ipc || !userIdRef.current) return;
    if (targetId === sessionRef.current?.id) return;
    const session = await ipc.invoke('db:switch-session', targetId, userIdRef.current);
    if (!session) return;
    sessionRef.current = session;
    setSessionId(session.id);
    const [msgs, files] = await Promise.all([
      ipc.invoke('db:get-messages', session.id),
      ipc.invoke('db:get-context-files', session.id),
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
        ipc.invoke('db:get-messages', result.newActiveSession.id),
        ipc.invoke('db:get-context-files', result.newActiveSession.id),
      ]);
      setMessages(msgs);
      setContextFiles(files);
    }
  }, []);

  const clearSession = useCallback(async () => {
    if (!ipc || !sessionRef.current) return;
    await ipc.invoke('db:clear-session', sessionRef.current.id);
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
