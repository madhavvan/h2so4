// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ELECTRON-BUILDER CUSTOM SIGN HOOK — Azure Trusted Signing
//
//  electron-builder calls this function for every .exe it produces
//  (the installer, the unpacked app .exe, etc.). We shell out to
//  signtool.exe with Microsoft's Trusted Signing dlib pointing at
//  our Azure account.
//
//  Required env vars at build time:
//    AZURE_TENANT_ID      — from your App registration's Overview page
//    AZURE_CLIENT_ID      — from your App registration's Overview page
//    AZURE_CLIENT_SECRET  — the value you copied when creating the secret
//
//  The dlib uses DefaultAzureCredential — it picks up these env vars
//  automatically, no signtool flags needed for them.
//
//  Required toolchain:
//    - signtool.exe — from Windows SDK (auto-located below)
//    - Azure.CodeSigning.Dlib.dll — install via:
//        powershell -ExecutionPolicy Bypass -File scripts/install-signing-dlib.ps1
//      (one-time setup; cached in .signing/ which is gitignored)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Microsoft's Trusted Signing timestamp authority. RFC 3161 server
// hosted by Microsoft — using their own timestamping is the supported
// path; using a third-party (digicert/sectigo) timestamp server with a
// Trusted Signing cert technically works but isn't officially supported.
const TIMESTAMP_URL = 'http://timestamp.acs.microsoft.com';

function locateSigntool() {
  // Honor explicit override first.
  if (process.env.SIGNTOOL_PATH && fs.existsSync(process.env.SIGNTOOL_PATH)) {
    return process.env.SIGNTOOL_PATH;
  }
  // Walk Windows SDK install locations newest-first. Standard layout:
  //   C:\Program Files (x86)\Windows Kits\10\bin\<sdk-version>\x64\signtool.exe
  const sdkRoot = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  if (!fs.existsSync(sdkRoot)) return null;
  const versions = fs
    .readdirSync(sdkRoot)
    .filter((n) => /^10\.\d+\.\d+\.\d+$/.test(n))
    .sort()
    .reverse();
  for (const v of versions) {
    const candidate = path.join(sdkRoot, v, 'x64', 'signtool.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  // Fallback to Windows SDK without versioned subdir (older installs).
  const fallback = path.join(sdkRoot, 'x64', 'signtool.exe');
  return fs.existsSync(fallback) ? fallback : null;
}

function locateDlib() {
  const candidate = path.join(__dirname, '..', '.signing', 'Azure.CodeSigning.Dlib.dll');
  return fs.existsSync(candidate) ? candidate : null;
}

exports.default = async function sign(configuration) {
  const filePath = configuration.path;
  const fileName = path.basename(filePath);

  // Skip env validation in CI dry-runs (e.g. linting the config). We only
  // care when an actual file path is provided.
  if (!filePath) return;

  const missing = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'].filter(
    (v) => !process.env[v]
  );
  if (missing.length) {
    throw new Error(
      `[sign] Cannot sign ${fileName} — missing env vars: ${missing.join(', ')}.\n` +
        `  Set them before running electron-builder. See scripts/sign-windows.cjs header.`
    );
  }

  const signtool = locateSigntool();
  if (!signtool) {
    throw new Error(
      `[sign] Cannot find signtool.exe.\n` +
        `  Install Windows SDK 10 (or set SIGNTOOL_PATH env var to its location).\n` +
        `  Easiest: install "Visual Studio Build Tools" with the "Desktop development with C++" workload.`
    );
  }

  const dlib = locateDlib();
  if (!dlib) {
    throw new Error(
      `[sign] Azure Code Signing dlib not found at .signing/Azure.CodeSigning.Dlib.dll.\n` +
        `  Run once: powershell -ExecutionPolicy Bypass -File scripts/install-signing-dlib.ps1`
    );
  }

  const metadata = path.join(__dirname, 'azure-signing-metadata.json');

  console.log(`[sign] ${fileName} → Azure Trusted Signing`);

  // execFileSync (not execSync) so we don't have to quote-escape arguments —
  // safer with paths that may contain spaces (Program Files etc.).
  execFileSync(
    signtool,
    [
      'sign',
      '/v',                         // verbose output (helps debug failures)
      '/debug',                     // detailed dlib loader info on failure
      '/fd', 'SHA256',              // file digest algorithm
      '/tr', TIMESTAMP_URL,         // RFC 3161 timestamp server
      '/td', 'SHA256',              // timestamp digest algorithm
      '/dlib', dlib,                // path to Azure.CodeSigning.Dlib.dll
      '/dmdf', metadata,            // path to azure-signing-metadata.json
      filePath,
    ],
    { stdio: 'inherit' }
  );
};
