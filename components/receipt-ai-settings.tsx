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
    if (!response.ok) throw Error(response.status === 401 ? "Sign in to manage receipt AI." : "Unable to load receipt AI settings. Try again.");
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
    void load(controller).catch(() => {
      if (!controller.signal.aborted) setAccountState(previous => ({
        ...(previous.accountId === accountId ? previous : initialState(accountId)),
        error: "Unable to load receipt AI settings. Try again.", accountId,
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
    try {
      const response = await fetch("/api/receipt/ai-settings", {
        method, credentials: "same-origin", signal: controller.signal,
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      // Provider responses are never rendered: they must not echo credentials.
      if (!response.ok) throw Error("Unable to update receipt AI settings.");
      if (controller.signal.aborted || request.current !== controller) return;
      updated = true;
      changed();
      setNotice(success);
      await load(controller);
    } catch {
      if (!controller.signal.aborted) setError(updated
        ? "Your settings were saved, but the connection status could not refresh. Reopen Your account."
        : (method === "DELETE"
          ? "Unable to remove the API key. Try again."
          : "Unable to save receipt AI settings. Check your verified account and try again."));
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
      if (!response.ok) throw Error("Unable to connect your ChatGPT plan.");
      const body = await response.json() as { authorizationUrl?: unknown };
      if (typeof body.authorizationUrl !== "string") throw Error("Unable to connect your ChatGPT plan.");
      const authorization = new URL(body.authorizationUrl);
      if (authorization.protocol !== "https:" || authorization.hostname !== "auth.openai.com" || authorization.username || authorization.password) throw Error("Unable to connect your ChatGPT plan.");
      if (!controller.signal.aborted && request.current === controller) window.location.assign(authorization.href);
    } catch {
      if (!controller.signal.aborted) setError("Unable to connect your ChatGPT plan. Try again.");
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
          setApiKey("");
          void update({ apiKey: submittedKey }, "POST", "API key saved.");
        }}>
          <label htmlFor={`${id}-api-key`}>{settings.apiConnected ? "Replace OpenAI API key" : "OpenAI API key"}
            <input id={`${id}-api-key`} name="receipt-ai-api-key" type="password" value={apiKey} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
              required maxLength={512} disabled={busy} aria-describedby={`${id}-key-hint`} onChange={event => setApiKey(event.target.value)} />
          </label>
          <small id={`${id}-key-hint`} className="muted">The shared key is encrypted on the server and never shown again. This field clears after submission.</small>
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
