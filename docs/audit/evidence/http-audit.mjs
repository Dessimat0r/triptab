// Adversarial HTTP-level audit against LOCAL worker (npm start) with local D1/R2 only.
import { randomUUID } from 'node:crypto';
const BASE = 'http://127.0.0.1:8787';
const results = [];
const log = (id, outcome, detail = '') => { results.push({ id, outcome, detail }); console.log(`[${outcome}] ${id} ${detail}`); };

class Client {
  constructor(name) { this.name = name; this.cookies = new Map(); }
  async req(path, { method = 'GET', body, headers = {}, origin = BASE, raw } = {}) {
    const h = { ...headers };
    if (origin) h.Origin = origin;
    if (this.cookies.size) h.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined && !raw && !h['Content-Type']) h['Content-Type'] = 'application/json';
    let r; for (let attempt = 0; attempt < 3; attempt++) { try { r = await fetch(BASE + path, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: 'manual' }); break; } catch (e) { if (attempt === 2) throw e; await new Promise(res => setTimeout(res, 200)); } }
    for (const c of r.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';'); const i = pair.indexOf('=');
      const k = pair.slice(0, i), v = pair.slice(i + 1);
      if (v === '' || /Max-Age=0/i.test(c)) this.cookies.delete(k); else this.cookies.set(k, v);
    }
    const text = await r.text(); let json; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text, headers: r.headers };
  }
  async register(email, name) {
    const r = await this.req('/api/auth', { method: 'POST', body: { action: 'register', email, password: 'correct horse battery staple', displayName: name } });
    return r;
  }
  async ledger() { const r = await this.req('/api/ledger'); return r.json; }
  async save(data, revision) { return this.req('/api/ledger', { method: 'POST', body: { data, revision } }); }
}
const exp = (over = {}) => ({ id: randomUUID(), title: 'Dinner', date: '2026-08-15', time: '20:30', timezone: 'Europe/Paris', currency: 'GBP', payer: '', items: [], tax: 0, tip: 0, discount: 0, ...over });
const sum = a => a.reduce((x, y) => x + y, 0);

