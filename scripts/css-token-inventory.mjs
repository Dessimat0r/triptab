import { readFileSync, writeFileSync } from 'node:fs';
import postcss from 'postcss';
const path = new URL('../app/globals.css', import.meta.url);
const root = postcss.parse(readFileSync(path, 'utf8'));
const spacing = new Map([['4px', '--space-1'], ['8px', '--space-2'], ['12px', '--space-3'], ['16px', '--space-4'], ['24px', '--space-5'], ['32px', '--space-6']]);
const type = new Map([['0.8rem', '--text-xs'], ['0.875rem', '--text-s'], ['1rem', '--text-m'], ['1.25rem', '--text-l'], ['1.5rem', '--text-xl']]);
const rows = [];
root.walkDecls(declaration => {
  if (declaration.prop.startsWith('--')) return;
  const selector = declaration.parent.type === 'rule' ? declaration.parent.selector : '';
  const context = [];
  for (let parent = declaration.parent.parent; parent; parent = parent.parent) if (parent.type === 'atrule') context.unshift(`@${parent.name} ${parent.params}`);
  for (const match of declaration.value.matchAll(/(?<![\w.-])-?\d*\.?\d+(?:px|rem)\b/g)) {
    const value = match[0];
    let token = null;
    if (/^(padding|margin|gap|column-gap|row-gap)/.test(declaration.prop)) token = spacing.get(value) ?? null;
    if (declaration.prop === 'font-size') token = type.get(value) ?? null;
    if (declaration.prop === 'border-radius') token = ({ '8px': '--radius-s', '12px': '--radius-m' })[value] ?? null;
    rows.push({ selector, context, property: declaration.prop, value, exactToken: token });
  }
});
// The committed docs/audit/layout-css-implementation-2026-10-09/token-inventory.md
// records globals.css before the migration. Write a new inventory only to a
// file named with --out, so a later run cannot overwrite that evidence.
const report = '# Raw CSS lengths in app/globals.css\n\nNo values are rounded. A dash means the value needs a separate design decision or is a dimension outside the spacing/type scale.\n\n| Selector | Context | Property | Value | Exact token |\n| --- | --- | --- | --- | --- |\n' + rows.map(row => `| ${row.selector.replaceAll('\n', ' ').replaceAll('|', '\\|')} | ${row.context.join('; ')} | ${row.property} | ${row.value} | ${row.exactToken ?? '—'} |`).join('\n') + '\n';
const out = process.argv.indexOf('--out');
if (out !== -1) {
  if (!process.argv[out + 1]) throw new Error('--out needs a file path');
  writeFileSync(process.argv[out + 1], report);
}
console.log(`${rows.length} raw lengths; ${rows.filter(row => row.exactToken).length} exact token matches. No values rounded.`);

if (process.argv.includes('--apply')) {
  root.walkDecls(declaration => {
    if (declaration.prop.startsWith('--')) return;
    declaration.value = declaration.value.replace(/(?<![\w.-])-?\d*\.?\d+(?:px|rem)\b/g, value => {
      let token = null;
      if (/^(padding|margin|gap|column-gap|row-gap)/.test(declaration.prop)) token = spacing.get(value);
      if (declaration.prop === 'font-size') token = type.get(value);
      if (declaration.prop === 'border-radius') token = ({ '8px': '--radius-s', '12px': '--radius-m' })[value];
      return token ? `var(${token})` : value;
    });
  });
  writeFileSync(path, root.toString());
}
