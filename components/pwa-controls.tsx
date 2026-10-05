"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bell, Download, Check, RefreshCw } from "lucide-react";
import { useLiveRefresh } from "@/components/use-live-refresh";
type InstallEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
};
function keyBytes(v: string) {
  const raw = atob(
    v.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (v.length % 4)) % 4),
  );
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

type NotificationRequestGuard = { signal?: AbortSignal; isCurrent?: () => boolean };
function assertNotificationRequest(guard: NotificationRequestGuard) {
  if (guard.signal?.aborted || guard.isCurrent?.() === false) throw new DOMException("Notification settings request superseded.", "AbortError");
}

// Browser operations cannot all be aborted. Stop waiting, and use the request
// guard to prevent any late completion from changing another account's device.
async function boundedNotificationRequest<T>(operation: (signal: AbortSignal) => Promise<T>, controller: AbortController) {
  assertNotificationRequest({ signal: controller.signal });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(new DOMException("Notification settings request superseded.", "AbortError"));
    controller.signal.addEventListener("abort", abort, { once: true });
    timeout = setTimeout(() => { controller.abort(); }, 8_000);
  });
  try { return await Promise.race([operation(controller.signal), interrupted]); }
  finally { clearTimeout(timeout); if (abort) controller.signal.removeEventListener("abort", abort); }
}

export async function clearBrowserNotifications(registration?: ServiceWorkerRegistration, capturedSubscription?: PushSubscription, isCurrent: () => boolean = () => true) {
  if (!("serviceWorker" in navigator)) return;
  const reg = registration || await navigator.serviceWorker.getRegistration("/");
  if (!reg || !isCurrent()) return;
  const notifications = await reg.getNotifications?.();
  if (!isCurrent()) return;
  for (const notification of notifications || []) notification.close();
  const subscription = capturedSubscription || await reg.pushManager?.getSubscription();
  if (subscription && isCurrent()) await subscription.unsubscribe();
}

/** A browser subscription alone never means this account opted into updates. */
export async function reconcileBrowserNotifications(guard: NotificationRequestGuard = {}) {
  if (!("serviceWorker" in navigator)) return { owned: false, publicKey: "", reset: false };
  const reg = await navigator.serviceWorker.getRegistration("/")
    || await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
  assertNotificationRequest(guard);
  const subscription = await reg.pushManager?.getSubscription();
  assertNotificationRequest(guard);
  const response = await fetch("/api/push", subscription ? {
    method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", signal: guard.signal,
    body: JSON.stringify({ mode: "status", endpoint: subscription.endpoint }),
  } : { cache: "no-store", signal: guard.signal });
  assertNotificationRequest(guard);
  if (!response.ok && response.status !== 401) throw Error("Unable to check notification settings. Try again.");
  const data = response.ok ? await response.json() as { ownsSubscription?: boolean; publicKey?: string } : {};
  assertNotificationRequest(guard);
  const owned = Boolean(subscription && data.ownsSubscription);
  if (subscription && !owned) await clearBrowserNotifications(reg, subscription, () => !guard.signal?.aborted && guard.isCurrent?.() !== false);
  assertNotificationRequest(guard);
  return { owned, publicKey: data.publicKey || "", reset: Boolean(subscription && !owned) };
}

