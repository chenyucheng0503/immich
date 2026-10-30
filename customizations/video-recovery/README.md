# 视频后处理补偿

用于 Immich 3.2.4 定制部署：已入库视频的元数据、缩略图或播放预览漏处理时，通过原生资产任务 API 补偿。数据库查询和媒体读取均为只读，不改原片、不删除资产、不重建资产 ID。

## 范围与限制

- 查询在线、active、未删除、非 hidden 的视频。Live Photo 的隐藏视频不要求独立缩略图。
- 历史视频只处理元数据不完整、缩略图/预览缺失或已登记代理丢失的记录。历史完整视频没有代理，不自动触发全库转码。
- 启用后新增视频还会核对播放预览。是否需要转码由运行镜像自身的 MediaService 和 LogPreviewRepository 决定，沿用当前编码、音频、容器和 LUT 配置。
- 等源文件的路径、inode、大小和修改时间至少两轮稳定后再探测；无有效视频流的文件记为 invalid_source，原片变化后自动重新检查。无法恢复已经丢失的字节。
- 按元数据 → 缩略图 → 视频顺序回读实际结果。三个媒体队列合计只允许本补偿放行一个任务；任一媒体队列有 active/waiting/delayed/paused 任务时整轮等待。
- 放行前要求主服务已有限制（最多 2 核、4 GiB），FFmpeg 为单线程纯软件处理；整机一分钟负载低于 3、可用内存至少 4 GiB、温度低于 70°C。条件不满足时只报告，不探测原片或提交任务。硬限制负责约束正在执行的任务，准入检查负责停止新增；不代表能够排除硬件或内核故障。
- 意图在 API 请求前原子落盘，任务结果未出现时退避重试，每阶段最多三次；持续失败记录在 state.json，不无限循环。`--retry <资产 ID>` 可在处理外部故障后手工重试。
- 调度间隔五分钟，手机直接上传仍走原生处理；本程序是补漏，不保证损坏、离线或无权限的原片可识别。
- 提交任务前检查该资产的 Log 自动识别和处理缓存。损坏 JSON 以 `.corrupt-时间戳` 留存后重新生成；不修改单片覆盖配置或用户 LUT。
- `--scan-libraries` 启用低负载发现：每个外部库最多每 15 分钟调用一次原生扫描 API；媒体、图库或旁车队列忙/暂停时等待，已有待补偿资产优先。适用于关闭持续实时监听的大图库；NAS 上使用此模式时关闭原生固定扫描，避免重复调度。手机直接上传仍走原生导入流程。

## 部署

运行于 Unraid 宿主机 Python 3，使用现有 Docker 管理权限。API 密钥在内存中读取现有 `immich_power_tools` 容器配置，不写入代码、参数或日志；使用其现有 API 权限。没有新增监听端口或上传用户媒体。

将 `recover.py` 和 `decision.cjs` 发布至 `/mnt/cache/appdata/immich-custom/video-recovery/releases/<提交号>/`，`current` 指向该版本。状态目录为同级 `state/`，不要随代码升级清空。

Unraid 持久化 cron 文件 `/boot/config/plugins/dynamix/immich-video-recovery.cron`：

```cron
*/5 * * * * test ! -f /mnt/cache/appdata/immich-custom/video-recovery/current/recover.py || /usr/bin/python3 /mnt/cache/appdata/immich-custom/video-recovery/current/recover.py --scan-libraries >> /mnt/cache/appdata/immich-custom/video-recovery/state/run.log 2>&1
```

执行 `bash /usr/local/sbin/update_cron` 使其生效（部分 Unraid 版本的脚本 shebang 不正确）。查看 `state/summary.json` 或运行 `recover.py --status`。创建 `state/paused` 暂停补偿，删除此文件恢复；不暂停用户现有 Immich 队列。`--dry-run --settle-seconds 0` 只读预检，不提交任务或保存状态。

队列还应把 Valkey `/data` 挂载到持久化目录并使用 `appendonly yes`、`appendfsync everysec`。迁移前停生产者、等待后台任务结束、启用 AOF 并确认重写成功、SAVE，再停止 Valkey 复制其全部 `/data`；不能给空目录直接开启 AOF 而丢失旧队列。容器重建后核对所有队列长度、暂停状态和健康状态，再恢复生产者。

回退本补偿：移除该 cron 文件后运行 update_cron，保留状态和原片。队列持久化目录应继续保留；不能用撤销挂载的方式清空工作队列。

## 验证

```sh
python3 -m unittest -v test_recover.py
```

覆盖处理顺序、结果回读、重复运行、损坏原片隔离、文件稳定性、暂停/拥堵队列、无需转码、新资产、任务丢失、重启状态、重试上限、资产删除/隐藏和 HTTP 超时后的意图保留。上线另需验证运行镜像的原生策略兼容性、真实漏处理视频、新导入测试视频及补偿效果。升级 Immich 后需重新验证私有原生方法接口；不兼容会报错停止本轮，不猜测转码策略。
