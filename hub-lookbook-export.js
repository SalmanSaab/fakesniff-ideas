/* FAKESNIFF Hub - browser-side Lookbook PDF export. Owner: Codex.
 *
 * Photographs are fetched by the authenticated Lookbook module, resized and
 * re-encoded one at a time here, then transferred to a same-origin worker.
 * The worker owns PDF layout so a factory-size lookbook does not freeze the UI.
 */

export const MAX_EXPORT_ITEMS = 40;
const FRAME_POINTS = { width: 515, height: 420 };
const PDF_PPI = 300;
const MAX_EMBEDDED_IMAGE_BYTES = 1.2 * 1024 * 1024;
const MAX_PREPARED_IMAGE_BYTES = 28 * 1024 * 1024;

export class LookbookImageError extends Error {
  constructor(items) {
    super("One or more photographs could not be prepared.");
    this.name = "LookbookImageError";
    this.items = items;
  }
}

export class LookbookTooLargeError extends Error {
  constructor(bytes) {
    super("The PDF would be too large to save safely on this device.");
    this.name = "LookbookTooLargeError";
    this.bytes = bytes;
  }
}

export class LookbookTextError extends Error {
  constructor(itemTitle) {
    super("The PDF cannot safely print one or more characters in this reference.");
    this.name = "LookbookTextError";
    this.itemTitle = itemTitle;
  }
}

const PDF_TEXT_REPLACEMENTS = new Map([
  ["ı", "i"], ["İ", "I"], ["ğ", "g"], ["Ğ", "G"], ["ş", "s"], ["Ş", "S"],
  ["ł", "l"], ["Ł", "L"], ["đ", "d"], ["Đ", "D"], ["ø", "o"], ["Ø", "O"],
  ["ß", "ss"], ["æ", "ae"], ["Æ", "AE"], ["œ", "oe"], ["Œ", "OE"],
  ["°", " degrees"], ["×", " x "], ["±", "+/-"], ["€", "EUR"],
]);

export function toPdfText(value) {
  const replaced = [...String(value ?? "")].map((char) => PDF_TEXT_REPLACEMENTS.get(char) || char).join("");
  const normalized = replaced
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/•/g, "-")
    .replace(/[ \t]+/g, " ")
    .trim();
  return /^[\x20-\x7E\n]*$/.test(normalized) ? normalized : null;
}

export function validateExportText(item) {
  const fields = [item.title, item.category, item.description, item.note, ...(item.tags || [])];
  if (fields.some((field) => toPdfText(field) === null)) throw new LookbookTextError(item.title);
}

export function prepareItemText(item) {
  validateExportText(item);
  return {
    ...item,
    title: toPdfText(item.title),
    category: toPdfText(item.category),
    description: toPdfText(item.description),
    note: toPdfText(item.note),
    tags: (item.tags || []).map(toPdfText),
  };
}

export function fitInside(sourceWidth, sourceHeight, boxWidth, boxHeight) {
  if (![sourceWidth, sourceHeight, boxWidth, boxHeight].every((n) => Number.isFinite(n) && n > 0)) {
    return { width: 0, height: 0, scale: 0 };
  }
  const scale = Math.min(boxWidth / sourceWidth, boxHeight / sourceHeight);
  return { width: sourceWidth * scale, height: sourceHeight * scale, scale };
}

