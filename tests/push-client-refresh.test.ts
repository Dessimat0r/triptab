import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
type Client = { url: string; postMessage(message: unknown): void };
type PushOptions = {
  ownership?: boolean | number | Error;
  inbox?: number | Error;
  clients?: Client[] | Error;
  subscription?: boolean;
};

async function push(options: PushOptions = {}) {
  const handlers = new Map<string, (event: { waitUntil(task: Promise<unknown>): void }) => void>();
  const fetched: string[] = [], shown: unknown[][] = [], messages: { url: string; data: unknown }[] = [];
  let unsubscribe = 0, closed = 0, matched = 0, navigation = 0;
  const ours = ['https://triptab.test/expenses', 'https://triptab.test/balances'];
  const clients: Client[] = options.clients instanceof Error ? [] : options.clients ?? [
    ...ours.map(url => ({ url, postMessage(data: unknown) { messages.push({ url, data }); } })),
    { url: 'https://other.test/', postMessage(data: unknown) { messages.push({ url: 'foreign', data }); } },
  ];
  const context = vm.createContext({
    URL, Response, AbortController, setTimeout, clearTimeout,
    self: {
      location: { origin: 'https://triptab.test' },
      addEventListener(name: string, handler: (event: { waitUntil(task: Promise<unknown>): void }) => void) { handlers.set(name, handler); },
      registration: {
        pushManager: { async getSubscription() {
          if (options.subscription === false) return null;
          return { endpoint: 'https://push.example.test/private-endpoint', async unsubscribe() { unsubscribe++; } };
        } },
        async getNotifications() { return [{ close() { closed++; } }]; },
        async showNotification(...args: unknown[]) { shown.push(args); },
      },
      clients: {
        async matchAll(value: unknown) {
          matched++;
          assert.deepEqual(JSON.parse(JSON.stringify(value)), { type: 'window', includeUncontrolled: true });
          if (options.clients instanceof Error) throw options.clients;
          return clients.map(client => ({ ...client, async navigate() { navigation++; }, async focus() { navigation++; } }));
        },
        async openWindow() { navigation++; },
      },
    },
    async fetch(url: string) {
      fetched.push(url);
      if (url === '/api/push') {
        const ownership = options.ownership ?? true;
        if (ownership instanceof Error) throw ownership;
        return Response.json({ ownsSubscription: ownership === true }, { status: typeof ownership === 'number' ? ownership : 200 });
      }
      assert.equal(url, '/api/notifications');
      if (options.inbox instanceof Error) throw options.inbox;
      return Response.json({ notifications: [{ id: 'private-id', title: 'Private account title', body: 'Private account body', url: '/expenses?private=value' }] }, { status: options.inbox ?? 200 });
    },
  });
  vm.runInContext(source, context);
  let task: Promise<unknown> | undefined;
  handlers.get('push')!({ waitUntil(value) { task = value; } });
  assert(task, 'push keeps the authorization and wake-up work alive');
  await task;
  return { fetched, shown, messages, unsubscribe, closed, matched, navigation };
}

test('an authorized push wakes same-origin windows with only a generic refresh signal', async () => {
  const result = await push();
  assert.deepEqual(result.fetched, ['/api/push', '/api/notifications']);
  assert.equal(result.messages.length, 2);
  for (const message of result.messages) {
    assert.equal(new URL(message.url).origin, 'https://triptab.test');
    assert.equal(JSON.stringify(message.data), '{"type":"TRIPTAB_REFRESH"}');
  }
  assert.equal(result.navigation, 0, 'push never navigates, focuses or reloads an open editor');
  assert.equal(result.shown.length, 1);
  assert.equal(result.shown[0][0], 'Private account title', 'existing visible notifications are preserved');
});

