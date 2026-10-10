'use client';
import { t as uiText } from '@/lib/ui-language';

import { useId, useState } from 'react';
import ModalA11y from './modal-accessibility';
import {
  CURRENCIES,
  expenseSchema,
  expenseTotal,
  stampCalculationRules,
  type Currency,
  type Trip,
} from '@/lib/model';
import { offlineStore, type OfflineExpense } from '@/lib/offline-store';
import { formatMoney } from '@/lib/money-format';
export default function OfflineEntryEditor({
  entry,
  trip,
  onClose,
  onSaved,
}: {
  entry: OfflineExpense;
  trip?: Trip;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const id = useId(),
    [title, setTitle] = useState(entry.expense.title),
    [date, setDate] = useState(entry.expense.date),
    [amount, setAmount] = useState(String(entry.expense.items[0].amount / 100)),
    [currency, setCurrency] = useState(entry.expense.currency),
    [rate, setRate] = useState(String(entry.expense.fx?.rate ?? '')),
    [payer, setPayer] = useState(entry.expense.payer),
    [members, setMembers] = useState(entry.expense.items[0].members),
    [photo, setPhoto] = useState(!!entry.photo),
    [checked, setChecked] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  let converted: string | undefined;
  try {
    if (trip)
      converted = formatMoney(
        expenseTotal(
          {
            ...entry.expense,
            currency,
            items: [
              {
                ...entry.expense.items[0],
                amount: Math.round(Number(amount) * 100),
              },
            ],
            fx:
              currency === trip.currency
                ? undefined
                : { rate: Number(rate), source: 'manual', asOf: date },
          },
          trip.currency,
        ),
        trip.currency,
      );
  } catch {}
  return (
    <ModalA11y className="overlay" onClose={onClose}>
      <section
        className="modal small"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
      >
        <div className="modalheading">
          <h2 id={`${id}-title`}>{uiText('Edit pending expense')}</h2>
          <button className="quiet" onClick={onClose} disabled={busy}>
            {uiText('Close')}
          </button>
        </div>
        {!trip ? (
          <p role="alert">
            {uiText(
              'Restore this holiday or sign in to its account before editing the pending expense.',
            )}
          </p>
        ) : (
          <form
            className="repeat-expense-form"
            onSubmit={async (event) => {
              event.preventDefault();
              setError('');
              setBusy(true);
              try {
                if (!/^\d+(?:\.\d{1,2})?$/.test(amount.trim()))
                  throw Error('Enter an amount with up to two decimals.');
                if (currency !== trip.currency && !checked)
                  throw Error('Check the converted amount before saving.');
                const expense = expenseSchema.parse({
                  ...entry.expense,
                  title,
                  date,
                  payer,
                  currency,
                  fx:
                    currency === trip.currency
                      ? undefined
                      : { rate: Number(rate), source: 'manual', asOf: date },
                  items: [
                    {
                      ...entry.expense.items[0],
                      name: title,
                      amount: Math.round(Number(amount) * 100),
                      members,
                    },
                  ],
                });
                if (
                  !members.length ||
                  members.some(
                    (id) => !trip.members.some((member) => member.id === id),
                  )
                )
                  throw Error('Choose travellers in this holiday.');
                stampCalculationRules(expense, trip.members);
                expenseTotal(expense, trip.currency);
                const store = await offlineStore();
                await store.enqueue({
                  ...entry,
                  expense,
                  photo: photo ? entry.photo : undefined,
                  receiptId: photo ? entry.receiptId : undefined,
                });
                await onSaved();
                onClose();
              } catch (cause) {
                setError(
                  cause instanceof Error
                    ? cause.message
                    : 'The pending expense could not be updated.',
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              {uiText('Name')}
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
                maxLength={200}
              />
            </label>
            <label>
              {uiText('Date')}
              <input
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                required
              />
            </label>
            <label>
              {uiText('Amount')}
              <input
                inputMode="decimal"
                value={amount}
                onChange={(event) => {
                  setAmount(event.target.value);
                  setChecked(false);
                }}
                required
              />
            </label>
            <label>
              {uiText('Currency')}
              <select
                value={currency}
                onChange={(event) => {
                  setCurrency(event.target.value as Currency);
                  setChecked(false);
                }}
              >
                {CURRENCIES.map((currency) => (
                  <option key={currency.code}>{currency.code}</option>
                ))}
              </select>
            </label>
            {currency !== trip.currency && (
              <>
                <label>
                  {uiText('Manual rate')}
                  <input
                    inputMode="decimal"
                    value={rate}
                    onChange={(event) => {
                      setRate(event.target.value);
                      setChecked(false);
                    }}
                    required
                  />
                </label>
                <p>
                  {converted
                    ? uiText("Converted total: {value0}", { value0: converted })
                    : uiText('Check the exchange rate and amount.')}
                </p>
                <label>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => setChecked(event.target.checked)}
                  />
                  {uiText('I checked the converted amount.')}
                </label>
              </>
            )}
            <label>
              {uiText('Paid by')}
              <select
                value={payer}
                onChange={(event) => setPayer(event.target.value)}
              >
                {trip.members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </label>
            <fieldset>
              <legend>{uiText('Shared by')}</legend>
              {trip.members.map((member) => (
                <label key={member.id}>
                  <input
                    type="checkbox"
                    checked={members.includes(member.id)}
                    onChange={(event) =>
                      setMembers(
                        event.target.checked
                          ? [...members, member.id]
                          : members.filter((id) => id !== member.id),
                      )
                    }
                  />
                  {member.name}
                </label>
              ))}
            </fieldset>
            {entry.photo && (
              <label>
                <input
                  type="checkbox"
                  checked={photo}
                  onChange={(event) => setPhoto(event.target.checked)}
                />
                {uiText('Keep receipt photo')}
              </label>
            )}
            <button className="primary wide" disabled={busy}>
              {uiText('Save pending changes')}
            </button>
          </form>
        )}
        {error && (
          <p className="error" role="alert">
            {uiText(error)}
          </p>
        )}
      </section>
    </ModalA11y>
  );
}
