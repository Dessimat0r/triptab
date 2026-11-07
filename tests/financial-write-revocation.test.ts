import assert from 'node:assert/strict';
import test from 'node:test';
import { createReceiptOperationWorker } from './helpers/receipt-operation-worker';
import { hashToken, identityWriteAuthorization, requestWriteAuthorizationSql, requestWriteAuthorized, resolveIdentity } from '../lib/auth';
import { storage } from './helpers/sqlite-d1';

for(const mode of ['whole-ledger','per-trip'] as const)for(const revocation of ['logout','expiry'] as const)test(`Independent financial authorisation: ${mode} normal payment commit after ${revocation}`,async()=>{
 const f=await createReceiptOperationWorker();
 try{
  let snapshot=await f.readLedger();
  const trip=snapshot.data.trips.find(t=>t.id===f.tripId)!;
  trip.expenses=[{id:'signout-bill',title:'Dinner',date:'2026-11-07',time:'12:00',timezone:'Europe/London',currency:'GBP',payer:'bob',tax:0,tip:0,discount:0,items:[{id:'meal',name:'Meal',amount:1000,members:['alice','bob']}]}];
  await f.saveLedger(snapshot.data,snapshot.revision);
  snapshot=await f.readLedger();snapshot.data.trips.find(t=>t.id===f.tripId)!.payments.push({id:'pending-payment',from:'alice',to:'bob',amount:500,date:'2026-11-07'});
  const revision=(await f.database.prepare('SELECT revision FROM trips WHERE id=?').bind(f.tripId).first<{revision:number}>())!.revision;
  const body=mode==='whole-ledger'?snapshot:{data:{trips:[snapshot.data.trips.find(t=>t.id===f.tripId)]},tripRevisions:{[f.tripId]:revision}};
  const deadline=Date.now()+2000;
  if(revocation==='expiry')await f.database.prepare('UPDATE auth_sessions SET expires_at=? WHERE session_id=?').bind(new Date(deadline).toISOString(),f.sessionId).run();
  await f.control('/__test/hooks',{pauseNextCommit:true});
  const pending=f.request('/api/ledger',{method:'POST',body:JSON.stringify(body)});
  await f.waitFor(async()=>(await f.control('/__test/hooks')).atCommit,'ordinary financial commit to be prepared');
  if(revocation==='logout'){const loggedOut=await f.request('/api/auth',{method:'POST',body:JSON.stringify({action:'logout'})});assert.equal(loggedOut.status,200);}
  else await new Promise(r=>setTimeout(r,Math.max(0,deadline-Date.now())+100));
  assert.equal((await f.request('/api/ledger')).status,401,'the same credential is revoked');
  const before=await f.tripRow(),history=await f.historyCount();
  await f.control('/__test/hooks',{proceed:true});
  const result=await pending,stored=await f.tripRow();
  console.log('INDEPENDENT ordinary payment after revocation',JSON.stringify({mode,revocation,status:result.status,payments:JSON.parse(stored.data).payments,historyDelta:await f.historyCount()-history}));
  assert.notEqual(result.status,200,'revoked session must not admit the queued payment');
  assert.deepEqual(stored,before);assert.equal(await f.historyCount(),history);
 }finally{await f.dispose();}
});

for (const route of ['import', 'offline', 'delete', 'restore-deleted', 'purge-deleted'] as const) test(`N03: ${route} cannot mutate after its session is revoked during preparation`, async () => {
  const f = await createReceiptOperationWorker({ kind: 'bill' });
  try {
    if (route === 'restore-deleted' || route === 'purge-deleted') {
      const deleted = await f.request('/api/trip', { method: 'POST', body: JSON.stringify({ action: 'delete', tripId: f.tripId, confirmName: 'Operations holiday' }) });
      assert.equal(deleted.status, 200, await deleted.text());
    }
    const snapshot = await f.readLedger();
    const trip = { id: 'import-after-signout', name: 'Imported holiday', currency: 'GBP', members: [{ id: 'alice', name: 'Alice' }], expenses: [], drafts: [], payments: [] };
    const expense = { id: 'queued-expense', title: 'Queued', date: '2026-11-07', currency: 'GBP', payer: 'alice', tax: 0, tip: 0, discount: 0,
      items: [{ id: 'queued-item', name: 'Meal', amount: 1000, members: ['alice', 'bob'] }] };
    const body = route === 'import' ? { accountId: f.owner.id, trip, memberId: 'alice' }
      : route === 'offline' ? { accountId: f.owner.id, tripId: f.tripId, expense }
      : { action: route, tripId: f.tripId, confirmName: 'Operations holiday' };
    const path = route === 'import' ? '/api/import' : route === 'offline' ? '/api/offline-expenses' : '/api/trip';
    await f.control('/__test/hooks', { pauseNextCommit: true });
    const pending = f.request(path, { method: 'POST', body: JSON.stringify(body) });
    await f.waitFor(async () => (await f.control('/__test/hooks')).atCommit, `${route} final transaction`);
    assert.equal((await f.request('/api/auth', { method: 'POST', body: JSON.stringify({ action: 'logout' }) })).status, 200);
    const before = await f.tripRow(), history = await f.historyCount();
    const receipts = (await f.database.prepare('SELECT * FROM receipts ORDER BY id').all()).results;
    await f.control('/__test/hooks', { proceed: true });
    assert.notEqual((await pending).status, 200);
    assert.deepEqual(await f.tripRow(), before);
    assert.deepEqual((await f.database.prepare('SELECT * FROM receipts ORDER BY id').all()).results, receipts);
    assert.equal(await f.historyCount(), history);
    assert.equal((await f.database.prepare('SELECT revision FROM sync_state WHERE id=1').first<{ revision: number }>())!.revision, snapshot.revision);
    assert.equal(await f.database.prepare('SELECT 1 FROM trips WHERE id=?').bind(trip.id).first(), null);
  } finally { await f.dispose(); }
});

