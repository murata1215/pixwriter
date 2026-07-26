/**
 * City queue management for automated data-writer runs.
 * State lives in /home/pixwriter/state/data-writer/cities.json
 */
import fs from "node:fs";

const QUEUE_PATH = "/home/pixwriter/state/data-writer/cities.json";

interface CityQueue {
  queue: string[];
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

/** Returns the next city in the queue, or null if empty. */
export function nextCity(): string | null {
  const q = load();
  return q.queue.length > 0 ? q.queue[0] : null;
}

/** Returns the reference city id. */
export function getRef(): string {
  return load().ref;
}

/** Moves a city from queue to done. */
export function markDone(cityId: string): void {
  const q = load();
  q.queue = q.queue.filter((c) => c !== cityId);
  if (!q.done.includes(cityId)) {
    q.done.push(cityId);
  }
  save(q);
}
