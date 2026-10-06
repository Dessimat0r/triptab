"use client";
import { useId, useRef, useState } from "react";
import { Camera, ImagePlus, X } from "lucide-react";
import ModalA11y from "./modal-accessibility";
import ReceiptLocationFields, { type ReceiptPlace } from "./receipt-location-fields";
import "./receipt-upload.css";

export type ReceiptUploadContext = ReceiptPlace & { notes?: string };
export default function ReceiptUploadDialog({ busy, nativeAvailable, error, onClose, onUpload }: {
  busy: boolean; nativeAvailable: boolean; error?: string; onClose: () => void;
  onUpload: (file: File, context: ReceiptUploadContext) => Promise<boolean>;
}) {
  const titleId = useId(), noteId = useId(), cameraId = useId(), galleryId = useId();
  const [file, setFile] = useState<File | null>(null), [notes, setNotes] = useState("");
  const [place, setPlace] = useState<ReceiptPlace>({}), [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState("");
  const inFlight = useRef(false);
  const locked = busy || submitting;
  async function submit() {
    if (!file || locked || inFlight.current) return;
    inFlight.current = true; setSubmitting(true); setLocalError("");
    try { if (!await onUpload(file, { ...place, notes: notes.trim() || undefined })) setLocalError("Unable to save this receipt. Your photo and notes are still here."); }
    catch { setLocalError("Unable to save this receipt. Your photo and notes are still here."); }
    finally { inFlight.current = false; setSubmitting(false); }
  }
  return <ModalA11y className="overlay" onClose={() => { if (!locked) onClose(); }}>
    <section className="modal receipt-upload-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={locked}>
      <div className="modalheading"><h2 id={titleId}>Add a receipt</h2><button type="button" className="iconbutton" aria-label="Close receipt upload" disabled={locked} onClick={onClose}><X /></button></div>
      <div className="receipt-capture-inputs">
        {[{ id: cameraId, camera: true, label: "Take photo" }, { id: galleryId, camera: false, label: "Choose image" }].map(option => <label key={option.id} htmlFor={option.id} className={`receipt-capture-action${locked ? " disabled" : ""}`}>
          {option.camera ? <Camera size={17} aria-hidden="true" /> : <ImagePlus size={17} aria-hidden="true" />}{option.label}
          <input id={option.id} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" capture={option.camera ? "environment" : undefined} disabled={locked} onChange={event => {
            const selected = event.target.files?.[0]; if (selected) { setFile(selected); setLocalError(""); } event.target.value = "";
          }} />
        </label>)}
      </div>
      {file && <p className="receipt-upload-filename" role="status">{file.name}</p>}
      <label htmlFor={noteId}>Who bought what? <small>optional</small></label>
      <textarea id={noteId} rows={3} maxLength={4000} value={notes} disabled={locked} placeholder="In Bratislava. Gary had a decaf, I had a cappuccino. We each had 2 croissants." onChange={event => setNotes(event.target.value)} />
      <p className="footnote">Use your own words, including nicknames. The assistant uses the holiday’s travellers and remembered context.</p>
      <details className="receipt-upload-place"><summary>Place or current location <small>optional</small></summary><ReceiptLocationFields value={place} onChange={setPlace} disabled={locked} /></details>
      {(error || localError) && <p className="error" role="alert">{error || localError}</p>}
      <p className="footnote">{nativeAvailable ? "The assistant reads the photo and these notes together. Review its suggestions before saving the expense." : "Your photo and notes are saved together. You can enter items yourself or use connected ChatGPT tools."}</p>
      <button type="button" className="primary wide" disabled={locked || !file} onClick={() => void submit()}>{locked ? "Saving receipt…" : nativeAvailable ? "Upload & read receipt" : "Upload receipt"}</button>
    </section>
  </ModalA11y>;
}
