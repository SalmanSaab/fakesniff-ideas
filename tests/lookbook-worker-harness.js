/* Codex — 2026-08-13: exercise the exact browser worker in Node for PDF QA. */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function fileArrayBuffer(filePath) {
  const bytes = fs.readFileSync(filePath);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export function createLookbookWorkerHarness() {
  const messages = [];
  const sandbox = {
    console,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
  };
  const context = vm.createContext(sandbox);
  context.self = context;
  context.postMessage = (message) => messages.push(message);
  context.importScripts = (asset) => {
    const source = fs.readFileSync(path.join(ROOT, asset), "utf8");
    vm.runInContext(source, context, { filename: asset });
  };
  const workerSource = fs.readFileSync(path.join(ROOT, "hub-lookbook-pdf-worker.js"), "utf8");
  vm.runInContext(workerSource, context, { filename: "hub-lookbook-pdf-worker.js" });

  let requestId = 0;
  return {
    async request(type, payload = {}) {
      const id = ++requestId;
      await context.onmessage({ data: { type, requestId: id, ...payload } });
      const index = messages.findIndex((message) => message.requestId === id);
      if (index < 0) throw new Error(`Worker did not answer ${type}.`);
      const [message] = messages.splice(index, 1);
      if (message.type === "error") throw new Error(message.message);
      return message;
    },
  };
}

export const webRoot = ROOT;
