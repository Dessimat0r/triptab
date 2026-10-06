"use client";

import { useId, useState, type ChangeEvent, type ReactNode } from "react";
import { Camera, Check, Copy, ExternalLink, ImagePlus, RefreshCw, Trash2 } from "lucide-react";
import { receiptImageQualityWarnings, sampleReceiptImageContrast, type ReceiptImageQualityWarning } from "@/lib/receipt-image-quality";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 4_000_000;
const MAX_IMAGE_DIMENSION = 8192;

// Decode and re-encode every browser upload: canvas keeps the visible receipt,
// honours the decoder's orientation, and does not copy camera EXIF/GPS data.
export async function prepareReceiptImage(file: File, onQualityWarnings?: (warnings: ReceiptImageQualityWarning[]) => void): Promise<File> {
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
    onQualityWarnings?.(receiptImageQualityWarnings({
      sourceWidth: width, sourceHeight: height, preparedWidth: canvas.width, preparedHeight: canvas.height,
      ...sampleReceiptImageContrast(canvas),
    }));
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
  /** Before any photo or request exists: just the two capture actions, with
   * reading notes and location tucked into an optional disclosure. */
  compact?: boolean;
  contextFields?: ReactNode;
  busy: boolean;
  stored: boolean;
  copied: boolean;
  ready?: boolean;
  itemized?: boolean;
  prompt?: string;
  chatgptUrl?: string;
  connected?: boolean;
  aiConfigured?: boolean;
  aiConnected?: boolean;
  aiProvider?: "api" | "siwc";
  aiEligible?: boolean;
  aiManageable?: boolean;
  aiManagementReason?: string;
  aiSiwcAvailable?: boolean;
  aiReason?: string;
  processing?: boolean;
  handoffOpened?: boolean;
  assistantError?: string;
  refreshError?: string;
  offline?: boolean;
  onCapture: (file: File) => void | Promise<void>;
  onPreparingChange?: (preparing: boolean) => void;
  onRemove?: () => void;
  onPrepare: () => void;
  onOpenChatGPT?: () => void;
  onConnectChatGPT?: () => void;
  onProcess?: () => void;
  onConnectPlan?: () => void;
  onRefresh: () => void;
  onUseProcessed: () => void;
};

