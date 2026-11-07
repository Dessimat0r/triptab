import type { Expense } from '../../lib/model';

/**
 * The required receipt (invariant 1): Pringles 300, Pringles 300, milk 150,
 * an item-scoped BOGOF −300 on both Pringles, printed total 450. Bob pays.
 * Both Pringles are Alice's and the milk is shared, so the shares are 375/75
 * and Alice owes Bob 375. A reader that ignores the discount sees 675/75 and
 * suggests 675 (R01).
 */
export const bogofMembers = [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }];
export function bogofExpense(id = 'bogof'): Expense {
  return { id, title: 'Tesco', date: '2026-11-06', time: '12:00', timezone: 'Europe/London', currency: 'GBP', payer: 'bob',
    tax: 0, tip: 0, discount: 0,
    items: [{ id: 'p1', name: 'Pringles', amount: 300, members: ['alice'] }, { id: 'p2', name: 'Pringles', amount: 300, members: ['alice'] },
      { id: 'milk', name: 'Milk', amount: 150, members: ['alice', 'bob'] }],
    adjustments: [{ id: 'bogof-line', kind: 'discount', label: 'BOGOF Pringles', amount: 300, scope: { type: 'items', itemIds: ['p1', 'p2'] } }],
    adjustmentAllocation: 'scoped-adjustments' };
}
