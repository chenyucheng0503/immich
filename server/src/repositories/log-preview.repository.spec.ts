import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logPreviewDefaults } from 'src/dtos/log-preview.dto';
import { LogPlan, LogPreviewRepository } from 'src/repositories/log-preview.repository';

const cube = `LUT_3D_SIZE 2\n${Array.from({ length: 8 }, (_, i) => `${i & 1} ${(i >> 1) & 1} ${(i >> 2) & 1}`).join('\n')}`;
const id = '00000000-0000-4000-8000-000000000001';

describe('Log 预览持久化', () => {
  let root: string;
  let repository: LogPreviewRepository;
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'immich-log-preview-test-'));
    vi.stubEnv('IMMICH_LOG_PREVIEW_DIR', root);
    repository = new LogPreviewRepository();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });
  it('导入后按内容校验读取，不允许改写为另一种输入类型', async () => {
    const lut = await repository.uploadLut({ name: 'Sony', profile: 'sony-slog3-cine', content: cube });
    const loaded = await repository.getLut(lut.id);
    expect(loaded.lut.name).toBe('Sony');
    await expect(repository.uploadLut({ name: 'DJI', profile: 'dji-dlog-m', content: cube })).rejects.toThrow(
      '其他输入类型',
    );
    await fs.writeFile(join(root, 'luts', `${lut.id}.cube`), cube + '\n# changed');
    await expect(repository.getLut(lut.id)).rejects.toThrow('校验失败');
  });
  it('拒绝规则与 LUT 输入不匹配，关闭功能无需读取原片', async () => {
    const lut = await repository.uploadLut({ name: 'Sony', profile: 'sony-slog3-cine', content: cube });
    await expect(
      repository.validateConfig({ enabled: true, rules: [{ model: '', profile: 'dji-dlog-m', lutId: lut.id }] }),
    ).rejects.toThrow('不匹配');
    await expect(
      repository.resolve({ id, originalPath: '/does-not-exist' }, logPreviewDefaults),
    ).resolves.toBeUndefined();
  });
  it('新版排队后，旧任务完成不能覆盖新版状态', async () => {
    const lut = await repository.uploadLut({ name: 'Sony', profile: 'sony-slog3-cine', content: cube });
    const plan: LogPlan = {
      lut,
      path: join(root, 'luts', `${lut.id}.cube`),
      revision: 'new',
      profile: 'sony-slog3-cine',
      detection: {
        fingerprint: 'source',
        model: 'ILCE-7CM2',
        profile: 'sony-slog3-cine',
        source: 'sony-rtmd',
        inputRange: 'full',
        checkedAt: 'now',
      },
    };
    await repository.record(id, 'video', 'queued', plan);
    await repository.record(id, 'video', 'complete', { ...plan, revision: 'old' });
    const queued = await repository.getState(id);
    expect(queued.video).toMatchObject({ revision: 'new', status: 'queued' });
    await repository.record(id, 'video', 'complete', plan);
    const completed = await repository.getState(id);
    expect(completed.video?.status).toBe('complete');
  });
});
