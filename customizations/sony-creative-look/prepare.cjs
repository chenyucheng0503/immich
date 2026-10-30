'use strict';
// 仅供明确指定、尚未入库的文件预写旁车。只新建旁车，不覆盖已有旁车或改写原片。
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { exif, resolveLook, validateProfiles, safePath, sameFile, sidecarPath, snapshotXmp,
  xmpFields, mergeDescription, Conflict } = require('./core.cjs');
const digest = async (file) => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
function renderXmp(text) {
  const value = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:tiff="http://ns.adobe.com/tiff/1.0/">' +
    '<dc:description><rdf:Alt><rdf:li xml:lang="x-default">' + value + '</rdf:li></rdf:Alt></dc:description>' +
    '<tiff:ImageDescription>' + value + '</tiff:ImageDescription></rdf:Description></rdf:RDF></x:xmpmeta>\n';
}
async function prepare({ files, roots, profiles, read, auditDir, apply = false }) {
  validateProfiles(profiles);
  const plans = [];
  // 整批预检完成后才允许写入。
  for (const file of files) {
    if (!/\.(jpe?g|arw|hif|heic)$/i.test(file)) throw new Conflict('not_photo');
    const stat = await safePath(file, roots);
    const tags = await read(file);
    if (tags['IFD0:Model'] !== 'ILCE-7CM2' || !/^sony$/i.test(tags['IFD0:Make'] ?? '')) throw new Conflict('different_camera');
    const resolved = resolveLook(tags, profiles);
    const xmp = await sidecarPath(file);
    const before = await snapshotXmp(xmp, roots, read);
    const [dc, tiff] = xmpFields(tags);
    const old = before?.tiff ?? before?.dc ?? tiff ?? dc ?? tags['IFD0:ImageDescription'] ?? '';
    const target = mergeDescription(old, resolved.code);
    if (before && (before.dc !== target || before.tiff !== target)) throw new Conflict('existing_sidecar_requires_review');
    plans.push({ file, xmp, stat, originalSha256: await digest(file), ...resolved, target, status: before ? 'unchanged' : 'planned' });
  }
  if (!apply) return { dryRun: true, plans };
  await fs.mkdir(auditDir, { recursive: true, mode: 0o700 });
  const record = { createdAt: new Date().toISOString(), plans };
  const audit = path.join(auditDir, 'preimport-' + crypto.randomUUID() + '.json');
  const save = async () => {
    const temporary = audit + '.tmp';
    await fs.writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(temporary, audit);
  };
  await save();
  for (const item of plans) {
    if (item.status === 'unchanged') continue;
    const temporary = path.join(path.dirname(item.xmp), '.' + path.basename(item.xmp) + '.' + crypto.randomUUID() + '.xmp');
    let ownedTemporary = false;
    try {
      const handle = await fs.open(temporary, 'wx', 0o644);
      ownedTemporary = true;
      try { await handle.writeFile(renderXmp(item.target)); await handle.sync(); } finally { await handle.close(); }
      if (!xmpFields(await read(temporary)).every((value) => value === item.target)) throw new Error('temporary_xmp_not_verified');
      if (!sameFile(item.stat, await safePath(item.file, roots)) || await digest(item.file) !== item.originalSha256) {
        throw new Conflict('original_changed');
      }
      // 原子创建，文件同时出现时失败，不覆盖他人的旁车。
      await fs.link(temporary, item.xmp);
      item.status = 'created';
      const dir = await fs.open(path.dirname(item.xmp), 'r');
      try { await dir.sync(); } finally { await dir.close(); }
      if (!xmpFields(await read(item.xmp)).every((value) => value === item.target)) throw new Error('xmp_not_verified');
      item.originalUnchanged = await digest(item.file) === item.originalSha256;
      if (!item.originalUnchanged) throw new Conflict('original_changed_after_write');
      await save();
    } catch (error) {
      item.error = error.message;
      await save();
      throw error;
    } finally { if (ownedTemporary) await fs.unlink(temporary).catch(() => {}); }
  }
  return { audit, plans };
}
async function main() {
  const args = process.argv.slice(2);
  const option = (name) => { const at = args.indexOf(name); if (at < 0) throw new Error('missing_' + name); return args.splice(at, 2)[1]; };
  const root = option('--root'), auditDir = option('--audit-dir');
  const apply = args.includes('--apply');
  const files = args.filter((value) => value !== '--apply');
  if (!files.length) throw new Error('explicit_files_required');
  const cfg = JSON.parse(await fs.readFile(process.env.SONY_LOOK_CONFIG || '/run/secrets/config.json', 'utf8'));
  const tool = cfg.exiftool ?? '/usr/src/app/server/node_modules/.pnpm/node_modules/.bin/exiftool';
  const result = await prepare({ files, roots: [root], profiles: cfg.customProfiles ?? [], read: (file) => exif(file, tool), auditDir, apply });
  console.log(JSON.stringify(result, null, 2));
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { prepare, renderXmp };
