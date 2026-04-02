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

export function useDatabase() {
  const ipc = getIPC();
  const sessionRef = useRef<any>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [contextFiles, setContextFiles] = useState<ContextFile[]>([]);
  const [ready, setReady] = useState(false);

  // Load active session on mount
  useEffect(() => {
    if (!ipc) { setReady(true); return; }

    (async () => {
      const session = await ipc.invoke('db:get-active-session');
      sessionRef.current = session;
      setSessionId(session.id);

      const msgs = await ipc.invoke('db:get-messages', session.id);
      setMessages(msgs);

      const files = await ipc.invoke('db:get-context-files', session.id);
      setContextFiles(files);

      setReady(true);
    })();
  }, []);

  // Listen for updates from the other window
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

    ipc.on('db:messages-updated', onMessagesUpdated);
    ipc.on('db:files-updated', onFilesUpdated);
    ipc.on('db:session-cleared', onSessionCleared);

    return () => {
      ipc.removeListener('db:messages-updated', onMessagesUpdated);
      ipc.removeListener('db:files-updated', onFilesUpdated);
      ipc.removeListener('db:session-cleared', onSessionCleared);
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
    if (!ipc) return;
    const session = await ipc.invoke('db:new-session', name);
    sessionRef.current = session;
    setSessionId(session.id);
    setMessages([]);
    setContextFiles([]);
  }, []);

  const clearSession = useCallback(async () => {
    if (!ipc || !sessionRef.current) return;
    await ipc.invoke('db:clear-session', sessionRef.current.id);
    setMessages([]);
    setContextFiles([]);
  }, []);

  return {
    ready,
    sessionId,
    messages,
    setMessages, // for local-only updates like interim text
    contextFiles,
    addMessage,
    addContextFile,
    removeContextFile,
    newSession,
    clearSession,
    isElectron: !!ipc,
  };
}