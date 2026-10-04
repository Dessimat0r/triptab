"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import ModalA11y from "@/components/modal-accessibility";
import AccountPanel, { type Profile } from "@/components/account-panel";
import { TripSharing, JoinTrip } from "@/components/trip-sharing";
import {
  Plus,
  Plane,
  Receipt,
  Wallet,
  Users,
  X,
  Upload,
  Sparkles,
  Check,
  RefreshCw,
  Copy,
  Trash2,
  ChevronDown,
  Menu,
  CircleHelp,
  CheckCircle2,
} from "lucide-react";
import {
  balances,
  settlements,
  total,
  expenseTotal,
  expenseShares,
  convertAmount,
  CURRENCIES,
  type Currency,
  type Ledger,
  type Trip,
  type Expense,
  type Draft,
} from "@/lib/model";
const uid = () => crypto.randomUUID();
const today = () => new Date().toISOString().slice(0, 10);
const money = (n: number, c: string) =>
  new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: c,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n / 100);
function Amount({
  value,
  onChange,
  label,
}: {
  value: number;
  onChange: (n: number) => void;
  label: string;
}) {
  const [v, set] = useState((value / 100).toFixed(2));
  return (
    <input
      aria-label={label}
      inputMode="decimal"
      value={v}
      onChange={(e) => {
        const s = e.target.value;
        if (/^\d*(\.\d{0,2})?$/.test(s)) {
          set(s);
          const n = Math.round(Number(s) * 100);
          if (Number.isFinite(n)) onChange(n);
        }
      }}
      onBlur={() => {
        const n = Math.round(Number(v) * 100);
        onChange(Number.isFinite(n) ? n : 0);
        set((n / 100).toFixed(2));
      }}
    />
  );
}
export default function Home() {
  const [ledger, setLedger] = useState<Ledger>({ trips: [] }),
    [revision, setRevision] = useState(0),
    [selected, setSelected] = useState(""),
    [view, setView] = useState("expenses"),
    [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [auth, setAuth] = useState(false),
    [menu, setMenu] = useState(false),
    [create, setCreate] = useState(false),
    [help, setHelp] = useState(false),
    [editing, setEditing] = useState<(Expense & { draftId?: string }) | null>(
      null,
    ),
    [paste, setPaste] = useState(""),
    [uploading, setUploading] = useState(false),
    [fxLoading, setFxLoading] = useState(false),
    [fxError, setFxError] = useState(""),
    [profile, setProfile] = useState<Profile | null>(null),
    [account, setAccount] = useState(false),
    [invite, setInvite] = useState(""),
    [offline, setOffline] = useState(false);
  const trip = ledger.trips.find((t) => t.id === selected) || ledger.trips[0];
  async function load() {
    setLoading(true);
    setError("");
    try {
      const r = await fetch("/api/ledger", { cache: "no-store" }),
        b = (await r.json()) as {
          data: Ledger;
          revision: number;
          error: string;
        };
      if (!r.ok) {
        setAuth(r.status === 401);
        throw Error(b.error);
      }
      setLedger(b.data);
      setRevision(b.revision);
      setAuth(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load your ledger");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    Promise.resolve().then(() => {
      setInvite(new URLSearchParams(location.search).get("invite") || "");
      load();
    });
    fetch("/api/profile")
      .then((r) => r.json())
      .then((b: unknown) => {
        const p = b as Profile & { profile?: Profile };
        if (p.id || p.profile?.id) setProfile(p.profile || p);
      })
      .catch(() => {});
    if ("serviceWorker" in navigator)
      navigator.serviceWorker
        .register("/sw.js", { scope: "/", updateViaCache: "none" })
        .catch(() => {});
    const update = () => setOffline(!navigator.onLine);
    window.addEventListener("offline", update);
    window.addEventListener("online", update);
    Promise.resolve().then(update);
    return () => {
      window.removeEventListener("offline", update);
      window.removeEventListener("online", update);
    };
  }, []);
  async function save(data: Ledger) {
    setSaving(true);
    setError("");
    try {
      const r = await fetch("/api/ledger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data, revision }),
      });
      const b = (await r.json()) as {
        data: Ledger;
        revision: number;
        error: string;
        receiptId: string;
      };
      if (!r.ok) throw Error(b.error);
      setLedger(b.data);
      setRevision(b.revision);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save");
      return false;
    } finally {
      setSaving(false);
    }
  }
  async function updateTrip(next: Trip) {
    return save({
      trips: ledger.trips.map((t) => (t.id === next.id ? next : t)),
    });
  }
  function newExpense() {
    if (!trip) return;
    setPaste("");
    setFxError("");
    setEditing({
      id: uid(),
      title: "",
      date: today(),
      time: new Date().toTimeString().slice(0, 5),
      timezone:
        Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/London",
      currency: trip.currency,
      payer: trip.members[0].id,
      items: [
        {
          id: uid(),
          name: "",
          amount: 0,
          members: trip.members.map((m) => m.id),
        },
      ],
      tax: 0,
      tip: 0,
      discount: 0,
    });
  }
  function openDraft(d: Draft) {
    setPaste("");
    setFxError("");
    setEditing({
      ...d,
      date: d.date || today(),
      time: d.time || "12:00",
      timezone: d.timezone || "Europe/London",
      currency: d.currency || trip!.currency,
      draftId: d.id,
      items: d.items.length
        ? d.items
        : [
            {
              id: uid(),
              name: "",
              amount: 0,
              members: trip!.members.map((m) => m.id),
            },
          ],
    });
  }
  async function upload(file: File) {
    if (!trip) return;
    setUploading(true);
    setError("");
    try {
      if (
        !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
        file.size > 5 * 1024 * 1024
      )
        throw Error("Choose a JPEG, PNG or WebP image under 5 MB.");
      const r = await fetch(
        "/api/receipt?tripId=" + encodeURIComponent(trip.id),
        { method: "POST", headers: { "Content-Type": file.type }, body: file },
      );
      const b = (await r.json()) as {
        data: Ledger;
        revision: number;
        error: string;
        receiptId: string;
      };
      if (!r.ok) throw Error(b.error);
      const d: Draft = {
        id: uid(),
        currency: trip.currency,
        title: file.name,
        receiptId: b.receiptId,
        items: [],
        tax: 0,
        tip: 0,
        discount: 0,
        payer: trip.members[0].id,
        status: "waiting",
      };
      if (await updateTrip({ ...trip, drafts: [...trip.drafts, d] })) {
        setView("receipts");
        setHelp(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }
  async function copyPrompt() {
    const pending = trip?.drafts
      .filter((d) => d.status === "waiting")
      .map((d) => ({ draftId: d.id, receiptId: d.receiptId, title: d.title }));
    const prompt = `Pending receipts: ${JSON.stringify(pending)}. Use the connected TripTab plugin. Call get_trip_ledger, then get_receipt_image for each pending receipt in trip ${trip?.id}. Read the native image and save its items with update_receipt_draft for me to review. Amounts must be integers in hundredths of the original currency, full line totals. Use the currency printed on the receipt. Do not invent unreadable prices or double-count tax included in prices. Assign items to all trip members initially; flag uncertain text. Keep receiptId and draft ID. Never post this as an expense.`;
    try {
      await navigator.clipboard.writeText(prompt);
    } catch {
      setError("Clipboard is unavailable. Use the instructions in this panel.");
    }
  }
  async function submitExpense(e: React.FormEvent) {
    e.preventDefault();
    if (!trip || !editing) return;
    if (
      editing.currency !== trip.currency &&
      !editing.bankAmount &&
      !editing.fx?.rate
    ) {
      setError(
        "Look up a conversion rate or enter the amount your bank charged.",
      );
      return;
    }
    if (editing.bankAmount === 0) {
      setError("The bank charge must be greater than zero.");
      return;
    }
    if (
      !editing.title.trim() ||
      editing.items.some((i) => !i.name.trim() || !i.members.length) ||
      total(editing) <= 0
    ) {
      setError(
        "Add a title, named items, at least one person per item, and a positive total.",
      );
      return;
    }
    const { draftId, ...expense } = editing;
    const exists = trip.expenses.some((x) => x.id === expense.id);
    if (
      await updateTrip({
        ...trip,
        expenses: exists
          ? trip.expenses.map((x) => (x.id === expense.id ? expense : x))
          : [expense, ...trip.expenses],
        drafts: trip.drafts.filter((d) => d.id !== draftId),
      })
    )
      setEditing(null);
  }
  function importItems() {
    try {
      const b = JSON.parse(paste);
      const rows = Array.isArray(b) ? b : b.items;
      if (!Array.isArray(rows) || !rows.length || rows.length > 200)
        throw Error();
      const items = rows.map(
        (r: { name: string; amount: number; members?: string[] }) => {
          if (
            typeof r.name !== "string" ||
            !r.name.trim() ||
            !Number.isInteger(r.amount) ||
            r.amount < 0
          )
            throw Error();
          return {
            id: uid(),
            name: r.name,
            amount: r.amount,
            members:
              r.members?.filter((id) =>
                trip!.members.some((m) => m.id === id),
              ) || trip!.members.map((m) => m.id),
          };
        },
      );
      setEditing({ ...editing!, items });
      setPaste("");
    } catch {
      setError(
        'Use a JSON array with name and amount in cents/pence, for example [{"name":"Lunch","amount":1250}].',
      );
    }
  }
  async function lookupFx() {
    if (!editing || !trip) return;
    setFxLoading(true);
    setFxError("");
    const transaction = editing;
    try {
      const q = new URLSearchParams({
        from: transaction.currency,
        to: trip.currency,
        date: transaction.date,
        time: transaction.time,
        timezone: transaction.timezone,
      });
      const r = await fetch("/api/fx?" + q.toString()),
        b = (await r.json()) as { rate: number; asOf: string; error: string };
      if (!r.ok)
        throw Error(
          b.error ||
            "No historical rate available. Enter a manual rate or your bank charge.",
        );
      setEditing((prev) =>
        prev &&
        prev.currency === transaction.currency &&
        prev.date === transaction.date &&
        prev.time === transaction.time &&
        prev.timezone === transaction.timezone
          ? { ...prev, fx: { rate: b.rate, asOf: b.asOf, source: "reference" } }
          : prev,
      );
    } catch (e) {
      setFxError(e instanceof Error ? e.message : "Rate lookup failed.");
    } finally {
      setFxLoading(false);
    }
  }
  function previewShares(e: Expense, t: Trip) {
    try {
      return total(e) > 0 ? expenseShares(e, t.members, t.currency) : null;
    } catch {
      return null;
    }
  }
  function previewTotal(e: Expense, t: Trip) {
    try {
      return expenseTotal(e, t.currency);
    } catch {
      return null;
    }
  }
  const balance = trip ? balances(trip) : [],
    due = trip ? settlements(trip) : [],
    spent =
      trip?.expenses.reduce((s, e) => s + expenseTotal(e, trip.currency), 0) ||
      0;
  const name = (id: string) =>
    trip?.members.find((m) => m.id === id)?.name || "Unknown";
  return (
    <div className="shell">
      <aside
        id="holiday-sidebar"
        className={"sidebar " + (menu ? "visible" : "")}
      >
        <Link className="brand" href="/">
          <span className="brandmark">
            <Plane size={23} />
          </span>
          TripTab<span className="branddot">.</span>
        </Link>
        <button className="sidebar-close iconbutton" aria-label="Close holiday menu" onClick={()=>setMenu(false)}><X size={20}/></button><div className="side-label">YOUR HOLIDAYS</div>
        <div className="tripnav">
          {ledger.trips.map((t) => (
            <button
              className={trip?.id === t.id ? "active" : ""}
              key={t.id}
              onClick={() => {
                setSelected(t.id);
                setMenu(false);
                setView("expenses");
              }}
            >
              <span className="tripicon">
                <Plane size={17} />
              </span>
              <span>
                {t.name}
                <small>
                  {t.members.length} travellers · {t.currency}
                </small>
              </span>
            </button>
          ))}
        </div>
        <button
          className="newtrip"
          onClick={() => {
            setCreate(true);
            setMenu(false);
          }}
          disabled={loading || auth || saving}
        >
          <Plus size={17} /> New holiday
        </button>
        <div className="side-bottom">
          <div className="account-note">
            <Sparkles size={19} />
            <strong>Your assistant, optionally.</strong>
            <p>
              Connect your own ChatGPT or Codex account to read receipts. Manual
              entry always works.
            </p>
            <button className="textbutton" onClick={() => setHelp(true)}>
              How to connect <CircleHelp size={15} />
            </button>
          </div>
          <button className="personal" onClick={() => setAccount(true)}>
            <span className="avatar">
              {profile?.displayName.slice(0, 1).toUpperCase() || "Y"}
            </span>
            <span>
              {profile?.displayName || "Your account"}
              <small>{profile?.email || "Profile & app settings"}</small>
            </span>
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div>
            <button
              className="mobile-menu iconbutton"
              aria-label="Open holidays"
              aria-expanded={menu}
              aria-controls="holiday-sidebar"
              onClick={() => setMenu(!menu)}
            >
              <Menu />
            </button>
            <span className="breadcrumb">
              Holidays <span>/</span>{" "}
              <b>{trip?.name || "Your next adventure"}</b>
            </span>
          </div>
          <button
            className="mobile-account iconbutton"
            aria-label="Profile and app settings"
            onClick={() => setAccount(true)}
          >
            <span className="avatar">
              {profile?.displayName.slice(0, 1).toUpperCase() || "Y"}
            </span>
          </button>
          <button
            className="quiet"
            aria-label="Refresh ledger"
            onClick={load}
            disabled={saving || loading}
          >
            <RefreshCw size={16} className={loading ? "spin" : ""} />
            <span>Refresh</span>
          </button>
        </header>
        <main>
          {offline && (
            <p className="connection-banner" role="status">
              You’re offline. Keep this screen open—your unsaved edits are still
              here. Reconnect before saving.
            </p>
          )}
          {invite && (
            <JoinTrip
              token={invite}
              onJoined={async (id) => {
                setInvite("");
                history.replaceState(null, "", "/");
                setSelected(id);
                await load();
                fetch("/api/profile")
                  .then((r) => r.json())
                  .then((b: unknown) => {
                    const p = b as Profile & { profile?: Profile };
                    setProfile(p.profile || p);
                  })
                  .catch(() => {});
              }}
            />
          )}
          <div className="page-heading">
            <div>
              <span className="eyebrow">HOLIDAY LEDGER</span>
              <h1>{trip?.name || "Every trip starts together."}</h1>
              <p>
                {trip
                  ? `${trip.members.length} travellers · Settle in ${trip.currency}${trip.startDate ? " · " + new Date(trip.startDate + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : ""}`
                  : "Create a holiday, add your people, and keep the tabs fair."}
              </p>
            </div>
            {trip && (
              <button
                className="primary"
                onClick={newExpense}
                disabled={saving}
              >
                <Plus size={18} /> Add expense
              </button>
            )}
          </div>
          {error && (
            <div className="error" role="alert">
              {error}
              {auth && (
                <a
                  href={
                    "/signin-with-chatgpt?return_to=" +
                    encodeURIComponent(invite ? "/?invite=" + invite : "/")
                  }
                >
                  Sign in with ChatGPT
                </a>
              )}
              {!auth && (
                <button className="textbutton" onClick={load} disabled={saving}>
                  Refresh ledger
                </button>
              )}
            </div>
          )}
          {loading && !trip ? (
            <div className="empty panel">
              <RefreshCw className="spin" />
              <h2>Opening your holiday ledger…</h2>
            </div>
          ) : !trip ? (
            <div className="onboarding panel">
              <div className="large-icon">
                <Plane size={35} />
              </div>
              <h2>A fair share of the good times.</h2>
              <p>
                From the first taxi to the last dinner, track what everyone paid
                and who shared each item.
              </p>
              <button
                className="primary"
                onClick={() => setCreate(true)}
                disabled={auth || loading}
              >
                <Plus size={18} /> Create your first holiday
              </button>
              <div className="intro-features">
                <span>
                  <Receipt size={19} /> Itemised receipts
                </span>
                <span>
                  <Users size={19} /> Split by person
                </span>
                <span>
                  <Wallet size={19} /> Simple settlements
                </span>
              </div>
            </div>
          ) : (
            <>
              <div className="stats">
                <div className="stat">
                  <span>
                    Total trip spend <Receipt size={17} />
                  </span>
                  <strong>{money(spent, trip.currency)}</strong>
                  <small>
                    {trip.expenses.length}{" "}
                    {trip.expenses.length === 1 ? "expense" : "expenses"}{" "}
                    recorded
                  </small>
                </div>
                <div className="stat">
                  <span>
                    Average per traveller <Users size={17} />
                  </span>
                  <strong>
                    {money(
                      Math.round(spent / trip.members.length),
                      trip.currency,
                    )}
                  </strong>
                  <small>Actual shares depend on your items</small>
                </div>
                <div className="stat accent">
                  <span>
                    Still to settle <Wallet size={17} />
                  </span>
                  <strong>
                    {money(
                      due.reduce((s, d) => s + d.amount, 0),
                      trip.currency,
                    )}
                  </strong>
                  <small>
                    {due.length
                      ? `${due.length} suggested ${due.length === 1 ? "payment" : "payments"}`
                      : "Everyone is square"}
                  </small>
                </div>
              </div>
              <div className="tabs" role="tablist" aria-label="Holiday views" onKeyDown={e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;const buttons=Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="tab"]'));const i=buttons.indexOf(document.activeElement as HTMLButtonElement);const n=e.key==='Home'?0:e.key==='End'?buttons.length-1:(i+(e.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;e.preventDefault();buttons[n]?.focus();buttons[n]?.click()}}>
                {[
                  ["expenses", "Expenses", Receipt],
                  ["balances", "Balances", Wallet],
                  ["receipts", "Receipts", Sparkles],
                  ["settings", "Travellers", Users],
                ].map(([id, label, Icon]) => (
                  <button
                    role="tab"
 id={"tab-"+id} aria-controls={"panel-"+id} tabIndex={view===id?0:-1}
                    aria-selected={view === id}
                    className={view === id ? "selected" : ""}
                    key={id as string}
                    onClick={() => setView(id as string)}
                  >
                    {typeof Icon !== "string" && <Icon size={17} />}
                    <span>{label as string}</span>
                    {id === "receipts" && trip.drafts.length > 0 && (
                      <span className="badge">{trip.drafts.length}</span>
                    )}
                  </button>
                ))}
              </div>
              <div className="content-grid">
                <section role="tabpanel" id={"panel-"+view} aria-labelledby={"tab-"+view}>
                  {view === "expenses" && (
                    <>
                      <div className="sectionheading">
                        <h2>Your expenses</h2>
                        <span className="muted">Newest first</span>
                      </div>
                      <div className="panel expense-list">
                        {trip.expenses.length ? (
                          trip.expenses.map((e) => (
                            <button
                              className="expense"
                              key={e.id}
                              onClick={() => {
                                setPaste("");
                                setEditing(e);
                              }}
                            >
                              <span className="expense-icon">
                                <Receipt size={22} />
                              </span>
                              <span className="expense-details">
                                <b>{e.title}</b>
                                <span>
                                  {name(e.payer)} paid · {e.items.length}{" "}
                                  {e.items.length === 1 ? "item" : "items"}
                                </span>
                                <small>
                                  {new Date(
                                    e.date + "T12:00:00",
                                  ).toLocaleDateString("en-GB", {
                                    day: "numeric",
                                    month: "short",
                                    year: "numeric",
                                  })}{" "}
                                  · {e.time} ·{" "}
                                  {e.bankAmount !== undefined
                                    ? "Bank charge"
                                    : e.currency !== trip.currency
                                      ? "Reference estimate"
                                      : "Paid"}
                                </small>
                              </span>
                              <span className="expense-amount">
                                <b>
                                  {money(
                                    expenseTotal(e, trip.currency),
                                    trip.currency,
                                  )}
                                </b>
                                <small>
                                  {e.currency !== trip.currency
                                    ? money(total(e), e.currency) + " original"
                                    : "Edit split"}
                                </small>
                              </span>
                            </button>
                          ))
                        ) : (
                          <div className="empty">
                            <Receipt size={30} />
                            <h3>No tabs yet</h3>
                            <p>Add a shared expense or start with a receipt.</p>
                            <button className="quiet" onClick={newExpense}>
                              <Plus size={16} /> Add the first expense
                            </button>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                  {view === "balances" && (
                    <>
                      <div className="sectionheading">
                        <h2>Settle up</h2>
                        <span className="muted">Suggested transfers</span>
                      </div>
                      <div className="panel">
                        {due.length ? (
                          due.map((d, i) => (
                            <div className="settlement" key={i}>
                              <div>
                                <strong>{name(d.from)}</strong>
                                <span> pays {name(d.to)}</span>
                              </div>
                              <b>{money(d.amount, trip.currency)}</b>
                              <button
                                className="quiet"
                                disabled={saving}
                                onClick={() =>
                                  updateTrip({
                                    ...trip,
                                    payments: [
                                      ...trip.payments,
                                      { id: uid(), ...d, date: today() },
                                    ],
                                  })
                                }
                              >
                                <Check size={16} /> Record paid
                              </button>
                            </div>
                          ))
                        ) : (
                          <div className="empty">
                            <CheckCircle2 size={30} />
                            <h3>All square</h3>
                            <p>
                              Everyone’s recorded payments and shares balance
                              out.
                            </p>
                          </div>
                        )}
                      </div>
                      <p className="footnote">
                        Record a payment after the money has been transferred.
                        TripTab does not move money.
                      </p>
                      {trip.payments.length > 0 && (
                        <>
                          <h2 className="subheading">Recorded payments</h2>
                          <div className="panel">
                            {trip.payments.map((p) => (
                              <div className="payment" key={p.id}>
                                <span>
                                  {name(p.from)} paid {name(p.to)}
                                  <small>{p.date}</small>
                                </span>
                                <b>{money(p.amount, trip.currency)}</b>
                                <button
                                  aria-label="Undo recorded payment"
                                  className="iconbutton"
                                  disabled={saving}
                                  onClick={() =>
                                    updateTrip({
                                      ...trip,
                                      payments: trip.payments.filter(
                                        (x) => x.id !== p.id,
                                      ),
                                    })
                                  }
                                >
                                  <Trash2 size={17} />
                                </button>
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </>
                  )}
                  {view === "receipts" && (
                    <>
                      <div className="sectionheading">
                        <h2>Receipt inbox</h2>
                        <label className="quiet upload-label">
                          <Upload size={16} />
                          {uploading ? "Uploading…" : "Add receipt"}
                          <input
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            capture="environment"
                            disabled={uploading || saving}
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) upload(f);
                              e.target.value = "";
                            }}
                          />
                        </label>
                      </div>
                      <div className="panel">
                        {trip.drafts.length ? (
                          trip.drafts.map((d) => (
                            <div className="draft" key={d.id}>
                              {d.receiptId ? (
                                <img
                                  src={"/api/receipt?id=" + d.receiptId}
                                  alt="Receipt thumbnail"
                                />
                              ) : (
                                <span className="expense-icon">
                                  <Receipt />
                                </span>
                              )}
                              <div>
                                <b>{d.title}</b>
                                <small
                                  className={
                                    d.status === "review" ? "ready" : "muted"
                                  }
                                >
                                  {d.status === "review"
                                    ? "Ready to review"
                                    : "Awaiting itemisation"}{" "}
                                  · {d.items.length} items · {d.currency}
                                </small>
                              </div>
                              <button
                                className="quiet"
                                onClick={() => openDraft(d)}
                              >
                                Review
                              </button>
                              <button
                                className="iconbutton"
                                aria-label="Remove draft"
                                disabled={saving}
                                onClick={() =>
                                  updateTrip({
                                    ...trip,
                                    drafts: trip.drafts.filter(
                                      (x) => x.id !== d.id,
                                    ),
                                  })
                                }
                              >
                                <X size={17} />
                              </button>
                            </div>
                          ))
                        ) : (
                          <div className="empty">
                            <Sparkles size={30} />
                            <h3>Receipts, without the retyping</h3>
                            <p>
                              Upload a photo, ask your connected assistant to
                              read it, then check each item here.
                            </p>
                            <button
                              className="quiet"
                              onClick={() => setHelp(true)}
                            >
                              Connect ChatGPT or Codex
                            </button>
                          </div>
                        )}
                      </div>
                      <p className="footnote">
                        JPEG, PNG or WebP · Up to 5 MB · You approve every
                        split.
                      </p>
                    </>
                  )}
                  {view === "settings" && (
                    <>
                      <div className="sectionheading">
                        <h2>Your travellers</h2>
                        <span className="muted">
                          {trip.members.length} people
                        </span>
                      </div>
                      <div className="panel members">
                        {trip.members.map((m, i) => (
                          <div className="member" key={m.id}>
                            <span className={"avatar color" + (i % 5)}>
                              {m.name.slice(0, 1).toUpperCase()}
                            </span>
                            <b>{m.name}</b>
                            <span className="member-account">
                              {m.email || "Not linked"}
                              <small>
                                {m.userId
                                  ? "Account connected"
                                  : "Invite to join"}
                              </small>
                            </span>
                          </div>
                        ))}
                        <form
                          className="add-member"
                          onSubmit={async (e) => {
                            e.preventDefault();
                            const f = e.currentTarget;
                            const n = (
                              new FormData(f).get("name") as string
                            ).trim();
                            if (
                              n &&
                              (await updateTrip({
                                ...trip,
                                members: [
                                  ...trip.members,
                                  { id: uid(), name: n },
                                ],
                              }))
                            )
                              f.reset();
                          }}
                        >
                          <input
                            name="name"
                            placeholder="Traveller’s name"
                            required
                            maxLength={50}
                            aria-label="New traveller name"
                          />
                          <button
                            className="quiet"
                            disabled={saving || trip.members.length >= 50}
                          >
                            <Plus size={17} /> Add
                          </button>
                        </form>
                      </div>
                      <TripSharing trip={trip} profile={profile} />
                      <div className="panel settingspanel">
                        <h3>Holiday details</h3>
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            const data = new FormData(e.currentTarget);
                            updateTrip({
                              ...trip,
                              name: (data.get("name") as string).trim(),
                            });
                          }}
                        >
                          <label>
                            Holiday name
                            <input
                              name="name"
                              defaultValue={trip.name}
                              key={trip.id}
                              required
                              maxLength={100}
                            />
                          </label>
                          <button className="quiet" disabled={saving}>
                            Save name
                          </button>
                        </form>
                        <p className="footnote">
                          Settle in {trip.currency}. Each expense keeps its
                          original currency and transaction time; enter your
                          bank’s charge for an exact reimbursement.
                        </p>
                      </div>
                    </>
                  )}
                </section>
                <aside className="right-rail">
                  <div className="panel balance-card">
                    <div className="sectionheading">
                      <h2>The group balance</h2>
                      <Users size={18} />
                    </div>
                    {trip.members.map((m, i) => (
                      <div className="balance-row" key={m.id}>
                        <span className={"avatar color" + (i % 5)}>
                          {m.name.slice(0, 1).toUpperCase()}
                        </span>
                        <span>
                          {m.name}
                          <small>
                            {balance[i] > 0
                              ? "Gets back"
                              : balance[i] < 0
                                ? "Owes"
                                : "Settled"}
                          </small>
                        </span>
                        <b
                          className={
                            balance[i] > 0
                              ? "positive"
                              : balance[i] < 0
                                ? "negative"
                                : "muted"
                          }
                        >
                          {money(Math.abs(balance[i]), trip.currency)}
                        </b>
                      </div>
                    ))}
                    <button
                      className="wide quiet"
                      onClick={() => setView("balances")}
                    >
                      View settlements
                    </button>
                  </div>
                  <div className="receipt-card">
                    <span className="mini-tag">
                      <Sparkles size={14} /> WITH YOUR ASSISTANT
                    </span>
                    <h3>
                      Snap it.
                      <br />
                      Check it. Split it.
                    </h3>
                    <p>A shared dinner doesn’t have to mean an equal bill.</p>
                    <label className="primary upload-label">
                      <Upload size={17} />
                      {uploading ? "Uploading…" : "Upload receipt"}
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        capture="environment"
                        disabled={uploading || saving}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) upload(f);
                          e.target.value = "";
                        }}
                      />
                    </label>
                    <button
                      className="textbutton"
                      onClick={() => setHelp(true)}
                    >
                      How it works
                    </button>
                  </div>
                </aside>
              </div>
            </>
          )}
          <footer>
            <span>TripTab</span>
            <span>
              {saving
                ? "Saving…"
                : trip
                  ? "Shared holiday ledger, saved securely."
                  : "Good trips. Fair tabs."}
            </span>
          </footer>
        </main>
      </div>
      {create && (
        <ModalA11y className="overlay" onClose={() => setCreate(false)}>
          <section
            className="modal small"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-title"
          >
            <div className="modalheading">
              <div>
                <span className="eyebrow">A NEW ADVENTURE</span>
                <h2 id="create-title">Create a holiday</h2>
              </div>
              <button
                className="iconbutton"
                aria-label="Close"
                onClick={() => setCreate(false)}
              >
                <X />
              </button>
            </div>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const names = (f.get("members") as string)
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean);
                if (
                  !names.length ||
                  names.length > 50 ||
                  names.some((n) => n.length > 50)
                ) {
                  setError(
                    "Add between 1 and 50 travellers, with each name under 50 characters.",
                  );
                  return;
                }
                const t: Trip = {
                  id: uid(),
                  name: (f.get("name") as string).trim(),
                  currency: f.get("currency") as Currency,
                  startDate: (f.get("startDate") as string) || undefined,
                  endDate: (f.get("endDate") as string) || undefined,
                  members: names.map((name) => ({ id: uid(), name })),
                  expenses: [],
                  drafts: [],
                  payments: [],
                };
                if (await save({ trips: [...ledger.trips, t] })) {
                  setSelected(t.id);
                  setView("expenses");
                  setCreate(false);
                }
              }}
            >
              <label>
                Holiday name
                <input
                  name="name"
                  placeholder="A week in Lisbon"
                  required
                  maxLength={100}
                  autoFocus
                />
              </label>
              <label>
                Travellers
                <textarea
                  name="members"
                  placeholder="You, Alex, Sam, Jo"
                  required
                />
                <small>Separate names with commas. List yourself first.</small>
              </label>
              <div className="fieldpair">
                <label>
                  Start date <span className="muted">optional</span>
                  <input type="date" name="startDate" />
                </label>
                <label>
                  End date <span className="muted">optional</span>
                  <input type="date" name="endDate" />
                </label>
              </div>
              <label>
                Settle in
                <select name="currency" defaultValue="GBP">
                  {CURRENCIES.map((c) => (
                    <option value={c.code} key={c.code}>
                      {c.name} · {c.code}
                    </option>
                  ))}
                </select>
              </label>
              {error && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
              <button className="primary wide" disabled={saving}>
                {saving ? "Saving…" : "Create holiday"}
              </button>
            </form>
          </section>
        </ModalA11y>
      )}
      {help && (
        <ModalA11y className="overlay" onClose={() => setHelp(false)}>
          <section
            className="modal small"
            role="dialog"
            aria-modal="true"
            aria-labelledby="help-title"
          >
            <div className="modalheading">
              <div>
                <span className="eyebrow">
                  YOUR OWN CHATGPT OR CODEX ACCOUNT
                </span>
                <h2 id="help-title">Connect ChatGPT or Codex</h2>
              </div>
              <button
                className="iconbutton"
                aria-label="Close"
                onClick={() => setHelp(false)}
              >
                <X />
              </button>
            </div>
            <ol className="steps">
              <li>
                <strong>Install the TripTab plugin</strong>
                <p>
                  In ChatGPT or Codex, open Plugins → Personal → Created by you,
                  then install or connect TripTab.
                </p>
              </li>
              <li>
                <strong>Upload your receipt here</strong>
                <p>
                  Use a clear JPEG, PNG or WebP. Your assistant can read it
                  through the plugin, or you can attach the original image in
                  chat.
                </p>
              </li>
              <li>
                <strong>Ask your assistant to itemise it</strong>
                <p>
                  “Read my pending TripTab receipt and save the items as a draft
                  for review.” You can also describe an expense or ask it to set
                  up a holiday.
                </p>
              </li>
              <li>
                <strong>Refresh and check your split</strong>
                <p>
                  Review prices, assign each item, then save the expense.
                  Nothing is posted automatically.
                </p>
              </li>
            </ol>
            <button className="primary wide" onClick={copyPrompt}>
              <Copy size={17} /> Copy receipt-reading prompt
            </button>
            <p className="footnote">
              Connection is optional. Receipt reading runs in your chat using
              your account. This website cannot run Codex directly through your
              subscription. You can always enter items yourself.
            </p>
          </section>
        </ModalA11y>
      )}
      {editing && trip && (
        <ModalA11y
          className="overlay editor-overlay"
          onClose={() => setEditing(null)}
        >
          <section
            className="modal editor"
            role="dialog"
            aria-modal="true"
            aria-labelledby="expense-title"
          >
            <form onSubmit={submitExpense}>
              <div className="modalheading">
                <div>
                  <span className="eyebrow">MAKE EVERY ITEM FAIR</span>
                  <h2 id="expense-title">
                    {editing.draftId
                      ? "Review receipt"
                      : trip.expenses.some((e) => e.id === editing.id)
                        ? "Edit expense"
                        : "Add an expense"}
                  </h2>
                </div>
                <button
                  type="button"
                  className="iconbutton"
                  aria-label="Close editor"
                  onClick={() => setEditing(null)}
                >
                  <X />
                </button>
              </div>
              <div
                className={
                  "editor-body " + (editing.receiptId ? "with-receipt" : "")
                }
              >
                {editing.receiptId && (
                  <div className="receipt-preview">
                    <img
                      src={"/api/receipt?id=" + editing.receiptId}
                      alt="Original receipt for review"
                    />
                    <a
                      href={"/api/receipt?id=" + editing.receiptId}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open original receipt
                    </a>
                  </div>
                )}
                <div className="edit-fields">
                  <label>
                    Expense name
                    <input
                      value={editing.title}
                      required
                      maxLength={200}
                      placeholder="Dinner by the harbour"
                      onChange={(e) =>
                        setEditing({ ...editing, title: e.target.value })
                      }
                    />
                  </label>
                  <div className="fieldpair">
                    <label>
                      Paid by
                      <select
                        value={editing.payer}
                        onChange={(e) =>
                          setEditing({ ...editing, payer: e.target.value })
                        }
                      >
                        {trip.members.map((m) => (
                          <option value={m.id} key={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Date
                      <input
                        type="date"
                        required
                        value={editing.date}
                        onChange={(e) =>
                          setEditing({
                            ...editing,
                            date: e.target.value,
                            fx: undefined,
                          })
                        }
                      />
                    </label>
                  </div>
                  <div className="fieldpair">
                    <label>
                      Original currency
                      <select
                        value={editing.currency}
                        onChange={(e) => {
                          setFxError("");
                          setEditing({
                            ...editing,
                            currency: e.target.value as Currency,
                            fx: undefined,
                            bankAmount: undefined,
                          });
                        }}
                      >
                        {CURRENCIES.map((c) => (
                          <option value={c.code} key={c.code}>
                            {c.code} · {c.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Transaction time
                      <input
                        type="time"
                        required
                        value={editing.time}
                        onChange={(e) =>
                          setEditing({
                            ...editing,
                            time: e.target.value,
                            fx: undefined,
                          })
                        }
                      />
                    </label>
                  </div>
                  <label>
                    Transaction time zone
                    <select
                      value={editing.timezone}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          timezone: e.target.value,
                          fx: undefined,
                        })
                      }
                    >
                      {Array.from(
                        new Set([
                          editing.timezone,
                          "Europe/London",
                          "Europe/Paris",
                          "Europe/Berlin",
                          "Europe/Rome",
                          "Europe/Madrid",
                          "Europe/Lisbon",
                          "Europe/Prague",
                          "Europe/Budapest",
                          "Europe/Warsaw",
                          "Europe/Athens",
                          "Europe/Bucharest",
                          "Europe/Zurich",
                          "Europe/Stockholm",
                          "Europe/Oslo",
                          "Europe/Copenhagen",
                          "Atlantic/Reykjavik",
                          "Europe/Istanbul",
                          "UTC",
                        ]),
                      ).map((z) => (
                        <option value={z} key={z}>
                          {z.replaceAll("_", " ")}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="itemsheading">
                    <h3>Items</h3>
                    <span className="muted">
                      Full line total · {editing.currency}
                    </span>
                  </div>
                  <p className="itemhint">
                    Tap the travellers who shared each item.
                  </p>
                  <div className="items">
                    {editing.items.map((item, i) => (
                      <div className="item" key={item.id}>
                        <div className="item-top">
                          <span className="itemnumber">{i + 1}</span>
                          <input
                            aria-label={"Item " + (i + 1) + " name"}
                            placeholder="Item name"
                            value={item.name}
                            required
                            maxLength={200}
                            onChange={(e) =>
                              setEditing({
                                ...editing,
                                items: editing.items.map((x) =>
                                  x.id === item.id
                                    ? { ...x, name: e.target.value }
                                    : x,
                                ),
                              })
                            }
                          />
                          <div className="moneyinput">
                            <Amount
                              label={"Item " + (i + 1) + " total"}
                              value={item.amount}
                              onChange={(amount) =>
                                setEditing(
                                  (prev) =>
                                    prev && {
                                      ...prev,
                                      items: prev.items.map((x) =>
                                        x.id === item.id ? { ...x, amount } : x,
                                      ),
                                    },
                                )
                              }
                            />
                          </div>
                          <button
                            type="button"
                            className="iconbutton"
                            aria-label={"Remove item " + (i + 1)}
                            disabled={editing.items.length === 1}
                            onClick={() =>
                              setEditing({
                                ...editing,
                                items: editing.items.filter(
                                  (x) => x.id !== item.id,
                                ),
                              })
                            }
                          >
                            <X size={17} />
                          </button>
                        </div>
                        <div className="personchips">
                          {trip.members.map((m, n) => (
                            <button
                              type="button"
                              key={m.id}
                              className={
                                item.members.includes(m.id) ? "chosen" : ""
                              }
                              aria-pressed={item.members.includes(m.id)}
                              onClick={() =>
                                setEditing({
                                  ...editing,
                                  items: editing.items.map((x) =>
                                    x.id === item.id
                                      ? {
                                          ...x,
                                          members: x.members.includes(m.id)
                                            ? x.members.filter(
                                                (id) => id !== m.id,
                                              )
                                            : [...x.members, m.id],
                                        }
                                      : x,
                                  ),
                                })
                              }
                            >
                              <span className={"chipavatar color" + (n % 5)}>
                                {m.name.slice(0, 1).toUpperCase()}
                              </span>
                              {m.name}
                              {item.members.includes(m.id) && (
                                <Check size={13} />
                              )}
                            </button>
                          ))}
                        </div>
                        {!item.members.length && (
                          <small className="negative">
                            Choose at least one traveller.
                          </small>
                        )}
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="quiet additem"
                    disabled={editing.items.length >= 200}
                    onClick={() =>
                      setEditing({
                        ...editing,
                        items: [
                          ...editing.items,
                          {
                            id: uid(),
                            name: "",
                            amount: 0,
                            members: trip.members.map((m) => m.id),
                          },
                        ],
                      })
                    }
                  >
                    <Plus size={16} /> Add item
                  </button>
                  <div className="adjustments">
                    {(["tax", "tip", "discount"] as const).map((k) => (
                      <label key={k}>
                        {k === "tax"
                          ? "Added tax"
                          : k === "tip"
                            ? "Tip / service"
                            : "Discount"}
                        <Amount
                          label={k}
                          value={editing[k]}
                          onChange={(v) =>
                            setEditing((prev) => prev && { ...prev, [k]: v })
                          }
                        />
                      </label>
                    ))}
                  </div>
                  <p className="footnote">
                    Tax, tip and discount are shared in proportion to each
                    person’s items. Add tax only if it isn’t already in the item
                    prices.
                  </p>
                  <details className="import">
                    <summary>
                      Paste itemised data <ChevronDown size={15} />
                    </summary>
                    <p>
                      JSON with amounts in cents/pence, e.g.{" "}
                      {`[{"name":"Lunch","amount":1250}]`}
                    </p>
                    <textarea
                      aria-label="Itemised JSON"
                      value={paste}
                      onChange={(e) => setPaste(e.target.value)}
                      placeholder="Paste the items from your assistant"
                    />
                    <button
                      type="button"
                      className="quiet"
                      onClick={importItems}
                    >
                      Import items
                    </button>
                  </details>
                  {editing.currency !== trip.currency && (
                    <div className="fx-panel">
                      <div className="sectionheading">
                        <h3>What did the bank charge?</h3>
                        <span className="currency-pair">
                          {editing.currency} / {trip.currency}
                        </span>
                      </div>
                      <p className="footnote">
                        Compare a reference estimate with the charge on your
                        card statement.
                      </p>
                      <button
                        type="button"
                        className="quiet wide"
                        disabled={fxLoading}
                        onClick={lookupFx}
                      >
                        <RefreshCw
                          size={16}
                          className={fxLoading ? "spin" : ""}
                        />
                        {fxLoading
                          ? "Finding rate…"
                          : "Look up historical rate"}
                      </button>
                      {fxError && <p className="error">{fxError}</p>}
                      {editing.fx && (
                        <div className="rate-result">
                          <span>
                            1 {editing.currency} = {editing.fx.rate.toFixed(5)}{" "}
                            {trip.currency}
                          </span>
                          <small>
                            {editing.fx.source === "reference"
                              ? "Daily reference rate"
                              : "Manual rate"}{" "}
                            · {editing.fx.asOf}
                          </small>
                          <strong>
                            Estimated charge{" "}
                            {money(
                              convertAmount(total(editing), editing.fx.rate),
                              trip.currency,
                            )}
                          </strong>
                        </div>
                      )}
                      <details className="manual-rate">
                        <summary>Enter a conversion rate yourself</summary>
                        <label>
                          1 {editing.currency} in {trip.currency}
                          <input
                            type="number"
                            inputMode="decimal"
                            min="0.00000001"
                            max="100000000"
                            step="any"
                            value={editing.fx?.rate || ""}
                            onChange={(e) => {
                              const rate = Number(e.target.value);
                              setEditing({
                                ...editing,
                                fx:
                                  rate > 0
                                    ? {
                                        rate,
                                        asOf: editing.date,
                                        source: "manual",
                                      }
                                    : undefined,
                              });
                            }}
                          />
                        </label>
                      </details>
                      <label className="checklabel">
                        <input
                          type="checkbox"
                          checked={editing.bankAmount !== undefined}
                          onChange={(e) =>
                            setEditing({
                              ...editing,
                              bankAmount: e.target.checked ? 0 : undefined,
                            })
                          }
                        />
                        Use the actual bank charge
                      </label>
                      {editing.bankAmount !== undefined && (
                        <label>
                          Amount charged in {trip.currency}
                          <Amount
                            label="Actual bank charge"
                            value={editing.bankAmount}
                            onChange={(bankAmount) =>
                              setEditing(
                                (prev) => prev && { ...prev, bankAmount },
                              )
                            }
                          />
                        </label>
                      )}
                      {editing.bankAmount !== undefined && editing.fx && (
                        <p className="bank-diff">
                          Conversion cost vs reference:{" "}
                          <b>
                            {money(
                              editing.bankAmount -
                                convertAmount(total(editing), editing.fx.rate),
                              trip.currency,
                            )}{" "}
                            ·{" "}
                            {total(editing) * editing.fx.rate > 0
                              ? (
                                  ((editing.bankAmount -
                                    convertAmount(
                                      total(editing),
                                      editing.fx.rate,
                                    )) /
                                    convertAmount(
                                      total(editing),
                                      editing.fx.rate,
                                    )) *
                                  100
                                ).toFixed(2)
                              : "0.00"}
                            %
                          </b>
                          <small>
                            Estimated fees and exchange-rate markup combined.
                          </small>
                        </p>
                      )}
                      <p className="footnote">
                        Daily reference rates are not intraday card rates. Your
                        transaction time is saved; the bank may use a later
                        processing date and add fees. The actual bank charge
                        takes priority.
                      </p>
                    </div>
                  )}
                  <div className="split-preview">
                    <h3>Who pays what · {trip.currency}</h3>
                    {trip.members.map((m, i) => (
                      <div key={m.id}>
                        <span>{m.name}</span>
                        <b>
                          {previewShares(editing, trip)?.[i] === undefined
                            ? "—"
                            : money(
                                previewShares(editing, trip)![i],
                                trip.currency,
                              )}
                        </b>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              {error && (
                <div className="error" role="alert">
                  {error}
                </div>
              )}
              <div className="editor-footer">
                <div>
                  <small>Original receipt total</small>
                  <strong>{money(total(editing), editing.currency)}</strong>
                  {editing.currency !== trip.currency &&
                    (editing.bankAmount !== undefined || editing.fx?.rate) && (
                      <small>
                        {money(previewTotal(editing, trip) || 0, trip.currency)}{" "}
                        to split
                      </small>
                    )}
                </div>
                <div className="footer-actions">
                  {trip.expenses.some((e) => e.id === editing.id) && (
                    <button
                      type="button"
                      className="danger quiet"
                      disabled={saving}
                      onClick={async () => {
                        if (
                          await updateTrip({
                            ...trip,
                            expenses: trip.expenses.filter(
                              (x) => x.id !== editing.id,
                            ),
                          })
                        )
                          setEditing(null);
                      }}
                    >
                      <Trash2 size={16} />
                      <span>Delete</span>
                    </button>
                  )}
                  <button
                    className="primary"
                    disabled={
                      saving ||
                      fxLoading ||
                      editing.bankAmount === 0 ||
                      editing.items.some((i) => !i.members.length) ||
                      total(editing) <= 0 ||
                      (editing.currency !== trip.currency &&
                        editing.bankAmount === undefined &&
                        !editing.fx?.rate)
                    }
                  >
                    {saving ? "Saving…" : "Save expense"}
                  </button>
                </div>
              </div>
            </form>
          </section>
        </ModalA11y>
      )}
      {account && (
        <AccountPanel
          profile={profile}
          onClose={() => setAccount(false)}
          onSaved={(p) => {
            setProfile(p);
            setAccount(false);
          }}
        />
      )}
    </div>
  );
}
