"use client";
import { useEffect, useRef, useState } from "react";
import { Bell, Download, Check, RefreshCw } from "lucide-react";
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

export default function PwaControls() {
  const [install, setInstall] = useState<InstallEvent | null>(null),
    [installed, setInstalled] = useState(false),
    [supported, setSupported] = useState(false),
    [enabled, setEnabled] = useState(false),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState(""),
    [publicKey, setPublicKey] = useState("");
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
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/", updateViaCache: "none" })
        .then(async (reg) => {
          const sub = await reg.pushManager?.getSubscription();
          if (live) setEnabled(!!sub);
        })
        .catch(() => {
          if (live)
            setStatus("App installation is unavailable in this browser.");
        });
      fetch("/api/push")
        .then((r) => r.json())
        .then((b: unknown) => {
          const data = b as { publicKey?: string };
          if (live) setPublicKey(data.publicKey || "");
        })
        .catch(() => {});
    }
    return () => {
      live = false;
      window.removeEventListener("beforeinstallprompt", listener);
      window.removeEventListener("appinstalled", appInstalled);
    };
  }, []);
  async function toggle() {
    setBusy(true);
    setStatus("");
    try {
      const reg = await navigator.serviceWorker.ready;
      if (enabled) {
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          const r = await fetch("/api/push", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mode: "unsubscribe",
              endpoint: sub.endpoint,
            }),
          });
          if (!r.ok) throw Error("Unable to change notifications. Try again.");
          await sub.unsubscribe();
        }
        setEnabled(false);
        setStatus("Notifications turned off on this device.");
      } else {
        if (!publicKey)
          throw Error(
            "Notifications are not available yet. Try again after refreshing.",
          );
        const permission = await Notification.requestPermission();
        if (permission !== "granted")
          throw Error(
            "Allow notifications in your browser settings to receive trip updates.",
          );
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes(publicKey),
        });
        const r = await fetch("/api/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "subscribe", endpoint: sub.endpoint }),
        });
        const b = (await r.json()) as { error?: string };
        if (!r.ok) {
          await sub.unsubscribe();
          throw Error(b.error || "Unable to register this device.");
        }
        setEnabled(true);
        setStatus(
          "You’ll receive updates when another traveller changes a shared trip.",
        );
      }
    } catch (e) {
      setStatus(
        e instanceof Error ? e.message : "Unable to change notifications.",
      );
    } finally {
      setBusy(false);
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
        disabled={busy || !supported}
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
