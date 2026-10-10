import {
  CURRENCIES,
  expenseSchema,
  tripSchema,
  validateLedger,
  type Currency,
  type Expense,
  type Trip,
} from './model';

const maximumBytes = 2_000_000;
const newId = () => crypto.randomUUID();
const supported = (value: string): Currency => {
  const currency = value.trim().toUpperCase();
  if (!CURRENCIES.some((item) => item.code === currency))
    throw Error(`Unsupported currency: ${currency}`);
  return currency as Currency;
};
const hundredths = (value: string) => {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim()))
    throw Error(`Enter a positive amount with up to two decimals: ${value}`);
  const [whole, fraction = ''] = value.trim().split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount) || amount > 100_000_000)
    throw Error('An imported amount exceeds the expense limit.');
  return amount;
};

/** Bounded RFC 4180 parser, including escaped quotes and multiline fields. */
export function parseCsv(text: string): string[][] {
  if (new TextEncoder().encode(text).length > maximumBytes)
    throw Error('Import files must be no larger than 2 MB.');
  const rows: string[][] = [];
  let row: string[] = [],
    field = '',
    quoted = false,
    closed = false;
  text = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += character;
      continue;
    }
    if (character === '"') {
      if (field || closed) throw Error('A CSV quote is out of place.');
      quoted = true;
      continue;
    }
    if (character === ',' || character === '\n' || character === '\r') {
      row.push(field);
      field = '';
      closed = false;
      if (character !== ',') {
        if (row.some((value) => value.trim())) rows.push(row);
        row = [];
        if (character === '\r' && text[index + 1] === '\n') index++;
      }
      continue;
    }
    if (closed && character !== ' ' && character !== '\t')
      throw Error('Unexpected text after a CSV quote.');
    if (!closed) field += character;
  }
  if (quoted) throw Error('A CSV quoted field is unfinished.');
  row.push(field);
  if (row.some((value) => value.trim())) rows.push(row);
  if (rows.length > 2001 || rows.some((row) => row.length > 100))
    throw Error('This CSV has too many rows or columns.');
  return rows;
}

function exactExpense(
  title: string,
  date: string,
  currency: Currency,
  payer: string,
  amount: number,
  allocations: Record<string, number>,
): Expense {
  if (
    Object.values(allocations).some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    ) ||
    Object.values(allocations).reduce((sum, value) => sum + value, 0) !== amount
  )
    throw Error('Participant shares do not add up to the expense total.');
  const selected = Object.keys(allocations).filter((id) => allocations[id] > 0);
  return expenseSchema.parse({
    id: newId(),
    title,
    date,
    currency,
    payer,
    source: 'manual',
    adjustmentAllocation: 'receipt-total',
    tax: 0,
    tip: 0,
    discount: 0,
    items: [
      {
        id: newId(),
        name: title,
        amount,
        members: selected,
        units: {
          total: amount / 100,
          allocations: Object.fromEntries(
            selected.map((id) => [id, allocations[id] / 100]),
          ),
        },
      },
    ],
  });
}

