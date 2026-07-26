/**
 * Wikimedia Commons photo search, license filtering, and PixBlog upload.
 */
import fs from "node:fs";
import { log } from "../logger.js";

// ---- License filter ----

const ALLOWED_PATTERNS = [
  /^cc0$/i,
  /^public\s*domain$/i,
  /^pd/i,
  /^cc[\s-]by[\s-][\d.]+$/i,        // CC BY x.0
  /^cc[\s-]by[\s-]sa[\s-][\d.]+$/i,  // CC BY-SA x.0
  /^cc[\s-]by$/i,
  /^cc[\s-]by[\s-]sa$/i,
];

const REJECTED_PATTERNS = [
  /nc/i,   // NonCommercial
  /nd/i,   // NoDerivatives
  /gfdl/i, // GFDL only (without CC)
];

function isLicenseAllowed(licenseShort: string): boolean {
  if (!licenseShort || licenseShort.trim() === "") return false;
  const lic = licenseShort.trim();

  // Reject first (NC/ND take priority)
  if (REJECTED_PATTERNS.some((p) => p.test(lic))) return false;

  // Then check allowed
  return ALLOWED_PATTERNS.some((p) => p.test(lic));
}

// ---- HTML tag stripping ----

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .trim();
}

// ---- Types ----

export interface PhotoCandidate {
  pixblogUrl: string;
  artist: string;
  license: string;
  commonsPage: string;
  figcaption: string;
}

interface WikiImageInfo {
  thumburl?: string;
  url?: string;
  descriptionurl?: string;
  extmetadata?: {
    LicenseShortName?: { value: string };
    License?: { value: string };
    Artist?: { value: string };
    ImageDescription?: { value: string };
  };
}

interface WikiPage {
  title: string;
  imageinfo?: WikiImageInfo[];
}

// ---- Main search function ----

export async function searchCityPhotos(
  cityEnName: string,
  cityJaName: string,
  pixblogBaseUrl: string
): Promise<PhotoCandidate[]> {
  log("INFO", `[photo] Searching Wikimedia Commons for: ${cityEnName}`);

  // Read token from file (same as citygen postDraft)
  const tokenPath = "/home/pixwriter/.pixblog_token";
  let token: string;
  try {
    token = fs.readFileSync(tokenPath, "utf-8").trim();
  } catch {
    log("WARN", "[photo] .pixblog_token not found, skipping photo upload");
    return [];
  }

  // Search Wikimedia Commons
  const searchUrl = new URL("https://commons.wikimedia.org/w/api.php");
  searchUrl.searchParams.set("action", "query");
  searchUrl.searchParams.set("generator", "search");
  searchUrl.searchParams.set("gsrsearch", `${cityEnName} skyline`);
  searchUrl.searchParams.set("gsrnamespace", "6"); // File namespace
  searchUrl.searchParams.set("gsrlimit", "10");
  searchUrl.searchParams.set("prop", "imageinfo");
  searchUrl.searchParams.set("iiprop", "url|extmetadata");
  searchUrl.searchParams.set("iiurlwidth", "1200");
  searchUrl.searchParams.set("format", "json");

  let pages: Record<string, WikiPage>;
  try {
    const res = await fetch(searchUrl.toString(), {
      headers: { "User-Agent": "PixWriter/1.0 (pixblog.net; data article generator)" },
    });
    if (!res.ok) {
      log("WARN", `[photo] Wikimedia API returned ${res.status}`);
      return [];
    }
    const data = (await res.json()) as { query?: { pages?: Record<string, WikiPage> } };
    pages = data.query?.pages ?? {};
  } catch (e) {
    log("WARN", `[photo] Wikimedia API error: ${e}`);
    return [];
  }

  const pageList = Object.values(pages);
  log("INFO", `[photo] Found ${pageList.length} candidates from Wikimedia`);

  // Filter by license
  const candidates: {
    page: WikiPage;
    ii: WikiImageInfo;
    license: string;
    artist: string;
  }[] = [];

  for (const page of pageList) {
    const ii = page.imageinfo?.[0];
    if (!ii?.extmetadata) continue;

    const licShort = ii.extmetadata.LicenseShortName?.value ?? "";
    if (!isLicenseAllowed(licShort)) {
      log("INFO", `[photo] Rejected (license=${licShort}): ${page.title}`);
      continue;
    }

    const artist = stripHtml(ii.extmetadata.Artist?.value ?? "Unknown");
    candidates.push({ page, ii, license: licShort, artist });

    if (candidates.length >= 3) break;
  }

  if (candidates.length === 0) {
    log("INFO", "[photo] No photos with allowed license found");
    return [];
  }

  log("INFO", `[photo] ${candidates.length} photos passed license filter`);

  // Download and upload to PixBlog
  const results: PhotoCandidate[] = [];

  for (const c of candidates) {
    const imageUrl = c.ii.thumburl ?? c.ii.url;
    if (!imageUrl) continue;

    try {
      // Download image
      const imgRes = await fetch(imageUrl, {
        headers: { "User-Agent": "PixWriter/1.0 (pixblog.net; data article generator)" },
      });
      if (!imgRes.ok) {
        log("WARN", `[photo] Failed to download: ${imageUrl}`);
        continue;
      }
      const buffer = Buffer.from(await imgRes.arrayBuffer());
      const contentType = imgRes.headers.get("content-type") ?? "image/jpeg";

      // Upload to PixBlog
      const filename = `city-${cityEnName.toLowerCase()}-${Date.now()}.jpg`;
      const formData = new FormData();
      const blob = new Blob([new Uint8Array(buffer)], { type: contentType });
      formData.append("file", blob, filename);

      const uploadRes = await fetch(`${pixblogBaseUrl}/api/v1/images`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      if (!uploadRes.ok) {
        const errText = await uploadRes.text().catch(() => "");
        log("WARN", `[photo] PixBlog upload failed: ${uploadRes.status} ${errText}`);
        continue;
      }

      const uploadData = (await uploadRes.json()) as { url: string };
      const commonsPage = c.ii.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(c.page.title)}`;
      const figcaption = `${cityJaName}の街並み　撮影: ${c.artist} / ${c.license} / Wikimedia Commons`;

      results.push({
        pixblogUrl: uploadData.url,
        artist: c.artist,
        license: c.license,
        commonsPage,
        figcaption,
      });

      log("INFO", `[photo] Uploaded: ${uploadData.url} (${c.license}, ${c.artist.substring(0, 40)})`);
    } catch (e) {
      log("WARN", `[photo] Error processing ${c.page.title}: ${e}`);
    }
  }

  return results;
}
