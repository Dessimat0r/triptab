"use client";
import { t as uiText } from "@/lib/ui-language";


import { createContext, useCallback, useContext, useSyncExternalStore, type AnchorHTMLAttributes, type ReactNode } from "react";
import { History, Receipt, Sparkles, Users, Wallet } from "lucide-react";
import { sectionsFor, tripSectionForPathname, tripSectionHref, type TripSection } from "@/lib/trip-routes";
import { navigateTripTab, subscribeTripTabLocation, tripTabLocationSnapshot } from "@/lib/trip-navigation";

const KindContext = createContext<"bill" | "holiday" | undefined>(undefined);
const SectionContext = createContext<((section: TripSection) => ReactNode) | null>(null);

export function TripTabRouteProvider({ renderSection, children, kind }: {
  renderSection: (section: TripSection) => ReactNode;
  children?: ReactNode;
  kind?: "bill" | "holiday";
}) {
  return <KindContext.Provider value={kind}><SectionContext.Provider value={renderSection}>{children}</SectionContext.Provider></KindContext.Provider>;
}

export function TripTabSection({ section }: { section: TripSection }) {
  const location = useTripTabLocation(tripSectionHref(section));
  const activeSection = tripSectionForPathname(location.split("?", 1)[0]);
  const renderSection = useContext(SectionContext);
  if (!renderSection) throw Error("Holiday sections must be rendered inside the shared TripTab application.");
  const kind = useContext(KindContext);
  return <section id={`panel-${activeSection}`} aria-labelledby={`tab-${kind === "bill" && activeSection !== "history" ? "expenses" : activeSection}`}>{renderSection(activeSection)}</section>;
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
    if (navigateTripTab(href)) event.preventDefault();
  }} />;
}

const icons = { expenses: Receipt, balances: Wallet, receipts: Sparkles, settings: Users, history: History };

export function TripTabNavigation({ receiptCount = 0, kind }: { receiptCount?: number; kind?: "bill" | "holiday" }) {
  const location = useTripTabLocation();
  const search = useTripTabEntryQuery();
  const view = tripSectionForPathname(location.split("?", 1)[0]);
  const selectedSection = kind === "bill" && view !== "history" ? "expenses" : view;
  return <nav className="tabs" aria-label={uiText(kind === "bill" ? "Bill sections" : "Holiday sections")}>
    {sectionsFor(kind).map(section => {
      const Icon = icons[section.id];
      return <TripTabLink
        key={section.id}
        id={`tab-${section.id}`}
        href={tripSectionHref(section.id, search)}
        aria-current={selectedSection === section.id ? "page" : undefined}
        className={selectedSection === section.id ? "selected" : ""}
      >
        <Icon size={17} aria-hidden="true" />
        <span>{uiText(section.label)}</span>
        {section.id === "receipts" && receiptCount > 0 && <span className="badge">{receiptCount}</span>}
      </TripTabLink>;
    })}
  </nav>;
}
