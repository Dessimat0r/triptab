import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import * as languageModel from '../lib/receipt-languages';
import type { LanguagePreferencesController } from '../components/trip-language-preferences';

const compiled = transpileModule(await readFile(new URL('../components/trip-language-preferences.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.ReactJSX },
}).outputText.replace('require("./receipt-languages.css");', '');
const nodeRequire = createRequire(import.meta.url);
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); };
const snapshot = (revision = 0, readingLanguage = 'en', accountId = 'owner', tripId = 'holiday') => ({
  accountId, tripId, revision, preferences: { readingLanguage, primaryVersion: 'reading', itemVersions: {} },
});

function controller(fetcher: (url: string, options?: RequestInit) => Promise<Response>) {
  const slots: unknown[] = [], dependencies: (unknown[] | undefined)[] = [];
  const cleanups = new Map<number, () => void>(), effects: { slot: number; callback: () => void | (() => void) }[] = [];
  const layouts: (() => void)[] = [];
  let index = 0, accountId = 'owner', tripId = 'holiday';
  let refresh: (() => void | Promise<unknown>) | undefined;
  const changed = (slot: number, next: unknown[]) => !dependencies[slot] || next.some((value, at) => !Object.is(value, dependencies[slot]![at]));
  const hooks = {
    useState(initial: unknown) {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = initial;
      return [slots[slot], (next: unknown) => { slots[slot] = typeof next === 'function' ? next(slots[slot]) : next; }];
    },
    useRef(initial: unknown) { const slot = index++; return slots[slot] ||= { current: initial }; },
    useCallback(callback: unknown, next: unknown[]) {
      const slot = index++;
      if (changed(slot, next)) { slots[slot] = callback; dependencies[slot] = next; }
      return slots[slot];
    },
    useLayoutEffect(callback: () => void, next: unknown[]) {
      const slot = index++;
      if (changed(slot, next)) { layouts.push(callback); dependencies[slot] = next; }
    },
    useEffect(callback: () => void | (() => void), next: unknown[]) {
      const slot = index++;
      if (changed(slot, next)) { effects.push({ slot, callback }); dependencies[slot] = next; }
    },
  };
  const loaded = { exports: {} as { useTripLanguagePreferences(accountId: string, tripId: string): LanguagePreferencesController } };
  new Function('require', 'module', 'exports', 'fetch', compiled)((name: string) => {
    if (name === 'react') return hooks;
    if (name === '@/lib/receipt-languages') return languageModel;
    if (name === './use-live-refresh') return { useLiveRefresh(callback: () => void | Promise<unknown>, options: { accountId: string; enabled: boolean }) { refresh = options.enabled && options.accountId === accountId ? callback : undefined; } };
    return nodeRequire(name);
  }, loaded, loaded.exports, fetcher);
  return {
    changeScope(account: string, trip: string) { accountId = account; tripId = trip; },
    refresh() { return refresh?.(); },
    render() {
      index = 0;
      const result = loaded.exports.useTripLanguagePreferences(accountId, tripId);
      for (const callback of layouts.splice(0)) callback();
      for (const effect of effects.splice(0)) {
        cleanups.get(effect.slot)?.();
        const cleanup = effect.callback();
        if (cleanup) cleanups.set(effect.slot, cleanup);
      }
      return result;
    },
    unmount() { for (const cleanup of cleanups.values()) cleanup(); },
  };
}

test('automatic preference reads coalesce and apply a same-account remote change inline', async () => {
  let calls = 0, finish!: (response: Response) => void;
  const ui = controller(async () => ++calls === 1 ? Response.json(snapshot()) : new Promise(resolve => { finish = resolve; }));
  ui.render(); await settle();
  assert.equal(ui.render().preferences.readingLanguage, 'en');
  const first = ui.refresh(), second = ui.refresh();
  assert.equal(calls, 2);
  finish(Response.json(snapshot(2, 'fr')));
  await Promise.all([first, second]);
  assert.equal(ui.render().preferences.readingLanguage, 'fr');
  assert.equal(ui.render().busy, false);
});

