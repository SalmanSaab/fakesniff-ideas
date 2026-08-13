/* FAKESNIFF Hub - Lookbook PDF worker. Owner: Codex.
 * pdf-lib is vendored at the same origin; no document data leaves the Hub.
 */

importScripts("vendor-pdf-lib.min.js");

const { PDFDocument, StandardFonts, rgb } = self.PDFLib;
const PAGE = [595.28, 841.89];
const MARGIN = 40;
const PHOTO_FRAME = { x: 40, y: 354, width: 515.28, height: 426 };
const COLORS = {
  ink: rgb(0.07, 0.065, 0.06),
  cream: rgb(0.957, 0.945, 0.91),
  paper: rgb(0.985, 0.98, 0.965),
  muted: rgb(0.34, 0.33, 0.30),
  line: rgb(0.77, 0.75, 0.69),
  green: rgb(0.467, 0.773, 0.40),
};

let documentState = null;

function ascii(value) {
  return String(value ?? "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function wrapText(font, value, size, maxWidth) {
  const paragraphs = ascii(value).split(/\n+/);
  const lines = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(""); continue; }
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      if (font.widthOfTextAtSize(word, size) <= maxWidth) {
        line = word;
        continue;
      }
      let chunk = "";
      for (const char of word) {
        if (font.widthOfTextAtSize(chunk + char, size) > maxWidth && chunk) {
          lines.push(chunk);
          chunk = char;
        } else {
          chunk += char;
        }
      }
      line = chunk;
    }
    if (line) lines.push(line);
  }
  return lines;
}

function drawBackground(page, color = COLORS.paper) {
  page.drawRectangle({ x: 0, y: 0, width: PAGE[0], height: PAGE[1], color });
}

function drawCover(meta) {
  const page = documentState.pdf.addPage(PAGE);
  drawBackground(page, COLORS.ink);
  page.drawText("FAKESNIFF", {
    x: MARGIN, y: 780, size: 10, font: documentState.bold, color: COLORS.green,
  });
  page.drawRectangle({ x: MARGIN, y: 752, width: 70, height: 3, color: COLORS.green });
  const title = ["FACTORY", "REFERENCE", "LOOKBOOK"];
  title.forEach((line, index) => page.drawText(line, {
    x: MARGIN, y: 615 - index * 49, size: 39, font: documentState.bold, color: COLORS.cream,
  }));
  page.drawText(`${meta.itemCount} VISUAL REFERENCE${meta.itemCount === 1 ? "" : "S"}`, {
    x: MARGIN, y: 408, size: 10, font: documentState.bold, color: COLORS.green,
  });
  page.drawText(ascii(meta.displayDate).toUpperCase(), {
    x: MARGIN, y: 386, size: 10, font: documentState.regular, color: COLORS.cream,
  });
  page.drawLine({
    start: { x: MARGIN, y: 116 }, end: { x: PAGE[0] - MARGIN, y: 116 },
    thickness: 0.7, color: COLORS.muted,
  });
  const notice = wrapText(documentState.regular,
    "Visual references only - not final artwork, measurements or colour standards.", 9.5, 390);
  notice.forEach((line, index) => page.drawText(line, {
    x: MARGIN, y: 88 - index * 13, size: 9.5, font: documentState.regular, color: COLORS.cream,
  }));
}

function drawHeader(page, item, index, total) {
  page.drawText(`REFERENCE ${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`, {
    x: MARGIN, y: 807, size: 8.5, font: documentState.bold, color: COLORS.green,
  });
  const category = ascii(item.category || "unsorted").toUpperCase();
  const width = documentState.regular.widthOfTextAtSize(category, 8.5);
  page.drawText(category, {
    x: PAGE[0] - MARGIN - width, y: 807, size: 8.5, font: documentState.regular, color: COLORS.muted,
  });
}

