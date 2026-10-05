"use client";

import { useId, useState } from "react";
import { Minus, Plus, X, ImageIcon } from "lucide-react";
import ModalA11y from "./modal-accessibility";

/** A separate dialog leaves the receipt form and its scroll position mounted. */
export default function ReceiptPhotoViewer({ receiptId }: { receiptId: string }) {
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const titleId = useId();
  return <>
    <button type="button" className="quiet receipt-view-photo" onClick={() => { setZoom(1); setOpen(true); }}><ImageIcon size={17} aria-hidden="true" />View receipt photo</button>
    {open && <ModalA11y className="overlay receipt-photo-overlay" onClose={() => setOpen(false)}>
      <section className="modal receipt-photo-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modalheading"><h2 id={titleId}>Receipt photo</h2><button type="button" className="iconbutton" aria-label="Close receipt photo" onClick={() => setOpen(false)}><X /></button></div>
        <div className="receipt-photo-controls" role="group" aria-label="Photo magnification">
          <button type="button" className="quiet" aria-label="Zoom out" disabled={zoom <= 1} onClick={() => setZoom(value => Math.max(1, value - 0.5))}><Minus size={17} /></button>
          <span role="status">{Math.round(zoom * 100)}%</span>
          <button type="button" className="quiet" aria-label="Zoom in" disabled={zoom >= 4} onClick={() => setZoom(value => Math.min(4, value + 0.5))}><Plus size={17} /></button>
          <button type="button" className="quiet" onClick={() => setZoom(1)}>Fit width</button>
        </div>
        <p className="footnote">Zoom to read small print. Drag or scroll within the photo to move around it.</p>
        <div className="receipt-photo-pan" tabIndex={0} role="region" aria-label="Receipt photo, scroll to inspect">
          {/* Native private image route preserves authentication and source bytes. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/receipt?id=${encodeURIComponent(receiptId)}`} alt="Stored receipt evidence" style={{ width: `${zoom * 100}%`, maxWidth: "none" }} />
        </div>
      </section>
    </ModalA11y>}
  </>;
}
