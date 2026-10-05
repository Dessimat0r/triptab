import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import type { ReceiptAIStatus } from '../components/receipt-ai-settings';

const source = await readFile(new URL('../components/receipt-ai-settings.tsx', import.meta.url), 'utf8');
const compiled = transpileModule(source, { compilerOptions: {
  module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.ReactJSX,
} }).outputText.replace('require("./receipt-ai-settings.css");', '');
const nodeRequire = createRequire(import.meta.url);
type Element = React.ReactElement<Record<string, unknown>>;
function elements(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as React.ReactNode)];
}
const state: ReceiptAIStatus = {
  configured: true, connected: false, eligible: true, manageable: true, apiConnected: false,
  provider: 'api', siwcAvailable: false, reason: 'not_connected', model: 'gpt-test',
};
const verificationHref = '/signin-with-chatgpt?return_to=%2F%3Fconnect%3Dchatgpt';
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); };

function controller(fetcher: (url: string, options?: RequestInit) => Promise<Response>) {
  const values: unknown[] = [], refs: { current: unknown }[] = [], effects: (() => void | (() => void))[] = [];
  const notifications: string[] = [], redirects: string[] = [];
  let index = 0, refIndex = 0, firstRender = true, cleanup: (() => void) | undefined;
  const hooks = {
    useId: () => 'receipt-ai-test',
    useCallback: (callback: unknown) => callback,
    useState(initial: unknown) {
      const slot = index++;
      if (!(slot in values)) values[slot] = initial;
      return [values[slot], (next: unknown) => { values[slot] = typeof next === 'function' ? next(values[slot]) : next; }];
    },
    useRef(initial: unknown) { const slot = refIndex++; return refs[slot] ||= { current: initial }; },
    useEffect(callback: () => void | (() => void)) { if (firstRender) effects.push(callback); },
  };
  const loaded = { exports: {} as { default: React.ComponentType<{ accountId: string; verificationHref: string }> } };
  new Function('require', 'module', 'exports', 'fetch', 'window', compiled)((name: string) => {
    if (name === 'react') return hooks;
    if (name === 'lucide-react') return { KeyRound: () => React.createElement('svg'), Trash2: () => React.createElement('svg') };
    return nodeRequire(name);
  }, loaded, loaded.exports, fetcher, {
    dispatchEvent(event: Event) { notifications.push(event.type); return true; },
    location: { assign(url: string) { redirects.push(url); } },
  });
  return {
    notifications, redirects,
    render() {
      index = 0; refIndex = 0;
      const tree = (loaded.exports.default as (props: { accountId: string; verificationHref: string }) => React.ReactNode)({ accountId: 'owner', verificationHref });
      for (const effect of effects.splice(0)) cleanup = effect() || undefined;
      firstRender = false;
      return { html: renderToStaticMarkup(tree), elements: elements(tree) };
    },
    unmount() { cleanup?.(); },
  };
}
function keyInput(rendered: ReturnType<ReturnType<typeof controller>['render']>) {
  const input = rendered.elements.find(element => element.type === 'input' && element.props.name === 'receipt-ai-api-key');
  assert(input, 'the eligible verified owner gets the API key field');
  return input;
}

test('an unverified claimed owner gets the existing ChatGPT verification link and cannot enter a key', async () => {
  const ui = controller(async () => Response.json({ ...state, manageable: false, managementReason: 'verification_required' }));
  ui.render(); await settle();
  const rendered = ui.render();
  assert.match(rendered.html, /Continue with ChatGPT to verify/);
  assert.match(rendered.html, /href="\/signin-with-chatgpt\?return_to=%2F%3Fconnect%3Dchatgpt"/);
  assert(!rendered.elements.some(element => element.type === 'input' || element.type === 'select'));
});

