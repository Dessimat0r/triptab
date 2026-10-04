import { isTripSectionPathname } from "./trip-routes";

const navigationEvent = "triptab:navigation";
let subscribers = 0;

export function tripTabLocationSnapshot(): string {
  return window.location.pathname + window.location.search;
}

function restoreTripSection() {
  if (!isTripSectionPathname(window.location.pathname)) return;
  // The shared client application follows the committed browser URL. Leave the
  // native event available to framework history/scroll and other subscribers.
  window.dispatchEvent(new Event(navigationEvent));
}

export function subscribeTripTabLocation(listener: () => void): () => void {
  if (subscribers++ === 0) window.addEventListener("popstate", restoreTripSection);
  window.addEventListener(navigationEvent, listener);
  return () => {
    window.removeEventListener(navigationEvent, listener);
    if (--subscribers === 0) window.removeEventListener("popstate", restoreTripSection);
  };
}

export function navigateTripTab(href: string, options: { replace?: boolean; scroll?: boolean } = {}): boolean {
  if (!isTripSectionPathname(window.location.pathname)) return false;
  const destination = new URL(href, window.location.href);
  if (destination.origin !== window.location.origin || !isTripSectionPathname(destination.pathname)) return false;
  const next = destination.pathname + destination.search + destination.hash;
  const current = window.location.pathname + window.location.search + window.location.hash;
  if (next !== current) {
    // Keep framework history metadata intact, while the app owns section URL
    // changes. Native section anchors also work before hydration and in a new tab.
    window.history[options.replace ? "replaceState" : "pushState"](window.history.state, "", next);
    window.dispatchEvent(new Event(navigationEvent));
    if (options.scroll !== false) window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }
  return true;
}
