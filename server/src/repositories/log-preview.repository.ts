import { Injectable } from '@nestjs/common';
import { exiftool } from 'exiftool-vendored';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  LogLutUploadDto,
  LogPreviewConfig,
  LogPreviewOverrideDto,
  LogProfile,
  LutIdSchema,
} from 'src/dtos/log-preview.dto';
import {
  detectDjiLogProfile,
  ffprobeHexToBuffer,
  logLutFilter,
  matchLogRule,
  parseCube,
  parseSonyLogProfile,
} from 'src/utils/log-preview';

const execute = promisify(execFile);
export type LogAsset = {
  id: string;
  originalPath: string;
  cameraModel?: string | null;
  exifInfo?: { model?: string | null } | null;
};
export type LogDetection = {
  fingerprint: string;
  model: string;
  profile?: LogProfile;
  source: 'sony-rtmd' | 'dji-metadata' | 'none';
  inputRange: 'full' | 'limited';
  checkedAt: string;
  warning?: string;
};
export type LogLut = { id: string; name: string; profile: LogProfile; size: number; createdAt: string };
export type LogPlan = { lut: LogLut; path: string; revision: string; detection: LogDetection; profile: LogProfile };

@Injectable()
export class LogPreviewRepository {
  readonly root = process.env.IMMICH_LOG_PREVIEW_DIR ?? '/data/log-preview';

