import { allocate, balances, settlements, expenseShares, expenseTotal, shares, total, validateLedger, convertAmount, itemShares } from '/home/user/triptab/lib/model';
import type { Expense, Trip } from '/home/user/triptab/lib/model';

// deterministic PRNG
let seed = 123456789;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 2 ** 32; };
const ri = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const pick = <T,>(xs: T[]) => xs[ri(0, xs.length - 1)];
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const out = (id: string, outcome: string, detail = '') => console.log(`[${outcome}] ${id} ${detail}`);

function mkMembers(n: number) { return Array.from({ length: n }, (_, i) => ({ id: `m${i}`, name: `M${i}` })); }
function randExpense(members: { id: string }[], base: string, i: number): Expense {
  const cur = pick(['GBP', 'GBP', 'EUR', 'PLN', 'HUF', 'ISK'] as const);
  const nItems = ri(1, 6);
  const items = Array.from({ length: nItems }, (_, k) => {
    const n = ri(1, members.length); const ids = [...members].sort(() => rnd() - 0.5).slice(0, n).map(m => m.id);
    const mode = ri(0, 2);
    let percentages: Record<string, number> | undefined;
    if (mode === 2 && ids.length > 1) {
      let left = 10000; percentages = {};
      ids.forEach((id, idx) => { const v = idx === ids.length - 1 ? left : ri(0, left); left -= v; percentages![id] = v / 100; });
    }
    return { id: `i${i}-${k}`, name: 'x', amount: ri(0, 250000), members: ids, ...(percentages ? { percentages } : {}) };
  });
  const sumItems = sum(items.map(x => x.amount));
  const tax = rnd() < 0.4 ? ri(0, 5000) : 0, tip = rnd() < 0.4 ? ri(0, 5000) : 0;
  const discount = rnd() < 0.3 ? ri(0, Math.min(sumItems + tax + tip, 4000)) : 0;
  const e: Expense = { id: `e${i}`, title: 't', date: '2026-08-15', time: '12:00', timezone: 'Europe/London', currency: cur, payer: pick(members).id, items, tax, tip, discount } as Expense;
  if (cur !== base) { if (rnd() < 0.5) (e as any).bankAmount = ri(1, 400000); else (e as any).fx = { rate: Math.round(rnd() * 1e5) / 1e4 + 0.0001, asOf: '2026-08-14', source: 'manual' }; }
  if (rnd() < 0.15) { (e as any).percentages = { [members[0].id]: 50, [members[members.length - 1].id]: 50 }; }
  return e;
}

// 1+2+3: share-sum, net zero, order independence, settlement zeroing
let bad = { shares: 0, zero: 0, order: 0, settle: 0, skipped: 0, determinism: 0 }, trials = 0, extraTransfers = 0, settleCases = 0;
for (let t = 0; t < 4000; t++) {
  const members = mkMembers(ri(2, 9)); const base = 'GBP';
  const expenses: Expense[] = []; for (let i = 0; i < ri(1, 25); i++) { const e = randExpense(members, base, i); try { expenseTotal(e, base); if (total(e) > 0) expenses.push(e); else bad.skipped++; } catch { bad.skipped++; } }
  if (!expenses.length) continue; trials++;
  const trip: Trip = { id: 't', name: 'T', currency: 'GBP', members, expenses, drafts: [], payments: [] };
  try { validateLedger({ trips: [trip] }); } catch (e) { bad.skipped++; continue; }
  for (const e of expenses) if (sum(expenseShares(e, members, base)) !== expenseTotal(e, base)) bad.shares++;
  const bal = balances(trip); if (sum(bal) !== 0) bad.zero++;
  const shuffled = { ...trip, expenses: [...expenses].sort(() => rnd() - 0.5) };
  if (JSON.stringify(balances(shuffled)) !== JSON.stringify(bal)) bad.order++;
  const s = settlements(trip);
  if (JSON.stringify(s) !== JSON.stringify(settlements(shuffled))) bad.determinism++;
  const withPay = { ...trip, payments: s.map((p, i) => ({ ...p, id: `p${i}`, date: '2026-08-16' })) };
  if (balances(withPay).some(x => x !== 0)) bad.settle++;
  // minimal transfers = nonzero - maxZeroSumPartitions (brute force for n<=9)
  const nz = bal.filter(x => x !== 0); const k = nz.length;
  if (k <= 9 && k > 0) {
    // dp over subsets: maximum number of disjoint zero-sum subsets covering all
    const sumMask = new Array(1 << k).fill(0); for (let m = 1; m < 1 << k; m++) { const lb = m & -m; sumMask[m] = sumMask[m ^ lb] + nz[31 - Math.clz32(lb)]; }
    const dp = new Array(1 << k).fill(0);
    for (let m = 1; m < 1 << k; m++) { let best = 0; for (let sub = m; sub; sub = (sub - 1) & m) if (sumMask[sub] === 0) best = Math.max(best, dp[m ^ sub] + 1); dp[m] = best; }
    const minTransfers = k - dp[(1 << k) - 1]; settleCases++; extraTransfers += s.length - minTransfers;
    if (s.length < minTransfers) out('settlement-below-theoretical-min', 'IMPOSSIBLE', '');
  }
}
out('random-invariants', Object.values(bad).slice(0, 4).every(v => v === 0) ? 'HELD' : 'VIOLATED', JSON.stringify({ trials, ...bad }));
out('settlement-optimality', 'INFO', `avg extra transfers vs minimum over ${settleCases} cases = ${(extraTransfers / settleCases).toFixed(3)}`);