export type ImportPreview = { trips: Trip[]; notes: string[] };
/** Imports are new holidays. No source account, payment destination or photo is adopted. */
export function previewImport(text: string, filename: string): ImportPreview {
  if (new TextEncoder().encode(text).length > maximumBytes)
    throw Error('Import files must be no larger than 2 MB.');
  if (filename.toLowerCase().endsWith('.json') || text.trim().startsWith('{')) {
    const document = JSON.parse(text);
    if (
      document.schemaVersion !== 1 ||
      document.amountScale !== 100 ||
      !Array.isArray(document.data?.trips)
    )
      throw Error('Choose a TripTab JSON export with schema version 1.');
    if (!document.data.trips.length || document.data.trips.length > 50)
      throw Error('Choose an export containing 1–50 holidays.');
    const trips = document.data.trips.map((value: unknown) => {
      const trip = tripSchema.parse(value);
      trip.id = newId();
      delete trip.ownerId;
      trip.members = trip.members.map(
        ({ id, name, weight, joinedOn, leftOn, retired }) => ({
          id,
          name,
          weight,
          joinedOn,
          leftOn,
          retired,
        }),
      );
      trip.drafts = [];
      trip.expenses = trip.expenses.map((entry) => {
        const copy = structuredClone(entry);
        for (const key of [
          'receiptId',
          'receiptScan',
          'conversation',
          'memory',
          'sourceDraftId',
          'languageViewId',
          'fieldSources',
        ] as const)
          delete copy[key];
        copy.items = copy.items.map((item) => {
          const copy = { ...item };
          delete copy.fieldSources;
          delete copy.scanSource;
          return copy;
        });
        return copy;
      });
      return trip;
    });
    return {
      trips: validateLedger({ trips }, { preserveCalculationRules: true })
        .trips,
      notes: [
        'Financial entries, item splits and saved rounding rules are copied. Photos, pending drafts, chats, history, account links and payment details are excluded.',
      ],
    };
  }
  const rows = parseCsv(text);
  if (rows.length < 2) throw Error('The CSV has no expenses.');
  const headers = rows[0].map((value) => value.trim()),
    normalized = headers.map((value) =>
      value.toLowerCase().replace(/[ _-]/g, ''),
    );
  const get = (row: string[], ...names: string[]) => {
    const index = normalized.findIndex((header) => names.includes(header));
    return index < 0 ? '' : (row[index] || '').trim();
  };
  const names: string[] = [],
    members = new Map<string, string>();
  const member = (name: string) => {
    name = name.trim();
    if (!name) throw Error('A traveller name is missing.');
    if (!members.has(name)) {
      if (names.length >= 50) throw Error('Import no more than 50 travellers.');
      names.push(name);
      members.set(name, newId());
    }
    return members.get(name)!;
  };
  const triptab = normalized.includes('recordtype');
  const shareColumns = headers.flatMap((header, index) =>
    header.endsWith('_cost_share_hundredths')
      ? [{ name: header.slice(0, -'_cost_share_hundredths'.length), index }]
      : [],
  );
  const wide = !triptab && !normalized.includes('paidby');
  const known = new Set([
    'date',
    'description',
    'title',
    'category',
    'cost',
    'amount',
    'currency',
    'notes',
    'note',
  ]);
  const participantColumns = wide
    ? headers.flatMap((name, index) =>
        !known.has(normalized[index]) ? [{ name, index }] : [],
      )
    : [];
  if (wide && !participantColumns.length)
    throw Error(
      'CSV needs Paid by and Shared by columns, or Splitwise participant balance columns.',
    );
  for (const column of [...shareColumns, ...participantColumns])
    member(column.name);
  let currency: Currency | undefined;
  const expenses: Expense[] = [],
    payments: Trip['payments'] = [];
  for (let index = 1; index < rows.length; index++) {
    const row = rows[index];
    if (row.length !== headers.length)
      throw Error(`CSV row ${index + 1} has a different number of columns.`);
    const date = get(row, 'transactiondatelocal', 'date'),
      title = get(row, 'description', 'title');
    if (!date && /^(total balance|total costs|total)$/i.test(title || row[0]))
      continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      throw Error(`Row ${index + 1}: dates must use YYYY-MM-DD.`);
    const code = supported(get(row, 'settlementcurrency', 'currency') || 'GBP');
    if (currency && currency !== code)
      throw Error(
        'CSV imports need one settlement currency. Use a TripTab JSON export to preserve multiple receipt currencies.',
      );
    currency = code;
    if (triptab && get(row, 'recordtype') === 'payment') {
      payments.push({
        id: newId(),
        date,
        from: member(get(row, 'from')),
        to: member(get(row, 'to')),
        amount: Number(get(row, 'settlementamounthundredths')),
        method: get(row, 'paymentmethod') || undefined,
        note: get(row, 'note') || undefined,
      });
      continue;
    }
    if (triptab && get(row, 'recordtype') !== 'expense')
      throw Error(`Row ${index + 1}: unknown record type.`);
    if (triptab && get(row, 'calculationerror'))
      throw Error(
        `Row ${index + 1} needs review in the source holiday before importing.`,
      );
    const amount = triptab
      ? Number(get(row, 'settlementamounthundredths'))
      : hundredths(get(row, 'cost', 'amount'));
    let payer: string,
      allocations: Record<string, number> = {};
    if (triptab) {
      payer = member(get(row, 'paidby'));
      for (const column of shareColumns)
        allocations[member(column.name)] = Number(row[column.index]);
    } else if (wide) {
      const net = participantColumns.map((column) => {
        const value = row[column.index].trim();
        if (!/^-?\d+(?:\.\d{1,2})?$/.test(value))
          throw Error(`Row ${index + 1}: unsupported participant balance.`);
        return {
          id: member(column.name),
          value:
            (value.startsWith('-') ? -1 : 1) *
            hundredths(value.replace(/^-/, '')),
        };
      });
      const payers = net.filter((value) => value.value > 0);
      if (
        payers.length !== 1 ||
        net.reduce((sum, value) => sum + value.value, 0) !== 0
      )
        throw Error(
          `Row ${index + 1}: cannot infer a single payer. Use a CSV with Paid by and Shared by columns.`,
        );
      payer = payers[0].id;
      allocations = Object.fromEntries(
        net.map((value) => [
          value.id,
          value.id === payer ? amount - value.value : -value.value,
        ]),
      );
    } else {
      payer = member(get(row, 'paidby'));
      const shared = get(row, 'sharedby', 'participants')
        .split(/[;|]/)
        .map((value) => value.trim())
        .filter(Boolean);
      if (!shared.length)
        throw Error(
          `Row ${index + 1}: list Shared by travellers separated with semicolons.`,
        );
      const ids = [...new Set(shared.map(member))];
      allocations = Object.fromEntries(
        ids.map((id, index) => [
          id,
          Math.floor(amount / ids.length) +
            (index < amount % ids.length ? 1 : 0),
        ]),
      );
    }
    expenses.push(
      exactExpense(
        title || 'Imported expense',
        date,
        code,
        payer,
        amount,
        allocations,
      ),
    );
  }
  const trip: Trip = {
    id: newId(),
    name: filename.replace(/\.[^.]+$/, '').slice(0, 90) || 'Imported holiday',
    currency: currency || 'GBP',
    members: names.map((name) => ({ id: members.get(name)!, name })),
    expenses,
    payments,
    drafts: [],
  };
  return {
    trips: validateLedger({ trips: [trip] }, { preserveCalculationRules: true })
      .trips,
    notes: [
      triptab
        ? 'CSV restores settlement amounts and each traveller’s exact share as one line per expense. Use JSON to keep original item detail and receipt currencies.'
        : 'CSV restores a single payer and exact cost shares per expense. Refunds, mixed currencies and ambiguous payers need conversion before importing.',
    ],
  };
}

export function prepareImportedTrip(value: unknown, memberId: string): Trip {
  const trip = tripSchema.parse(value);
  if (!trip.members.some((member) => member.id === memberId && !member.retired))
    throw Error('Choose your traveller in the imported holiday.');
  delete trip.ownerId;
  trip.members = trip.members.map(
    ({ id, name, weight, joinedOn, leftOn, retired }) => ({
      id,
      name,
      weight,
      joinedOn,
      leftOn,
      retired,
    }),
  );
  trip.drafts = [];
  if (
    trip.expenses.some(
      (entry) =>
        entry.receiptId ||
        entry.receiptScan ||
        entry.conversation?.length ||
        entry.memory,
    )
  )
    throw Error('Import a financial copy without receipt images or chats.');
  return validateLedger({ trips: [trip] }, { preserveCalculationRules: true })
    .trips[0];
}
