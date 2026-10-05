import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ExpensesPage from "../app/(ledger)/expenses/page";
import BalancesPage from "../app/(ledger)/balances/page";
import ReceiptsPage from "../app/(ledger)/receipts/page";
import TravellersPage from "../app/(ledger)/travellers/page";
import HistoryPage from "../app/(ledger)/history/page";
import { TripTabRouteProvider } from "../components/trip-routing";
import { TRIP_SECTIONS, tripSectionForPathname, tripSectionHref, type TripSection } from "../lib/trip-routes";

test("every direct section route renders only its requested section through the shared application", () => {
  const pages = [ExpensesPage, BalancesPage, ReceiptsPage, TravellersPage, HistoryPage];
  for (const [index, page] of pages.entries()) {
    const requested: TripSection[] = [];
    const section = TRIP_SECTIONS[index];
    const markup = renderToStaticMarkup(createElement(TripTabRouteProvider, {
      renderSection(id) { requested.push(id); return createElement("h2", null, `Loaded ${id}`); },
    }, createElement(page)));
    assert.deepEqual(requested, [section.id], "inactive section bodies must not render");
    assert.match(markup, new RegExp(`id="panel-${section.id}"`));
    assert.match(markup, new RegExp(`aria-labelledby="tab-${section.id}"`));
    assert.match(markup, new RegExp(`Loaded ${section.id}`));
  }
});

test("direct links, the root entry page, and trailing slashes select the matching section", () => {
  assert.equal(tripSectionForPathname("/"), "expenses");
  for (const section of TRIP_SECTIONS) {
    assert.equal(tripSectionForPathname(section.href), section.id);
    assert.equal(tripSectionForPathname(`${section.href}/`), section.id);
  }
});

test("changing sections preserves unfinished invitation and account entry parameters without copying unrelated URL data", () => {
  const search = "?invite=abc%2B123%26join&connect=chatgpt&account=login&receipt=private-photo&return_to=https%3A%2F%2Felsewhere.example";
  for (const section of TRIP_SECTIONS) {
    const destination = new URL(tripSectionHref(section.id, search), "https://triptab.example");
    assert.equal(destination.pathname, section.href);
    assert.equal(destination.searchParams.get("invite"), "abc+123&join");
    assert.equal(destination.searchParams.get("connect"), "chatgpt");
    assert.equal(destination.searchParams.get("account"), "login");
    assert.equal(destination.searchParams.has("receipt"), false);
    assert.equal(destination.searchParams.has("return_to"), false);
  }
  assert.equal(tripSectionHref("balances"), "/balances");
});

test("invitation and account entry links survive browsers without URLSearchParams.size", () => {
  const descriptor = Object.getOwnPropertyDescriptor(URLSearchParams.prototype, "size");
  if (descriptor) assert.equal(Reflect.deleteProperty(URLSearchParams.prototype, "size"), true);
  try {
    assert.equal(new URLSearchParams("invite=existing-member").size, undefined);
    const entries = [["invite", "abc+123&join"], ["account", "login"], ["connect", "chatgpt"]];
    const queries = [...entries.map(([key, value]) => new URLSearchParams([[key, value]])), new URLSearchParams(entries)];
    for (const section of TRIP_SECTIONS) {
      for (const query of queries) {
        const destination = new URL(tripSectionHref(section.id, query.toString()), "https://triptab.example");
        assert.equal(destination.pathname, section.href);
        assert.equal(destination.search, "?" + query.toString(), "unfinished entry parameters must remain in the navigable URL");
      }
      assert.equal(tripSectionHref(section.id), section.href);
      assert.equal(tripSectionHref(section.id, "?receipt=private-photo"), section.href);
    }
  } finally {
    if (descriptor) Object.defineProperty(URLSearchParams.prototype, "size", descriptor);
  }
});
