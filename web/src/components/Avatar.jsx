import { fileUrl } from '../api';
import { colorFor } from '../util';
import { Bookmark } from 'lucide-react';

export default function Avatar({ id, name, file, size = 44, online, saved }) {
  const style = { width: size, height: size, fontSize: size * 0.42 };
  return (
    <span className="avatar" style={style}>
      {saved ? (
        <span className="avatar-fallback saved">
          <Bookmark size={size * 0.46} fill="currentColor" />
        </span>
      ) : file ? (
        <img src={fileUrl(file)} alt="" loading="lazy" />
      ) : (
        <span className="avatar-fallback" style={{ background: colorFor(id) }}>
          {[...(name || '?').trim()][0]}
        </span>
      )}
      {online && <span className="online-dot" />}
    </span>
  );
}
