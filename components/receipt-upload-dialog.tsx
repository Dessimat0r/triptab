"use client";
import { useId, useRef, useState } from "react";
import { Camera, ImagePlus, X } from "lucide-react";
import ModalA11y from "./modal-accessibility";
import ReceiptLocationFields, { type ReceiptPlace } from "./receipt-location-fields";
import "./receipt-upload.css";

export type ReceiptUploadContext = ReceiptPlace & { notes?: string };
export default function ReceiptUploadDialog({ busy, nativeAvailable, error, onClose, onCancel, onUpload }: {
  busy: boolean; nativeAvailable: boolean; error?: string; onClose: () => void; onCancel: () => void;
  onUpload: (file: File, context: ReceiptUploadContext, signal?: AbortSignal, onSaving?: () => boolean) => Promise<boolean>;
}) {
  const titleId = useId(), noteId = useId(), cameraId = useId(), galleryId = useId();
  const [file, setFile] = useState<File | null>(null), [notes, setNotes] = useState("");
  const [place, setPlace] = useState<ReceiptPlace>({}), [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState("");
  const request = useRef<{ controller: AbortController; saving: boolean } | null>(null);
  const [persisting, setPersisting] = useState(false);
  const locked = busy || submitting;
  function cancel() {
    if (request.current?.saving) return;
    request.current?.controller.abort(); request.current = null;
    onCancel(); setSubmitting(false); setFile(null); setLocalError("");
  }
  async function submit(selected: File) {
    if (request.current?.saving) return;
    if (request.current) cancel();
    const active = { controller: new AbortController(), saving: false };
    const { controller } = active; request.current = active;
    setFile(selected); setSubmitting(true); setLocalError("");
    try {
      const saved = await onUpload(selected, { ...place, notes: notes.trim() || undefined }, controller.signal, () => {
        if (request.current !== active || controller.signal.aborted) return false;
        // Lock synchronously before the draft POST, including handlers from an older render.
        active.saving = true; setPersisting(true); return true;
      });
      if (!saved && request.current === active && !controller.signal.aborted) setLocalError("Unable to save this receipt. Your photo and notes are still here.");
    } catch {
      if (request.current === active && !controller.signal.aborted) setLocalError("Unable to save this receipt. Your photo and notes are still here.");
    } finally {
      if (request.current === active) { request.current = null; setSubmitting(false); setPersisting(false); }
    }
  }
  function close() { if (request.current?.saving) return; cancel(); onClose(); }
  return <ModalA11y className="overlay" onClose={close}>
    <section className="modal receipt-upload-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={locked}>
      <div className="modalheading"><h2 id={titleId}>Add a receipt</h2><button type="button" className="iconbutton" aria-label="Close receipt upload" disabled={persisting} onClick={close}><X /></button></div>
      <label htmlFor={noteId}>Who bought what? <small>optional</small></label>
      <textarea id={noteId} rows={3} maxLength={4000} value={notes} disabled={locked} placeholder="In Bratislava. Gary had a decaf, I had a cappuccino. We each had 2 croissants." onChange={event => setNotes(event.target.value)} />
      <p className="footnote">Use your own words, including nicknames. The assistant uses the holiday’s travellers and remembered context.</p>
      <details className="receipt-upload-place"><summary>Receipt location <small>optional</small></summary><ReceiptLocationFields value={place} onChange={setPlace} disabled={locked} /></details>
      <div className="receipt-capture-inputs">
        {[{ id: cameraId, camera: true, label: "Scan receipt" }, { id: galleryId, camera: false, label: "Choose image" }].map(option => <label key={option.id} htmlFor={option.id} className={`receipt-capture-action${persisting || (busy && !submitting) ? " disabled" : ""}`}>
          {option.camera ? <Camera size={17} aria-hidden="true" /> : <ImagePlus size={17} aria-hidden="true" />}{option.label}
          <input id={option.id} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" capture={option.camera ? "environment" : undefined} disabled={persisting || (busy && !submitting)} onChange={event => {
            const selected = event.target.files?.[0]; if (selected) void submit(selected); event.target.value = "";
          }} />
        </label>)}
      </div>
      {file && <p className="receipt-upload-filename" role="status">{file.name}</p>}
      {submitting && <div className="receipt-upload-progress"><p role="status">{persisting ? "Saving receipt…" : "Uploading photo…"}</p>{!persisting && <><button type="button" className="quiet" onClick={cancel}>Cancel upload</button><p className="footnote">Choose another image above to replace this upload.</p></>}</div>}
      {(error || localError) && <p className="error" role="alert">{error || localError}</p>}
      <p className="footnote">{nativeAvailable ? "The assistant reads the photo and these notes together. Review its suggestions before saving the expense." : "Your photo and notes are saved together. You can enter items yourself or use connected ChatGPT tools."} Photos are resized and camera metadata is removed before uploading.</p>
      {!locked && file && (error || localError) && <button type="button" className="primary wide" onClick={() => void submit(file)}>Retry upload</button>}
    </section>
  </ModalA11y>;
}
