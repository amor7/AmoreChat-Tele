import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import Avatar from './Avatar';
import { Mic, MicOff, Video, VideoOff, LogOut, Phone } from 'lucide-react';

const formatMb = (mb) => (mb >= 1024 ? `${+(mb / 1024).toFixed(1)} گیگابایت` : `${mb} مگابایت`);

// A size in MB stored as a number, edited in MB or GB.
function SizeField({ label, value, onChange, presets, min = 0 }) {
  const [unit, setUnit] = useState(value != null && value >= 1024 && value % 1024 === 0 ? 'GB' : 'MB');
  const factor = unit === 'GB' ? 1024 : 1;
  return (
    <div className="size-field">
      <span className="size-label">{label}</span>
      <div className="size-row">
        <input
          type="number"
          min={min}
          step="any"
          placeholder="پیش‌فرض سرور"
          value={value == null ? '' : +(value / factor).toFixed(2)}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Math.round(Number(e.target.value) * factor))}
        />
        <select value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="واحد">
          <option value="MB">مگابایت</option>
          <option value="GB">گیگابایت</option>
        </select>
      </div>
      {presets && (
        <div className="chips">
          {presets.map(([mb, text]) => (
            <button
              key={text}
              type="button"
              className={`chip-btn ${value === mb ? 'active' : ''}`}
              onClick={() => {
                if (mb >= 1024) setUnit('GB');
                onChange(mb);
              }}
            >
              {text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Per-user overrides; empty = site default.
export function LimitsEditor({ u, run }) {
  const [o, setO] = useState(u.overrides || {});
  const tri = (key) => (o[key] === true ? 'yes' : o[key] === false ? 'no' : '');
  const setTri = (key, v) => setO({ ...o, [key]: v === 'yes' ? true : v === 'no' ? false : undefined });
  const num = (key) => (e) => setO({ ...o, [key]: e.target.value === '' ? undefined : Number(e.target.value) });
  const setVal = (key) => (v) => setO({ ...o, [key]: v });
  const L = u.limits || {};
  const save = (body, ok) => run(() => api('PATCH', `/admin/users/${u.id}/limits`, body), ok);
  return (
    <div className="perm-box limits-box">
      <b>محدودیت‌ها و دسترسی‌های این کاربر</b>
      <small className="muted">خالی یا «پیش‌فرض سرور» یعنی همان تنظیم کلی سرور</small>
      <div className="limits-now">
        <span>الان:</span>
        <span className="pill">فایل تا {formatMb(L.uploadMb)}</span>
        <span className={`pill ${L.canCall ? 'ok' : 'no'}`}>تماس {L.canCall ? 'مجاز' : 'ممنوع'}</span>
        <span className={`pill ${L.canStream ? 'ok' : 'no'}`}>استریم {L.canStream ? `تا ${L.streamQuality}p، ${L.streamFps || 30} فریم` : 'ممنوع'}</span>
      </div>
      <SizeField
        label="حداکثر حجم هر فایل"
        value={o.upload_mb}
        onChange={setVal('upload_mb')}
        min={1}
        presets={[
          [100, '۱۰۰ مگ'],
          [1024, '۱ گیگ'],
          [5120, '۵ گیگ'],
          [10240, '۱۰ گیگ'],
        ]}
      />
      <SizeField
        label="سهمیه کل فضای کاربر (۰ = نامحدود)"
        value={o.quota_mb}
        onChange={setVal('quota_mb')}
        presets={[
          [0, 'نامحدود'],
          [5120, '۵ گیگ'],
          [20480, '۲۰ گیگ'],
        ]}
      />
      <label>
        تماس صوتی/تصویری
        <select value={tri('can_call')} onChange={(e) => setTri('can_call', e.target.value)}>
          <option value="">پیش‌فرض سرور</option>
          <option value="yes">مجاز</option>
          <option value="no">ممنوع</option>
        </select>
      </label>
      <label>
        استریم (اشتراک صفحه و دوربین)
        <select value={tri('can_stream')} onChange={(e) => setTri('can_stream', e.target.value)}>
          <option value="">پیش‌فرض سرور</option>
          <option value="yes">مجاز</option>
          <option value="no">ممنوع</option>
        </select>
      </label>
      <label>
        حداکثر کیفیت استریم
        <select value={o.stream_quality ?? ''} onChange={num('stream_quality')}>
          <option value="">پیش‌فرض</option>
          <option value="480">480p</option>
          <option value="720">720p</option>
          <option value="1080">1080p</option>
        </select>
      </label>
      <label>
        حداکثر نرخ فریم استریم
        <select value={o.stream_fps ?? ''} onChange={num('stream_fps')}>
          <option value="">پیش‌فرض</option>
          <option value="30">۳۰ فریم</option>
          <option value="60">۶۰ فریم</option>
        </select>
      </label>
      <div className="actions">
        <button className="btn sm" onClick={() => save({}, 'به پیش‌فرض برگشت').then(() => setO({}))}>
          بازگشت به پیش‌فرض
        </button>
        <button className="btn primary sm" onClick={() => save(o, 'ذخیره شد')}>
          ذخیره محدودیت‌ها
        </button>
      </div>
    </div>
  );
}

// Everything happening right now: voice rooms and calls, with moderation.
export function Live() {
  const showToast = useStore((s) => s.showToast);
  const [data, setData] = useState(null);
  const alive = useRef(true);
  const load = () =>
    api('GET', '/admin/live')
      .then((d) => alive.current && setData(d))
      .catch((e) => showToast(e.message));

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const act = (fn, ok) =>
    fn()
      .then(() => {
        showToast(ok);
        load();
      })
      .catch((e) => showToast(e.message));
  const moderate = (chatId, userId, action, ok) => act(() => api('POST', `/rtc/${chatId}/moderate`, { userId, action }), ok);

  if (!data) return <p className="muted">…</p>;
  if (!data.enabled) return <p className="muted pad">تماس و ویس‌چت روی این سرور فعال نیست (LiveKit تنظیم نشده).</p>;
  return (
    <>
      <h4 className="with-icon">
        <Mic size={18} /> ویس‌چت‌های فعال
      </h4>
      {!data.rooms.length && <p className="muted">هیچ ویس‌چتی فعال نیست.</p>}
      {data.rooms.map((r) => (
        <div key={r.chatId} className="boxed">
          <div className="row-item">
            <b className="grow">{r.title}</b>
            <button
              className="btn sm danger"
              onClick={() => confirm('ویس‌چت برای همه بسته شود؟') && act(() => api('POST', '/admin/live/end', { chatId: r.chatId }), 'بسته شد')}
            >
              پایان برای همه
            </button>
          </div>
          {r.participants.map((p) => (
            <div key={p.userId} className="row-item">
              <Avatar id={p.userId} name={p.name} file={p.avatar} size={28} />
              <span className="grow">
                {p.name} {p.screen && <span className="live-badge">LIVE</span>} {p.camera && <Video size={14} />}
              </span>
              <button className="btn sm" title="بستن میکروفون" onClick={() => moderate(r.chatId, p.userId, 'mute', 'میکروفون بسته شد')}>
                <MicOff size={16} />
              </button>
              <button className="btn sm" title="توقف استریم" onClick={() => moderate(r.chatId, p.userId, 'stop_stream', 'استریم متوقف شد')}>
                <VideoOff size={16} />
              </button>
              <button className="btn sm danger" title="بیرون کردن" onClick={() => moderate(r.chatId, p.userId, 'kick', 'بیرون شد')}>
                <LogOut size={16} />
              </button>
            </div>
          ))}
        </div>
      ))}
      <h4 className="with-icon">
        <Phone size={18} /> تماس‌های در جریان
      </h4>
      {!data.calls.length && <p className="muted">تماسی در جریان نیست.</p>}
      {data.calls.map((c) => (
        <div key={c.id} className="row-item boxed">
          <span className="grow">
            {c.video ? <Video size={15} /> : <Phone size={15} />} {c.caller.displayName} ← {c.callee.displayName} · {c.state === 'ringing' ? 'در حال زنگ' : 'در حال مکالمه'}
          </span>
          <button className="btn sm danger" onClick={() => act(() => api('POST', '/admin/live/end', { callId: c.id }), 'تماس قطع شد')}>
            قطع
          </button>
        </div>
      ))}
    </>
  );
}

export function RtcSettings({ f, setF }) {
  return (
    <>
      <h4>تماس و ویس‌چت</h4>
      <p className="hint">پیش‌فرض برای همه کاربران؛ برای هر کاربر جداگانه از تب «کاربران» قابل تغییر است.</p>
      <label className="check">
        <input type="checkbox" checked={f.default_can_call === '1'} onChange={(e) => setF({ ...f, default_can_call: e.target.checked ? '1' : '0' })} />
        همه کاربران بتوانند تماس صوتی/تصویری بگیرند
      </label>
      <label className="check">
        <input type="checkbox" checked={f.default_can_stream === '1'} onChange={(e) => setF({ ...f, default_can_stream: e.target.checked ? '1' : '0' })} />
        همه کاربران بتوانند استریم کنند (اشتراک صفحه و دوربین در ویس‌چت)
      </label>
      <label>
        حداکثر کیفیت استریم
        <select value={f.max_stream_quality} onChange={(e) => setF({ ...f, max_stream_quality: e.target.value })}>
          <option value="480">480p (کم‌مصرف)</option>
          <option value="720">720p</option>
          <option value="1080">1080p (پهنای باند زیاد)</option>
        </select>
      </label>
      <label>
        حداکثر نرخ فریم استریم
        <select value={f.max_stream_fps || '30'} onChange={(e) => setF({ ...f, max_stream_fps: e.target.value })}>
          <option value="30">۳۰ فریم</option>
          <option value="60">۶۰ فریم (روان‌تر، حدود دو برابر پهنای باند)</option>
        </select>
      </label>
      <label>
        حداکثر استریم همزمان در هر اتاق (۰ = نامحدود)
        <input type="number" min="0" value={f.max_streams_per_room} onChange={(e) => setF({ ...f, max_streams_per_room: e.target.value })} />
      </label>
    </>
  );
}
