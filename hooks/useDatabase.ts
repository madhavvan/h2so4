import { useState, useEffect, useCallback, useRef } from 'react';
import { Message, ContextFile } from '../types';

const isElectron = typeof window !== 'undefined'
  && !!(window as any).process?.versions?.electron;

function getIPC() {
  if (!isElectron) return null;
  try {
    return (window as any).require('electron').ipcRenderer;
  } catch { return null; }
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
  useEffect(() => {
    if (!ipc) return;

    const onMessagesUpdated = (_e: any, sid: string) => {
      if (sid === sessionRef.current?.id) {
        ipc.invoke('db:get-messages', sid).then(setMessages);
      }
    };

    const onFilesUpdated = (_e: any, sid?: string) => {
      const id = sid || sessionRef.current?.id;
      if (id) {
        ipc.invoke('db:get-context-files', id).then(setContextFiles);
      }
    };

    const onSessionCleared = (_e: any, sid: string) => {
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
    const onActiveSessionChanged = async (_e: any, newId: string) => {
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

    ipc.on('db:messages-updated', onMessagesUpdated);
    ipc.on('db:files-updated', onFilesUpdated);
    ipc.on('db:session-cleared', onSessionCleared);
    ipc.on('db:sessions-updated', onSessionsUpdated);
    ipc.on('db:active-session-changed', onActiveSessionChanged);

    return () => {
      ipc.removeListener('db:messages-updated', onMessagesUpdated);
      ipc.removeListener('db:files-updated', onFilesUpdated);
      ipc.removeListener('db:session-cleared', onSessionCleared);
      ipc.removeListener('db:sessions-updated', onSessionsUpdated);
      ipc.removeListener('db:active-session-changed', onActiveSessionChanged);
    };
  }, []);

  const addMessage = useCallback(async (msg: Message) => {
    if (!ipc || !sessionRef.current) return;
    setMessages(prev => [...prev, msg]);
    await ipc.invoke('db:add-message', sessionRef.current.id, msg);
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