test('the verified owner sees a masked empty shared key field and a disabled subscription option', async () => {
  const ui = controller(async () => Response.json({ ...state, apiKey: 'server-must-never-return-this', accessToken: 'server-token' }));
  ui.render(); await settle();
  const rendered = ui.render(), input = keyInput(rendered);
  assert.equal(input.props.type, 'password');
  assert.equal(input.props.value, '');
  assert.equal(input.props.autoComplete, 'off');
  assert.doesNotMatch(rendered.html, /server-must-never-return-this|server-token/);
  const plan = rendered.elements.find(element => element.type === 'option' && element.props.value === 'siwc');
  assert.equal(plan?.props.disabled, true);
  assert.match(rendered.html, /billed to the OpenAI account.*separately from a ChatGPT subscription/);
  assert.match(rendered.html, /funds receipt processing for all signed-in users/);
});

test('submitting a key sends it only to the same-origin server and retains the masked field for a retry after failure', async () => {
  const calls: { url: string; options?: RequestInit }[] = [];
  let finish!: (response: Response) => void;
  const ui = controller(async (url, options) => {
    calls.push({ url, options });
    return options?.method === 'POST' ? new Promise(resolve => { finish = resolve; }) : Response.json(state);
  });
  ui.render(); await settle();
  let rendered = ui.render();
  (keyInput(rendered).props.onChange as (event: unknown) => void)({ target: { value: 'sk-test-ephemeral-key' } });
  rendered = ui.render();
  const form = rendered.elements.find(element => element.type === 'form');
  assert(form);
  (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
  const pending = ui.render();
  assert.equal(keyInput(pending).props.value, 'sk-test-ephemeral-key');
  assert.equal(keyInput(pending).props.disabled, true);
  const post = calls.find(call => call.options?.method === 'POST');
  assert.equal(post?.url, '/api/receipt/ai-settings');
  assert.equal(post?.options?.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(String(post?.options?.body)), { apiKey: 'sk-test-ephemeral-key' });
  finish(Response.json({ error: 'sk-test-ephemeral-key' }, { status: 500 }));
  await settle();
  rendered = ui.render();
  assert.doesNotMatch(rendered.html.replace('value="sk-test-ephemeral-key"', ''), /sk-test-ephemeral-key/);
  assert.match(rendered.html, /Receipt AI settings are temporarily unavailable/);
  assert.equal(keyInput(rendered).props.value, 'sk-test-ephemeral-key');
  assert.equal(keyInput(rendered).props.disabled, false);
});

test('removing a saved key refreshes settings and notifies the receipt editor without exposing credentials', async () => {
  let saved = true;
  const calls: { url: string; options?: RequestInit }[] = [];
  const ui = controller(async (url, options) => {
    calls.push({ url, options });
    if (options?.method === 'DELETE') { saved = false; return Response.json({ ok: true }); }
    return Response.json({ ...state, connected: saved, apiConnected: saved });
  });
  ui.render(); await settle();
  const remove = ui.render().elements.find(element => element.type === 'button' && elements(element.props.children as React.ReactNode).length === 1 && String(element.props.children).includes('Remove API key'));
  const buttons = ui.render().elements.filter(element => element.type === 'button');
  const deletion = remove || buttons.find(element => Array.isArray(element.props.children) && element.props.children.includes('Remove API key'));
  assert(deletion);
  (deletion.props.onClick as () => void)();
  await settle();
  const request = calls.find(call => call.options?.method === 'DELETE');
  assert.equal(request?.url, '/api/receipt/ai-settings');
  assert.equal(request?.options?.body, undefined);
  assert.deepEqual(ui.notifications, ['triptab:receipt-ai-settings']);
  assert.match(ui.render().html, /API key removed/);
  assert.doesNotMatch(ui.render().html, /Remove API key/);
});

test('retrying a rejected key save reuses the masked local key and clears it only after a successful save', async () => {
  const submissions: unknown[] = [];
  const ui = controller(async (_url, options) => {
    if (options?.method !== 'POST') return Response.json(state);
    submissions.push(JSON.parse(String(options.body)));
    return submissions.length === 1 ? Response.json({ code: 'key_check_rate_limited' }, { status: 429 }) : Response.json({ ok: true });
  });
  ui.render(); await settle();
  (keyInput(ui.render()).props.onChange as (event: unknown) => void)({ target: { value: 'sk-test-retry-key' } });
  const submit = () => {
    const form = ui.render().elements.find(element => element.type === 'form'); assert(form);
    (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
  };
  submit(); await settle();
  assert.equal(keyInput(ui.render()).props.value, 'sk-test-retry-key');
  assert.deepEqual(ui.notifications, []);
  submit(); await settle();
  assert.equal(keyInput(ui.render()).props.value, '');
  assert.deepEqual(submissions, [{ apiKey: 'sk-test-retry-key' }, { apiKey: 'sk-test-retry-key' }]);
  assert.deepEqual(ui.notifications, ['triptab:receipt-ai-settings']);
});

test('closing the settings aborts an in-flight request', () => {
  let signal: AbortSignal | null | undefined;
  const ui = controller(async (_url, options) => {
    signal = options?.signal;
    return new Promise(() => {});
  });
  ui.render();
  assert(signal);
  ui.unmount();
  assert.equal(signal.aborted, true);
});

test('signed-in participants see the shared service without key or provider management controls', async () => {
  const ui = controller(async () => Response.json({ ...state, manageable: false, connected: true, apiConnected: true, managementReason: 'account_restricted' }));
  ui.render(); await settle();
  const rendered = ui.render();
  assert.match(rendered.html, /Provided by TripTab\. Shared receipt processing is ready/);
  assert.match(rendered.html, /use receipt AI without entering a key/);
  assert(!rendered.elements.some(element => element.type === 'input' || element.type === 'select' || element.type === 'form'));
  assert.doesNotMatch(rendered.html, /Remove API key|Replace API key|Continue with ChatGPT to verify/);
});

test('owner verification for management does not suggest shared processing is unavailable', async () => {
  const ui = controller(async () => Response.json({ ...state, manageable: false, connected: true, apiConnected: true, managementReason: 'verification_required' }));
  ui.render(); await settle();
  const html = ui.render().html;
  assert.match(html, /Provided by TripTab\. Shared receipt processing is ready/);
  assert.match(html, /To manage the shared AI settings/);
  assert.match(html, /Continue with ChatGPT to verify/);
  assert.doesNotMatch(html, /Receipt processing is not connected|receipt-ai-api-key/);
});

test('the future enabled ChatGPT plan mode lets a participant connect their own plan without key-management access', async () => {
  const requests: { url: string; options?: RequestInit }[] = [];
  const ui = controller(async (url, options) => {
    requests.push({ url, options });
    if (options?.method === 'POST') return Response.json({ authorizationUrl: 'https://auth.openai.com/oauth/authorize?client_id=test' });
    return Response.json({ ...state, manageable: false, provider: 'siwc', siwcAvailable: true, reason: 'permission_required' });
  });
  ui.render(); await settle();
  const rendered = ui.render();
  assert(!rendered.elements.some(element => element.type === 'input' || element.type === 'select'));
  const connect = rendered.elements.find(element => element.type === 'button' && element.props.children === 'Connect ChatGPT plan');
  assert(connect);
  (connect.props.onClick as () => void)();
  await settle();
  const post = requests.find(request => request.options?.method === 'POST');
  assert.equal(post?.url, '/api/chatgpt-plan/start');
  assert.deepEqual(JSON.parse(String(post?.options?.body)), { returnTo: '/receipts' });
  assert.deepEqual(ui.redirects, ['https://auth.openai.com/oauth/authorize?client_id=test']);
});

async function failedKeySave(failure: () => Promise<Response>) {
  const ui = controller(async (_url, options) => options?.method === 'POST' ? failure() : Response.json(state));
  ui.render(); await settle();
  (keyInput(ui.render()).props.onChange as (event: unknown) => void)({ target: { value: 'sk-test-sensitive-value' } });
  const form = ui.render().elements.find(element => element.type === 'form');
  assert(form);
  (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
  await settle();
  const rendered = ui.render();
  assert.equal(keyInput(rendered).props.value, 'sk-test-sensitive-value', 'a failed save leaves the masked local field available for retry');
  const html = rendered.html.replace('value="sk-test-sensitive-value"', '');
  assert.doesNotMatch(html, /sk-test-sensitive-value|RAW_PROVIDER_ERROR/);
  assert.deepEqual(ui.notifications, [], 'a rejected save must not announce a settings change');
  return html;
}

test('key saving distinguishes provider failure, key permissions, owner verification and concurrent changes using fixed local messages', async () => {
  const cases = [
    { code: 'key_invalid_format', status: 400, message: /Enter a valid OpenAI API key beginning with sk-/ },
    { code: 'receipt_ai_error', status: 400, message: /Enter a valid OpenAI API key beginning with sk-/ },
    { code: 'key_rejected', status: 400, message: /OpenAI rejected this API key/ },
    { code: 'key_permission_denied', status: 400, message: /lacks the required permissions/ },
    { code: 'key_check_unavailable', status: 503, message: /could not reach OpenAI to check the key/ },
    { code: 'key_check_timeout', status: 504, message: /OpenAI took too long to check the key/ },
    { code: 'key_check_server_error', status: 503, message: /OpenAI could not check the key right now/ },
    { code: 'key_check_request_rejected', status: 400, message: /OpenAI could not accept the key-check request/ },
    { code: 'key_check_rate_limited', status: 429, message: /OpenAI is limiting key-check requests/ },
    { code: 'rate_limited', status: 429, message: /Too many key setup attempts/ },
    { code: 'verification_required', status: 403, message: /verify your owner account/ },
    { code: 'account_restricted', status: 403, message: /Only the verified site owner/ },
    { code: 'account_changed', status: 401, message: /Your account or ChatGPT link changed/ },
    { code: 'settings_changed', status: 409, message: /settings changed while you were updating them/ },
    { code: 'not_configured', status: 503, message: /encrypted key storage must be configured/ },
  ];
  for (const item of cases) {
    const html = await failedKeySave(async () => Response.json({ code: item.code, error: 'RAW_PROVIDER_ERROR sk-test-sensitive-value', apiKey: 'sk-test-sensitive-value' }, { status: item.status }));
    assert.match(html, item.message, `safe error ${item.code}/${item.status}`);
    if (item.code.startsWith('key_check')) assert.doesNotMatch(html, /verify your owner account|Check your verified account/);
  }
});

test('unrecognized error codes and non-JSON failures use safe status messages without exposing response text', async () => {
  for (const code of ['sk-test-sensitive-value', 'constructor', '__proto__', ['key_rejected']]) {
    const html = await failedKeySave(async () => Response.json({ code, error: 'RAW_PROVIDER_ERROR sk-test-sensitive-value' }, { status: 503 }));
    assert.match(html, /Receipt AI settings are temporarily unavailable/);
  }
  const html = await failedKeySave(async () => new Response('<html>RAW_PROVIDER_ERROR sk-test-sensitive-value</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }));
  assert.match(html, /Receipt AI settings are temporarily unavailable/);
});

test('a browser network failure does not imply the signed-in owner needs verification', async () => {
  const html = await failedKeySave(async () => { throw new TypeError('RAW_PROVIDER_ERROR sk-test-sensitive-value'); });
  assert.match(html, /Could not reach TripTab\. Check your connection and try again/);
  assert.doesNotMatch(html, /verify your owner account|Check your verified account/);
});

test('a successful save followed by a failed status refresh remains reported as saved', async () => {
  let gets = 0;
  const ui = controller(async (_url, options) => {
    if (options?.method === 'POST') return Response.json({ ok: true });
    return ++gets === 1 ? Response.json(state) : Response.json({ code: 'account_changed', error: 'RAW_PROVIDER_ERROR' }, { status: 401 });
  });
  ui.render(); await settle();
  (keyInput(ui.render()).props.onChange as (event: unknown) => void)({ target: { value: 'sk-test-sensitive-value' } });
  const form = ui.render().elements.find(element => element.type === 'form');
  assert(form);
  (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
  await settle();
  const html = ui.render().html;
  assert.match(html, /Your settings were saved, but the connection status could not refresh/);
  assert.match(html, /API key saved/);
  assert.deepEqual(ui.notifications, ['triptab:receipt-ai-settings']);
  assert.doesNotMatch(html, /sk-test-sensitive-value|RAW_PROVIDER_ERROR|Unable to save/);
});
