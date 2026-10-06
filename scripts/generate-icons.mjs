// Regenerates the TripTab app icons: `node scripts/generate-icons.mjs`
// Renders with the Playwright Chromium already used by `npm run test:layout`.
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const root = new URL('../public/', import.meta.url).pathname;
const out = `${root}icons`;
const P = '#4355db', TINT = '#cdd3f7', ACCENT = '#ffb547';

// Luggage tag ("trip" + "tab") whose bottom row is a bill split in two.
const glyph = (detail = true) => `
  <g transform="rotate(-14 256 262)">
    <path d="M256 180 C256 116 336 84 382 112" fill="none" stroke="${ACCENT}" stroke-width="13" stroke-linecap="round"/>
    <mask id="hole"><rect width="512" height="512" fill="#fff"/><circle cx="256" cy="180" r="18" fill="#000"/></mask>
    <path mask="url(#hole)" d="M166 204 L214 132 L298 132 L346 204 L346 380 Q346 400 326 400 L186 400 Q166 400 166 380 Z"
      fill="#fff" stroke="#fff" stroke-width="20" stroke-linejoin="round"/>
    ${detail ? `
    <rect x="198" y="232" width="116" height="17" rx="8.5" fill="${TINT}"/>
    <rect x="198" y="266" width="78" height="17" rx="8.5" fill="${TINT}"/>
    <line x1="202" y1="310" x2="312" y2="310" stroke="${TINT}" stroke-width="6" stroke-linecap="round" stroke-dasharray="1 14"/>` : ''}
    <rect x="198" y="${detail ? 330 : 282}" width="54" height="${detail ? 34 : 64}" rx="${detail ? 17 : 14}" fill="${P}"/>
    <rect x="260" y="${detail ? 330 : 282}" width="54" height="${detail ? 34 : 64}" rx="${detail ? 17 : 14}" fill="${ACCENT}"/>
  </g>`;

const defs = `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
  <stop offset="0" stop-color="#5568ee"/><stop offset="1" stop-color="#3342c4"/></linearGradient></defs>`;

const svg = ({ rx = 0, scale = 1, detail = true }) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${defs}
  <rect width="512" height="512" rx="${rx}" fill="url(#bg)"/>
  <g transform="translate(256 256) scale(${scale}) translate(-265 -242)">${glyph(detail)}</g>
</svg>`;

const variants = {
  'icon.svg': svg({ rx: 112, scale: 1 }),            // purpose "any": rounded, transparent corners
  'maskable.svg': svg({ scale: 0.88 }),               // full bleed, glyph inside 80% safe zone
  'apple-touch.svg': svg({ scale: 0.94 }),           // iOS masks it itself; must be opaque
};
writeFileSync(`${root}favicon.svg`, svg({ rx: 112, scale: 1.08, detail: false }).replace(/\n\s*/g, ' ') + '\n'); // fewer details for 16–32px
for (const [name, s] of Object.entries(variants)) writeFileSync(`${out}/${name}`, s.replace(/\n\s*/g, ' ') + '\n');

const renders = [
  ['icon.svg', 'icon-192.png', 192], ['icon.svg', 'icon-512.png', 512],
  ['maskable.svg', 'maskable-192.png', 192], ['maskable.svg', 'maskable-512.png', 512],
  ['apple-touch.svg', 'apple-touch-icon.png', 180],
];
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [src, dst, size] of renders) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}img{display:block;width:${size}px;height:${size}px}</style><img src="data:image/svg+xml;base64,${Buffer.from(variants[src]).toString('base64')}">`);
  await page.waitForFunction(() => document.images[0].complete);
  await page.screenshot({ path: `${out}/${dst}`, omitBackground: true });
}
await browser.close();