function drawPhoto(page, image, dimensions, hadSavedPhoto) {
  page.drawRectangle({
    ...PHOTO_FRAME, color: rgb(0.91, 0.90, 0.86), borderColor: COLORS.line, borderWidth: 0.5,
  });
  if (!image || !dimensions?.width || !dimensions?.height) {
    const label = hadSavedPhoto ? "PHOTOGRAPH UNAVAILABLE IN THIS EXPORT" : "NO PHOTOGRAPH SAVED";
    const width = documentState.bold.widthOfTextAtSize(label, 10);
    page.drawText(label, {
      x: PHOTO_FRAME.x + (PHOTO_FRAME.width - width) / 2,
      y: PHOTO_FRAME.y + PHOTO_FRAME.height / 2,
      size: 10, font: documentState.bold, color: COLORS.muted,
    });
    return;
  }
  const scale = Math.min(PHOTO_FRAME.width / dimensions.width, PHOTO_FRAME.height / dimensions.height);
  const width = dimensions.width * scale;
  const height = dimensions.height * scale;
  page.drawImage(image, {
    x: PHOTO_FRAME.x + (PHOTO_FRAME.width - width) / 2,
    y: PHOTO_FRAME.y + (PHOTO_FRAME.height - height) / 2,
    width, height,
  });
}

function buildSections(item) {
  const sections = [];
  if (item.description) sections.push({ label: "DESCRIPTION", text: item.description });
  if (item.note) sections.push({ label: "WHY WE SAVED IT", text: item.note });
  if (item.tags?.length) sections.push({ label: "TAGS", text: item.tags.join("  /  ") });
  if (!sections.length) sections.push({ label: "REFERENCE NOTE", text: "No description has been added yet." });
  return sections;
}

function sectionLineCount(sections, width = 515) {
  return sections.reduce((sum, section) =>
    sum + 1 + wrapText(documentState.regular, section.text, 10.5, width).length, 0);
}

function drawCompactDetails(page, sections, hasContinuation, startY, maxLines) {
  let y = startY;
  let used = 0;
  outer: for (const section of sections) {
    if (used >= maxLines) break;
    page.drawText(section.label, {
      x: MARGIN, y, size: 7.5, font: documentState.bold, color: COLORS.green,
    });
    y -= 15;
    used += 1;
    const lines = wrapText(documentState.regular, section.text, 10.5, 515);
    for (const line of lines) {
      if (used >= maxLines) break outer;
      page.drawText(line, {
        x: MARGIN, y, size: 10.5, font: documentState.regular, color: COLORS.ink,
      });
      y -= 13.5;
      used += 1;
    }
    y -= 6;
  }
  if (hasContinuation) {
    page.drawText("FULL NOTES CONTINUE ON THE NEXT PAGE", {
      x: MARGIN, y: 86, size: 7.5, font: documentState.bold, color: COLORS.muted,
    });
  }
}

function addDetailPages(item, index, total, sections) {
  const queue = sections.map((section) => ({
    label: section.label,
    lines: wrapText(documentState.regular, section.text, 11, 515),
    offset: 0,
  }));
  while (queue.length) {
    const page = documentState.pdf.addPage(PAGE);
    drawBackground(page);
    drawHeader(page, item, index, total);
    const detailTitleLines = wrapText(documentState.bold, ascii(item.title).toUpperCase(), 19, 515).slice(0, 3);
    detailTitleLines.forEach((line, titleIndex) => page.drawText(line, {
      x: MARGIN, y: 760 - titleIndex * 22, size: 19, font: documentState.bold, color: COLORS.ink,
    }));
    const detailsY = 760 - detailTitleLines.length * 22 - 6;
    page.drawText("DETAILS", {
      x: MARGIN, y: detailsY, size: 8, font: documentState.bold, color: COLORS.green,
    });
    let y = detailsY - 34;
    while (queue.length && y > 80) {
      const section = queue[0];
      if (section.offset === 0) {
        page.drawText(section.label, {
          x: MARGIN, y, size: 8, font: documentState.bold, color: COLORS.muted,
        });
        y -= 19;
      }
      while (section.offset < section.lines.length && y > 80) {
        page.drawText(section.lines[section.offset], {
          x: MARGIN, y, size: 11, font: documentState.regular, color: COLORS.ink,
        });
        section.offset += 1;
        y -= 15;
      }
      if (section.offset >= section.lines.length) {
        queue.shift();
        y -= 18;
      }
    }
  }
}

