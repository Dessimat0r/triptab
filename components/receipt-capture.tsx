"use client";

import { useId, type ChangeEvent } from "react";
import { Camera, Check, Copy, ImagePlus, RefreshCw } from "lucide-react";

export type ReceiptCaptureProps = {
  receiptId?: string;
  busy: boolean;
  stored: boolean;
  copied: boolean;
  ready?: boolean;
  prompt?: string;
  onCapture: (file: File) => void;
  onPrepare: () => void;
  onRefresh: () => void;
  onUseProcessed: () => void;
};

export default function ReceiptCapture({
  receiptId,
  busy,
  stored,
  copied,
  ready = false,
  prompt,
  onCapture,
  onPrepare,
  onRefresh,
  onUseProcessed,
}: ReceiptCaptureProps) {
  const titleId = useId();
  const hintId = useId();
  const cameraId = useId();
  const imageId = useId();
  const receiptUrl = receiptId
    ? "/api/receipt?id=" + encodeURIComponent(receiptId)
    : undefined;

  function capture(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file && !busy) onCapture(file);
  }

  return (
    <section className="receipt-capture" aria-labelledby={titleId} aria-busy={busy}>
      <h3 id={titleId}>Original receipt</h3>
      <div className="receipt-capture-inputs">
        <label
          htmlFor={cameraId}
          className={`receipt-capture-action${busy ? " disabled" : ""}`}
        >
          <Camera size={17} aria-hidden="true" />
          Scan receipt
          <input
            id={cameraId}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            aria-describedby={hintId}
            disabled={busy}
            onChange={capture}
          />
        </label>
        <label
          htmlFor={imageId}
          className={`receipt-capture-action${busy ? " disabled" : ""}`}
        >
          <ImagePlus size={17} aria-hidden="true" />
          Choose image
          <input
            id={imageId}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            aria-describedby={hintId}
            disabled={busy}
            onChange={capture}
          />
        </label>
      </div>
      {receiptUrl && (
        <div className="receipt-capture-original">
          <img src={receiptUrl} alt="Original receipt for review" loading="lazy" />
          <a href={receiptUrl} target="_blank" rel="noreferrer">
            Open original receipt
          </a>
        </div>
      )}
      <p id={hintId} className="receipt-capture-hint">
        You can process your receipt in your connected ChatGPT or Codex, then check for
        processed items here. Review the processed receipt before choosing Save
        expense. You can also enter items yourself.
      </p>
      {receiptUrl && (
        <div className="receipt-capture-processing">
          <button type="button" className="quiet" disabled={busy} onClick={onPrepare}>
            {copied ? <Check size={17} aria-hidden="true" /> : <Copy size={17} aria-hidden="true" />}
            Copy receipt prompt
          </button>
          <button type="button" className="quiet" disabled={busy} onClick={onRefresh}>
            <RefreshCw size={17} aria-hidden="true" />
            Check for processed items
          </button>
          {ready && <button type="button" className="primary" disabled={busy} onClick={onUseProcessed}>
            Review processed receipt
          </button>}
        </div>
      )}
      {prompt && <details className="receipt-capture-prompt">
        <summary>View receipt prompt</summary>
        <textarea aria-label="Receipt assistant prompt" value={prompt} readOnly />
      </details>}
      <div className="receipt-capture-status" role="status" aria-live="polite" aria-atomic="true">
        {busy ? <p>Please wait…</p> : receiptUrl && (
          <>
            <p>{stored ? "Original image stored with this receipt." : "Receipt attached. Save your expense to keep it."}</p>
            {copied && <p>Prompt copied. Open your connected ChatGPT or Codex to process it.</p>}
            {ready && <p>Processed items are ready to review</p>}
          </>
        )}
      </div>
    </section>
  );
}
