import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ModuleKind, ScriptTarget, JsxEmit, transpileModule } from 'typescript';

const compiled = transpileModule(await readFile(new URL('../components/activity-panel.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.ReactJSX },
}).outputText;
type Event = { id: string; sequence: number; userId?: string };
type History = { events: Event[]; loading: boolean; error: string; nextCursor: number | null; loadOlder(): Promise<void> };
function controller(fetcher: (url: string, options: RequestInit) => Promise<Response>) {
  const slots: unknown[] = [], deps: (unknown[] | undefined)[] = [], cleanups: (undefined | (() => void))[] = [];
  const effects: (() => void)[] = [], layout: (() => void)[] = [];
  let index = 0, liveRefresh!: () => Promise<void>;
  let accountId = 'alice', key = 'alice:holiday', endpoint = '/api/activity?tripId=holiday', refreshKey = 0;
  const changed = (slot: number, next?: unknown[]) => !deps[slot] || !next || deps[slot]!.length !== next.length || next.some((value, at) => !Object.is(value, deps[slot]![at]));
  const effect = (queue: (() => void)[], callback: () => void | (() => void), next?: unknown[]) => {
    const slot = index++;
    if (changed(slot, next)) {
      deps[slot] = next;
      queue.push(() => { cleanups[slot]?.(); cleanups[slot] = callback() || undefined; });
    }
  };
  const hooks = {
    useState(initial: unknown) { const slot = index++; if (!(slot in slots)) slots[slot] = initial; return [slots[slot], (next: unknown) => { slots[slot] = typeof next === 'function' ? next(slots[slot]) : next; }]; },
    useRef(initial: unknown) { const slot = index++; if (!(slot in slots)) slots[slot] = { current: initial }; return slots[slot]; },
    useCallback(callback: unknown, next: unknown[]) { const slot = index++; if (changed(slot, next)) { slots[slot] = callback; deps[slot] = next; } return slots[slot]; },
    useEffect: (callback: () => void | (() => void), next?: unknown[]) => effect(effects, callback, next),
    useLayoutEffect: (callback: () => void | (() => void), next?: unknown[]) => effect(layout, callback, next),
  };
  const loaded = { exports: {} as { useActivityPages(endpoint: string, key: string, refreshKey: number, ownerField: 'userId' | undefined, accountId: string): History } };
  new Function('require', 'module', 'exports', 'fetch', 'location', compiled)((name: string) => {
    if (name === 'react') return hooks;
    if (name === './use-live-refresh') return { useLiveRefresh: (callback: typeof liveRefresh) => { liveRefresh = callback; } };
    return {};
  }, loaded, loaded.exports, fetcher, { origin: 'https://triptab.test' });
  return {
    render() {
      index = 0;
      const result = loaded.exports.useActivityPages(endpoint, key, refreshKey, endpoint === '/api/account-activity' ? 'userId' : undefined, accountId);
      layout.splice(0).forEach(callback => callback()); effects.splice(0).forEach(callback => callback());
      return result;
    },
    refresh: () => liveRefresh(),
    changeAccount(id: string) { accountId = id; key = `${id}:holiday`; },
    privateAccount() { endpoint = '/api/account-activity'; key = `${accountId}:private`; },
    refreshToken() { refreshKey++; },
    unmount() { cleanups.forEach(cleanup => cleanup?.()); },
  };
}
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); };
const events = (from: number, to: number, userId?: string): Event[] => Array.from({ length: from - to + 1 }, (_, at) => ({ id: `${userId || 'event'}-${from - at}`, sequence: from - at, ...(userId ? { userId } : {}) }));
const page = (data: Event[], cursor: number | null = null) => Response.json({ events: data, nextCursor: cursor });

test('live history checks are quiet, coalesced and preserve loaded entries until the new page arrives', async () => {
  let finish!: (response: Response) => void, calls = 0;
  const ui = controller(async () => ++calls === 1 ? page(events(3, 1)) : new Promise(resolve => { finish = resolve; }));
  ui.render(); await settle(); const saved = ui.render(); assert.equal(saved.events.length, 3);
  const pending = ui.refresh(); await ui.refresh();
  assert.equal(calls, 2); assert.equal(ui.render().loading, false); assert.deepEqual(ui.render().events, saved.events);
  finish(page(events(4, 2))); await pending;
  const refreshed = ui.render();
  assert.deepEqual(refreshed.events.map(event => event.sequence), [4, 3, 2, 1]);
  for (const event of saved.events) assert.equal(refreshed.events.find(value => value.id === event.id), event, 'expanded immutable audit rows retain their memoized event object');
  ui.unmount();
});

