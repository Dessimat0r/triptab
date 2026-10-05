import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import type { Trip } from '../lib/model';
import type { Profile } from '../components/account-panel';

const compiled = transpileModule(await readFile(new URL('../components/trip-sharing.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.ReactJSX },
}).outputText;
const nodeRequire = createRequire(import.meta.url);
type Element = React.ReactElement<Record<string, unknown>>;
function elements(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as React.ReactNode)];
}
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); };
const initialTrip: Trip = {
  id: 'holiday', ownerId: 'owner', name: 'Holiday', currency: 'GBP',
  members: [{ id: 'owner-member', userId: 'owner', name: 'Organiser' }, { id: 'bob', name: 'Bob' }, { id: 'carol', name: 'Carol' }],
  expenses: [], payments: [], drafts: [],
};
const owner: Profile = { id: 'owner', email: 'owner@example.test', displayName: 'Organiser' };

function controller() {
  const values: unknown[] = [], dependencies: (unknown[] | undefined)[] = [];
  const callbacks: unknown[] = [], effects: (() => void | (() => void))[] = [];
  const calls: { url: string; options?: RequestInit }[] = [];
  let index = 0, linkNumber = 0;
  let trip = structuredClone(initialTrip), profile = owner;
  const changed = (slot: number, next: unknown[] | undefined) => {
    const previous = dependencies[slot];
    return !previous || !next || previous.length !== next.length || next.some((value, at) => !Object.is(value, previous[at]));
  };
  const hooks = {
    useState(initial: unknown) {
      const slot = index++;
      if (!(slot in values)) values[slot] = initial;
      return [values[slot], (next: unknown) => { values[slot] = typeof next === 'function' ? next(values[slot]) : next; }];
    },
    useCallback(callback: unknown, next: unknown[]) {
      const slot = index++;
      if (changed(slot, next)) { callbacks[slot] = callback; dependencies[slot] = next; }
      return callbacks[slot];
    },
    useEffect(callback: () => void | (() => void), next: unknown[]) {
      const slot = index++;
      if (changed(slot, next)) { effects.push(callback); dependencies[slot] = next; }
    },
  };
  const loaded = { exports: {} as { TripSharing(props: { trip: Trip; profile: Profile }): React.ReactNode } };
  new Function('require', 'module', 'exports', 'fetch', compiled)((name: string) => {
    if (name === 'react') return hooks;
    if (name === 'lucide-react') return Object.fromEntries(['Link', 'Copy', 'Users', 'Check'].map(icon => [icon, () => React.createElement('svg')]));
    if (name === './confirmation-dialog') return { useConfirmation: () => ({ confirm: async () => false, dialog: null, confirming: false }) };
    return nodeRequire(name);
  }, loaded, loaded.exports, async (url: string, options?: RequestInit) => {
    calls.push({ url, options });
    if (options?.method === 'POST') {
      linkNumber++;
      return Response.json({ url: `https://triptab.test/?invite=one-use-${linkNumber}`, invitationId: `invitation-${linkNumber}` });
    }
    return Response.json({ invitations: [], hasMore: false });
  });
  return {
    calls,
    changeTrip(next: Trip) { trip = next; },
    changeProfile(next: Profile) { profile = next; },
    render() {
      index = 0;
      const tree = loaded.exports.TripSharing({ trip, profile });
      for (const effect of effects.splice(0)) effect();
      return { html: renderToStaticMarkup(tree), elements: elements(tree) };
    },
  };
}
type Rendered = ReturnType<ReturnType<typeof controller>['render']>;
function invitationValue(rendered: Rendered) {
  return rendered.elements.find(element => element.type === 'input' && element.props['aria-label'] === 'Invitation link')?.props.value;
}
async function createInvitation(ui: ReturnType<typeof controller>) {
  ui.render(); await settle();
  const form = ui.render().elements.find(element => element.type === 'form');
  assert(form);
  (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
  await settle();
  return invitationValue(ui.render());
}

test('renaming either unlinked traveller preserves the newly generated one-time invitation URL and updates its label', async () => {
  const ui = controller();
  const link = await createInvitation(ui);
  assert.equal(link, 'https://triptab.test/?invite=one-use-1');
  for (const memberId of ['bob', 'carol']) {
    const renamed = structuredClone(initialTrip);
    renamed.members.find(member => member.id === memberId)!.name = `Renamed ${memberId}`;
    ui.changeTrip(renamed);
    ui.render(); await settle();
    const rendered = ui.render();
    assert.equal(invitationValue(rendered), link, 'editing a display name cannot destroy an unrepeatable secret URL');
    assert.match(rendered.html, new RegExp(`Renamed ${memberId}`));
  }
  assert.equal(ui.calls.filter(call => call.options?.method === 'POST').length, 1, 'the organiser need not revoke and recreate the link');
});

test('traveller joining or changing the holiday clears a no-longer-applicable invitation URL', async context => {
  for (const reason of ['joined', 'different holiday']) await context.test(reason, async () => {
    const ui = controller(); await createInvitation(ui);
    const changed = structuredClone(initialTrip);
    if (reason === 'joined') changed.members.find(member => member.id === 'bob')!.userId = 'bob-account';
    else changed.id = 'other-holiday';
    ui.changeTrip(changed); ui.render(); await settle();
    assert.equal(invitationValue(ui.render()), undefined);
  });
});

test('switching organiser accounts cannot retain or resurrect a previous account’s invitation URL', async () => {
  const ui = controller(); await createInvitation(ui);
  ui.changeProfile({ ...owner, id: 'other-account' });
  ui.render(); await settle();
  assert.equal(invitationValue(ui.render()), undefined);
  ui.changeProfile(owner); ui.render(); await settle();
  assert.equal(invitationValue(ui.render()), undefined);
});
