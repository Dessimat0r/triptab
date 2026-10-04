// Second-pass evidence for model-level claims. Run: npx tsx docs/audit/evidence-second-pass/model-recheck.ts
// Pure: imports lib/model.ts only, touches no storage.
import { balances, expenseTotal, settlements, validateLedger, expenseShares, type Trip, type Expense } from '../../../lib/model';

const out: Record<string, unknown> = {};
const base = (over: Partial<Expense>): Expense => ({
  id: 'e', title: 'Dinner', date: '2026-08-15', time: '20:00', timezone: 'Europe/London', currency: 'GBP',
  payer: 'a', items: [{ id: 'i', name: 'Food', amount: 5000, members: ['a', 'b'] }], tax: 0, tip: 0, discount: 0, ...over,
});
const trip = (expenses: Expense[], members = ['a', 'b']): Trip => ({
  id: 't', name: 'T', currency: 'GBP', members: members.map(id => ({ id, name: id })), expenses, drafts: [], payments: [],
});

// 1. F-10: same-currency bankAmount overrides receipt total; bankAmount 0 accepted by the model.
{
  const t = trip([base({ bankAmount: 100 })]);
  validateLedger({ trips: [t] });
  out.f10_sameCurrencyOverride = { receiptTotal: 5000, ledgerTotal: expenseTotal(t.expenses[0], 'GBP'), balances: balances(t) };
  const z = trip([base({ currency: 'EUR', bankAmount: 0 })]);
  validateLedger({ trips: [z] });
  out.f10_bankAmountZeroForeign = { accepted: true, ledgerTotal: expenseTotal(z.expenses[0], 'GBP'), balances: balances(z) };
}

// 2. Unbounded fx rate: converted totals bypass the 100,000,000 cap applied to every other money field.
{
  const t = trip([
    base({ id: 'x1', currency: 'EUR', fx: { rate: 40000000, asOf: '2026-08-15', source: 'manual' }, items: [{ id: 'i', name: 'x', amount: 100000000, members: ['a', 'b'] }] }),
  ]);
  let accepted = true;
  try { validateLedger({ trips: [t] }); } catch { accepted = false; }
  out.unboundedFx = { accepted, convertedTotal: accepted ? expenseTotal(t.expenses[0], 'GBP') : null, cap: 100000000, maxSafe: Number.MAX_SAFE_INTEGER };
  // A typo'd manual rate (8567 instead of 0.8567) on a EUR 100 dinner:
  const typo = trip([base({ currency: 'EUR', fx: { rate: 8567, asOf: '2026-08-15', source: 'manual' }, items: [{ id: 'i', name: 'x', amount: 10000, members: ['a', 'b'] }] })]);
  validateLedger({ trips: [typo] });
  out.manualRateTypo = { accepted: true, convertedTotal: expenseTotal(typo.expenses[0], 'GBP') };
}

// 3. F-13: greedy vs exact minimum number of transfers.
function exactMin(bal: number[]): number {
  const v = bal.filter(Boolean);
  const n = v.length;
  if (!n) return 0;
  const size = 1 << n;
  const sum = new Array<number>(size).fill(0);
  for (let m = 1; m < size; m++) { const low = m & -m; sum[m] = sum[m ^ low] + v[31 - Math.clz32(low)]; }
  const dp = new Array<number>(size).fill(-1);
  dp[0] = 0;
  for (let m = 1; m < size; m++) {
    let best = -1;
    for (let i = 0; i < n; i++) if (m & (1 << i) && dp[m ^ (1 << i)] > best) best = dp[m ^ (1 << i)];
    dp[m] = best + (sum[m] === 0 ? 1 : 0);
  }
  return n - dp[size - 1]; // n minus max number of zero-sum groups
}
{
  const t = trip([], ['d1', 'd2', 'c1', 'c2']);
  t.payments = [{ id: 'p1', from: 'c1', to: 'd2', amount: 7, date: '2026-01-01' }, { id: 'p2', from: 'c2', to: 'd1', amount: 3, date: '2026-01-01' }];
  out.f13_counterExample = { balances: balances(t), greedy: settlements(t), optimum: exactMin(balances(t)) };

  // Realistic "couples/families" trips: households pay for each other and share group costs.
  let rng = 12345;
  const rand = () => (rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648;
  let worse = 0, extra = 0, runs = 0;
  for (let run = 0; run < 3000; run++) {
    const n = 4 + Math.floor(rand() * 5);
    const ids = Array.from({ length: n }, (_, i) => `m${i}`);
    const expenses: Expense[] = [];
    for (let e = 0; e < 3 + Math.floor(rand() * 15); e++) {
      const payer = ids[Math.floor(rand() * n)];
      const pick = rand();
      // a third of costs are within a pair (couple), the rest group-wide
      const members = pick < 0.33 ? [ids[0 + 2 * Math.floor(rand() * Math.floor(n / 2))], ids[1 + 2 * Math.floor(rand() * Math.floor(n / 2))]].filter((v, i, a) => a.indexOf(v) === i) : ids;
      const amount = 100 * (5 + Math.floor(rand() * 200)); // whole pounds, like most real receipts
      expenses.push(base({ id: `e${e}`, payer, items: [{ id: 'i', name: 'x', amount, members }] }));
    }
    const t2 = trip(expenses, ids);
    const g = settlements(t2).length;
    const o = exactMin(balances(t2));
    runs++;
    if (g > o) { worse++; extra += g - o; }
  }
  out.f13_structured = { runs, greedyWorse: worse, extraTransfers: extra };
}

// 4. F-21: the remainder penny goes to the first selected member (they owe it).
{
  const t = trip([base({ items: [{ id: 'i', name: 'x', amount: 1000, members: ['a', 'b', 'c'] }] })], ['a', 'b', 'c']);
  out.f21_split = expenseShares(t.expenses[0], t.members, 'GBP');
}

// 5. F-14: client date = UTC date, time = local time, tz = device tz. How often is the date wrong,
// and how often would /api/fx reject it as a future transaction? Mirrors app/page.tsx:48,276-279 and app/api/fx/route.ts:18-26,62.
function localTimestamp(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const p = (type: string) => parts.find(x => x.type === type)!.value;
  return `${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}`;
}
{
  const zones = ['Europe/London', 'Europe/Berlin', 'Europe/Istanbul', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney', 'Asia/Tokyo'];
  const result: Record<string, { wrongDateHours: number; fxRejectedHours: number; example?: string }> = {};
  for (const zone of zones) {
    let wrong = 0, rejected = 0, example: string | undefined;
    for (let minute = 0; minute < 24 * 60; minute += 15) {
      const instant = new Date(Date.UTC(2026, 9, 4, 0, minute)); // 4 Oct 2026, every 15 minutes
      const local = localTimestamp(instant, zone);
      const clientDate = instant.toISOString().slice(0, 10);
      const clientTime = local.slice(11);
      if (clientDate !== local.slice(0, 10)) { wrong += 0.25; example ??= `local ${local} recorded as ${clientDate} ${clientTime}`; }
      if (`${clientDate}T${clientTime}` > local) rejected += 0.25;
    }
    result[zone] = { wrongDateHours: wrong, fxRejectedHours: rejected, example };
  }
  out.f14_dates = result;
}

console.log(JSON.stringify(out, null, 2));
