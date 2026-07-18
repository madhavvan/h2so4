#!/usr/bin/env node
/**
 * build-icons.mjs — rasterize build/icon.svg into every shape electron-builder
 * and the web app expect. Run via `npm run icons`.
 *
 * Outputs (all into build/):
 *   icon.icns           — macOS, multi-resolution (16/32/64/128/256/512/1024)
 *   icon.ico            — Windows, multi-resolution (16/24/32/48/64/128/256)
 *   icon.png            — Linux, 1024x1024 (electron-builder downsamples)
 *   icon-{N}.png        — individual sized PNGs (kept for reference / PWA)
 *
 * Plus public/ favicon variants for the Vite web build.
 *
 * Convention: electron-builder picks build/icon.{icns,ico,png} automatically
 * when no explicit `build.{mac,win,linux}.icon` is set in package.json — so
 * we don't need to touch the build config at all to wire these in.
 *
 * Strategy: render the SVG ONCE at 4x density (4096px internal) into a
 * 1024px master PNG, then resize that master with Lanczos for every smaller
 * size. Renders SVG filters (feGaussianBlur for the glow halo) once instead
 * of N times — faster, and guarantees identical pixel output across sizes.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';
import png2icons from 'png2icons';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'build', 'icon.svg');
const BUILD = path.join(root, 'build');
const PUBLIC = path.join(root, 'public');

// Sizes we emit. 16/24/32/48/64/128/256 cover Windows ICO; 512 for Linux/PWA;
// 1024 is the macOS Retina source. PNG copies of every size are useful for
// manual debugging and any future PWA manifest entries.
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

async function main() {
  console.log('• Reading master SVG:', path.relative(root, SRC));
  const svg = await readFile(SRC);
  await mkdir(PUBLIC, { recursive: true });

  // Render the SVG once at high density. density=384 → ~4096px internal
  // for our 1024-viewBox source, which gives sharp's Lanczos kernel
  // enough source pixels to downsample any size without aliasing.
  console.log('• Rendering master (4096px internal → 1024 master)…');
  const master = await sharp(svg, { density: 384 })
    .resize(1024, 1024, { kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9 })
    .toBuffer();

  // Derive every other size from the master. Resizing a 1024 PNG to 16
  // via Lanczos3 produces visibly cleaner output than re-rendering the
  // SVG at density=2 (where filter blur radii get rounded into oblivion).
  console.log('• Resizing to all target sizes…');
  const pngs = { 1024: master };
  for (const size of SIZES) {
    if (size === 1024) continue;
    pngs[size] = await sharp(master)
      .resize(size, size, { kernel: sharp.kernel.lanczos3 })
      .png({ compressionLevel: 9 })
      .toBuffer();
  }

  // Write per-size PNGs into build/ (kept for inspection + PWA reuse).
  for (const size of SIZES) {
    await writeFile(path.join(BUILD, `icon-${size}.png`), pngs[size]);
  }

  // Linux icon — electron-builder picks build/icon.png by convention.
  await writeFile(path.join(BUILD, 'icon.png'), pngs[1024]);
  console.log('  ✓ build/icon.png (1024×1024)');

  // macOS .icns. png2icons takes the largest PNG buffer and emits all the
  // internal slices itself. BICUBIC scaler matches what Apple's iconutil
  // would produce in look and feel.
  console.log('• Generating ICNS (macOS)…');
  const icns = png2icons.createICNS(pngs[1024], png2icons.BICUBIC, 0);
  if (!icns) throw new Error('png2icons.createICNS returned null');
  await writeFile(path.join(BUILD, 'icon.icns'), icns);
  console.log('  ✓ build/icon.icns');

  // Windows .ico. usePNG=true → embeds PNG-in-ICO for the 256/512 slices
  // (Vista+); legacy 16/24/32/48 stay BMP-encoded. Without usePNG, anything
  // above 256 is silently dropped.
  console.log('• Generating ICO (Windows)…');
  const ico = png2icons.createICO(pngs[1024], png2icons.BICUBIC, 0, true);
  if (!ico) throw new Error('png2icons.createICO returned null');
  await writeFile(path.join(BUILD, 'icon.ico'), ico);
  console.log('  ✓ build/icon.ico');

  // Web favicons. Vite copies anything in public/ into the build root, so
  // these become /favicon.ico, /favicon-32.png, /apple-touch-icon.png.
  console.log('• Writing public/ favicons…');
  await writeFile(path.join(PUBLIC, 'favicon.ico'), ico);
  await writeFile(path.join(PUBLIC, 'favicon-32.png'), pngs[32]);
  // 180x180 is the canonical apple-touch-icon size — derived from the same
  // master so it's pixel-identical to a 180-resize of the 1024.
  const appleTouch = await sharp(master)
    .resize(180, 180, { kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(path.join(PUBLIC, 'apple-touch-icon.png'), appleTouch);
  console.log('  ✓ public/favicon.ico, favicon-32.png, apple-touch-icon.png');

  // Tray icons. Electron's Tray expects a small PNG (16px on Win/Linux,
  // template PNG on Mac). Vite copies public/ → dist/ at build time, so
  // in a packaged build these ship as dist/tray-icon.png. Electron's
  // nativeImage auto-picks the @2x variant on HiDPI displays when both
  // are co-located. Reusing the already-rendered 16/32 sizes from the
  // master downsample so the tray matches the rest of the brand output
  // pixel-for-pixel.
  await writeFile(path.join(PUBLIC, 'tray-icon.png'), pngs[16]);
  await writeFile(path.join(PUBLIC, 'tray-icon@2x.png'), pngs[32]);
  console.log('  ✓ public/tray-icon.png, tray-icon@2x.png');

  // The RUNTIME tray asset. electron/main.cjs loadTrayIcon() reads
  // electron/tray-icon.png (shipped inside app.asar beside main.cjs) —
  // NOT the public/ copies above. This split caused the 2026-07-18
  // "new icon everywhere except the tray" bug: the pipeline refreshed
  // public/ while the tray kept loading a stale electron/ file forever.
  // 32px: matches the file main.cjs documents; Electron scales per-DPI.
  await writeFile(path.join(root, 'electron', 'tray-icon.png'), pngs[32]);
  console.log('  ✓ electron/tray-icon.png (the one the tray actually loads)');

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Icon build failed:', err);
  process.exit(1);
});
