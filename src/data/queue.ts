/**
 * City queue management for automated data-writer runs.
 * State lives in /home/pixwriter/state/data-writer/cities.json
 */
import fs from "node:fs";

const QUEUE_PATH = "/home/pixwriter/state/data-writer/cities.json";

export interface QueueEntry {
  city: string;
  slug: string;
}

interface CityQueue {
  queue: (QueueEntry | string)[];  // supports legacy string format for backward compat
  done: string[];
  ref: string;
}

function load(): CityQueue {
  const raw = fs.readFileSync(QUEUE_PATH, "utf-8");
  return JSON.parse(raw) as CityQueue;
}

function save(q: CityQueue): void {
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(q, null, 2) + "\n");
}

/** Returns the next city entry in the queue, or null if empty. */
export function nextCity(): QueueEntry | null {
  const q = load();
  if (q.queue.length === 0) return null;
  const first = q.queue[0];
  if (typeof first === "string") {
    // Legacy string format — error, slug is required
    throw new Error(`Queue entry "${first}" is a plain string. Slug is required. Update cities.json to use { "city": "...", "slug": "..." } format.`);
  }
  return first;
}

/** Returns the reference city id. */
export function getRef(): string {
  return load().ref;
}

/** Moves a city from queue to done. */
export function markDone(cityId: string): void {
  const q = load();
  q.queue = q.queue.filter((entry) => {
    const id = typeof entry === "string" ? entry : entry.city;
    return id !== cityId;
  });
  if (!q.done.includes(cityId)) {
    q.done.push(cityId);
  }
  save(q);
}
