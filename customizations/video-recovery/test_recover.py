import copy
import unittest
import tempfile
from pathlib import Path

from recover import recover, has_video_stream, quarantine_corrupt_cache


def asset(**values):
    result = {'id': 'one', 'name': 'one.mp4', 'path': '/extlib/one.mp4',
              'createdAt': '2026-01-01T00:00:00Z', 'metadataAt': None, 'width': None,
              'height': None, 'duration': None, 'video': None, 'thumbhash': False, 'files': []}
    result.update(values)
    return result


def complete_metadata(value):
    value.update(metadataAt='2026-01-02T00:00:00Z', width=1920, height=1080, duration=1000, video={})
    value['video'] = {'codecName': 'h264'}


def complete_thumbs(value):
    value['thumbhash'] = True
    value['files'] = [{'type': k, 'exists': True, 'size': 10} for k in ('thumbnail', 'preview')]


class Fake:
    def __init__(self, rows):
        self.rows = rows
        self.sent = []
        self.valid = True
        self.required = True
        self.fp = 'same'
        self.blocked = []
        self.q = {k: {'queueStatus': {'isPaused': False},
                      'jobCounts': {'active': 0, 'waiting': 0, 'failed': 0}}
                  for k in ['metadataExtraction', 'thumbnailGeneration', 'videoConversion']}

    def assets(self): return copy.deepcopy(self.rows)
    def safety(self): return self.blocked
    def queues(self): return copy.deepcopy(self.q)
    def fingerprint(self, _): return self.fp
    def probe(self, _): return {'valid': self.valid, 'reason': 'no video stream'}
    def required_video(self, _): return self.required
    def submit(self, ident, stage): self.sent.append((ident, stage))
    def libraries(self): return [{'id': 'library-one', 'name': 'Library'}]
    def scan_library(self, ident): self.sent.append((ident, 'library_scan'))


