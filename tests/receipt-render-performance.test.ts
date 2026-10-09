import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as React from 'react';
import * as runtime from 'react/jsx-runtime';
import * as model from '../lib/model';
import * as dates from '../lib/dates';
import * as clientLedger from '../lib/client-ledger';
import * as moneyFormat from '../lib/money-format';
import * as receiptScan from '../lib/receipt-scan';
import * as receiptProcessing from '../lib/receipt-processing';
import * as receiptChatgpt from '../lib/receipt-chatgpt';
import * as expenseFxReview from '../lib/expense-fx-review';
import * as expenseReadiness from '../lib/expense-readiness';
import * as quickExpense from '../lib/quick-expense';
import * as dataUtils from '../lib/data-utils';
import * as receiptLanguages from '../lib/receipt-languages';
import { createSourceFile, isArrayBindingPattern, isBindingElement, isCallExpression, isFunctionDeclaration, isIdentifier, isVariableStatement, JsxEmit, ModuleKind, ScriptKind, ScriptTarget, transpileModule } from 'typescript';

// Run Home's actual render and event handlers with a small hook boundary. Child
// rendering is excluded here so these assertions measure saved-ledger work,
// independent of the machine's speed or a second financial implementation.
const source = await readFile(new URL('../components/trip-app.tsx', import.meta.url), 'utf8');
const syntax = createSourceFile('page.tsx', source, ScriptTarget.Latest, true, ScriptKind.TSX);
const home = syntax.statements.find(statement => isFunctionDeclaration(statement) && statement.name?.text === 'Home');
assert(home && isFunctionDeclaration(home) && home.body);
const states = home.body.statements.filter(isVariableStatement).flatMap(statement => statement.declarationList.declarations)
  .filter(declaration => declaration.initializer && isCallExpression(declaration.initializer) && declaration.initializer.expression.getText(syntax) === 'useState')
  .map(declaration => {
    assert(isArrayBindingPattern(declaration.name));
    const first = declaration.name.elements[0];
    assert(isBindingElement(first) && isIdentifier(first.name));
    return first.name.text;
  });
