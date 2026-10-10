'use client';
import { useState } from 'react';
import { setUiLanguage, t, type UiLanguage } from '@/lib/ui-language';
export default function InterfaceLanguage({
  accountId,
  value,
  onSaved,
}: {
  accountId?: string;
  value: UiLanguage;
  onSaved?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <div className="interface-language">
      <label>
        {t('Interface language')}
        <select
          value={value}
          disabled={busy}
          onChange={async (event) => {
            const language = event.target.value as UiLanguage;
            setBusy(true);
            setError('');
            try {
              if (accountId) {
                const response = await fetch('/api/interface-language', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ language }),
                });
                if (!response.ok)
                  throw Error('Could not save the interface language.');
              }
              setUiLanguage(language);
              await onSaved?.();
            } catch (cause) {
              setError(
                cause instanceof Error
                  ? cause.message
                  : 'Could not change language.',
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <option value="en">English</option>
          <option value="es">Español</option>
        </select>
      </label>
      {value === 'es' && (
        <small>
          La ayuda avanzada que aún no está traducida se muestra en inglés.
        </small>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
