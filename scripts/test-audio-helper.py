#!/usr/bin/env python3
"""Test the local audio helper with fake commands and a private HOME/TMPDIR."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

helper = Path(sys.argv[1] if len(sys.argv) > 1 else Path.home() / '.local/bin/whatsapp-audio-setup').resolve()
subprocess.run(['/bin/bash', '-n', str(helper)], check=True)
with tempfile.TemporaryDirectory(prefix='wa-audio-helper-test-') as root:
    root = Path(root)
    root.chmod(0o700)
    home = root / 'home'
    home.mkdir(mode=0o700)
    models = home / '.local/share/piper-voices'
    models.mkdir(parents=True)
    for voice in ('ryan', 'lessac'):
        (models / f'en_US-{voice}-medium.onnx').write_bytes(b'mock model')
    bindir = root / 'bin'
    bindir.mkdir()
    tmp = root / 'tmp'
    tmp.mkdir(mode=0o700)
    log = root / 'events.jsonl'
    for name in ('mktemp', 'rm', 'grep'):
        (bindir / name).symlink_to(shutil.which(name))
    mock = r'''import json, os, pathlib, signal, stat, sys
name=pathlib.Path(sys.argv[0]).name
record={'command':name,'args':sys.argv[1:]}
if name=='piper':
    record['stdin']=sys.stdin.buffer.read().decode()
    output=pathlib.Path(sys.argv[sys.argv.index('-f')+1])
    record['parent_mode']=stat.S_IMODE(output.parent.stat().st_mode)
    if os.environ.get('PIPER_MODE')!='empty': output.write_bytes(b'mock wav')
    if output.exists(): record['file_mode']=stat.S_IMODE(output.stat().st_mode)
if name=='paplay':
    record['file_exists']=pathlib.Path(sys.argv[-1]).is_file()
with open(os.environ['MOCK_LOG'],'a') as f: f.write(json.dumps(record)+'\n')
if name=='pactl':
    print('1 WhatsAppVirtualMic')
elif name=='piper' and os.environ.get('PIPER_MODE')=='fail': sys.exit(17)
elif name=='paplay':
    if os.environ.get('PAPLAY_MODE')=='fail': sys.exit(19)
    if os.environ.get('PAPLAY_MODE')=='term': os.kill(os.getppid(),signal.SIGTERM)
elif name not in ('piper','paplay'): sys.exit(97)
'''
    for name in ('piper', 'paplay', 'pactl', 'chatterbox-tts', 'gtts-cli', 'speak'):
        executable = bindir / name
        executable.write_text('#!' + sys.executable + '\n' + mock)
        executable.chmod(0o700)
    env = {**os.environ, 'HOME': str(home), 'TMPDIR': str(tmp), 'PATH': str(bindir), 'MOCK_LOG': str(log)}
    for key in ('PIPER_MODE', 'PAPLAY_MODE'):
        env.pop(key, None)

    def run(text='hello', voice='lessac', extra=None, success=True):
        log.write_text('')
        result = subprocess.run(['/bin/bash', str(helper), 'speak', text, voice],
                                env={**env, **(extra or {})}, text=True, capture_output=True, timeout=8)
        rows = [json.loads(line) for line in log.read_text().splitlines()]
        assert (result.returncode == 0) == success, (result.returncode, result.stderr)
        assert not list(tmp.iterdir()), 'Temporary audio leaked'
        assert not any(r['command'] in ('chatterbox-tts', 'gtts-cli', 'speak') for r in rows), rows
        return result, rows

    paths = []
    for text in ('-n', '-e', r'line\ntext', 'first\nsecond', 'normal speech'):
        _, rows = run(text)
        piper = next(r for r in rows if r['command'] == 'piper')
        assert piper['stdin'] == text + '\n', piper
        assert 'en_US-lessac-medium.onnx' in piper['args'][1]
        assert piper['parent_mode'] == 0o700 and piper['file_mode'] == 0o600, piper
        paths.append(piper['args'][-1])
        assert next(r for r in rows if r['command'] == 'paplay')['file_exists']
    assert len(set(paths)) == len(paths)
    result, rows = run(extra={'PIPER_MODE': 'fail'}, success=False)
    assert result.returncode == 17 and all(r['command'] != 'paplay' for r in rows)
    result, _ = run(extra={'PAPLAY_MODE': 'fail'}, success=False)
    assert result.returncode == 19
    _, rows = run(extra={'PIPER_MODE': 'empty'}, success=False)
    assert all(r['command'] != 'paplay' for r in rows)
    result, _ = run(extra={'PAPLAY_MODE': 'term'}, success=False)
    assert result.returncode == 143, result
    _, rows = run(voice='missing', success=False)
    assert rows == []
    _, rows = run(voice='../ryan', success=False)
    assert rows == []
    _, rows = run(text='', success=False)
    assert rows == []
    (bindir / 'piper').rename(bindir / 'piper-unavailable')
    _, rows = run(success=False)
    assert rows == []
    print('PASS: 13 mocked cases and bash -n; no real audio commands or fallback.')