export default function ReceiptCapture({
  receiptId,
  compact = false,
  contextFields,
  busy,
  stored,
  copied,
  ready = false,
  itemized = false,
  prompt,
  chatgptUrl,
  connected = false,
  aiConfigured = false,
  aiConnected = false,
  aiProvider = "api",
  aiEligible = false,
  aiManageable = false,
  aiManagementReason,
  aiSiwcAvailable = false,
  aiReason,
  processing = false,
  handoffOpened = false,
  assistantError,
  refreshError,
  offline,
  onCapture,
  onPreparingChange,
  onRemove,
  onPrepare,
  onOpenChatGPT,
  onConnectChatGPT,
  onProcess,
  onConnectPlan,
  onRefresh,
  onUseProcessed,
}: ReceiptCaptureProps) {
  const titleId = useId();
  const hintId = useId();
  const cameraId = useId();
  const imageId = useId();
  const errorId = useId();
  const promptId = useId();
  const [preparing, setPreparing] = useState(false);
  const [captureError, setCaptureError] = useState("");
  const [captureWarnings, setCaptureWarnings] = useState<ReceiptImageQualityWarning[]>([]);
  const locked = busy || preparing || processing;
  const receiptUrl = receiptId
    ? "/api/receipt?id=" + encodeURIComponent(receiptId)
    : undefined;
  const automaticAvailable = aiConfigured && aiEligible && (aiProvider === "api" || aiSiwcAvailable);
  const handoffNeedsPaste = Boolean(prompt && chatgptUrl === "https://chatgpt.com/");
  const readingText = aiProvider === "api" ? "Reading receipt with AI…" : "Reading receipt with ChatGPT…";
  const handoffStatus = "Request prepared. TripTab cannot verify tools in an external conversation. Enable TripTab there and send this request; no external processing is confirmed until a proposal arrives.";
  let assistanceStatus: string;
  if (ready) {
    assistanceStatus = "Processed items are ready to review. Saving the expense applies your reviewed items.";
  } else if (itemized) {
    assistanceStatus = "Receipt details received. Check printed totals, warnings and item shares before saving.";
  } else if (receiptUrl && !aiConnected && aiManagementReason === "verification_required") {
    assistanceStatus = "Verify your account with ChatGPT in Your account before managing shared receipt AI. You can enter items manually at any time.";
  } else if (receiptUrl && aiEligible && aiProvider === "api") {
    assistanceStatus = aiConnected
      ? (assistantError
        ? "Your image is saved. Retry reading it with receipt AI, use the request below, or enter items yourself."
        : "Receipt AI is provided by TripTab. TripTab can read this image and suggest receipt items.")
      : (aiManageable
        ? "Set up shared receipt AI in Your account to read uploaded receipts automatically for all signed-in users. You can enter items manually at any time."
        : "TripTab's shared receipt AI is not connected yet. You can use a ChatGPT conversation with TripTab tools enabled or enter items manually at any time.");
  } else if (receiptUrl && automaticAvailable) {
    assistanceStatus = aiConnected
      ? (assistantError
        ? "Your image is saved. Retry reading it with ChatGPT, use the request below, or enter items yourself."
        : "Your ChatGPT plan is connected. TripTab can read this image and suggest receipt items.")
      : "Connect your ChatGPT plan to let TripTab read uploaded receipts automatically. You can enter items manually at any time.";
  } else if (receiptUrl) {
    assistanceStatus = aiEligible && aiProvider === "siwc" && !aiSiwcAvailable
      ? "ChatGPT plan processing is switched off. You can use a ChatGPT conversation with TripTab tools enabled or enter items yourself."
      : (aiEligible
        ? (aiReason === "not_connected"
          ? "TripTab's shared receipt AI is not connected yet. You can use a ChatGPT conversation with TripTab tools enabled or enter items manually at any time."
          : (connected
          ? "Automatic receipt reading is not available for this site yet. Use the request below with a ChatGPT conversation with TripTab tools enabled, or enter items yourself."
          : "Automatic receipt reading is not available for this site yet. Link your ChatGPT identity in Your account, then enable TripTab tools in the external conversation to use this request. You can enter items manually at any time."))
        : "Sign in to use TripTab's shared receipt AI. You can use a ChatGPT conversation with TripTab tools enabled or enter items manually at any time.");
  } else if (!connected) {
    assistanceStatus = "Link your ChatGPT identity in Your account, then enable TripTab tools in the external conversation to ask about these receipt details. You can enter items manually at any time.";
  } else if (handoffOpened) {
    assistanceStatus = handoffStatus;
  } else if (stored && prompt) {
    assistanceStatus = "Your receipt request is ready; processing has not started. Open a ChatGPT conversation with TripTab tools enabled and send it to help with these receipt details.";
  } else {
    assistanceStatus = "Prepare a receipt request for a ChatGPT conversation with TripTab tools enabled.";
  }

  async function capture(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || locked) return;
    setCaptureError("");
    setCaptureWarnings([]);
    setPreparing(true);
    onPreparingChange?.(true);
    try { await onCapture(await prepareReceiptImage(file, setCaptureWarnings)); }
    catch (cause) { setCaptureError(cause instanceof Error ? cause.message : "Unable to prepare this photo. Try another image."); }
    finally {
      setPreparing(false);
      onPreparingChange?.(false);
    }
  }

  const inputs = <div className="receipt-capture-inputs">
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
  </div>;
  const problems = <>
    {captureError && <p id={errorId} className="receipt-chat-error" role="alert">{captureError}</p>}
    {captureWarnings.length > 0 && <div className="receipt-capture-hint" role="status" aria-live="polite">
      {captureWarnings.map(warning => <p key={warning.code}>{warning.message}</p>)}
      <p>Your image can still be uploaded and reviewed.</p>
    </div>}
    {assistantError && <p className="receipt-chat-error" role="alert">{assistantError}</p>}
  </>;

  if (compact && !receiptUrl && !prompt) return (
    <section className="receipt-capture receipt-capture--compact" aria-labelledby={titleId} aria-busy={locked}>
      <h3 id={titleId}>Have a receipt?</h3>
      <div className="receipt-capture-status" role="status" aria-live="polite" aria-atomic="true">
        {locked && <p>{processing ? readingText : (preparing ? "Preparing receipt photo…" : "Please wait…")}</p>}
      </div>
      {inputs}
      {contextFields && <details className="receipt-capture-context-toggle">
        <summary>Add notes for reading the photo <small>optional</small></summary>
        {contextFields}
      </details>}
      <p id={hintId} className="receipt-capture-hint">
        {aiConnected ? "TripTab reads the photo and suggests items for you to check. " : ""}
        Photos are resized and camera metadata is removed before uploading.
      </p>
      {problems}
    </section>
  );

  return (
    <section className="receipt-capture" aria-labelledby={titleId} aria-busy={locked}>
      <h3 id={titleId}>Receipt image</h3>
      {!aiConnected && <p className="receipt-capture-hint">Upload a photo or enter items yourself. Connected ChatGPT tools are also available when enabled in your conversation.</p>}
      <div className="receipt-capture-status" role="status" aria-live="polite" aria-atomic="true">
        {locked ? <p>{processing ? readingText : (preparing ? "Preparing receipt photo…" : "Please wait…")}</p> : (receiptUrl || prompt) && (
          <>
            <p>{receiptUrl
              ? (stored ? "Receipt image stored with this receipt." : "Receipt attached. Save your expense to keep it.")
              : (stored ? "Receipt details saved for ChatGPT." : "Save your receipt details before sending the request to ChatGPT.")}</p>
            <p>{assistanceStatus}</p>
            {handoffOpened && receiptUrl && !ready && !itemized && <p>{handoffStatus}</p>}
            {copied && !ready && !itemized && <p>Receipt request copied. Paste and send it in a ChatGPT or Codex conversation with TripTab tools enabled.</p>}
          </>
        )}
      </div>
      {contextFields}
      {inputs}
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
        When receipt AI is connected, TripTab reads uploaded receipts automatically and suggests items. {" "}
        Review the items here before choosing Save expense. You can also enter items yourself.
      </p>
      {problems}
      {(receiptUrl || prompt) && (
        <div className="receipt-capture-processing">
          {ready && <button type="button" className="primary" disabled={locked} onClick={onUseProcessed}>
            Review processed receipt
          </button>}
          {!ready && !itemized && receiptUrl && automaticAvailable && aiConnected && onProcess && <button type="button" className="primary" disabled={locked || !stored} onClick={onProcess}>
            <RefreshCw size={17} aria-hidden="true" />
            {processing ? readingText : (assistantError ? "Retry reading receipt" : (aiProvider === "api" ? "Read receipt with AI" : "Read receipt with ChatGPT"))}
          </button>}
          {!ready && !itemized && receiptUrl && aiManageable && aiProvider === "api" && !aiConnected && onConnectPlan && <button type="button" className="primary" disabled={locked} onClick={onConnectPlan}>
            Set up receipt AI
          </button>}
          {!ready && !itemized && receiptUrl && !aiManageable && !aiConnected && aiManagementReason === "verification_required" && onConnectPlan && <button type="button" className="primary" disabled={locked} onClick={onConnectPlan}>
            Verify receipt AI setup
          </button>}
          {!ready && !itemized && receiptUrl && automaticAvailable && aiProvider === "siwc" && !aiConnected && onConnectPlan && <button type="button" className="primary" disabled={locked} onClick={onConnectPlan}>
            Connect ChatGPT plan
          </button>}
          <details className="receipt-capture-tools" open={!aiConnected && !ready && !itemized}><summary>Connected ChatGPT tools</summary><div className="receipt-capture-tool-actions">
          {!ready && !itemized && connected && stored && prompt && chatgptUrl && (
            locked ? <button type="button" className={aiConfigured ? "quiet" : "primary"} disabled>
              <ExternalLink size={17} aria-hidden="true" /> Open ChatGPT
            </button> : <a className={aiConfigured ? "quiet" : "primary"} href={chatgptUrl} target="_blank" rel="noopener noreferrer" onClick={onOpenChatGPT}>
              <ExternalLink size={17} aria-hidden="true" /> Open ChatGPT
            </a>
          )}
          {!ready && !itemized && !connected && onConnectChatGPT && <button type="button" className={aiConfigured ? "quiet" : "primary"} disabled={locked} onClick={onConnectChatGPT}>
            Link ChatGPT identity
          </button>}
          <button type="button" className="quiet" disabled={locked} onClick={onPrepare}>
            {copied ? <Check size={17} aria-hidden="true" /> : <Copy size={17} aria-hidden="true" />}
            {prompt ? "Copy receipt request" : "Prepare receipt request"}
          </button>
          </div></details>
          {refreshError && !offline && <button type="button" className="quiet" disabled={locked} onClick={onRefresh}>
            <RefreshCw size={17} aria-hidden="true" />
            Retry updates
          </button>}
        </div>
      )}
      {stored && <p className="receipt-chat-note" role="status">{offline ? "You’re offline. Receipt updates resume when you reconnect." : refreshError ? "Unable to refresh receipt updates. We’ll keep trying automatically." : "Processed items and replies appear automatically while this receipt is open."}</p>}
      {prompt && <details className="receipt-capture-prompt" open={!aiConnected && !ready && !itemized}>
        <summary>Request to send in ChatGPT</summary>
        <p>{handoffNeedsPaste
          ? "This request is too long to prefill reliably. Copy the complete text below, open ChatGPT, then paste and send it with TripTab enabled."
          : "If ChatGPT opens without the request, copy this text into the conversation and send it with TripTab enabled."}</p>
        <textarea id={promptId} aria-label="Receipt assistant prompt" value={prompt} readOnly onFocus={event => event.currentTarget.select()} />
      </details>}
    </section>
  );
}
