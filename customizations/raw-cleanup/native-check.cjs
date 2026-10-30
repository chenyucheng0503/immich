'use strict';
// 在目标 Immich 镜像内运行；只使用 /tmp 生成文件和仓库替身，不连接数据库。
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
  const root = await fs.mkdtemp('/tmp/raw-pair-native-');
  try {
    const config = JSON.parse(await fs.readFile(path.join(__dirname, 'config.json'), 'utf8'));
    config.roots = [root];
    config.stateDirectory = path.join(root, 'state');
    const configPath = path.join(root, 'config.json');
    await fs.writeFile(configPath, JSON.stringify(config));
    process.env.IMMICH_RAW_CLEANUP_CONFIG = configPath;
    require('/usr/src/app/server/node_modules/reflect-metadata');
    require('./register.cjs');
    const { StorageService } = require('/usr/src/app/server/dist/services/storage.service.js');
    const { MetadataKey, JobName, JobStatus } = require('/usr/src/app/server/dist/enum.js');
    assert.equal(Reflect.getMetadata(MetadataKey.JobConfig, StorageService.prototype.handleDeleteFiles).name, JobName.FileDelete);
    assert.ok(Reflect.getMetadataKeys(StorageService.prototype.onBootstrap).length > 0);
    const service = Object.create(StorageService.prototype);
    service.logger = { log() {}, warn() {} };
    service.storageRepository = { unlink: (file) => fs.unlink(file) };
    const db = { selectFrom() { return this; }, select() { return this; }, where() { return this; }, async executeTakeFirst() {} };
    service.assetRepository = { db };
    const jpg = path.join(root, 'TEST.JPG');
    const raw = path.join(root, 'TEST.ARW');
    await fs.writeFile(jpg, 'generated jpeg fixture');
    await fs.writeFile(raw, 'generated raw fixture');
    assert.equal(await service.handleDeleteFiles({ files: [jpg] }), JobStatus.Success);
    await assert.rejects(fs.stat(jpg), { code: 'ENOENT' });
    await assert.rejects(fs.stat(raw), { code: 'ENOENT' });
    console.log('PASS: 原生 FileDelete 处理器、装饰器元数据、JPG/RAW 实际删除');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
