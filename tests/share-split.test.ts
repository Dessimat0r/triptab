import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import * as React from 'react';
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import * as model from '../lib/model';
import type { Item, Trip } from '../lib/model';

// Run the production component's mode-button handlers with its actual financial
// helpers. Only React's state boundary and the parent item update are replaced.
const source = await readFile(new URL('../components/share-split.tsx', import.meta.url), 'utf8');
const compiled = transpileModule(source, { compilerOptions: {
  module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.ReactJSX,
} }).outputText.replace('require("./share-split-units.css");', '');
const nodeRequire = createRequire(import.meta.url);
type Quantity = { total: number; label?: string; sourceText?: string };
type TestItem = Item & { quantity?: Quantity };
type Element = React.ReactElement<Record<string, unknown>>;
type Change = { selected: string[]; percentages?: Record<string, number>; units?: Item['units'] };
const members: Trip['members'] = [
  { id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }, { id: 'chris', name: 'Chris' },
];

function elements(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as React.ReactNode)];
}

function controller(initial: TestItem) {
  const values: unknown[] = [], changes: Change[] = [];
  let index = 0, item = { ...initial };
  const hooks = {
    useId: () => 'share-split-test',
    useEffect: () => {},
    useState(initialValue: unknown) {
      const slot = index++;
      if (!(slot in values)) values[slot] = typeof initialValue === 'function' ? initialValue() : initialValue;
      return [values[slot], (next: unknown) => { values[slot] = typeof next === 'function' ? next(values[slot]) : next; }];
    },
  };
  type Props = {
    members: Trip['members']; selected: string[]; percentages?: Record<string, number>;
    units?: Item['units']; quantity?: Quantity; scope: string;
    onChange: (selected: string[], percentages?: Record<string, number>, units?: Item['units']) => void;
  };
  const loaded = { exports: {} as { default: (props: Props) => React.ReactNode } };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (name === 'react') return hooks;
    if (name === '@/lib/model') return model;
    if (name === 'lucide-react') return { Check: () => React.createElement('svg') };
    return nodeRequire(name);
  }, loaded, loaded.exports);
  return {
    get item() { return item; },
    get changes() { return changes; },
    click(label: string) {
      index = 0;
      const tree = loaded.exports.default({
        members, selected: item.members, percentages: item.percentages,
        units: item.units, quantity: item.quantity, scope: 'item Pizza slices',
        onChange(selected, percentages, units) {
          changes.push({ selected, percentages, units });
          item = { ...item, members: selected, percentages, units };
        },
      });
      const button = elements(tree).find(element => element.type === 'button' && element.props.children === label);
      assert(button, `The production component exposes the ${label} mode button`);
      (button.props.onClick as () => void)();
    },
  };
}

function pizza(overrides: Partial<TestItem> = {}): TestItem {
  return { id: 'pizza', name: 'Pizza slices', amount: 1390, members: ['alice', 'bob'], ...overrides };
}

test('Units uses the detected two slices and divides the full printed line price', () => {
  const quantity = Object.freeze({ total: 2, label: 'slices', sourceText: '2 x Stck' });
  const ui = controller(pizza({ quantity }));
  ui.click('Units');
  assert.deepEqual(ui.item.units, { total: 2, allocations: { alice: 1, bob: 1 }, label: 'slices' });
  assert.equal(ui.item.amount, 1390, 'purchase quantity must never multiply the item line price');
  assert.equal(ui.item.quantity, quantity, 'the original printed quantity remains separate from allocations');
  assert.equal(model.itemSplitError(ui.item), null);
});

test('manual items without a detected quantity retain the one-unit default', () => {
  const ui = controller(pizza());
  ui.click('Units');
  assert.deepEqual(ui.item.units, { total: 1, allocations: { alice: 0.5, bob: 0.5 } });
  assert.equal(ui.item.quantity, undefined);
  assert.equal(model.itemSplitError(ui.item), null);
});

test('a detected count without a known label initializes units without inventing a name', () => {
  const ui = controller(pizza({ quantity: { total: 2, sourceText: '2 x' } }));
  ui.click('Units');
  assert.deepEqual(ui.item.units, { total: 2, allocations: { alice: 1, bob: 1 } });
});

test('detected quantity is allocated only to the currently selected travellers', () => {
  const ui = controller(pizza({ members: ['alice', 'chris'], quantity: { total: 2, label: 'slices' } }));
  ui.click('Units');
  assert.deepEqual(ui.item.members, ['alice', 'chris']);
  assert.deepEqual(ui.item.units, { total: 2, allocations: { alice: 1, chris: 1 }, label: 'slices' });
  assert.equal(model.itemSplitError(ui.item), null);
});

test('choosing Units preserves existing traveller allocations and their edited unit label', () => {
  const units = { total: 4, allocations: { alice: 0.75, bob: 3.25 }, label: 'pieces' };
  const quantity = Object.freeze({ total: 2, label: 'slices', sourceText: '2 x Stck' });
  const ui = controller(pizza({ quantity, units }));
  ui.click('Units');
  assert.equal(ui.item.units, units, 'reselecting the mode must retain the original allocation map');
  assert.equal(ui.item.quantity, quantity);
  assert.equal(model.itemSplitError(ui.item), null);
});

test('equal and custom percentage modes clear allocations but preserve detected receipt quantity', () => {
  for (const mode of ['Equal', 'Custom percentages']) {
    const quantity = Object.freeze({ total: 2, label: 'slices', sourceText: '2 x Stck' });
    const ui = controller(pizza({ quantity, units: { total: 2, allocations: { alice: 1, bob: 1 }, label: 'slices' } }));
    ui.click(mode);
    assert.equal(ui.item.units, undefined);
    assert.equal(ui.item.quantity, quantity, `${mode} must not erase printed quantity evidence`);
    assert.deepEqual(ui.item.percentages, mode === 'Equal' ? undefined : { alice: 50, bob: 50 });
    ui.click('Units');
    assert.deepEqual(ui.item.units, { total: 2, allocations: { alice: 1, bob: 1 }, label: 'slices' }, 'returning to Units uses the saved printed quantity');
    assert.equal(ui.item.quantity, quantity);
  }
});

test('detected units allocate the exact millionth remainder across three travellers', () => {
  const ui = controller(pizza({ members: ['alice', 'bob', 'chris'], quantity: { total: 2, label: 'slices' } }));
  ui.click('Units');
  assert.deepEqual(ui.item.units, {
    total: 2, allocations: { alice: 0.666667, bob: 0.666667, chris: 0.666666 }, label: 'slices',
  });
  const scaled = Object.values(ui.item.units!.allocations).map(value => model.unitsScale(value));
  assert(scaled.every(value => value !== null));
  assert.equal(scaled.reduce<number>((sum, value) => sum + value!, 0), 2 * model.UNIT_SCALE);
  assert.equal(model.itemSplitError(ui.item), null);
});