for (const change of ['unlink', 'remap'] as const) test(`N03: a prepared MCP memory write is fenced against provider ${change}`, async () => {
  const f = await createReceiptOperationWorker();
  try {
    const account = await f.createAccount({ id: 'linked-user', email: 'linked@example.test', name: 'Linked', password: true, link: { providerId: 'linked-provider' }, session: true });
    const identity = { provider: { id: 'linked-provider', email: 'linked@example.test' } };
    const reading = await f.seedReading(identity, 'linked-trip');
    const snapshot = await reading.read();
    await f.control('/__test/hooks', { pauseNextCommit: true });
    const pending = f.requestAs(identity, '/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'remember_receipt_context', arguments: { tripId: 'linked-trip', draftId: 'linked-trip-draft', revision: snapshot.revision, memory: { notes: 'Keep the original printed prices.', aliases: [] } } } }) });
    await f.waitFor(async () => (await f.control('/__test/hooks')).atCommit, 'MCP final transaction');
    if (change === 'unlink') assert.equal((await f.requestAs(account, '/api/auth', { method: 'POST', body: JSON.stringify({ action: 'unlink_chatgpt' }) })).status, 200);
    else {
      await f.createAccount({ id: 'mapped-elsewhere', name: 'Other', email: 'other@example.test' });
      await f.database.prepare('UPDATE auth_links SET user_id=? WHERE oai_user_id=?').bind('mapped-elsewhere', 'linked-provider').run();
    }
    const before = await reading.trip(), history = await reading.history();
    await f.control('/__test/hooks', { proceed: true });
    const response = await pending;
    const result = await response.json() as { result: { isError?: boolean } };
    assert.equal(result.result.isError, true, JSON.stringify(result));
    assert.deepEqual(await reading.trip(), before);
    assert.equal(await reading.history(), history);
  } finally { await f.dispose(); }
});

test('N03: request fences preserve session precedence, reject forgery and use database-time expiry', async () => {
  const database = await storage(), now = new Date().toISOString(), token = 'q'.repeat(43);
  for (const id of ['session-account', 'provider-account']) database.sqlite.prepare('INSERT INTO profiles(id,email,display_name,created_at) VALUES(?,?,?,?)').run(id, `${id}@example.test`, id, now);
  database.sqlite.prepare('INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(await hashToken(token), 'session-account', '2999-01-01T00:00:00.000Z', now);
  const request = new Request('https://triptab.test', { headers: { cookie: `tt_session=${token}`, 'oai-authenticated-user-id': 'provider-account', 'oai-authenticated-user-email': 'provider-account@example.test' } });
  const identity = await resolveIdentity(request, {}, database.asD1());
  const fence = identityWriteAuthorization(identity);
  assert.equal(await requestWriteAuthorized(database.asD1(), fence, 'session-account'), true);
  assert.throws(() => requestWriteAuthorizationSql({ ...fence }, 'session-account'), /UNAUTHORIZED/);
  assert.throws(() => requestWriteAuthorizationSql(fence, 'provider-account'), /UNAUTHORIZED/);
  database.sqlite.prepare('DELETE FROM auth_sessions').run();
  assert.equal(await requestWriteAuthorized(database.asD1(), fence, 'session-account'), false, 'a valid provider header must not replace the revoked session that admitted the request');
  const providerFence = identityWriteAuthorization(await resolveIdentity(request, { allowSession: false }, database.asD1()));
  assert.equal(await requestWriteAuthorized(database.asD1(), providerFence, 'provider-account'), true);
  database.sqlite.prepare("UPDATE profiles SET deleted_at=? WHERE id='provider-account'").run(now);
  assert.equal(await requestWriteAuthorized(database.asD1(), providerFence, 'provider-account'), false);
});

test('N03: a valid password session still saves when its old provider ID is mapped to another account', async () => {
  const f = await createReceiptOperationWorker();
  try {
    await f.createAccount({ id: 'new-provider-account', name: 'Other', email: 'new-provider@example.test' });
    await f.database.prepare('INSERT INTO auth_links(oai_user_id,user_id,created_at) VALUES(?,?,?)').bind(f.owner.id, 'new-provider-account', new Date().toISOString()).run();
    assert.equal((await f.request('/api/ledger')).status, 200, 'the password session remains authenticated as its original account');
    const snapshot = await f.readLedger();
    snapshot.data.trips.find(trip => trip.id === f.tripId)!.drafts[0].title = 'My authorised edit';
    const response = await f.request('/api/ledger', { method: 'POST', body: JSON.stringify(snapshot) });
    assert.equal(response.status, 200, await response.text());
    assert.equal((await f.currentDraft()).title, 'My authorised edit');
  } finally { await f.dispose(); }
});
