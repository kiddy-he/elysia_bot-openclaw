#!/usr/bin/env python3
"""Bounded local Elysia TTS; returns artifacts, never sends QQ messages."""
import argparse
from datetime import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import wave

PROJECT = Path('/root/GPT-SoVITS-local')
OUTPUTS = Path('/root/.openclaw/state/tts/elysia')
TIMEOUT = 900
MAX_CHARS = 200
RESOURCES = {
    'python': PROJECT / '.venv/bin/python',
    'entrypoint': PROJECT / 'local_deploy/run_elysia.py',
    'sovits': PROJECT / 'SoVITS_weights_v2ProPlus/elysia_expanded_v1_e4_s444.pth',
    'gpt': PROJECT / 'GPT_weights_v2ProPlus/elysia_expanded_v1-e5.ckpt',
    'reference': PROJECT / 'local_deploy/data/elysia_game_reference_v2.wav',
}


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def check():
    files = {name: path.is_file() for name, path in RESOURCES.items()}
    bins = {name: shutil.which(name) is not None for name in ('ffmpeg', 'ffprobe')}
    # R2 uses FFmpeg's librubberband filter, not a standalone rubberband binary.
    try:
        filters = subprocess.run(['ffmpeg', '-hide_banner', '-filters'], capture_output=True, text=True, timeout=10)
        rubberband = filters.returncode == 0 and any(' rubberband ' in line for line in filters.stdout.splitlines())
    except (OSError, subprocess.TimeoutExpired):
        rubberband = False
    return {'ok': all(files.values()) and all(bins.values()) and rubberband, 'resources': files, 'programs': bins,
            'ffmpeg_rubberband': rubberband,
            'preset': 'elysia-light-v1', 'timeout_seconds': TIMEOUT, 'max_text_chars': MAX_CHARS}


def stop_child(child):
    if child.poll() is None:
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()


def validate_audio(output):
    metadata = output.with_suffix('.json')
    report = json.loads(metadata.read_text(encoding='utf-8'))
    if report.get('preset') != 'elysia-light-v1' or report.get('output_sha256') != hashlib.sha256(output.read_bytes()).hexdigest():
        raise ValueError('metadata mismatch')
    with wave.open(str(output), 'rb') as audio:
        if (audio.getnchannels(), audio.getframerate(), audio.getsampwidth(), audio.getcomptype()) != (1, 32000, 2, 'NONE') or audio.getnframes() <= 0:
            raise ValueError('invalid audio format')
        duration = audio.getnframes() / audio.getframerate()
    return {'audio_output': str(output), 'raw_output': str(output.with_name('speech.raw.wav')),
            'metadata': str(metadata), 'duration_seconds': round(duration, 3),
            'sample_rate': 32000, 'channels': 1, 'preset': report['preset']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--check', action='store_true')
    source.add_argument('--text')
    source.add_argument('--text-file', type=Path)
    source.add_argument('--stdin', action='store_true')
    parser.add_argument('--split-method', choices=('cut0', 'cut3', 'cut5'), default='cut3')
    args = parser.parse_args()
    if args.check:
        result = check()
        emit(result)
        return 0 if result['ok'] else 1
    try:
        if args.text_file:
            # Limit reads before decoding large documents, not after loading them.
            with args.text_file.open('rb') as handle:
                text = handle.read(MAX_CHARS * 4 + 4).decode('utf-8-sig')
        elif args.stdin:
            text = sys.stdin.read(MAX_CHARS + 1)
        else:
            text = args.text
        text = text.strip()
        if not text or len(text) > MAX_CHARS or '\x00' in text:
            raise ValueError('invalid text')
    except (OSError, UnicodeError, ValueError):
        emit({'ok': False, 'reason': 'invalid_text', 'max_text_chars': MAX_CHARS})
        return 1
    readiness = check()
    if not readiness['ok']:
        emit({'ok': False, 'reason': 'missing_resources', 'check': readiness})
        return 1
    OUTPUTS.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Never unlink this lock: all invocations must keep using the same inode.
    with (OUTPUTS / '.generation.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            emit({'ok': False, 'reason': 'busy'})
            return 1
        task = Path(tempfile.mkdtemp(prefix=datetime.now().strftime('%Y%m%d-%H%M%S-'), dir=OUTPUTS))
        text_file = task / 'input.txt'
        text_file.write_text(text, encoding='utf-8')
        text_file.chmod(0o600)
        output, logfile = task / 'speech.wav', task / 'generation.log'
        command = [str(RESOURCES['python']), str(RESOURCES['entrypoint']), '--text-file', str(text_file),
                   '--output', str(output), '--split-method', args.split_method]
        env = os.environ.copy()
        for name in ('OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS'):
            env[name] = '6'
        child = None
        try:
            with logfile.open('wb') as log:
                child = subprocess.Popen(command, cwd=PROJECT, env=env, stdin=subprocess.DEVNULL,
                                         stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                child.wait(timeout=TIMEOUT)
            if child.returncode != 0:
                emit({'ok': False, 'reason': 'generation_failed', 'log': str(logfile)})
                return 1
            result = validate_audio(output)
            emit({'ok': True, **result, 'log': str(logfile)})
            return 0
        except subprocess.TimeoutExpired:
            stop_child(child)
            emit({'ok': False, 'reason': 'generation_timeout', 'log': str(logfile)})
            return 1
        except (KeyboardInterrupt, SystemExit):
            if child is not None:
                stop_child(child)
            raise
        except (OSError, ValueError, wave.Error):
            if child is not None:
                stop_child(child)
            emit({'ok': False, 'reason': 'output_validation_failed', 'log': str(logfile)})
            return 1


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    sys.exit(main())
