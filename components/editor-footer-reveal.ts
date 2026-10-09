"use client";

import { useCallback, useRef } from "react";

/**
 * A callback ref for a dialog's sticky footer. It publishes the footer's
 * current height as `--editor-footer-height` on the scrolling dialog (used by
 * its scroll padding) and, whenever focus moves to a control the footer would
 * cover, scrolls that control back into view. The checklist can change the
 * footer's height at any time, so a fixed allowance is not enough.
 *
 * A phone keyboard shrinks the dialog to the area above it after focus has
 * already moved, so a focused field is revealed again whenever the dialog's
 * height changes.
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
    const revealable = (target: EventTarget | null): target is HTMLElement =>
      target instanceof HTMLElement && !footer.contains(target) && dialog.contains(target);
    const reveal = (target: HTMLElement) => {
      const rect = target.getBoundingClientRect();
      const limit = footer.getBoundingClientRect().top - 12;
      if (rect.height && rect.bottom > limit) dialog.scrollBy({ top: rect.bottom - limit });
    };
    let frame = 0;
    const revealFocused = (event: FocusEvent) => {
      const target = event.target;
      if (!revealable(target)) return;
      cancelAnimationFrame(frame);
      // Measure after the browser's own focus scrolling has finished.
      frame = requestAnimationFrame(() => reveal(target));
    };
    dialog.addEventListener("focusin", revealFocused);
    // Runs after layout and before paint, so the field is never drawn hidden.
    let height = dialog.clientHeight;
    const resized = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
      if (dialog.clientHeight === height) return;
      height = dialog.clientHeight;
      const active = document.activeElement;
      if (revealable(active) && active.matches("input, textarea, select, [contenteditable='true']")) reveal(active);
    }) : null;
    resized?.observe(dialog);
    cleanup.current = () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      resized?.disconnect();
      dialog.removeEventListener("focusin", revealFocused);
    };
  }, [scroller]);
}
