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
type Invitation = { id: string; memberId: string; memberName: string; email: string | null; expiresAt: string };

function controller(initialInvitations: Invitation[] = []) {
  const values: unknown[] = [], dependencies: (unknown[] | undefined)[] = [];
  const callbacks: unknown[] = [], effects: (() => void | (() => void))[] = [];
  const calls: { url: string; options?: RequestInit }[] = [];
  const confirmations: { message: string }[] = [];
  let index = 0, linkNumber = 0;
  let acceptConfirmation = false, invitations = structuredClone(initialInvitations);
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
    if (name === './confirmation-dialog') return { useConfirmation: () => ({ confirm: async (options: { message: string }) => { confirmations.push(options); return acceptConfirmation; }, dialog: null, confirming: false }) };
    return nodeRequire(name);
  }, loaded, loaded.exports, async (url: string, options?: RequestInit) => {
    calls.push({ url, options });
    if (options?.method === 'POST') {
      const request = JSON.parse(options.body as string) as { mode: string; memberId: string; invitationId: string; email?: string };
      if (request.mode === 'revoke') {
        invitations = invitations.filter(invitation => invitation.id !== request.invitationId);
        return Response.json({});
      }
      linkNumber++;
      invitations = [{ id: `invitation-${linkNumber}`, memberId: request.memberId, memberName: trip.members.find(member => member.id === request.memberId)!.name, email: request.email || null, expiresAt: '2026-10-12T12:00:00.000Z' }];
      return Response.json({ url: `https://triptab.test/?invite=one-use-${linkNumber}`, invitationId: `invitation-${linkNumber}` });
    }
    return Response.json({ invitations, hasMore: false });
  });
  return {
    calls, confirmations,
    acceptConfirmations() { acceptConfirmation = true; },
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
function invitationName(rendered: Rendered) {
  const row = rendered.elements.find(element => element.props.className === 'invite-management-entry');
  assert(row);
  return elements(row).find(element => element.type === 'strong')?.props.children;
}
async function revokeInvitation(rendered: Rendered) {
  const button = rendered.elements.find(element => element.type === 'button' && element.props.children === 'Revoke');
  assert(button);
  await (button.props.onClick as () => Promise<void>)();
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

test('invitation rows and revoke confirmation use the current traveller name while preserving the original one-time link and id', async () => {
  const ui = controller();
  const link = await createInvitation(ui), callsBeforeRename = ui.calls.length;
  const renamed = structuredClone(initialTrip);
  renamed.members.find(member => member.id === 'bob')!.name = 'Robert';
  ui.changeTrip(renamed); ui.render(); await settle();
  const rendered = ui.render();
  assert.equal(invitationName(rendered), 'Robert', 'the stored invitation snapshot still says Bob');
  assert.equal(invitationValue(rendered), link);
  assert.equal(ui.calls.length, callsBeforeRename, 'a display-name edit needs no invitation request');

  await revokeInvitation(rendered);
  assert.equal(ui.confirmations.at(-1)?.message, 'Revoke the invitation for Robert? Its link will stop working.');
  assert.equal(invitationValue(ui.render()), link, 'cancelling revoke preserves the original URL');
  ui.acceptConfirmations();
  await revokeInvitation(ui.render());
  assert.deepEqual(JSON.parse(ui.calls.at(-2)!.options!.body as string), { mode: 'revoke', tripId: 'holiday', invitationId: 'invitation-1' });
  assert.equal(invitationValue(ui.render()), undefined, 'revoking the original invitation clears its URL');
});

test('an invitation for a removed traveller falls back to its saved name in the row and revoke confirmation', async () => {
  const ui = controller([{ id: 'saved-invitation', memberId: 'bob', memberName: 'Saved Bob', email: null, expiresAt: '2026-10-12T12:00:00.000Z' }]);
  ui.render(); await settle();
  assert.equal(invitationName(ui.render()), 'Bob', 'an existing traveller name takes precedence over the snapshot');
  const changed = structuredClone(initialTrip);
  changed.members = changed.members.filter(member => member.id !== 'bob');
  ui.changeTrip(changed); ui.render(); await settle();
  const rendered = ui.render();
  assert.equal(invitationName(rendered), 'Saved Bob');
  await revokeInvitation(rendered);
  assert.equal(ui.confirmations.at(-1)?.message, 'Revoke the invitation for Saved Bob? Its link will stop working.');
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
