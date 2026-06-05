#!/usr/bin/env python3
import json, re
from pathlib import Path
from datetime import datetime, timezone
from collections import Counter, defaultdict

PROJECTS = Path.home() / ".claude/projects"
gap_start = datetime(2026, 5, 26, 2, 43, tzinfo=timezone.utc)
gap_end   = datetime(2026, 6,  4, 8, 52, tzinfo=timezone.utc)

gap_sessions = []
for jsonl in sorted(PROJECTS.rglob("*.jsonl")):
    if 'subagent' in str(jsonl): continue
    mtime = datetime.fromtimestamp(jsonl.stat().st_mtime, tz=timezone.utc)
    if not (gap_start <= mtime <= gap_end): continue
    events = []
    with open(jsonl, errors='replace') as f:
        for line in f:
            line = line.strip()
            if not line: continue
            try: events.append(json.loads(line))
            except: pass
    user_msgs = [e for e in events if e.get('type') == 'user']
    if not user_msgs: continue
    ts_str = user_msgs[0].get('timestamp', mtime.isoformat())
    try: ts = datetime.fromisoformat(ts_str.replace('Z','+00:00'))
    except: ts = mtime
    proj_dir = jsonl.parts[-2]

    tool_uses = []
    file_paths = []
    for e in events:
        if e.get('type') != 'assistant': continue
        content = e.get('message', {}).get('content', [])
        if not isinstance(content, list): continue
        for block in content:
            if not isinstance(block, dict): continue
            if block.get('type') != 'tool_use': continue
            tname = block.get('name', '')
            tool_uses.append(tname)
            inp = block.get('input', {})
            p = inp.get('path') or inp.get('file_path') or inp.get('command','')
            if p: file_paths.append(str(p)[:200])

    gap_sessions.append({
        'ts': ts,
        'project_dir': proj_dir,
        'path': jsonl,
        'user_turns': len(user_msgs),
        'tool_uses': Counter(tool_uses),
        'file_paths': file_paths,
        'events': events,
    })

print(f"Gap sessions: {len(gap_sessions)}")
print(f"Total user turns: {sum(s['user_turns'] for s in gap_sessions)}")

# Top tools
all_tools = Counter()
for s in gap_sessions:
    all_tools += s['tool_uses']
print("\nTop 25 tools used:")
for t, n in all_tools.most_common(25):
    print(f"  {n:5d}  {t}")

# Files/repos
repos = Counter(s['project_dir'] for s in gap_sessions)
print("\nTop repos during gap:")
for r, n in repos.most_common(15):
    clean = r.replace('-Users-joe-github-joeblackwaslike-','repo/').replace('-Users-joe-','~/')
    print(f"  {n:3d}  {clean}")

# Unique file paths sampled
all_files = []
for s in gap_sessions:
    all_files.extend(s['file_paths'])
file_exts = Counter()
for f in all_files:
    ext = Path(f).suffix.lower() if '.' in Path(f).name else '(none)'
    file_exts[ext] += 1
print("\nFile types touched:")
for ext, n in file_exts.most_common(20):
    print(f"  {n:5d}  {ext}")

# Daily breakdown
daily = defaultdict(int)
for s in gap_sessions:
    daily[s['ts'].date()] += s['user_turns']
print("\nDaily turns:")
for day in sorted(daily):
    print(f"  {day}  {daily[day]}")
