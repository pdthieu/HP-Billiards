"""report.py: the audit's findings, grouped: what breaks where."""
import json, glob, os, re, sys
from collections import defaultdict

here = os.path.dirname(os.path.abspath(__file__))
outdir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, 'out')
runs = []
for f in sorted(glob.glob(os.path.join(outdir, '*.json'))):
    d = json.load(open(f))
    runs.append(d)

def key(s):
    w, h = map(int, s.split('x'))
    return (w > h, w, h)

issues = defaultdict(lambda: defaultdict(set))  # kind -> item -> {size/lang/state}
geo = {}
errors = []
for r in sorted(runs, key=lambda r: (r['lang'], key(r['size']))):
    tag = f"{r['lang']} {r['size']}"
    if r.get('error'):
        errors.append(f"{tag}: {r['error']}")
    for st, m in r['states'].items():
        where = f"{tag} {st}"
        if m['hscroll']: issues['page scrolls sideways'][''].add(where)
        if m['vscroll']: issues['page scrolls down'][''].add(where)
        for kind in ('small', 'offscreen', 'overlaps', 'clipped'):
            for it in m[kind]:
                # strip the numbers so the same thing at many sizes groups
                k = re.sub(r'\s+[-\d.,×x/\[\]]+$', '', it)
                issues[kind][k].add(where)
        if st == 'aim':
            geo[tag] = m['geo']
        f = float(m['minFont'].split('px')[0])
        if f < 9.5: issues['tiny text'][m['minFont'].split(' ', 1)[1]].add(f"{where} {f}px")

print('== runs', len(runs), 'errors', errors)
print()
print('== the power bar and the table while aiming')
for tag, g in geo.items():
    print(f"  {tag:14} {g['mode']:28} bar {g['pbar']} table {g['table']}")
for kind, items in issues.items():
    print()
    print('==', kind)
    for it, where in sorted(items.items(), key=lambda kv: -len(kv[1])):
        w = sorted(where)
        print(f"  [{len(w):3}] {it[:90]}")
        print('        e.g.', '; '.join(w[:4]))