async function main() {
  const run = randomUUID().slice(0, 8);
  const A = new Client('A'), B = new Client('B'), C = new Client('C');
  let r = await A.register(`a-${run}@example.com`, 'Alice');
  log('reg-A', r.status === 200 ? 'OK' : 'FAIL', `status ${r.status}`);
  const setCookie = (await new Client('x').req('/api/auth', { method: 'POST', body: { action: 'register', email: `x-${run}@example.com`, password: 'correct horse battery staple', displayName: 'X' } })).headers.getSetCookie();
  log('cookie-flags', 'INFO', JSON.stringify(setCookie));
  await B.register(`b-${run}@example.com`, 'Bob');
  await C.register(`c-${run}@example.com`, 'Carol');

  // ---- enumeration / duplicate register
  r = await new Client('dup').register(`a-${run}@example.com`, 'Dup');
  log('register-existing-email', 'INFO', `status ${r.status} msg=${r.json?.error}`);

  // ---- CSRF / origin
  r = await A.req('/api/ledger', { method: 'POST', body: { data: { trips: [] }, revision: 0 }, origin: 'https://evil.example' });
  log('csrf-foreign-origin', r.status >= 400 ? 'BLOCKED' : 'ALLOWED', `status ${r.status}`);
  r = await A.req('/api/ledger', { method: 'POST', body: { data: { trips: [] }, revision: 0 }, origin: null });
  log('csrf-no-origin', r.status >= 400 ? 'BLOCKED' : 'ALLOWED', `status ${r.status}`);
  // text/plain content-type simple-request style
  r = await A.req('/api/ledger', { method: 'POST', raw: JSON.stringify({ data: { trips: [] }, revision: 0 }), headers: { 'Content-Type': 'text/plain' } });
  log('ledger-accepts-text-plain-body', r.status === 200 ? 'ACCEPTED(same-origin only)' : 'REJECTED', `status ${r.status}`);

  // ---- create trip (A)
  let led = await A.ledger();
  const mA = randomUUID(), mB = randomUUID(), mC = randomUUID(), mD = randomUUID();
  const trip = { id: randomUUID(), name: 'Lisbon', currency: 'GBP', members: [{ id: mA, name: 'Alice' }, { id: mB, name: 'Bob' }, { id: mC, name: 'Carol' }, { id: mD, name: 'Dave (unlinked)' }], expenses: [], drafts: [], payments: [] };
  r = await A.save({ trips: [...led.data.trips, trip] }, led.revision);
  log('create-trip', r.status === 200 ? 'OK' : 'FAIL', `status ${r.status} rev ${r.json?.revision}`);
  led = r.json;
  const T = led.data.trips.find(t => t.id === trip.id);
  log('trip-owner-forced', T.ownerId && T.members[0].userId ? 'OK' : 'FAIL', `owner=${T.ownerId} m0.userId=${T.members[0].userId}`);

  // ---- A forges ownerId / userId on create
  const forged = { ...trip, id: randomUUID(), ownerId: 'someone-else', members: [{ id: randomUUID(), name: 'Mallory', userId: 'victim-user', email: 'victim@example.com' }, { id: randomUUID(), name: 'Z' }] };
  let l2 = await A.ledger();
  r = await A.save({ trips: [...l2.data.trips, forged] }, l2.revision);
  const F = r.json?.data?.trips.find(t => t.id === forged.id);
  log('forge-owner-userId-on-create', F && F.ownerId !== 'someone-else' && F.members[0].userId !== 'victim-user' ? 'SANITISED' : 'VULNERABLE', JSON.stringify({ owner: F?.ownerId, m0: F?.members[0], status: r.status }));

  // ---- invite: create (owner), accept (B), reuse (C), self accept, wrong email
  l2 = await A.ledger();
  r = await A.req('/api/invite', { method: 'POST', body: { mode: 'create', tripId: trip.id, memberId: mB } });
  const inviteB = r.json?.url ? new URL(r.json.url).searchParams.get('invite') : null;
  log('invite-create', inviteB ? 'OK' : 'FAIL', `status ${r.status}`);
  r = await B.req('/api/invite', { method: 'POST', body: { mode: 'create', tripId: trip.id, memberId: mC } });
  log('invite-create-by-non-owner', r.status === 403 ? 'BLOCKED' : 'ALLOWED', `status ${r.status}`);
  r = await C.req('/api/invite?token=' + inviteB);
  log('invite-preview-by-anyone-with-link', r.status === 200 ? 'ALLOWED(token-bearer)' : 'BLOCKED', `status ${r.status} ${JSON.stringify(r.json)}`);
  r = await A.req('/api/invite', { method: 'POST', body: { mode: 'accept', token: inviteB } });
  log('invite-owner-accepts-own', r.status >= 400 ? 'BLOCKED' : 'ALLOWED', `status ${r.status} ${r.json?.error}`);
  r = await B.req('/api/invite', { method: 'POST', body: { mode: 'accept', token: inviteB } });
  log('invite-accept-B', r.status === 200 ? 'OK' : 'FAIL', `status ${r.status} ${JSON.stringify(r.json)}`);
  r = await B.req('/api/invite', { method: 'POST', body: { mode: 'accept', token: inviteB } });
  log('invite-accept-B-again(idempotent)', r.status === 200 ? 'OK' : 'FAIL', `status ${r.status} ${JSON.stringify(r.json)}`);
  r = await C.req('/api/invite', { method: 'POST', body: { mode: 'accept', token: inviteB } });
  log('invite-reuse-by-C', r.status >= 400 ? 'BLOCKED' : 'ALLOWED', `status ${r.status} ${r.json?.error}`);
  // two live invites for same member (no revoke)
  const i1 = (await A.req('/api/invite', { method: 'POST', body: { mode: 'create', tripId: trip.id, memberId: mC } })).json?.url;
  const i2 = (await A.req('/api/invite', { method: 'POST', body: { mode: 'create', tripId: trip.id, memberId: mC } })).json?.url;
  log('invite-multiple-live-links-same-member', i1 && i2 ? 'ALLOWED(no revoke)' : 'BLOCKED', '');
  r = await A.req('/api/invite', { method: 'POST', body: { mode: 'revoke', tripId: trip.id, token: 'x' } });
  log('invite-revoke-endpoint', r.status === 400 ? 'ABSENT' : 'PRESENT', `status ${r.status} ${r.json?.error}`);
  // email-bound invite, accept with other account
  const emailInvite = (await A.req('/api/invite', { method: 'POST', body: { mode: 'create', tripId: trip.id, memberId: mC, email: `c-${run}@example.com` } })).json?.url;
  const tok = new URL(emailInvite).searchParams.get('invite');
  r = await B.req('/api/invite', { method: 'POST', body: { mode: 'accept', token: tok } });
  log('invite-email-bound-wrong-account', r.status >= 400 ? 'BLOCKED' : 'ALLOWED', `status ${r.status} ${r.json?.error}`);
  // unverified-email bypass: new account registers with the invited email? (already used by C) -> register a new addr invite
  const victimEmail = `victim-${run}@example.com`;
  const emailInvite2 = (await A.req('/api/invite', { method: 'POST', body: { mode: 'create', tripId: trip.id, memberId: mD, email: victimEmail } })).json?.url;
  const tok2 = new URL(emailInvite2).searchParams.get('invite');
  const Evil = new Client('Evil'); await Evil.register(victimEmail, 'Not The Victim');
  r = await Evil.req('/api/invite', { method: 'POST', body: { mode: 'accept', token: tok2 } });
  log('invite-email-binding-with-unverified-email', r.status === 200 ? 'BYPASSED(any registrant of that address with the link)' : 'BLOCKED', `status ${r.status} ${r.json?.error}`);

  // refresh
  led = await A.ledger();
  const lb = await B.ledger();
  log('B-sees-trip-after-join', lb.data.trips.some(t => t.id === trip.id) ? 'OK' : 'FAIL');
  const TB = lb.data.trips.find(t => t.id === trip.id);

  // ---- IDOR / BOLA
  const lc = await C.ledger();
  log('C-sees-no-trip', lc.data.trips.length === 0 ? 'OK' : 'LEAK', `${lc.data.trips.length} trips`);
  r = await C.save({ trips: [{ ...T, name: 'hijacked' }] }, lc.revision);
  log('C-writes-A-trip', r.status === 403 ? 'BLOCKED' : `status ${r.status}`, r.json?.error);
  // C creates trip with *same* id → should not overwrite
  r = await C.req('/api/receipt?tripId=' + trip.id, { method: 'POST', raw: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1]), headers: { 'Content-Type': 'image/png' } });
  log('C-upload-receipt-to-A-trip', r.status === 403 ? 'BLOCKED' : `status ${r.status}`, r.json?.error);
  // A uploads receipt (valid minimal png header only passes magic check)
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1]), Buffer.from('EXIF-GPS-LEAK-MARKER')]);
  r = await A.req('/api/receipt?tripId=' + trip.id, { method: 'POST', raw: png, headers: { 'Content-Type': 'image/png' } });
  const receiptId = r.json?.receiptId; log('A-upload-receipt', receiptId ? 'OK' : 'FAIL', `status ${r.status}`);
  r = await C.req('/api/receipt?id=' + receiptId); log('C-read-A-receipt', r.status === 404 ? 'BLOCKED' : `status ${r.status}`);
  r = await B.req('/api/receipt?id=' + receiptId); log('B-read-A-receipt(member)', r.status === 200 ? 'ALLOWED(member)' : `status ${r.status}`, JSON.stringify([...r.headers].filter(([k]) => /content-type|cache|nosniff|disposition/i.test(k))));
  r = await new Client('anon').req('/api/receipt?id=' + receiptId); log('anon-read-receipt', r.status === 401 || r.status === 404 ? 'BLOCKED' : `status ${r.status}`);
  r = await A.req('/api/receipt?tripId=' + trip.id, { method: 'POST', raw: Buffer.alloc(100), headers: { 'Content-Type': 'image/svg+xml' } });
  log('upload-svg', r.status >= 400 ? 'BLOCKED' : 'ALLOWED', `status ${r.status}`);
  r = await A.req('/api/receipt?tripId=' + trip.id, { method: 'POST', raw: Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]), headers: { 'Content-Type': 'image/png' } });
  log('upload-over-5MB', r.status === 413 ? 'BLOCKED' : `status ${r.status}`);
  // storage abuse: N uploads
  let ok = 0; for (let i = 0; i < 15; i++) { const u = await A.req('/api/receipt?tripId=' + trip.id, { method: 'POST', raw: png, headers: { 'Content-Type': 'image/png' } }); if (u.status === 200) ok++; }
  log('upload-quota', ok === 15 ? 'NO_LIMIT(15/15 accepted)' : `limited ${ok}/15`);

  // ---- Receipt linking cross-trip: C's trip with A's receiptId
  const cTrip = { id: randomUUID(), name: 'Carols', currency: 'GBP', members: [{ id: randomUUID(), name: 'Carol' }], expenses: [], drafts: [], payments: [] };
  let lcc = await C.ledger();
  r = await C.save({ trips: [cTrip] }, lcc.revision);
  lcc = r.json;
  const ct = lcc.data.trips[0];
  const bad = { ...ct, drafts: [{ id: randomUUID(), title: 'steal', receiptId, currency: 'GBP', items: [], tax: 0, tip: 0, discount: 0, payer: ct.members[0].id, status: 'waiting' }] };
  r = await C.save({ trips: [bad] }, lcc.revision);
  log('C-attach-A-receipt-to-own-trip', r.status >= 400 ? 'BLOCKED' : 'ALLOWED', `status ${r.status} ${r.json?.error}`);

  // ---- Collaboration semantics: B (non-owner) mutates freely
  let lb2 = await B.ledger();
  let TB2 = lb2.data.trips.find(t => t.id === trip.id);
  const e1 = exp({ title: 'Taxi by A', payer: mA, items: [{ id: randomUUID(), name: 'Taxi', amount: 3000, members: [mA, mB, mC] }] });
  TB2 = { ...TB2, expenses: [e1], members: TB2.members.map(m => m.id === mA ? { ...m, name: 'ALICE-RENAMED-BY-BOB' } : m), payments: [{ id: randomUUID(), from: mA, to: mC, amount: 500, date: '2026-08-16' }] };
  r = await B.save({ trips: lb2.data.trips.map(t => t.id === trip.id ? TB2 : t) }, lb2.revision);
  log('B-adds-expense-paid-by-A', r.status === 200 ? 'ALLOWED(no author check)' : `status ${r.status} ${r.json?.error}`);
  const after = r.json?.data?.trips.find(t => t.id === trip.id);
  log('B-renames-A', after?.members.find(m => m.id === mA)?.name === 'ALICE-RENAMED-BY-BOB' ? 'ALLOWED(identity spoof)' : 'BLOCKED');
  log('B-records-payment-A-to-C-without-consent', after?.payments.length === 1 ? 'ALLOWED' : 'BLOCKED');
  // Alice's view: any history?
  const la = await A.ledger();
  const TA = la.data.trips.find(t => t.id === trip.id);
  log('A-sees-change-attribution', JSON.stringify(TA).includes('createdBy') || JSON.stringify(TA).includes('updatedBy') ? 'PRESENT' : 'ABSENT(no author/timestamps in data)');
  const nA = await A.req('/api/notifications');
  log('A-notification-content', 'INFO', JSON.stringify(nA.json?.notifications?.map(n => [n.title, n.body])));

  // ---- Remove unlinked member with no references; remove linked member
  let l3 = await A.ledger(); let T3 = l3.data.trips.find(t => t.id === trip.id);
  r = await A.save({ trips: l3.data.trips.map(t => t.id === trip.id ? { ...T3, members: T3.members.filter(m => m.id !== mB) } : t) }, l3.revision);
  log('remove-linked-member', r.status >= 400 ? 'BLOCKED' : 'ALLOWED', `status ${r.status} ${r.json?.error}`);
  r = await A.save({ trips: l3.data.trips.map(t => t.id === trip.id ? { ...T3, members: T3.members.filter(m => m.id !== mD) } : t) }, l3.revision);
  log('remove-unlinked-unreferenced-member', r.status === 200 ? 'ALLOWED' : 'BLOCKED', `status ${r.status}`);
  // remove member referenced by expense
  l3 = await A.ledger(); T3 = l3.data.trips.find(t => t.id === trip.id);
  r = await A.save({ trips: l3.data.trips.map(t => t.id === trip.id ? { ...T3, members: T3.members.filter(m => m.id !== mC) } : t) }, l3.revision);
  log('remove-member-with-payment-reference', r.status >= 400 ? 'BLOCKED' : 'ALLOWED', `status ${r.status} ${r.json?.error}`);
  // remove member AND strip references in same save (history rewrite): remove C along with payment referencing + expense items
  l3 = await A.ledger(); T3 = l3.data.trips.find(t => t.id === trip.id);
  const rewritten = { ...T3, members: T3.members.filter(m => m.id !== mC), payments: [], expenses: T3.expenses.map(e => ({ ...e, items: e.items.map(i => ({ ...i, members: i.members.filter(x => x !== mC) })) })) };
  r = await A.save({ trips: l3.data.trips.map(t => t.id === trip.id ? rewritten : t) }, l3.revision);
  log('remove-member-by-rewriting-history(unlinked C)', r.status === 200 ? 'ALLOWED(silent shares reassigned)' : 'BLOCKED', `status ${r.status} ${r.json?.error}`);

  // ---- Concurrency
  let lx = await A.ledger(), ly = await B.ledger();
  const tx = lx.data.trips.find(t => t.id === trip.id), ty = ly.data.trips.find(t => t.id === trip.id);
  const pa = A.save({ trips: lx.data.trips.map(t => t.id === trip.id ? { ...tx, name: 'A-edit' } : t) }, lx.revision);
  const pb = B.save({ trips: ly.data.trips.map(t => t.id === trip.id ? { ...ty, name: 'B-edit' } : t) }, ly.revision);
  const [ra, rb] = await Promise.all([pa, pb]);
  log('concurrent-same-trip-writes', [ra.status, rb.status].sort().join(',') === '200,409' ? 'CAS_OK(one 409)' : `statuses ${ra.status},${rb.status}`);
  // unrelated-trip contention: C writes own trip, A holds stale revision
  let lA = await A.ledger(); let lC = await C.ledger();
  const cT = lC.data.trips[0];
  r = await C.save({ trips: [{ ...cT, name: 'Carol renamed' }] }, lC.revision);
  const tA = lA.data.trips.find(t => t.id === trip.id);
  r = await A.save({ trips: lA.data.trips.map(t => t.id === trip.id ? { ...tA, name: 'A-after-C-unrelated' } : t) }, lA.revision);
  log('unrelated-user-write-conflicts-A', r.status === 409 ? 'GLOBAL_REVISION_CONTENTION(409)' : `status ${r.status}`, r.json?.error);

  // ---- duplicate-submit / retry-after-commit
  lA = await A.ledger(); let tA2 = lA.data.trips.find(t => t.id === trip.id);
  const pay = { id: randomUUID(), from: mB, to: mA, amount: 1000, date: '2026-08-17' };
  const nextTrip = { ...tA2, payments: [...tA2.payments, pay] };
  const s1 = await A.save({ trips: lA.data.trips.map(t => t.id === trip.id ? nextTrip : t) }, lA.revision);
  const s2 = await A.save({ trips: lA.data.trips.map(t => t.id === trip.id ? nextTrip : t) }, lA.revision); // retry with same body (client never saw first reply)
  log('retry-same-payment-after-commit', s1.status === 200 && s2.status === 409 ? 'NO_DUPLICATE(409)' : `statuses ${s1.status},${s2.status}`);
  // retry with refreshed revision but same payment id => idempotent by id? (client re-sends same payment id)
  lA = await A.ledger(); tA2 = lA.data.trips.find(t => t.id === trip.id);
  const s3 = await A.save({ trips: lA.data.trips.map(t => t.id === trip.id ? { ...tA2, payments: [...tA2.payments, pay] } : t) }, lA.revision);
  log('retry-with-fresh-revision-and-same-payment-id', s3.status >= 400 ? 'REJECTED(dup id)' : 'ACCEPTED', `status ${s3.status} ${s3.json?.error}`);
  // retry with fresh revision and a NEW id (what the UI does after refresh -> double payment if user doesn't notice)
  lA = await A.ledger(); tA2 = lA.data.trips.find(t => t.id === trip.id);
  const s4 = await A.save({ trips: lA.data.trips.map(t => t.id === trip.id ? { ...tA2, payments: [...tA2.payments, { ...pay, id: randomUUID() }] } : t) }, lA.revision);
  log('duplicate-payment-new-id-accepted', s4.status === 200 ? 'ACCEPTED(no semantic dedupe)' : 'REJECTED', `status ${s4.status}`);
  // payment bigger than any debt / wrong direction
  lA = await A.ledger(); tA2 = lA.data.trips.find(t => t.id === trip.id);
  const s5 = await A.save({ trips: lA.data.trips.map(t => t.id === trip.id ? { ...tA2, payments: [...tA2.payments, { id: randomUUID(), from: mA, to: mB, amount: 100000000, date: '2026-08-17' }] } : t) }, lA.revision);
  log('overpayment-1M-accepted', s5.status === 200 ? 'ACCEPTED(no sanity check)' : 'REJECTED', `status ${s5.status}`);

  // ---- stale tab resurrects deleted expense (server-level view: edit of deleted expense is just upsert)
  // ---- size limit / performance
  lA = await A.ledger(); tA2 = lA.data.trips.find(t => t.id === trip.id);
  const members20 = Array.from({ length: 20 }, (_, i) => ({ id: randomUUID(), name: `P${i}` }));
  const big = { id: randomUUID(), name: 'Big', currency: 'GBP', members: members20, expenses: [], drafts: [], payments: [] };
  big.expenses = Array.from({ length: 1000 }, (_, i) => exp({ title: `Expense ${i}`, payer: members20[i % 20].id, items: [{ id: randomUUID(), name: 'Item', amount: 1000 + i, members: members20.map(m => m.id) }, { id: randomUUID(), name: 'Item2', amount: 777 + i, members: members20.slice(0, 7).map(m => m.id) }] }));
  const t0 = Date.now();
  r = await A.save({ trips: [...lA.data.trips, big] }, lA.revision);
  log('save-20members-1000expenses', r.status === 200 ? 'OK' : 'FAIL', `status ${r.status} ${r.json?.error ?? ''} ${Date.now() - t0}ms bytes=${JSON.stringify({ trips: [big] }).length}`);
  if (r.status === 200) {
    const t1 = Date.now(); const g = await A.req('/api/ledger'); log('read-ledger-after-big', 'INFO', `${Date.now() - t1}ms ${g.text.length} bytes`);
    const t2 = Date.now(); const lg = g.json; const small = lg.data.trips.find(t => t.id === trip.id);
    const s = await A.save({ trips: lg.data.trips.map(t => t.id === trip.id ? { ...small, name: 'tiny rename' } : t) }, lg.revision);
    log('tiny-edit-with-big-ledger-present', 'INFO', `status ${s.status} ${Date.now() - t2}ms (client uploads whole ledger every save)`);
  }
  // oversize
  const huge = { id: randomUUID(), name: 'Huge', currency: 'GBP', members: members20, expenses: [], drafts: [], payments: [] };
  huge.expenses = Array.from({ length: 1000 }, (_, i) => exp({ title: 'E'.repeat(200), payer: members20[0].id, items: Array.from({ length: 10 }, () => ({ id: randomUUID(), name: 'I'.repeat(200), amount: 100, members: members20.map(m => m.id) })) }));
  const lH = await A.ledger();
  try { r = await A.save({ trips: [...lH.data.trips, huge] }, lH.revision); log('oversize-ledger', 'INFO', `bytes=${JSON.stringify({ trips: [...lH.data.trips, huge] }).length} status ${r.status} ${r.json?.error}`); } catch (e) { log('oversize-ledger', 'INFO', 'connection reset by server (body over 1.6MB cap) ' + e.cause?.code); }
  // after hitting size limit with existing big trip, can user still edit small trip?
  // ---- rate-limit
  const R = new Client('R'); let last;
  for (let i = 0; i < 10; i++) last = await R.req('/api/auth', { method: 'POST', body: { action: 'login', email: `b-${run}@example.com`, password: 'wrong wrong wrong wrong' } });
  log('bruteforce-lock-after-8', last.status === 429 ? 'LOCKED(429)' : `status ${last.status}`, `retry-after=${last.headers.get('retry-after')}`);
  r = await B.req('/api/auth', { method: 'POST', body: { action: 'login', email: `b-${run}@example.com`, password: 'correct horse battery staple' } });
  log('victim-login-after-attacker-lockout', r.status === 429 ? 'LOCKED_OUT(DoS by anyone who knows email)' : `status ${r.status}`);
  // fx unauth
  r = await new Client('anon').req('/api/fx?from=EUR&to=GBP&date=2026-01-02&time=12:00&timezone=Europe/London'); log('fx-unauth', r.status === 401 ? 'BLOCKED' : `status ${r.status}`);
  // mcp without provider identity
  r = await new Client('anon').req('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_trip_ledger', arguments: {} } }, origin: null });
  log('mcp-unauth', 'INFO', `status ${r.status} ${r.text.slice(0, 120)}`);
  // mcp with forged provider headers (LOCAL worker only; shows trust placed in gateway)
  r = await new Client('anon').req('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_trip_ledger', arguments: {} } }, origin: null, headers: { 'oai-authenticated-user-id': 'forged-user-1', 'oai-authenticated-user-email': 'forged@example.com' } });
  log('mcp-forged-provider-header(local)', r.status === 200 ? 'TRUSTED(header-only auth; relies on gateway stripping)' : `status ${r.status}`, r.text.slice(0, 100));
  r = await new Client('anon').req('/api/ledger', { headers: { 'oai-authenticated-user-id': 'forged-user-1', 'oai-authenticated-user-email': 'forged@example.com' }, origin: null });
  log('ledger-forged-provider-header(local)', r.status === 200 ? 'TRUSTED(header-only auth)' : `status ${r.status}`);

  console.log('\nDONE', results.length);
}
main().catch(e => { console.error(e); process.exit(1); });
