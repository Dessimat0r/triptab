"use client";
import { t as uiText } from "@/lib/ui-language";


import { useId, useState } from "react";
import { Minus, Plus, X, ImageIcon } from "lucide-react";
import ModalA11y from "./modal-accessibility";

/**
 * The one way to look at a stored receipt photo. A thumbnail sits with the
 * receipt's totals on phones and a large panel fills the left column on wide
 * screens; both open the same zoomable dialog, which leaves the receipt form
 * and its scroll position mounted.
 */
export default function ReceiptPhotoViewer({ receiptId, variant }: {
  receiptId: string; variant: "thumbnail" | "panel";
}) {
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const titleId = useId();
  const src = `/api/receipt?id=${encodeURIComponent(receiptId)}`;
  const show = () => { setZoom(1); setOpen(true); };
  return <>
    <button type="button" className={`receipt-photo-${variant}`} aria-label={uiText("View receipt photo")} onClick={show}>
      {/* Native private image route preserves authentication and source bytes. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" loading="lazy" decoding="async" />
      {variant === "panel" && <span className="receipt-photo-panel-hint"><ImageIcon size={15} aria-hidden="true" />{uiText("Tap to zoom")}</span>}
    </button>
    {open && <ModalA11y className="overlay receipt-photo-overlay" onClose={() => setOpen(false)}>
      <section className="modal receipt-photo-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modalheading"><h2 id={titleId}>{uiText("Receipt photo")}</h2><button type="button" className="iconbutton" aria-label={uiText("Close receipt photo")} onClick={() => setOpen(false)}><X /></button></div>
        <div className="receipt-photo-controls" role="group" aria-label={uiText("Photo magnification")}>
          <button type="button" className="quiet" aria-label={uiText("Zoom out")} disabled={zoom <= 1} onClick={() => setZoom(value => Math.max(1, value - 0.5))}><Minus size={17} /></button>
          <span role="status">{Math.round(zoom * 100)}%</span>
          <button type="button" className="quiet" aria-label={uiText("Zoom in")} disabled={zoom >= 4} onClick={() => setZoom(value => Math.min(4, value + 0.5))}><Plus size={17} /></button>
          <button type="button" className="quiet" onClick={() => setZoom(1)}>{uiText("Fit width")}</button>
        </div>
        <p className="footnote">{uiText("Zoom to read small print. Drag or scroll within the photo to move around it.")}</p>
        <div className="receipt-photo-pan" tabIndex={0} role="region" aria-label={uiText("Receipt photo, scroll to inspect")}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={uiText("Stored receipt evidence")} style={{ width: `${zoom * 100}%`, maxWidth: "none" }} />
        </div>
      </section>
    </ModalA11y>}
  </>;
}
