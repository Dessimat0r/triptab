'use client';
import { useState } from 'react';
import { setUiLanguage, t as uiText, type UiLanguage } from '@/lib/ui-language';
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
        {uiText('Interface language')}
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
          <option value="fr">Français</option>
          <option value="de">Deutsch</option>
        </select>
      </label>
      {value !== 'en' && (
        <small>
          {value === 'es'
            ? uiText('La ayuda avanzada que aún no está traducida se muestra en inglés.')
            : value === 'fr'
              ? uiText('L’aide avancée non encore traduite s’affiche en anglais.')
              : uiText('Noch nicht übersetzte erweiterte Hilfetexte erscheinen auf Englisch.')}
        </small>
      )}
      {error && <p role="alert">{uiText(error)}</p>}
    </div>
  );
}
