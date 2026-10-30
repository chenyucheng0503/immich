import { defaults } from 'src/dtos/config.dto';
import { AssetType, JobName } from 'src/enum';
import { LogPlan } from 'src/repositories/log-preview.repository';
import { LogPreviewService } from 'src/services/log-preview.service';
import { AssetFactory } from 'test/factories/asset.factory';
import { authStub } from 'test/fixtures/auth.stub';
import { getForAsset } from 'test/mappers';
import { makeStream, newTestService } from 'test/utils';

const counts = { active: 0, waiting: 0, paused: 0, delayed: 0, completed: 0, failed: 0 };
const plan: LogPlan = {
  lut: { id: 'a'.repeat(64), name: 'Sony', profile: 'sony-slog3-cine', size: 33, createdAt: 'now' },
  path: '/data/log-preview/luts/test.cube',
  revision: 'current',
  profile: 'sony-slog3-cine',
  detection: { fingerprint: 'source', model: 'ILCE-7CM2', source: 'sony-rtmd', inputRange: 'full', checkedAt: 'now' },
};
function setup() {
  const context = newTestService(LogPreviewService);
  const asset = AssetFactory.create({ type: AssetType.Video });
  context.mocks.asset.getById.mockResolvedValue(getForAsset(asset));
  context.mocks.logPreview.resolve.mockResolvedValue(plan);
  context.mocks.logPreview.getState.mockResolvedValue({
    detection: plan.detection,
    override: { mode: 'auto' },
    video: undefined,
    thumbnail: undefined,
  });
  context.mocks.job.getJobCounts.mockResolvedValue(counts);
  vi.spyOn(context.sut, 'getConfig').mockResolvedValue(defaults);
  return { ...context, asset };
}

describe('Sony 存量回填', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it('恢复扫描跳过同版本已完成素材，并保留 Sony 范围', async () => {
    const { sut, mocks, asset } = setup();
    mocks.assetJob.streamForLogPreview.mockReturnValue(
      makeStream([{ id: asset.id, originalPath: asset.originalPath, cameraModel: 'ILCE-7CM2' }]),
    );
    mocks.logPreview.getState.mockResolvedValue({
      detection: plan.detection,
      override: { mode: 'auto' },
      video: { status: 'complete', revision: 'current' },
      thumbnail: { status: 'complete', revision: 'current' },
    });
    await sut.scan({ sonyOnly: true });
    expect(mocks.assetJob.streamForLogPreview).toHaveBeenCalledWith(true);
    expect(mocks.job.queueAll).not.toHaveBeenCalled();
  });
  it('原生队列已有两个在途任务时等待，不一次灌入所有 FFmpeg 作业', async () => {
    vi.useFakeTimers();
    const { sut, mocks, asset } = setup();
    mocks.job.getJobCounts.mockResolvedValueOnce({ ...counts, active: 1, waiting: 1 });
    const running = sut.scan({ assetIds: [asset.id] });
    await vi.advanceTimersByTimeAsync(2000);
    await running;
    expect(mocks.job.getJobCounts).toHaveBeenCalledTimes(4);
    expect(mocks.job.queueAll).toHaveBeenCalledWith([
      { name: JobName.AssetEncodeVideo, data: { id: asset.id } },
      { name: JobName.AssetGenerateThumbnails, data: { id: asset.id } },
    ]);
  });
});

function appliedSetup() {
  const context = setup();
  context.mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([context.asset.id]));
  context.mocks.asset.getForVideo.mockResolvedValue({
    originalPath: context.asset.originalPath,
    encodedVideoPath: '/preview.mp4',
  });
  return context;
}

describe('已应用 LUT 的只读提示', () => {
  it('返回生成预览时使用的 LUT，而非目前选择的配置', async () => {
    const { sut, mocks, asset } = appliedSetup();
    mocks.logPreview.getState.mockResolvedValue({
      detection: plan.detection,
      override: { mode: 'auto' },
      video: { status: 'complete', lutId: 'rendered-lut', lutName: '实际还原 LUT' },
      thumbnail: undefined,
    });
    await expect(sut.getAppliedLut(asset.id, authStub.admin)).resolves.toEqual({
      lut: { id: 'rendered-lut', name: '实际还原 LUT' },
    });
    expect(mocks.logPreview.inspect).not.toHaveBeenCalled();
    expect(mocks.logPreview.resolve).not.toHaveBeenCalled();
  });

  it.each(['queued', 'processing', 'failed', 'complete'])(
    '不把 %s 状态的未完成/未套 LUT 预览误报为还原',
    async (status) => {
      const { sut, mocks, asset } = appliedSetup();
      mocks.logPreview.getState.mockResolvedValue({
        detection: plan.detection,
        override: { mode: 'auto' },
        video: status === 'complete' ? { status } : { status, lutId: 'planned-lut', lutName: '准备使用的 LUT' },
        thumbnail: undefined,
      });
      await expect(sut.getAppliedLut(asset.id, authStub.admin)).resolves.toEqual({ lut: null });
    },
  );

  it('没有播放代理时不显示旧的完成记录', async () => {
    const { sut, mocks, asset } = appliedSetup();
    mocks.asset.getForVideo.mockResolvedValue({ originalPath: asset.originalPath, encodedVideoPath: null });
    await expect(sut.getAppliedLut(asset.id, authStub.admin)).resolves.toEqual({ lut: null });
    expect(mocks.logPreview.getState).not.toHaveBeenCalled();
  });
});
