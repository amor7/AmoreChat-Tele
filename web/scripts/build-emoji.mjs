// Builds web/public/emoji/fluent.webp (+ fluent.json) from Microsoft Fluent Emoji (MIT).
// The output is committed, so normal builds don't need this. To regenerate:
//   mkdir /tmp/e && cd /tmp/e && npm i @iconify-json/fluent-emoji@1.2.7 unicode-emoji-json@0.9.0 sharp
//   node <repo>/web/scripts/build-emoji.mjs <repo>/web/public/emoji
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(path.join(process.cwd(), 'x.js'));
const sharp = require('sharp');
const fluent = require('@iconify-json/fluent-emoji/icons.json');
const byEmoji = require('unicode-emoji-json/data-by-emoji.json');

const OUT = path.resolve(process.argv[2] || 'web/public/emoji');
const SIZE = 64; // px per emoji in the sprite (sharp at 2x for ~32px display)

// Curated set: what people actually use, grouped for the picker.
const GROUPS = {
  smileys:
    '😀😃😄😁😆😅🤣😂🙂🙃😉😊😇🥰😍🤩😘😗😚😙😋😛😜🤪😝🤑🤗🤭🤫🤔🤐🤨😐😑😶😏😒🙄😬😮‍💨🤥😌😔😪🤤😴😷🤒🤕🤢🤮🥵🥶🥴😵🤯🤠🥳🥸😎🤓🧐😕😟🙁😮😯😲😳🥺😦😧😨😰😥😢😭😱😖😣😞😓😩😫🥱😤😡😠🤬😈👿💀💩🤡👻👽🤖😺😸😹😻😼😽🙀😿😾🙈🙉🙊',
  hearts: '❤️🧡💛💚💙💜🖤🤍🤎💔❣️💕💞💓💗💖💘💝💟❤️‍🔥💋💯💢💥💫💦💨🕊️',
  hands: '👋🤚🖐️✋🖖👌🤌🤏✌️🤞🤟🤘🤙👈👉👆🖕👇☝️👍👎✊👊🤛🤜👏🙌👐🤲🤝🙏✍️💪🦾👀👁️👅👄🧠',
  people: '👶🧒👦👧🧑👱👨🧔👩🧓👴👵🙍🙎🙅🙆💁🙋🧏🙇🤦🤷👮🕵️💂🥷👷🤴👸👳🧕🤵👰🤰🤱👼🎅🤶🦸🦹🧙🧚🧛🧜🧝🧞🧟💆💇🚶🧍🧎🏃💃🕺👯🧖🧗🏇⛷️🏂🏌️🏄🚣🏊⛹️🏋️🚴🤸🤼🤽🤾🤹🧘',
  nature: '🐶🐱🐭🐹🐰🦊🐻🐼🐨🐯🦁🐮🐷🐸🐵🐔🐧🐦🐤🦆🦅🦉🐺🐴🦄🐝🦋🐌🐞🐢🐍🦖🐙🦀🐬🐳🦈🐘🦒🐪🌵🎄🌲🌳🌴🌱🌿☘️🍀🍁🍂🌷🌹🥀🌺🌸🌼🌻🌞🌝🌚🌙⭐🌟✨⚡🔥🌈☀️⛅☁️🌧️⛈️❄️☃️⛄🌊',
  food: '🍏🍎🍐🍊🍋🍌🍉🍇🍓🫐🍈🍒🍑🥭🍍🥥🥝🍅🍆🥑🥦🥕🌽🌶️🥔🥐🍞🥖🧀🥚🍳🥞🥓🥩🍗🍖🌭🍔🍟🍕🥪🌮🌯🥗🍝🍜🍲🍛🍣🍱🍤🍚🍙🍘🍥🥮🍢🍡🍧🍨🍦🥧🧁🍰🎂🍮🍭🍬🍫🍿🍩🍪🌰🥜🍯🥛☕🍵🧃🥤🧋🍶🍺🍻🥂🍷🍸🍹🧉🧊',
  activity: '⚽🏀🏈⚾🥎🎾🏐🏉🥏🎱🏓🏸🏒🥅⛳🏹🎣🥊🥋🎽🛹⛸️🥌🎿🏆🥇🥈🥉🏅🎖️🎗️🎫🎟️🎪🎭🎨🎬🎤🎧🎼🎹🥁🎷🎺🎸🪕🎻🎲♟️🎯🎳🎮🕹️🧩',
  travel: '🚗🚕🚙🚌🏎️🚓🚑🚒🚚🚜🛵🏍️🚲🛴🚨🚦🚂✈️🛫🛬🚀🛸🚁⛵🚤🚢⚓⛽🗺️🏔️⛰️🌋🏕️🏖️🏜️🏝️🏟️🏛️🏠🏡🏢🏥🏦🏨🏫🕌⛪🕍🗽🗼🏰🎡🎢🌃🌆🌅🌄🌠🎆🎇',
  objects: '⌚📱💻⌨️🖥️🖨️🖱️💾💿📷📸📹🎥📞☎️📺📻🎙️⏰⌛⏳📡🔋🔌💡🔦🕯️💸💵💰💳💎⚖️🔧🔨⚒️🛠️⚙️🔫💣🔪🗡️🛡️🔮💊💉🧬🦠🧪🌡️🧹🧺🧻🚽🛁🔑🗝️🚪🛋️🛏️🧸🎁🎈🎀🎊🎉✉️📩📦📜📄📅📆📋📁📂📌📍✂️📏📐🔒🔓✏️📝🔍🔎📚📖🔗',
  symbols: '✅☑️✔️❌❎➕➖➗✖️♾️‼️⁉️❓❔❕❗〰️💲⚠️🚸⛔🚫🔞☢️☣️⬆️↗️➡️↘️⬇️↙️⬅️↖️↕️↔️🔄🔃🔙🔚🔛🔜🔝🛐⚛️☮️✝️☪️☯️♈♉♊♋♌♍♎♏♐♑♒♓🆗🆕🆓🆒🆙🔴🟠🟡🟢🔵🟣⚫⚪🟤🔺🔻💠🔘🔳🔲🏁🚩🎌🏴🏳️🏳️‍🌈🇮🇷',
};

