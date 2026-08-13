/* Codex — 2026-08-13: keep private QA files out and worker assets in deploys. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const deploy = fs.readFileSync(new URL("../deploy.sh", import.meta.url), "utf8");
const ignore = fs.readFileSync(new URL("../.gitignore", import.meta.url), "utf8");

test("deploy excludes QA output and validates worker dependencies", () => {
  assert.match(deploy, /"tmp" "output"/);
  assert.match(ignore, /^tmp\/$/m);
  assert.match(deploy, /hub-lookbook-pdf-worker\\\.js/);
  assert.match(deploy, /hub-lookbook-export\\\.js/);
  assert.match(deploy, /vendor-pdf-lib\\\.min\\\.js/);
  assert.match(deploy, /MISSING in \$name/);
});
