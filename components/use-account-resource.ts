"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveRefresh } from "./use-live-refresh";

export const ACCOUNT_HEADER = "X-TripTab-Account";

/**
 * A private read that belongs to one signed-in account (R02).
 *
 * The value is stored together with the account it was read for and is
 * returned only while that account is current, so a session switch never
 * shows the previous account's archive, people or amounts, even for the
 * render before a new read starts. A response is accepted only if it is the
 * newest request, its account is still current and the server says it
 * answered for that same account. Losing access (401/403/404) clears the
 * value; the read repeats on every live refresh, so access revoked while a
 * panel is open disappears from it.
 */
export function useAccountResource<T>(accountId: string | undefined, url: string, read: (body: unknown) => T, options: { init?: RequestInit; refreshKey?: unknown } = {}) {
  const [state, setState] = useState<{ accountId: string; value: T } | null>(null);
  const request = useRef(0);
  const scope = useRef(accountId);
  const latestRead = useRef(read);
  const latestInit = useRef(options.init);
  useEffect(() => { scope.current = accountId; latestRead.current = read; latestInit.current = options.init; });
  const refresh = useCallback(async () => {
    const id = ++request.current;
    const owner = accountId;
    if (!owner) { setState(null); return; }
    const current = () => id === request.current && scope.current === owner;
    try {
      const response = await fetch(url, { cache: "no-store", ...latestInit.current });
      if (!current()) return;
      const answeredFor = response.headers.get(ACCOUNT_HEADER);
      if ([401, 403, 404].includes(response.status) || (answeredFor !== null && answeredFor !== owner)) {
        setState({ accountId: owner, value: latestRead.current(null) });
        return;
      }
      if (!response.ok || answeredFor === null) return;
      const value = latestRead.current(await response.json());
      if (current()) setState({ accountId: owner, value });
    } catch {
      // A failed check keeps this account's last value; nothing else is shown.
    }
  }, [accountId, url]);
  useEffect(() => {
    // A new account, URL or refresh key starts a new read and retires older
    // ones. The read starts after this render commits, like other app reads.
    const requests = request;
    void Promise.resolve().then(refresh);
    return () => { requests.current++; };
  }, [refresh, options.refreshKey]);
  useLiveRefresh(refresh, { accountId, enabled: !!accountId });
  return state && accountId && state.accountId === accountId ? state.value : null;
}
