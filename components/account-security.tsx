'use client';
import { t as uiText } from '@/lib/ui-language';

import { useEffect, useState } from 'react';
import { eraseAccountCapture } from '@/lib/offline-store';
import type { Profile, AuthResponse } from './account-panel';
import { profileFromAuth } from './account-panel';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  notificationPreferenceSchema,
  type NotificationPreferences,
} from '@/lib/notification-preferences';

type Session = {
  id: string;
  device: string;
  createdAt: string;
  expiresAt: string;
  current: boolean;
};
export default function AccountSecurity({
  profile,
  onSaved,
}: {
  profile: Profile;
  onSaved: (profile: Profile) => void;
}) {
  const [sessions, setSessions] = useState<Session[]>([]),
    [preferences, setPreferences] = useState(DEFAULT_NOTIFICATION_PREFERENCES),
    [ready, setReady] = useState(false),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [confirmation, setConfirmation] = useState(''),
    [password, setPassword] = useState('');
  useEffect(() => {
    let active = true;
    Promise.all([
      fetch('/api/account', { cache: 'no-store' }),
      fetch('/api/notification-preferences', { cache: 'no-store' }),
    ])
      .then(async ([account, preference]) => {
        if (!account.ok || !preference.ok)
          throw Error('Unable to load account controls.');
        const a = (await account.json()) as { sessions: Session[] };
        if(!Array.isArray(a.sessions))throw Error('Unable to load signed-in browsers.');
        const p=notificationPreferenceSchema.parse(await preference.json());
        if (active) {
          setSessions(a.sessions);
          setPreferences(p);
          setReady(true);
        }
      })
      .catch(() => {
        if (active)
          setMessage(
            'Unable to load account controls. Reopen settings to try again.',
          );
      });
    return () => {
      active = false;
    };
  }, [profile.id]);
  async function action(url: string, body: unknown) {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
        data = (await response.json()) as AuthResponse & {
          sessions?: Session[];
          message?: string;
        };
      if (!response.ok) throw Error(data.error || 'Unable to save.');
      return data;
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Unable to save.');
      return null;
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {!profile.emailVerified && (
        <section className="account-section">
          <h3>{uiText('Verify your email')}</h3>
          <p className="footnote">
            {uiText('Confirm your email address for account recovery.')}
          </p>
          <button
            className="quiet"
            disabled={busy}
            onClick={async () => {
              const result = await action('/api/auth', {
                action: 'request_verification',
              });
              if (result) {
                setMessage(result.notice ?? 'Verification email sent.');
                const next = profileFromAuth(result);
                if (next) onSaved(next);
              }
            }}
          >
            {uiText('Send verification email')}
          </button>
        </section>
      )}
      <section className="account-section">
        <h3>{uiText('Notification preferences')}</h3>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (await action('/api/notification-preferences', preferences))
              setMessage('Notification preferences saved.');
          }}
        >
          <label>
            {uiText('Holiday updates')}
            <select
              value={preferences.scope}
              disabled={busy || !ready}
              onChange={(event) =>
                setPreferences({
                  ...preferences,
                  scope: event.target.value as NotificationPreferences['scope'],
                })
              }
            >
              <option value="all">{uiText('All holiday activity')}</option>
              <option value="involved">
                {uiText('Expenses and payments involving me')}
              </option>
              <option value="none">{uiText('No holiday updates')}</option>
            </select>
          </label>
          <label>
            {uiText('Browser notifications')}
            <select
              value={preferences.delivery}
              disabled={busy || !ready}
              onChange={(event) =>
                setPreferences({
                  ...preferences,
                  delivery: event.target
                    .value as NotificationPreferences['delivery'],
                })
              }
            >
              <option value="immediate">{uiText('As activity happens')}</option>
              <option value="daily">{uiText('Daily summary')}</option>
              <option value="none">{uiText('In-app only')}</option>
            </select>
          </label>
          <label className="insights-check">
            <input
              type="checkbox"
              checked={preferences.reminders}
              disabled={busy || !ready}
              onChange={(event) =>
                setPreferences({
                  ...preferences,
                  reminders: event.target.checked,
                })
              }
            />
            {uiText('Allow settlement reminders')}
          </label>
          <button className="quiet" disabled={busy || !ready}>
            {uiText('Save notification preferences')}
          </button>
        </form>
      </section>
      <section className="account-section">
        <h3>{uiText('Signed-in browsers')}</h3>
        <p className="footnote">
          {uiText(
            'ChatGPT sign-in is managed by ChatGPT. These are your TripTab password sessions.',
          )}
        </p>
        <ul className="session-list">
          {sessions.map((session) => (
            <li key={session.id}>
              <strong>
                {session.current
                  ? 'This browser'
                  : session.device.includes('Firefox')
                    ? 'Firefox'
                    : session.device.includes('Edg/')
                      ? 'Edge'
                      : session.device.includes('Chrome/')
                        ? 'Chrome'
                        : session.device.includes('Safari/')
                          ? 'Safari'
                          : 'Browser'}
              </strong>
              <small>
                {uiText('Signed in ')}
                {session.createdAt.slice(0, 10)}
                {uiText(' · expires ')}
                {session.expiresAt.slice(0, 10)}
              </small>
              <button
                className="textbutton"
                disabled={busy}
                onClick={async () => {
                  const result = await action('/api/account', {
                    action: 'revoke',
                    sessionId: session.id,
                  });
                  if (result) {
                    if (session.current) location.reload();
                    else setSessions(result.sessions ?? []);
                  }
                }}
              >
                {uiText('Sign out')}
              </button>
            </li>
          ))}
        </ul>
        <button
          className="quiet"
          disabled={busy || !ready}
          onClick={async () => {
            const result = await action('/api/account', {
              action: 'revoke',
              sessionId: 'others',
            });
            if (result) {
              setSessions(result.sessions ?? []);
              setMessage('Other browsers signed out.');
            }
          }}
        >
          {uiText('Sign out other browsers')}
        </button>
      </section>
      <details className="account-section">
        <summary>{uiText('Delete your account')}</summary>
        <p className="footnote">
          {uiText(
            'This removes your sign-in, private settings and account history. Shared expenses and their history, including authored names and notes, remain for other travellers. Transfer or delete holidays you own first.',
          )}
        </p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (
              await action('/api/account', {
                action: 'delete',
                confirmation,
                password,
              })
            ) {
              setPassword('');
              await eraseAccountCapture(profile.id).catch(() => {});
              location.reload();
            }
          }}
        >
          <label>
            {uiText('Type your email to confirm')}
            <input
              value={confirmation}
              autoComplete="off"
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
          {profile.hasPassword && (
            <label>
              {uiText('Current password')}
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
          )}
          <button
            className="danger quiet"
            disabled={busy || confirmation !== profile.email}
          >
            {uiText('Delete account')}
          </button>
        </form>
      </details>
      {message && (
        <p role="status" className="footnote">
          {message}
        </p>
      )}
    </>
  );
}
