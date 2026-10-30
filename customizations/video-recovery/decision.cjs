// 复用运行镜像的原生转码策略和 LUT 匹配，避免把“无需转码”当作处理丢失。
const fs = require('node:fs');
const { MediaService } = require('./dist/services/media.service');
const { LogPreviewRepository } = require('./dist/repositories/log-preview.repository');
const { TranscodeTarget } = require('./dist/enum');
const { exiftool } = require('exiftool-vendored');

async function main() {
  const { asset, config } = JSON.parse(fs.readFileSync(0, 'utf8'));
  const service = Object.create(MediaService.prototype);
  const stream = { ...asset.video, width: asset.width, height: asset.height };
  const target = service.getTranscodeTarget(config.ffmpeg, stream, asset.audio || undefined);
  const remux = service.isRemuxRequired(config.ffmpeg, asset.video);
  const plan = await new LogPreviewRepository().resolve(
    { id: asset.id, originalPath: asset.path, cameraModel: asset.model }, config.ffmpeg.logPreview,
  );
  process.stdout.write(JSON.stringify({ required: target !== TranscodeTarget.None || remux || !!plan }));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => exiftool.end());
