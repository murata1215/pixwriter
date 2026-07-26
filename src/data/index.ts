/**
 * CLI entry point for data-driven city profile generation.
 *
 * Usage:
 *   npx tsx src/data/index.ts --city=prague --ref=nagoya --out=/home/pixwriter/out/ --mock
 *   npx tsx src/data/index.ts --city=prague --ref=nagoya --slug=czechia-prague --post --out=/home/pixwriter/out/
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateCityArticle } from "./citygen.js";
import { end as endDb } from "./db.js";
import { log } from "../logger.js";
import type { MockData } from "./queries.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(): {
  city: string;
  ref: string;
  out: string;
  mock: boolean;
  post: boolean;
  slug: string;
} {
  const args = process.argv.slice(2);
  let city = "";
  let ref = "nagoya";
  let out = "";
  let mock = false;
  let post = false;
  let slug = "";

  for (const arg of args) {
    if (arg.startsWith("--city=")) city = arg.slice(7);
    else if (arg.startsWith("--ref=")) ref = arg.slice(6);
    else if (arg.startsWith("--out=")) out = arg.slice(6);
    else if (arg.startsWith("--slug=")) slug = arg.slice(7);
    else if (arg === "--mock") mock = true;
    else if (arg === "--post") post = true;
  }

  if (!city) {
    console.error("Error: --city=<id> is required");
    process.exit(1);
  }
  if (!out) {
    console.error("Error: --out=<dir> is required");
    process.exit(1);
  }
  if (post && !slug) {
    console.error("Error: --slug=<slug> is required when --post is specified");
    process.exit(1);
  }

  return { city, ref, out, mock, post, slug };
}

async function main() {
  const { city, ref, out, mock: isMock, post, slug } = parseArgs();

  log("INFO", `[data-gen] Starting: city=${city} ref=${ref} out=${out} mock=${isMock} post=${post} slug=${slug || "(none)"}`);

  let mockData: MockData | undefined;

  if (isMock) {
    const fixturePath = path.join(__dirname, "fixtures", `${city}.json`);
    if (!fs.existsSync(fixturePath)) {
      console.error(`Error: Mock fixture not found: ${fixturePath}`);
      process.exit(1);
    }
    mockData = JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as MockData;
    log("INFO", `[data-gen] Loaded mock data from ${fixturePath}`);
  }

  try {
    const result = await generateCityArticle({
      cityId: city,
      refCityId: ref,
      outDir: out,
      mock: mockData,
      post,
      slug,
    });

    console.log(`\nGenerated:`);
    console.log(`  HTML: ${result.htmlPath}`);
    console.log(`  Meta: ${result.metaPath}`);
    if (result.postId) {
      console.log(`  PixBlog post_id: ${result.postId}`);
    }
    console.log(`\nDone.`);
  } catch (err) {
    log("ERROR", `[data-gen] Failed: ${err}`);
    console.error(`Error: ${err}`);
    process.exit(1);
  } finally {
    await endDb();
  }
}

main();
