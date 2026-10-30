#!/usr/bin/env python3
"""补偿已入库但后处理未完成的视频；只读数据库/原片，通过原生 API 排队。"""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request

STAGES = {
    'metadata': ('metadataExtraction', 'refresh-metadata'),
    'thumbnail': ('thumbnailGeneration', 'regenerate-thumbnail'),
    'video': ('videoConversion', 'transcode-video'),
}
QUERY = '''SELECT json_build_object(
 'id',a.id,'name',a."originalFileName",'path',a."originalPath",'createdAt',a."createdAt",
 'width',a.width,'height',a.height,'duration',a.duration,'metadataAt',j."metadataExtractedAt",
 'thumbhash',a.thumbhash IS NOT NULL,'video',row_to_json(v),'audio',row_to_json(u),'model',e.model,
 'files',(SELECT json_agg(json_build_object('type',f.type,'path',f.path)) FROM asset_file f
          WHERE f."assetId"=a.id AND NOT f."isEdited")
) FROM asset a LEFT JOIN asset_job_status j ON j."assetId"=a.id
 LEFT JOIN asset_video v ON v."assetId"=a.id LEFT JOIN asset_audio u ON u."assetId"=a.id
 LEFT JOIN asset_exif e ON e."assetId"=a.id
 WHERE a.type='VIDEO' AND a.status='active' AND a."deletedAt" IS NULL
 AND NOT a."isOffline" AND a.visibility<>'hidden'
 ORDER BY a."createdAt",a.id'''


