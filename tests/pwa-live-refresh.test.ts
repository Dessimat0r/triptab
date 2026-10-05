import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JsxEmit, ModuleKind, ScriptTarget } from 'typescript';
import { transpileWithSharedImports } from './helpers/transpile';

type Hook = { value?: unknown; dependencies?: readonly unknown[]; cleanup?: () => void };
type Effect = { hook: Hook; run: () => void | (() => void) };
let active: Controls;
function activate(controls: Controls) { active = controls; }
const bridge = {
  useState: (initial: unknown) => active.state(initial),
  useRef: (initial: unknown) => active.ref(initial),
  useCallback: (callback: (...args: unknown[]) => unknown, dependencies: readonly unknown[]) => active.callback(callback, dependencies),
  useEffect: (run: Effect['run'], dependencies: readonly unknown[]) => active.effect(run, dependencies, false),
  useLayoutEffect: (run: Effect['run'], dependencies: readonly unknown[]) => active.effect(run, dependencies, true),
  useLiveRefresh: (refresh: () => unknown, options: { accountId?: string; enabled?: boolean }) => { active.refresh = refresh; active.refreshScope = options; },
};
Object.defineProperty(globalThis, Symbol.for('triptab.pwa-live-test'), { value: bridge, configurable: true });
const bridgeUrl = 'data:text/javascript;base64,' + Buffer.from(`const bridge=globalThis[Symbol.for('triptab.pwa-live-test')];${Object.keys(bridge).map(name => `export const ${name}=bridge.${name};`).join('\n')}`).toString('base64');
const source = await readFile(new URL('../components/pwa-controls.tsx', import.meta.url), 'utf8');
const compiled = transpileWithSharedImports(source, { sharedImportOverrides: { react: bridgeUrl }, compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022, jsx: JsxEmit.ReactJSX } }).outputText
  .replace('"@/components/use-live-refresh"', JSON.stringify(bridgeUrl))
  .replace('"lucide-react"', JSON.stringify(import.meta.resolve('lucide-react')));
const { default: PwaControls } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64')) as typeof import('../components/pwa-controls');

class Controls {
  hooks: Hook[] = []; position = 0; layouts: Effect[] = []; effects: Effect[] = [];
  refresh?: () => unknown; refreshScope?: { accountId?: string; enabled?: boolean };
  accountId = 'alice'; tree: unknown; changes = 0;
  state(initial: unknown) {
    const hook = this.hooks[this.position++] ??= { value: initial };
    return [hook.value, (next: unknown) => { hook.value = typeof next === 'function' ? next(hook.value) : next; }];
  }
  ref(initial: unknown) { return this.state({ current: initial })[0]; }
  callback(callback: unknown, dependencies: readonly unknown[]) {
    const hook = this.hooks[this.position++] ??= {};
    if (!sameDependencies(hook.dependencies, dependencies)) { hook.value = callback; hook.dependencies = dependencies; }
    return hook.value;
  }
  effect(run: Effect['run'], dependencies: readonly unknown[], layout: boolean) {
    const hook = this.hooks[this.position++] ??= {};
    if (sameDependencies(hook.dependencies, dependencies)) return;
    hook.dependencies = dependencies; (layout ? this.layouts : this.effects).push({ hook, run });
  }
  render() {
    activate(this); this.position = 0;
    this.tree = PwaControls({ accountId: this.accountId, onChanged: () => { this.changes++; } });
    for (const effect of [...this.layouts.splice(0), ...this.effects.splice(0)]) {
      effect.hook.cleanup?.(); const cleanup = effect.run(); effect.hook.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    }
  }
  update() { return this.refreshScope?.enabled && this.refreshScope.accountId === this.accountId ? this.refresh?.() : undefined; }
  get enabled() { return this.hooks[3]?.value; }
  get busy() { return this.hooks[4]?.value; }
  get status() { return this.hooks[5]?.value; }
  get publicKey() { return this.hooks[6]?.value; }
  toggle() {
    this.render();
    const find = (value: unknown): (() => Promise<void>) | undefined => {
      if (!value || typeof value !== 'object') return;
      const node = value as { type?: string; props?: { onClick?: () => Promise<void>; children?: unknown } };
      if (node.type === 'button' && node.props?.onClick && JSON.stringify(node.props.children).includes('notifications')) return node.props.onClick;
      const children = node.props?.children;
      for (const child of Array.isArray(children) ? children : [children]) { const result = find(child); if (result) return result; }
    };
    const toggle = find(this.tree); assert(toggle, 'notification toggle is rendered'); return toggle();
  }
  dispose() { for (const hook of this.hooks) { hook.cleanup?.(); hook.cleanup = undefined; } }
}
function sameDependencies(left: readonly unknown[] | undefined, right: readonly unknown[]) {
  return !!left && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(complete => { resolve = complete; }); return { promise, resolve }; }
async function flush() { for (let index = 0; index < 12; index++) await Promise.resolve(); }

