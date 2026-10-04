"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, type ReactNode } from "react";
import { History, Receipt, Sparkles, Users, Wallet } from "lucide-react";
import { TRIP_SECTIONS, tripSectionForPathname, tripSectionHref, type TripSection } from "@/lib/trip-routes";

const SectionContext = createContext<((section: TripSection) => ReactNode) | null>(null);

export function TripTabRouteProvider({ renderSection, children }: {
  renderSection: (section: TripSection) => ReactNode;
  children?: ReactNode;
}) {
  return <SectionContext.Provider value={renderSection}>{children}</SectionContext.Provider>;
}

export function TripTabSection({ section }: { section: TripSection }) {
  const renderSection = useContext(SectionContext);
  if (!renderSection) throw Error("Holiday sections must be rendered inside the shared TripTab application.");
  return <section id={`panel-${section}`} aria-labelledby={`tab-${section}`}>{renderSection(section)}</section>;
}

export function useTripTabNavigation() {
  const pathname = usePathname();
  const router = useRouter();
  const navigate = useCallback((section: TripSection) => {
    const href = tripSectionHref(section, window.location.search);
    router.push(href);
  }, [router]);
  const replaceEntryUrl = useCallback((href: string) => router.replace(href, { scroll: false }), [router]);
  return { view: tripSectionForPathname(pathname), navigate, replaceEntryUrl };
}

export function useTripTabEntryQuery() {
  return useSearchParams().toString();
}

const icons = { expenses: Receipt, balances: Wallet, receipts: Sparkles, settings: Users, history: History };

export function TripTabNavigation({ receiptCount = 0 }: { receiptCount?: number }) {
  const pathname = usePathname();
  const search = useTripTabEntryQuery();
  const view = tripSectionForPathname(pathname);
  return <nav className="tabs" aria-label="Holiday sections">
    {TRIP_SECTIONS.map(section => {
      const Icon = icons[section.id];
      return <Link
        key={section.id}
        id={`tab-${section.id}`}
        href={tripSectionHref(section.id, search)}
        aria-current={view === section.id ? "page" : undefined}
        className={view === section.id ? "selected" : ""}
      >
        <Icon size={17} aria-hidden="true" />
        <span>{section.label}</span>
        {section.id === "receipts" && receiptCount > 0 && <span className="badge">{receiptCount}</span>}
      </Link>;
    })}
  </nav>;
}