def atomic_json(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    with temporary.open('w', encoding='utf-8') as out:
        os.chmod(temporary, 0o600)
        json.dump(value, out, ensure_ascii=False, indent=2)
        out.flush()
        os.fsync(out.fileno())
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def metadata_ready(asset):
    return bool(asset.get('metadataAt') and asset.get('width') and asset.get('height')
                and asset.get('duration') and asset.get('video'))


def file_ready(asset, kind):
    return any(f['type'] == kind and f.get('exists') and f.get('size', 0) > 0
               for f in asset.get('files') or [])


def initial_issue(asset):
    if not metadata_ready(asset):
        return 'metadata'
    if not asset.get('thumbhash') or not all(file_ready(asset, k) for k in ('thumbnail', 'preview')):
        return 'thumbnail'
    if any(f['type'] == 'encoded_video' and not f.get('exists') for f in asset.get('files') or []):
        return 'video'
    return None


def timestamp(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


class Native:
    def __init__(self):
        obj = self.command(['docker', 'inspect', 'immich_power_tools'], as_json=True)[0]
        env = dict(s.split('=', 1) for s in obj['Config']['Env'] if '=' in s)
        self.key = env['IMMICH_API_KEY']
        self.mounts = self.command(['docker', 'inspect', '-f', '{{json .Mounts}}', 'immich_server'], as_json=True)
        self.mounts.sort(key=lambda m: len(m['Destination']), reverse=True)
        self.config = self.api('/system-config')

    def safety(self):
        reasons = []
        if os.getloadavg()[0] >= 3.0:
            reasons.append('整机一分钟负载达到 3，等待回落')
        memory = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
        if int(memory['MemAvailable'].split()[0]) < 4 * 1024 * 1024:
            reasons.append('整机可用内存不足 4 GiB')
        for path in Path('/sys/class/thermal').glob('thermal_zone*/temp'):
            if int(path.read_text().strip()) >= 70_000:
                reasons.append('温度达到 70°C，等待冷却')
        obj = self.command(['docker', 'inspect', 'immich_server'], as_json=True)[0]['HostConfig']
        if not 0 < obj['NanoCpus'] <= 2_000_000_000 or not 0 < obj['Memory'] <= 4 * 1024**3:
            reasons.append('Immich 未满足 2 核 / 4 GiB 硬限制')
        ffmpeg = self.config['ffmpeg']
        if ffmpeg['accel'] != 'disabled' or ffmpeg['accelDecode'] or ffmpeg['threads'] != 1:
            reasons.append('自动恢复要求单线程纯软件处理')
        return reasons

    @staticmethod
    def command(args, input=None, timeout=60, as_json=False):
        result = subprocess.run(args, input=input, text=True, capture_output=True, timeout=timeout)
        if result.returncode:
            # 不回显可能包含密钥的命令或完整环境。
            raise RuntimeError(result.stderr[-1200:] or '命令执行失败')
        return json.loads(result.stdout) if as_json else result.stdout

    def api(self, path, body=None):
        req = urllib.request.Request('http://127.0.0.1:2283/api' + path,
              headers={'x-api-key': self.key, 'Content-Type': 'application/json'},
              data=None if body is None else json.dumps(body).encode())
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.loads(response.read() or 'null')

    def host_path(self, path):
        for mount in self.mounts:
            dest = mount['Destination']
            if path == dest or path.startswith(dest + '/'):
                return Path(mount['Source'] + path[len(dest):])
        raise ValueError('媒体路径没有匹配的 Immich 挂载')

    def assets(self):
        text = self.command(['docker', 'exec', 'immich_postgres', 'psql', '-X', '-U', 'postgres',
                             '-d', 'immich', '-Atc', QUERY])
        assets = [json.loads(line) for line in text.splitlines()]
        for asset in assets:
            for file in asset['files'] or []:
                try:
                    stat = self.host_path(file['path']).stat()
                    file.update(exists=True, size=stat.st_size)
                except FileNotFoundError:
                    file.update(exists=False, size=0)
        return assets

    def fingerprint(self, asset):
        stat = self.host_path(asset['path']).stat()
        raw = [asset['path'], stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns]
        return hashlib.sha256(json.dumps(raw).encode()).hexdigest()

    def probe(self, asset):
        result = subprocess.run(['docker', 'exec', 'immich_server', 'timeout', '30', 'ffprobe',
              '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height',
              '-of', 'json', asset['path']], capture_output=True, text=True, timeout=40)
        if result.returncode == 124:
            raise TimeoutError('原片探测超时')
        data = json.loads(result.stdout or '{}')
        if result.returncode or not any(s.get('codec_type') == 'video' and s.get('width', 0) > 0
                                       for s in data.get('streams', [])):
            return {'valid': False, 'reason': result.stderr[-1000:] or '容器没有有效视频流'}
        return {'valid': True}

    def required_video(self, asset):
        program = Path(__file__).with_name('decision.cjs').read_text()
        return self.command(['docker', 'exec', '-i', '-w', '/usr/src/app/server', 'immich_server',
                             'node', '-e', program], input=json.dumps({'asset': asset, 'config': self.config}),
                             timeout=120, as_json=True)['required']

    def queues(self):
        return self.api('/jobs')

    def submit(self, asset_id, stage):
        self.api('/assets/jobs', {'name': STAGES[stage][1], 'assetIds': [asset_id]})

    def libraries(self):
        return self.api('/libraries')

    def scan_library(self, ident):
        self.api('/libraries/' + ident + '/scan', {})


def recover(native, state, save, now, settle=120, max_jobs=1, dry_run=False, scan_libraries=False):
    reasons = native.safety()
    if reasons:
        return {'at': now, 'submitted': [], 'planned': [], 'states': {'blocked_resource': 1},
                'blocked': reasons}
    queues = native.queues()
    # 不能只限制单个队列：元数据、缩略图和转码共享 CPU、内存及磁盘。
    observed_queues = [q for q, _ in STAGES.values()] + ['library', 'sidecar']
    if any(any(queues.get(q, {}).get('jobCounts', {}).get(k, 0)
               for k in ('active', 'waiting', 'delayed', 'paused')) for q in observed_queues):
        return {'at': now, 'submitted': [], 'planned': [], 'states': {'waiting_media_pipeline': 1}}
    assets = native.assets()
    records = state.setdefault('assets', {})
    actions = []
    live_ids = {a['id'] for a in assets}
    for key, record in records.items():
        if key not in live_ids:
            record['status'] = 'excluded'  # 离线、隐藏、回收站或已删除；不自动恢复可见性。
    for asset in assets:
        issue = initial_issue(asset)
        record = records.get(asset['id'])
        is_new = timestamp(asset['createdAt']) >= state['enabledAt']
        if not issue and not record and not is_new:
            continue  # 历史完整视频不因缺少可选代理而被全库重转码。
        try:
            fingerprint = native.fingerprint(asset)
        except FileNotFoundError:
            records[asset['id']] = {'name': asset['name'], 'path': asset['path'], 'status': 'source_missing'}
            continue
        if not record or record.get('fingerprint') != fingerprint:
            record = {'name': asset['name'], 'path': asset['path'], 'fingerprint': fingerprint,
                      'seenAt': now, 'status': 'settling', 'attempts': {}}
            records[asset['id']] = record
        if record.get('status') == 'complete' and not issue:
            continue
        if record.get('status') in ('invalid_source', 'failed'):
            continue  # 原片变化后自动重审，原片未变不无限重复重试。
        if now - record['seenAt'] < settle or now < record.get('retryAt', 0):
            continue
        if not record.get('probeValid'):
            try:
                probe = native.probe(asset)
            except (TimeoutError, subprocess.TimeoutExpired) as error:
                record.update(status='retry', reason=str(error), retryAt=now + 3600)
                continue
            if not probe['valid']:
                record.update(status='invalid_source', reason=probe['reason'])
                continue
            record['probeValid'] = True
        if not metadata_ready(asset):
            stage = 'metadata'
        elif issue == 'thumbnail':
            stage = 'thumbnail'
        elif file_ready(asset, 'encoded_video'):
            record.update(status='complete', completedAt=now)
            record.pop('pending', None)
            continue
        elif native.required_video(asset):
            stage = 'video'
        else:
            record.update(status='complete', completedAt=now, video='not_required')
            record.pop('pending', None)
            continue
        queue = queues[STAGES[stage][0]]
        counts = queue['jobCounts']
        if queue['queueStatus']['isPaused'] or any(counts.get(k, 0) for k in ('active', 'waiting', 'delayed', 'paused')):
            record['status'] = 'waiting_queue'
            continue
        pending = record.get('pending')
        if pending and pending['stage'] == stage:
            if now - pending['at'] < 900:
                continue
            attempts = record['attempts'].get(stage, 0)
            record.pop('pending', None)
            record.update(status='failed' if attempts >= 3 else 'retry',
                          reason=stage + ' 任务结束后结果仍不完整', retryAt=now + 3600 * max(1, attempts))
            continue
        if len(actions) >= min(max_jobs, 1):
            continue
        if not dry_run:
            # 先落盘意图。进程退出或 HTTP 超时后仍能回读结果，不因重启遗忘。
            record['attempts'][stage] = record['attempts'].get(stage, 0) + 1
            record.update(status='pending', pending={'stage': stage, 'at': now})
            save(state)
            native.submit(asset['id'], stage)
            counts['waiting'] = counts.get('waiting', 0) + 1
        actions.append({'id': asset['id'], 'name': asset['name'], 'stage': stage})
    if scan_libraries and not actions and not any(
            queues.get(q, {}).get('queueStatus', {}).get('isPaused') for q in observed_queues):
        scans = state.setdefault('libraryLastScan', {})
        for library in native.libraries():
            if now - scans.get(library['id'], 0) < 900:
                continue
            if not dry_run:
                scans[library['id']] = now
                save(state)
                native.scan_library(library['id'])
            actions.append({'id': library['id'], 'name': library['name'], 'stage': 'library_scan'})
            break
    state['lastRunAt'] = now
    summary = {}
    for record in records.values():
        status = record.get('status', 'unknown')
        summary[status] = summary.get(status, 0) + 1
    if not dry_run:
        save(state)
    return {'at': now, 'examined': len(assets), 'submitted': [] if dry_run else actions,
            'planned': actions if dry_run else [], 'states': summary}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-dir', default='/mnt/cache/appdata/immich-custom/video-recovery/state')
    parser.add_argument('--settle-seconds', type=int, default=120)
    parser.add_argument('--max-jobs', type=int, default=1)
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--status', action='store_true')
    parser.add_argument('--retry', help='重新检查指定失败资产；不改变原片或资产可见性')
    parser.add_argument('--scan-libraries', action='store_true', help='空闲时每个外部库最多每 15 分钟扫描一次')
    args = parser.parse_args()
    folder = Path(args.state_dir)
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (folder / 'run.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        path = folder / 'state.json'
        state = json.loads(path.read_text()) if path.exists() else {'enabledAt': time.time(), 'assets': {}}
        if args.retry:
            if args.retry not in state['assets']:
                raise ValueError('状态中没有该资产')
            state['assets'].pop(args.retry)
            atomic_json(path, state)
            return
        if args.status:
            print(json.dumps(state, ensure_ascii=False, indent=2))
            return
        if (folder / 'paused').exists():
            print(json.dumps({'paused': True, 'submitted': [], 'states': {'paused': 1}}))
            return
        result = recover(Native(), state, lambda value: atomic_json(path, value), time.time(),
                         settle=args.settle_seconds, max_jobs=args.max_jobs, dry_run=args.dry_run,
                         scan_libraries=args.scan_libraries)
        if not args.dry_run:
            atomic_json(folder / 'summary.json', result)
        print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