export function PwaUpdatePrompt({ canUpdate = true }: { canUpdate?: boolean }) {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [dismissed, setDismissed] = useState<ServiceWorker | null>(null);
  const [updating, setUpdating] = useState(false);
  const requested = useRef(false);
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let live = true;
    let registration: ServiceWorkerRegistration | undefined;
    let installing: ServiceWorker | null = null;
    const detect = () => {
      if (live && registration?.waiting && navigator.serviceWorker.controller) {
        setWaiting(registration.waiting);
      }
    };
    const stateChanged = () => {
      if (live && installing?.state === "installed" && navigator.serviceWorker.controller) {
        setWaiting(registration?.waiting || installing);
      }
    };
    const updateFound = () => {
      installing?.removeEventListener("statechange", stateChanged);
      installing = registration?.installing || null;
      installing?.addEventListener("statechange", stateChanged);
    };
    const check = () => {
      if (navigator.onLine) registration?.update().catch(() => {});
      detect();
    };
    const changed = () => {
      // Initial activation and updates requested by another tab never reload
      // this tab: its expense editor may contain unsaved work.
      if (requested.current) window.location.reload();
      else if (live) setWaiting(null);
    };
    navigator.serviceWorker.addEventListener("controllerchange", changed);
    window.addEventListener("focus", check);
    window.addEventListener("online", check);
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then(reg => {
        if (!live) return;
        registration = reg;
        reg.addEventListener("updatefound", updateFound);
        updateFound();
        detect();
      }).catch(() => {});
    return () => {
      live = false;
      registration?.removeEventListener("updatefound", updateFound);
      installing?.removeEventListener("statechange", stateChanged);
      navigator.serviceWorker.removeEventListener("controllerchange", changed);
      window.removeEventListener("focus", check);
      window.removeEventListener("online", check);
    };
  }, []);
  if (!waiting || waiting === dismissed) return null;
  return <div className="pwa-update-banner" role="status">
    <p><strong>A TripTab update is available.</strong> {canUpdate ? "Update when you’re ready." : "Finish or close your current form before updating."}</p>
    <div>
      <button type="button" className="quiet" disabled={!canUpdate || updating} onClick={() => {
        if (!canUpdate || updating || waiting.state !== "installed") return;
        requested.current = true;
        setUpdating(true);
        waiting.postMessage({ type: "SKIP_WAITING" });
      }}><RefreshCw size={17} aria-hidden="true" />{updating ? "Updating…" : "Update and reload"}</button>
      <button type="button" className="textbutton" disabled={updating} onClick={() => setDismissed(waiting)}>Later</button>
    </div>
  </div>;
}

