#!/bin/bash
# Persistent family membership keeps replacement cleanup retryable after partial uploads.
set -e
ENV_LIB="$(dirname -- "${BASH_SOURCE[0]}")/env-file.sh"
[[ -f "$ENV_LIB" ]] || ENV_LIB="${EMBERVY_HOME:-/opt/embervy}/shared/scripts/env-file.sh"
. "$ENV_LIB"
EMBERVY_HOME="${EMBERVY_HOME:-$(embervy_home_default)}"; export EMBERVY_HOME
embervy_env_load "$EMBERVY_HOME/.env"
: "${RAG_URL:?RAG_URL is not set}"
export RAG_URL RAG_AUTH_TOKEN SPLIT_THRESHOLD PART_TARGET_SIZE
python3 - "${1:-}" <<'PY'
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

source = Path(sys.argv[1])
if not source.is_file() or not re.fullmatch(r'[A-Za-z0-9._-]+\.md', source.name):
    sys.exit('A valid Markdown file is required')
url = os.environ['RAG_URL'].rstrip('/')
base = source.name[:-3]
threshold = int(os.environ.get('SPLIT_THRESHOLD') or '81920')
target = int(os.environ.get('PART_TARGET_SIZE') or '80000')
state_dir = Path(os.environ['EMBERVY_HOME']) / 'state' / 'rag-families'
state_dir.mkdir(parents=True, exist_ok=True)
key = hashlib.sha256((url + '\n' + source.name).encode()).hexdigest()
state_path = state_dir / (key + '.json')
lock = open(state_dir / (key + '.lock'), 'a')
fcntl.flock(lock, fcntl.LOCK_EX)
token = os.environ.get('RAG_AUTH_TOKEN', '')
if '\r' in token or '\n' in token:
    sys.exit('Invalid bearer header')

def request(endpoint, args):
    # The inherited anonymous file keeps the header out of argv and leaves no named file.
    with tempfile.TemporaryFile(mode='w+') as headers:
        if token:
            headers.write('Authorization: Bearer ' + token + '\n')
        headers.flush()
        headers.seek(0)
        fd = headers.fileno()
        result = subprocess.run(['curl', '-sS', '--connect-timeout', '10', '--max-time', '120',
                                 '-w', '\n%{http_code}', '--header', '@/dev/fd/' + str(fd), url + endpoint, *args],
                                capture_output=True, text=True, pass_fds=(fd,))
    if result.returncode:
        raise RuntimeError('Request failed: ' + endpoint)
    body, _, status = result.stdout.rpartition('\n')
    return int(status), json.loads(body)

def save(state):
    # Atomic replacement preserves the last complete inventory when a write fails.
    with tempfile.NamedTemporaryFile(mode='w', dir=state_dir, delete=False) as out:
        temporary = out.name
        json.dump(state, out)
        out.flush()
        os.fsync(out.fileno())
    os.replace(temporary, state_path)
    fd = os.open(state_dir, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def cleanup(state):
    for name in list(state['pending']):
        status, body = request('/delete', ['-X', 'POST', '-H', 'Content-Type: application/json', '-d', json.dumps({'filename': name})])
        if not (status == 200 and body.get('success') is True or status == 404 and body.get('absent') is True):
            raise RuntimeError('Deletion incomplete; retry this family: ' + name)
        state['pending'].remove(name)
        state['members'] = [n for n in state['members'] if n != name]
        save(state)

try:
    family = re.compile(re.escape(base) + r'(?:_part\d+)?\.md')
    state = json.loads(state_path.read_text()) if state_path.exists() else {'members': [], 'pending': []}
    if not all(isinstance(state.get(k), list) and all(isinstance(n, str) and family.fullmatch(n) for n in state[k]) for k in ('members', 'pending')):
        raise RuntimeError('Invalid family inventory')
    # An unfinished delete runs before any upload can reuse its physical filename.
    cleanup(state)
    status, body = request('/list', [])
    if status != 200 or not isinstance(body.get('files'), list):
        raise RuntimeError('Cannot inventory the existing file family')
    old = set(state['members']) | {f['name'] for f in body['files'] if isinstance(f, dict) and isinstance(f.get('name'), str) and family.fullmatch(f['name'])}
    content = source.read_text() if source.stat().st_size > threshold else ''
    desired = {source.name: None}
    if source.stat().st_size > threshold and '\n---\n' in content:
        header, rest = content.split('\n---\n', 1)
        parts, current, size = [], [], len(header)
        for turn in re.split(r'\n---\n', rest):
            if not turn.strip():
                continue
            turn = '\n---\n' + turn
            if size + len(turn) > target and current:
                parts.append(current)
                current, size = [], len(header)
            current.append(turn)
            size += len(turn)
        if current:
            parts.append(current)
        if len(parts) > 1:
            title = base.replace('_', ' ')
            desired = {f'{base}_part{i:02d}.md': header.replace(f'# {title}', f'# {title} Part {i}') + ''.join(turns)
                       for i, turns in enumerate(parts, 1)}
    # Planned members survive even when the first upload loses its response.
    state['members'] = sorted(old | set(desired))
    save(state)
    with tempfile.TemporaryDirectory() as temporary:
        for name, text in desired.items():
            path = source
            if text is not None:
                path = Path(temporary) / name
                path.write_text(text)
            status, body = request('/upload', ['-X', 'POST', '-F', 'file=@' + str(path)])
            if status != 200 or body.get('success') is not True:
                raise RuntimeError('Upload incomplete; retry this family: ' + name)
            print('Uploaded: ' + name)
    state['pending'] = sorted(set(state['members']) - set(desired))
    save(state)
    cleanup(state)
    print('File family uploaded and cleanup complete.')
except Exception as error:
    sys.exit(str(error))
PY
