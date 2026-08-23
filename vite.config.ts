import path from 'path';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import svgr from 'vite-plugin-svgr';

// Read version from package.json at config-load time so the renderer and
// the server-side version-check always agree. Injected as a global so
// App.tsx can use it without a runtime JSON import (which would bundle
// the whole manifest).
const pkg = JSON.parse(
  readFileSync(path.resolve(__dirname, './package.json'), 'utf-8')
);

export default defineConfig(() => {
    return {
      base: './',
      server: {
        port: 3005,
        host: '0.0.0.0',
      },
      plugins: [
        react(),
        // SVG-as-React-component support via the `?react` query suffix.
        // Used by ProviderIcons.tsx to import the AI provider brand
        // marks shipped in @lobehub/icons-static-svg as React
        // components so they can be styled with currentColor + sized
        // via the size prop (vs. a flat <img> which loses both).
        svgr({ include: '**/*.svg?react' }),
      ],
      define: {
        // No API key is defined here, and loadEnv is deliberately gone.
        //
        // This block used to map 'process.env.API_KEY' and
        // 'process.env.GEMINI_API_KEY' onto env.GEMINI_API_KEY. Nothing in
        // the renderer ever read either token, so nothing was inlined — but
        // the first line of renderer code that did would have baked the live
        // Gemini key into dist/, and dist/ ships to every installed client
        // AND to minicaai.com. Logged as latent in
        // docs/private/AUDIT-crownjewels-2026-08-02.md; removed 2026-08-19.
        //
        // Gemini is server-side only: server/src/routes/ai.js reads
        // process.env.GEMINI_API_KEY per request, so the key lives in the
        // Railway service env and nowhere near a bundle. The config now
        // reads no .env at all, which makes the mistake unavailable rather
        // than merely unmade. VITE_* still works — Vite exposes those
        // through import.meta.env independently of loadEnv.
        __APP_VERSION__: JSON.stringify(pkg.version),
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