export default function PwaControls({ accountId, onChanged }: { accountId?: string | null; onChanged?: () => void } = {}) {
  const [install, setInstall] = useState<InstallEvent | null>(null),
    [installed, setInstalled] = useState(false),
    [supported, setSupported] = useState(false),
    [enabled, setEnabled] = useState(false),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState(""),
    [publicKey, setPublicKey] = useState("");
  const scope = useRef(accountId), live = useRef(true), generation = useRef(0), toggling = useRef(false), ownership = useRef(false);
  const checking = useRef<{ token: number; controller: AbortController; promise: Promise<void> } | null>(null);
  const toggleController = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    const requests = generation;
    scope.current = accountId; live.current = true; generation.current++; ownership.current = false;
    checking.current?.controller.abort(); checking.current = null;
    toggleController.current?.abort(); toggleController.current = null; toggling.current = false;
    return () => {
      live.current = false; requests.current++;
      checking.current?.controller.abort(); checking.current = null;
      toggleController.current?.abort(); toggleController.current = null;
    };
  }, [accountId]);
  const refreshNotifications = useCallback(async () => {
    if (!accountId || !("serviceWorker" in navigator) || toggling.current || !live.current || scope.current !== accountId) return;
    if (checking.current) return checking.current.promise;
    const token = ++generation.current, controller = new AbortController();
    const isCurrent = () => live.current && scope.current === accountId && generation.current === token && !toggling.current;
    const promise = (async () => {
      try {
        const result = await boundedNotificationRequest(signal => reconcileBrowserNotifications({ signal, isCurrent }), controller);
        if (!isCurrent()) return;
        const previouslyOwned = ownership.current; ownership.current = result.owned;
        setEnabled(result.owned); setPublicKey(result.publicKey);
        setStatus(previous => result.reset ? "Notifications are off for this account. Enable them here if you want trip updates."
          : previouslyOwned && !result.owned ? "Notifications are off on this device."
          : previous === "Notification settings are unavailable. Checking again automatically."
            || (result.owned && previous.startsWith("Notifications are off")) ? "" : previous);
      } catch {
        if (isCurrent()) setStatus("Notification settings are unavailable. Checking again automatically.");
      } finally { if (checking.current?.token === token) checking.current = null; }
    })();
    checking.current = { token, controller, promise };
    return promise;
  }, [accountId]);
  useLiveRefresh(refreshNotifications, { accountId: accountId || undefined, enabled: !!accountId });
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      setEnabled(false); setPublicKey(""); setBusy(false); setStatus("");
      return refreshNotifications();
    });
    return () => { active = false; };
  }, [refreshNotifications]);
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => {
      if (live) {
        setInstalled(matchMedia("(display-mode: standalone)").matches);
        setSupported(
          "serviceWorker" in navigator &&
            "PushManager" in window &&
            "Notification" in window,
        );
      }
    });
    const listener = (e: Event) => {
      e.preventDefault();
      setInstall(e as InstallEvent);
    };
    const appInstalled = () => {
      setInstalled(true);
      setInstall(null);
    };
    window.addEventListener("beforeinstallprompt", listener);
    window.addEventListener("appinstalled", appInstalled);
    return () => {
      live = false;
      window.removeEventListener("beforeinstallprompt", listener);
      window.removeEventListener("appinstalled", appInstalled);
    };
  }, []);
  async function toggle() {
    if (toggling.current || !accountId || scope.current !== accountId || !live.current) return;
    toggling.current = true;
    checking.current?.controller.abort(); checking.current = null;
    const token = ++generation.current, controller = new AbortController();
    toggleController.current = controller;
    const isCurrent = () => live.current && scope.current === accountId && generation.current === token;
    const guard = () => assertNotificationRequest({ signal: controller.signal, isCurrent });
    setBusy(true);
    setStatus("");
    try {
      const reg = await boundedNotificationRequest(async () => await navigator.serviceWorker.getRegistration("/")
        || await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }), controller);
      guard();
      if (!reg.active) throw Error("Notifications are getting ready. Try again shortly.");
      if (enabled) {
        const sub = await boundedNotificationRequest(() => reg.pushManager.getSubscription(), controller);
        guard();
        if (sub) {
          const r = await boundedNotificationRequest(signal => fetch("/api/push", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal,
            body: JSON.stringify({
              mode: "unsubscribe",
              endpoint: sub.endpoint,
            }),
          }), controller);
          guard();
          if (!r.ok) throw Error("Unable to change notifications. Try again.");
          onChanged?.();
          await clearBrowserNotifications(reg, sub, isCurrent);
          guard();
        }
        ownership.current = false; setEnabled(false);
        setStatus("Notifications turned off on this device.");
      } else {
        if (!publicKey)
          throw Error(
            "Notifications are not available yet. Settings will update automatically.",
          );
        const permission = await Notification.requestPermission();
        guard();
        if (permission !== "granted")
          throw Error(
            "Allow notifications in your browser settings to receive trip updates.",
          );
        const sub = await boundedNotificationRequest(() => reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes(publicKey),
        }), controller);
        guard();
        const r = await boundedNotificationRequest(signal => fetch("/api/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal,
          body: JSON.stringify({ mode: "subscribe", endpoint: sub.endpoint }),
        }), controller);
        const b = (await r.json()) as { error?: string };
        guard();
        if (!r.ok) {
          await sub.unsubscribe();
          throw Error(b.error || "Unable to register this device.");
        }
        onChanged?.();
        ownership.current = true; setEnabled(true);
        setStatus(
          "You’ll receive updates when another traveller changes a shared trip.",
        );
      }
    } catch (e) {
      if (isCurrent()) setStatus(e instanceof Error && e.name !== "AbortError" ? e.message : "Unable to change notifications. Try again shortly.");
    } finally {
      if (isCurrent()) {
        toggling.current = false; toggleController.current = null; setBusy(false);
        // A change in another tab may have arrived during the explicit action.
        // Reconcile once afterwards; never overlap it with permission/subscription.
        void refreshNotifications();
      }
    }
  }
  return (
    <div className="pwa-settings">
      <h3>TripTab on your phone</h3>
      {installed ? (
        <p className="installed">
          <Check size={16} /> Installed on this device
        </p>
      ) : install ? (
        <button
          className="quiet wide"
          onClick={async () => {
            await install.prompt();
            const c = await install.userChoice;
            if (c.outcome === "accepted") setInstalled(true);
            setInstall(null);
          }}
        >
          <Download size={17} /> Install TripTab
        </button>
      ) : (
        <p className="footnote">
          Use your browser’s menu to install TripTab or choose “Add to Home
          Screen”.
        </p>
      )}
      <button
        className="quiet wide"
        disabled={busy || !supported || !accountId}
        onClick={toggle}
      >
        <Bell size={17} />
        {busy
          ? "Updating…"
          : enabled
            ? "Turn off notifications"
            : "Enable trip notifications"}
      </button>
      <p className="footnote">
        On iPhone, add TripTab to your Home Screen before enabling
        notifications. Support depends on your browser.
      </p>
      {status && (
        <p className="notification-status" role="status">
          {status}
        </p>
      )}
    </div>
  );
}
