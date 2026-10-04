// Second-pass HTTP evidence against the LOCAL Worker only (npm start, http://127.0.0.1:8787).
// Before each run: DELETE FROM auth_rate_limits (all local requests share one IP bucket).
// Run: node docs/audit/evidence-second-pass/http-recheck.mjs
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const ORIGIN = new URL(BASE).origin;
const run = Date.now().toString(36);
const results = {};

async function call(path, { method = 'GET', body, cookie, headers = {}, raw } = {}) {
  const response = await fetch(BASE + path, {
    method,
    headers: { ...(method !== 'GET' ? { origin: ORIGIN, 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    redirect: 'manual',
  });
  const text = await response.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  const setCookie = response.headers.getSetCookie?.() ?? [];
  const session = setCookie.map(c => c.split(';')[0]).find(c => c.startsWith('tt_session=') && c.length > 'tt_session='.length);
  return { status: response.status, json, session };
}
const password = 'correct horse battery staple';

// N-3: a successful login clears the per-IP bucket, so one valid account resets the IP limit
// between guesses against other accounts.
{
  const attacker = `attacker-${run}@example.test`;
  await call('/api/auth', { method: 'POST', body: { action: 'register', email: attacker, password, displayName: 'Attacker' } });
  const statuses = [];
  for (let i = 0; i < 24; i++) {
    const r = await call('/api/auth', { method: 'POST', body: { action: 'login', email: `victim${i}-${run}@example.test`, password: 'wrong password guess' } });
    statuses.push(r.status);
    if (i % 6 === 5) await call('/api/auth', { method: 'POST', body: { action: 'login', email: attacker, password } });
  }
  results.n3_failedLoginsAcrossEmails = { attempts: statuses.length, statuses: [...new Set(statuses)], rateLimited: statuses.filter(s => s === 429).length, limitPerIpWithoutReset: 8 };
}

// N-4: /mcp performs no Origin or Content-Type check (contrast: every /api POST does).
{
  const forged = { 'oai-authenticated-user-id': `mcp-${run}`, 'oai-authenticated-user-email': `mcp-${run}@example.test` };
  const r = await call('/mcp', {
    method: 'POST', headers: { ...forged, origin: 'https://evil.example', 'content-type': 'text/plain' },
    raw: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_trip_ledger', arguments: {} } }),
  });
  const api = await call('/api/profile', { method: 'POST', headers: { ...forged, origin: 'https://evil.example' }, body: { displayName: 'x' } });
  results.n4_crossOriginTextPlain = { mcpStatus: r.status, mcpIsError: r.json?.result?.isError ?? null, apiProfileStatus: api.status };
}

// F-05 (local only): the Worker itself accepts provider headers without verification.
{
  const r = await call('/api/ledger', { headers: { 'oai-authenticated-user-id': `forged-${run}`, 'oai-authenticated-user-email': `forged-${run}@example.test` } });
  results.f05_localForgedHeader = { status: r.status, trips: r.json?.data?.trips?.length };
}

// N-5: email squatting. Anyone can register a password account for an email first; the real
// ChatGPT user with that email can then never add a password, and email-bound invites go to the squatter.
{
  const email = `chatgpt-user-${run}@example.test`;
  const provider = { 'oai-authenticated-user-id': `oai-${run}`, 'oai-authenticated-user-email': email };
  await call('/api/profile', { headers: provider }); // ChatGPT user's profile exists
  const squat = await call('/api/auth', { method: 'POST', body: { action: 'register', email, password, displayName: 'Squatter' } });
  const setPw = await call('/api/auth', { method: 'POST', headers: provider, body: { action: 'set_password', password: 'another long password' } });
  results.n5_emailSquat = { squatterRegister: squat.status, realUserSetPassword: setPw.status, message: setPw.json?.error };
}

// F-03 re-check: an unrelated user's save makes everyone else's next save conflict.
{
  const a = await call('/api/auth', { method: 'POST', body: { action: 'register', email: `a-${run}@example.test`, password, displayName: 'A' } });
  const c = await call('/api/auth', { method: 'POST', body: { action: 'register', email: `c-${run}@example.test`, password, displayName: 'C' } });
  const trip = (id, name) => ({ id, name, currency: 'GBP', members: [{ id: 'm1', name }], expenses: [], drafts: [], payments: [] });
  const aLedger = await call('/api/ledger', { cookie: a.session });
  const cLedger = await call('/api/ledger', { cookie: c.session });
  const cSave = await call('/api/ledger', { method: 'POST', cookie: c.session, body: { data: { trips: [trip(`c-trip-${run}`, 'C')] }, revision: cLedger.json.revision } });
  const aSave = await call('/api/ledger', { method: 'POST', cookie: a.session, body: { data: { trips: [trip(`a-trip-${run}`, 'A')] }, revision: aLedger.json.revision } });
  results.f03_unrelatedConflict = { cSave: cSave.status, aSaveAfterUnrelatedWrite: aSave.status, aError: aSave.json?.error };
}

console.log(JSON.stringify(results, null, 2));
