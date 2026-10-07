"use client";

import { useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Utensils, UtensilsCrossed, CookingPot, ChefHat, Sandwich, Pizza, Beef, Fish,
  Salad, Soup, Croissant, CakeSlice, IceCreamBowl, Candy, Apple, Carrot, Coffee,
  CupSoda, Beer, Wine, Martini, GlassWater, Milk, BottleWine, Plane, Car, Bus,
  TrainFront, TramFront, Ship, Sailboat, Bike, Footprints, Fuel, ParkingCircle,
  CableCar, Ticket, MapPin, Hotel, BedDouble, House, Building2, Tent, Caravan,
  KeyRound, Bath, ShowerHead, WashingMachine, Camera, Mountain, Palmtree, Waves,
  Volleyball, Dumbbell, Music, Theater, Landmark, FerrisWheel, Drama, PartyPopper,
  Gamepad2, BookOpen, Compass, Sun, Umbrella, Backpack, Binoculars, ShoppingBag,
  ShoppingCart, Shirt, Watch, Gift, Gem, Store, Smartphone, Headphones, HeartPulse,
  Pill, Cross, Hospital, Stethoscope, Baby, Accessibility, Receipt, Wallet,
  CreditCard, Banknote, Coins, BadgePoundSterling, BadgeEuro, HandCoins, Luggage,
  Dog, Sparkles, Scissors, Wifi, Plug, Wrench, Package, CircleHelp, Check, X,
} from "lucide-react";
import ModalA11y from "@/components/modal-accessibility";
import { ICON_CATALOG, ICON_BACKGROUNDS, resolveExpenseIcon,
  iconLabel, iconSearchText, type ExpenseIconChoice, type IconReceipt } from "@/lib/expense-icons";
import "./expense-icon.css";

const SYMBOLS = {
  Utensils, UtensilsCrossed, CookingPot, ChefHat, Sandwich, Pizza, Beef, Fish,
  Salad, Soup, Croissant, CakeSlice, IceCreamBowl, Candy, Apple, Carrot, Coffee,
  CupSoda, Beer, Wine, Martini, GlassWater, Milk, BottleWine, Plane, Car, Bus,
  TrainFront, TramFront, Ship, Sailboat, Bike, Footprints, Fuel, ParkingCircle,
  CableCar, Ticket, MapPin, Hotel, BedDouble, House, Building2, Tent, Caravan,
  KeyRound, Bath, ShowerHead, WashingMachine, Camera, Mountain, Palmtree, Waves,
  Volleyball, Dumbbell, Music, Theater, Landmark, FerrisWheel, Drama, PartyPopper,
  Gamepad2, BookOpen, Compass, Sun, Umbrella, Backpack, Binoculars, ShoppingBag,
  ShoppingCart, Shirt, Watch, Gift, Gem, Store, Smartphone, Headphones, HeartPulse,
  Pill, Cross, Hospital, Stethoscope, Baby, Accessibility, Receipt, Wallet,
  CreditCard, Banknote, Coins, BadgePoundSterling, BadgeEuro, HandCoins, Luggage,
  Dog, Sparkles, Scissors, Wifi, Plug, Wrench, Package, CircleHelp,
};
const GROUPS = [...new Set(ICON_CATALOG.map(icon => icon[2]))];

export function ExpenseIconBadge({ entry, size = 23 }: { entry: IconReceipt; size?: number }) {
  const {title,items,icon,suggestedIcon} = entry, titleSource = entry.titleSource ?? entry.fieldSources?.title;
  const choice = useMemo(() => resolveExpenseIcon({title,items,icon,suggestedIcon,titleSource}), [title,items,icon,suggestedIcon,titleSource]), Symbol = SYMBOLS[choice.symbol];
  const background = ICON_BACKGROUNDS.find(color => color[0] === choice.background)![2];
  return <span className="expense-icon expense-symbol" style={{ backgroundColor: background, color: "#fff" }} aria-hidden="true">
    <Symbol size={size} strokeWidth={2.2} />
  </span>;
}

