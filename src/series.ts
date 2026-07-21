import fs from "node:fs";
import { SERIES_FILE } from "./config.js";

export interface SeriesEpisode {
  n: number;
  theme: string;
  periodFrom: string;
  periodTo: string;
  status: "planned" | "written" | "published";
  postId?: number;
}

export interface Series {
  seriesId: string;
  projectId: string;
  projectName: string;
  title: string;
  writer: string;
  episodes: SeriesEpisode[];
  createdAt: string;
}

export function loadSeries(): Series[] {
  try {
    const raw = fs.readFileSync(SERIES_FILE, "utf-8");
    return JSON.parse(raw) as Series[];
  } catch {
    return [];
  }
}

export function saveSeries(series: Series[]): void {
  const tmpPath = SERIES_FILE + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(series, null, 2) + "\n");
  fs.renameSync(tmpPath, SERIES_FILE);
}

export function getNextPlannedEpisode(seriesList: Series[]): { series: Series; episode: SeriesEpisode } | null {
  for (const s of seriesList) {
    for (const ep of s.episodes) {
      if (ep.status === "planned") {
        return { series: s, episode: ep };
      }
    }
  }
  return null;
}

export function getPreviousEpisodePostId(series: Series, currentN: number): number | undefined {
  if (currentN <= 1) return undefined;
  const prev = series.episodes.find((e) => e.n === currentN - 1);
  return prev?.postId;
}
