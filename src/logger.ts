import fs from "node:fs";
import path from "node:path";
import { LOGS_DIR, LOG_RETENTION_DAYS, JST_OFFSET_HOURS } from "./config.js";

function todayStr(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + JST_OFFSET_HOURS * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10).replace(/-/g, "");
}

function logFilePath(): string {
  return path.join(LOGS_DIR, `cycle-${todayStr()}.log`);
}

export function log(level: "INFO" | "WARN" | "ERROR", message: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${message}\n`;
  process.stderr.write(line);
  try {
    fs.appendFileSync(logFilePath(), line);
  } catch {
    // If we can't write to the log file, just output to stderr
  }
}

export function cleanOldLogs(): void {
  try {
    const files = fs.readdirSync(LOGS_DIR);
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const file of files) {
      if (!file.startsWith("cycle-") || !file.endsWith(".log")) continue;
      const filePath = path.join(LOGS_DIR, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
        log("INFO", `Deleted old log: ${file}`);
      }
    }
  } catch {
    // Non-critical
  }
}
