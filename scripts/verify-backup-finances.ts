// Local, read-only restore check. Never prints profiles, receipt text or balances.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { parseStoredTrip, expenseShares, expenseTotal, balances } from '../lib/model';

const path = process.argv[2];
if (!path || process.argv.length !== 3) throw new Error('Supply the isolated restored SQLite path.');
const db = new DatabaseSync(path, { readOnly: true });
try {
  let tripCount = 0, expenseCount = 0, paymentCount = 0;
  const fingerprint = createHash('sha256');
  for (const row of db.prepare('SELECT id,data FROM trips ORDER BY id').all()) {
    const trip = parseStoredTrip(JSON.parse(String(row.data)));
    if (String(row.id) !== trip.id) throw new Error('Trip identity mismatch.');
    const memberIds = new Set(trip.members.map(member => member.id));
    const costs = trip.expenses.map(expense => {
      if (!memberIds.has(expense.payer)) throw new Error('Unknown payer.');
      const amount = expenseTotal(expense, trip.currency);
      const split = expenseShares(expense, trip.members, trip.currency);
      if (split.reduce((sum, value) => sum + value, 0) !== amount) throw new Error('Receipt share mismatch.');
      return { id: expense.id, amount, split };
    });
    for (const payment of trip.payments) {
      if (!memberIds.has(payment.from) || !memberIds.has(payment.to)) throw new Error('Unknown payment participant.');
    }
    const net = balances(trip);
    if (net.reduce((sum, value) => sum + value, 0) !== 0) throw new Error('Unbalanced trip.');
    fingerprint.update(JSON.stringify({ id: trip.id, currency: trip.currency, costs, payments: trip.payments, net }));
    tripCount++; expenseCount += trip.expenses.length; paymentCount += trip.payments.length;
  }
  console.log(JSON.stringify({ tripCount, expenseCount, paymentCount, financialFingerprint: fingerprint.digest('hex') }));
} catch {
  // Schema/model errors can embed receipt contents. Keep them outside logs.
  console.error('TripTab isolated financial restore verification failed.');
  process.exitCode = 1;
} finally { db.close(); }
