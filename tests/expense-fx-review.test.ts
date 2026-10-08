import assert from 'node:assert/strict';
import test from 'node:test';
import { manualFxReview } from '../lib/expense-fx-review';
import type { ReceiptEditor } from '../lib/receipt-processing';

const entry: ReceiptEditor = {id:'fx',title:'Lunch',date:'2026-10-08',time:'12:00',timezone:'Europe/Vienna',payer:'alice',currency:'EUR',items:[{id:'coffee',name:'Coffee',amount:1000,members:['alice']}],tax:0,tip:0,discount:0,fx:{rate:0.98,source:'manual',asOf:'2026-10-08'}};
const reference={rate:0.86,currency:'EUR',date:entry.date,time:entry.time,timezone:entry.timezone};

test('manual FX warns inline with the actual difference and ignores unrelated references',()=>{
  assert.equal(manualFxReview(entry,'GBP',reference),'Manual rate differs from reference by 14%');
  for(const changes of [{currency:'CHF'},{date:'2026-10-07'},{time:'13:00'},{timezone:'Europe/London'}]) assert.equal(manualFxReview(entry,'GBP',{...reference,...changes}),undefined);
  assert.equal(manualFxReview({...entry,bankAmount:800},'GBP',reference),undefined);
  assert.equal(manualFxReview({...entry,fx:{...entry.fx!,source:'reference'}},'GBP',reference),undefined);
  assert.equal(manualFxReview(entry,'EUR',reference),undefined);
  assert.equal(manualFxReview({...entry,fx:{...entry.fx!,rate:0.87}},'GBP',reference),undefined);
  assert.match(manualFxReview({...entry,fx:{...entry.fx!,rate:200}},'GBP')!,/unusually/);
});
