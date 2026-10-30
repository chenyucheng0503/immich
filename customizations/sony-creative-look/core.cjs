'use strict';
// 原片只读；描述和旁车统一交给 Immich 写入。
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const VERSION = 'sony-standard-v1';
const aliases = [
  ['ST', 'Standard'], ['PT', 'Portrait'], ['NT', 'Neutral'], ['VV', 'Vivid'],
  ['VV2', 'Vivid 2'], ['FL', 'Film'], ['IN', 'Instant'], ['SH', 'Soft Highkey'],
  ['BW', 'B&W', 'Black & White'], ['SE', 'Sepia'],
];
const normalize = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const names = new Map(aliases.flatMap(([code, ...values]) => [code, ...values].map((v) => [normalize(v), code])));
const lookCode = (value) => names.get(normalize(value)) ?? null;
class Conflict extends Error {}
class Skip extends Error {}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const description = (asset) => asset.exifInfo?.description ?? '';
function mergeDescription(before, code) {
  if (!before.trim()) return code;
  const whole = lookCode(before);
  if (whole === code) return code;
  if (whole) throw new Conflict('existing_different_look');
  const lookLines = before.split(/\r?\n/).map(lookCode).filter(Boolean);
  if (lookLines.some((value) => value !== code)) throw new Conflict('existing_different_look_line');
  if (lookLines.includes(code)) return before;
  return before + (before.endsWith('\n') ? '' : '\n') + code;
}
const localDay = (asset) => String(asset.localDateTime ?? '').slice(0, 10);
function inScope(asset, scope) {
  if (!scope || scope.kind === 'explicit') return true;
  if (scope.kind === 'backfill') {
    const day = localDay(asset);
    return /^\d{4}-\d{2}-\d{2}$/.test(day) && day >= scope.from && day < scope.to;
  }
  return Date.parse(asset.createdAt) >= Date.parse(scope.from);
}
async function safePath(file, roots) {
  if (!path.isAbsolute(file) || path.normalize(file) !== file) throw new Conflict('invalid_path');
  if (!roots.some((root) => file.startsWith(root + path.sep))) throw new Conflict('outside_media_roots');
  if (await fs.realpath(file) !== file) throw new Conflict('symlink_path');
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Conflict('not_regular_file');
  return { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
}
const sameFile = (a, b) => a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
async function exif(file, executable) {
  const result = await run(executable, [
    '-json', '-G1', '-s', '-Make', '-Model', '-Sony:CreativeStyle',
    '-XMP-dc:Description*', '-XMP-tiff:ImageDescription', file,
  ], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
  const tags = JSON.parse(result.stdout)[0];
  if (!tags || tags.Error) throw new Error('exif_read_failed');
  return tags;
}
async function exists(file) {
  try { await fs.lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
async function sidecarPath(original) {
  const parsed = path.parse(original);
  const full = original + '.xmp';
  const short = path.join(parsed.dir, parsed.name + '.xmp');
  const entries = await fs.readdir(parsed.dir);
  const present = [];
  for (const file of [full, short]) if (await exists(file)) present.push(file);
  if (present.length > 1 || entries.includes(parsed.base + '.XMP') || entries.includes(parsed.name + '.XMP')) {
    throw new Conflict('ambiguous_sidecars');
  }
  if (present[0] === short) {
    const siblings = entries.filter((name) =>
      path.parse(name).name === parsed.name && /\.(jpe?g|arw|hif|heic)$/i.test(name));
    if (siblings.length > 1) throw new Conflict('shared_raw_jpeg_sidecar');
  }
  return present[0] ?? full;
}
const xmpFields = (tags) => [tags['XMP-dc:Description'] ?? tags['XMP-dc:Description-x-default'], tags['XMP-tiff:ImageDescription']];
async function snapshotXmp(file, roots, read) {
  if (!await exists(file)) return null;
  const stat = await safePath(file, roots);
  if (stat.size > 4 * 1024 * 1024) throw new Conflict('large_sidecar');
  const raw = await fs.readFile(file);
  const languages = [...raw.toString('utf8').matchAll(/xml:lang\s*=\s*["']([^"']+)["']/g)];
  if (languages.some((match) => match[1] !== 'x-default')) throw new Conflict('multilingual_sidecar');
  const [dc, tiff] = xmpFields(await read(file));
  if (dc !== undefined && tiff !== undefined && dc !== tiff) throw new Conflict('sidecar_description_conflict');
  return { base64: raw.toString('base64'), dc, tiff };
}
class Processor {
  constructor({ api, roots, ownerId, read, saveIntent, delays = [150, 350, 750, 1500, 3000] }) {
    Object.assign(this, { api, roots, ownerId, read, saveIntent, delays });
  }
  async process(job) {
    let asset = await this.api('GET', '/assets/' + job.id);
    if (this.ownerId && asset.ownerId !== this.ownerId) throw new Skip('different_owner');
    if (asset.type !== 'IMAGE' || asset.isTrashed || asset.deletedAt || asset.visibility === 'locked') throw new Skip('not_active_image');
    if (!inScope(asset, job.scope)) throw new Skip('outside_scope');
    if (asset.isOffline) throw new Error('asset_offline');
    if (!asset.hasMetadata || !asset.exifInfo) throw new Error('metadata_not_ready');
    if (asset.exifInfo.model !== 'ILCE-7CM2') throw new Skip('different_camera');
    const file = asset.originalPath;
    const beforeStat = await safePath(file, this.roots);
    let intent = job.intent;
    if (!intent) {
      const tags = await this.read(file);
      if (tags['IFD0:Model'] !== 'ILCE-7CM2' || !/^sony$/i.test(tags['IFD0:Make'] ?? '')) throw new Skip('original_camera_mismatch');
      const rawLook = tags['Sony:CreativeStyle'];
      const code = lookCode(rawLook);
      if (!code) throw new Skip('unknown_or_custom_look:' + String(rawLook ?? 'missing').slice(0, 80));
      const target = mergeDescription(description(asset), code);
      const xmp = await sidecarPath(file);
      const previousXmp = await snapshotXmp(xmp, this.roots, this.read);
      for (const value of [previousXmp?.dc, previousXmp?.tiff]) {
        if (value !== undefined && value !== description(asset) && value !== target) throw new Conflict('disk_database_description_conflict');
      }
      intent = {
        file, stat: beforeStat, checksum: asset.checksum, old: description(asset), target, code,
        rawLook, xmp, previousXmp, ruleVersion: VERSION, preparedAt: new Date().toISOString(),
      };
      await this.saveIntent(job.id, intent);
    }
    if (intent.file !== file || intent.checksum !== asset.checksum || !sameFile(intent.stat, beforeStat)) throw new Conflict('original_changed');
    if (await sidecarPath(file) !== intent.xmp) throw new Conflict('sidecar_path_changed');
    const check = async () => {
      if (!await exists(intent.xmp)) return false;
      await safePath(intent.xmp, this.roots);
      if (!xmpFields(await this.read(intent.xmp)).every((v) => v === intent.target)) return false;
      asset = await this.api('GET', '/assets/' + job.id);
      return description(asset) === intent.target;
    };
    asset = await this.api('GET', '/assets/' + job.id);
    if (![intent.old, intent.target].includes(description(asset))) throw new Conflict('manual_description_change');
    if (asset.originalPath !== file || asset.checksum !== intent.checksum || asset.isTrashed || asset.deletedAt) throw new Conflict('asset_changed_before_write');
    if (!sameFile(beforeStat, await safePath(file, this.roots))) throw new Conflict('original_changed_before_write');
    if (await check()) return intent;
    const currentXmp = await snapshotXmp(intent.xmp, this.roots, this.read);
    if (currentXmp && currentXmp.base64 !== intent.previousXmp?.base64 &&
        ![currentXmp.dc, currentXmp.tiff].every((v) => v === undefined || v === intent.target)) {
      throw new Conflict('sidecar_changed_before_write');
    }
    // intent 已落盘，API 超时或进程崩溃后先回读再重试。
    await this.api('PUT', '/assets', { ids: [job.id], description: intent.target });
    for (const delay of this.delays) {
      await sleep(delay);
      if (await check()) {
        if (!sameFile(beforeStat, await safePath(file, this.roots))) throw new Conflict('original_changed_after_write');
        return intent;
      }
      if (![intent.old, intent.target].includes(description(asset))) throw new Conflict('manual_description_change');
    }
    throw new Error('xmp_write_not_verified');
  }
}
module.exports = { VERSION, lookCode, mergeDescription, localDay, inScope, safePath, sameFile, exif, sidecarPath,
  snapshotXmp, xmpFields, Processor, Conflict, Skip, sleep };
