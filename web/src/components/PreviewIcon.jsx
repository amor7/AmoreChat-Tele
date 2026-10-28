import { Image, Film, Mic, Paperclip, Phone, Video, Hourglass, Ban } from 'lucide-react';
import { callSummary } from '../util';

// Small type icon shown before message previews (chat list, replies, pinned bar, search).
export default function PreviewIcon({ m, size = 15 }) {
  if (!m) return null;
  let Icon = null;
  if (m.file?.purged) Icon = Hourglass;
  else if (m.type === 'image') Icon = Image;
  else if (m.type === 'video') Icon = Film;
  else if (m.type === 'voice') Icon = Mic;
  else if (m.type === 'file') Icon = Paperclip;
  else if (m.type === 'deleted') Icon = Ban;
  else if (m.type === 'call') Icon = callSummary(m).video ? Video : Phone;
  return Icon ? <Icon size={size} className="preview-icon" /> : null;
}