const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.ReactJSX } }).outputText;
type Element = React.ReactElement<Record<string, unknown>>;
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!React.isValidElement<Record<string, unknown>>(value)) return [];
  return [value, ...elements(value.props.children)];
}
function fixture(count = 100): model.Trip {
  const members = [{ id: 'alice', name: 'Alice', userId: 'account-alice' }, { id: 'bob', name: 'Bob' }];
  return { id: 'holiday', name: 'Holiday', currency: 'GBP', members, drafts: [], payments: [], expenses: Array.from({ length: count }, (_, index) => ({
    id: `expense-${index}`, title: `Dinner ${index}`, payer: 'alice', date: '2026-10-04', time: '12:00', timezone: 'Europe/London', currency: 'GBP',
    tax: 3, tip: 7, discount: 1, items: Array.from({ length: 20 }, (_, item) => ({ id: `item-${index}-${item}`, name: `Item ${item}`, amount: 101 + item, members: ['alice', 'bob'] })),
  })) };
}
function controller(trip: model.Trip, fetcher?: typeof fetch) {
  const state: Record<string, unknown> = { view: 'expenses', ledger: { trips: [trip] }, selected: trip.id, loading: false, profile: { id: 'account-alice', displayName: 'Alice', email: 'alice@example.test' } };
  const refs: { current: unknown }[] = [], memos: { dependencies: unknown[]; value: unknown }[] = [];
  const calls = { balances: 0, settlements: 0, expenseShares: 0, expenseTotal: 0 };
  const models = { ...model };
  for (const name of Object.keys(calls) as (keyof typeof calls)[]) {
    models[name] = ((...args: never[]) => { calls[name]++; return (model[name] as (...args: never[]) => unknown)(...args); }) as never;
  }
  let stateIndex = 0, refIndex = 0, memoIndex = 0;
  const navigationEffects: (() => void)[] = [];
  const layoutEffects: (() => void)[] = [];
  const hooks = { ...React,
    useState(initial: unknown) {
      const key = states[stateIndex++];
      if (!Object.hasOwn(state, key)) state[key] = typeof initial === 'function' ? initial() : initial;
      return [state[key], (next: unknown) => { state[key] = typeof next === 'function' ? next(state[key]) : next; }];
    },
    useRef(initial: unknown) { const index = refIndex++; return refs[index] ||= { current: initial }; },
    useMemo(callback: () => unknown, dependencies: unknown[]) {
      const index = memoIndex++, previous = memos[index];
      if (!previous || dependencies.some((value, item) => !Object.is(value, previous.dependencies[item]))) memos[index] = { dependencies, value: callback() };
      return memos[index].value;
    },
    useCallback: (callback: unknown) => callback,
    useLayoutEffect(callback: () => void) { layoutEffects.push(callback); },
    useEffect(callback: () => void, dependencies: unknown[]) {
      // Run the real section-entry refresh, while excluding mount listeners.
      if (dependencies?.length === 2 && dependencies[0] === state.view && typeof dependencies[1] === 'function') navigationEffects.push(callback);
    },
  };
  const component = (props: unknown) => props;
  const exported = { exports: {} as { default: (props: {children: React.ReactNode}) => React.ReactNode } };
  new Function('require', 'module', 'exports', 'fetch', compiled)((name: string) => {
    if (name === 'react') return hooks;
    if (name === '@/components/use-live-refresh') return {useLiveRefresh() {},dispatchLiveRefresh() {}};
    if (name === 'react/jsx-runtime') return runtime;
    if (name === '@/components/trip-language-preferences') return {useTripLanguagePreferences:()=>({preferences:{readingLanguage:'en',primaryVersion:'reading',itemVersions:{}},ready:true,busy:false,error:'',save:async()=>true}),PersonalLanguageSettings:component};
    if (name === '@/lib/model') return models;
    if (name === '@/lib/dates') return dates;
    if (name === '@/lib/client-ledger') return clientLedger;
    if (name === '@/lib/money-format') return moneyFormat;
    if (name === '@/lib/receipt-processing') return receiptProcessing;
    if (name === '@/lib/receipt-scan') return receiptScan;
    if (name === '@/lib/expense-fx-review') return expenseFxReview;
    if (name === '@/lib/expense-readiness') return expenseReadiness;
    if (name === '@/lib/quick-expense') return quickExpense;
    if (name === '@/lib/data-utils') return dataUtils;
    if (name === '@/lib/receipt-languages') return receiptLanguages;
    if (name === '@/components/receipt-scan-review') return {__esModule: true, default: component, receiptMoney: (amount: number, currency: string | null) => currency ? moneyFormat.formatMoney(amount, currency) : String(amount / 100)};
    if (name === '@/lib/receipt-chatgpt') return receiptChatgpt;
    if (name === '@/components/trip-routing') return {
      TripTabRouteProvider: component, TripTabNavigation: component, TripTabLink: component,
      useTripTabEntryQuery: () => '',
      useTripTabNavigation: () => ({ view: state.view, navigate: (next: string) => {state.view = next;}, replaceEntryUrl() {} }),
    };
    if (name === '@/components/modal-accessibility') return { __esModule: true, default: component, useModalLayer() {} };
    if (name === '@/components/paged-list') return { __esModule: true, default: component, useListPaging: () => (_key: string, step: number) => ({ shown: step, onMore() {} }) };
    if (name === '@/components/editor-footer-reveal') return { useStickyFooterReveal: () => () => {} };
    if (name === '@/components/confirmation-dialog') return { useConfirmation: () => ({ confirm: async () => true, dialog: null, confirming: false }) };
    if (name === 'lucide-react') return new Proxy({}, { get: () => component });
    return { __esModule: true, default: component, PwaUpdates: component };
  }, exported, exported.exports, fetcher || fetch);
  return { calls, state,
    render() {
      stateIndex = 0; refIndex = 0; memoIndex = 0;
      const shell = elements(exported.exports.default({children: null}));
      const provider = shell.find(element => typeof element.props.renderSection === 'function');
      assert(provider, 'the persistent shell supplies the active route body');
      const body = elements((provider.props.renderSection as (view: unknown) => React.ReactNode)(state.view));
      for (const effect of layoutEffects.splice(0)) effect();
      for (const effect of navigationEffects.splice(0)) effect();
      return [...shell, ...body];
    },
    resetCounts() { for (const name of Object.keys(calls) as (keyof typeof calls)[]) calls[name] = 0; },
  };
}
test('opening and typing in a receipt does not recalculate all saved holiday balances', () => {
  const holiday = fixture();
  const editor = controller(holiday);
  const before = structuredClone(holiday);
  const initial = editor.render();
  assert.equal(editor.calls.balances, 1);
  assert.equal(editor.calls.settlements, 1);
  assert.equal(editor.calls.expenseShares, holiday.expenses.length, 'each saved row needs one cost-share preview');
  const button = initial.find(element => element.type === 'button' && element.props.className === 'expense-open');
  assert(button && typeof button.props.onClick === 'function');
  button.props.onClick();
  editor.resetCounts();
  editor.render();
  assert.equal(editor.calls.balances, 0);
  assert.equal(editor.calls.settlements, 0);
  assert.equal(editor.calls.expenseShares, 1, 'one editor preview covers every traveller');
  editor.state.editing = { ...(editor.state.editing as model.Expense), title: 'Corrected receipt title' };
  editor.resetCounts();
  const typing = editor.render();
  assert.equal(editor.calls.balances, 0);
  assert.equal(editor.calls.settlements, 0);
  assert.equal(editor.calls.expenseShares, 1);
  assert(typing.some(element => element.props.value === 'Corrected receipt title'));
  assert.deepEqual(holiday, before, 'preview rendering must not modify saved data');
});

