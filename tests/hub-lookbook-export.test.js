/* Codex — 2026-08-13: Lookbook selection, image sizing and real PDF worker tests. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  fitInside,
  lookbookFileName,
  MAX_EXPORT_ITEMS,
  normaliseExportItem,
  prepareItemText,
  toPdfText,
  targetPixelSize,
  validateExportText,
} from "../hub-lookbook-export.js";
import { createLookbookWorkerHarness, fileArrayBuffer, webRoot } from "./lookbook-worker-harness.js";

test("export item projection keeps factory content and drops private storage fields", () => {
  const result = normaliseExportItem({
    id: "item-1",
    title: "Heavy tee",
    category: "tee",
    note: "Keep the collar",
    tags: ["Rib", "black"],
    storage_path: "private/workspace/path.jpg",
    source_url: "https://example.test/private",
    added_by: "Someone",
    ai_analysis: { description: "A boxy heavyweight tee.", tags: ["rib", "Cotton"] },
  });
  assert.deepEqual(result, {
    id: "item-1",
    title: "Heavy tee",
    category: "tee",
    description: "A boxy heavyweight tee.",
    note: "Keep the collar",
    tags: ["rib", "black", "cotton"],
    hasPhoto: true,
  });
  assert.equal("storage_path" in result, false);
  assert.equal("source_url" in result, false);
  assert.equal("added_by" in result, false);
});

test("factory text is transliterated deliberately or fails before export instead of disappearing", () => {
  assert.equal(toPdfText("İstanbul'da ağır kumaş — crème"), "Istanbul'da agir kumas - creme");
  assert.equal(toPdfText("30° ±2° / 50×70 cm / 12€"), "30 degrees +/-2 degrees / 50 x 70 cm / 12EUR");
  assert.deepEqual(prepareItemText({
    title: "Maß 50×70", category: "detail", description: "30° ±2°", note: "12€", tags: ["œillet"],
  }), {
    title: "Mass 50 x 70", category: "detail", description: "30 degrees +/-2 degrees",
    note: "12EUR", tags: ["oeillet"],
  });
  assert.equal(toPdfText("قماش ثقيل"), null);
  assert.throws(() => validateExportText({
    title: "Arabic fabric note", category: "fabric", description: "قماش ثقيل", note: "", tags: [],
  }), (error) => error?.name === "LookbookTextError" && error.itemTitle === "Arabic fabric note");
});

test("photos target the actual A4 frame at print resolution without upscaling", () => {
  assert.deepEqual(targetPixelSize(4000, 3000), { width: 2146, height: 1610 });
  assert.deepEqual(targetPixelSize(3000, 4000), { width: 1313, height: 1750 });
  assert.deepEqual(targetPixelSize(520, 520), { width: 520, height: 520 });
  assert.deepEqual(fitInside(1600, 900, 515, 420), {
    width: 515,
    height: 289.6875,
    scale: 0.321875,
  });
  assert.equal(MAX_EXPORT_ITEMS, 40);
  assert.match(lookbookFileName(new Date("2026-08-13T12:00:00Z")), /2026-08-13\.pdf$/);
});

test("selection is a sibling of the detail button and export assets ship locally", () => {
  const source = fs.readFileSync(path.join(webRoot, "hub-lookbook.js"), "utf8");
  assert.match(source, /<article class="lb-cardwrap/);
  assert.match(source, /<\/button>\s*<label class="lb-select-control"/);
  assert.doesNotMatch(source, /<button class="lb-card"[^>]*>\s*<input/);
  assert.match(source, /new Set\(\)/);
  assert.match(source, /fetchImageBlob\(item\.storage_path, signal\)/);

  for (const asset of [
    "hub-lookbook-export.js",
    "hub-lookbook-pdf-worker.js",
    "vendor-pdf-lib.min.js",
    "vendor-pdf-lib-LICENSE.txt",
  ]) {
    assert.ok(fs.statSync(path.join(webRoot, asset)).size > 0, `${asset} exists`);
  }
  assert.ok(fs.statSync(path.join(webRoot, "vendor-pdf-lib.min.js")).size > 500_000);
  const vendorHash = crypto.createHash("sha256")
    .update(fs.readFileSync(path.join(webRoot, "vendor-pdf-lib.min.js"))).digest("hex");
  assert.equal(vendorHash, "0f9a5cad07941f0826586c94e089d89b918c46e5c17cf2d5a3c6f666e3bc694f");
});

test("the real worker builds a cover and one A4 reference page", async () => {
  const worker = createLookbookWorkerHarness();
  await worker.request("start", { meta: { itemCount: 1, displayDate: "13 August 2026" } });
  const photoBytes = fileArrayBuffer(path.join(webRoot, "shirt-black.jpg"));
  await worker.request("item", {
    index: 0,
    item: {
      id: "item-1", title: "Nothing is real", category: "tee",
      description: "A heavyweight black cotton tee with a matte front print.",
      note: "Use this only as a fit and placement reference.", tags: ["heavy cotton", "boxy"],
      hasPhoto: true,
    },
    photo: { bytes: photoBytes, width: 520, height: 520 },
  });
  const result = await worker.request("finish");
  assert.equal(result.pageCount, 2);
  assert.equal(result.missingPhotos, 0);
  const header = Buffer.from(new Uint8Array(result.bytes).slice(0, 5)).toString("ascii");
  assert.equal(header, "%PDF-");
  assert.ok(result.bytes.byteLength < 2_000_000);
});

test("long factory notes add continuation pages instead of clipping", async () => {
  const worker = createLookbookWorkerHarness();
  await worker.request("start", { meta: { itemCount: 1, displayDate: "13 August 2026" } });
  const paragraph = "Confirm seam construction, wash shrinkage, fabric composition and print position before approval. ";
  await worker.request("item", {
    index: 0,
    item: {
      id: "long", title: "A deliberately long factory reference title that cannot stay on one line",
      category: "fabric", description: paragraph.repeat(18), note: paragraph.repeat(16),
      tags: ["sample", "wash test", "composition"], hasPhoto: false,
    },
    photo: null,
  });
  const result = await worker.request("finish");
  assert.ok(result.pageCount >= 4, `expected cover, reference and continuation pages; got ${result.pageCount}`);
});
