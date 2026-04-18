/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GOOGLE_CLIENT_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Injected by Vite from package.json at build time (see vite.config.ts).
declare const __APP_VERSION__: string;
