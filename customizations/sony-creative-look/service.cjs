'use strict';
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { Store } = require('./store.cjs');
const { Processor, Conflict, Skip, VERSION, exif, inScope, sleep, validateProfiles, retryableCustomSkip } = require('./core.cjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
function config() {
  const value = JSON.parse(fs.readFileSync(process.env.SONY_LOOK_CONFIG || '/run/secrets/config.json', 'utf8'));
  if (!value.apiUrl || !value.apiKey || !value.webhookSecret || !value.ownerId || !Array.isArray(value.roots)) throw new Error('invalid_config');
  value.exiftool ??= '/usr/src/app/server/node_modules/.pnpm/node_modules/.bin/exiftool';
  value.stateDir ??= '/state';
  if (!Number.isFinite(Date.parse(value.enabledAt))) throw new Error('enabled_at_required');
  value.customProfiles = validateProfiles(value.customProfiles ?? []);
  return value;
}
function makeApi(cfg) {
  return async (method, route, body) => {
    const response = await fetch(cfg.apiUrl.replace(/\/$/, '') + route, {
      method, headers: { 'x-api-key': cfg.apiKey, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      if (response.status === 404) throw new Skip('asset_not_found');
      throw new Error('immich_http_' + response.status);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
}
function authenticate(header, expected) {
  const actual = Buffer.from(String(header ?? ''));
  const secret = Buffer.from(expected);
  return actual.length === secret.length && crypto.timingSafeEqual(actual, secret);
}
function scanQuery(scan) {
  const filter = { type: { eq: 'IMAGE' }, isOffline: { eq: false }, trashedAt: { eq: null } };
  if (scan.spec.kind === 'backfill') {
    filter.takenAt = {
      gte: new Date(Date.parse(scan.spec.from) - 2 * 86400_000).toISOString(),
      lt: new Date(Date.parse(scan.spec.to) + 2 * 86400_000).toISOString(),
    };
    filter.model = { eq: 'ILCE-7CM2' };
  } else {
    filter.createdAt = { gte: scan.spec.from, lt: scan.spec.to };
  }
  return { filter, withExif: true, size: 200, ...(scan.cursor ? { cursor: scan.cursor } : {}) };
}
function log(event, details = {}) { console.log(JSON.stringify({ at: new Date().toISOString(), event, ...details })); }
async function serve(cfg, store, api) {
  let stopping = false;
  const processor = new Processor({ api, roots: cfg.roots, ownerId: cfg.ownerId, customProfiles: cfg.customProfiles,
    read: (file) => exif(file, cfg.exiftool),
    saveIntent: (id, intent) => store.saveIntent(id, intent) });
  const server = http.createServer(async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/health' && req.method === 'GET') return send(200, { ok: !stopping, ruleVersion: VERSION });
    if (!authenticate(req.headers['x-sony-look-key'], cfg.webhookSecret)) return send(401, { error: 'unauthorized' });
    if (req.url === '/status' && req.method === 'GET') return send(200, store.status());
    if (req.url !== '/webhook' || req.method !== 'POST') return send(404, { error: 'not_found' });
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 128 * 1024) return send(413, { error: 'large_body' });
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const asset = payload.data?.asset;
      if (payload.trigger !== 'AssetMetadataExtraction' || !UUID.test(asset?.id ?? '') || asset.ownerId !== cfg.ownerId) {
        return send(400, { error: 'invalid_event' });
      }
      if (asset.type !== 'IMAGE' || !inScope(asset, { kind: 'auto', from: cfg.enabledAt })) return send(200, { skipped: true });
      store.enqueue(asset.id, { kind: 'auto', from: cfg.enabledAt });
      send(202, { accepted: true, assetId: asset.id });
    } catch { send(400, { error: 'invalid_payload' }); }
  });
  server.requestTimeout = 15_000;
  server.listen(cfg.port ?? 8787, '0.0.0.0');
  const work = async () => {
    while (!stopping) {
      if (store.get('paused')) { await sleep(500); continue; }
      const job = store.next();
      if (!job) { await sleep(300); continue; }
      try {
        const result = await processor.process(job);
        store.finish(job, 'done');
        log('done', { assetId: job.id, code: result.code });
      } catch (error) {
        const state = error instanceof Conflict ? 'conflict' : error instanceof Skip ? 'skipped' : job.attempts >= 8 ? 'failed' : 'retry';
        const reason = String(error.message).slice(0, 200);
        store.finish(job, state, reason);
        log(state, { assetId: job.id, reason });
      }
    }
  };
  const scan = async () => {
    let lastAuto = 0;
    while (!stopping) {
      if (store.get('paused')) { await sleep(500); continue; }
      try {
        let task = store.nextScan();
        if (!task && Date.now() - lastAuto > 300_000) {
          const previous = store.get('cursor') ?? cfg.enabledAt;
          const from = new Date(Math.max(Date.parse(cfg.enabledAt), Date.parse(previous) - 600_000)).toISOString();
          const to = new Date().toISOString();
          store.addScan('auto-' + crypto.randomUUID(), { kind: 'auto', from, to });
          task = store.nextScan(); lastAuto = Date.now();
        }
        if (task) {
          const response = await api('POST', '/search/metadata', scanQuery(task));
          const assets = response.assets.items.filter((asset) => inScope(asset, task.spec));
          store.page(task, assets, response.assets.nextCursor);
          if (!response.assets.nextCursor) log('scan_complete', { scan: task.id, count: task.count + assets.length });
          await sleep(250);
        } else await sleep(1000);
      } catch (error) {
        const task = store.nextScan();
        if (task) store.db.prepare('UPDATE scans SET error=? WHERE id=?').run(String(error.message).slice(0, 200), task.id);
        log('scan_retry', { reason: String(error.message).slice(0, 200) });
        await sleep(15_000);
      }
    }
  };
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopping = true; server.close(); });
  log('started', { ruleVersion: VERSION, enabledAt: cfg.enabledAt });
  await Promise.all([work(), scan()]);
  store.close();
}
async function main() {
  const cfg = config();
  fs.mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  const store = new Store(path.join(cfg.stateDir, 'state.sqlite'));
  const api = makeApi(cfg);
  const [command = 'serve', arg, end] = process.argv.slice(2);
  if (command === 'serve') return serve(cfg, store, api);
  try {
    if (command === 'status') console.log(JSON.stringify(store.status(arg), null, 2));
    else if (command === 'pause' || command === 'resume') { store.set('paused', command === 'pause'); log(command); }
    else if (command === 'backfill') {
      if (!DAY.test(arg ?? '') || !DAY.test(end ?? '') || arg >= end) throw new Error('expected from and exclusive to YYYY-MM-DD');
      const id = 'backfill-' + arg + '-' + end + '-' + crypto.randomUUID().slice(0, 8);
      store.addScan(id, { kind: 'backfill', from: arg, to: end }); log('backfill_queued', { id });
    } else if (command === 'enqueue') {
      if (!UUID.test(arg ?? '')) throw new Error('invalid_asset_id');
      store.enqueue(arg, { kind: 'explicit' });
      log('queued', { assetId: arg });
    } else if (command === 'retry') {
      if (!UUID.test(arg ?? '')) throw new Error('invalid_asset_id');
      const result = store.db.prepare("UPDATE jobs SET state='pending',attempts=0,next=0 WHERE id=? AND state IN ('failed','retry')").run(arg);
      log('retry_queued', { assetId: arg, count: result.changes });
    } else if (command === 'retry-custom') {
      // 仅重试未发生写入的自订识别跳过项；done、人工冲突及其他跳过原因不变。
      const rows = store.db.prepare("SELECT id,reason FROM jobs WHERE state='skipped' AND intent IS NULL").all();
      const update = store.db.prepare("UPDATE jobs SET state='pending',attempts=0,next=0,reason=NULL WHERE id=? AND state='skipped' AND intent IS NULL");
      let count = 0;
      for (const row of rows) if (retryableCustomSkip(row.reason)) count += update.run(row.id).changes;
      log('custom_retry_queued', { count });
    } else throw new Error('unknown_command');
  } finally { store.close(); }
}
if (require.main === module) main().catch((error) => { log('fatal', { reason: error.message }); process.exitCode = 1; });
module.exports = { authenticate, scanQuery, makeApi, serve };
