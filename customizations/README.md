# Immich NAS 定制

统一维护 NAS 上相对官方 Immich 的改造。上游固定为 `v3.2.4`；仓库地址为 `chenyucheng0503/immich`，NAS checkout 为 `/mnt/user/code/immich`，维护主线为 `master`。新的改造继续在这个仓库中新建独立分支/worktree。

## 改造范围

- `video-recovery/`：通过原生任务 API 补偿视频元数据、缩略图和播放预览漏处理；持久化重试状态、限制在途任务并隔离损坏原片。部署与验证边界见该目录 README。
- `sony-creative-look/`：A7C II 标准创意外观转缩写，通过原生工作流和资产 API 自动写入 XMP 旁车；独立容器、持久化逐张记录，支持按拍摄日期回填。部署和操作见该目录 README。
- `raw-cleanup/`：从 NAS 当前已部署的 `20261028-1` 发布目录原样纳入。JPG/JPEG 经 Immich 原生永久删除后，检查并清理同目录同名、未被 Immich 收录的 ARW/CR2。回收站内不执行，原片变化或数据库核对失败时保留 RAW；状态继续持久化。
- Log 预览：`server/src/{controllers,services,repositories}/log-preview.*`、`server/src/utils/log-preview.*` 和现有媒体生成链路。设置入口在官方“视频转码”分组；Web 组件为 `LogPreviewSettings.svelte`。
- 原片不套 LUT；视频代理、缩略图、预览图使用同一颜色变换。Sony RTMD 区分 S-Gamut3.Cine/S-Log3 与 S-Gamut3/S-Log3；DJI 只依据明确的颜色模式字段识别，缺字段可手动指定，不能以机型猜测 Log。
- 视频详情只在播放代理已成功套用 LUT 时以纯文本分行显示 `LUT:`、LUT 名称、色域/Log，名称取自实际生成记录；普通视频、未完成或失败的转换不显示提示。提示不提供设置跳转链接。

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


## Sony 存量回填

通过管理员 API `POST /api/admin/log-preview/rebuild`，请求体为 `{"sonyOnly": true}`，提交一个持久化后台扫描任务。它只扫描可用且未删除的 Sony 视频，依据元数据和默认规则匹配 LUT；已完成同版本视频及缩略图会跳过，重启后可重新扫描恢复。不会将所有 Sony 视频直接认定为 Log。

扫描任务按原生视频/缩略图队列容量逐步补充任务，每个队列的在途量达到 2 时等待，不修改全局并发参数。配置更新仅由 microservices 进程发起一次重建，避免 API 和后台进程重复排队。原片不变；旧预览在新文件完整生成后替换。

2026-10-30 的存量清单存于 NAS 私有目录 `/mnt/cache/appdata/immich-custom/backfills/sony-log-20261030/manifest.json`。只读进度统计：

```sh
python3 /mnt/user/code/immich/customizations/backfill_status.py --manifest /mnt/cache/appdata/immich-custom/backfills/sony-log-20261030/manifest.json
```

加 `--details` 可查看未完成素材和错误。只有目标 LUT 的视频和缩略图都完成才计入完成数。清单、状态、用户素材和第三方 LUT 不提交 Git。

## 本次验收边界

Sony 三段实片已验证 RTMD 自动识别、QSV 编码、Rec.709 标记、竖拍方向、原片校验和、完整视频的 Web 播放和缩略图。294 项相关单元回归通过，后续修改定向复测；新增的回填容量限制和恢复跳过测试通过。RAW 清理在 NAS Linux 上 15 项测试及原生处理器检查通过。

用户确认当前 Pocket 3 素材未用 D-Log M 拍摄，本次优先验收 Sony。Pocket 3 保留官方 LUT 和手动指定入口；现有文件没有能可靠读取的 Log 模式标记，自动识别优化等拿到 D-Log M 正样本和普通模式负样本后进行，不能拿 BT.709 标签或机型猜测。Sony 模式识别失败时同样不自动套 LUT。

本地 Web 的 TypeScript 检查、Svelte 检查和构建通过；项目现有 `tscompat/tscompat` ESLint 规则在锁定 TypeScript 6 环境中崩溃，局部 lint 临时关闭该规则后通过，没有改动仓库的规则配置。没有进行全库播放、手机本机播放或长期高负载稳定性验收。
