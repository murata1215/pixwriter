/**
 * Location map SVG (equirectangular projection) and Haversine distance.
 * Uses Natural Earth 110m Admin 0 Countries (public domain).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  return Math.round(km / 100) * 100; // round to nearest 100km
}

// ---- Equirectangular map SVG ----

interface GeoFeature {
  type: string;
  geometry: {
    type: string;
    coordinates: number[] | number[][] | number[][][] | number[][][][];
  };
}

interface GeoJSON {
  features: GeoFeature[];
}

export function locationMapSvg(
  cityLat: number,
  cityLon: number,
  cityNameJa: string
): string {
  const W = 680;
  const H = 400;
  const lonRange = 60; // ±30 degrees
  const latRange = 36; // ±18 degrees

  const lonMin = cityLon - lonRange / 2;
  const lonMax = cityLon + lonRange / 2;
  const latMin = cityLat - latRange / 2;
  const latMax = cityLat + latRange / 2;

  // Projection: equirectangular
  const projX = (lon: number): number => ((lon - lonMin) / (lonMax - lonMin)) * W;
  const projY = (lat: number): number => ((latMax - lat) / (latMax - latMin)) * H;

  // Load and parse GeoJSON
  let geojson: GeoJSON;
  try {
    geojson = JSON.parse(fs.readFileSync(GEOJSON_PATH, "utf-8")) as GeoJSON;
  } catch {
    // If GeoJSON not available, return a simple placeholder
    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
<rect width="${W}" height="${H}" fill="#F4F1EC"/>
<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="14" fill="#6B7079">地図データなし</text>
</svg>`;
  }

  // Render polygons
  const paths: string[] = [];

  for (const feature of geojson.features) {
    const geom = feature.geometry;
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
        // Check if any point is in view (rough AABB check)
        let inView = false;
        for (const coord of ring) {
          const [lon, lat] = coord;
          if (lon >= lonMin - 5 && lon <= lonMax + 5 && lat >= latMin - 5 && lat <= latMax + 5) {
            inView = true;
            break;
          }
        }
        if (!inView) continue;

        const points = ring
          .map(([lon, lat]) => `${projX(lon).toFixed(1)},${projY(lat).toFixed(1)}`)
          .join(" ");
        paths.push(`<polygon points="${points}" fill="#E8E6DF" stroke="#DDDFDB" stroke-width="0.5"/>`);
      }
    }
  }

  // City marker
  const cx = projX(cityLon).toFixed(1);
  const cy = projY(cityLat).toFixed(1);

  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${cityNameJa}の位置">
<rect width="${W}" height="${H}" fill="#F4F1EC"/>
${paths.join("\n")}
<circle cx="${cx}" cy="${cy}" r="5" fill="#CD2A3E"/>
<circle cx="${cx}" cy="${cy}" r="10" fill="none" stroke="#CD2A3E" stroke-width="1.5" opacity="0.4"/>
<text x="${Number(cx) + 14}" y="${Number(cy) + 5}" font-family="Zen Kaku Gothic New, sans-serif" font-size="14" font-weight="500" fill="#16181C">${esc(cityNameJa)}</text>
<text x="${W - 8}" y="${H - 8}" text-anchor="end" font-family="IBM Plex Mono, monospace" font-size="9" fill="#9AA39E">Natural Earth</text>
</svg>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
