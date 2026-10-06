"use client";

import { useCallback, useRef } from "react";

/**
 * A callback ref for a dialog's sticky footer. It publishes the footer's
 * current height as `--editor-footer-height` on the scrolling dialog (used by
 * its scroll padding) and, whenever focus moves to a control the footer would
 * cover, scrolls that control back into view. The checklist can change the
 * footer's height at any time, so a fixed allowance is not enough.
 */
export function useStickyFooterReveal(scroller = ".editor") {
  const cleanup = useRef<(() => void) | null>(null);
  return useCallback((footer: HTMLElement | null) => {
    cleanup.current?.();
    cleanup.current = null;
    const dialog = footer?.closest<HTMLElement>(scroller);
    if (!footer || !dialog) return;
    const update = () => dialog.style.setProperty("--editor-footer-height", `${Math.ceil(footer.getBoundingClientRect().height)}px`);
    update();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    observer?.observe(footer);
    let frame = 0;
    const reveal = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || footer.contains(target) || !dialog.contains(target)) return;
      cancelAnimationFrame(frame);
      // Measure after the browser's own focus scrolling has finished.
      frame = requestAnimationFrame(() => {
        const rect = target.getBoundingClientRect();
        const limit = footer.getBoundingClientRect().top - 12;
        if (rect.height && rect.bottom > limit) dialog.scrollBy({ top: rect.bottom - limit });
      });
    };
    dialog.addEventListener("focusin", reveal);
    cleanup.current = () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      dialog.removeEventListener("focusin", reveal);
    };
  }, [scroller]);
}
