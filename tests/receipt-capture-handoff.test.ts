import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReceiptCapture, { type ReceiptCaptureProps } from '../components/receipt-capture';
import { chatgptReceiptUrl } from '../lib/receipt-chatgpt';

const request = 'Read the stored receipt “Dinner & drinks”. Keep existing shares and ask about unclear prices.';
const chatgptUrl = 'https://chatgpt.com/?q=' + encodeURIComponent(request);
const props: ReceiptCaptureProps = {
  receiptId: 'receipt-image', busy: false, stored: true, copied: false,
  connected: true, prompt: request, chatgptUrl,
  aiProvider: 'siwc', aiEligible: true, aiSiwcAvailable: true,
  onCapture() {}, onPrepare() {}, onRefresh() {}, onUseProcessed() {},
  onOpenChatGPT() {}, onConnectChatGPT() {},
};
// A stored receipt shows its status and next step with the receipt's totals,
// and its photo tools and ChatGPT handoff under Receipt tools: render both.
function render(overrides: Partial<ReceiptCaptureProps> = {}) {
  return renderToStaticMarkup(createElement(ReceiptCapture, { ...props, ...overrides, part: 'status' }))
    + renderToStaticMarkup(createElement(ReceiptCapture, { ...props, ...overrides, part: 'tools' }));
}
function visibleText(html: string) { return html.replace(/<[^>]*>/g, ' '); }

test('the saved receipt offers a native ChatGPT link and an immediately accessible exact request fallback', () => {
  const html = render();
  assert.match(html, new RegExp(`href="${chatgptUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" target="_blank" rel="noopener noreferrer"`));
  assert.match(html, />Open ChatGPT<|> Open ChatGPT</);
  assert.match(html, /<details[^>]* open=""/);
  assert.match(html, /<textarea[^>]*aria-label="Receipt assistant prompt"[^>]*readOnly=""/i);
  assert.match(html, /Read the stored receipt “Dinner &amp; drinks”\. Keep existing shares and ask about unclear prices\./);
  assert.match(visibleText(html), /open[s]? without the request.*copy this text.*send it with TripTab enabled/i);
  assert.match(visibleText(html), /enter items yourself/);
});

test('long and non-ASCII handoff requests open a bounded URL and retain the full copyable prompt', () => {
  for (const prompt of ['x'.repeat(2500), '🍕'.repeat(180)]) {
    const url = chatgptReceiptUrl(prompt);
    assert.equal(url, 'https://chatgpt.com/');
    const html = render({ prompt, chatgptUrl: url });
    assert.match(html, /href="https:\/\/chatgpt\.com\/"/);
    assert.match(visibleText(html), /too long to prefill reliably.*Copy the complete text below.*paste and send it/);
    assert(html.includes(prompt), 'copyable prompt is never truncated');
  }
  const short = new URL(chatgptReceiptUrl(request));
  assert.equal(short.searchParams.get('q'), request);
  assert(short.toString().length <= 2000);
});

test('opening or copying a request does not claim ChatGPT received or processed the receipt', () => {
  const text = visibleText(render({ handoffOpened: true, copied: true }));
  assert.match(text, /TripTab cannot verify tools in an external conversation/);
  assert.match(text, /no external processing is confirmed until a proposal arrives/);
  assert.match(text, /Receipt request copied\. Paste and send it/);
  assert.doesNotMatch(text, /Processing your receipt|Request sent|ChatGPT is processing|Items are ready/i);
});

