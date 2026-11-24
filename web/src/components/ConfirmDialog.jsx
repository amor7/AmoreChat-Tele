import { useId, useRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useStore } from '../store';
import { openedByKeyboard } from '../a11y';
import { settleDialog } from '../confirm';
import { cancelValue, canSubmitPrompt } from '../confirm-rules';
import { copyText } from '../util';
import { Modal } from './Modals';

/** Shows the shared confirm / prompt / copy dialogs (confirm.js), one at a time. Render once. */
export default function ConfirmHost() {
  const item = useStore((s) => s.confirmQueue.current);
  if (!item) return null;
  // key: a queued dialog after this one starts fresh (its own value, focus and Back entry).
  return <ConfirmDialog key={item.id} item={item} />;
}

function ConfirmDialog({ item }) {
  const { kind, title, message, danger, extra } = item;
  const [value, setValue] = useState(item.defaultValue || '');
  const [reveal, setReveal] = useState(false);
  const titleId = useId();
  const messageId = useId();
  const fieldId = useId();
  const okRef = useRef(null);
  const cancelRef = useRef(null);
  const fieldRef = useRef(null);
  const showToast = useStore((s) => s.showToast);

  const answer = (v) => settleDialog(item.id, v);
  const cancel = () => answer(cancelValue(kind));
  const canSubmit = kind !== 'prompt' || canSubmitPrompt(value, item.required);
  const submit = (e) => {
    e?.preventDefault();
    if (kind === 'copy') return answer(undefined);
    if (!canSubmit) return;
    answer(kind === 'prompt' ? value : true);
  };
  const copy = async () => {
    if (await copyText(item.value)) return showToast('کپی شد');
    // No clipboard here (plain http on an old WebView): select it for a manual copy.
    fieldRef.current?.focus();
    fieldRef.current?.select();
    showToast('متن انتخاب شد؛ آن را کپی کنید');
  };
  const password = kind === 'prompt' && item.type === 'password';

  // From the keyboard, start on a safe button: Cancel for a destructive action (Enter must never
  // delete by accident), the confirm button otherwise. By tap / mouse: the panel itself (Modal's
  // default). A prompt's field has autoFocus and takes focus either way: typing is the point,
  // and Enter there only submits what was typed.
  let initialFocus;
  if (openedByKeyboard() && kind !== 'prompt') initialFocus = danger || extra?.danger ? cancelRef : kind === 'copy' ? fieldRef : okRef;

  return (
    <Modal
      bare
      size="small confirm-dialog"
      backdropClassName="confirm-backdrop"
      labelledBy={title ? titleId : messageId}
      describedBy={title && message ? messageId : undefined}
      onClose={cancel}
      initialFocus={initialFocus}
      portal
    >
      <form className="confirm-form" onSubmit={submit}>
        {title && <h3 id={titleId}>{title}</h3>}
        {message && (
          <p id={messageId} className="confirm-message">
            {message}
          </p>
        )}
        {kind === 'prompt' && (
          <div className="confirm-field">
            <label htmlFor={fieldId}>
              {item.label}
              {item.required && ' (الزامی)'}
            </label>
            <span className="confirm-input">
              <input
                id={fieldId}
                ref={fieldRef}
                type={password && !reveal ? 'password' : 'text'}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                // "off" even for passwords: this is a re-check of the signed-in account, with no
                // username field, so a browser would offer to save it as a new login.
                autoComplete="off"
                aria-required={item.required || undefined}
                dir="auto"
                autoFocus
              />
              {password && (
                <button type="button" className="icon-btn" aria-label={reveal ? 'پنهان کردن رمز' : 'نمایش رمز'} aria-pressed={reveal} onClick={() => setReveal(!reveal)}>
                  {reveal ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              )}
            </span>
          </div>
        )}
        {kind === 'copy' && (
          <input
            ref={fieldRef}
            className="confirm-copy-value"
            value={item.value}
            readOnly
            dir="ltr"
            aria-label={title || 'متن'}
            onFocus={(e) => e.target.select()}
          />
        )}
        <div className="actions">
          {kind === 'copy' ? (
            <>
              <button type="button" className="btn primary confirm-copy" onClick={copy}>
                کپی
              </button>
              <button type="submit" ref={okRef} className="btn confirm-ok">
                {item.closeLabel}
              </button>
            </>
          ) : (
            <>
              <button type="button" ref={cancelRef} className="btn confirm-cancel" onClick={cancel}>
                {item.cancelLabel}
              </button>
              {extra && (
                <button type="button" className={`btn confirm-extra ${extra.danger ? 'danger' : ''}`.trim()} onClick={() => answer(extra.value)}>
                  {extra.label}
                </button>
              )}
              <button type="submit" ref={okRef} className={`btn primary confirm-ok ${danger ? 'danger' : ''}`.trim()} disabled={!canSubmit}>
                {item.confirmLabel}
              </button>
            </>
          )}
        </div>
      </form>
    </Modal>
  );
}
