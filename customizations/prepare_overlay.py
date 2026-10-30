#!/usr/bin/env python3
"""本地完成官方 pnpm 构建后，整理可在 NAS 上构建的小体积镜像上下文。"""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'customizations/build'

def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args], text=True).strip()

def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    paths = set(git('diff', '--name-only', 'v3.2.4', '--', 'server/src').splitlines())
    paths.update(git('ls-files', '--others', '--exclude-standard', 'server/src').splitlines())
    manifest = {}
    for name in sorted(paths):
        if not name.endswith('.ts') or name.endswith('.spec.ts'):
            continue
        relative = Path(name).relative_to('server/src').with_suffix('.js')
        source = ROOT / 'server/dist' / relative
        if not source.is_file():
            raise RuntimeError(f'缺少编译产物：{source}')
        target = OUT / 'overlay/server/dist' / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        manifest[str(relative)] = hashlib.sha256(source.read_bytes()).hexdigest()
    if not manifest:
        raise RuntimeError('没有检测到服务端改动')
    shutil.copytree(ROOT / 'web/build', OUT / 'overlay/www')
    shutil.copytree(ROOT / 'customizations/raw-cleanup', OUT / 'raw-cleanup')
    shutil.copy2(ROOT / 'customizations/Dockerfile', OUT / 'Dockerfile')
    (OUT / 'build-manifest.json').write_text(json.dumps({
        'base': 'v3.2.4', 'commit': git('rev-parse', 'HEAD'),
        'dirty': bool(git('status', '--porcelain')), 'modules': manifest,
    }, indent=2) + '\n')
    print(OUT)

if __name__ == '__main__':
    main()
