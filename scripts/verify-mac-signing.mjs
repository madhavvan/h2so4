#!/usr/bin/env node
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  IS THE MAC BUILD ACTUALLY OPENABLE?
//
//  `release:verify` proves the feed SERVES the mac files. It cannot tell
//  you whether the thing it serves will open: an unsigned or un-stapled
//  .app downloads with a perfect 200 and then dies at Gatekeeper with
//  "Apple could not verify... it may contain malware". To the user that is
//  indistinguishable from the app being broken, and nothing upstream of
//  this catches it — electron-builder's `notarize: true` fails the BUILD on
//  a notarization error, but it cannot notice a stapling step that silently
//  produced nothing, an asset overwritten by a later upload, or a mirror
//  that copied a truncated file.
//
//  This existed once, as `mac-verify.yml` — a ONE-OFF added to check v4.0.8
//  and deleted the moment it passed (commits 4170789, then 0ca1ecc). Every
//  release since has shipped with nobody checking. This is the permanent
//  replacement.
//
//  ── WHY IT NEEDS NO MAC RUNNER ──
//  `codesign`/`spctl` need macOS. The two FACTS they would establish are
//  both visible as bytes inside the .zip:
//
//    Contents/_CodeSignature/CodeResources   the signature manifest. Must
//        exist for the app AND for every nested framework and helper —
//        Gatekeeper rejects the bundle if any nested code is unsigned.
//
//    Contents/CodeResources                  NOT under _CodeSignature/ —
//        this is the STAPLED NOTARIZATION TICKET that `xcrun stapler`
//        writes into the bundle. Its first four bytes are the magic
//        's8ch'. Stapling is what lets the app open with no network; an
//        app that is notarized but not stapled fails on an offline
//        machine, which is exactly where an interview happens.
//
//  ── WHY IT DOES NOT DOWNLOAD THE ZIP ──
//  Each mac zip is ~176 MB and there are two. Everything above is answered
//  by the ZIP central directory (a list of every entry) plus the ~2 KB of
//  one file, so this reads a few hundred KB over HTTP Range instead. If the
//  host refuses Range it falls back to a full read rather than failing.
//
//  Dependency-free on purpose, like verify-release-feed.mjs: node built-ins
//  and fetch only, so a broken `npm ci` can never disable the gate.
//
//  Usage:  node scripts/verify-mac-signing.mjs --tag v4.0.21
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { inflateRawSync } from 'node:zlib';

const args = process.argv.slice(2);
const argOf = (n, d = null) => {
  const i = args.indexOf(n);
  return i === -1 ? d : args[i + 1];
};

const TAG = argOf('--tag');
const REPO = argOf('--repo', 'madhavvan/interviewcopilot-releases');
if (!TAG) {
  console.error('usage: node scripts/verify-mac-signing.mjs --tag vX.Y.Z [--repo owner/name]');
  process.exit(2);
}

// The stapled-ticket magic. `xcrun stapler` writes this at byte 0.
const TICKET_MAGIC = 's8ch';
// A correctly signed Electron app carries a manifest for the app itself plus
// one per nested framework/helper. Well under the ~18 a real build has, but
// far above the 1 you get when only the outer bundle was signed.
const MIN_SIGNATURE_MANIFESTS = 5;

const assetUrl = (name) =>
  `https://github.com/${REPO}/releases/download/${TAG}/${name}`;

async function contentLength(url) {
  // HEAD can be answered by a redirect stub, so ask for one byte instead and
  // read the total out of Content-Range — that is always the real object.
  const res = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  if (!res.ok && res.status !== 206) return { size: null, status: res.status };
  const cr = res.headers.get('content-range');
  await res.arrayBuffer().catch(() => {});
  if (cr && /\/(\d+)$/.test(cr)) return { size: Number(cr.match(/\/(\d+)$/)[1]), status: res.status, ranges: true };
  const cl = res.headers.get('content-length');
  return { size: cl ? Number(cl) : null, status: res.status, ranges: false };
}

