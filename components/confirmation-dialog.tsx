"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ModalA11y from "./modal-accessibility";
import "./confirmation-dialog.css";

type ConfirmationOptions = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
};
type PendingConfirmation = ConfirmationOptions & { scope: string };

/** An embed-safe confirmation that also works above an existing editor. */
export function useConfirmation(scope: string) {
  const id = useId();
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const resolver = useRef<((accepted: boolean) => void) | null>(null);
  const currentScope = useRef(scope);
  useLayoutEffect(() => { currentScope.current = scope; }, [scope]);

  const finish = useCallback((accepted: boolean) => {
    const resolve = resolver.current;
    resolver.current = null;
    setPending(null);
    resolve?.(accepted);
  }, []);

  useEffect(() => {
    // Resolve a waiting handler when its host disappears (for example, logout).
    return () => { resolver.current?.(false); resolver.current = null; };
  }, []);
  useEffect(() => {
    if (pending && pending.scope !== scope) {
      void Promise.resolve().then(() => finish(false));
    }
  }, [finish, pending, scope]);

  const confirm = useCallback((options: ConfirmationOptions): Promise<boolean> => {
    if (resolver.current) return Promise.resolve(false);
    const requestedScope = scope;
    return new Promise(resolve => {
      resolver.current = accepted => resolve(accepted && currentScope.current === requestedScope);
      setPending({ ...options, scope: requestedScope });
    });
  }, [scope]);

  const dialog = pending && pending.scope === scope ? createPortal(
    <ModalA11y className="overlay confirmation-overlay" onClose={() => finish(false)}>
      <section className="modal small confirmation-sheet" role="dialog" aria-modal="true"
        aria-labelledby={`${id}-title`} aria-describedby={`${id}-message`}>
        <h2 id={`${id}-title`}>{pending.title}</h2>
        <p id={`${id}-message`}>{pending.message}</p>
        <div className="confirmation-actions">
          <button type="button" className="quiet" data-autofocus onClick={() => finish(false)}>{pending.cancelLabel || "Cancel"}</button>
          <button type="button" className={pending.destructive ? "danger quiet" : "primary"}
            onClick={() => finish(true)}>{pending.confirmLabel}</button>
        </div>
      </section>
    </ModalA11y>, document.body,
  ) : null;
  return { confirm, dialog, confirming: !!pending };
}
