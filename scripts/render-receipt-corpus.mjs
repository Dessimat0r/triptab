import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const directory = fileURLToPath(new URL('../tests/fixtures/receipts/v1/', import.meta.url));
const corpus = JSON.parse(await readFile(path.join(directory, 'corpus.json'), 'utf8'));
const rasterize = process.argv.includes('--png');
const sharp = rasterize ? (await import('sharp')).default : undefined;
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
await mkdir(path.join(directory, 'images'), { recursive: true });
for (const fixture of corpus.fixtures) {
  if (!/^[a-z0-9-]+$/.test(fixture.id) || fixture.image !== `images/${fixture.id}.png` || fixture.sourceImage !== `images/${fixture.id}.svg`) throw Error('Invalid fixture image path');
  const height = 150 + fixture.source.lines.length * 30;
  const lines = fixture.source.lines.map((line, index) => {
    const obscured = fixture.source.obscuredLineIndexes?.includes(index);
    return `<text x="25" y="${115 + index * 30}"${obscured ? ' filter="url(#obscured)"' : ''}>${escape(line)}</text>`;
  }).join('\n');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="${height}" viewBox="0 0 640 ${height}">
<title>${escape(fixture.description)}</title>
<defs><filter id="obscured"><feGaussianBlur stdDeviation="2.5"/></filter></defs>
<rect width="640" height="${height}" fill="#fff"/>
<g fill="#111" font-family="monospace" font-size="22">
<text x="25" y="35" font-size="16">${escape(fixture.source.merchant)}</text>
<text x="25" y="65" font-size="16">Corpus v${corpus.version}: ${escape(fixture.id)}</text>
${lines}
</g>
${fixture.source.cropped ? `<path d="M0 ${height - 12} H640" stroke="#666" stroke-width="12" stroke-dasharray="16 8"/>` : ''}
</svg>\n`;
  await writeFile(path.join(directory, fixture.sourceImage), svg);
  if (sharp) await sharp(Buffer.from(svg)).png().toFile(path.join(directory, fixture.image));
}
console.log(`Rendered ${corpus.fixtures.length} synthetic receipt SVGs${rasterize ? ' and uploadable PNGs' : ' (add --png to refresh uploadable PNGs)'}. No model or network calls.`);
