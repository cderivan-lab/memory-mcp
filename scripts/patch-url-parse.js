#!/usr/bin/env node
/**
 * Replace the deprecated `url.parse()` calls in azure-devops-node-api's
 * VsoClient with the WHATWG URL API.
 *
 * `@vscode/vsce` depends on azure-devops-node-api (^12.5.0), and the published
 * versions through at least 17.0.1 still call `url.parse()`, which Node emits
 * DEP0169 for on every startup. The upstream package is unmaintained, so this
 * idempotent postinstall patch rewrites the two call sites in place.
 *
 * The original `url` module is still used by `url.resolve()`, so the import is
 * kept. Only the constructor's pathname extraction and the two `resolveUrl`
 * helpers are rewritten. `new URL(...).pathname` matches `url.parse().pathname`
 * for absolute URLs; for relative inputs `url.parse()` returned an object with
 * an empty pathname, which `new URL()` rejects, but VsoClient is always
 * constructed with an absolute base URL.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const file = path.join(__dirname, "..", "node_modules", "azure-devops-node-api", "VsoClient.js");

if (!fs.existsSync(file)) {
  // Not installed (e.g. offline or a different package graph) — nothing to do.
  process.exit(0);
}

let src = fs.readFileSync(file, "utf8");

const replacements = [
  // Constructor: extract the pathname with the WHATWG API.
  {
    from: "this.basePath = url.parse(baseUrl).pathname;",
    to: "this.basePath = new URL(baseUrl).pathname;",
  },
  // resolveUrl helper.
  {
    from: "return url.resolve(this.baseUrl, path.join(this.basePath, relativeUrl));",
    to: "return new URL(path.join(this.basePath, relativeUrl), this.baseUrl).href;",
  },
];

let changed = false;
for (const { from, to } of replacements) {
  if (src.includes(to)) {
    continue; // already patched
  }
  if (!src.includes(from)) {
    // Unexpected layout — fail loudly so a future upstream change is visible.
    throw new Error(`patch-url-parse: expected pattern not found in ${file}: ${from}`);
  }
  src = src.replace(from, to);
  changed = true;
}

if (changed) {
  fs.writeFileSync(file, src);
}
