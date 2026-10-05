"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { KeyRound, Trash2 } from "lucide-react";
import "./receipt-ai-settings.css";

export type ReceiptAIStatus = {
  configured: boolean;
  connected: boolean;
  eligible: boolean;
  manageable: boolean;
  managementReason?: "verification_required" | "account_restricted";
  apiConnected: boolean;
  provider: "api" | "siwc";
  siwcAvailable: boolean;
  reason?: "not_configured" | "not_connected" | "verification_required" | "account_restricted" | "siwc_disabled" | "permission_required";
  model?: string;
};

const reasonText: Record<NonNullable<ReceiptAIStatus["reason"]>, string> = {
  not_configured: "Receipt AI setup is not available on this site yet.",
  not_connected: "Shared receipt processing is not connected yet.",
  verification_required: "Continue with ChatGPT to verify your account before adding a key.",
  account_restricted: "Only the site owner can manage shared receipt AI settings. Manual entry and linked ChatGPT tools remain available.",
  siwc_disabled: "ChatGPT plan processing is switched off. Use the OpenAI API option.",
  permission_required: "Connect your ChatGPT plan and grant permission to use it for receipt reading.",
};

type SettingsOperation = "load" | "save-key" | "change-provider" | "remove-key" | "connect-plan";
const requestErrorText: Record<string, string> = {
  key_invalid_format: "Enter a valid OpenAI API key beginning with sk-.",
  key_rejected: "OpenAI rejected this API key. Check that it is correct and has not been revoked, then try again.",
  key_permission_denied: "This API key lacks the required permissions. Check the key's OpenAI project settings and try again.",
  key_check_unavailable: "TripTab could not reach OpenAI to check the key. Try again shortly.",
  key_check_timeout: "OpenAI took too long to check the key. Try again shortly.",
  key_check_server_error: "OpenAI could not check the key right now. Try again shortly.",
  key_check_request_rejected: "OpenAI could not accept the key-check request. Check the key's project settings and try again.",
  key_check_rate_limited: "OpenAI is limiting key-check requests. Wait a moment and try again.",
  rate_limited: "Too many key setup attempts. Wait a minute before trying again.",
  verification_required: "Continue with ChatGPT to verify your owner account before changing receipt AI settings.",
  account_restricted: "Only the verified site owner can manage the shared receipt AI settings.",
  account_changed: "Your account or ChatGPT link changed. Sign in again before changing receipt AI settings.",
  settings_changed: "Receipt AI settings changed while you were updating them. Reopen Your account and try again.",
  not_configured: "This site's encrypted key storage must be configured before an API key can be saved.",
  not_connected: "Shared receipt processing is not connected yet.",
  key_unavailable: "The saved key could not be opened. Save a replacement key to restore receipt processing.",
  siwc_disabled: "ChatGPT plan processing is switched off. Choose OpenAI API key.",
  permission_required: "Reconnect your ChatGPT plan and allow receipt processing.",
  connection_invalid: "Reconnect your ChatGPT plan to restore receipt processing.",
  authorization_failed: "Your ChatGPT plan connection could not be completed. Try connecting again.",
};
const operationErrorText: Record<SettingsOperation, string> = {
  load: "Unable to load receipt AI settings. Try again.",
  "save-key": "Unable to save the API key. Try again.",
  "change-provider": "Unable to change the receipt AI provider. Try again.",
  "remove-key": "Unable to remove the API key. Try again.",
  "connect-plan": "Unable to connect your ChatGPT plan. Try again.",
};
class SettingsRequestError extends Error {}

async function settingsResponseError(response: Response, operation: SettingsOperation) {
  // Only fixed internal codes select locally written text. Error descriptions,
  // echoed request fields and unknown codes must never reach the interface.
  let code: unknown;
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object") code = (body as Record<string, unknown>).code;
  } catch { /* A proxy can return HTML or an empty response. Use status only. */ }
  if (typeof code === "string" && Object.prototype.hasOwnProperty.call(requestErrorText, code)) return new SettingsRequestError(requestErrorText[code]);
  if (code === "receipt_ai_error" && response.status === 400 && operation === "save-key") return new SettingsRequestError(requestErrorText.key_invalid_format);
  if (response.status === 401) return new SettingsRequestError("Your sign-in has expired. Sign in again and reopen Your account.");
  if (response.status === 403) return new SettingsRequestError("This change was not permitted. Reopen Your account and try again.");
  if (response.status === 409) return new SettingsRequestError(requestErrorText.settings_changed);
  if (response.status === 429) return new SettingsRequestError("Too many requests. Wait a minute and try again.");
  if (response.status >= 500) return new SettingsRequestError("Receipt AI settings are temporarily unavailable. Try again shortly.");
  return new SettingsRequestError(operationErrorText[operation]);
}

