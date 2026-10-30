import { Body, Controller, Get, Param, Post, Put, Query, StreamableFile } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { AuthDto } from 'src/dtos/auth.dto';
import {
  LogLutUploadDto,
  LogPreviewFrameDto,
  LogPreviewOverrideDto,
  LogPreviewRebuildDto,
} from 'src/dtos/log-preview.dto';
import { Permission } from 'src/enum';
import { Auth, Authenticated } from 'src/middleware/auth.guard';
import { LogPreviewService } from 'src/services/log-preview.service';
import { UUIDParamDto } from 'src/validation';

// 私有定制端点，官方客户端继续使用原有播放 API。
@ApiExcludeController()
@Controller('admin/log-preview')
export class LogPreviewController {
  constructor(private service: LogPreviewService) {}

  @Get()
  @Authenticated({ permission: Permission.AdminConfigRead, admin: true })
  catalogue() {
    return this.service.catalogue();
  }

  @Post('luts')
  @Authenticated({ permission: Permission.AdminConfigUpdate, admin: true })
  upload(@Body() dto: LogLutUploadDto) {
    return this.service.upload(dto);
  }

  @Post('rebuild')
  @Authenticated({ permission: Permission.AdminConfigUpdate, admin: true })
  rebuild(@Auth() auth: AuthDto, @Body() dto: LogPreviewRebuildDto) {
    return this.service.rebuild(dto, auth);
  }

  @Get('assets/:id')
  @Authenticated({ permission: Permission.AdminConfigRead, admin: true })
  inspect(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto) {
    return this.service.inspect(id, auth);
  }

  @Put('assets/:id')
  @Authenticated({ permission: Permission.AdminConfigUpdate, admin: true })
  override(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Body() dto: LogPreviewOverrideDto) {
    return this.service.override(id, dto, auth);
  }

  @Get('assets/:id/frame')
  @Authenticated({ permission: Permission.AdminConfigRead, admin: true })
  async frame(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Query() dto: LogPreviewFrameDto) {
    return new StreamableFile(await this.service.frame(id, dto, auth), { type: 'image/jpeg', disposition: 'inline' });
  }
}
