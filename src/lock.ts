import fs from "node:fs";
import { LOCK_FILE, LOCK_STALE_MS } from "./config.js";

export function acquireLock(): boolean {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const stat = fs.statSync(LOCK_FILE);
      const age = Date.now() - stat.mtimeMs;
      if (age < LOCK_STALE_MS) {
        return false; // Lock is held and not stale
      }
      // Stale lock — remove and re-acquire
      fs.unlinkSync(LOCK_FILE);
    }
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    return true;
  } catch {
    return false;
  }
}

export function releaseLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {
    // Ignore errors during cleanup
  }
}