test('older preference responses cannot roll back an already accepted remote revision', async () => {
  let value = snapshot(4, 'fr');
  const ui = controller(async () => Response.json(value));
  ui.render(); await settle(); ui.render();
  value = snapshot(3, 'de');
  await ui.refresh();
  assert.equal(ui.render().preferences.readingLanguage, 'fr');
});

test('background preference checks preserve an optimistic change while its save is pending', async () => {
  let finish!: (response: Response) => void;
  const calls: { options?: RequestInit }[] = [];
  const ui = controller(async (_url, options) => {
    calls.push({ options });
    return options?.method === 'POST' ? new Promise(resolve => { finish = resolve; }) : Response.json(snapshot());
  });
  ui.render(); await settle();
  const saving = ui.render().save({ readingLanguage: 'fr' });
  assert.equal(ui.render().preferences.readingLanguage, 'fr');
  await ui.refresh();
  assert.equal(calls.length, 2);
  assert.equal(ui.render().busy, true);
  finish(Response.json(snapshot(1, 'fr')));
  assert.equal(await saving, true);
  assert.equal(ui.render().preferences.readingLanguage, 'fr');
});

for (const changed of ['account', 'trip']) test(`a late preference response cannot cross a ${changed} switch`, async () => {
  const replies: ((response: Response) => void)[] = [];
  const ui = controller(async () => new Promise(resolve => { replies.push(resolve); }));
  ui.render(); await settle();
  const account = changed === 'account' ? 'second-account' : 'owner', trip = changed === 'trip' ? 'second-trip' : 'holiday';
  ui.changeScope(account, trip); ui.render(); await settle();
  assert.equal(replies.length, 2);
  replies[1](Response.json(snapshot(2, 'de', account, trip))); await settle();
  assert.equal(ui.render().preferences.readingLanguage, 'de');
  replies[0](Response.json(snapshot(7, 'fr'))); await settle();
  assert.equal(ui.render().preferences.readingLanguage, 'de');
});

test('automatic preference checks retain a save conflict for the user to resolve', async () => {
  const ui = controller(async (_url, options) => options?.method === 'POST'
    ? Response.json({ error: 'Preferences changed elsewhere.' }, { status: 409 }) : Response.json(snapshot()));
  ui.render(); await settle();
  assert.equal(await ui.render().save({ readingLanguage: 'fr' }), false);
  ui.render(); await ui.refresh();
  assert.match(ui.render().error, /changed elsewhere/);
  assert.equal(ui.render().preferences.readingLanguage, 'en');
});

test('a failed initial preference read recovers automatically and clears its obsolete error', async () => {
  let failing = true;
  const ui = controller(async () => failing ? Response.json({ error: 'Preferences temporarily unavailable.' }, { status: 503 }) : Response.json(snapshot(1, 'fr')));
  ui.render(); await settle();
  assert.equal(ui.render().ready, false);
  assert.match(ui.render().error, /temporarily unavailable/);
  failing = false; await ui.refresh();
  const recovered = ui.render();
  assert.equal(recovered.ready, true);
  assert.equal(recovered.preferences.readingLanguage, 'fr');
  assert.equal(recovered.error, '');
});

test('unchanged preference polls retain the accepted object including reordered item display keys', async () => {
  const original = { ...snapshot(2), preferences: { ...snapshot().preferences, itemVersions: { first: 'reading', second: 'receipt' } } };
  let next = original;
  const ui = controller(async () => Response.json(next));
  ui.render(); await settle();
  const preferences = ui.render().preferences;
  next = { ...original, preferences: { ...original.preferences, itemVersions: { second: 'receipt', first: 'reading' } } };
  await ui.refresh();
  assert.equal(ui.render().preferences, preferences);
});
