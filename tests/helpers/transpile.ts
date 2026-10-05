import { transpileModule } from 'typescript';

/** Default shared modules for data-URL test harnesses; caller mocks still win. */
export function transpileWithSharedImports(...args: Parameters<typeof transpileModule>): ReturnType<typeof transpileModule> {
  const result = transpileModule(...args);
  result.outputText = result.outputText
    .replace(/(['"])(?:\.\/|@\/lib\/)(data-utils|receipt-ai-config|audit)\1/g,
      (_, _quote: string, name: string) => JSON.stringify(new URL(`../../lib/${name}.ts`, import.meta.url).href))
    .replace(/\bfrom (['"])(react|react\/jsx-runtime)\1/g, (_, _quote: string, name: string) => `from ${JSON.stringify(import.meta.resolve(name))}`);
  return result;
}