export function targetPixelSize(sourceWidth, sourceHeight) {
  const maxWidth = Math.round((FRAME_POINTS.width / 72) * PDF_PPI);
  const maxHeight = Math.round((FRAME_POINTS.height / 72) * PDF_PPI);
  const fitted = fitInside(sourceWidth, sourceHeight, maxWidth, maxHeight);
  const scale = Math.min(1, fitted.scale || 1);
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

export function normaliseExportItem(item = {}) {
  const analysis = item.ai_analysis && typeof item.ai_analysis === "object" ? item.ai_analysis : {};
  const tags = [...(Array.isArray(item.tags) ? item.tags : []),
                ...(Array.isArray(analysis.tags) ? analysis.tags : [])]
    .map((tag) => String(tag || "").trim())
    .filter(Boolean);
  return {
    id: String(item.id || ""),
    title: String(item.title || item.category || "Reference").trim() || "Reference",
    category: String(item.category || "unsorted").trim() || "unsorted",
    description: String(analysis.description || "").trim(),
    note: String(item.note || "").trim(),
    tags: [...new Set(tags.map((tag) => tag.toLowerCase()))].slice(0, 30),
    hasPhoto: Boolean(item.storage_path),
  };
}

export function lookbookFileName(date = new Date()) {
  const safeDate = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const iso = [safeDate.getFullYear(), String(safeDate.getMonth() + 1).padStart(2, "0"),
    String(safeDate.getDate()).padStart(2, "0")].join("-");
  return `FAKESNIFF-lookbook-${iso}.pdf`;
}

function abortError() {
  return typeof DOMException === "function"
    ? new DOMException("Export cancelled", "AbortError")
    : Object.assign(new Error("Export cancelled"), { name: "AbortError" });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
}

function yieldToBrowser() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    } else {
      setTimeout(resolve, 0);
    }
  });
}

async function decodePhoto(blob, signal) {
  throwIfAborted(signal);
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
      throwIfAborted(signal);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close?.(),
      };
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      // Safari has shipped createImageBitmap without the orientation option.
      try {
        const bitmap = await createImageBitmap(blob);
        throwIfAborted(signal);
        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          close: () => bitmap.close?.(),
        };
      } catch (fallbackError) {
        if (fallbackError?.name === "AbortError") throw fallbackError;
      }
    }
  }

  if (typeof Image !== "function") throw new Error("This browser cannot decode the photograph.");
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    throwIfAborted(signal);
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close() {},
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function canvasToJpeg(canvas, quality) {
  if (typeof canvas.convertToBlob === "function") {
    return canvas.convertToBlob({ type: "image/jpeg", quality });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Photo compression failed.")),
      "image/jpeg", quality);
  });
}

function drawToCanvas(source, width, height) {
  const canvas = makeCanvas(width, height);
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("This browser cannot prepare the photograph.");
  context.fillStyle = "#f4f1e8";
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, width, height);
  return canvas;
}

async function preparePhoto(blob, signal) {
  if (!(blob instanceof Blob) || !blob.size) throw new Error("The photograph was empty.");
  const decoded = await decodePhoto(blob, signal);
  try {
    let dimensions = targetPixelSize(decoded.width, decoded.height);
    let canvas = drawToCanvas(decoded.source, dimensions.width, dimensions.height);
    let output = await canvasToJpeg(canvas, 0.84);
    throwIfAborted(signal);

    if (output.size > MAX_EMBEDDED_IMAGE_BYTES) output = await canvasToJpeg(canvas, 0.76);
    if (output.size > MAX_EMBEDDED_IMAGE_BYTES) output = await canvasToJpeg(canvas, 0.68);

    if (output.size > MAX_EMBEDDED_IMAGE_BYTES) {
      dimensions = {
        width: Math.max(1, Math.round(dimensions.width * 0.82)),
        height: Math.max(1, Math.round(dimensions.height * 0.82)),
      };
      canvas.width = 1;
      canvas.height = 1;
      canvas = drawToCanvas(decoded.source, dimensions.width, dimensions.height);
      output = await canvasToJpeg(canvas, 0.72);
    }

    let reduction = 0;
    while (output.size > MAX_EMBEDDED_IMAGE_BYTES && reduction < 3
      && Math.max(dimensions.width, dimensions.height) > 900) {
      reduction += 1;
      dimensions = {
        width: Math.max(1, Math.round(dimensions.width * 0.8)),
        height: Math.max(1, Math.round(dimensions.height * 0.8)),
      };
      canvas.width = 1;
      canvas.height = 1;
      canvas = drawToCanvas(decoded.source, dimensions.width, dimensions.height);
      output = await canvasToJpeg(canvas, 0.7);
      throwIfAborted(signal);
    }

    const bytes = await output.arrayBuffer();
    canvas.width = 1;
    canvas.height = 1;
    return { bytes, width: dimensions.width, height: dimensions.height };
  } finally {
    decoded.close();
  }
}