const strip = (s) => s.replace(/️/g, '');
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

// unicode-emoji-json slugs ("thumbs_up") match Fluent names ("thumbs-up") almost always.
const lookup = new Map(Object.entries(byEmoji).map(([ch, v]) => [strip(ch), v.slug.replace(/_/g, '-')]));
const ALIASES = { 'flag-iran': 'flag-iran', 'red-heart': 'red-heart' };

function fluentName(ch) {
  const slug = lookup.get(strip(ch));
  if (!slug) return null;
  for (const name of [ALIASES[slug] || slug, slug + '-default', slug.replace(/-face$/, '')]) {
    if (fluent.icons[name]) return name;
    if (fluent.aliases?.[name]) return fluent.aliases[name].parent;
  }
  return null;
}

const entries = [];
const missing = [];
for (const [group, str] of Object.entries(GROUPS)) {
  for (const { segment } of segmenter.segment(str)) {
    const name = fluentName(segment);
    if (!name) {
      missing.push(segment);
      continue;
    }
    if (!entries.some((e) => strip(e.ch) === strip(segment))) entries.push({ ch: segment, name, group });
  }
}

const COLS = Math.ceil(Math.sqrt(entries.length));
const ROWS = Math.ceil(entries.length / COLS);
const w = fluent.width || 32;
const h = fluent.height || 32;
const tiles = await Promise.all(
  entries.map(async (e, i) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${SIZE}" height="${SIZE}">${fluent.icons[e.name].body}</svg>`;
    const input = await sharp(Buffer.from(svg), { density: 300 }).resize(SIZE, SIZE).png().toBuffer();
    return { input, left: (i % COLS) * SIZE, top: Math.floor(i / COLS) * SIZE };
  }),
);

fs.mkdirSync(OUT, { recursive: true });
await sharp({ create: { width: COLS * SIZE, height: ROWS * SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite(tiles)
  .webp({ quality: 84, alphaQuality: 85, effort: 6 })
  .toFile(path.join(OUT, 'fluent.webp'));

const map = { cols: COLS, rows: ROWS, size: SIZE, groups: Object.keys(GROUPS), emoji: entries.map((e) => [e.ch, e.group]) };
fs.writeFileSync(path.join(OUT, 'fluent.json'), JSON.stringify(map));
const kb = (f) => Math.round(fs.statSync(path.join(OUT, f)).size / 1024);
console.log(`${entries.length} emoji, ${COLS}x${ROWS}, webp ${kb('fluent.webp')} KB, json ${kb('fluent.json')} KB`);
if (missing.length) console.log('not in Fluent set (skipped):', missing.join(' '));
