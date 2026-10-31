#!/usr/bin/env node
// Pull a deployed worker's own modules down so they can be read or edited here.
// Read-only: it only ever GETs. Nothing in this script uploads or deploys.
//
//   node tools/pull-worker.mjs truth .scratch/truth
//   node tools/pull-worker.mjs truth            # lists the modules instead
//
// Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ID in the environment.
import fs from "node:fs";
import path from "node:path";

const [name, outDir, ...rest] = process.argv.slice(2);
if (!name) {
  console.error("usage: node tools/pull-worker.mjs <worker-name> [outDir]");
  process.exit(2);
}

const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ID;
if (!token || !account) {
  console.error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ID must both be set");
  process.exit(2);
}

const base = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${encodeURIComponent(name)}`;
const auth = { Authorization: `Bearer ${token}` };

const res = await fetch(base, { headers: auth });
if (!res.ok) {
  console.error(`${name}: HTTP ${res.status}`);
  process.exit(1);
}

const type = res.headers.get("content-type") || "";
if (type.indexOf("multipart/form-data") < 0) {
  console.error(`${name}: expected a multipart script, got ${type}`);
  process.exit(1);
}

const form = await res.formData();
const written = [];
for (const [moduleName, value] of form) {
  const isFile = value && typeof value.arrayBuffer === "function";
  if (!outDir) {
    written.push(`${moduleName}\t${isFile ? "file" : "text"}`);
    continue;
  }
  const file = path.join(outDir, moduleName.replace(/[^a-zA-Z0-9._-]/g, "_"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = isFile ? Buffer.from(await value.arrayBuffer()) : Buffer.from(String(value), "utf8");
  fs.writeFileSync(file, body);
  written.push(`${file}\t${body.length} bytes`);
}

if (outDir) {
  const settings = await fetch(base + "/settings", { headers: auth });
  if (settings.ok) {
    const data = await settings.json();
    const ok = data && data.result;
    const lines = [];
    if (ok) {
      lines.push(`compatibility_date ${ok.compatibility_date}`);
      (ok.bindings || []).forEach((b) => {
        const target = b.service || b.namespace_id || b.id || b.bucket_name || b.class_name || "";
        lines.push(`${b.type}\t${b.name}\t${target}`);
      });
    }
    fs.writeFileSync(path.join(outDir, "BINDINGS.txt"), lines.join("\n") + "\n");
    written.push(`${path.join(outDir, "BINDINGS.txt")}\t${lines.length} lines`);
  }
}

console.log(written.join("\n"));
if (rest.length) console.error("extra arguments ignored:", rest.join(" "));
