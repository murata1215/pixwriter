import OpenAI from "openai";
import sharp from "sharp";
import { OPENAI_API_KEY, EYECATCH_MODEL, EYECATCH_COST_PER_IMAGE } from "./config.js";
import { isImageBudgetExceeded, recordImageUsage } from "./budget.js";
import { uploadImage } from "./pixblog-api.js";
import { log } from "./logger.js";

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

const EYECATCH_BASE_PROMPT =
  "A flat, simple illustration for a tech blog article. No text or letters anywhere in the image. Calm, muted colors. Clean minimal design with subtle tech-related visual elements.";

/**
 * Generate an eyecatch image using OpenAI gpt-image-1, upload to PixBlog, return URL.
 * Returns null on any failure (caller should continue without image).
 */
export async function generateAndUploadEyecatch(
  title: string,
  topic: string
): Promise<string | null> {
  if (!openai) {
    log("WARN", "OpenAI API key not configured. Skipping eyecatch generation.");
    return null;
  }

  if (isImageBudgetExceeded()) {
    log("WARN", "Image budget exceeded. Skipping eyecatch generation.");
    return null;
  }

  try {
    log("INFO", `Generating eyecatch for: ${title}`);

    const prompt = `${EYECATCH_BASE_PROMPT} About: ${title} (${topic})`;

    const response = await openai.images.generate({
      model: EYECATCH_MODEL,
      prompt,
      n: 1,
      size: "1024x1024",
      quality: "low",
    });

    const imageData = response.data?.[0];
    if (!imageData) {
      log("WARN", "OpenAI returned no image data");
      return null;
    }

    // gpt-image-1 returns base64 by default
    let buffer: Buffer;
    if (imageData.b64_json) {
      buffer = Buffer.from(imageData.b64_json, "base64");
    } else if (imageData.url) {
      // Fallback: fetch from URL
      const res = await fetch(imageData.url);
      buffer = Buffer.from(await res.arrayBuffer());
    } else {
      log("WARN", "OpenAI image response has no b64_json or url");
      return null;
    }

    // Record cost
    recordImageUsage(EYECATCH_COST_PER_IMAGE);

    // Upload to PixBlog
    const filename = `eyecatch-${Date.now()}.png`;
    const result = await uploadImage(buffer, filename, "image/png");
    log("INFO", `Eyecatch uploaded: ${result.url}`);
    return result.url;
  } catch (err) {
    log("WARN", `Eyecatch generation failed: ${err}`);
    return null;
  }
}

/**
 * Convert SVG string to PNG buffer using sharp.
 * Returns null on failure.
 */
export async function svgToPng(svgString: string): Promise<Buffer | null> {
  try {
    const svgBuffer = Buffer.from(svgString);
    const pngBuffer = await sharp(svgBuffer, { density: 150 })
      .resize(1200, null, { withoutEnlargement: false })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .png()
      .toBuffer();
    return pngBuffer;
  } catch (err) {
    log("WARN", `SVG to PNG conversion failed: ${err}`);
    return null;
  }
}

/**
 * Extract SVG from article body, convert to PNG, upload, and replace in body.
 * Returns the modified body with SVG replaced by image markdown.
 */
export async function processBodyDiagrams(body: string): Promise<string> {
  // Match <svg>...</svg> blocks (non-greedy, first occurrence only)
  const svgMatch = body.match(/<svg[\s\S]*?<\/svg>/i);
  if (!svgMatch) return body;

  const svgString = svgMatch[0];
  log("INFO", "Found SVG diagram in article body, converting to PNG");

  const pngBuffer = await svgToPng(svgString);
  if (!pngBuffer) {
    // Remove the SVG block if conversion fails
    return body.replace(svgString, "");
  }

  try {
    const filename = `diagram-${Date.now()}.png`;
    const result = await uploadImage(pngBuffer, filename, "image/png");
    log("INFO", `Diagram uploaded: ${result.url}`);

    // Replace SVG with markdown image
    return body.replace(svgString, `![図解](${result.url})`);
  } catch (err) {
    log("WARN", `Diagram upload failed: ${err}`);
    return body.replace(svgString, "");
  }
}
