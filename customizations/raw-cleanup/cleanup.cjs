'use strict';

// 只接收 Immich 已发出的原文件删除任务；不按“找不到 JPG”扫描媒体库。
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const jpeg = (name) => ['.jpg', '.jpeg'].includes(path.extname(name).toLowerCase());
const stem = (name) => path.basename(name, path.extname(name));
const identity = (s) => Object.fromEntries(
  ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map((key) => [key, String(s[key])]),
);
const same = (a, b) => Object.keys(a).every((key) => a[key] === b[key]);
async function stat(file) {
  try { return await fs.lstat(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function atomicJson(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temp, file);
  const dir = await fs.open(path.dirname(file), 'r');
  try { await dir.sync(); } finally { await dir.close(); }
}

class PairCleanup {
  constructor(config, { isTracked, log = console.log } = {}) {
    this.roots = config.roots.map((root) => path.resolve(root));
    this.extensions = new Set(config.rawExtensions.map((ext) => ext.toLowerCase()));
    if (!this.roots.length || this.roots.includes('/') ||
        [...this.extensions].some((ext) => !['.arw', '.cr2'].includes(ext))) {
      throw new Error('必须显式配置相机目录；仅支持已排除的 ARW、CR2');
    }
    if (typeof isTracked !== 'function') throw new Error('缺少 RAW 入库检查');
    this.state = path.resolve(config.stateDirectory);
    this.isTracked = isTracked;
    this.log = log;
    this.serial = Promise.resolve();
  }

  allows(file) {
    return typeof file === 'string' && path.isAbsolute(file) && path.normalize(file) === file &&
      this.roots.some((root) => file.startsWith(`${root}/`));
  }

  async init() {
    await fs.mkdir(path.join(this.state, 'pending'), { recursive: true, mode: 0o700 });
  }

  exclusive(fn) {
    const result = this.serial.then(fn);
    this.serial = result.catch(() => {});
    return result;
  }

  async audit(event, fields) {
    const entry = { at: new Date().toISOString(), event, ...fields };
    this.log(`[RawPairCleanup] ${JSON.stringify(entry)}`);
    await fs.appendFile(path.join(this.state, 'audit.jsonl'), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  receiptPath(file) {
    return path.join(this.state, 'pending', `${crypto.createHash('sha256').update(file).digest('hex')}.json`);
  }

  async parent(file) {
    const parent = path.dirname(file);
    if (await fs.realpath(parent) !== parent) throw new Error(`拒绝符号链接目录: ${parent}`);
    const s = await stat(parent);
    if (!s?.isDirectory()) throw new Error(`目录不可用: ${parent}`);
    return { dev: String(s.dev), ino: String(s.ino) };
  }

  async prepare(file) {
    if (!this.allows(file) || !jpeg(file)) return null;
    const source = await stat(file);
    if (!source?.isFile()) return null;
    const parent = await this.parent(file);
    const candidates = [];
    for (const name of await fs.readdir(path.dirname(file))) {
      if (stem(name) !== stem(file) || !this.extensions.has(path.extname(name).toLowerCase())) continue;
      const raw = path.join(path.dirname(file), name);
      const s = await stat(raw);
      if (s?.isFile()) candidates.push({ path: raw, identity: identity(s) });
    }
    if (!candidates.length) return null;
    if (await this.isTracked(candidates.map((raw) => raw.path))) {
      await this.audit('skipped_tracked_raw', { jpeg: file });
      return null;
    }
    const receipt = { version: 1, jpeg: file, source: identity(source), parent, raw: candidates };
    // 先落盘删除意图，再让 Immich 删除 JPG，以便重启后补做 RAW 删除。
    await atomicJson(this.receiptPath(file), receipt);
    return receipt;
  }

  async block(receipt, reason) {
    receipt.blocked = reason;
    await atomicJson(this.receiptPath(receipt.jpeg), receipt);
    await this.audit('blocked', { jpeg: receipt.jpeg, reason });
  }

  async finish(receipt) {
    if (receipt.blocked) return;
    if (receipt.version !== 1 || !this.allows(receipt.jpeg) || !jpeg(receipt.jpeg) ||
        !Array.isArray(receipt.raw) || !receipt.raw.length || receipt.raw.some((raw) =>
          !this.allows(raw.path) || path.dirname(raw.path) !== path.dirname(receipt.jpeg) ||
          stem(raw.path) !== stem(receipt.jpeg) || !this.extensions.has(path.extname(raw.path).toLowerCase()))) {
      throw new Error('删除记录不符合配对范围');
    }
    if (!same(receipt.parent, await this.parent(receipt.jpeg))) {
      return this.block(receipt, '目录已经更换');
    }
    const source = await stat(receipt.jpeg);
    if (source) {
      if (!source.isFile() || !same(receipt.source, identity(source))) {
        return this.block(receipt, 'JPG 已被替换');
      }
      return; // 原生删除失败时，RAW 必须保留。
    }
    const siblings = await fs.readdir(path.dirname(receipt.jpeg));
    if (siblings.some((name) => jpeg(name) && stem(name) === stem(receipt.jpeg))) return;
    if (await this.isTracked(receipt.raw.map((raw) => raw.path))) {
      return this.block(receipt, 'RAW 已经被 Immich 收录');
    }
    for (const raw of receipt.raw) {
      const s = await stat(raw.path);
      if (s && (!s.isFile() || !same(raw.identity, identity(s)))) {
        return this.block(receipt, 'RAW 已被替换或修改');
      }
    }
    for (const raw of receipt.raw) {
      // 在 unlink 前再次核对目录和文件，避免重试时误删后来替换的文件。
      if (!same(receipt.parent, await this.parent(raw.path))) throw new Error('目录发生变化');
      const s = await stat(raw.path);
      if (!s) continue;
      if (!s.isFile() || !same(raw.identity, identity(s))) return this.block(receipt, 'RAW 删除前发生变化');
      try { await fs.unlink(raw.path); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await this.audit('raw_deleted', { jpeg: receipt.jpeg, raw: raw.path });
    }
    await fs.rm(this.receiptPath(receipt.jpeg), { force: true });
  }

  async process(files, removeOriginals) {
    if (!files.some((file) => this.allows(file) && jpeg(file))) return removeOriginals();
    return this.exclusive(async () => {
      const receipts = [];
      for (const file of files) {
        const receipt = await this.prepare(file);
        if (receipt) receipts.push(receipt);
      }
      const result = await removeOriginals();
      for (const receipt of receipts) {
        try { await this.finish(receipt); }
        catch (error) { await this.audit('retry_pending', { jpeg: receipt.jpeg, error: error.message }); }
      }
      return result;
    });
  }

  async replay() {
    return this.exclusive(async () => {
      const names = (await fs.readdir(path.join(this.state, 'pending'))).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
      for (const name of names) {
        try {
          const receipt = JSON.parse(await fs.readFile(path.join(this.state, 'pending', name), 'utf8'));
          if (path.basename(this.receiptPath(receipt.jpeg)) !== name) throw new Error('删除记录路径不匹配');
          await this.finish(receipt);
        } catch (error) { await this.audit('retry_error', { receipt: name, error: error.message }); }
      }
      return names.length;
    });
  }
}

module.exports = { PairCleanup, atomicJson };
