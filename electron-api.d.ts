// Global types for the contextBridge surface exposed by electron/preload.cjs.
// Keep in sync with the channel allowlists in preload.cjs — adding a channel
// there has no runtime impact here, but the type lets TS catch typos in the
// renderer when calling send/invoke/on.

export {};

declare global {
  interface ElectronAPI {
    /** Always true when running inside the Electron renderer. Replaces the
     * old `(window as any).process?.versions?.electron` check, which no
     * longer works with contextIsolation:true + nodeIntegration:false. */
    isElectron: true;

    /** Fire-and-forget channel. No-op (with console.warn) for non-allowlisted
     * channels. */
    send(channel: string, data?: unknown): void;

    /** Register a listener for a main→renderer broadcast. Returns a disposer
     * that the caller MUST invoke to remove the listener. */
    on(channel: string, callback: (data: any) => void): () => void;

    /** Promise-based RPC to the main process. Rejects for non-allowlisted
     * channels. */
    invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;

    /** Open an http/https/mailto URL in the OS default browser. Rejects
     * other protocols (no file://, javascript:, data:). */
    openExternal(url: string): Promise<void>;

    /** Robust opener that goes through main-process IPC and tries multiple
     * launch paths (shell.openExternal → child_process spawn). Resolves
     * with a structured result so the renderer can show diagnostic info.
     * Use this in preference to openExternal — the legacy helper is kept
     * for code paths that haven't been migrated yet. */
    openExternalRobust(url: string): Promise<{
      ok: boolean;
      method: string;
      error?: string;
      attempts: Array<{ method: string; ok: boolean; error?: string }>;
    }>;
  }

  interface Window {
    electronAPI?: ElectronAPI;
  }
}
