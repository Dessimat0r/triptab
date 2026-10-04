import { settlements, balances } from '/home/user/triptab/lib/model';
const m = ['d1','d2','c1','c2'].map(id => ({ id, name: id }));
// d1 owes 3, d2 owes 7, c1 is owed 7, c2 is owed 3 (e.g. two couples) -> payments encode balances
const t: any = { id:'t', name:'t', currency:'GBP', members: m, expenses: [], drafts: [], payments: [
 {id:'1',from:'c1',to:'d2',amount:7,date:'2026-01-01'},{id:'2',from:'c2',to:'d1',amount:3,date:'2026-01-01'}]};
console.log(JSON.stringify(balances(t)), JSON.stringify(settlements(t)));
