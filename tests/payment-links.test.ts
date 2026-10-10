import assert from 'node:assert/strict';
import test from 'node:test';
import { hasPaymentDetails, normalisePaymentHandle, paymentDetailsSummary, paymentLinks, payToSchema } from '../lib/payment-links';
import { validateLedger, type Trip } from '../lib/model';

test('pasted links, @handles and bare usernames normalise to one handle', () => {
  assert.equal(normalisePaymentHandle('paypal', 'https://www.paypal.me/AliceSmith/25'), 'AliceSmith');
  assert.equal(normalisePaymentHandle('paypal', 'paypal.me/alice'), 'alice');
  assert.equal(normalisePaymentHandle('revolut', '@alice.smith'), 'alice.smith');
  assert.equal(normalisePaymentHandle('monzo', ' monzo.me/alice?d=x '), 'alice');
  assert.equal(normalisePaymentHandle('wise', 'https://wise.com/pay/me/alices'), 'alices');
  assert.equal(normalisePaymentHandle('monzo', ''), '');
  assert.equal(normalisePaymentHandle('paypal', 'alice smith'), null);
  assert.equal(normalisePaymentHandle('paypal', 'evil.example'), null, 'PayPal usernames are letters and digits');
  assert.equal(normalisePaymentHandle('revolut', 'ab'), null);
});

test('links carry the amount and currency where the service supports it', () => {
  const payTo = { paypal: 'alice', monzo: 'alice', revolut: 'alice.s', wise: 'alices', bank: 'GB00 TEST' };
  assert.deepEqual(paymentLinks(payTo, 4210, 'GBP', 'TripTab: Lisbon & Porto').map(link => [link.label, link.href, link.withAmount]), [
    ['PayPal', 'https://paypal.me/alice/42.10GBP', true],
    ['Monzo', 'https://monzo.me/alice/42.10?d=TripTab%3A%20Lisbon%20%26%20Porto', true],
    ['Revolut', 'https://revolut.me/alice.s', false],
    ['Wise', 'https://wise.com/pay/me/alices', false],
  ]);
  // Monzo.me requests are in pounds only.
  assert.deepEqual(paymentLinks({ monzo: 'alice' }, 500, 'EUR', 'x'), [{ key: 'monzo', label: 'Monzo', withAmount: false, href: 'https://monzo.me/alice' }]);
  assert.deepEqual(paymentLinks(undefined, 500, 'EUR', 'x'), []);
  assert.deepEqual(paymentLinks({ paypal: 'bad/../path' }, 500, 'EUR', 'x'), [], 'invalid saved handles never become links');
});

test('the schema accepts handles only and summarises saved details', () => {
  assert.equal(payToSchema.safeParse({ paypal: 'alice', bank: '  IBAN  ' }).data?.bank, 'IBAN');
  assert.equal(payToSchema.safeParse({ paypal: 'https://evil.example' }).success, false);
  assert.equal(payToSchema.safeParse({ venmo: 'alice' }).success, false);
  assert.equal(payToSchema.safeParse({ bank: 'x'.repeat(201) }).success, false);
  assert.equal(hasPaymentDetails({}), false);
  assert.equal(hasPaymentDetails({ bank: 'IBAN' }), true);
  assert.equal(paymentDetailsSummary({ paypal: 'alice', bank: 'IBAN' }), 'PayPal: alice\nBank: IBAN');
  assert.equal(paymentDetailsSummary(undefined), 'No payment details');
});

test('saved travellers keep payment details through ledger validation', () => {
  const trip: Trip = { id: 't', name: 'Lisbon', currency: 'EUR', expenses: [], drafts: [], payments: [],
    members: [{ id: 'a', name: 'Alice', payTo: { revolut: 'alice.s' } }, { id: 'b', name: 'Bob' }] };
  assert.deepEqual(validateLedger({ trips: [trip] }).trips[0].members[0].payTo, { revolut: 'alice.s' });
  assert.throws(() => validateLedger({ trips: [{ ...trip, members: [{ id: 'a', name: 'Alice', payTo: { revolut: 'http://x' } }] }] }));
});