test('a saved expense update invalidates previews and reflects current financial amounts', () => {
  const holiday = fixture(2), editor = controller(holiday);
  editor.render();
  const changed = { ...holiday, expenses: holiday.expenses.map((expense, index) => index ? expense : { ...expense, items: [{ ...expense.items[0], amount: 9999 }] }) };
  editor.state.ledger = { trips: [changed] };
  editor.resetCounts();
  const rendered = editor.render();
  assert.equal(editor.calls.balances, 1);
  assert.equal(editor.calls.settlements, 1);
  assert.equal(editor.calls.expenseShares, changed.expenses.length);
  const expected = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(model.expenseTotal(changed.expenses[0], 'GBP') / 100);
  assert(rendered.some(element => element.type === 'b' && element.props.children === expected));
});

test('invalid saved and edited receipts keep their review warnings rather than stale cached values', () => {
  const holiday = fixture(1), editor = controller(holiday);
  editor.render();
  const invalid = { ...holiday.expenses[0], currency: 'EUR' as const, fx: undefined };
  editor.state.ledger = { trips: [{ ...holiday, expenses: [invalid] }] };
  editor.state.editing = invalid;
  const rendered = editor.render();
  assert(rendered.some(element => element.props.children === 'Needs review'));
  assert(rendered.some(element => element.props.children === 'Unavailable'));
  assert(rendered.some(element => element.type === 'b' && element.props.children === '—'));
});

test('the Balances route renders immediately while its background ledger request is held', async () => {
  const holiday = fixture(1);
  let finish!: (response: Response) => void;
  const editor = controller(holiday, () => new Promise(resolve => {finish = resolve;}));
  editor.render();
  editor.state.view = 'balances';
  const displayed = editor.render();
  assert.equal(editor.state.view, 'balances', 'panel selection must not wait for the network');
  assert.equal(editor.state.loading, false, 'background refresh keeps the saved panel usable');
  assert(displayed.some(element => element.type === 'h2' && element.props.children === 'Settle up'));
  await Promise.resolve();
  finish(Response.json({data: {trips: [holiday]}, revision: 1}, {headers: {ETag: '"fresh"'}}));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(editor.state.revision, 1);
});

