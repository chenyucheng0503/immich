import { createHash } from 'node:crypto';
import { LogPreviewConfig, LogProfile } from 'src/dtos/log-preview.dto';

export const LOG_PROFILE_LABELS: Record<LogProfile, string> = {
  'sony-slog3-cine': 'Sony S-Gamut3.Cine / S-Log3',
  'sony-slog3': 'Sony S-Gamut3 / S-Log3',
  'dji-dlog-m': 'DJI D-Log M',
  'dji-dlog': 'DJI D-Log',
};

export function parseCube(content: string) {
  let size = 0;
  let entries = 0;
  let title = '';
  const domain = { min: [0, 0, 0], max: [1, 1, 1] };
  for (const raw of content.replace(/^\u{FEFF}/u, '').split(/\r?\n/)) {
    const line = raw.split('#', 1)[0].trim();
    if (!line) {
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts[0] === 'TITLE') {
      title = line.slice(5).trim().replaceAll(/^"|"$/g, '');
      continue;
    }
    if (parts[0] === 'LUT_3D_SIZE') {
      if (size || entries) {
        throw new Error('LUT_3D_SIZE 重复或顺序错误');
      }
      if (parts.length !== 2) {
        throw new Error('LUT_3D_SIZE 格式无效');
      }
      size = Number(parts[1]);
      if (!Number.isSafeInteger(size) || size < 2 || size > 65) {
        throw new Error('只支持 2–65 格的 3D .cube');
      }
      continue;
    }
    if (parts[0] === 'DOMAIN_MIN' || parts[0] === 'DOMAIN_MAX') {
      const values = parts.slice(1).map(Number);
      if (values.length !== 3 || values.some((v) => !Number.isFinite(v))) {
        throw new Error('LUT 输入范围无效');
      }
      domain[parts[0] === 'DOMAIN_MIN' ? 'min' : 'max'] = values;
      continue;
    }
    const values = parts.map(Number);
    if (!size || values.length !== 3 || values.some((v) => !(Number.isFinite(v) && Math.abs(v) <= 16))) {
      throw new Error('LUT 数据无效；仅支持标准 3D .cube，不支持混合 1D/3D');
    }
    entries++;
    if (entries > size ** 3) {
      throw new Error('LUT 数据行过多');
    }
  }
  if (!size || entries !== size ** 3 || domain.min.some((v, i) => v >= domain.max[i])) {
    throw new Error('LUT 数据不完整或输入范围无效');
  }
  return { size, entries, title, sha256: createHash('sha256').update(content).digest('hex') };
}

/** Sony RTMD：只遍历合法容器，不在视频字节中模糊匹配；边界参考 SMPTE UL/本机样本。 */
export function parseSonyLogProfile(packet: Buffer): LogProfile | undefined {
  if (packet.length <= 28 || packet.readUInt16BE(0) !== 28) {
    return;
  }
  let profile: LogProfile | undefined;
  const parse = (data: Buffer, depth = 0) => {
    if (depth > 8) {
      throw new Error('RTMD 嵌套过深');
    }
    let offset = 0;
    while (offset + 2 <= data.length) {
      const tag = data.readUInt16BE(offset);
      offset += 2;
      if (tag === 0 || tag === 0xff_ff) {
        return;
      }
      if (tag === 0x06_0e) {
        if (offset + 14 > data.length) {
          throw new Error('RTMD UL 不完整');
        }
        offset += 14;
        continue;
      }
      if (offset + 2 > data.length) {
        throw new Error('RTMD 长度不完整');
      }
      const length = data.readUInt16BE(offset);
      offset += 2;
      if (offset + length > data.length) {
        throw new Error('RTMD 数据不完整');
      }
      const value = data.subarray(offset, offset + length);
      offset += length;
      if (tag === 0x83_00) {
        parse(value, depth + 1);
      }
      if (
        tag === 0x32_10 &&
        value.length === 16 &&
        value.subarray(0, 12).toString('hex') === '060e2b34040101060e060401'
      ) {
        const suffix = value.readUInt32BE(12);
        const candidate =
          suffix === 0x01_01_06_05 ? 'sony-slog3-cine' : suffix === 0x01_01_06_04 ? 'sony-slog3' : undefined;
        if (profile && candidate !== profile) {
          throw new Error('RTMD 色彩配置冲突');
        }
        profile = candidate;
      }
    }
  };
  parse(packet.subarray(28));
  return profile;
}

export function ffprobeHexToBuffer(dump: string): Buffer {
  return Buffer.from(
    dump
      .split('\n')
      .filter((v) => /^[0-9a-f]+:/i.test(v))
      .map((v) =>
        v
          .slice(v.indexOf(':') + 1)
          .trimStart()
          .split('  ', 1)[0]
          .replaceAll(' ', ''),
      )
      .join(''),
    'hex',
  );
}

export function detectDjiLogProfile(tags: Record<string, unknown>): LogProfile | undefined {
  // 只有明确的色彩模式字段可决定是否为 Log；机型和 10-bit 不能决定。
  const make = String(tags.Make ?? tags.DeviceManufacturer ?? '');
  const model = String(tags.Model ?? tags.DeviceModelName ?? tags.CameraModel ?? '');
  if (!/dji|osmo|pocket|mavic/i.test(`${make} ${model}`)) {
    return;
  }
  const mode = Object.entries(tags)
    .filter(([key]) => /^(?:ColorMode|ColorProfile|Gamma|GammaCurve|CaptureGammaEquation)$/i.test(key))
    .map(([, value]) => String(value))
    .join(' ');
  if (/\bd[ -]?log[ -]?m\b/i.test(mode)) {
    return 'dji-dlog-m';
  }
  if (/\bd[ -]?log\b/i.test(mode)) {
    return 'dji-dlog';
  }
}

const normalize = (v: string) =>
  v
    .trim()
    .toLowerCase()
    .replace(/^dji[ _-]*/i, '')
    .replaceAll(/[ _-]/g, '');

export function matchLogRule(config: LogPreviewConfig, profile: LogProfile, model: string) {
  const exact = config.rules.find((r) => r.profile === profile && r.model && normalize(r.model) === normalize(model));
  return exact ?? config.rules.find((r) => r.profile === profile && !r.model.trim());
}

export function logLutFilter(path: string, range: 'full' | 'limited' = 'full') {
  // 输入矩阵与 RGB 色域不是同一概念。Sony XAVC 按 BT.709 YCbCr 矩阵解包，LUT 才变换色域。
  if (!/^\/[a-zA-Z0-9_./-]+\.cube$/.test(path)) {
    throw new Error('LUT 路径无效');
  }
  return [
    `scale=in_range=${range === 'full' ? 'pc' : 'tv'}:out_range=pc:in_color_matrix=bt709:flags=accurate_rnd+full_chroma_int`,
    'format=gbrpf32le',
    `lut3d=file=${path}:interp=tetrahedral`,
    'scale=in_range=pc:out_range=tv:out_color_matrix=bt709',
    'format=yuv420p',
    'setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709',
  ];
}