  private assetPath(id: string, kind: string) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) {
      throw new Error('无效的资产 ID');
    }
    return join(this.root, 'assets', id, `${kind}.json`);
  }

  private async readJson<T>(path: string): Promise<T | undefined> {
    try {
      return JSON.parse(await fs.readFile(path, 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }

  private async writeJson(path: string, value: unknown) {
    await fs.mkdir(join(path, '..'), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await fs.rename(temporary, path);
  }

  async listLuts(): Promise<LogLut[]> {
    const folder = join(this.root, 'luts');
    await fs.mkdir(folder, { recursive: true });
    const entries = await fs.readdir(folder);
    const files = entries.filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    const luts = await Promise.all(files.map((name) => this.readJson<LogLut>(join(folder, name))));
    return luts.filter((value): value is LogLut => Boolean(value)).sort((a, b) => a.name.localeCompare(b.name));
  }

  async getLut(id: string) {
    LutIdSchema.parse(id);
    const lut = await this.readJson<LogLut>(join(this.root, 'luts', `${id}.json`));
    if (!lut) {
      throw new Error('LUT 不存在，请先导入对应文件');
    }
    const path = join(this.root, 'luts', `${id}.cube`);
    const content = await fs.readFile(path, 'utf8');
    if (createHash('sha256').update(content).digest('hex') !== id) {
      throw new Error('LUT 文件校验失败');
    }
    return { lut, path };
  }

  async uploadLut(dto: LogLutUploadDto) {
    const parsed = parseCube(dto.content);
    const id = parsed.sha256;
    await fs.mkdir(join(this.root, 'luts'), { recursive: true });
    const existing = await this.readJson<LogLut>(join(this.root, 'luts', `${id}.json`));
    if (existing && existing.profile !== dto.profile) {
      throw new Error('同一 LUT 已绑定其他输入类型，不能重复标记');
    }
    const lut: LogLut = {
      id,
      name: dto.name,
      profile: dto.profile,
      size: parsed.size,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    const path = join(this.root, 'luts', `${id}.cube`);
    try {
      await fs.writeFile(path, dto.content, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
    await this.writeJson(join(this.root, 'luts', `${id}.json`), lut);
    return lut;
  }

  async validateConfig(config: LogPreviewConfig) {
    const keys = new Set<string>();
    for (const rule of config.rules) {
      const key = `${rule.model.trim().toLowerCase()}:${rule.profile}`;
      if (keys.has(key)) {
        throw new Error('同一机型和 Log 类型只能有一条默认规则');
      }
      keys.add(key);
      if (rule.lutId) {
        const { lut } = await this.getLut(rule.lutId);
        if (lut.profile !== rule.profile) {
          throw new Error(`${lut.name} 的输入类型与规则不匹配`);
        }
      }
    }
  }

  async inspect(asset: LogAsset): Promise<LogDetection> {
    const stat = await fs.stat(asset.originalPath);
    const model = asset.cameraModel ?? asset.exifInfo?.model ?? '';
    const fingerprint = createHash('sha256').update(`${asset.originalPath}:${stat.size}:${stat.mtimeMs}`).digest('hex');
    const cached = await this.readJson<LogDetection>(this.assetPath(asset.id, 'detection'));
    if (cached?.fingerprint === fingerprint) {
      return cached;
    }
    let result: LogDetection = {
      fingerprint,
      model,
      source: 'none',
      inputRange: 'full',
      checkedAt: new Date().toISOString(),
    };
    try {
      const { stdout: header } = await execute(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_entries',
          'stream=index,codec_type,codec_tag_string,color_range',
          '-of',
          'json',
          asset.originalPath,
        ],
        { timeout: 20_000, maxBuffer: 256 * 1024 },
      );
      const streams = (
        JSON.parse(header) as {
          streams: { index: number; codec_type?: string; codec_tag_string?: string; color_range?: string }[];
        }
      ).streams;
      const range = streams.find((stream) => stream.codec_type === 'video')?.color_range;
      result.inputRange = range === 'tv' ? 'limited' : 'full';
      const rtmd = streams.find((stream) => stream.codec_tag_string === 'rtmd');
      // 没有 RTMD 轨时不能用 -show_packets 扫描全片来等一个不存在的数据包。
      if (rtmd) {
        const { stdout } = await execute(
          'ffprobe',
          [
            '-v',
            'error',
            '-select_streams',
            String(rtmd.index),
            '-read_intervals',
            '%+#1',
            '-show_packets',
            '-show_data',
            '-of',
            'json',
            asset.originalPath,
          ],
          { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
        );
        const packets = (JSON.parse(stdout) as { packets?: { data?: string }[] }).packets ?? [];
        for (const packet of packets) {
          if (!packet.data) {
            continue;
          }
          const profile = parseSonyLogProfile(ffprobeHexToBuffer(packet.data));
          if (profile) {
            result = { ...result, profile, source: 'sony-rtmd' };
          }
        }
      }
      if (!result.model || result.source === 'none') {
        const tags = await exiftool.read(asset.originalPath);
        const rawTags = tags as Record<string, unknown>;
        result.model ||= String(tags.Model ?? rawTags.DeviceModelName ?? '');
        if (result.source === 'none') {
          const profile = detectDjiLogProfile(rawTags);
          if (profile) {
            result = { ...result, profile, source: 'dji-metadata' };
          }
        }
      }
    } catch (error) {
      // 颜色识别失败不改变原有视频处理能力，也绝不能猜测后误套 LUT。
      result = {
        ...result,
        profile: undefined,
        source: 'none',
        warning: `未能可靠识别 Log：${(error as Error).message}`,
      };
    }
    await this.writeJson(this.assetPath(asset.id, 'detection'), result);
    return result;
  }

  getOverride(id: string) {
    return this.readJson<LogPreviewOverrideDto>(this.assetPath(id, 'override'));
  }

  async setOverride(id: string, override: LogPreviewOverrideDto) {
    if (override.mode === 'manual') {
      const { lut } = await this.getLut(override.lutId!);
      if (lut.profile !== override.profile) {
        throw new Error('LUT 与指定的 Log 类型不匹配');
      }
    }
    await this.writeJson(this.assetPath(id, 'override'), override);
  }

  async resolve(asset: LogAsset, config: LogPreviewConfig): Promise<LogPlan | undefined> {
    if (!config.enabled) {
      return;
    }
    const override = await this.getOverride(asset.id);
    if (override?.mode === 'off') {
      return;
    }
    const detection = await this.inspect(asset);
    const profile = override?.mode === 'manual' ? override.profile : detection.profile;
    if (!profile) {
      return;
    }
    const lutId = override?.mode === 'manual' ? override.lutId : matchLogRule(config, profile, detection.model)?.lutId;
    if (!lutId) {
      return;
    }
    const { lut, path } = await this.getLut(lutId);
    if (lut.profile !== profile) {
      throw new Error('LUT 与原片 Log 类型不匹配');
    }
    const revision = createHash('sha256')
      .update(`log-preview-v1:${detection.fingerprint}:${profile}:${lutId}`)
      .digest('hex');
    return { lut, path, profile, detection, revision };
  }

  async listAssetIds() {
    try {
      const names = await fs.readdir(join(this.root, 'assets'));
      return names.filter((name) => /^[a-f0-9-]{36}$/i.test(name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async getState(id: string) {
    const [detection, override, video, thumbnail] = await Promise.all([
      this.readJson<LogDetection>(this.assetPath(id, 'detection')),
      this.getOverride(id),
      this.readJson<Record<string, unknown>>(this.assetPath(id, 'video')),
      this.readJson<Record<string, unknown>>(this.assetPath(id, 'thumbnail')),
    ]);
    return { detection, override: override ?? { mode: 'auto' }, video, thumbnail };
  }

  async record(
    id: string,
    kind: 'video' | 'thumbnail',
    status: 'queued' | 'processing' | 'complete' | 'failed',
    plan?: LogPlan,
    error?: string,
  ) {
    const previous = await this.readJson<{ revision?: string }>(this.assetPath(id, kind));
    if (!plan && !previous && !(await this.readJson(this.assetPath(id, 'detection')))) {
      return;
    }
    if (['complete', 'failed'].includes(status) && previous && previous.revision !== plan?.revision) {
      return;
    }
    return this.writeJson(this.assetPath(id, kind), {
      status,
      revision: plan?.revision,
      lutId: plan?.lut.id,
      lutName: plan?.lut.name,
      updatedAt: new Date().toISOString(),
      error,
    });
  }

  async frame(asset: LogAsset, seconds: number, lutId?: string) {
    const detection = await this.inspect(asset);
    const lut = lutId ? await this.getLut(lutId) : undefined;
    const filters = lut ? logLutFilter(lut.path, detection.inputRange) : ['scale=-2:480'];
    if (lutId) {
      filters[0] = filters[0].replace('scale=', 'scale=-2:480:');
    }
    const { stdout } = await execute(
      'ffmpeg',
      [
        '-v',
        'error',
        '-threads',
        '2',
        '-ss',
        String(seconds),
        '-i',
        asset.originalPath,
        '-frames:v',
        '1',
        '-vf',
        filters.join(','),
        '-f',
        'image2pipe',
        '-c:v',
        'mjpeg',
        '-q:v',
        '2',
        'pipe:1',
      ],
      { encoding: 'buffer', timeout: 45_000, maxBuffer: 4 * 1024 * 1024 },
    );
    return stdout;
  }
}