test('the holiday and receipt editor remain usable without Intl.supportedValuesOf', () => {
  const descriptor = Object.getOwnPropertyDescriptor(Intl, 'supportedValuesOf');
  Object.defineProperty(Intl, 'supportedValuesOf', {value: undefined, configurable: true});
  try {
    const holiday = fixture(1);
    holiday.expenses[0].timezone = 'America/Los_Angeles';
    const editor = controller(holiday);
    const initial = editor.render();
    assert(initial.some(element => element.props.children === 'Dinner 0'), 'the initial holiday screen renders');
    const expense = initial.find(element => element.type === 'button' && element.props.className === 'expense-open');
    assert(expense && typeof expense.props.onClick === 'function');
    expense.props.onClick();
    const opened = editor.render();
    const selector = opened.find(element => element.type === 'select' && element.props.value === 'America/Los_Angeles');
    assert(selector, 'the saved transaction time zone remains selected');
    const options = elements(selector.props.children).filter(element => element.type === 'option').map(element => element.props.value);
    for (const zone of ['America/Los_Angeles', 'Europe/London', 'Europe/Paris', 'Europe/Prague', 'UTC']) {
      assert(options.includes(zone), `${zone} remains available without native time zone enumeration`);
    }
    assert.equal(new Set(options).size, options.length);
  } finally {
    if (descriptor) Object.defineProperty(Intl, 'supportedValuesOf', descriptor);
    else Reflect.deleteProperty(Intl, 'supportedValuesOf');
  }
});

const discussionSource = await readFile(new URL('../components/item-receipt-conversation.tsx', import.meta.url), 'utf8');
const discussionCompiled = transpileModule(discussionSource, {compilerOptions: {module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.ReactJSX}}).outputText;
test('closed item discussions render no chats, and visited chats remain mounted after collapsing', () => {
  let visited = false;
  const chat = (props: unknown) => props;
  const exported = {exports: {} as {default: (props: Record<string, unknown>) => Element}};
  new Function('require', 'module', 'exports', discussionCompiled)((name: string) => {
    if (name === 'react') return {...React, useState: () => [visited, (next: boolean) => {visited = next;} ]};
    if (name === 'react/jsx-runtime') return runtime;
    return {__esModule: true, default: chat};
  }, exported, exported.exports);
  const props = {itemId: 'dinner', scopeLabel: 'Dinner', messages: [], busy: false, onSend: async () => true, onRefresh() {}};
  let discussion = exported.exports.default(props);
  assert.equal(elements(discussion).filter(element => element.type === chat).length, 0);
  assert(typeof discussion.props.onToggle === 'function');
  discussion.props.onToggle({currentTarget: {open: true}});
  discussion = exported.exports.default(props);
  const mounted = elements(discussion).find(element => element.type === chat);
  assert(mounted);
  assert.equal(mounted.props.itemId, props.itemId);
  assert.equal(mounted.props.contextTitle, 'Discuss Dinner');
  assert(typeof discussion.props.onToggle === 'function');
  discussion.props.onToggle({currentTarget: {open: false}});
  assert.equal(elements(exported.exports.default(props)).filter(element => element.type === chat).length, 1, 'collapse must not discard an unsent question');
});

test('the real Save button disables only while posting and every other state uses the shared blockers', () => {
  const holiday = fixture(1), editor = controller(holiday);
  const initial = editor.render();
  const open = initial.find(element => element.type === 'button' && element.props.className === 'expense-open');
  assert(open && typeof open.props.onClick === 'function'); open.props.onClick();
  const entry = editor.state.editing as receiptProcessing.ReceiptEditor;
  for (let flags = 0; flags < 64; flags++) {
    const state = { uploading: !!(flags & 1), processing: !!(flags & 2), conflict: !!(flags & 4), offline: !!(flags & 8), fxLookupPending: !!(flags & 16) };
    Object.assign(editor.state, { uploading: state.uploading, receiptProcessing: state.processing, editorConflict: state.conflict ? { latest: holiday.expenses[0] } : null, offline: state.offline, fxLoading: state.fxLookupPending, saving: !!(flags & 32) });
    const rendered = editor.render();
    const button = rendered.find(element => element.type === 'button' && ['Save expense','Saving…'].includes(String(element.props.children)));
    assert(button); assert.equal(button.props.disabled, !!(flags & 32), JSON.stringify(state));
    const checklist = rendered.find(element => Array.isArray(element.props.blockers)); assert(checklist);
    assert.deepEqual(checklist.props.blockers, expenseReadiness.expenseSaveBlockers(entry,holiday,state));
  }
});
