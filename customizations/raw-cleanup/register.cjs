'use strict';

// NODE_OPTIONS 预加载适配器。保留 Immich 装饰器元数据，不覆盖镜像中的文件。
const Module = require('node:module');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { PairCleanup, atomicJson } = require('./cleanup.cjs');
const configPath = process.env.IMMICH_RAW_CLEANUP_CONFIG || '/opt/immich-raw-cleanup/config.json';
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const target = '/usr/src/app/server/dist/services/storage.service.js';
const actualHash = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
if (actualHash !== config.storageServiceSha256) {
  // 升级改变了删除接口时，不在未经验证的新版本上执行额外删除。
  console.error('[RawPairCleanup] DISABLED: Immich 删除实现已改变，需要重新验证适配器');
  fs.writeFileSync(`${config.stateDirectory}/health.json`, JSON.stringify({ status: 'incompatible', actualHash }));
} else {
  const load = Module._load;
  Module._load = function (request, parent, isMain) {
    const exported = load.apply(this, arguments);
    if (Module._resolveFilename(request, parent, isMain) !== target) return exported;
    Module._load = load;
    const proto = exported.StorageService.prototype;
    const engines = new WeakMap();
    function replace(name, factory) {
      const original = proto[name];
      const wrapped = factory(original);
      Object.defineProperty(wrapped, 'name', { value: original.name });
      for (const key of Reflect.getMetadataKeys(original)) {
        Reflect.defineMetadata(key, Reflect.getMetadata(key, original), wrapped);
      }
      proto[name] = wrapped;
    }
    function engine(service) {
      if (!engines.has(service)) {
        engines.set(service, new PairCleanup(config, {
          isTracked: async (paths) => Boolean(await service.assetRepository.db.selectFrom('asset')
            .select('id').where('originalPath', 'in', paths).executeTakeFirst()),
          log: (line) => service.logger.log(line),
        }));
      }
      return engines.get(service);
    }
    replace('onBootstrap', (original) => async function (...args) {
      const result = await original.apply(this, args);
      if (this.worker === 'microservices') {
        const cleanup = engine(this);
        await cleanup.init();
        const replay = async () => {
          try {
            const pending = await cleanup.replay();
            await atomicJson(`${config.stateDirectory}/health.json`, {
              status: 'ready', checkedAt: new Date().toISOString(), pending, storageServiceSha256: actualHash,
            });
          } catch (error) { this.logger.error(`[RawPairCleanup] 重试任务失败: ${error.message}`); }
        };
        await replay();
        const timer = setInterval(replay, 60000);
        timer.unref();
        this.logger.log('[RawPairCleanup] 配对删除已启用：JPG/JPEG → 同目录同名 ARW/CR2');
      }
      return result;
    });
    replace('handleDeleteFiles', (original) => async function (job) {
      const cleanup = engine(this);
      await cleanup.init();
      return cleanup.process(job.files, () => original.call(this, job));
    });
    return exported;
  };
}