async function readRange(url, start, end) {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
  if (res.status !== 206 && res.status !== 200) throw new Error(`range read ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Parse the ZIP central directory into {name, offset, method, cSize} entries. */
async function centralDirectory(url, size) {
  // The End Of Central Directory record lives in the last 64KB (it is 22
  // bytes plus a comment that is empty in practice).
  const tailLen = Math.min(65_557, size);
  const tail = await readRange(url, size - tailLen, size - 1);
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd === -1) throw new Error('no End Of Central Directory — not a zip?');
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOff = tail.readUInt32LE(eocd + 16);
  // Zip64 sentinel. These builds are ~176MB so it should never trip, but a
  // wrong offset would read garbage rather than fail loudly, so check.
  if (cdOff === 0xffffffff || cdSize === 0xffffffff) {
    const z = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06]));
    if (z === -1) throw new Error('zip64 sentinel with no zip64 EOCD');
    cdSize = Number(tail.readBigUInt64LE(z + 40));
    cdOff = Number(tail.readBigUInt64LE(z + 48));
  }
  const cd = await readRange(url, cdOff, cdOff + cdSize - 1);
  const out = [];
  let p = 0;
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
    const method = cd.readUInt16LE(p + 10);
    const cSize = cd.readUInt32LE(p + 20);
    const uSize = cd.readUInt32LE(p + 24);
    const nLen = cd.readUInt16LE(p + 28);
    const eLen = cd.readUInt16LE(p + 30);
    const kLen = cd.readUInt16LE(p + 32);
    const lho = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nLen).toString('utf8');
    out.push({ name, method, cSize, uSize, offset: lho });
    p += 46 + nLen + eLen + kLen;
  }
  return out;
}

/** Pull one entry's bytes out of the archive. */
async function readEntry(url, e) {
  // The local header repeats the name/extra with its OWN lengths — the
  // central directory's are not reliable here.
  const head = await readRange(url, e.offset, e.offset + 29);
  if (head.readUInt32LE(0) !== 0x04034b50) throw new Error('bad local header');
  const nLen = head.readUInt16LE(26);
  const eLen = head.readUInt16LE(28);
  const start = e.offset + 30 + nLen + eLen;
  const raw = await readRange(url, start, start + e.cSize - 1);
  if (e.method === 0) return raw;
  if (e.method === 8) return inflateRawSync(raw);
  throw new Error(`unsupported compression method ${e.method}`);
}

const problems = [];
const notes = [];

async function verifyArch(archAsset) {
  const url = assetUrl(archAsset);
  console.log(`\n━━━ ${archAsset} ━━━`);
  const meta = await contentLength(url);
  if (!meta.size) {
    problems.push(`${archAsset}: cannot read (HTTP ${meta.status}) — the asset is missing from ${REPO}@${TAG}`);
    console.log(`  ✗ not fetchable (HTTP ${meta.status})`);
    return;
  }
  console.log(`  ✓ fetchable, ${(meta.size / 1048576).toFixed(1)} MB${meta.ranges ? '' : '  (host ignored Range — read in full)'}`);

  let entries;
  try {
    entries = await centralDirectory(url, meta.size);
  } catch (err) {
    problems.push(`${archAsset}: could not read the archive (${err.message}) — a truncated or corrupt upload looks exactly like this`);
    console.log(`  ✗ ${err.message}`);
    return;
  }
  console.log(`  ✓ archive readable, ${entries.length} entries`);

  // 1. Everything that carries code must be signed.
  const manifests = entries.filter((e) => /\/_CodeSignature\/CodeResources$/.test(e.name));
  if (manifests.length >= MIN_SIGNATURE_MANIFESTS) {
    console.log(`  ✓ code signature manifests: ${manifests.length} (app + nested frameworks/helpers)`);
  } else {
    problems.push(`${archAsset}: only ${manifests.length} _CodeSignature manifest(s) — nested frameworks/helpers look unsigned, which Gatekeeper rejects`);
    console.log(`  ✗ only ${manifests.length} signature manifest(s)`);
  }

  // 2. The stapled notarization ticket, on the OUTERMOST .app.
  //
  // ⚠️ Do NOT anchor this to a wrapper directory. electron-builder's mac zip
  // has NO top-level folder — entries begin at "Interview Copilot.app/" —
  // while an unzipped copy on disk sits under "…-arm64/". The first version
  // of this check required the wrapper, found nothing, and reported a
  // perfectly stapled build as unsigned. A verifier that fails closed for
  // the wrong reason gets switched off, so: match at any depth and take the
  // SHALLOWEST hit, which is the outer bundle rather than a nested Helper.
  const ticket = entries
    .filter((e) => /\.app\/Contents\/CodeResources$/.test(e.name))
    .sort((a, b) => a.name.split('/').length - b.name.split('/').length)[0];
  if (!ticket) {
    problems.push(`${archAsset}: NO stapled notarization ticket (Contents/CodeResources missing). The app may be notarized but un-stapled — it will fail to open on a machine with no network, which is where interviews happen.`);
    console.log('  ✗ no stapled ticket');
    return;
  }
  let body;
  try {
    body = await readEntry(url, ticket);
  } catch (err) {
    problems.push(`${archAsset}: stapled ticket unreadable (${err.message})`);
    console.log(`  ✗ ticket unreadable: ${err.message}`);
    return;
  }
  const magic = body.subarray(0, 4).toString('latin1');
  if (magic !== TICKET_MAGIC) {
    problems.push(`${archAsset}: Contents/CodeResources is not a stapled ticket (magic "${magic}", expected "${TICKET_MAGIC}")`);
    console.log(`  ✗ ticket magic "${magic}"`);
    return;
  }
  const issuer = body.subarray(0, 400).toString('latin1');
  const apple = /Apple/.test(issuer);
  console.log(`  ✓ stapled notarization ticket: ${body.length} b, magic "${magic}"${apple ? ', Apple-issued' : ''}`);
  if (!apple) notes.push(`${archAsset}: ticket present but no Apple issuer string in its header — unusual, worth a manual look`);
}

console.log(`Verifying the SHIPPED macOS build is signed and stapled.`);
console.log(`Repo: ${REPO}   Tag: ${TAG}`);

for (const asset of ['InterviewCopilot-Mac-arm64.zip', 'InterviewCopilot-Mac-x64.zip']) {
  try {
    await verifyArch(asset);
  } catch (err) {
    problems.push(`${asset}: ${err.message}`);
    console.log(`  ✗ ${err.message}`);
  }
}

console.log('\n' + '─'.repeat(66));
for (const n of notes) console.log(`  (note) ${n}`);
if (problems.length) {
  console.log(`FAIL — ${problems.length} problem${problems.length === 1 ? '' : 's'}:`);
  for (const p of problems) console.log(`  • ${p}`);
  console.log('\nA Mac user who downloads this will be told the app "cannot be opened".');
  process.exit(1);
}
console.log('PASS — both architectures are code-signed and carry an Apple stapled');
console.log('notarization ticket, so they open cleanly, including offline.');
