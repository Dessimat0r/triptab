"use client";

import { createContext, useCallback, useContext, useSyncExternalStore, type AnchorHTMLAttributes, type ReactNode } from "react";
import { History, Receipt, Sparkles, Users, Wallet } from "lucide-react";
import { TRIP_SECTIONS, tripSectionForPathname, tripSectionHref, type TripSection } from "@/lib/trip-routes";
import { navigateTripTab, subscribeTripTabLocation, tripTabLocationSnapshot } from "@/lib/trip-navigation";

const SectionContext = createContext<((section: TripSection) => ReactNode) | null>(null);

export function TripTabRouteProvider({ renderSection, children }: {
  renderSection: (section: TripSection) => ReactNode;
  children?: ReactNode;
}) {
  return <SectionContext.Provider value={renderSection}>{children}</SectionContext.Provider>;
}

export function TripTabSection({ section }: { section: TripSection }) {
  const location = useTripTabLocation(tripSectionHref(section));
  const activeSection = tripSectionForPathname(location.split("?", 1)[0]);
  const renderSection = useContext(SectionContext);
  if (!renderSection) throw Error("Holiday sections must be rendered inside the shared TripTab application.");
  return <section id={`panel-${activeSection}`} aria-labelledby={`tab-${activeSection}`}>{renderSection(activeSection)}</section>;
}

function useTripTabLocation(serverLocation = "/") {
  return useSyncExternalStore(subscribeTripTabLocation, tripTabLocationSnapshot, () => serverLocation);
}

export function useTripTabNavigation() {
  const location = useTripTabLocation();
  const navigate = useCallback((section: TripSection) => {
    const href = tripSectionHref(section, window.location.search);
    navigateTripTab(href);
  }, []);
  const replaceEntryUrl = useCallback((href: string) => navigateTripTab(href, { replace: true, scroll: false }), []);
  return { view: tripSectionForPathname(location.split("?", 1)[0]), navigate, replaceEntryUrl };
}

export function useTripTabEntryQuery() {
  const location = useTripTabLocation();
  const marker = location.indexOf("?");
  return marker < 0 ? "" : location.slice(marker + 1);
}

export function TripTabLink({ href, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return <a {...props} href={href} onClick={event => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || (props.target && props.target !== "_self") || props.download !== undefined) return;
    const destination = new URL(href, window.location.href);
    if (destination.origin !== window.location.origin || !TRIP_SECTIONS.some(section => section.href === destination.pathname) && destination.pathname !== "/") return;
    event.preventDefault();
    navigateTripTab(href);
  }} />;
}

const icons = { expenses: Receipt, balances: Wallet, receipts: Sparkles, settings: Users, history: History };

export function TripTabNavigation({ receiptCount = 0 }: { receiptCount?: number }) {
  const location = useTripTabLocation();
  const search = useTripTabEntryQuery();
  const view = tripSectionForPathname(location.split("?", 1)[0]);
  return <nav className="tabs" aria-label="Holiday sections">
    {TRIP_SECTIONS.map(section => {
      const Icon = icons[section.id];
      return <TripTabLink
        key={section.id}
        id={`tab-${section.id}`}
        href={tripSectionHref(section.id, search)}
        aria-current={view === section.id ? "page" : undefined}
        className={view === section.id ? "selected" : ""}
      >
        <Icon size={17} aria-hidden="true" />
        <span>{section.label}</span>
        {section.id === "receipts" && receiptCount > 0 && <span className="badge">{receiptCount}</span>}
      </TripTabLink>;
    })}
  </nav>;
}