function settingsFailureText(cause: unknown, fallback: string) {
  return cause instanceof SettingsRequestError ? cause.message : fallback;
}

const initialState = (accountId: string) => ({
  accountId, settings: null as ReceiptAIStatus | null, apiKey: "", busy: false, error: "", notice: "",
});

function statusFromResponse(body: unknown): ReceiptAIStatus {
  if (!body || typeof body !== "object") throw Error("Unable to load receipt AI settings.");
  const data = body as Record<string, unknown>;
  if (!["configured", "connected", "eligible", "siwcAvailable"].every(name => typeof data[name] === "boolean") ||
    (data.provider !== "api" && data.provider !== "siwc")) throw Error("Unable to load receipt AI settings.");
  return {
    configured: data.configured === true,
    connected: data.connected === true,
    eligible: data.eligible === true,
    manageable: data.manageable === true,
    managementReason: data.managementReason === "verification_required" || data.managementReason === "account_restricted" ? data.managementReason : undefined,
    apiConnected: data.apiConnected === true,
    provider: data.provider,
    siwcAvailable: data.siwcAvailable === true,
    reason: typeof data.reason === "string" && Object.prototype.hasOwnProperty.call(reasonText, data.reason)
      ? data.reason as ReceiptAIStatus["reason"] : undefined,
    model: typeof data.model === "string" && /^[a-z0-9._:-]{1,100}$/i.test(data.model) ? data.model : undefined,
  };
}

