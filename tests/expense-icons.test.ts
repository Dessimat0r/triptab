import assert from 'node:assert/strict';
import test from 'node:test';
import { ICON_CATALOG, ICON_BACKGROUNDS, expenseIconSchema, defaultBackground, inferExpenseIcon, resolveExpenseIcon } from '../lib/expense-icons';
import { draftSchema, expenseSchema, parseLedgerStructure, type Trip } from '../lib/model';
import { isBlankReceipt, receiptEditableValue, receiptProposalEditor, type ReceiptEditor } from '../lib/receipt-processing';
import { rebaseLedger } from '../lib/client-ledger';

const icon = { symbol: 'Palmtree', background: 'pink' } as const;
const receipt: ReceiptEditor = { id:'receipt', title:'Dinner', date:'2026-10-05', time:'12:00', timezone:'Europe/London',
  currency:'GBP', payer:'alice', items:[{id:'item',name:'Pasta',amount:1000,members:['alice']}], tax:0,tip:0,discount:0 };

test('merchant context outranks an individual purchased item and transport qualifiers', () => {
  assert.deepEqual(inferExpenseIcon({title:'Lidl Lisboa',items:[{name:'Beer'}]}),{symbol:'ShoppingCart',background:'green'});
  assert.equal(inferExpenseIcon({title:'Airport taxi'}).symbol,'Car');
  assert.equal(inferExpenseIcon({title:'Car hire at the airport'}).symbol,'Car');
});

test('European merchant categories support accents, punctuation, and word boundaries', () => {
  for (const [title,symbol] of [['Restaurante do Porto','Utensils'],['Bäckerei Müller','Croissant'],['Boulangerie de Paris','Croissant'],
    ['Farmácia Central','Pill'],['Museo del Prado','Landmark'],['RENFE – Madrid','TrainFront'],['Caffè Roma','Coffee']]) {
    assert.equal(inferExpenseIcon({title}).symbol,symbol,title);
  }
  assert.equal(inferExpenseIcon({title:'Barcode 123'}).symbol,'Receipt');
});

test('transcribed items suggest an icon even for a generic receipt title', () => {
  assert.equal(inferExpenseIcon({title:'Receipt',items:[{name:'Cappuccino coffee'}]}).symbol,'Coffee');
  assert.equal(inferExpenseIcon({items:[{name:'Milk 1L'},{name:'Bread'},{name:'Beer'}]}).symbol,'ShoppingCart');
  assert.equal(inferExpenseIcon({title:'Unknown merchant',items:[{name:'Unreadable line'}]}).symbol,'Receipt');
  for (const [name,symbol] of [['Chicken sandwich','Sandwich'],['Salad','Salad'],['Soup','Soup'],['Sport equipment','Volleyball'],['SIM card','Smartphone']]) {
    assert.equal(inferExpenseIcon({title:'Receipt',items:[{name}]}).symbol,symbol,name);
  }
});

test('all curated symbols and colours validate, and arbitrary markup is rejected', () => {
  assert.equal(ICON_CATALOG.length,100);
  assert.equal(new Set(ICON_CATALOG.map(entry=>entry[0])).size,100);
  for (const [symbol] of ICON_CATALOG) assert(expenseIconSchema.safeParse({symbol,background:'indigo'}).success);
  for (const [background] of ICON_BACKGROUNDS) assert(expenseIconSchema.safeParse({symbol:'Receipt',background}).success);
  assert(!expenseIconSchema.safeParse({symbol:'<script>',background:'red'}).success);
  assert(!expenseIconSchema.safeParse({symbol:'Receipt',background:'url(https://example.test)'}).success);
  assert(!expenseIconSchema.safeParse({...icon,html:'injected'}).success);
});

test('manual icons round trip through stored expenses and drafts; legacy absence stays automatic', () => {
  assert.deepEqual(expenseSchema.parse({...receipt,icon}).icon,icon);
  assert.deepEqual(draftSchema.parse({...receipt,icon,status:'review'}).icon,icon);
  const trip: Trip = {id:'trip',name:'Holiday',currency:'GBP',members:[{id:'alice',name:'Alice'}],expenses:[expenseSchema.parse(receipt)],drafts:[],payments:[]};
  assert.equal(parseLedgerStructure({trips:[trip]}).trips[0].expenses[0].icon,undefined);
  assert.equal(resolveExpenseIcon(trip.expenses[0]).symbol,'Utensils');
  assert.deepEqual(resolveExpenseIcon({...receipt,icon}),icon);
});

test('receipt proposals preserve manual icon choices and explicitly resetting automatic mode', () => {
  const draft = draftSchema.parse({...receipt,id:'draft',title:'Supermercado',icon:{symbol:'ShoppingCart',background:'green'},status:'review'});
  assert.deepEqual(receiptProposalEditor({...receipt,icon},draft).icon,icon);
  assert.equal(receiptProposalEditor({...receipt,icon:undefined},draft).icon,undefined);
  assert.deepEqual(receiptEditableValue({...receipt,icon}),receiptEditableValue(receipt));
  assert(isBlankReceipt({...receipt,title:'',icon,items:[]}), 'choosing an icon does not prevent initial receipt itemisation');
});