test('a linked, saved and available receipt is required before offering the ChatGPT handoff', () => {
  for (const state of [
    { connected: false }, { stored: false }, { busy: true }, { prompt: undefined }, { chatgptUrl: undefined },
  ]) {
    const html = render(state);
    assert.doesNotMatch(html, /<a[^>]*href="https:\/\/chatgpt\.com\//);
  }
  const unlinked = visibleText(render({ connected: false }));
  assert.match(unlinked, /Link ChatGPT identity/);
  assert.match(unlinked, /enter items manually at any time/);
});

test('a ready proposal offers review and explains that saving applies the reviewed items', () => {
  const html = render({ ready: true });
  assert.match(visibleText(html), /Review processed receipt/);
  assert.match(visibleText(html), /Saving the expense applies your reviewed items/);
  assert.doesNotMatch(html, /<a[^>]*href="https:\/\/chatgpt\.com\//);
  // The photo itself is shown once, with the receipt's totals, not repeated here.
  assert.doesNotMatch(html, /href="\/api\/receipt\?id=receipt-image"/);
});

test('manual receipt questions keep their ChatGPT handoff even without an image', () => {
  const html = render({ receiptId: undefined });
  assert.match(html, /<a[^>]*href="https:\/\/chatgpt\.com\//);
  assert.match(visibleText(html), /Receipt details saved for ChatGPT/);
  assert.match(visibleText(html), /help with these receipt details/);
  assert.doesNotMatch(visibleText(html), /transcribe the image into items|Receipt image stored with this receipt/);
});

test('handoff errors leave the stored photo and readable request available', () => {
  const html = render({ assistantError: 'Clipboard unavailable. Select the request below and copy it.' });
  assert.match(html, /role="alert">Clipboard unavailable/);
  assert.match(html, /<details[^>]* open=""/);
  assert.match(html, /aria-label="Receipt assistant prompt"/);
  assert.match(visibleText(html), /Replace the photo/, 'the stored photo stays attached and replaceable');
});

test('receipt proposals update automatically and show a retry only after refresh failure', () => {
  assert.match(visibleText(render()), /Processed items and replies appear automatically/);
  assert.doesNotMatch(visibleText(render()), /Check for processed items|Retry updates/);
  assert.match(visibleText(render({ refreshError: 'Network failure' })), /Retry updates/);
  const offline = visibleText(render({ refreshError: 'Network failure', offline: true }));
  assert.match(offline, /Receipt updates resume when you reconnect/);
  assert.doesNotMatch(offline, /Retry updates/);
});

test('linking the ChatGPT tool account does not grant automatic plan processing', () => {
  const html = render({ aiConfigured: true, aiConnected: false, onProcess() {}, onConnectPlan() {} });
  assert.match(visibleText(html), /Connect ChatGPT plan/);
  assert.doesNotMatch(visibleText(html), /Read receipt with ChatGPT|Reading receipt with ChatGPT/);
  assert.match(html, /<a class="quiet" href="https:\/\/chatgpt\.com\//);
});

test('a real ChatGPT plan grant offers receipt reading independently of the tool account link', () => {
  const html = render({ aiConfigured: true, aiConnected: true, connected: false, onProcess() {}, onConnectPlan() {} });
  assert.match(visibleText(html), /Read receipt with ChatGPT/);
  assert.match(visibleText(html), /Your ChatGPT plan is connected/);
  assert.doesNotMatch(visibleText(html), /Connect ChatGPT plan|Reading receipt with ChatGPT/);
});

test('the reading status appears only while a real processing request is pending', () => {
  const settings = { aiConfigured: true, aiConnected: true, onProcess() {} };
  assert.doesNotMatch(visibleText(render(settings)), /Reading receipt with ChatGPT/);
  const html = render({ ...settings, processing: true });
  assert.match(visibleText(html), /Reading receipt with ChatGPT…/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /<button type="button" class="primary" disabled=""/);
  assert.doesNotMatch(html, /<a[^>]*href="https:\/\/chatgpt\.com\//);
});

test('failed automatic reading offers a retry while retaining manual and linked ChatGPT options', () => {
  const html = render({ aiConfigured: true, aiConnected: true, onProcess() {}, assistantError: 'ChatGPT could not read this photo. Try a clearer image.' });
  assert.match(html, /role="alert">ChatGPT could not read this photo/);
  assert.match(visibleText(html), /Retry reading receipt/);
  assert.match(visibleText(html), /Your image is saved/);
  assert.match(html, /<a class="quiet" href="https:\/\/chatgpt\.com\//);
  assert.match(html, /aria-label="Receipt assistant prompt"/);
});

test('an unavailable site client offers an explicit fallback without an enabled plan connection or processing button', () => {
  const html = render({ aiConfigured: false, aiConnected: true, onProcess() {}, onConnectPlan() {} });
  assert.match(visibleText(html), /Automatic receipt reading is not available for this site yet/);
  assert.doesNotMatch(visibleText(html), /Connect ChatGPT plan|Read receipt with ChatGPT|Reading receipt with ChatGPT/);
  assert.match(html, /<a[^>]*href="https:\/\/chatgpt\.com\//);
});

test('filled receipt details leave checking to the receipt summary rather than starting transcription again', () => {
  const status = renderToStaticMarkup(createElement(ReceiptCapture, { ...props, aiConfigured: true, aiConnected: true, itemized: true, handoffOpened: true, onProcess() {}, onConnectPlan() {}, part: 'status' }));
  const html = render({ aiConfigured: true, aiConnected: true, itemized: true, handoffOpened: true, onProcess() {}, onConnectPlan() {} });
  // The receipt's own summary (totals, warnings, then the lines) is the next step.
  assert.doesNotMatch(visibleText(status), /\w/, 'no second status competes with the receipt summary');
  assert.doesNotMatch(visibleText(html), /Read receipt with ChatGPT|Reading receipt with ChatGPT|Connect ChatGPT plan|Return here after it saves/);
  assert.doesNotMatch(html, /<a[^>]*href="https:\/\/chatgpt\.com\//);
});

test('a new incoming proposal still requires review after earlier details were filled', () => {
  const html = render({ ready: true, itemized: true });
  assert.match(visibleText(html), /Review processed receipt/);
  assert.doesNotMatch(visibleText(html), /Receipt details received/);
});

test('before any photo, notes come before the two capture actions and one privacy line follows', () => {
  const html = renderToStaticMarkup(createElement(ReceiptCapture, { ...props, receiptId: undefined, prompt: undefined, part: 'compact',
    contextFields: createElement('textarea', { 'aria-label': 'Who bought what?' }) }));
  const text = visibleText(html);
  assert.match(text, /Have the receipt\?/);
  assert(html.indexOf('Who bought what?') < html.indexOf('Scan receipt'), 'optional notes are offered before a photo starts uploading');
  assert(html.indexOf('Scan receipt') < html.indexOf('Choose image'));
  assert.match(text, /camera metadata is removed/);
  assert.doesNotMatch(text, /ChatGPT/, 'the handoff belongs to a stored receipt, not to an empty form');
});

test('Receipt tools let a stored photo be replaced or removed without showing it again', () => {
  const html = renderToStaticMarkup(createElement(ReceiptCapture, { ...props, onRemove() {}, part: 'tools' }));
  assert.match(visibleText(html), /Replace the photo/);
  assert.match(visibleText(html), /Remove receipt image/);
  assert.doesNotMatch(html, /<img/);
});

test('an eligible owner can open API setup before a key is connected', () => {
  const html = render({ aiProvider: 'api', aiEligible: true, aiManageable: true, aiConfigured: false, aiConnected: false, onConnectPlan() {} });
  assert.match(visibleText(html), /Set up receipt AI/);
  assert.doesNotMatch(visibleText(html), /Connect ChatGPT plan|Read receipt with AI/);
});

test('the shared API key uses the AI reading state for every signed-in participant', () => {
  const settings = { aiProvider: 'api' as const, aiConfigured: true, aiConnected: true, onProcess() {} };
  assert.match(visibleText(render({ ...settings, aiEligible: true })), /Read receipt with AI/);
  assert.match(visibleText(render({ ...settings, aiEligible: true, processing: true })), /Reading receipt with AI…/);
  const restricted = visibleText(render({ ...settings, aiEligible: false }));
  assert.doesNotMatch(restricted, /Read receipt with AI|Set up receipt AI/);
  assert.match(restricted, /Sign in to use TripTab(?:&#x27;|')s shared receipt AI/);
});

test('the disabled ChatGPT plan option cannot start model processing or OAuth', () => {
  const html = render({ aiProvider: 'siwc', aiConfigured: true, aiConnected: true, aiSiwcAvailable: false, onProcess() {}, onConnectPlan() {} });
  assert.match(visibleText(html), /ChatGPT plan processing is switched off/);
  assert.doesNotMatch(visibleText(html), /Read receipt with ChatGPT|Connect ChatGPT plan/);
});

test('an owner needing verification can start shared setup when receipt processing is unavailable', () => {
  const html = render({ aiProvider: 'api', aiConfigured: true, aiEligible: true, aiManageable: false, aiConnected: false, aiManagementReason: 'verification_required', onProcess() {}, onConnectPlan() {} });
  assert.match(visibleText(html), /Verify receipt AI setup/);
  assert.match(visibleText(html), /Verify your account with ChatGPT/);
  assert.doesNotMatch(visibleText(html), /Read receipt with AI|Set up receipt AI/);
});

test('a regular participant can read with shared AI without linking ChatGPT or managing the key', () => {
  const html = render({ aiProvider: 'api', aiConfigured: true, aiConnected: true, aiEligible: true, aiManageable: false, connected: false, onProcess() {}, onConnectPlan() {} });
  assert.match(visibleText(html), /Read receipt with AI/);
  assert.match(visibleText(html), /Receipt AI is provided by TripTab/);
  assert.doesNotMatch(visibleText(html), /Set up receipt AI|Verify receipt AI setup|Connect ChatGPT plan/);
});

test('shared service management verification never blocks available model processing', () => {
  const html = render({ aiProvider: 'api', aiConfigured: true, aiConnected: true, aiEligible: true, aiManageable: false, aiManagementReason: 'verification_required', onProcess() {}, onConnectPlan() {} });
  assert.match(visibleText(html), /Read receipt with AI/);
  assert.doesNotMatch(visibleText(html), /Verify receipt AI setup|Verify your account with ChatGPT/);
});

test('participants without a configured shared key receive a fallback without key setup prompts', () => {
  const html = render({ aiProvider: 'api', aiConfigured: true, aiConnected: false, aiEligible: true, aiManageable: false, aiReason: 'not_connected', onProcess() {}, onConnectPlan() {} });
  assert.match(visibleText(html), /shared receipt AI is not connected yet/);
  assert.doesNotMatch(visibleText(html), /Set up receipt AI|Read receipt with AI|Verify receipt AI setup/);
});

test('direct receipt AI stays primary while external connected tools are a compact optional fallback', () => {
  const html=render({connected:true,aiProvider:'api',aiConfigured:true,aiConnected:true,onProcess(){}}),text=visibleText(html);
  assert.match(text,/Receipt AI is provided by TripTab/);
  assert.match(text,/Read receipt with AI/,'direct API readiness is independent of the external conversation');
  assert.match(html,/<details class="receipt-capture-tools">/);
  assert.match(text,/Connected ChatGPT tools/);assert.match(text,/send it.*TripTab enabled/);
  assert.doesNotMatch(text,/external tools are enabled|identity.*enables.*tools/i);
});
