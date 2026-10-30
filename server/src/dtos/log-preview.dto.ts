import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const LogProfileSchema = z.enum(['sony-slog3-cine', 'sony-slog3', 'dji-dlog-m', 'dji-dlog']);
export type LogProfile = z.infer<typeof LogProfileSchema>;
export const LutIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const LogPreviewRuleSchema = z
  .object({
    model: z.string().trim().max(120),
    profile: LogProfileSchema,
    lutId: z.union([z.literal(''), LutIdSchema]),
  })
  .meta({ id: 'LogPreviewRuleDto' });
export const LogPreviewConfigSchema = z
  .object({
    enabled: z.boolean(),
    rules: z.array(LogPreviewRuleSchema).max(100),
  })
  .meta({ id: 'LogPreviewConfigDto' });
export type LogPreviewConfig = z.infer<typeof LogPreviewConfigSchema>;
export const logPreviewDefaults: LogPreviewConfig = {
  enabled: false,
  rules: [
    { model: 'ILCE-7CM2', profile: 'sony-slog3-cine', lutId: '' },
    { model: 'ILCE-7CM2', profile: 'sony-slog3', lutId: '' },
    { model: 'Osmo Pocket 3', profile: 'dji-dlog-m', lutId: '' },
  ],
};

export class LogLutUploadDto extends createZodDto(
  z.object({
    name: z.string().trim().min(1).max(120),
    profile: LogProfileSchema,
    content: z
      .string()
      .min(1)
      .max(8 * 1024 * 1024),
  }),
) {}

export class LogPreviewOverrideDto extends createZodDto(
  z
    .object({
      mode: z.enum(['auto', 'off', 'manual']),
      profile: LogProfileSchema.optional(),
      lutId: LutIdSchema.optional(),
    })
    .refine((v) => v.mode !== 'manual' || Boolean(v.profile && v.lutId), {
      message: '手动还原需要同时指定 Log 类型和 LUT',
    }),
) {}

export class LogPreviewRebuildDto extends createZodDto(
  z.object({
    assetIds: z.array(z.uuid()).max(100).optional(),
  }),
) {}

export class LogPreviewFrameDto extends createZodDto(
  z.object({
    lutId: LutIdSchema.optional(),
    seconds: z.coerce.number().min(0).max(3600).default(1),
  }),
) {}
