#!/usr/bin/env python3
"""通过现有 Compose 发布本仓库镜像；保留原媒体/数据库挂载，失败时回退配置。"""
import argparse
import copy
import hashlib
import json
import shlex
import subprocess
import time

import yaml

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='unraid')
    parser.add_argument('--image', required=True)
    parser.add_argument('--project', default='/boot/config/plugins/compose.manager/projects/immich')
    parser.add_argument('--backup', required=True, help='已完成数据库备份的私有目录')
    parser.add_argument('--check-only', action='store_true')
    args = parser.parse_args()
    ssh = ['ssh', '-T', '-o', 'RemoteCommand=none', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', args.host]

    def remote(command, data=None, timeout=120):
        return subprocess.run([*ssh, command], input=data, text=True, capture_output=True, check=True, timeout=timeout).stdout

    def compose(file=None):
        result = ['docker', 'compose', '--project-directory', args.project, '-f', args.project + '/docker-compose.yml',
                  '-f', file or args.project + '/docker-compose.override.yml']
        return shlex.join(result)

    original_path = args.project + '/docker-compose.override.yml'
    candidate_path = args.project + '/docker-compose.log-preview.candidate.yml'
    original = remote('cat ' + shlex.quote(original_path))
    original_sha = hashlib.sha256(original.encode()).hexdigest()
    before = json.loads(remote(compose() + ' config --format json'))
    service = next(name for name, value in before['services'].items() if value.get('container_name') == 'immich_server')
    override = yaml.safe_load(original)
    target = override.setdefault('services', {}).setdefault(service, {})
    target['image'] = args.image
    environment = target.setdefault('environment', {})
    if isinstance(environment, list):
        environment = dict(item.split('=', 1) for item in environment)
        target['environment'] = environment
    environment['IMMICH_LOG_PREVIEW_DIR'] = '/var/lib/immich-log-preview'

    def destination(volume):
        return volume.get('target') if isinstance(volume, dict) else volume.split(':')[1]

    volumes = target.setdefault('volumes', [])
    target['volumes'] = [v for v in volumes if destination(v) not in ['/opt/immich-raw-cleanup', '/var/lib/immich-log-preview']]
    target['volumes'].append('/mnt/cache/appdata/immich-custom/log-preview:/var/lib/immich-log-preview')
    candidate = yaml.safe_dump(override, allow_unicode=True, sort_keys=False)
    remote('umask 077; cat > ' + shlex.quote(candidate_path), candidate)
    after = json.loads(remote(compose(candidate_path) + ' config --format json'))

    # 校验合并后的有效配置，而不是只看改过的文本。
    expected = copy.deepcopy(before)
    expected_service = expected['services'][service]
    actual_service = after['services'][service]
    expected_service['image'] = args.image
    expected_service.setdefault('environment', {})['IMMICH_LOG_PREVIEW_DIR'] = '/var/lib/immich-log-preview'
    old_volumes = {v['target']: v for v in expected_service['volumes']}
    new_volumes = {v['target']: v for v in actual_service['volumes']}
    old_volumes.pop('/opt/immich-raw-cleanup', None)
    old_volumes.pop('/var/lib/immich-log-preview', None)
    new_state = new_volumes.pop('/var/lib/immich-log-preview')
    assert new_state['source'] == '/mnt/cache/appdata/immich-custom/log-preview'
    assert old_volumes == new_volumes, '发现非本任务挂载变化，停止发布'
    expected_service['volumes'] = actual_service['volumes']
    assert expected == after, '发现本任务以外的有效配置变化，停止发布'
    remote('test -s ' + shlex.quote(args.backup + '/immich.dump'))
    remote('docker image inspect ' + shlex.quote(args.image) + ' --format {{.Id}}')
    print(json.dumps({'validated': True, 'service': service, 'image': args.image,
                      'changes': ['服务镜像', 'RAW 代码改由同仓库镜像提供', '新增 LUT 持久化目录']}, ensure_ascii=False))
    if args.check_only:
        return
    remote('mkdir -p /mnt/cache/appdata/immich-custom/log-preview')
    remote('cp -p ' + shlex.quote(original_path) + ' ' + shlex.quote(args.backup + '/override-immediately-before.yml'))
    script = f'''set -eu
actual=$(sha256sum {shlex.quote(original_path)} | cut -d ' ' -f 1)
[ "$actual" = {shlex.quote(original_sha)} ] || {{ echo '配置被并发修改，停止发布' >&2; exit 1; }}
mv {shlex.quote(candidate_path)} {shlex.quote(original_path)}
'''
    remote('sh -s', script)
    try:
        remote(compose() + ' up -d --no-deps ' + shlex.quote(service), timeout=180)
        for _ in range(60):
            state = json.loads(remote('docker inspect immich_server --format "{{json .State}}"'))
            if state.get('Health', {}).get('Status') == 'healthy':
                print('Immich 新镜像健康检查通过')
                return
            if not state.get('Running'):
                raise RuntimeError('新容器未运行')
            time.sleep(2)
        raise TimeoutError('新镜像健康检查超时')
    except Exception:
        remote('umask 077; cat > ' + shlex.quote(original_path), original)
        remote(compose() + ' up -d --no-deps ' + shlex.quote(service), timeout=180)
        print('发布未通过，已恢复原 Compose 和镜像；需继续检查健康状态')
        raise

if __name__ == '__main__':
    main()
