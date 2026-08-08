const fs = require('fs');
const path = require('path');

const WRONG_PLATFORM_LIBNUT = {
  darwin: ['@nut-tree-fork/libnut-linux', '@nut-tree-fork/libnut-win32'],
  win32:  ['@nut-tree-fork/libnut-darwin', '@nut-tree-fork/libnut-linux'],
  linux:  ['@nut-tree-fork/libnut-darwin', '@nut-tree-fork/libnut-win32'],
};

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else if (entry.isFile()) {
      try { total += fs.statSync(full).size; } catch {}
    }
  }
  return total;
}

const { guardAfterPack } = require('./asar-guard.cjs');

exports.default = async function afterPack(context) {
  // Runs FIRST and throws on a dirty-tree build. electron-builder has only
  // one afterPack slot, so the guard is chained here rather than configured
  // separately — see scripts/asar-guard.cjs for why it exists at all.
  await guardAfterPack(context);

  const { appOutDir, electronPlatformName, packager } = context;
  const appName = packager.appInfo.productFilename;

  const nodeModulesPath = electronPlatformName === 'darwin'
    ? path.join(appOutDir, `${appName}.app`, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules')
    : path.join(appOutDir, 'resources', 'app.asar.unpacked', 'node_modules');

  console.log(`[notary-cleanup] platform=${electronPlatformName} appOutDir=${appOutDir}`);
  console.log(`[notary-cleanup] inspecting: ${nodeModulesPath}`);

  if (!fs.existsSync(nodeModulesPath)) {
    console.log('[notary-cleanup] no app.asar.unpacked/node_modules in this build — nothing to do');
    return;
  }

  const toRemove = WRONG_PLATFORM_LIBNUT[electronPlatformName] || [];
  for (const pkg of toRemove) {
    const fullPath = path.join(nodeModulesPath, ...pkg.split('/'));
    if (fs.existsSync(fullPath)) {
      const sizeMB = (dirSize(fullPath) / 1024 / 1024).toFixed(2);
      fs.rmSync(fullPath, { recursive: true, force: true });
      console.log(`[notary-cleanup] REMOVED ${pkg} (${sizeMB} MB) — files config did NOT exclude it`);
    } else {
      console.log(`[notary-cleanup] ${pkg} already absent — files config DID exclude it`);
    }
  }

  // Also enumerate any other non-Mach-O .node or .dll files in the bundle
  // so we can spot anything else that might be choking the notary scanner.
  if (electronPlatformName === 'darwin') {
    const suspicious = [];
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) {
          const name = entry.name.toLowerCase();
          if (name.endsWith('.dll') || name.endsWith('.exe')) {
            suspicious.push(full);
          } else if (name.endsWith('.node')) {
            // Check magic bytes
            try {
              const fd = fs.openSync(full, 'r');
              const buf = Buffer.alloc(4);
              fs.readSync(fd, buf, 0, 4, 0);
              fs.closeSync(fd);
              const magic = buf.readUInt32BE(0);
              // Mach-O: 0xfeedface, 0xfeedfacf, 0xcafebabe (universal), reverse-endian variants
              const isMachO = [0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcefaedfe, 0xcffaedfe, 0xbebafeca].includes(magic);
              if (!isMachO) {
                suspicious.push(`${full}  magic=0x${magic.toString(16)}`);
              }
            } catch (e) {
              suspicious.push(`${full}  (read failed: ${e.message})`);
            }
          }
        }
      }
    })(nodeModulesPath);

    if (suspicious.length) {
      console.log(`[notary-cleanup] SUSPICIOUS non-Mach-O binaries still in mac bundle (${suspicious.length}):`);
      for (const s of suspicious) console.log(`  - ${s}`);
    } else {
      console.log('[notary-cleanup] mac bundle clean — no foreign .node/.dll/.exe found');
    }
  }
};
