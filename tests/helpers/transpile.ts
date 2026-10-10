import { createSourceFile, forEachChild, isCallExpression, isExportDeclaration, isImportDeclaration, isStringLiteral, ScriptTarget, SyntaxKind, transpileModule, type TranspileOptions } from 'typescript';

type SharedTranspileOptions = TranspileOptions & {
  /** Override a shared default before imports are resolved, including test mocks. */
  sharedImportOverrides?: Readonly<Record<string, string>>;
};

const sharedImports: Readonly<Record<string, string>> = {
  ...Object.fromEntries(['data-utils', 'receipt-ai-config', 'audit', 'receipt-languages', 'email', 'trip-lifecycle', 'ui-language'].flatMap(name => {
    const url = new URL(`../../lib/${name}.ts`, import.meta.url).href;
    return [[`./${name}`, url], [`@/lib/${name}`, url]];
  })),
  react: import.meta.resolve('react'),
  'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'),
};

/** Default shared modules for data-URL test harnesses; caller mocks still win. */
export function transpileWithSharedImports(input: string, options: SharedTranspileOptions): ReturnType<typeof transpileModule> {
  const { sharedImportOverrides, ...transpileOptions } = options;
  const result = transpileModule(input, transpileOptions);
  const imports = { ...sharedImports, ...sharedImportOverrides };
  const source = createSourceFile('transpiled-test.js', result.outputText, ScriptTarget.Latest, true);
  const replacements: { start: number; end: number; url: string }[] = [];
  const visit = (node: import('typescript').Node) => {
    const specifier = isImportDeclaration(node) || isExportDeclaration(node) ? node.moduleSpecifier
      : isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
    if (specifier && isStringLiteral(specifier) && Object.hasOwn(imports, specifier.text)) {
      replacements.push({ start: specifier.getStart(source), end: specifier.end, url: imports[specifier.text] });
    }
    forEachChild(node, visit);
  };
  visit(source);
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    result.outputText = result.outputText.slice(0, replacement.start) + JSON.stringify(replacement.url) + result.outputText.slice(replacement.end);
  }
  return result;
}
