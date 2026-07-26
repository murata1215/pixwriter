/**
 * Location map SVG (equirectangular projection) and Haversine distance.
 * Uses Natural Earth 110m Admin 0 Countries (public domain).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GEOJSON_PATH = path.join(__dirname, "assets", "ne_110m_countries.geojson");

// ---- Haversine distance ----

const R_KM = 6371;

export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const km = R_KM * c;
  return Math.round(km / 100) * 100;
}

// ---- Equirectangular map SVG ----

// Colors
const SEA = "#DDE4EA";           // slightly blue-grey
const LAND = "#E4E2DB";          // warm grey
const LAND_HIGHLIGHT = "#D0CDC4"; // target country — noticeably darker
const BORDER = "#C0C2BD";        // country borders
const ACCENT = "#CD2A3E";        // city marker

interface GeoFeature {
  type: string;
  properties: Record<string, unknown>;
  geometry: {
    type: string;
    coordinates: number[] | number[][] | number[][][] | number[][][][];
  };
}

interface GeoJSON {
  features: GeoFeature[];
}

export interface MapResult {
  svg: string;
  countriesInView: string[];   // ISO_A2 codes of countries rendered
  markerCenterPct: { xPct: number; yPct: number }; // marker position as % of viewBox
}

export function locationMapSvg(
  cityLat: number,
  cityLon: number,
  cityNameJa: string,
  countryIso2: string
): MapResult {
  const W = 680;
  const H = 400;
  const lonHalf = 30;
  const latHalf = 18;

  // Ensure numeric (PostgreSQL numeric comes as string via node-pg)
  const cLat = Number(cityLat);
  const cLon = Number(cityLon);

  // Center the projection window on the city
  const lonMin = cLon - lonHalf;
  const lonMax = cLon + lonHalf;
  const latMin = cLat - latHalf;
  const latMax = cLat + latHalf;

  const projX = (lon: number): number => ((lon - lonMin) / (lonMax - lonMin)) * W;
  const projY = (lat: number): number => ((latMax - lat) / (latMax - latMin)) * H;

  // Load GeoJSON
  let geojson: GeoJSON;
  try {
    geojson = JSON.parse(fs.readFileSync(GEOJSON_PATH, "utf-8")) as GeoJSON;
  } catch {
    return {
      svg: `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
<rect width="${W}" height="${H}" fill="${SEA}"/>
<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="14" fill="#6B7079">地図データなし</text>
</svg>`,
      countriesInView: [],
      markerCenterPct: { xPct: 50, yPct: 50 },
    };
  }

  // Render polygons — target country gets a different fill
  const paths: string[] = [];
  const countriesInView = new Set<string>();

  for (const feature of geojson.features) {
    const geom = feature.geometry;
    const iso2 = String(feature.properties.ISO_A2 ?? "");
    const isTarget = iso2.toUpperCase() === countryIso2.toUpperCase();

    let polygons: number[][][][] = [];
    if (geom.type === "Polygon") {
      polygons = [geom.coordinates as number[][][]];
    } else if (geom.type === "MultiPolygon") {
      polygons = geom.coordinates as number[][][][];
    } else {
      continue;
    }

    for (const polygon of polygons) {
      for (const ring of polygon) {
        let inView = false;
        for (const coord of ring) {
          const [lon, lat] = coord;
          if (lon >= lonMin - 5 && lon <= lonMax + 5 && lat >= latMin - 5 && lat <= latMax + 5) {
            inView = true;
            break;
          }
        }
        if (!inView) continue;

        if (iso2) countriesInView.add(iso2);

        const fill = isTarget ? LAND_HIGHLIGHT : LAND;
        const points = ring
          .map(([lon, lat]) => `${projX(lon).toFixed(1)},${projY(lat).toFixed(1)}`)
          .join(" ");
        paths.push(`<polygon points="${points}" fill="${fill}" stroke="${BORDER}" stroke-width="0.8"/>`);
      }
    }
  }

  // City marker — should be at center of viewBox
  const cx = projX(cLon);
  const cy = projY(cLat);
  const xPct = (cx / W) * 100;
  const yPct = (cy / H) * 100;

  // Auto-verify: marker should be within ±10% of center
  if (Math.abs(xPct - 50) > 10 || Math.abs(yPct - 50) > 10) {
    log("WARN", `[geomap] Marker off-center: x=${xPct.toFixed(1)}% y=${yPct.toFixed(1)}% (expected ~50%)`);
  } else {
    log("INFO", `[geomap] Marker centered: x=${xPct.toFixed(1)}% y=${yPct.toFixed(1)}%`);
  }

  const countriesList = [...countriesInView];
  log("INFO", `[geomap] Countries in view: ${countriesList.join(", ")}`);

  const svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(cityNameJa)}の位置">
<rect width="${W}" height="${H}" fill="${SEA}"/>
${paths.join("\n")}
<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5" fill="${ACCENT}"/>
<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="10" fill="none" stroke="${ACCENT}" stroke-width="1.5" opacity="0.4"/>
<text x="${(cx + 14).toFixed(1)}" y="${(cy + 5).toFixed(1)}" font-family="Zen Kaku Gothic New, sans-serif" font-size="14" font-weight="500" fill="#16181C">${esc(cityNameJa)}</text>
<text x="${W - 8}" y="${H - 8}" text-anchor="end" font-family="IBM Plex Mono, monospace" font-size="9" fill="#9AA39E">Natural Earth</text>
</svg>`;

  return { svg, countriesInView: countriesList, markerCenterPct: { xPct, yPct } };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
