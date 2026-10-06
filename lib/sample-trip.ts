import { validateLedger, type Trip } from './model';

/** Fictional data for an explicitly configured staging build, owned by its signed-in user. */
export function sampleTrip(account: { id: string; displayName: string }): Trip {
  const you = crypto.randomUUID(), gary = crypto.randomUUID(), receipt = crypto.randomUUID();
  const trip: Trip = {
    id: crypto.randomUUID(), ownerId: account.id, name: 'Sample holiday · Bratislava', currency: 'GBP', receiptLanguage: 'sk',
    startDate: '2026-10-01', endDate: '2026-10-07',
    members: [{ id: you, name: account.displayName.trim() || 'You', userId: account.id }, { id: gary, name: account.displayName.trim().toLowerCase() === 'gary' ? 'Gary Example' : 'Gary' }],
    expenses: [{ id: receipt, title: 'Sample café receipt', date: '2026-10-05', time: '10:15', timezone: 'Europe/Bratislava', currency: 'EUR', payer: you,
      location: { label: 'Bratislava, Slovakia', source: 'user' }, detectedLanguage: 'sk', bankAmount: 1135,
      tax: 0, tip: 0, discount: 0, source: 'manual',
      memory: { notes: 'Fictional test receipt. Gary also goes by Gaz.', aliases: [{ name: 'Gaz', memberId: gary }] },
      items: [
        { id: crypto.randomUUID(), name: 'Bezkofeínová káva', nameLanguage: 'sk', amount: 280, members: [gary],
          translations: { en: { text: 'Decaf coffee', sourceText: 'Bezkofeínová káva', pairedText: 'Decaf coffee', sourceLanguage: 'sk', provenance: 'user' } } },
        { id: crypto.randomUUID(), name: 'Cappuccino', nameLanguage: 'it', amount: 320, members: [you] },
        { id: crypto.randomUUID(), name: 'Croissant', nameLanguage: 'fr', amount: 720, members: [you, gary], quantity: { total: 4, label: 'croissants' },
          units: { total: 4, label: 'croissants', allocations: { [you]: 2, [gary]: 2 } } },
      ],
    }], payments: [], drafts: [],
  };
  return validateLedger({ trips: [trip] }).trips[0];
}
