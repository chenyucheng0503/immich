#!/usr/bin/env python3
"""读取 Sony 回填清单和持久化结果；不修改素材、不提交或重试任务。"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--state-dir', default='/mnt/cache/appdata/immich-custom/log-preview')
    parser.add_argument('--details', action='store_true')
    args = parser.parse_args()
    manifest = json.loads(Path(args.manifest).read_text())
    counts = Counter()
    details = []
    for item in manifest['items']:
        states = []
        for kind in ['video', 'thumbnail']:
            path = Path(args.state_dir) / 'assets' / item['id'] / f'{kind}.json'
            states.append(json.loads(path.read_text()) if path.exists() else {})
        if any(state.get('status') == 'failed' for state in states):
            status = 'failed'
        elif all(state.get('status') == 'complete' and state.get('lutId') == item['lutId'] for state in states):
            status = 'complete'
        elif any(state.get('status') == 'processing' for state in states):
            status = 'processing'
        elif any(state.get('status') == 'queued' for state in states):
            status = 'queued'
        else:
            status = 'pending'
        counts[status] += 1
        if status != 'complete':
            details.append({'id': item['id'], 'fileName': item['fileName'], 'status': status,
                            'errors': [state['error'] for state in states if state.get('error')]})
    result = {'checkedAt': datetime.now(timezone.utc).isoformat(), 'total': len(manifest['items']),
              **{key: counts[key] for key in ['complete', 'processing', 'queued', 'pending', 'failed']}}
    if args.details:
        result['unfinished'] = details
    print(json.dumps(result, ensure_ascii=False))

if __name__ == '__main__':
    main()
