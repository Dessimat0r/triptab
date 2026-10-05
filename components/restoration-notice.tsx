export type RestorationInfo = { actorName: string; createdAt: string; adjustments: string[] };

export default function RestorationNotice({ info }: { info: RestorationInfo }) {
  const date = new Date(info.createdAt);
  return <section className="account-section" aria-label="Restoration source">
    <h3>Restoring a deleted record</h3>
    <p className="footnote">This snapshot was removed by {info.actorName || "an earlier traveller"}{Number.isFinite(date.getTime()) ? ` on ${date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "long" })}` : ""}. Review its details before saving it again. The new save will appear in activity under your account.</p>
    {info.adjustments.map((adjustment, index) => <p className="notification-status" key={index}>{adjustment}</p>)}
  </section>;
}
