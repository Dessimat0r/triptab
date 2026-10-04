export const TRIP_SECTIONS = [
  { id: "expenses", href: "/expenses", label: "Expenses" },
  { id: "balances", href: "/balances", label: "Balances" },
  { id: "receipts", href: "/receipts", label: "Receipts" },
  { id: "settings", href: "/travellers", label: "Travellers" },
  { id: "history", href: "/history", label: "History" },
] as const;

export type TripSection = (typeof TRIP_SECTIONS)[number]["id"];

export function tripSectionForPathname(pathname: string | null): TripSection {
  const path = pathname?.replace(/\/+$/, "") || "/";
  return TRIP_SECTIONS.find(section => section.href === path)?.id || "expenses";
}

export function tripSectionHref(section: TripSection, search = ""): string {
  const path = TRIP_SECTIONS.find(candidate => candidate.id === section)!.href;
  const source = new URLSearchParams(search);
  const entry = new URLSearchParams();
  // Keep unfinished invitation and account entry flows usable after a section
  // change or reload. No private ledger information is placed in the URL.
  for (const key of ["invite", "account", "connect"]) {
    const value = source.get(key);
    if (value) entry.set(key, value);
  }
  return entry.size ? `${path}?${entry}` : path;
}
