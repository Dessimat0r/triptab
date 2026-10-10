
import { t as uiText } from "@/lib/ui-language";
import { formatInstant } from "@/lib/dates";
export type RestorationInfo = { actorName: string; createdAt: string; adjustments: string[] };

export default function RestorationNotice({ info }: { info: RestorationInfo }) {
  const date = new Date(info.createdAt);
  return <section className="account-section" aria-label={uiText("Restoration source")}>
    <h3>{uiText("Restoring a deleted record")}</h3>
    <p className="footnote">{uiText("This snapshot was removed by ")}{info.actorName || "an earlier traveller"}{Number.isFinite(date.getTime()) ? ` on ${formatInstant(date)}` : ""}{uiText(". Review its details before saving it again. The new save will appear in activity under your account.")}</p>
    {info.adjustments.map((adjustment, index) => <p className="notification-status" key={index}>{adjustment}</p>)}
  </section>;
}