test('conflicting icon edits are protected by the ledger conflict guard', () => {
  const trip: Trip = {id:'trip',name:'Holiday',currency:'GBP',members:[{id:'alice',name:'Alice'}],expenses:[expenseSchema.parse(receipt)],drafts:[],payments:[]};
  const base={trips:[trip]},local=structuredClone(base),remote=structuredClone(base);
  local.trips[0].expenses[0].icon=icon;
  remote.trips[0].expenses[0].icon={symbol:'Coffee',background:'gold'};
  const rebased=rebaseLedger(base,local,remote);
  assert.deepEqual(rebased.conflicts,[{tripId:'trip',entityType:'expenses',entityId:'receipt'}]);
  assert.deepEqual(rebased.data.trips[0].expenses[0].icon,remote.trips[0].expenses[0].icon);
});

test('specific merchant services beat broader venues and include common travel terms', () => {
  for (const [title,symbol] of [
    ['Restaurant & Bar','Utensils'], ['Cafe restaurant','Utensils'], ['Cafe lunch','Utensils'], ['Restaurant Wine Bar','Utensils'],
    ['Hotel Atlantic Bar','Martini'], ['Tapas','Utensils'], ['Osteria','Utensils'],
    ['Brasserie','Utensils'], ['Trattoria','Utensils'], ['Izakaya','Utensils'],
    ['Tabac','ShoppingCart'], ['Food shop','ShoppingCart'], ['Boat tour','Ship'], ['Guided tour','Compass'],
  ] as const) assert.equal(inferExpenseIcon({title,items:[{name:'Wine'},{name:'Beer'}]}).symbol,symbol,title);
  for (const [name,symbol] of [
    ['Tapas','Utensils'], ['Osteria','Utensils'], ['Brasserie','Utensils'], ['Trattoria','Utensils'],
    ['Izakaya','Utensils'], ['Ramen','Soup'], ['Tabac','ShoppingCart'], ['Food shop','ShoppingCart'],
    ['Boat tour','Ship'], ['Tour','Compass'],
  ] as const) assert.equal(inferExpenseIcon({items:[{name}]}).symbol,symbol,name);
  assert.equal(inferExpenseIcon({title:'Restaurant',items:[{name:'Wine'}]}).symbol,'Utensils');
});

test('reading translations count once per line, and the category with most lines wins', () => {
  assert.equal(inferExpenseIcon({items:[{name:'拉面',translations:{en:{text:'Ramen'}}}]}).symbol,'Soup');
  const food = [{name:'Pizza'},{name:'Salad'},{name:'Ramen'}], wine = [{name:'Wine'},{name:'Wine'}];
  for (const items of [[...wine,...food],[...food,...wine]]) assert.equal(inferExpenseIcon({items}).symbol,'Pizza');
  assert.equal(inferExpenseIcon({items:[
    {name:'Wine',translations:{en:{text:'Wine'},fr:{text:'Wine'}}}, ...food,
  ]}).symbol,'Pizza');
});

test('user icon > matching user title > AI suggestion > local matcher', () => {
  const suggestedIcon = {symbol:'Utensils',background:'orange'} as const;
  const entry = {title:'Taxi home',titleSource:'user' as const,suggestedIcon,items:[{name:'Coffee'}]};
  assert.deepEqual(resolveExpenseIcon({...entry,icon}),icon);
  assert.equal(resolveExpenseIcon(entry).symbol,'Car','a renamed expense overrides stale Meals');
  assert.equal(resolveExpenseIcon({...entry,titleSource:'receipt'}).symbol,'Utensils');
  assert.equal(resolveExpenseIcon({...entry,title:'Something unclear'}).symbol,'Utensils');
  assert.equal(resolveExpenseIcon({...entry,title:'Something unclear',suggestedIcon:undefined}).symbol,'Coffee');
  assert.equal(resolveExpenseIcon({...entry,titleSource:undefined,fieldSources:{title:'user'}}).symbol,'Car');
  assert.equal(resolveExpenseIcon({...entry,title:'Museums & sights'}).symbol,'Landmark','user label matches count');
  assert.equal(defaultBackground('Utensils'),'orange');
  assert.equal(defaultBackground('Martini'),'pink');
  assert.equal(defaultBackground('Ship'),'cyan');
  assert.equal(defaultBackground('Salad'),'orange');
  assert.deepEqual(expenseSchema.parse({...receipt,suggestedIcon}).suggestedIcon,suggestedIcon);
  assert.deepEqual(draftSchema.parse({...receipt,status:'review',suggestedIcon}).suggestedIcon,suggestedIcon);
});
