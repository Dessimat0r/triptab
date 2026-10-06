// Regenerates the TripTab app icons: `node scripts/generate-icons.mjs`
// Renders with the Playwright Chromium already used by `npm run test:layout`.
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const root = new URL('../public/', import.meta.url).pathname;
const out = `${root}icons`;
const ACCENT = '#ffb547';

// The TripTab "T" cut down the middle: your share in white, the others' in amber.
const glyph = () => `
  <path d="M146 120 L251 120 L251 376 Q251 392 235 392 L230 392 Q214 392 214 376 L214 204 L146 204 Q128 204 128 186 L128 138 Q128 120 146 120 Z" fill="#fff"/>
  <path d="M366 120 L261 120 L261 376 Q261 392 277 392 L282 392 Q298 392 298 376 L298 204 L366 204 Q384 204 384 186 L384 138 Q384 120 366 120 Z" fill="${ACCENT}"/>`;

const defs = `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
  <stop offset="0" stop-color="#5568ee"/><stop offset="1" stop-color="#3342c4"/></linearGradient></defs>`;

const svg = ({ rx = 0, scale = 1 }) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${defs}
  <rect width="512" height="512" rx="${rx}" fill="url(#bg)"/>
  <g transform="translate(256 256) scale(${scale}) translate(-256 -256)">${glyph()}</g>
</svg>`;

const variants = {
  'icon.svg': svg({ rx: 112, scale: 1 }),            // purpose "any": rounded, transparent corners
  'maskable.svg': svg({ scale: 0.86 }),               // full bleed, glyph inside 80% safe zone
  'apple-touch.svg': svg({ scale: 0.92 }),           // iOS masks it itself; must be opaque
};
writeFileSync(`${root}favicon.svg`, svg({ rx: 112, scale: 1.15 }).replace(/\n\s*/g, ' ') + '\n'); // larger glyph for 16–32px
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
