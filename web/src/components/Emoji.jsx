import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { Clock, Smile, Heart, Hand, Users, Leaf, Utensils, Trophy, Plane, Lamp, Shapes } from 'lucide-react';

// Microsoft Fluent Emoji (MIT), pre-rendered into one sprite: /emoji/fluent.webp + fluent.json.
const strip = (s) => s.replace(/️/g, '');
const useEmojiData = create(() => ({ index: null, list: [], cols: 1, rows: 1 }));

let loading = null;
export function loadEmoji() {
  loading ||= fetch('/emoji/fluent.json')
    .then((r) => r.json())
    .then((d) => {
      const index = new Map(d.emoji.map(([ch], i) => [strip(ch), i]));
      useEmojiData.setState({ index, list: d.emoji, cols: d.cols, rows: d.rows });
    })
    .catch(() => {
      loading = null;
    });
  return loading;
}

export function EmojiImg({ ch, size = 22, className = '' }) {
  const { index, cols, rows } = useEmojiData();
  const i = index?.get(strip(ch));
  if (i == null) return <span className={`emoji-native ${className}`} style={{ fontSize: size * 0.9 }}>{ch}</span>;
  return (
    <span
      className={`emoji ${className}`}
      role="img"
      aria-label={ch}
      style={{
        width: size,
        height: size,
        backgroundSize: `${cols * size}px ${rows * size}px`,
        backgroundPosition: `-${(i % cols) * size}px -${Math.floor(i / cols) * size}px`,
      }}
    />
  );
}

const segmenter = new Intl.Segmenter('fa', { granularity: 'grapheme' });
const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

// Splits text into strings and emoji images (emoji we don't have stay as text).
export function useEmojiText(text) {
  const index = useEmojiData((s) => s.index);
  return useMemo(() => {
    if (!text || !EMOJI_RE.test(text)) return { parts: [text], onlyEmoji: 0 };
    const parts = [];
    let buf = '';
    let emojiCount = 0;
    let other = false;
    for (const { segment } of segmenter.segment(text)) {
      if (EMOJI_RE.test(segment)) {
        emojiCount++;
        if (index?.has(strip(segment))) {
          if (buf) parts.push(buf);
          buf = '';
          parts.push({ emoji: segment });
          continue;
        }
      } else if (segment.trim()) other = true;
      buf += segment;
    }
    if (buf) parts.push(buf);
    // 1-3 emoji with nothing else are shown large, like other messengers.
    return { parts, onlyEmoji: !other && emojiCount <= 3 ? emojiCount : 0 };
  }, [text, index]);
}

// Text with Fluent emoji images in place of emoji characters.
export function RichText({ text, size = 20, big = false, children }) {
  const { parts, onlyEmoji } = useEmojiText(text);
  const s = big && onlyEmoji ? (onlyEmoji === 1 ? 72 : 52) : size;
  return (
    <>
      {parts.map((p, i) => (typeof p === 'string' ? (children ? children(p, i) : p) : <EmojiImg key={i} ch={p.emoji} size={s} />))}
    </>
  );
}

export const isBigEmoji = (text) => {
  if (!text || !EMOJI_RE.test(text)) return false;
  let n = 0;
  for (const { segment } of segmenter.segment(text)) {
    if (EMOJI_RE.test(segment)) n++;
    else if (segment.trim()) return false;
  }
  return n > 0 && n <= 3;
};

// ---------- Picker ----------
const GROUP_META = {
  recent: ['اخیر', Clock],
  smileys: ['شکلک‌ها', Smile],
  hearts: ['قلب‌ها', Heart],
  hands: ['دست‌ها', Hand],
  people: ['آدم‌ها', Users],
  nature: ['طبیعت', Leaf],
  food: ['خوراکی', Utensils],
  activity: ['فعالیت', Trophy],
  travel: ['سفر', Plane],
  objects: ['اشیا', Lamp],
  symbols: ['نمادها', Shapes],
};
const RECENT_KEY = 'ac_recent_emoji';

function getRecent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  } catch {
    return [];
  }
}
export function pushRecent(ch) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([ch, ...getRecent().filter((x) => x !== ch)].slice(0, 32)));
  } catch {
    /* private mode */
  }
}

export function EmojiPicker({ onPick, onClose }) {
  const list = useEmojiData((s) => s.list);
  const [recent] = useState(getRecent);
  const [tab, setTab] = useState(recent.length ? 'recent' : 'smileys');
  const ref = useRef(null);

  useEffect(() => {
    loadEmoji();
    const close = (e) => !ref.current?.contains(e.target) && onClose();
    const esc = (e) => e.key === 'Escape' && onClose();
    setTimeout(() => document.addEventListener('pointerdown', close));
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', esc);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const items = tab === 'recent' ? recent : list.filter(([, g]) => g === tab).map(([ch]) => ch);
  const tabs = Object.keys(GROUP_META).filter((g) => g !== 'recent' || recent.length);

  return (
    <div className="emoji-picker" ref={ref} role="dialog" aria-label="انتخاب ایموجی">
      <div className="ep-grid">
        {items.map((ch) => (
          <button
            key={ch}
            type="button"
            className="ep-item"
            onClick={() => {
              pushRecent(ch);
              onPick(ch);
            }}
            aria-label={ch}
          >
            <EmojiImg ch={ch} size={30} />
          </button>
        ))}
      </div>
      <div className="ep-tabs">
        {tabs.map((g) => {
          const [label, Icon] = GROUP_META[g];
          return (
            <button key={g} type="button" className={tab === g ? 'active' : ''} onClick={() => setTab(g)} title={label} aria-label={label}>
              <Icon size={18} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
