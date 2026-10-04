import assert from "node:assert/strict";
import test from "node:test";
import type { MouseEvent, ReactElement } from "react";
import { TripTabLink } from "../components/trip-routing";
import { navigateTripTab, subscribeTripTabLocation, tripTabLocationSnapshot } from "../lib/trip-navigation";

type HistoryState = { frameworkKey: string };

class BrowserFixture extends EventTarget {
  location = new URL("https://triptab.example/expenses");
  changes: { mode: string; url: string }[] = [];
  scrolls: unknown[] = [];
  history: { state: HistoryState; pushState(state: HistoryState, unused: string, url: string): void; replaceState(state: HistoryState, unused: string, url: string): void } = {
    state: { frameworkKey: "preserved" },
    pushState: (state: HistoryState, _unused: string, url: string) => this.change("push", state, url),
    replaceState: (state: HistoryState, _unused: string, url: string) => this.change("replace", state, url),
  };
  change(mode: string, state: HistoryState, url: string) {
    this.history.state = state;
    this.location = new URL(url, this.location);
    this.changes.push({ mode, url });
  }
  scrollTo(options: unknown) { this.scrolls.push(options); }
}

function browserFixture(callback: (browser: BrowserFixture) => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const browser = new BrowserFixture();
  Object.defineProperty(globalThis, "window", { value: browser, configurable: true });
  try { callback(browser); }
  finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

test("section navigation publishes committed URLs, keeps history metadata, and cleans entry queries without scrolling", () => browserFixture(browser => {
  const snapshots: string[] = [];
  const unsubscribe = subscribeTripTabLocation(() => snapshots.push(tripTabLocationSnapshot()));
  try {
    assert.equal(navigateTripTab("/balances?connect=chatgpt"), true);
    assert.equal(navigateTripTab("/balances", { replace: true, scroll: false }), true);
    assert.deepEqual(snapshots, ["/balances?connect=chatgpt", "/balances"]);
    assert.deepEqual(browser.changes, [{ mode: "push", url: "/balances?connect=chatgpt" }, { mode: "replace", url: "/balances" }]);
    assert.deepEqual(browser.history.state, { frameworkKey: "preserved" });
    assert.equal(browser.scrolls.length, 1);
    navigateTripTab("/balances");
    assert.equal(browser.changes.length, 2, "the current route does not create duplicate history entries");
    assert.equal(navigateTripTab("/api/profile"), false);
    assert.equal(navigateTripTab("https://elsewhere.example/balances"), false);
    assert.equal(browser.changes.length, 2, "unowned URLs use native navigation");
  } finally { unsubscribe(); }
}));

test("browser history restores owned sections without triggering server navigation and leaves other routes alone", () => browserFixture(browser => {
  let updates = 0, frameworkNavigations = 0;
  const unsubscribe = subscribeTripTabLocation(() => updates++);
  browser.addEventListener("popstate", () => frameworkNavigations++);
  try {
    browser.location = new URL("https://triptab.example/receipts");
    browser.dispatchEvent(new Event("popstate"));
    assert.equal(updates, 1);
    assert.equal(frameworkNavigations, 0);
    assert.equal(browser.scrolls.length, 0, "back and forward retain browser scroll restoration");
    browser.location = new URL("https://triptab.example/unowned");
    browser.dispatchEvent(new Event("popstate"));
    assert.equal(updates, 1);
    assert.equal(frameworkNavigations, 1);
  } finally { unsubscribe(); }
}));

test("section anchors retain normal modifier, new-tab, download and external-link behavior", () => browserFixture(browser => {
  function click(props: Parameters<typeof TripTabLink>[0], changes: Partial<MouseEvent<HTMLAnchorElement>> = {}) {
    let prevented = false;
    const event = { button: 0, defaultPrevented: false, preventDefault() { prevented = true; }, ...changes } as MouseEvent<HTMLAnchorElement>;
    const link = TripTabLink(props) as ReactElement<{ onClick: (event: MouseEvent<HTMLAnchorElement>) => void }>;
    link.props.onClick(event);
    return prevented;
  }
  assert.equal(click({ href: "/balances" }, { ctrlKey: true }), false);
  assert.equal(click({ href: "/balances" }, { metaKey: true }), false);
  assert.equal(click({ href: "/balances" }, { button: 1 }), false);
  assert.equal(click({ href: "/balances", target: "_blank" }), false);
  assert.equal(click({ href: "/balances", download: "ledger" }), false);
  assert.equal(click({ href: "https://elsewhere.example/balances" }), false);
  assert.equal(browser.changes.length, 0);
  assert.equal(click({ href: "/balances" }), true);
  assert.equal(browser.location.pathname, "/balances");
  browser.location = new URL("https://triptab.example/unowned");
  assert.equal(click({ href: "/expenses" }), false, "an unknown page uses a hard navigation to mount the correct route outlet");
  assert.equal(browser.changes.length, 1);
}));
