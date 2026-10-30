# Sony 创意外观自动标注

Immich v3.2.4 原生工作流 → 本服务 → 读取原片 Sony MakerNotes → 更新 Immich 描述 → 原生 SidecarWrite → 回读验证。与 RAW 清理、LUT 预览在同一仓库维护，独立容器运行，不替换 Immich 服务镜像。

## 行为

- 仅处理 `IMAGE`、`ILCE-7CM2`，标准外观使用 ST/PT/NT/VV/VV2/FL/IN/SH/BW/SE。六个新增外观和未知标记跳过。
- 空描述写纯缩写；相同外观的旧全称转换为缩写；普通文案末尾追加独立缩写行；不同外观标签、磁盘与数据库冲突进入 conflict。
- 读取原片与旁车，不自行写原片或 XMP，不修改 MakerNotes、Lightroom 配置。原片挂载只读，写入由 Immich 的 `asset.update` API 完成。
- 数据库成功而旁车未落盘不计完成。每张记录持久化原/目标描述、原旁车字节、源文件标识、外观值、规则版本和重试状态。
- 已处理任务重复触发不重新覆盖用户后续描述。元数据未就绪、离线、写入延迟等退避重试，8 次后 failed；冲突不会自动重试。
- 每 5 分钟增量补漏，分页和游标事务持久化。自动处理按入库时间；显式历史批次按 Immich `localDateTime` 的拍摄日期，结束日期不包含在内。
- 现有多语言旁车、同名 RAW/JPEG 共用的短文件名旁车、重复旁车候选保留并报告冲突。原生 API 没有条件更新，极短窗口内的人工并发修改仍存在竞争风险。

## 构建与配置

在本目录执行 Docker build；基底固定为当前官方 Immich v3.2.4 镜像摘要，复用其中 Node.js 24 和 ExifTool 13.59。用提交号作为镜像 tag，并通过 build 的 `--label org.opencontainers.image.revision=<commit>` 记录来源。

`compose.yaml` 是当前 NAS 的独立部署配置，`SONY_LOOK_IMAGE` 必须指定构建后的镜像。启动前核对媒体挂载仍与运行中的 Immich 一致；不把凭据写入仓库。

私有配置 `/mnt/cache/appdata/immich-custom/sony-creative-look/config.private.json` 包含：

| 字段 | 值/用途 |
| --- | --- |
| apiUrl | `http://immich_server:2283/api` |
| apiKey | 目标用户专用密钥，仅 `asset.read`、`asset.update` |
| ownerId | 工作流所属用户 ID |
| webhookSecret | 随机独立密钥 |
| enabledAt | 明确的 UTC 开始时间，不能每次启动重设 |
| roots | `["/data", "/extlib", "/extlib2"]` |

私有配置和 state 目录由容器 UID 99、GID 100 读取/写入；配置权限 0600。独立 Compose 项目可放入 Unraid Compose Manager 的 `immich-sony-look` 项目，启用自动启动。容器没有宿主端口，不需要 Docker socket 或数据库密码；限制 0.5 CPU 和 512 MiB。

工作流：触发器 `AssetMetadataExtraction`；依次执行 `immich-plugin-core#assetTypeFilter`（IMAGE）、`#assetExifFilter`（model 精确匹配 ILCE-7CM2）、`#webhook`。Webhook URL 为 `http://immich-sony-look:8787/webhook`，鉴权头 `x-sony-look-key`。仅持久化任务后返回 202。不要把工作流配置中密钥输出到日志。

## 操作

```sh
# 状态只读
docker exec immich_sony_look node /opt/sony-creative-look/service.cjs status
# 2026-10-22 至 2026-10-30 拍摄的照片，后台扫描、逐张处理
docker exec immich_sony_look node /opt/sony-creative-look/service.cjs backfill 2026-10-22 2026-10-31
# 查询指定批次
docker exec immich_sony_look node /opt/sony-creative-look/service.cjs status <batch-id>
# 安全暂停/继续；已在进行的单张任务会结束
docker exec immich_sony_look node /opt/sony-creative-look/service.cjs pause
docker exec immich_sony_look node /opt/sony-creative-look/service.cjs resume
# 仅重试 failed/retry，保留原始意图并重新检查人工修改
docker exec immich_sony_look node /opt/sony-creative-look/service.cjs retry <asset-id>
```

备份 state 中的 SQLite 及其 WAL 时使用 SQLite 在线备份或先停止本容器。停用工作流并停止本容器即可停止自动处理；既有 XMP 继续可用。回退描述时须根据 intent 校验当前值仍为该任务写入值，再通过 Immich API 恢复原描述；不得整文件覆盖后来新增的其他 XMP 内容或删除整个旁车。

## 验证

`node --test core.test.cjs` 覆盖映射、范围、人工描述、冲突、幂等、API 成功但未落盘、请求超时后的恢复、原片替换和重启游标。上线还需完成真实 A7C2 写入回读、新导入工作流、元数据重提取和原片哈希验证；单元检查不能替代这些验收。

2026-10-30：14 项针对性检查通过。京都真实 JPG 已验证 Portrait→PT、两个 XMP 描述字段、Immich 信息面板显示及元数据重提取后保持一致，原片 SHA-256 不变。独立生成测试图并复制相机元数据后上传，验证原生工作流自动触发并完成写入，随后通过 Immich API 删除该测试资产。没有重启或替换原 Immich/LUT 容器。RAW、HEIF 的实片覆盖，以及那六个新增自定义外观不在本次验收结论内。
