'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PairCleanup } = require('./cleanup.cjs');

async function fixture(t, tracked = async () => false) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'immich-raw-test-')));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'camera');
  await fs.mkdir(root);
  const config = { roots: [root], rawExtensions: ['.arw', '.cr2'], stateDirectory: path.join(temp, 'state') };
  const cleanup = new PairCleanup(config, { isTracked: tracked, log: () => {} });
  await cleanup.init();
  async function write(name, data = name) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
    return file;
  }
  return { root, temp, config, cleanup, write, jpg: await write('DSC00001.JPG'), raw: await write('DSC00001.ARW') };
}
async function exists(file) {
  try { await fs.lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

test('原生删除完成后只删除同目录同名 RAW，保留其他文件和视频', async (t) => {
  const f = await fixture(t);
  const others = await Promise.all(['other/DSC00001.ARW', 'DSC00002.ARW', 'DSC00001.MP4', 'DSC00001.DNG'].map((name) => f.write(name)));
  const result = await f.cleanup.process([f.jpg], async () => { await fs.unlink(f.jpg); return 'success'; });
  assert.equal(result, 'success');
  assert.equal(await exists(f.raw), false);
  for (const file of others) assert.equal(await exists(file), true);
});

test('进入回收站后恢复：没有原文件删除任务，两份文件保留', async (t) => {
  const f = await fixture(t);
  await f.cleanup.replay();
  assert.equal(await exists(f.jpg), true);
  assert.equal(await exists(f.raw), true);
});

test('JPG 原生删除失败，保留 RAW；恢复后重试补做', async (t) => {
  const f = await fixture(t);
  await f.cleanup.process([f.jpg], async () => 'success');
  await f.cleanup.replay();
  assert.equal(await exists(f.raw), true);
  await fs.unlink(f.jpg);
  const restarted = new PairCleanup(f.config, { isTracked: async () => false, log: () => {} });
  await restarted.init();
  await restarted.replay();
  assert.equal(await exists(f.raw), false);
});

test('RAW 被替换时拒绝旧删除记录，保留新文件', async (t) => {
  const f = await fixture(t);
  await f.cleanup.process([f.jpg], async () => { await fs.unlink(f.jpg); await fs.writeFile(f.raw, 'new raw data'); });
  await f.cleanup.replay();
  assert.equal(await fs.readFile(f.raw, 'utf8'), 'new raw data');
  const receipt = JSON.parse(await fs.readFile(f.cleanup.receiptPath(f.jpg), 'utf8'));
  assert.match(receipt.blocked, /RAW/);
});

test('JPG 被替换后不会在后来消失时自动删除 RAW', async (t) => {
  const f = await fixture(t);
  await f.cleanup.process([f.jpg], async () => fs.writeFile(f.jpg, 'replacement jpeg'));
  await fs.unlink(f.jpg);
  await f.cleanup.replay();
  assert.equal(await exists(f.raw), true);
});

test('RAW 已被 Immich 收录时不绕过 Immich 删除它', async (t) => {
  const f = await fixture(t, async () => true);
  await f.cleanup.process([f.jpg], () => fs.unlink(f.jpg));
  assert.equal(await exists(f.raw), true);
});

test('准备后才被收录的 RAW 也保留', async (t) => {
  let tracked = false;
  const f = await fixture(t, async () => tracked);
  await f.cleanup.process([f.jpg], async () => { await fs.unlink(f.jpg); tracked = true; });
  assert.equal(await exists(f.raw), true);
});

test('扩展名不区分大小写，但文件名主体必须完全匹配', async (t) => {
  const f = await fixture(t);
  const cr2 = await f.write('DSC00001.cR2');
  const different = await f.write('DSC00001-extra.ARW');
  await f.cleanup.process([f.jpg], () => fs.unlink(f.jpg));
  assert.equal(await exists(cr2), false);
  assert.equal(await exists(different), true);
});

test('区分文件名主体大小写（需要区分大小写的文件系统）', async (t) => {
  const f = await fixture(t);
  const different = path.join(f.root, 'dsc00001.ARW');
  if (await exists(different)) return t.skip('当前文件系统不区分大小写；NAS Linux 上执行此场景');
  await fs.writeFile(different, 'another raw');
  await f.cleanup.process([f.jpg], () => fs.unlink(f.jpg));
  assert.equal(await exists(different), true);
});

test('还有同名 JPEG 时保留 RAW；最后一份删除后才清理', async (t) => {
  const f = await fixture(t);
  const second = await f.write('DSC00001.jpeg');
  await f.cleanup.process([f.jpg], () => fs.unlink(f.jpg));
  assert.equal(await exists(f.raw), true);
  await f.cleanup.process([second], () => fs.unlink(second));
  assert.equal(await exists(f.raw), false);
  await f.cleanup.replay();
});

test('不跟随 RAW 符号链接', async (t) => {
  const f = await fixture(t);
  const target = await f.write('outside.ARW');
  await fs.unlink(f.raw);
  await fs.symlink(target, f.raw);
  await f.cleanup.process([f.jpg], () => fs.unlink(f.jpg));
  assert.equal(await exists(target), true);
  assert.equal(await exists(f.raw), true);
});

test('不跟随目录符号链接，也不删除 JPG', async (t) => {
  const f = await fixture(t);
  await fs.symlink(f.root, path.join(f.root, 'link'));
  await assert.rejects(f.cleanup.process([path.join(f.root, 'link', 'DSC00001.JPG')], () => fs.unlink(f.jpg)), /符号链接/);
  assert.equal(await exists(f.jpg), true);
  assert.equal(await exists(f.raw), true);
});

test('范围外、历史孤立 RAW 和重复删除任务均不会触发额外删除', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.temp, 'DSC00001.JPG');
  await fs.writeFile(outside, 'jpg');
  await f.cleanup.process([outside], () => fs.unlink(outside));
  await fs.unlink(f.jpg);
  await f.cleanup.process([f.jpg], async () => 'success');
  await f.cleanup.replay();
  assert.equal(await exists(f.raw), true);
});

test('数据库检查失败时不删除 JPG/RAW，避免未核对便执行', async (t) => {
  const f = await fixture(t, async () => { throw new Error('db unavailable'); });
  await assert.rejects(f.cleanup.process([f.jpg], () => fs.unlink(f.jpg)), /db unavailable/);
  assert.equal(await exists(f.jpg), true);
  assert.equal(await exists(f.raw), true);
});

test('任务中途崩溃后，可从持久记录恢复清理', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.cleanup.process([f.jpg], async () => { await fs.unlink(f.jpg); throw new Error('crash'); }), /crash/);
  assert.equal(await exists(f.raw), true);
  await f.cleanup.replay();
  assert.equal(await exists(f.raw), false);
  assert.equal(await exists(f.cleanup.receiptPath(f.jpg)), false);
});
