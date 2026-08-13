/* Codex — 2026-08-13: generate a representative browser-worker PDF for Poppler review. */

import fs from "node:fs";
import path from "node:path";
import { createLookbookWorkerHarness, fileArrayBuffer, webRoot } from "./lookbook-worker-harness.js";

const output = path.resolve(process.argv[2] || path.join(webRoot, "tmp", "pdfs", "lookbook-export-fixture.pdf"));
fs.mkdirSync(path.dirname(output), { recursive: true });

const worker = createLookbookWorkerHarness();
await worker.request("start", { meta: { itemCount: 3, displayDate: "13 August 2026" } });

const fixtures = [
  {
    item: {
      id: "black", title: "Nothing is real", category: "tee",
      description: "Heavy black cotton jersey, boxy through the body, with a dry matte print and a compact rib collar.",
      note: "Reference the print placement and the way the blank holds its shape.",
      tags: ["heavy cotton", "boxy fit", "matte print"], hasPhoto: true,
    },
    file: path.join(webRoot, "shirt-black.jpg"), width: 520, height: 520,
  },
  {
    item: {
      id: "cream", title: "Cream blank with an intentionally long construction note", category: "fabric",
      description: "A warm cream jersey with visible weave and a substantial hand. The shoulder sits low and the sleeve opening stays wide. The surface is dry rather than glossy. This description is deliberately long so the fixture proves that the export adds a continuation page instead of clipping factory notes or silently dropping text.",
      note: "Keep the neckline compact. Ask the factory to show two rib weights, photograph the inside seam, confirm shrinkage after wash, and keep the final colour away from bright optical white. The reference is about material and construction, not artwork.",
      tags: ["cream", "jersey", "rib collar", "drop shoulder", "wash test", "factory reference"], hasPhoto: true,
    },
    file: path.resolve(webRoot, "..", "..", "content", "survey", "pairs", "pair4_REAL.jpeg"),
    width: 3840, height: 2160,
  },
  {
    item: {
      id: "note", title: "Fabric note without a saved photograph", category: "fabric",
      description: "A deliberate text-only reference page, used when the photo is not part of the archive.",
      note: "Request a 300–340 gsm cotton option and record composition before approval.",
      tags: ["gsm", "composition", "sample request"], hasPhoto: false,
    },
    file: null,
  },
];

for (let index = 0; index < fixtures.length; index += 1) {
  const fixture = fixtures[index];
  const bytes = fixture.file ? fileArrayBuffer(fixture.file) : null;
  await worker.request("item", {
    index,
    item: fixture.item,
    photo: bytes ? { bytes, width: fixture.width, height: fixture.height } : null,
  });
}

const result = await worker.request("finish");
fs.writeFileSync(output, new Uint8Array(result.bytes));
console.log(JSON.stringify({ output, pageCount: result.pageCount, bytes: result.bytes.byteLength }));
