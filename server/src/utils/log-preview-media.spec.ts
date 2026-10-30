import { defaults } from 'src/dtos/config.dto';
import { TranscodeHardwareAcceleration, TranscodeTarget } from 'src/enum';
import { BaseConfig, ThumbnailConfig } from 'src/utils/media';
import { videoInfoStub } from 'test/fixtures/media.stub';

describe('Log 预览滤镜与硬件编码', () => {
  const video = videoInfoStub.noAudioStreams.videoStreams[0];
  const color = { logLutPath: '/data/log-preview/luts/test.cube', logInputRange: 'full' as const };
  it('QSV 使用软件解码、浮点 LUT 后才上传硬件帧', () => {
    const config = BaseConfig.create(
      { ...defaults.ffmpeg, ...color, accel: TranscodeHardwareAcceleration.Qsv, accelDecode: true },
      { dri: ['renderD128'], mali: false },
    );
    const command = config.getCommand(TranscodeTarget.Video, video);
    const filter = command.outputOptions[command.outputOptions.indexOf('-vf') + 1];
    expect(command.inputOptions).not.toContain('-hwaccel');
    expect(command.outputOptions).toContain('h264_qsv');
    expect(filter.indexOf('lut3d=')).toBeLessThan(filter.indexOf('hwupload='));
    expect(filter).toContain('format=gbrpf32le');
    expect(command.outputOptions).toContain('bt709');
  });
  it('静态封面与视频使用同一 LUT，不叠加 HDR tonemap', () => {
    const command = ThumbnailConfig.create({ ...defaults.ffmpeg, ...color }).getCommand(TranscodeTarget.Video, video);
    const filter = command.outputOptions[command.outputOptions.indexOf('-vf') + 1];
    expect(filter).toContain('lut3d=file=/data/log-preview/luts/test.cube');
    expect(filter).not.toContain('tonemap');
    expect(filter).not.toContain('hwupload');
  });
  it('关闭 Log 处理时保持原有编码行为', () => {
    const command = BaseConfig.create(defaults.ffmpeg, { dri: [], mali: false }).getCommand(
      TranscodeTarget.Video,
      video,
    );
    expect(command.outputOptions.join(' ')).not.toContain('lut3d');
  });
});
