/**
 * CLI entry point for data-driven city profile generation.
 *
 * Usage:
 *   npx tsx src/data/index.ts --city=prague --ref=nagoya --out=/home/pixwriter/out/ --mock
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateCityArticle } from "./citygen.js";
import { end as endDb } from "./db.js";
import { log } from "../logger.js";
import type { MockData } from "./queries.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(): { city: string; ref: string; out: string; mock: boolean } {
  const args = process.argv.slice(2);
  let city = "";
  let ref = "nagoya";
  let out = "";
  let mock = false;

  for (const arg of args) {
    if (arg.startsWith("--city=")) city = arg.slice(7);
    else if (arg.startsWith("--ref=")) ref = arg.slice(6);
    else if (arg.startsWith("--out=")) out = arg.slice(6);
    else if (arg === "--mock") mock = true;
  }

  if (!city) {
    console.error("Error: --city=<id> is required");
    process.exit(1);
  }
  if (!out) {
    console.error("Error: --out=<dir> is required");
    process.exit(1);
  }

  return { city, ref, out, mock };
}

async function main() {
  const { city, ref, out, mock: isMock } = parseArgs();

  log("INFO", `[data-gen] Starting: city=${city} ref=${ref} out=${out} mock=${isMock}`);

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
    const { htmlPath, metaPath } = await generateCityArticle(
      city,
      ref,
      out,
      mockData
    );

    console.log(`\nGenerated:`);
    console.log(`  HTML: ${htmlPath}`);
    console.log(`  Meta: ${metaPath}`);
    console.log(`\nDone.`);
  } catch (err) {
    log("ERROR", `[data-gen] Failed: ${err}`);
    console.error(`Error: ${err}`);
    process.exit(1);
  } finally {
    if (!isMock) {
      await endDb();
    }
  }
}

main();
