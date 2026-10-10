'use client';
import { t as uiText } from '@/lib/ui-language';

import { useEffect, useState } from 'react';
import type { AuthResponse } from './account-panel';
import ModalA11y from './modal-accessibility';

export default function AuthRecovery({
  onChanged,
}: {
  onChanged: (body: AuthResponse) => Promise<void>;
}) {
  const [link, setLink] = useState<{
    purpose: 'reset' | 'verify';
    token: string;
  } | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [done, setDone] = useState(false);
  useEffect(() => {
    const read = () => {
      const params = new URLSearchParams(location.hash.slice(1));
      const purpose = params.has('reset-password')
        ? 'reset'
        : params.has('verify-email')
          ? 'verify'
          : null;
      if (purpose)
        setLink({
          purpose,
          token:
            params.get(
              purpose === 'reset' ? 'reset-password' : 'verify-email',
            ) ?? '',
        });
    };
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);
  const close = () => {
    if (busy) return;
    setLink(null);
    setPassword('');
    history.replaceState(null, '', location.pathname + location.search);
  };
  if (!link) return null;
  return (
    <ModalA11y className="overlay" onClose={close}>
      <section
        className="modal small"
        role="dialog"
        aria-modal="true"
        aria-labelledby="recovery-title"
      >
        <div className="modalheading">
          <h2 id="recovery-title">
            {link.purpose === 'reset' ? 'Reset password' : 'Verify email'}
          </h2>
          <button
            className="iconbutton"
            aria-label={uiText('Close recovery')}
            disabled={busy}
            onClick={close}
          >
            ×
          </button>
        </div>
        {!done && (
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (busy) return;
              setBusy(true);
              setMessage('');
              try {
                const response = await fetch('/api/auth', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    action:
                      link.purpose === 'reset'
                        ? 'reset_password'
                        : 'verify_email',
                    token: link.token,
                    ...(link.purpose === 'reset' ? { password } : {}),
                  }),
                });
                const body = (await response.json()) as AuthResponse & {
                  notice?: string;
                };
                if (!response.ok)
                  throw Error(body.error || 'Unable to use this link.');
                setMessage(body.notice || 'Confirmed.');
                setPassword('');
                setDone(true);
                history.replaceState(
                  null,
                  '',
                  location.pathname + location.search,
                );
                await onChanged(body);
              } catch (cause) {
                setMessage(
                  cause instanceof Error
                    ? cause.message
                    : 'Unable to use this link.',
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            {link.purpose === 'reset' ? (
              <label>
                {uiText('New password')}
                <input
                  required
                  type="password"
                  minLength={12}
                  maxLength={128}
                  autoComplete="new-password"
                  value={password}
                  disabled={busy}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
            ) : (
              <p>{uiText('Confirm that this email address belongs to you.')}</p>
            )}
            <button className="primary" disabled={busy}>
              {busy
                ? 'Confirming…'
                : link.purpose === 'reset'
                  ? 'Set new password'
                  : 'Verify email'}
            </button>
          </form>
        )}
        {message && <p role="status">{message}</p>}
        {done && (
          <button className="quiet" onClick={close}>
            {uiText('Return to TripTab')}
          </button>
        )}
      </section>
    </ModalA11y>
  );
}