export default function ExpenseIconPicker({ entry, onChange, disabled, showLabel = false }: {
  entry: IconReceipt;
  onChange: (icon: ExpenseIconChoice | undefined) => void | Promise<boolean>;
  disabled?: boolean;
  showLabel?: boolean;
}) {
  const {title,items,suggestedIcon} = entry, titleSource = entry.titleSource ?? entry.fieldSources?.title;
  const suggested = useMemo(() => resolveExpenseIcon({title,items,suggestedIcon,titleSource}), [title,items,suggestedIcon,titleSource]);
  const receiptSuggestion = suggestedIcon !== undefined && suggested === suggestedIcon;
  const resolved = entry.icon || suggested;
  const [open, setOpen] = useState(false), [choice, setChoice] = useState(resolved);
  const [automatic, setAutomatic] = useState(!entry.icon), [search, setSearch] = useState("");
  const [group, setGroup] = useState("All"), [pending, setPending] = useState(false), [error, setError] = useState("");
  const id = useId(), shown = automatic ? suggested : choice;
  const visible = !open ? [] : ICON_CATALOG.filter(icon => (group === "All" || icon[2] === group)
    && iconSearchText(`${icon[1]} ${icon[2]} ${icon[3]}`).includes(iconSearchText(search)));
  function close() { if (!pending) setOpen(false); }
  async function apply() {
    setPending(true); setError("");
    try {
      const saved = await onChange(automatic ? undefined : choice);
      if (saved === false) setError("The icon could not be saved. Close this picker to check the expense and try again.");
      else setOpen(false);
    } catch { setError("The icon could not be saved. Please try again."); }
    finally { setPending(false); }
  }
  return <>
    <button type="button" className={`expense-icon-trigger${showLabel ? " expense-icon-labelled" : ""}`}
      aria-label={`Choose icon for ${entry.title || "this receipt"}. ${entry.icon ? "Selected" : "Automatic"}: ${iconLabel(resolved)}`}
      aria-haspopup="dialog" disabled={disabled}
      onClick={() => { setChoice(resolved); setAutomatic(!entry.icon); setSearch(""); setGroup("All"); setError(""); setOpen(true); }}>
      <ExpenseIconBadge entry={{ icon: resolved }} />
      {showLabel && <span><b>Icon & background</b><small>{entry.icon ? iconLabel(entry.icon) : `Automatic · ${iconLabel(suggested)}`}</small></span>}
    </button>
    {open && createPortal(<ModalA11y className="overlay icon-picker-overlay" onClose={close}>
      <section className="modal icon-picker" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
        <div className="modalheading"><h2 id={`${id}-title`}>Choose an icon</h2>
          <button type="button" className="iconbutton" aria-label="Close icon picker" disabled={pending} onClick={close}><X /></button>
        </div>
        <div className="icon-picker-preview"><ExpenseIconBadge entry={{ icon: shown }} size={30} />
          <div><b>{iconLabel(shown)}</b><small>{automatic ? receiptSuggestion ? "Suggested from the receipt reading" : "Suggested from this receipt" : "Your choice"}</small></div>
          <button type="button" className="quiet" aria-pressed={automatic} disabled={pending || disabled}
            onClick={() => { setAutomatic(true); setChoice(suggested); }}>Automatic{automatic && <Check size={16} aria-hidden="true" />}</button>
        </div>
        <p className="footnote">Automatic follows the expense name and receipt items. Your choice stays until you change it.</p>
        <fieldset className="icon-picker-controls" disabled={pending || disabled}>
          <legend>Background colour</legend>
          <div className="icon-backgrounds">{ICON_BACKGROUNDS.map(([background, label, color]) => <button type="button" key={background}
            className="icon-color" style={{ backgroundColor: color }} aria-label={`${label} background`} aria-pressed={shown.background === background}
            onClick={() => { setChoice({ ...shown, background }); setAutomatic(false); }}>
            {shown.background === background && <Check size={22} aria-hidden="true" />}
          </button>)}</div>
          <div className="icon-picker-filters"><label>Search symbols<input value={search} maxLength={100} placeholder="Coffee, taxi, beach…" data-autofocus
            onChange={event => setSearch(event.target.value)} /></label>
            <label>Category<select value={group} onChange={event => setGroup(event.target.value)}><option>All</option>{GROUPS.map(group => <option key={group}>{group}</option>)}</select></label>
          </div>
          <div className="icon-symbol-grid" aria-label="Symbols">{visible.map(([symbol, label]) => {
            const Symbol = SYMBOLS[symbol];
            return <button type="button" key={symbol} className="icon-symbol-option" aria-label={label} aria-pressed={shown.symbol === symbol}
              onClick={() => { setChoice({ ...shown, symbol }); setAutomatic(false); }}>
              <Symbol size={25} aria-hidden="true" /><span>{label}</span>
            </button>;
          })}</div>
          {!visible.length && <p className="footnote" role="status">No matching symbols. Try another word or choose All categories.</p>}
        </fieldset>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="icon-picker-actions"><button type="button" className="quiet" onClick={close} disabled={pending}>Cancel</button>
          <button type="button" className="primary" onClick={() => void apply()} disabled={pending || disabled}>{pending ? "Saving…" : "Use icon"}</button>
        </div>
      </section>
    </ModalA11y>, document.body)}
  </>;
}