function browser(context: import('node:test').TestContext) {
  let subscription: { endpoint: string; unsubscribe(): Promise<boolean> } | null = null;
  let unsubscribe = 0, subscribe = 0, permissions = 0, calls = 0;
  let owned = false, key = 'configured-key', fail = false;
  let response: (() => Promise<Response>) | undefined;
  const registration = {
    active: {},
    pushManager: { async getSubscription() { return subscription; }, async subscribe() { subscribe++; subscription = makeSubscription(); return subscription; } },
    async getNotifications() { return []; },
  };
  function makeSubscription() { return { endpoint: 'https://fcm.googleapis.com/fcm/send/device', async unsubscribe() { unsubscribe++; subscription = null; return true; } }; }
  const worker = { async getRegistration() { return registration; }, async register() { return registration; }, ready: new Promise<never>(() => {}) };
  const property = (name: string, value: unknown) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    context.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name); });
  };
  property('navigator', { serviceWorker: worker, onLine: true });
  property('window', { PushManager: {}, Notification: {}, addEventListener() {}, removeEventListener() {} });
  property('matchMedia', () => ({ matches: false }));
  property('Notification', { async requestPermission() { permissions++; return 'granted'; } });
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    calls++; if (response) return response(); if (fail) throw Error('offline');
    if (init?.body && JSON.parse(String(init.body)).mode === 'unsubscribe') owned = false;
    if (init?.body && JSON.parse(String(init.body)).mode === 'subscribe') owned = true;
    return Response.json({ ownsSubscription: owned, publicKey: key });
  });
  return { registration, worker, setSubscribed() { subscription = makeSubscription(); owned = true; }, set owned(value: boolean) { owned = value; }, set key(value: string) { key = value; }, set fail(value: boolean) { fail = value; }, set response(value: (() => Promise<Response>) | undefined) { response = value; }, get calls() { return calls; }, get unsubscribed() { return unsubscribe; }, get subscribed() { return subscribe; }, get permissions() { return permissions; } };
}

test('live notification ownership and configuration update in place without prompting or opting in', async context => {
  const fixture = browser(context), controls = new Controls(); fixture.setSubscribed(); controls.render(); await flush();
  assert.equal(controls.enabled, true); assert.equal(controls.publicKey, 'configured-key');
  fixture.key = 'new-configured-key'; await controls.update(); assert.equal(controls.publicKey, 'new-configured-key');
  fixture.owned = false; await controls.update(); assert.equal(controls.enabled, false); assert.equal(fixture.unsubscribed, 1);
  assert.match(String(controls.status), /Notifications are off/);
  assert.equal(fixture.permissions, 0); assert.equal(fixture.subscribed, 0); assert.equal(controls.busy, false); controls.dispose();
});

test('overlapping live reads coalesce and failures retry automatically', async context => {
  const fixture = browser(context), controls = new Controls(); controls.render(); await flush();
  const held = deferred<Response>(); fixture.response = () => held.promise;
  const before = fixture.calls, first = controls.update(), second = controls.update(); await flush();
  assert.equal(fixture.calls, before + 1); held.resolve(Response.json({ publicKey: 'changed' })); await Promise.all([first, second]);
  assert.equal(controls.publicKey, 'changed'); fixture.response = undefined; fixture.fail = true;
  await controls.update(); assert.match(String(controls.status), /Checking again automatically/); assert.doesNotMatch(String(controls.status), /refreshing/);
  fixture.fail = false; await controls.update(); assert.equal(controls.status, ''); assert.equal(fixture.permissions, 0); controls.dispose();
});

test('late account responses and cleanup cannot disable a newer account subscription', async context => {
  const fixture = browser(context), controls = new Controls(); fixture.setSubscribed(); controls.render(); await flush();
  const held = deferred<Response>(); fixture.response = () => held.promise; const old = controls.update(); await flush();
  controls.accountId = 'bob'; fixture.response = undefined; controls.render(); await flush();
  held.resolve(Response.json({ ownsSubscription: false, publicKey: 'old-account' })); await old; await flush();
  assert.equal(controls.enabled, true); assert.equal(controls.publicKey, 'configured-key'); assert.equal(fixture.unsubscribed, 0);
  const late = deferred<Response>(); fixture.response = () => late.promise; const closing = controls.update(); await flush(); controls.dispose();
  late.resolve(Response.json({ ownsSubscription: false })); await closing; assert.equal(fixture.unsubscribed, 0);
});

test('an explicit toggle uses the active registration and skips live checks until its final reconciliation', async context => {
  const fixture = browser(context), controls = new Controls(); fixture.setSubscribed(); controls.render(); await flush();
  const held = deferred<Response>(); fixture.response = () => held.promise; const toggle = controls.toggle(); await flush();
  const before = fixture.calls; await controls.update(); await controls.update(); assert.equal(fixture.calls, before);
  fixture.response = undefined; fixture.owned = false; held.resolve(Response.json({ ok: true })); await toggle; await flush();
  assert.equal(controls.enabled, false); assert.equal(controls.busy, false); assert.equal(fixture.unsubscribed, 1);
  assert.equal(fixture.calls, before + 1, 'one read checks settings after the toggle'); assert.equal(controls.changes, 1);
  assert.equal(fixture.permissions, 0); controls.dispose();
});

test('a stalled browser read times out so the next live update can recover', async context => {
  const fixture = browser(context), controls = new Controls(); controls.render(); await flush();
  const timers: (() => void)[] = [], originalTimeout = globalThis.setTimeout;
  context.mock.method(globalThis, 'setTimeout', ((callback: () => void, delay?: number) => delay === 8_000 ? (timers.push(callback), timers.length) : originalTimeout(callback, delay)) as typeof setTimeout);
  context.mock.method(globalThis, 'clearTimeout', () => {});
  const held = deferred<typeof fixture.registration>(); context.mock.method(fixture.worker, 'getRegistration', () => held.promise);
  const pending = controls.update(); await flush(); assert.equal(timers.length, 1); timers[0](); await pending;
  assert.match(String(controls.status), /Checking again automatically/);
  context.mock.method(fixture.worker, 'getRegistration', async () => fixture.registration);
  await controls.update(); assert.equal(controls.status, ''); held.resolve(fixture.registration); await flush();
  assert.equal(fixture.permissions, 0); assert.equal(fixture.subscribed, 0); controls.dispose();
});
