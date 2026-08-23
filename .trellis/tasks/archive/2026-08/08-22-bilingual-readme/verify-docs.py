#!/usr/bin/env python3
import json, re, sys
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[3]
errors: list[str] = []

def fail(msg: str) -> None: errors.append(msg)

def anchors(text: str) -> set[str]:
    out, seen = set(), {}
    for line in text.splitlines():
        m = re.match(r'^(#{1,6})\s+(.+?)\s*#*$', line)
        if not m: continue
        title = re.sub(r'<[^>]+>', '', m.group(2))
        title = re.sub(r'[`*_~]', '', title).strip().lower()
        slug = re.sub(r'[^\w\-\s\u4e00-\u9fff]', '', title, flags=re.UNICODE)
        slug = re.sub(r'\s+', '-', slug).strip('-')
        n = seen.get(slug, 0); seen[slug] = n + 1
        out.add(slug if n == 0 else f'{slug}-{n}')
    return out

roots = [ROOT/'README.md', ROOT/'README.zh-CN.md']
root_texts = [p.read_text() for p in roots]
for p, text in zip(roots, root_texts):
    n = len(text.splitlines())
    if n > 300: fail(f'{p.relative_to(ROOT)} has {n} lines (>300)')
    for literal in ('docs/images/welcome.png', 'Node.js-%3E%3D20.3.0', 'TypeScript-7.0.2', 'Strands_Agents_SDK-1.12.0', 'License-ISC'):
        if literal not in text: fail(f'{p.relative_to(ROOT)} header lacks {literal}')
root_levels = [[len(m.group(1)) for m in re.finditer(r'^(#{1,6})\s', text, re.M)] for text in root_texts]
if root_levels[0] != root_levels[1]: fail(f'root README heading levels differ: {root_levels}')
if 'README.zh-CN.md' not in root_texts[0] or 'README.md' not in root_texts[1]:
    fail('root README language navigation is not reciprocal')
root_fences = [len(re.findall(r'^```', text, re.M)) for text in root_texts]
if root_fences[0] != root_fences[1] or any(count % 2 for count in root_fences):
    fail(f'root README fenced-block structure differs or is unbalanced: {root_fences}')

expected = {'README.md','getting-started.md','using-darwin.md','configuration.md','sessions-and-state.md','permissions.md','extensions.md','reference.md','development.md'}
guide = ROOT/'docs/user-guide'
en = {p.name for p in guide.glob('*.md') if not p.name.endswith('.zh-CN.md')}
zh = {p.name.removesuffix('.zh-CN.md')+'.md' for p in guide.glob('*.zh-CN.md')}
if en != expected: fail(f'English guide set mismatch: {sorted(en ^ expected)}')
if zh != expected: fail(f'Chinese guide set mismatch: {sorted(zh ^ expected)}')

for name in sorted(expected):
    ep, zp = guide/name, guide/(name.removesuffix('.md')+'.zh-CN.md')
    et, zt = ep.read_text(), zp.read_text()
    if zp.name not in et: fail(f'{ep.relative_to(ROOT)} lacks reciprocal Chinese link')
    if ep.name not in zt: fail(f'{zp.relative_to(ROOT)} lacks reciprocal English link')
    eh = [len(m.group(1)) for m in re.finditer(r'^(#{1,6})\s', et, re.M)]
    zhlev = [len(m.group(1)) for m in re.finditer(r'^(#{1,6})\s', zt, re.M)]
    if eh != zhlev: fail(f'heading levels differ: {ep.name} {eh} vs {zp.name} {zhlev}')
    ef, zf = len(re.findall(r'^```', et, re.M)), len(re.findall(r'^```', zt, re.M))
    if ef % 2 or zf % 2: fail(f'unbalanced fence: {ep.name}/{zp.name}')
    if ef != zf: fail(f'fence counts differ: {ep.name}={ef}, {zp.name}={zf}')

changed_md = roots + sorted(guide.glob('*.md'))
link_re = re.compile(r'(?<!!)\[[^\]]*\]\(([^)]+)\)|<img\s+[^>]*src="([^"]+)"', re.I)
for p in changed_md:
    text = p.read_text(); own = anchors(text)
    for m in link_re.finditer(text):
        raw = (m.group(1) or m.group(2)).strip().split()[0]
        if raw.startswith(('http://','https://','mailto:')): continue
        target, _, frag = raw.partition('#'); frag = unquote(frag)
        dest = (p.parent / unquote(target)).resolve() if target else p.resolve()
        try: dest.relative_to(ROOT.resolve())
        except ValueError: fail(f'{p.relative_to(ROOT)} link escapes repo: {raw}'); continue
        if not dest.exists(): fail(f'{p.relative_to(ROOT)} broken link: {raw}'); continue
        if frag:
            if dest.is_dir(): dest = dest/'README.md'
            if dest.suffix.lower() == '.md' and frag not in anchors(dest.read_text()):
                fail(f'{p.relative_to(ROOT)} missing anchor: {raw}')

pkg = json.loads((ROOT/'package.json').read_text())
want = {
 'repository': {'type':'git','url':'git+https://github.com/xiehust/strands-darwin.git'},
 'homepage':'https://github.com/xiehust/strands-darwin#readme',
 'bugs': {'url':'https://github.com/xiehust/strands-darwin/issues'},
}
for k,v in want.items():
    if pkg.get(k) != v: fail(f'package.json {k} mismatch: {pkg.get(k)!r}')
if not (ROOT/'docs/images/welcome.png').is_file(): fail('welcome image missing')

if errors:
    print('\n'.join(f'FAIL: {e}' for e in errors)); sys.exit(1)
print(f'PASS: 2 root READMEs; {len(expected)} complete bilingual guide pairs; links, anchors, fences, headings, metadata, image')
