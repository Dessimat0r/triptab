"use client";

import { useEffect, useLayoutEffect, useRef } from "react";

export const LIVE_REFRESH_EVENT = "triptab:live-refresh";

/** Saved-data checks only. Never start AI work or request browser permission. */
export function dispatchLiveRefresh(accountId: string) {
  // An empty scope retries profile bootstrap after an authenticated ledger
  // check. Resources bound to a known account ignore that event.
  window.dispatchEvent(new CustomEvent(LIVE_REFRESH_EVENT, { detail: { accountId } }));
}

/** One app scheduler refreshes only mounted resources in their current account. */
export function useLiveRefresh(refresh: () => void | Promise<unknown>, options: { accountId?: string; enabled?: boolean } = {}) {
  const latest = useRef(refresh);
  useLayoutEffect(() => { latest.current = refresh; }, [refresh]);
  const { accountId, enabled = true } = options;
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const update = (event: Event) => {
      const detail = (event as CustomEvent<{ accountId?: string }>).detail;
      if (accountId && detail?.accountId !== accountId) return;
      if (document.visibilityState !== "visible" || !navigator.onLine) return;
      void Promise.resolve().then(() => active ? latest.current() : undefined).catch(() => {});
    };
    window.addEventListener(LIVE_REFRESH_EVENT, update);
    return () => { active = false; window.removeEventListener(LIVE_REFRESH_EVENT, update); };
  }, [accountId, enabled]);
}