export default function ReceiptAISettings({
  accountId,
  verificationHref,
  onChanged,
}: {
  accountId: string;
  verificationHref: string;
  onChanged?: () => void;
}) {
  const id = useId();
  const [accountState, setAccountState] = useState(initialState(accountId));
  const { settings, apiKey, busy, error, notice } = accountState.accountId === accountId ? accountState : initialState(accountId);
  const updateState = (patch: Partial<ReturnType<typeof initialState>>) => setAccountState(previous => ({
    ...(previous.accountId === accountId ? previous : initialState(accountId)), ...patch, accountId,
  }));
  const setApiKey = (next: string) => updateState({ apiKey: next });
  const setBusy = (next: boolean) => updateState({ busy: next });
  const setError = (next: string) => updateState({ error: next });
  const setNotice = (next: string) => updateState({ notice: next });
  const request = useRef<AbortController | null>(null);
  const active = useRef(false);

  const load = useCallback(async (controller: AbortController) => {
    const response = await fetch("/api/receipt/ai-settings", {
      cache: "no-store", credentials: "same-origin", signal: controller.signal,
    });
    if (!response.ok) throw await settingsResponseError(response, "load");
    const next = statusFromResponse(await response.json());
    if (request.current === controller && !controller.signal.aborted) setAccountState(previous => ({
      ...(previous.accountId === accountId ? previous : initialState(accountId)), settings: next, accountId,
    }));
  }, [accountId]);

  useEffect(() => {
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    active.current = false;
    void load(controller).catch(cause => {
      if (!controller.signal.aborted) setAccountState(previous => ({
        ...(previous.accountId === accountId ? previous : initialState(accountId)),
        error: settingsFailureText(cause, operationErrorText.load), accountId,
      }));
    });
    return () => { controller.abort(); request.current?.abort(); request.current = null; };
  }, [accountId, load]);

  function changed() {
    window.dispatchEvent(new CustomEvent("triptab:receipt-ai-settings"));
    onChanged?.();
  }

  async function update(body: { apiKey: string } | { provider: ReceiptAIStatus["provider"] } | undefined, method: "POST" | "DELETE", success: string) {
    if (active.current || !settings?.manageable) return;
    active.current = true;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    setNotice("");
    let updated = false;
    const operation: SettingsOperation = method === "DELETE" ? "remove-key" : body && "apiKey" in body ? "save-key" : "change-provider";
    try {
      const response = await fetch("/api/receipt/ai-settings", {
        method, credentials: "same-origin", signal: controller.signal,
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) throw await settingsResponseError(response, operation);
      if (controller.signal.aborted || request.current !== controller) return;
      if (operation === "save-key") setApiKey("");
      updated = true;
      changed();
      setNotice(success);
      await load(controller);
    } catch (cause) {
      if (!controller.signal.aborted) setError(updated
        ? "Your settings were saved, but the connection status could not refresh. Reopen Your account."
        : settingsFailureText(cause, "Could not reach TripTab. Check your connection and try again."));
    } finally {
      if (request.current === controller && !controller.signal.aborted) {
        active.current = false;
        setBusy(false);
      }
    }
  }

  async function connectPlan() {
    if (active.current || !settings?.eligible || !settings.configured || !settings.siwcAvailable || settings.provider !== "siwc") return;
    active.current = true;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/chatgpt-plan/start", {
        method: "POST", credentials: "same-origin", signal: controller.signal,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ returnTo: "/receipts" }),
      });
      if (!response.ok) throw await settingsResponseError(response, "connect-plan");
      const body = await response.json() as { authorizationUrl?: unknown };
      if (typeof body.authorizationUrl !== "string") throw Error("Unable to connect your ChatGPT plan.");
      const authorization = new URL(body.authorizationUrl);
      if (authorization.protocol !== "https:" || authorization.hostname !== "auth.openai.com" || authorization.username || authorization.password) throw Error("Unable to connect your ChatGPT plan.");
      if (!controller.signal.aborted && request.current === controller) window.location.assign(authorization.href);
    } catch (cause) {
      if (!controller.signal.aborted) setError(settingsFailureText(cause, operationErrorText["connect-plan"]));
    } finally {
      if (request.current === controller && !controller.signal.aborted) {
        active.current = false;
        setBusy(false);
      }
    }
  }

  return <section className="account-section receipt-ai-settings" aria-labelledby={`${id}-title`} aria-busy={busy}>
    <h3 id={`${id}-title`}><KeyRound size={17} aria-hidden="true" />Receipt AI</h3>
    <p className="footnote">Read uploaded receipt images into items automatically with AI provided by TripTab. Review the results before saving an expense.</p>
    {!settings && !error && <p role="status">Loading receipt AI settings…</p>}
    {settings && <>
      <p className="footnote" role="status">{settings.connected
        ? (settings.provider === "api" ? "Provided by TripTab. Shared receipt processing is ready." : "Your ChatGPT plan receipt processing is connected.")
        : (settings.reason ? reasonText[settings.reason] : "Receipt processing is not connected.")}</p>
      {settings.managementReason === "verification_required" && <>
        <p className="footnote">To manage the shared AI settings, continue with ChatGPT to verify your account.</p>
        <a className="quiet account-link" href={verificationHref}>Continue with ChatGPT to verify</a>
      </>}
      {!settings.manageable && settings.managementReason !== "verification_required" && <p className="footnote">The site owner manages the shared API key. You can use receipt AI without entering a key.</p>}
      {settings.manageable && <>
        <p className="footnote">Your OpenAI API key funds receipt processing for all signed-in users. API usage is billed to the OpenAI account that owns the key, separately from a ChatGPT subscription.</p>
        <label htmlFor={`${id}-provider`}>Receipt processing provider
          <select id={`${id}-provider`} value={settings.provider} disabled={busy || !settings.configured}
            onChange={event => {
              const provider = event.target.value;
              if (provider === "api" || (provider === "siwc" && settings.siwcAvailable)) void update({ provider }, "POST", "Receipt processing provider saved.");
            }}>
            <option value="api">OpenAI API key</option>
            <option value="siwc" disabled={!settings.siwcAvailable}>ChatGPT plan{settings.siwcAvailable ? "" : " · currently disabled"}</option>
          </select>
        </label>
        {!settings.siwcAvailable && <p className="footnote">The ChatGPT plan option is switched off for now. You can switch providers here when it becomes available.</p>}
        {settings.provider === "api" && settings.configured && <form onSubmit={event => {
          event.preventDefault();
          if (active.current || !apiKey.trim()) return;
          const submittedKey = apiKey.trim();
          void update({ apiKey: submittedKey }, "POST", "API key saved.");
        }}>
          <label htmlFor={`${id}-api-key`}>{settings.apiConnected ? "Replace OpenAI API key" : "OpenAI API key"}
            <input id={`${id}-api-key`} name="receipt-ai-api-key" type="password" value={apiKey} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
              required maxLength={512} disabled={busy} aria-describedby={`${id}-key-hint`} onChange={event => setApiKey(event.target.value)} />
          </label>
          <small id={`${id}-key-hint`} className="muted">Use a key created in your TripTab OpenAI project. The shared key is encrypted on the server and never shown again. This field clears after the key is saved.</small>
          <button type="submit" className="quiet" disabled={busy || !apiKey.trim()}>{busy ? "Saving…" : (settings.apiConnected ? "Replace API key" : "Save API key")}</button>
        </form>}
        {settings.apiConnected && <button type="button" className="quiet danger" disabled={busy} onClick={() => void update(undefined, "DELETE", "API key removed.")}><Trash2 size={17} aria-hidden="true" />Remove API key</button>}
        {settings.apiConnected && <p className="footnote">Removing the key disables shared API receipt processing for everyone until a replacement is saved.</p>}
      </>}
      {settings.eligible && settings.provider === "siwc" && settings.siwcAvailable && !settings.connected && <button type="button" className="quiet" disabled={busy || !settings.configured} onClick={() => void connectPlan()}>Connect ChatGPT plan</button>}
      {settings.model && <p className="footnote">Receipt model: {settings.model}</p>}
    </>}
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p role="status" aria-live="polite">{notice}</p>}
  </section>;
}