async function addItem(message) {
  const { item, photo, index } = message;
  const page = documentState.pdf.addPage(PAGE);
  drawBackground(page);
  drawHeader(page, item, index, documentState.meta.itemCount);

  let image = null;
  if (photo?.bytes) image = await documentState.pdf.embedJpg(new Uint8Array(photo.bytes));
  else documentState.missingPhotos += item.hasPhoto ? 1 : 0;
  drawPhoto(page, image, photo, item.hasPhoto);

  const title = ascii(item.title || "Reference");
  const fullTitleLines = wrapText(documentState.bold, title, 21, 515);
  const titleLines = fullTitleLines.slice(0, 2);
  titleLines.forEach((line, lineIndex) => page.drawText(line, {
    x: MARGIN, y: 326 - lineIndex * 23, size: 21, font: documentState.bold, color: COLORS.ink,
  }));

  const sections = buildSections(item);
  if (fullTitleLines.length > 2) sections.unshift({ label: "FULL TITLE", text: title });
  const compactStart = titleLines.length > 1 ? 270 : 300;
  const availableLines = titleLines.length > 1 ? 10 : 13;
  const continuation = sectionLineCount(sections) > availableLines || fullTitleLines.length > 2;
  drawCompactDetails(page, sections, continuation, compactStart,
    continuation ? Math.min(7, availableLines) : availableLines);
  if (continuation) addDetailPages(item, index, documentState.meta.itemCount, sections);
}

function drawFooters() {
  const pages = documentState.pdf.getPages();
  const contentTotal = Math.max(0, pages.length - 1);
  pages.slice(1).forEach((page, index) => {
    page.drawLine({
      start: { x: MARGIN, y: 49 }, end: { x: PAGE[0] - MARGIN, y: 49 },
      thickness: 0.5, color: COLORS.line,
    });
    page.drawText("FAKESNIFF / LOOKBOOK", {
      x: MARGIN, y: 28, size: 7.5, font: documentState.bold, color: COLORS.muted,
    });
    const number = `${String(index + 1).padStart(2, "0")} / ${String(contentTotal).padStart(2, "0")}`;
    const width = documentState.regular.widthOfTextAtSize(number, 7.5);
    page.drawText(number, {
      x: PAGE[0] - MARGIN - width, y: 28, size: 7.5, font: documentState.regular, color: COLORS.muted,
    });
  });
}

async function start(meta) {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  documentState = { pdf, regular, bold, meta, missingPhotos: 0 };
  pdf.setTitle("FAKESNIFF Factory Reference Lookbook");
  pdf.setAuthor("FAKESNIFF");
  pdf.setSubject("Factory visual references");
  pdf.setCreator("FAKESNIFF Hub");
  pdf.setProducer("FAKESNIFF Hub using pdf-lib 1.17.1");
  drawCover(meta);
}

async function finish() {
  drawFooters();
  const pageCount = documentState.pdf.getPageCount();
  const missingPhotos = documentState.missingPhotos;
  const bytes = await documentState.pdf.save({ useObjectStreams: true, addDefaultPage: false });
  documentState = null;
  return { bytes: bytes.buffer, pageCount, missingPhotos };
}

self.onmessage = async ({ data }) => {
  const requestId = data?.requestId;
  try {
    if (data.type === "start") await start(data.meta);
    else if (data.type === "item") await addItem(data);
    else if (data.type === "finish") {
      const result = await finish();
      self.postMessage({ type: "ok", requestId, ...result }, [result.bytes]);
      return;
    } else {
      throw new Error("Unknown PDF worker request.");
    }
    self.postMessage({ type: "ok", requestId });
  } catch (error) {
    documentState = null;
    self.postMessage({ type: "error", requestId, message: String(error?.message || "PDF build failed.") });
  }
};
