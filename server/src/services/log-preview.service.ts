import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { isEqual } from 'lodash';
import { OnEvent, OnJob } from 'src/decorators';
import { AuthDto } from 'src/dtos/auth.dto';
import {
  LogLutUploadDto,
  LogPreviewFrameDto,
  LogPreviewOverrideDto,
  LogPreviewRebuildDto,
} from 'src/dtos/log-preview.dto';
import { AssetType, ImmichWorker, JobName, JobStatus, Permission, QueueName } from 'src/enum';
import { ArgOf } from 'src/repositories/event.repository';
import { BaseService } from 'src/services/base.service';
import { JobOf } from 'src/types';
import { LOG_PROFILE_LABELS } from 'src/utils/log-preview';

@Injectable()
export class LogPreviewService extends BaseService {
  async catalogue() {
    return { profiles: LOG_PROFILE_LABELS, luts: await this.logPreviewRepository.listLuts() };
  }

  async upload(dto: LogLutUploadDto) {
    try {
      return await this.logPreviewRepository.uploadLut(dto);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  @OnEvent({ name: 'ConfigValidate' })
  async validate({ newConfig }: ArgOf<'ConfigValidate'>) {
    await this.logPreviewRepository.validateConfig(newConfig.ffmpeg.logPreview);
  }

  @OnEvent({ name: 'ConfigUpdate', server: true, workers: [ImmichWorker.Microservices] })
  async configChanged({ oldConfig, newConfig }: ArgOf<'ConfigUpdate'>) {
    if (isEqual(oldConfig.ffmpeg.logPreview, newConfig.ffmpeg.logPreview)) {
      return;
    }
    // 不在设置保存请求中扫描视频；持久化队列在后台比较前后配置。
    await this.jobRepository.queue({
      name: JobName.LogPreviewScan,
      data: {
        knownOnly: true,
        previousConfig: oldConfig.ffmpeg.logPreview,
      },
    });
  }

  private async getAsset(id: string) {
    const asset = await this.assetRepository.getById(id, { exifInfo: true });
    if (!asset || asset.deletedAt || asset.type !== AssetType.Video) {
      throw new NotFoundException('视频不存在');
    }
    return asset;
  }

  async inspect(id: string, auth?: AuthDto) {
    if (auth) {
      await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [id] });
    }
    const asset = await this.getAsset(id);
    const detection = await this.logPreviewRepository.inspect(asset);
    const config = await this.getConfig({ withCache: false });
    const plan = await this.logPreviewRepository.resolve(asset, config.ffmpeg.logPreview);
    return {
      id,
      fileName: asset.originalFileName,
      ...(await this.logPreviewRepository.getState(id)),
      detection,
      selectedLut: plan?.lut,
    };
  }

  async override(id: string, dto: LogPreviewOverrideDto, auth: AuthDto) {
    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: [id] });
    await this.getAsset(id);
    try {
      await this.logPreviewRepository.setOverride(id, dto);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    await this.rebuild({ assetIds: [id] });
    return this.inspect(id);
  }

  async frame(id: string, dto: LogPreviewFrameDto, auth: AuthDto) {
    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [id] });
    return this.logPreviewRepository.frame(await this.getAsset(id), dto.seconds, dto.lutId);
  }

  async rebuild(dto: LogPreviewRebuildDto, auth?: AuthDto) {
    if (auth && dto.assetIds) {
      await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: dto.assetIds });
    }
    await this.jobRepository.queue({ name: JobName.LogPreviewScan, data: dto });
    return { queued: true, count: dto.assetIds?.length ?? null };
  }

  @OnJob({ name: JobName.LogPreviewScan, queue: QueueName.BackgroundTask })
  async scan({ assetIds, knownOnly, previousConfig }: JobOf<JobName.LogPreviewScan>) {
    const config = await this.getConfig({ withCache: false });
    const queue = async (id: string) => {
      try {
        const asset = await this.getAsset(id);
        const state = await this.logPreviewRepository.getState(id);
        const plan = await this.logPreviewRepository.resolve(asset, config.ffmpeg.logPreview);
        if (previousConfig) {
          const before = await this.logPreviewRepository.resolve(asset, previousConfig);
          if (before?.revision === plan?.revision) {
            return;
          }
        }
        // 关闭功能/某资产后仍重建过去套过 LUT 的预览，避免留下过时颜色。
        if (!plan && !state.video?.lutId && !state.thumbnail?.lutId && !assetIds) {
          return;
        }
        await Promise.all([
          this.logPreviewRepository.record(id, 'video', 'queued', plan),
          this.logPreviewRepository.record(id, 'thumbnail', 'queued', plan),
        ]);
        await this.jobRepository.queueAll([
          { name: JobName.AssetEncodeVideo, data: { id } },
          { name: JobName.AssetGenerateThumbnails, data: { id } },
        ]);
      } catch (error) {
        this.logger.warn(`Log 预览扫描 ${id} 失败: ${(error as Error).message}`);
      }
    };
    if (assetIds || knownOnly) {
      const ids = assetIds ?? (await this.logPreviewRepository.listAssetIds());
      for (const id of ids) {
        await queue(id);
      }
    } else {
      for await (const asset of this.assetJobRepository.streamForLogPreview()) {
        await queue(asset.id);
      }
    }
    return JobStatus.Success;
  }
}
