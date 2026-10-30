import fs from 'node:fs/promises';
import { defaults } from 'src/dtos/config.dto';
import { JobStatus, TranscodePolicy } from 'src/enum';
import { LogPlan } from 'src/repositories/log-preview.repository';
import { MediaService } from 'src/services/media.service';
import { AssetFactory } from 'test/factories/asset.factory';
import { videoInfoStub } from 'test/fixtures/media.stub';
import { newTestService } from 'test/utils';

describe('Log 素材必须生成代理', () => {
  afterEach(() => vi.restoreAllMocks());
  it('原片编解码已兼容时仍套 LUT，并只在成功后替换衍生文件', async () => {
    const { sut, mocks } = newTestService(MediaService);
    const asset = AssetFactory.create();
    const video = {
      ...videoInfoStub.noAudioStreams.videoStreams[0],
      codecName: 'h264',
      pixelFormat: 'yuv420p',
      timeBase: 600,
    };
    mocks.assetJob.getForVideoConversion.mockResolvedValue({
      ...asset,
      files: [],
      videoStream: video,
      audioStream: null,
      format: videoInfoStub.noAudioStreams.format,
    });
    const plan: LogPlan = {
      lut: { id: 'a'.repeat(64), name: 'Sony 709(800%)', profile: 'sony-slog3-cine', size: 33, createdAt: 'now' },
      path: '/data/log-preview/luts/test.cube',
      revision: 'revision',
      profile: 'sony-slog3-cine',
      detection: {
        fingerprint: 'source',
        model: 'ILCE-7CM2',
        source: 'sony-rtmd',
        inputRange: 'full',
        checkedAt: 'now',
      },
    };
    mocks.logPreview.resolve.mockResolvedValue(plan);
    vi.spyOn(sut, 'getConfig').mockResolvedValue({
      ...defaults,
      ffmpeg: { ...defaults.ffmpeg, transcode: TranscodePolicy.Required },
    });
    const promote = vi.spyOn(fs, 'rename').mockResolvedValue();
    vi.spyOn(fs, 'rm').mockResolvedValue();
    expect(await sut.handleVideoConversion({ id: asset.id })).toBe(JobStatus.Success);
    const command = mocks.media.transcode.mock.calls[0][2];
    expect(command.outputOptions[command.outputOptions.indexOf('-c:v') + 1]).not.toBe('copy');
    expect(command.outputOptions.join(' ')).toContain('lut3d=');
    expect(promote).toHaveBeenCalledOnce();
    expect(mocks.asset.upsertFile).toHaveBeenCalledOnce();
  });
});
