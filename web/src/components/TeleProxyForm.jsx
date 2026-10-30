import { useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { toFa } from '../util';
import { Plus, ClipboardPaste, SlidersHorizontal, FileKey } from 'lucide-react';

// Adding a Telegram proxy: a form per protocol (like the outbound form of x-ui panels) or a pasted
// config. The server checks every field and builds the sing-box config itself.

const TLS_FIELDS = [
  { k: 'sni', label: 'SNI (نام سرور TLS)', ph: 'خالی = همان آدرس سرور', dir: 'ltr' },
  { k: 'fingerprint', label: 'Fingerprint (uTLS)', options: ['', 'chrome', 'firefox', 'safari', 'edge', 'ios', 'android', 'random', 'randomized'] },
  { k: 'alpn', label: 'ALPN', ph: 'h2,http/1.1', dir: 'ltr' },
  { k: 'insecure', label: 'گواهی سرور بررسی نشود (insecure)', check: true },
];
const TRANSPORT_FIELDS = [
  { k: 'transport', label: 'Transport', options: ['tcp', 'ws', 'grpc', 'httpupgrade', 'http'] },
  { k: 'path', label: 'Path', ph: '/', dir: 'ltr', show: (f) => ['ws', 'httpupgrade', 'http'].includes(f.transport) },
  { k: 'host', label: 'Host', dir: 'ltr', show: (f) => ['ws', 'httpupgrade', 'http'].includes(f.transport) },
  { k: 'serviceName', label: 'Service name', dir: 'ltr', show: (f) => f.transport === 'grpc' },
];
const ADDR = [
  { k: 'server', label: 'آدرس سرور (IP یا دامنه)', ph: '203.0.113.10', dir: 'ltr', req: true },
  { k: 'port', label: 'پورت', ph: '1080', dir: 'ltr', num: true, req: true },
];

export const TYPES = {
  socks5: {
    label: 'SOCKS5',
    hint: 'یوزر و پسورد اختیاری است؛ اگر پروکسی بدون رمز است خالی بگذارید.',
    fields: [...ADDR, { k: 'username', label: 'یوزرنیم (اختیاری)', dir: 'ltr' }, { k: 'password', label: 'پسورد (اختیاری)', dir: 'ltr', secret: true }],
  },
  socks4: { label: 'SOCKS4', hint: 'SOCKS4 پسورد ندارد؛ فقط User ID اختیاری.', fields: [...ADDR, { k: 'username', label: 'User ID (اختیاری)', dir: 'ltr' }] },
  socks4a: { label: 'SOCKS4a', hint: 'مثل SOCKS4، ولی نام دامنه را خود پروکسی پیدا می‌کند.', fields: [...ADDR, { k: 'username', label: 'User ID (اختیاری)', dir: 'ltr' }] },
  http: {
    label: 'HTTP / HTTPS',
    hint: 'پروکسی باید CONNECT را پشتیبانی کند. با تیک TLS اتصال به خود پروکسی رمزنگاری می‌شود (https).',
    fields: [
      ...ADDR,
      { k: 'username', label: 'یوزرنیم (اختیاری)', dir: 'ltr' },
      { k: 'password', label: 'پسورد (اختیاری)', dir: 'ltr', secret: true },
      { k: 'tls', label: 'TLS (https)', check: true },
      { k: 'sni', label: 'SNI', dir: 'ltr', show: (f) => f.tls },
      { k: 'insecure', label: 'گواهی سرور بررسی نشود', check: true, show: (f) => f.tls },
    ],
  },
  vless: {
    label: 'VLESS',
    hint: 'برای Reality: Security را reality بگذارید و Public key، Short ID، SNI و Fingerprint را از کانفیگ سرور بنویسید.',
    fields: [
      ...ADDR,
      { k: 'uuid', label: 'UUID', dir: 'ltr', req: true },
      { k: 'flow', label: 'Flow', options: ['', 'xtls-rprx-vision'] },
      { k: 'security', label: 'Security', options: ['none', 'tls', 'reality'] },
      { k: 'publicKey', label: 'Public key (pbk)', dir: 'ltr', show: (f) => f.security === 'reality', req: true },
      { k: 'shortId', label: 'Short ID (sid)', dir: 'ltr', show: (f) => f.security === 'reality' },
      ...TLS_FIELDS.map((x) => ({ ...x, show: (f) => f.security === 'tls' || f.security === 'reality' })),
      ...TRANSPORT_FIELDS,
    ],
  },
  vmess: {
    label: 'VMess',
    fields: [
      ...ADDR,
      { k: 'uuid', label: 'UUID', dir: 'ltr', req: true },
      { k: 'cipher', label: 'رمزنگاری', options: ['auto', 'aes-128-gcm', 'chacha20-poly1305', 'none'] },
      { k: 'alterId', label: 'Alter ID', num: true, dir: 'ltr', ph: '0' },
      { k: 'tls', label: 'TLS', check: true },
      ...TLS_FIELDS.map((x) => ({ ...x, show: (f) => f.tls })),
      ...TRANSPORT_FIELDS,
    ],
  },
  trojan: {
    label: 'Trojan',
    fields: [...ADDR, { k: 'password', label: 'رمز', dir: 'ltr', secret: true, req: true }, ...TLS_FIELDS, ...TRANSPORT_FIELDS],
  },
  shadowsocks: {
    label: 'Shadowsocks',
    fields: [
      ...ADDR,
      {
        k: 'method',
        label: 'روش رمزنگاری',
        options: ['aes-256-gcm', 'aes-128-gcm', 'chacha20-ietf-poly1305', 'xchacha20-ietf-poly1305', '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305', 'none'],
      },
      { k: 'password', label: 'رمز', dir: 'ltr', secret: true, req: true },
      { k: 'plugin', label: 'Plugin (اختیاری)', options: ['', 'obfs-local', 'v2ray-plugin'] },
      { k: 'pluginOpts', label: 'Plugin options', dir: 'ltr', ph: 'obfs=http;obfs-host=example.com', show: (f) => f.plugin },
    ],
  },
  hysteria2: {
    label: 'Hysteria2',
    fields: [
      ...ADDR,
      { k: 'password', label: 'رمز', dir: 'ltr', secret: true, req: true },
      { k: 'sni', label: 'SNI', dir: 'ltr' },
      { k: 'obfsPassword', label: 'رمز Obfs (salamander، اختیاری)', dir: 'ltr', secret: true },
      { k: 'upMbps', label: 'سرعت آپلود (Mbps، اختیاری)', num: true, dir: 'ltr' },
      { k: 'downMbps', label: 'سرعت دانلود (Mbps، اختیاری)', num: true, dir: 'ltr' },
      { k: 'insecure', label: 'گواهی سرور بررسی نشود', check: true },
    ],
  },
  tuic: {
    label: 'TUIC',
    fields: [
      ...ADDR,
      { k: 'uuid', label: 'UUID', dir: 'ltr', req: true },
      { k: 'password', label: 'رمز', dir: 'ltr', secret: true },
      { k: 'congestion', label: 'Congestion control', options: ['bbr', 'cubic', 'new_reno'] },
      { k: 'sni', label: 'SNI', dir: 'ltr' },
      { k: 'alpn', label: 'ALPN', dir: 'ltr', ph: 'h3' },
      { k: 'insecure', label: 'گواهی سرور بررسی نشود', check: true },
    ],
  },
  wireguard: {
    label: 'WireGuard',
    hint: 'راحت‌تر: کل فایل .conf را در تب «چسباندن کانفیگ» بگذارید. اینجا مقدارها را از همان فایل بنویسید: Endpoint = آدرس و پورت سرور.',
    fields: [
      { k: 'server', label: 'آدرس سرور (Endpoint بدون پورت)', dir: 'ltr', req: true },
      { k: 'port', label: 'پورت (Endpoint)', num: true, dir: 'ltr', ph: '51820', req: true },
      { k: 'privateKey', label: 'Private key ([Interface])', dir: 'ltr', secret: true, req: true },
      { k: 'publicKey', label: 'Public key ([Peer])', dir: 'ltr', req: true },
      { k: 'presharedKey', label: 'Preshared key (اختیاری)', dir: 'ltr', secret: true },
      { k: 'address', label: 'Address ([Interface])', dir: 'ltr', ph: '10.0.0.2/32' },
      { k: 'mtu', label: 'MTU', num: true, dir: 'ltr', ph: '1408' },
    ],
  },
};

const DEFAULTS = { security: 'none', transport: 'tcp', method: 'aes-256-gcm', cipher: 'auto', congestion: 'bbr' };

export default function TeleAddProxy({ onAdded }) {
  const showToast = useStore((s) => s.showToast);
  const [mode, setMode] = useState('form');
  const [type, setType] = useState('socks5');
  const [form, setForm] = useState(DEFAULTS);
  const [name, setName] = useState('');
  const [links, setLinks] = useState('');
  const [ovpn, setOvpn] = useState({ ovpn: '', file: '', username: '', password: '' });
  const [busy, setBusy] = useState(false);
  const def = TYPES[type];
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body =
        mode === 'form'
          ? { name: name || undefined, form: { ...form, type } }
          : mode === 'openvpn'
            ? { name: name || undefined, openvpn: { ovpn: ovpn.ovpn, username: ovpn.username, password: ovpn.password } }
            : { name: name || undefined, links };
      if (mode === 'paste' && !links.trim()) return;
      if (mode === 'openvpn' && !ovpn.ovpn.trim()) return showToast('فایل .ovpn را انتخاب کنید');
      const r = await api('POST', '/admin/tele/proxies', body);
      const n = r.proxies?.length || 0;
      showToast(r.errors?.length ? `${toFa(n)} پروکسی اضافه شد؛ ${toFa(r.errors.length)} مورد خطا داشت: ${r.errors.join(' · ')}` : `${toFa(n)} پروکسی اضافه شد؛ حالا تستش کنید`);
      setLinks('');
      setName('');
      setOvpn({ ovpn: '', file: '', username: '', password: '' });
      // Secrets are not kept in the browser after adding.
      setForm(DEFAULTS);
      onAdded?.();
    } catch (err) {
      showToast(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="boxed tele-add" onSubmit={submit} autoComplete="off">
      <div className="tele-add-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={mode === 'form'} className={mode === 'form' ? 'active' : ''} onClick={() => setMode('form')}>
          <SlidersHorizontal size={15} /> فرم دستی
        </button>
        <button type="button" role="tab" aria-selected={mode === 'paste'} className={mode === 'paste' ? 'active' : ''} onClick={() => setMode('paste')}>
          <ClipboardPaste size={15} /> چسباندن کانفیگ / لینک
        </button>
        <button type="button" role="tab" aria-selected={mode === 'openvpn'} className={mode === 'openvpn' ? 'active' : ''} onClick={() => setMode('openvpn')}>
          <FileKey size={15} /> OpenVPN
        </button>
      </div>

      <label>
        نام (اختیاری)
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="مثلاً: آلمان ۱" maxLength={80} />
      </label>

      {mode === 'openvpn' ? (
        <>
          <p className="hint">فایل ‎.ovpn‎ را که فروشنده یا پنل VPN داده انتخاب کنید (گواهی‌ها داخل همان فایل باشند). اگر نام کاربری و رمز دارد، پایین بنویسید. فقط ترافیک تلگرام از این تونل می‌رود؛ بعد از افزودن چند ثانیه طول می‌کشد تا وصل شود، بعد «تست» را بزنید.</p>
          <label>
            فایل OpenVPN
            <input
              type="file"
              accept=".ovpn,.conf,text/plain"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                if (f.size > 256 * 1024) return showToast('فایل بیش از حد بزرگ است');
                const text = await f.text();
                setOvpn((o) => ({ ...o, ovpn: text, file: f.name }));
                if (!name) setName(f.name.replace(/\.(ovpn|conf)$/i, '').slice(0, 80));
              }}
            />
          </label>
          {ovpn.file && <small className="muted">{ovpn.file} · {toFa(ovpn.ovpn.split('\n').length)} خط</small>}
          <div className="tele-fields">
            <label>
              نام کاربری (اگر دارد)
              <input value={ovpn.username} onChange={(e) => setOvpn((o) => ({ ...o, username: e.target.value }))} dir="ltr" autoComplete="off" spellCheck={false} />
            </label>
            <label>
              رمز (اگر دارد)
              <input type="password" value={ovpn.password} onChange={(e) => setOvpn((o) => ({ ...o, password: e.target.value }))} dir="ltr" autoComplete="new-password" />
            </label>
          </div>
        </>
      ) : mode === 'form' ? (
        <>
          <label>
            نوع
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {Object.entries(TYPES).map(([k, t]) => (
                <option key={k} value={k}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          {def.hint && <p className="hint">{def.hint}</p>}
          <div className="tele-fields">
            {def.fields
              .filter((x) => !x.show || x.show(form))
              .map((x) =>
                x.check ? (
                  <label key={x.k} className="check">
                    <input type="checkbox" checked={!!form[x.k]} onChange={(e) => set(x.k, e.target.checked)} /> {x.label}
                  </label>
                ) : x.options ? (
                  <label key={x.k}>
                    {x.label}
                    <select value={form[x.k] ?? x.options[0]} onChange={(e) => set(x.k, e.target.value)} dir="ltr">
                      {x.options.map((o) => (
                        <option key={o} value={o}>
                          {o || '—'}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label key={x.k}>
                    {x.label}
                    {x.req && <span className="tele-req"> *</span>}
                    <input
                      value={form[x.k] ?? ''}
                      onChange={(e) => set(x.k, e.target.value)}
                      placeholder={x.ph || ''}
                      dir={x.dir}
                      inputMode={x.num ? 'numeric' : undefined}
                      type={x.secret ? 'password' : 'text'}
                      autoComplete={x.secret ? 'new-password' : 'off'}
                      spellCheck={false}
                      required={!!x.req}
                    />
                  </label>
                ),
              )}
          </div>
        </>
      ) : (
        <>
          <textarea
            rows={7}
            placeholder={'هر لینک در یک خط، یا کل فایل WireGuard (.conf)، یا JSON sing-box'}
            value={links}
            onChange={(e) => setLinks(e.target.value)}
            dir="ltr"
            spellCheck={false}
            style={{ width: '100%', fontFamily: 'monospace', fontSize: 13 }}
          />
          <FormatGuide />
        </>
      )}

      <button className="btn primary sm" disabled={busy}>
        <Plus size={14} /> {busy ? 'در حال افزودن…' : 'افزودن'}
      </button>
    </form>
  );
}

// Example of every accepted format (addresses are documentation examples).
function FormatGuide() {
  const rows = [
    ['SOCKS5 بدون رمز', 'socks5://203.0.113.10:1080'],
    ['SOCKS5 با رمز', 'socks5://USER:PASS@203.0.113.10:1080'],
    ['SOCKS5 (قالب فروشنده‌ها)', '203.0.113.10:1080:USER:PASS   یا   socks5://203.0.113.10:1080@USER:PASS'],
    ['SOCKS4 / 4a', 'socks4://203.0.113.10:1080   ·   socks4a://203.0.113.10:1080'],
    ['HTTP / HTTPS', 'http://USER:PASS@203.0.113.20:8080   ·   https://USER:PASS@proxy.example.com:443'],
    ['VLESS Reality', 'vless://UUID@host:443?security=reality&sni=www.example.com&fp=chrome&pbk=KEY&sid=ID&flow=xtls-rprx-vision#name'],
    ['VLESS WS + TLS', 'vless://UUID@host:443?security=tls&type=ws&path=%2Fws&host=cdn.example.com#name'],
    ['VMess', 'vmess://BASE64…'],
    ['Trojan', 'trojan://PASSWORD@host:443?sni=host#name'],
    ['Shadowsocks', 'ss://BASE64(method:password)@host:8388#name'],
    ['Hysteria2', 'hy2://PASSWORD@host:443?sni=host&obfs=salamander&obfs-password=X#name'],
    ['TUIC', 'tuic://UUID:PASSWORD@host:443?sni=host&congestion_control=bbr#name'],
    ['WireGuard', 'کل فایل .conf: از [Interface] تا آخر [Peer] (چند فایل پشت سر هم = چند پروکسی)'],
    ['اشتراک (subscription)', 'متن base64 لینک اشتراک'],
  ];
  return (
    <details className="tele-guide">
      <summary>راهنمای قالب‌ها</summary>
      <table>
        <tbody>
          {rows.map(([a, b]) => (
            <tr key={a}>
              <td>{a}</td>
              <td dir="ltr">
                <code>{b}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">
        کاراکترهای خاص در یوزر/پسورد را کد کنید: <code dir="ltr">@ → %40</code> · <code dir="ltr">: → %3A</code> · <code dir="ltr"># → %23</code> · <code dir="ltr">/ → %2F</code>. در فرم دستی لازم نیست.
      </p>
    </details>
  );
}