test('foreign, logged-out and offline subscriptions cannot wake windows or read the private inbox', async () => {
  for (const ownership of [false, 401, 403, new Error('offline')]) {
    const result = await push({ ownership });
    assert.deepEqual(result.fetched, ['/api/push']);
    assert.equal(result.messages.length, 0);
    assert.equal(result.matched, 0);
    assert.equal(result.shown.length, 0);
    if (!(ownership instanceof Error)) {
      assert.equal(result.unsubscribe, 1);
      assert.equal(result.closed, 1);
    }
  }
  const absent = await push({ subscription: false });
  assert.equal(absent.fetched.length, 0);
  assert.equal(absent.messages.length, 0);
  assert.equal(absent.shown.length, 0);
});

test('revocation between ownership and inbox checks prevents foreground refresh and notification', async () => {
  for (const inbox of [401, 403]) {
    const result = await push({ inbox });
    assert.deepEqual(result.fetched, ['/api/push', '/api/notifications']);
    assert.equal(result.messages.length, 0);
    assert.equal(result.matched, 0);
    assert.equal(result.shown.length, 0);
  }
});

test('an unavailable private inbox preserves generic notifications without waking open windows', async () => {
  for (const inbox of [503, new Error('offline')]) {
    const result = await push({ inbox });
    assert.equal(result.messages.length, 0);
    assert.equal(result.matched, 0);
    assert.equal(result.shown.length, 1);
    assert.equal(result.shown[0][0], 'TripTab update');
    assert.equal(result.navigation, 0);
  }
});

test('a closing or malformed client cannot stop other windows or existing push notifications', async () => {
  const delivered: unknown[] = [];
  const result = await push({ clients: [
    { url: 'not a URL', postMessage() { throw Error('must not reach an invalid client'); } },
    { url: 'https://triptab.test/closing', postMessage() { throw Error('client closed'); } },
    { url: 'https://triptab.test/expenses', postMessage(message) { delivered.push(message); } },
  ] });
  assert.equal(delivered.length, 1);
  assert.equal(JSON.stringify(delivered[0]), '{"type":"TRIPTAB_REFRESH"}');
  assert.equal(result.shown.length, 1);
  assert.equal(result.navigation, 0);
  const unavailable = await push({ clients: new Error('windows unavailable') });
  assert.equal(unavailable.shown.length, 1);
  assert.equal(unavailable.messages.length, 0);
});


test('clicking a notification focuses and updates the open app without navigating its form', async () => {
  let task:Promise<unknown>|undefined,focused=0,navigated=0,opened=0,closed=0;
  const messages:unknown[]=[];
  let click:(event:unknown)=>void=()=>{};
  const client={url:'https://triptab.test/expenses?receipt=open',postMessage(value:unknown){messages.push(value)},async focus(){focused++},async navigate(){navigated++}};
  const context=vm.createContext({URL,self:{location:{origin:'https://triptab.test'},
    addEventListener(name:string,handler:(event:unknown)=>void){if(name==='notificationclick')click=handler},
    clients:{async matchAll(){return [client]},async openWindow(){opened++}}
  }});
  vm.runInContext(source,context);
  click({notification:{data:{url:'/balances'},close(){closed++}},waitUntil(value:Promise<unknown>){task=value}});
  await task;assert.equal(focused,1);assert.equal(closed,1);assert.equal(navigated,0);assert.equal(opened,0);
  assert.equal(JSON.stringify(messages), '[{"type":"TRIPTAB_REFRESH"}]');
});

test('notification clicks open the internal destination when there is no existing app window', async () => {
  let task:Promise<unknown>|undefined,click:(event:unknown)=>void=()=>{};
  const opened:string[]=[];
  const context=vm.createContext({URL,self:{location:{origin:'https://triptab.test'},
    addEventListener(name:string,handler:(event:unknown)=>void){if(name==='notificationclick')click=handler},
    clients:{async matchAll(){return []},async openWindow(url:string){opened.push(url)}}
  }});
  vm.runInContext(source,context);
  click({notification:{data:{url:'https://foreign.test/'},close(){}},waitUntil(value:Promise<unknown>){task=value}});
  await task;assert.deepEqual(opened,['https://triptab.test/']);
});
