// Run after `npm run build`. Checks what the build traced into the deployed
// functions that draw finished PDFs.
//
// Each route must still list the fonts and the HarfBuzz subsetter that
// src/lib/services/pdf-fonts.ts reads at runtime, and must not list
// repository docs, tests or raw source. A file path the build cannot work
// out (such as a path looked up from a map at run time) makes Next.js trace
// the whole project into every function that imports it. See issue #108.
//
// Usage: node scripts/check-function-traces.ts [path to .next]

import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const nextDir = path.resolve(process.argv[2] ?? ".next");

// The signing page and two signing API routes that reach the PDF code.
const ROUTES = [
  "sign/[token]/page.js.nft.json",
  "api/signing/[token]/submit/route.js.nft.json",
  "api/signing/[token]/provider/start/route.js.nft.json",
];

const REQUIRED = [
  "src/assets/fonts/NotoSans-Regular.ttf",
  "src/assets/fonts/NotoSans-Bold.ttf",
  "src/assets/fonts/NotoSansCJKjp-Regular.ttf",
  "src/assets/fonts/GreatVibes-Regular.ttf",
  "node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm",
];

// Project files no function needs at runtime.
const FORBIDDEN: { test: (file: string) => boolean; label: string }[] = [
  { label: "docs/", test: (file) => file.startsWith("docs/") },
  { label: "e2e/", test: (file) => file.startsWith("e2e/") },
  { label: "db/", test: (file) => file.startsWith("db/") },
  { label: "scripts/", test: (file) => file.startsWith("scripts/") },
  {
    label: "test files",
    test: (file) => /\.(test|dbtest|spec)\.[cm]?[jt]sx?$/.test(file),
  },
  {
    label: "source code",
    test: (file) => file.startsWith("src/") && /\.[cm]?[jt]sx?$/.test(file),
  },
  { label: "package-lock.json", test: (file) => file === "package-lock.json" },
];

let failed = false;

for (const route of ROUTES) {
  const manifestPath = path.join(nextDir, "server", "app", route);

  if (!fs.existsSync(manifestPath)) {
    console.error(`${route}: no trace file at ${manifestPath}`);
    failed = true;
    continue;
  }

  const { files } = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    files: string[];
  };
  const traced = new Set(
    files.map((file) =>
      path
        .relative(projectRoot, path.resolve(path.dirname(manifestPath), file))
        .split(path.sep)
        .join("/"),
    ),
  );

  const missing = REQUIRED.filter((file) => !traced.has(file));
  const unwanted = [...traced].filter(
    (file) =>
      !file.startsWith("../") &&
      !file.startsWith("node_modules/") &&
      !file.startsWith(".next/") &&
      FORBIDDEN.some(({ test }) => test(file)),
  );

  if (missing.length > 0) {
    failed = true;
    console.error(`${route}: missing files the PDF code reads at runtime:`);
    for (const file of missing) console.error(`  ${file}`);
  }

  if (unwanted.length > 0) {
    failed = true;
    const labels = FORBIDDEN.filter(({ test }) => unwanted.some(test)).map(
      ({ label }) => label,
    );
    console.error(
      `${route}: ${unwanted.length} project files traced that no function needs (${labels.join(", ")}), for example:`,
    );
    for (const file of unwanted.slice(0, 5)) console.error(`  ${file}`);
  }

  if (missing.length === 0 && unwanted.length === 0) {
    console.log(`${route}: ok (${traced.size} files)`);
  }
}

if (failed) {
  process.exitCode = 1;
}