// worst-case greedy example
{
  const members = mkMembers(6);
  // balances: +10,+10,+10 (m0..m2) and -10,-10,-10 (m3..m5) -> optimal 3 transfers. Craft where greedy needs more: creditors 6,4 debtors 5,5
  const mk = (b: number[]): Trip => ({ id: 't', name: 'T', currency: 'GBP', members: members.slice(0, b.length), drafts: [], expenses: [], payments: [] });
  // craft via payments (payments directly encode balances)
  const target = [6, 4, -5, -5];
  const tr = mk(target); tr.payments = [{ id: 'p1', from: 'm2', to: 'm0', amount: 5, date: '2026-01-01' }, { id: 'p2', from: 'm3', to: 'm1', amount: 4, date: '2026-01-01' }, { id: 'p3', from: 'm3', to: 'm0', amount: 1, date: '2026-01-01' }];
  // balances() for payments: from +amt, to -amt, so m2:+5? invert: paying makes balance positive. Use opposite direction to create debts.
  tr.payments = tr.payments.map(p => ({ ...p, from: p.to, to: p.from }));
  out('greedy-example', 'INFO', `balances=${JSON.stringify(balances(tr))} suggested=${JSON.stringify(settlements(tr).map(s => [s.from, s.to, s.amount]))}`);
}

// 4: £10 / 3
out('10.00/3', 'INFO', JSON.stringify(allocate(1000, [1, 1, 1])));
// remainder recipient depends on selection order
{
  const m = mkMembers(3);
  const a = itemShares({ id: 'i', name: 'x', amount: 1000, members: ['m0', 'm1', 'm2'] }, m);
  const b = itemShares({ id: 'i', name: 'x', amount: 1000, members: ['m2', 'm0', 'm1'] }, m);
  out('remainder-depends-on-chip-click-order', JSON.stringify(a) !== JSON.stringify(b) ? 'CONFIRMED' : 'no', `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}
// systematic bias to first listed member
{
  const members = mkMembers(6); let extra = new Array(6).fill(0); const N = 500;
  for (let i = 0; i < N; i++) { const amt = ri(100, 20000); const sh = allocate(amt, members.map(() => 1)); sh.forEach((v, k) => extra[k] += v - amt / 6); }
  out('first-member-penny-bias(500 items,6 members)', 'INFO', `cumulative over-/under-charge in pence per member: ${extra.map(x => x.toFixed(1)).join(', ')}`);
}

// 5: same-currency bankAmount override
{
  const members = mkMembers(2);
  const e: Expense = { id: 'e', title: 't', date: '2026-08-15', time: '12:00', timezone: 'Europe/London', currency: 'GBP', payer: 'm0', items: [{ id: 'i', name: 'x', amount: 5000, members: ['m0', 'm1'] }], tax: 0, tip: 0, discount: 0, bankAmount: 100 };
  const trip: Trip = { id: 't', name: 'T', currency: 'GBP', members, expenses: [e], drafts: [], payments: [] };
  try { validateLedger({ trips: [trip] }); out('same-currency-bankAmount-override', 'ACCEPTED', `receipt total ${total(e)} but ledger total ${expenseTotal(e, 'GBP')}; balances ${JSON.stringify(balances(trip))}`); } catch (err) { out('same-currency-bankAmount-override', 'REJECTED', String(err)); }
}
// 6: zero items + tax split across all members
{
  const members = mkMembers(4);
  const e: Expense = { id: 'e', title: 't', date: '2026-08-15', time: '12:00', timezone: 'Europe/London', currency: 'GBP', payer: 'm0', items: [{ id: 'i', name: 'x', amount: 0, members: ['m1'] }], tax: 1000, tip: 0, discount: 0 };
  out('zero-items-with-tax', 'INFO', `shares=${JSON.stringify(shares(e, members))} (item assigned only to m1)`);
  const e2 = { ...e, items: [{ id: 'i', name: 'x', amount: 0, members: ['m1'] }], tax: 0, bankAmount: 500, currency: 'EUR' as const };
  out('zero-total-with-bankAmount', 'INFO', `expenseShares=${JSON.stringify(expenseShares(e2 as Expense, members, 'GBP'))}`);
}
// 7: convertAmount boundaries
for (const [amt, rate] of [[1, 0.5], [3, 0.5], [5, 0.1], [1, 0.005], [10, 0.045], [123456789, 0.8567], [100000000, 1234.56789]] as [number, number][]) {
  out('convertAmount', 'INFO', `${amt}c * ${rate} = ${convertAmount(amt, rate)}c  (float ref ${(amt * rate).toFixed(4)})`);
}
// 8: zero-decimal currencies: ISK/HUF/JPY semantics
out('minor-units', 'INFO', 'model hard-codes /100 for every currency incl. ISK/HUF (ISO exponent 0/2); UI formats with Intl min/max 2 fraction digits');
// 9: persistence round trip
{
  const members = mkMembers(3); const trip: Trip = { id: 't', name: 'T', currency: 'GBP', members, expenses: [randExpense(members, 'GBP', 1)], drafts: [], payments: [] };
  const rt = JSON.parse(JSON.stringify(trip)); out('roundtrip-balances-equal', JSON.stringify(balances(trip)) === JSON.stringify(balances(rt)) ? 'HELD' : 'VIOLATED');
}
// 10: member-order dependence of tax/tip remainder
{
  const m = mkMembers(3);
  const e: Expense = { id: 'e', title: 't', date: '2026-08-15', time: '12:00', timezone: 'Europe/London', currency: 'GBP', payer: 'm0', items: [{ id: 'i1', name: 'x', amount: 1000, members: ['m0'] }, { id: 'i2', name: 'y', amount: 1000, members: ['m1'] }, { id: 'i3', name: 'z', amount: 1000, members: ['m2'] }], tax: 100, tip: 0, discount: 0 };
  out('tax-100p-over-3-equal-items', 'INFO', JSON.stringify(shares(e, m)));
}
