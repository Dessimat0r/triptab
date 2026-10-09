"use client";

import { useEffect, type RefObject } from "react";

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
 * The values follow the viewport while it changes, including after the
 * keyboard closes, when iOS 26 can leave the viewport offset behind.
 */
export function useVisualViewportBounds(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = ref.current;
    const viewport = window.visualViewport;
    if (!root || !viewport) return;
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
      root.style.setProperty("--viewport-height", `${height}px`);
      root.style.setProperty("--keyboard-inset", `${Math.max(0, layoutHeight - height)}px`);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(apply); };
    apply();
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      for (const name of ["--viewport-top", "--viewport-height", "--keyboard-inset"]) root.style.removeProperty(name);
    };
  }, [ref]);
}