test('an automatic check waits for Load older and merges new events without losing the reader’s range', async () => {
  let finishOlder!: (response: Response) => void, headCalls = 0;
  const ui = controller(async url => {
    if (url.includes('before=31')) return new Promise(resolve => { finishOlder = resolve; });
    headCalls++; return headCalls === 1 ? page(events(50, 31), 31) : page(events(51, 32), 32);
  });
  ui.render(); await settle();
  const older = ui.render().loadOlder(); ui.render();
  await ui.refresh(); assert.equal(headCalls, 1, 'a live check cannot cancel the older-page request');
  finishOlder(page(events(30, 11), 11)); await older;
  ui.render(); await settle(); const refreshed = ui.render();
  assert.equal(headCalls, 2); assert.deepEqual(refreshed.events.map(event => event.sequence), Array.from({ length: 41 }, (_, at) => 51 - at));
  assert.equal(refreshed.nextCursor, 11); ui.unmount();
});

test('history errors retain saved rows and a later automatic success clears the retry state', async () => {
  let calls = 0;
  const ui = controller(async () => ++calls === 2 ? Response.json({ error: 'Temporary history outage' }, { status: 503 }) : page(events(calls === 1 ? 2 : 3, 1)));
  ui.render(); await settle(); ui.render();
  await ui.refresh(); assert.equal(ui.render().events.length, 2); assert.match(ui.render().error, /outage/);
  await ui.refresh(); assert.equal(ui.render().events.length, 3); assert.equal(ui.render().error, ''); ui.unmount();
});

test('a delayed private history response cannot revive data after an account switch', async () => {
  let finish!: (response: Response) => void, calls = 0;
  const ui = controller(async () => ++calls === 1 ? new Promise(resolve => { finish = resolve; }) : page(events(1, 1, 'bob')));
  ui.privateAccount(); ui.render(); ui.changeAccount('bob'); ui.privateAccount();
  assert.equal(ui.render().events.length, 0); await settle();
  finish(page(events(3, 1, 'alice'))); await settle();
  assert.deepEqual(ui.render().events.map(event => event.userId), ['bob']); ui.unmount();
});

test('loss of access clears private history instead of retaining cached rows', async () => {
  let calls = 0;
  const ui = controller(async () => ++calls === 1 ? page(events(2, 1, 'alice')) : Response.json({ error: 'Sign in again' }, { status: 401 }));
  ui.privateAccount(); ui.render(); await settle(); ui.render();
  await ui.refresh(); assert.equal(ui.render().events.length, 0); assert.match(ui.render().error, /Sign in/); ui.unmount();
});


test('unchanged live history responses keep the accepted event array and object identities', async () => {
  const ui = controller(async () => page(events(3, 1)));
  ui.render(); await settle(); const saved = ui.render();
  await ui.refresh(); const unchanged = ui.render();
  assert.equal(unchanged.events, saved.events, 'an unchanged read does not invalidate the history list');
  for (let index = 0; index < saved.events.length; index++) assert.equal(unchanged.events[index], saved.events[index]);
  ui.unmount();
});


test('an already loaded empty history remains inline while an automatic check is pending', async () => {
  let finish!: (response: Response) => void, calls = 0;
  const ui = controller(async () => ++calls === 1 ? page([]) : new Promise(resolve => { finish = resolve; }));
  ui.render(); await settle(); assert.equal(ui.render().loading, false);
  const pending = ui.refresh(); assert.equal(ui.render().loading, false, 'quiet checks must not flash the initial loading view');
  finish(page([])); await pending; assert.equal(ui.render().loading, false); ui.unmount();
});


test('a private history response for another signed-in account clears rows until the profile scope catches up', async () => {
  let calls = 0;
  const ui = controller(async () => page(events(2, 1, ++calls === 1 ? 'alice' : 'bob')));
  ui.privateAccount(); ui.render(); await settle(); assert.equal(ui.render().events.length, 2);
  await ui.refresh();
  assert.equal(ui.render().events.length, 0);
  assert.match(ui.render().error, /account changed/);
  ui.changeAccount('bob'); ui.privateAccount(); ui.render(); await settle();
  assert.deepEqual(ui.render().events.map(event => event.userId), ['bob', 'bob']);
  assert.equal(ui.render().error, ''); ui.unmount();
});

test('private history rejects mixed-owner head and older pages instead of merging unauthorized records', async context => {
  await context.test('mixed initial head', async () => {
    const ui = controller(async () => page([...events(2, 2, 'alice'), ...events(1, 1, 'bob')]));
    ui.privateAccount(); ui.render(); await settle();
    assert.equal(ui.render().events.length, 0); assert.match(ui.render().error, /account changed/); ui.unmount();
  });
  await context.test('older page changed owner', async () => {
    const ui = controller(async url => url.includes('before=2') ? page(events(1, 1, 'bob')) : page(events(3, 2, 'alice'), 2));
    ui.privateAccount(); ui.render(); await settle();
    await ui.render().loadOlder();
    assert.equal(ui.render().events.length, 0); assert.match(ui.render().error, /account changed/); ui.unmount();
  });
});
