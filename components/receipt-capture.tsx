"use client";

import { useId, useState, type ChangeEvent } from "react";
import { Camera, Check, Copy, ImagePlus, RefreshCw, Trash2 } from "lucide-react";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 4_000_000;
const MAX_IMAGE_DIMENSION = 8192;

// Decode and re-encode every browser upload: canvas keeps the visible receipt,
// honours the decoder's orientation, and does not copy camera EXIF/GPS data.
export async function prepareReceiptImage(file: File): Promise<File> {
  const supported = /^(image\/(jpeg|jpg|png|webp|heic|heif))$/i.test(file.type) ||
    (!file.type && /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name));
  if (!supported) throw Error("Choose a JPEG, PNG or WebP receipt image. HEIC/HEIF works only in browsers that can open it.");
  if (!file.size) throw Error("This image is empty. Choose another receipt photo.");
  if (file.size > MAX_SOURCE_BYTES) throw Error("This photo is too large to prepare on your phone. Export a smaller JPEG image and try again.");

  let source: ImageBitmap | HTMLImageElement | undefined;
  let objectUrl: string | undefined;
  try {
    if (typeof createImageBitmap === "function") {
      try { source = await createImageBitmap(file, { imageOrientation: "from-image" }); }
      catch { /* Some browsers decode HEIC only through their image element. */ }
    }
    if (!source) {
      objectUrl = URL.createObjectURL(file);
      const image = new Image();
      image.decoding = "async";
      image.src = objectUrl;
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(Error("This photo could not be opened. Choose another JPEG, PNG or WebP image."));
      });
      source = image;
    }
    const width = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
    const height = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
    if (!width || !height) throw Error("The image has no visible pixels.");
    // A pixel budget preserves narrow, long receipts: a 1200 × 6000 photo
    // becomes 894 × 4472 rather than 400 × 2000. Bound extreme dimensions too,
    // so unusually thin images cannot request an oversized mobile canvas.
    const scale = Math.min(
      1,
      Math.sqrt(MAX_IMAGE_PIXELS / (width * height)),
      MAX_IMAGE_DIMENSION / Math.max(width, height),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(width * scale));
    canvas.height = Math.max(1, Math.floor(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw Error("This browser cannot prepare receipt images.");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    let encoded: Blob | null = null;
    for (const quality of [0.85, 0.7, 0.55]) {
      encoded = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
      if (encoded && encoded.size <= MAX_UPLOAD_BYTES) break;
    }
    if (!encoded || encoded.type !== "image/jpeg" || encoded.size > MAX_UPLOAD_BYTES) {
      throw Error("Unable to prepare an image within the 5 MB upload limit. Export a smaller JPEG and try again.");
    }
    const name = (file.name.replace(/\.[^.]*$/, "") || "receipt") + ".jpg";
    return new File([encoded], name, { type: "image/jpeg", lastModified: file.lastModified });
  } catch (cause) {
    if (/\.(heic|heif)$/i.test(file.name) || /^image\/(heic|heif)$/i.test(file.type)) {
      throw Error("This browser could not open your HEIC/HEIF photo. Export it as JPEG from Photos or choose a JPEG, PNG or WebP image.");
    }
    throw cause instanceof Error ? cause : Error("Unable to open this receipt image. Choose a JPEG, PNG or WebP photo.");
  } finally {
    if (source && "close" in source) source.close();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

export type ReceiptCaptureProps = {
  receiptId?: string;
  busy: boolean;
  stored: boolean;
  copied: boolean;
  ready?: boolean;
  prompt?: string;
  onCapture: (file: File) => void | Promise<void>;
  onPreparingChange?: (preparing: boolean) => void;
  onRemove?: () => void;
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
  onPreparingChange,
  onRemove,
  onPrepare,
  onRefresh,
  onUseProcessed,
}: ReceiptCaptureProps) {
  const titleId = useId();
  const hintId = useId();
  const cameraId = useId();
  const imageId = useId();
  const errorId = useId();
  const [preparing, setPreparing] = useState(false);
  const [captureError, setCaptureError] = useState("");
  const locked = busy || preparing;
  const receiptUrl = receiptId
    ? "/api/receipt?id=" + encodeURIComponent(receiptId)
    : undefined;

  async function capture(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || locked) return;
    setCaptureError("");
    setPreparing(true);
    onPreparingChange?.(true);
    try { await onCapture(await prepareReceiptImage(file)); }
    catch (cause) { setCaptureError(cause instanceof Error ? cause.message : "Unable to prepare this photo. Try another image."); }
    finally {
      setPreparing(false);
      onPreparingChange?.(false);
    }
  }

  return (
    <section className="receipt-capture" aria-labelledby={titleId} aria-busy={locked}>
      <h3 id={titleId}>Receipt image</h3>
      <div className="receipt-capture-inputs">
        <label
          htmlFor={cameraId}
          className={`receipt-capture-action${locked ? " disabled" : ""}`}
        >
          <Camera size={17} aria-hidden="true" />
          Scan receipt
          <input
            id={cameraId}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
            capture="environment"
            aria-describedby={`${hintId}${captureError ? " " + errorId : ""}`}
            disabled={locked}
            onChange={capture}
          />
        </label>
        <label
          htmlFor={imageId}
          className={`receipt-capture-action${locked ? " disabled" : ""}`}
        >
          <ImagePlus size={17} aria-hidden="true" />
          Choose image
          <input
            id={imageId}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
            aria-describedby={`${hintId}${captureError ? " " + errorId : ""}`}
            disabled={locked}
            onChange={capture}
          />
        </label>
      </div>
      {receiptUrl && (
        <div className="receipt-capture-original">
          <img src={receiptUrl} alt="Stored receipt image for review" loading="lazy" />
          <a href={receiptUrl} target="_blank" rel="noreferrer">
            Open stored receipt image
          </a>
          {onRemove && <button type="button" className="quiet wide danger" disabled={locked} onClick={onRemove}>
            <Trash2 size={17} aria-hidden="true" /> Remove receipt image
          </button>}
        </div>
      )}
      <p id={hintId} className="receipt-capture-hint">
        Photos are resized to a readable JPEG copy and camera metadata is removed before uploading. {" "}
        You can process your receipt in your connected ChatGPT or Codex, then check for
        processed items here. Review the processed receipt before choosing Save
        expense. You can also enter items yourself.
      </p>
      {captureError && <p id={errorId} className="receipt-chat-error" role="alert">{captureError}</p>}
      {receiptUrl && (
        <div className="receipt-capture-processing">
          <button type="button" className="quiet" disabled={locked} onClick={onPrepare}>
            {copied ? <Check size={17} aria-hidden="true" /> : <Copy size={17} aria-hidden="true" />}
            Copy receipt prompt
          </button>
          <button type="button" className="quiet" disabled={locked} onClick={onRefresh}>
            <RefreshCw size={17} aria-hidden="true" />
            Check for processed items
          </button>
          {ready && <button type="button" className="primary" disabled={locked} onClick={onUseProcessed}>
            Review processed receipt
          </button>}
        </div>
      )}
      {prompt && <details className="receipt-capture-prompt">
        <summary>View receipt prompt</summary>
        <textarea aria-label="Receipt assistant prompt" value={prompt} readOnly />
      </details>}
      <div className="receipt-capture-status" role="status" aria-live="polite" aria-atomic="true">
        {locked ? <p>{preparing ? "Preparing receipt photo…" : "Please wait…"}</p> : receiptUrl && (
          <>
            <p>{stored ? "Receipt image stored with this receipt." : "Receipt attached. Save your expense to keep it."}</p>
            {copied && <p>Prompt copied. Open your connected ChatGPT or Codex to process it.</p>}
            {ready && <p>Processed items are ready to review</p>}
          </>
        )}
      </div>
    </section>
  );
}