class RecoveryTests(unittest.TestCase):
    def test_quarantine_preserves_bad_cache_and_leaves_user_settings(self):
        ident = 'afa4b921-abdf-4185-9f63-2904b9f7d302'
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / 'assets' / ident
            folder.mkdir(parents=True)
            (folder / 'detection.json').write_text('')
            (folder / 'video.json').write_text('{"revision":"valid"}')
            (folder / 'override.json').write_text('{broken')
            backups = quarantine_corrupt_cache(root, ident)
            self.assertEqual(len(backups), 1)
            self.assertEqual(Path(backups[0]).read_bytes(), b'')
            self.assertFalse((folder / 'detection.json').exists())
            self.assertEqual((folder / 'video.json').read_text(), '{"revision":"valid"}')
            self.assertEqual((folder / 'override.json').read_text(), '{broken')
            self.assertEqual(quarantine_corrupt_cache(root, ident), [])

    def setUp(self):
        self.state = {'enabledAt': 2_000_000_000, 'assets': {}}
        self.saves = []

    def run_once(self, fake, now=10_000, **options):
        return recover(fake, self.state, lambda s: self.saves.append(copy.deepcopy(s)), now,
                       settle=options.pop('settle', 0), **options)

    def test_pipeline_checks_results_before_advancing(self):
        a = asset(); f = Fake([a])
        self.run_once(f)
        self.assertEqual(f.sent, [('one', 'metadata')])
        self.run_once(f, now=10_001)
        self.assertEqual(len(f.sent), 1)
        complete_metadata(a); self.run_once(f, now=10_002)
        self.assertEqual(f.sent[-1], ('one', 'thumbnail'))
        complete_thumbs(a); self.run_once(f, now=10_003)
        self.assertEqual(f.sent[-1], ('one', 'video'))
        a['files'].append({'type': 'encoded_video', 'exists': True, 'size': 100})
        self.run_once(f, now=10_004)
        self.assertEqual(self.state['assets']['one']['status'], 'complete')
        self.run_once(f, now=10_005)
        self.assertEqual(len(f.sent), 3)

    def test_corrupt_source_stays_blocked_until_fingerprint_changes(self):
        f = Fake([asset()]); f.valid = False
        self.run_once(f); f.valid = True
        self.run_once(f, now=20_000)
        self.assertFalse(f.sent)
        f.fp = 'replaced'
        self.run_once(f, now=20_001)
        self.assertEqual(f.sent, [('one', 'metadata')])

    def test_unfinished_copy_waits_for_stable_fingerprint(self):
        f = Fake([asset()])
        self.run_once(f, now=0, settle=120)
        f.fp = 'growing'; self.run_once(f, now=100, settle=120)
        self.run_once(f, now=150, settle=120)
        self.assertFalse(f.sent)
        self.run_once(f, now=221, settle=120)
        self.assertEqual(len(f.sent), 1)

    def test_paused_or_busy_queues_are_respected(self):
        f = Fake([asset()]); f.q['metadataExtraction']['queueStatus']['isPaused'] = True
        self.run_once(f); self.assertFalse(f.sent)
        f.q['metadataExtraction']['queueStatus']['isPaused'] = False
        f.q['metadataExtraction']['jobCounts']['active'] = 1
        self.run_once(f, now=20_000); self.assertFalse(f.sent)

    def test_no_optional_preview_backfill_for_healthy_historical_assets(self):
        a = asset(); complete_metadata(a); complete_thumbs(a)
        f = Fake([a]); self.run_once(f)
        self.assertFalse(f.sent)
        self.assertEqual(self.state['assets'], {})

    def test_new_asset_uses_native_transcode_decision(self):
        a = asset(createdAt='2040-01-01T00:00:00Z'); complete_metadata(a); complete_thumbs(a)
        f = Fake([a]); f.required = False
        self.run_once(f)
        self.assertFalse(f.sent)
        self.assertEqual(self.state['assets']['one']['video'], 'not_required')

    def test_lost_job_retries_with_backoff_and_survives_restart(self):
        f = Fake([asset()]); self.run_once(f)
        self.state = copy.deepcopy(self.saves[-1])
        self.run_once(f, now=11_000)
        self.assertEqual(len(f.sent), 1)
        self.assertEqual(self.state['assets']['one']['status'], 'retry')
        self.run_once(f, now=14_601)
        self.assertEqual(len(f.sent), 2)

    def test_repeated_failure_stops_after_three_submissions(self):
        f = Fake([asset()]); now = 10_000
        for attempt in range(3):
            self.run_once(f, now=now)
            self.run_once(f, now=now+1000)
            now += 1000 + 3600 * (attempt+1) + 1
        self.run_once(f, now=now+100_000)
        self.assertEqual(len(f.sent), 3)
        self.assertEqual(self.state['assets']['one']['status'], 'failed')

    def test_deleted_or_hidden_asset_no_longer_scheduled(self):
        f = Fake([asset()]); self.run_once(f)
        f.rows = []; self.run_once(f, now=20_000)
        self.assertEqual(self.state['assets']['one']['status'], 'excluded')
        self.assertEqual(len(f.sent), 1)

    def test_failed_http_has_persisted_intent(self):
        f = Fake([asset()])
        def fail(*_): raise RuntimeError('network timeout')
        f.submit = fail
        with self.assertRaises(RuntimeError): self.run_once(f)
        self.assertEqual(self.saves[-1]['assets']['one']['pending']['stage'], 'metadata')

    def test_dry_run_does_not_submit_or_save(self):
        f = Fake([asset()]); self.run_once(f, dry_run=True)
        self.assertFalse(f.sent); self.assertFalse(self.saves)

    def test_any_busy_media_queue_blocks_other_stages(self):
        f = Fake([asset()]); f.q['videoConversion']['jobCounts']['active'] = 1
        self.run_once(f)
        self.assertFalse(f.sent)
        self.assertFalse(self.state['assets'])

    def test_resource_gate_blocks_even_with_empty_queues(self):
        f = Fake([asset()]); f.blocked = ['温度过高']
        result = self.run_once(f)
        self.assertEqual(result['blocked'], ['温度过高'])
        self.assertFalse(f.sent)

    def test_only_one_stage_globally_is_submitted_per_run(self):
        a = asset(id='two'); complete_metadata(a)
        f = Fake([asset(), a]); self.run_once(f, max_jobs=20)
        self.assertEqual(f.sent, [('one', 'metadata')])

    def test_library_discovery_is_rate_limited_and_persistent(self):
        f = Fake([])
        self.run_once(f, now=10_000, scan_libraries=True)
        self.run_once(f, now=10_899, scan_libraries=True)
        self.assertEqual(len(f.sent), 1)
        self.state = copy.deepcopy(self.saves[-1])
        self.run_once(f, now=10_901, scan_libraries=True)
        self.assertEqual(len(f.sent), 2)

    def test_library_scan_respects_empty_but_paused_media_queue(self):
        f = Fake([]); f.q['videoConversion']['queueStatus']['isPaused'] = True
        self.run_once(f, scan_libraries=True)
        self.assertFalse(f.sent)

    def test_busy_library_does_not_overlap_recovery(self):
        f = Fake([asset()])
        f.q['library'] = {'queueStatus': {'isPaused': False}, 'jobCounts': {'active': 1}}
        self.run_once(f, scan_libraries=True)
        self.assertFalse(f.sent)

    def test_attached_cover_is_not_a_video(self):
        self.assertFalse(has_video_stream({'format': {'duration': '10'}, 'streams': [
            {'codec_type': 'video', 'width': 1280, 'height': 720, 'disposition': {'attached_pic': 1}}]}))

    def test_empty_video_track_is_rejected(self):
        self.assertFalse(has_video_stream({'streams': [
            {'codec_type': 'video', 'width': 1920, 'height': 1080, 'duration': 'N/A'}]}))

    def test_normal_video_uses_container_duration(self):
        self.assertTrue(has_video_stream({'format': {'duration': '0.1'}, 'streams': [
            {'codec_type': 'video', 'width': 1920, 'height': 1080, 'disposition': {'attached_pic': 0}}]}))


if __name__ == '__main__':
    unittest.main()
