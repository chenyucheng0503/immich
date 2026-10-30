'use strict';
const { DatabaseSync } = require('node:sqlite');
class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec([
      'PRAGMA journal_mode=WAL', 'PRAGMA busy_timeout=5000',
      'CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, scope TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next REAL NOT NULL DEFAULT 0, intent TEXT, reason TEXT, updated TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS scans(id TEXT PRIMARY KEY, spec TEXT NOT NULL, cursor TEXT, state TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, error TEXT)',
      'CREATE TABLE IF NOT EXISTS scan_jobs(scan TEXT NOT NULL, asset TEXT NOT NULL, PRIMARY KEY(scan,asset))',
      'CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    ].join(';'));
  }
  enqueue(id, scope, scan = null) {
    this.db.prepare("INSERT OR IGNORE INTO jobs(id,scope,state,updated) VALUES(?,?,'pending',?)").run(id, JSON.stringify(scope), new Date().toISOString());
    if (scan) this.db.prepare('INSERT OR IGNORE INTO scan_jobs(scan,asset) VALUES(?,?)').run(scan, id);
  }
  next() {
    const row = this.db.prepare("SELECT * FROM jobs WHERE state IN ('pending','retry','processing') AND next<=? ORDER BY updated LIMIT 1").get(Date.now());
    if (!row) return null;
    this.db.prepare("UPDATE jobs SET state='processing',attempts=attempts+1,updated=? WHERE id=?").run(new Date().toISOString(), row.id);
    return { ...row, attempts: row.attempts + 1, scope: JSON.parse(row.scope), intent: row.intent ? JSON.parse(row.intent) : null };
  }
  saveIntent(id, intent) { this.db.prepare('UPDATE jobs SET intent=? WHERE id=?').run(JSON.stringify(intent), id); }
  finish(job, state, reason = null) {
    const next = state === 'retry' ? Date.now() + Math.min(900_000, 30_000 * 2 ** (job.attempts - 1)) : 0;
    this.db.prepare('UPDATE jobs SET state=?,reason=?,next=?,updated=? WHERE id=?').run(state, reason, next, new Date().toISOString(), job.id);
  }
  set(key, value) { this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key, JSON.stringify(value)); }
  get(key) { const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; }
  addScan(id, spec) { this.db.prepare("INSERT INTO scans(id,spec,state) VALUES(?,?,'pending')").run(id, JSON.stringify(spec)); }
  nextScan() {
    const row = this.db.prepare("SELECT * FROM scans WHERE state='pending' ORDER BY rowid LIMIT 1").get();
    return row ? { ...row, spec: JSON.parse(row.spec) } : null;
  }
  page(scan, assets, cursor) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const asset of assets) this.enqueue(asset.id, scan.spec, scan.id);
      this.db.prepare('UPDATE scans SET cursor=?,state=?,count=count+?,error=NULL WHERE id=?')
        .run(cursor, cursor ? 'pending' : 'complete', assets.length, scan.id);
      if (!cursor && scan.spec.kind === 'auto') this.set('cursor', scan.spec.to);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  status(scan = null) {
    const counts = scan
      ? this.db.prepare('SELECT j.state,count(*) AS count FROM jobs j JOIN scan_jobs s ON s.asset=j.id WHERE s.scan=? GROUP BY j.state').all(scan)
      : this.db.prepare('SELECT state,count(*) AS count FROM jobs GROUP BY state').all();
    return {
      counts,
      scans: this.db.prepare('SELECT id,spec,state,count,error FROM scans ORDER BY rowid DESC LIMIT 6').all(),
      problems: this.db.prepare("SELECT reason,count(*) AS count FROM jobs WHERE state IN ('failed','conflict','skipped','retry') GROUP BY reason").all(),
    };
  }
  close() { this.db.close(); }
}
module.exports = { Store };
