"use client";

import { useEffect, type RefObject } from "react";

/** Below this, a shortfall is browser chrome or rounding, not a keyboard. */
const KEYBOARD_THRESHOLD = 120;
const keyboardOpenFor = new Set<HTMLElement>();

function markKeyboard(root: HTMLElement, open: boolean) {
  if (open) keyboardOpenFor.add(root);
  else keyboardOpenFor.delete(root);
  document.documentElement.toggleAttribute("data-keyboard-open", keyboardOpenFor.size > 0);
}

/** `?viewport-debug` shows the measurements on the device; it lasts for the tab. */
function debugging() {
  try {
    if (new URLSearchParams(location.search).has("viewport-debug")) sessionStorage.setItem("viewport-debug", "1");
    return sessionStorage.getItem("viewport-debug") === "1";
  } catch {
    return false;
  }
}

/**
 * Keeps a fixed overlay on the part of the screen the person can actually see.
 *
 * A phone keyboard shrinks only the visual viewport. iOS then pans it down to
 * keep the focused field in view, which carries anything pinned to the layout
 * viewport (a `position: fixed; inset: 0` overlay) up and off the screen,
 * leaving the page underneath showing below it and through the keyboard.
 * Android behaves the same way by default since Chrome 108.
 *
 * This publishes, on the overlay element:
 * - `--viewport-top`: how far the visible area has panned. The overlay moves
 *   down by this much, so it starts at the top of the screen again.
 * - `--viewport-height`: the visible height above the keyboard, for dialogs
 *   that must fit inside it.
 * - `--keyboard-inset`: how much of the overlay the keyboard covers, kept
 *   clear of content but still painted with the overlay's own background.
 *
 * WebKit may not paint a fixed element past the layout viewport, so the part
 * of the screen behind the keyboard can still show the page. While a keyboard
 * is open, `data-keyboard-open` on the root element lets the page hide itself.
 *
 * The values follow the viewport while it changes, including after the
 * keyboard closes, when iOS 26 can leave the viewport offset behind.
 */
export function useVisualViewportBounds(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = ref.current;
    const viewport = window.visualViewport;
    if (!root || !viewport) return;
    const readout = debugging() ? root.appendChild(document.createElement("pre")) : null;
    readout?.classList.add("viewport-debug");
    let frame = 0;
    const apply = () => {
      frame = 0;
      // Pinch zoom also moves and shrinks the visual viewport; the overlay should
      // zoom with the page then, not chase the magnified area.
      const zoomed = viewport.scale > 1.01;
      const top = zoomed ? 0 : Math.max(0, viewport.offsetTop);
      root.style.setProperty("--viewport-top", `${top}px`);
      // The overlay keeps the layout viewport's height wherever it is moved.
      const layoutHeight = root.getBoundingClientRect().height;
      const height = zoomed ? layoutHeight : Math.min(layoutHeight, viewport.height);
      const inset = Math.max(0, layoutHeight - height);
      root.style.setProperty("--viewport-height", `${height}px`);
      root.style.setProperty("--keyboard-inset", `${inset}px`);
      markKeyboard(root, inset > KEYBOARD_THRESHOLD);
      if (readout) {
        const bounds = root.getBoundingClientRect();
        const round = (value: number) => Math.round(value * 10) / 10;
        readout.textContent = [
          `visual ${round(viewport.height)} @ ${round(viewport.offsetTop)} (page ${round(viewport.pageTop)}) ×${round(viewport.scale)}`,
          `inner ${innerHeight} · client ${document.documentElement.clientHeight} · scrollY ${round(scrollY)}`,
          `overlay ${round(bounds.top)}–${round(bounds.bottom)} · inset ${round(inset)}`,
        ].join("\n");
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(apply); };
    apply();
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule);
      markKeyboard(root, false);
      readout?.remove();
      for (const name of ["--viewport-top", "--viewport-height", "--keyboard-inset"]) root.style.removeProperty(name);
    };
  }, [ref]);
}
