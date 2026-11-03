"""Builds web/public/emoji/noto.webp + noto.json: Google's Noto Emoji (Apache 2.0) in one sprite,
so emoji look the same on every device and need no internet.

Usage: python scripts/emoji-sprite.py <unpacked emoji-datasource-google package> <emoji list json>
The list is a {"groups": [...], "emoji": [[char, group], ...]} file (the picker's order).
Needs Pillow.
"""
import json
import math
import sys
from pathlib import Path

from PIL import Image

SIZE = 64
src, listing = Path(sys.argv[1]), Path(sys.argv[2])
out = Path(__file__).resolve().parent.parent / 'web' / 'public' / 'emoji'
wanted = json.loads(listing.read_text(encoding='utf8'))


def key(text):
    return '-'.join(f'{ord(c):x}' for c in text if c != '️')


images = {}
for e in json.loads((src / 'emoji.json').read_text(encoding='utf8')):
    if not e.get('has_img_google'):
        continue
    for code in filter(None, [e['unified'], e.get('non_qualified')]):
        images[code.lower().replace('-fe0f', '')] = src / 'img' / 'google' / '64' / e['image']

# Country flags (Noto's are public domain), Iran first.
if 'flags' not in wanted['groups']:
    wanted['groups'].append('flags')
    flags = sorted(
        (e for e in json.loads((src / 'emoji.json').read_text(encoding='utf8')) if e.get('subcategory') == 'country-flag' and e.get('has_img_google')),
        key=lambda e: (e['unified'] != '1F1EE-1F1F7', e.get('sort_order', 0)),
    )
    wanted['emoji'] += [[''.join(chr(int(c, 16)) for c in e['unified'].split('-')), 'flags'] for e in flags]

# Left out of the picker by the owner's choice.
LEFT_OUT = {key('🏳️‍🌈'), key('🏳️‍⚧️'), key('⚧️')}
wanted['emoji'] = [(ch, group) for ch, group in wanted['emoji'] if key(ch) not in LEFT_OUT]

found = [(ch, group) for ch, group in wanted['emoji'] if key(ch) in images]
missing = [ch for ch, _ in wanted['emoji'] if key(ch) not in images]
cols = math.ceil(math.sqrt(len(found)))
rows = math.ceil(len(found) / cols)
sheet = Image.new('RGBA', (cols * SIZE, rows * SIZE))
for i, (ch, _) in enumerate(found):
    tile = Image.open(images[key(ch)]).convert('RGBA').resize((SIZE, SIZE), Image.LANCZOS)
    sheet.paste(tile, ((i % cols) * SIZE, (i // cols) * SIZE))
sheet.save(out / 'noto.webp', 'WEBP', quality=88, method=6)
(out / 'noto.json').write_text(
    json.dumps({'cols': cols, 'rows': rows, 'size': SIZE, 'groups': wanted['groups'], 'emoji': found}, ensure_ascii=False, separators=(',', ':')),
    encoding='utf8',
)
print(f'{len(found)} emoji, {cols}x{rows}; missing: {" ".join(missing) or "none"}')