class WorkerBridge {
  constructor(signal) {
    this.sequence = 0;
    this.pending = new Map();
    this.closed = false;
    this.worker = new Worker(new URL("hub-lookbook-pdf-worker.js", import.meta.url));
    this.worker.onmessage = ({ data }) => {
      const pending = this.pending.get(data?.requestId);
      if (!pending) return;
      this.pending.delete(data.requestId);
      if (data.type === "error") pending.reject(new Error(data.message || "PDF build failed."));
      else pending.resolve(data);
    };
    this.worker.onerror = () => this.close(new Error("The PDF builder stopped unexpectedly."));
    this.onAbort = () => this.close(signal?.reason instanceof Error ? signal.reason : abortError());
    signal?.addEventListener("abort", this.onAbort, { once: true });
    this.signal = signal;
  }

  request(type, payload = {}, transfer = []) {
    throwIfAborted(this.signal);
    if (this.closed) return Promise.reject(new Error("The PDF builder is closed."));
    const requestId = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage({ type, requestId, ...payload }, transfer);
    });
  }

  close(reason = null) {
    if (this.closed) return;
    this.closed = true;
    this.signal?.removeEventListener("abort", this.onAbort);
    this.worker.terminate();
    if (reason) {
      for (const pending of this.pending.values()) pending.reject(reason);
    }
    this.pending.clear();
  }
}

export async function exportLookbookPdf({
  items,
  getImageBlob,
  signal,
  onProgress = () => {},
  allowMissingPhotos = false,
  date = new Date(),
} = {}) {
  if (!Array.isArray(items) || !items.length) throw new Error("Select at least one Lookbook item.");
  if (items.length > MAX_EXPORT_ITEMS) {
    throw new Error(`Select no more than ${MAX_EXPORT_ITEMS} items for one PDF.`);
  }
  if (typeof getImageBlob !== "function") throw new Error("The photo loader is unavailable.");

  const safeItems = items.map(normaliseExportItem).map(prepareItemText);
  const displayDate = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "long", year: "numeric",
  }).format(date);
  const bridge = new WorkerBridge(signal);
  let preparedImageBytes = 0;

  try {
    await bridge.request("start", {
      meta: { itemCount: safeItems.length, displayDate },
    });

    for (let index = 0; index < safeItems.length; index += 1) {
      throwIfAborted(signal);
      const item = safeItems[index];
      onProgress({ phase: "preparing", current: index + 1, total: safeItems.length, title: item.title });
      await yieldToBrowser();

      let photo = null;
      if (item.hasPhoto) {
        let lastError = null;
        for (let attempt = 0; attempt < 2 && !photo; attempt += 1) {
          try {
            const blob = await getImageBlob(items[index], signal);
            photo = await preparePhoto(blob, signal);
          } catch (error) {
            if (error?.name === "AbortError") throw error;
            lastError = error;
            await yieldToBrowser();
          }
        }
        if (!photo && !allowMissingPhotos) {
          throw new LookbookImageError([{ id: item.id, title: item.title, cause: lastError }]);
        }
      }

      onProgress({ phase: "building", current: index + 1, total: safeItems.length, title: item.title });
      preparedImageBytes += photo?.bytes?.byteLength || 0;
      if (preparedImageBytes > MAX_PREPARED_IMAGE_BYTES) {
        throw new LookbookTooLargeError(preparedImageBytes);
      }
      const payload = {
        index,
        item,
        photo: photo ? { bytes: photo.bytes, width: photo.width, height: photo.height } : null,
      };
      await bridge.request("item", payload, photo ? [photo.bytes] : []);
    }

    onProgress({ phase: "finishing", current: safeItems.length, total: safeItems.length });
    const result = await bridge.request("finish");
    const pdfBytes = result.bytes;
    if (!(pdfBytes instanceof ArrayBuffer)) throw new Error("The PDF builder returned no file.");
    if (pdfBytes.byteLength > 50 * 1024 * 1024) throw new LookbookTooLargeError(pdfBytes.byteLength);
    return {
      blob: new Blob([pdfBytes], { type: "application/pdf" }),
      fileName: lookbookFileName(date),
      pageCount: Number(result.pageCount) || safeItems.length + 1,
      missingPhotos: Number(result.missingPhotos) || 0,
    };
  } finally {
    bridge.close();
  }
}
