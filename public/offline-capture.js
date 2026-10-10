/* The offline screen records new entries only; it never replaces a ledger. */
(() => {
  'use strict';
  const store = globalThis.TripTabOffline;
  const status = document.getElementById('capture-status'),
    form = document.getElementById('offline-expense'),
    holiday = document.getElementById('capture-trip');
  const payer = document.getElementById('capture-payer'),
    people = document.getElementById('capture-people'),
    currency = document.getElementById('capture-currency');
  let context, shared, trip;
  const option = (select, value, label) => {
    const item = document.createElement('option');
    item.value = value;
    item.textContent = label;
    select.append(item);
  };
  const notice = (value) => {
    status.textContent = value;
  };
  let peopleTouched = false;
  people.addEventListener('change', () => {
    peopleTouched = true;
  });
  const date = document.getElementById('capture-date');
  date.value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
  function selectTrip(keepPurchase = false) {
    const previousPayer = payer.value,
      previousCurrency = currency.value;
    trip = context.trips.find((value) => value.id === holiday.value);
    payer.replaceChildren();
    people.replaceChildren();
    for (const member of trip.members) {
      option(payer, member.id, member.name);
      const label = document.createElement('label'),
        input = document.createElement('input');
      input.type = 'checkbox';
      input.value = member.id;
      input.checked =
        !member.retired &&
        (!member.joinedOn || member.joinedOn <= date.value) &&
        (!member.leftOn || member.leftOn >= date.value);
      label.append(
        input,
        document.createTextNode(
          member.name +
            ((member.weight ?? 1) > 1 ? ` (counts as ${member.weight})` : ''),
        ),
      );
      people.append(label);
    }
    payer.value =
      trip.members.find((member) => member.userId === context.accountId)?.id ??
      trip.members[0].id;
    currency.value = trip.currency;
    document.getElementById('rate-currency').textContent = trip.currency;
    if (keepPurchase) {
      payer.value = previousPayer;
      currency.value = previousCurrency;
    }
    selectCurrency();
  }
  function selectCurrency() {
    document.getElementById('capture-rate-field').hidden =
      currency.value === trip.currency;
    document.getElementById('capture-rate-confirm').hidden =
      currency.value === trip.currency;
    previewAmount();
  }
  function previewAmount() {
    document.getElementById('capture-rate-checked').checked = false;
    const amount = Number(
        document.getElementById('capture-amount').value.replace(',', '.'),
      ),
      rate = Number(
        document.getElementById('capture-rate').value.replace(',', '.'),
      );
    document.getElementById('capture-converted').textContent =
      trip &&
      currency.value !== trip.currency &&
      Number.isFinite(amount * rate) &&
      amount > 0 &&
      rate > 0
        ? `Converted total: ${(amount * rate).toFixed(['ISK', 'JPY', 'KRW', 'VND', 'CLP'].includes(trip.currency) ? 0 : 2)} ${trip.currency}`
        : '';
  }
  document
    .getElementById('capture-amount')
    .addEventListener('input', previewAmount);
  document
    .getElementById('capture-rate')
    .addEventListener('input', previewAmount);
  holiday.addEventListener('change', () => {
    peopleTouched = false;
    selectTrip();
  });
  currency.addEventListener('change', selectCurrency);
  date.addEventListener('change', () => {
    if (!peopleTouched) selectTrip(true);
  });
  Promise.resolve()
    .then(async () => {
      const active = await store.operation('settings', 'get', 'active');
      if (!active) {
        notice(
          'Enable offline capture in TripTab while connected. Your pending expenses remain on this device.',
        );
        return;
      }
      context = await store.operation('contexts', 'get', active.accountId);
      if (!context?.trips.length) {
        notice('Open TripTab online to refresh your holidays first.');
        return;
      }
      for (const value of context.trips) option(holiday, value.id, value.name);
      for (const value of context.currencies)
        option(currency, value.code, `${value.code} · ${value.name}`);
      selectTrip();
      form.hidden = false;
      const pending = (await store.operation('queue', 'getAll')).filter(
        (entry) => entry.accountId === context.accountId,
      );
      notice(`${pending.length} expenses waiting to sync for ${context.name}.`);
      const photos = await store.operation('shared', 'getAll');
      shared = photos.find((photo) => photo.createdAt >= Date.now() - 86400000);
      if (shared) document.getElementById('capture-shared').hidden = false;
    })
    .catch(() =>
      notice(
        'This browser cannot save offline. Reconnect to record the expense.',
      ),
    );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const text = document
        .getElementById('capture-amount')
        .value.trim()
        .replace(',', '.');
      if (!/^\d+(?:\.\d{1,2})?$/.test(text))
        throw Error('Enter an amount with at most two decimal places.');
      const amount = Math.round(Number(text) * 100),
        members = [...people.querySelectorAll('input:checked')].map(
          (input) => input.value,
        );
      if (
        !Number.isSafeInteger(amount) ||
        amount <= 0 ||
        amount > 100000000 ||
        !members.length
      )
        throw Error('Enter a positive amount and choose who shares it.');
      const id = crypto.randomUUID(),
        current = new Date(),
        title = document.getElementById('capture-title').value.trim();
      if (!title || title.length > 200) throw Error('Enter an expense name.');
      const rate = Number(
        document.getElementById('capture-rate').value.replace(',', '.'),
      );
      if (
        currency.value !== trip.currency &&
        (!Number.isFinite(rate) || rate <= 0)
      )
        throw Error(
          `Enter a manual rate in ${trip.currency}, or use that currency for the amount.`,
        );
      if (
        ['ISK', 'JPY', 'KRW', 'VND', 'CLP'].includes(currency.value) &&
        amount % 100
      )
        throw Error(`${currency.value} totals must be whole currency units.`);
      if (
        currency.value !== trip.currency &&
        (!document.getElementById('capture-rate-checked').checked ||
          amount * rate > 100000000 ||
          amount * rate <
            (['ISK', 'JPY', 'KRW', 'VND', 'CLP'].includes(trip.currency)
              ? 50
              : 0.5))
      )
        throw Error(
          'Check the manual rate and converted total before saving. The converted amount must be within the expense limit.',
        );
      const memberWeights = Object.fromEntries(
        trip.members
          .filter((member) => (member.weight ?? 1) > 1)
          .map((member) => [member.id, member.weight]),
      );
      const expense = {
        id,
        title,
        date: date.value,
        time: current.toTimeString().slice(0, 5),
        timezone:
          Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/London',
        currency: currency.value,
        payer: payer.value,
        items: [{ id: crypto.randomUUID(), name: title, amount, members }],
        tax: 0,
        tip: 0,
        discount: 0,
        source: 'manual',
        adjustmentAllocation: 'native-minor-units',
        ...(Object.keys(memberWeights).length ? { memberWeights } : {}),
        ...(currency.value !== trip.currency
          ? { fx: { rate, asOf: date.value, source: 'manual' } }
          : {}),
      };
      const photo =
        document.getElementById('capture-photo').files[0] || shared?.photo;
      await store.enqueue({
        id,
        accountId: context.accountId,
        tripId: trip.id,
        expense,
        photo,
        createdAt: Date.now(),
      });
      if (shared && !document.getElementById('capture-photo').files.length) {
        await store.operation('shared', 'delete', shared.id);
        shared = null;
        document.getElementById('capture-shared').hidden = true;
      }
      document.getElementById('capture-title').value = '';
      document.getElementById('capture-amount').value = '';
      document.getElementById('capture-photo').value = '';
      notice('Saved on this device. Open TripTab when connected to sync it.');
    } catch (error) {
      notice(
        error instanceof Error
          ? error.message
          : 'Unable to save. Your details are still here.',
      );
    } finally {
      button.disabled = false;
    }
  });
})();
