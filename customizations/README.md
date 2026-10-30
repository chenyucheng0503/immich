# Immich NAS 定制

统一维护 NAS 上相对官方 Immich 的改造。上游固定为 `v3.2.4`；仓库地址为 `chenyucheng0503/immich`，NAS checkout 为 `/mnt/user/code/immich`。新的改造继续在这个仓库中新建独立分支/worktree。

## 改造范围

- `raw-cleanup/`：从 NAS 当前已部署的 `20261028-1` 发布目录原样纳入。JPG/JPEG 经 Immich 原生永久删除后，检查并清理同目录同名、未被 Immich 收录的 ARW/CR2。回收站内不执行，原片变化或数据库核对失败时保留 RAW；状态继续持久化。
- Log 预览：`server/src/{controllers,services,repositories}/log-preview.*`、`server/src/utils/log-preview.*` 和现有媒体生成链路。设置入口在官方“视频转码”分组；Web 组件为 `LogPreviewSettings.svelte`。
- 原片不套 LUT；视频代理、缩略图、预览图使用同一颜色变换。Sony RTMD 区分 S-Gamut3.Cine/S-Log3 与 S-Gamut3/S-Log3；DJI 只依据明确的颜色模式字段识别，缺字段可手动指定，不能以机型猜测 Log。

## 构建与部署

依赖沿用仓库锁定版本。先构建 SDK，再构建 plugin SDK、server 和 web；pnpm 的 injected workspace dependencies 需要在构建依赖后同步。

```sh
pnpm install --frozen-lockfile --filter immich... --filter immich-web...
pnpm --filter @immich/sdk build
pnpm install --offline --frozen-lockfile --filter immich... --filter immich-web...
pnpm --filter @immich/plugin-sdk build
pnpm install --offline --frozen-lockfile --filter immich... --filter immich-web...
pnpm --filter immich build
pnpm --filter immich-web build
python3 customizations/prepare_overlay.py
```

将 `customizations/build` 传到 NAS checkout 的同名目录，在 NAS 上运行 Docker build。Dockerfile 以官方版本为基础，只覆盖改变的服务端模块并替换 Web 静态站点，因此不会仅因重编译改变未修改的 RAW 删除实现指纹。

实际发布前先备份数据库、Compose 和配置；镜像通过 Compose 的现有服务替换，数据库与媒体挂载不变。不要修改正在运行容器中的代码作为正式发布。

## 持久化目录

- RAW 状态：现有 `/var/lib/immich-raw-cleanup` 挂载保持不变。
- LUT、识别缓存和单片覆盖：容器 `/var/lib/immich-log-preview`，NAS `/mnt/cache/appdata/immich-custom/log-preview`。
- 默认规则：Immich 原生系统配置中的 `ffmpeg.logPreview`，通过同一个管理设置 API 保存。

LUT 属于第三方资源，采用私有持久化文件，不提交 Git、不捆绑到公开镜像。Sony 709(800%) 来自 Sony Catalyst Browse 签名安装包资源，DJI Pocket 3 文件来自官方 LUT 下载。来源和校验和见 `lut-sources.json`；这不代表第三方资源获得了重新分发许可。

## 升级和回退

升级先在独立 worktree 合并指定上游版本，运行必要检查并重新核对所有改动入口。RAW 清理会核验 `storage.service.js` 的 SHA256；不匹配时禁用额外删除，必须先验证再更新指纹。LUT 文件与用户规则随持久化存储保留。

当前补丁不引入数据库表迁移。回退到部署前镜像和 Compose 后原片仍可用；已生成的还原代理会保留，若需要恢复灰片预览须重新生成相关代理与缩略图。不要删除原片或整个衍生目录来回退。

## 验证

关键检查覆盖 RTMD 边界、不同 Log 的识别、普通视频不误判、LUT 格式、QSV 前的浮点颜色转换、原有转码逻辑和 RAW 清理规则。部署后还要检查设置保存、真实样片自动识别、同帧对照、生成的播放代理和缩略图、原片校验和以及 RAW 扩展健康状态。测试目录使用临时文件，不能拿用户原片验证永久删除。
