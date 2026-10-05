import { notFound } from "next/navigation";

// Give unmatched URLs a root-only route boundary. The framework's unmatched
// fallback otherwise inherits the ledger group's client application layout.
export default function MissingPage() {
  notFound();
}
