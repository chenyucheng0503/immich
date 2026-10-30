import { logPreviewDefaults } from 'src/dtos/log-preview.dto';
import {
  detectDjiLogProfile,
  ffprobeHexToBuffer,
  logLutFilter,
  matchLogRule,
  parseCube,
  parseSonyLogProfile,
} from 'src/utils/log-preview';

const cube = `TITLE "test"\nLUT_3D_SIZE 2\n${Array.from({ length: 8 }, (_, i) => `${i & 1} ${(i >> 1) & 1} ${(i >> 2) & 1}`).join('\n')}`;
function packet(suffix: string, wrap = false) {
  const header = Buffer.alloc(28);
  header.writeUInt16BE(28);
  const tag = Buffer.from(`32100010060e2b34040101060e060401${suffix}`, 'hex');
  const container = Buffer.alloc(4);
  container.writeUInt16BE(0x83_00);
  container.writeUInt16BE(tag.length, 2);
  return Buffer.concat([header, ...(wrap ? [container] : []), tag]);
}

describe('Log 预览识别与 LUT 校验', () => {
  it('区分两种 Sony S-Log3 色域，支持 RTMD 容器', () => {
    expect(parseSonyLogProfile(packet('01010605'))).toBe('sony-slog3-cine');
    expect(parseSonyLogProfile(packet('01010604', true))).toBe('sony-slog3');
    expect(parseSonyLogProfile(packet('01020000'))).toBeUndefined();
  });
  it('不会把任意字节里的 Sony 字样识别成 Log', () => {
    const fake = packet('01010605');
    fake.writeUInt16BE(1);
    expect(parseSonyLogProfile(fake)).toBeUndefined();
    expect(() => parseSonyLogProfile(packet('01010605').subarray(0, 40))).toThrow('不完整');
    const wrongPrefix = packet('01010605');
    wrongPrefix[32] = 0xff;
    expect(parseSonyLogProfile(wrongPrefix)).toBeUndefined();
  });
  it('转换 ffprobe 十六进制列时不混入 ASCII 列', () => {
    expect(ffprobeHexToBuffer('\n00000000: 001c 0100 4142 4344  ....ABCD\n').toString('hex')).toBe('001c010041424344');
  });
  it('DJI 必须存在明确色彩字段，D-Log M 与 D-Log 分开', () => {
    expect(detectDjiLogProfile({ Make: 'DJI', Model: 'Osmo Pocket 3', ColorMode: 'D-Log M' })).toBe('dji-dlog-m');
    expect(detectDjiLogProfile({ Make: 'DJI', Model: 'Mavic', Gamma: 'D-Log' })).toBe('dji-dlog');
    expect(detectDjiLogProfile({ Model: 'Osmo Pocket 3', BitDepth: 10 })).toBeUndefined();
    expect(detectDjiLogProfile({ Make: 'DJI', ColorMode: 'Normal' })).toBeUndefined();
  });
  it('验证 3D LUT 的尺寸、完整数据、有限数值，同时允许 Sony 超白输出', () => {
    expect(parseCube(cube)).toMatchObject({ size: 2, entries: 8 });
    expect(parseCube(cube.replace('LUT_3D_SIZE 2', 'LUT_3D_SIZE\t2'))).toMatchObject({ size: 2, entries: 8 });
    expect(parseCube(cube.replace('1 1 1', '1.094749 1.094749 1.094749')).entries).toBe(8);
    expect(() => parseCube(cube + '\n0 0 0')).toThrow('过多');
    expect(() => parseCube(cube.replace('1 1 1', 'NaN 1 1'))).toThrow('无效');
    expect(() => parseCube(cube.replace('LUT_3D_SIZE 2', 'LUT_3D_SIZE 100'))).toThrow('2–65');
    expect(() => parseCube(cube.replace('1 1 1', ''))).toThrow('不完整');
  });
  it('精确机型规则优先；不匹配的型号不会套用其他机型默认 LUT', () => {
    const config = {
      ...logPreviewDefaults,
      rules: [
        { model: '', profile: 'sony-slog3-cine' as const, lutId: 'fallback' },
        { model: 'ILCE-7CM2', profile: 'sony-slog3-cine' as const, lutId: 'sony' },
      ],
    };
    expect(matchLogRule(config, 'sony-slog3-cine', 'ilce-7cm2')?.lutId).toBe('sony');
    expect(matchLogRule(config, 'sony-slog3-cine', 'Other')?.lutId).toBe('fallback');
    expect(matchLogRule(config, 'dji-dlog-m', 'Osmo Pocket 3')).toBeUndefined();
    expect(matchLogRule(logPreviewDefaults, 'dji-dlog-m', 'DJI OsmoPocket3')?.model).toBe('Osmo Pocket 3');
  });
  it('先保留浮点 RGB 精度进行 LUT，再标记输出；拒绝滤镜路径注入', () => {
    const filters = logLutFilter('/data/log-preview/luts/abc.cube', 'limited');
    expect(filters[0]).toContain('in_range=tv');
    expect(filters.indexOf('format=gbrpf32le')).toBeLessThan(filters.findIndex((f) => f.startsWith('lut3d=')));
    expect(filters.at(-1)).toContain('color_trc=bt709');
    expect(() => logLutFilter('/tmp/a.cube,evil')).toThrow('路径');
  });
});
