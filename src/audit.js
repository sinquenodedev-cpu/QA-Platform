// Append-only record of every data change made through the tool: who, when,
// which user, and the values before/after. One JSON object per line.
import fs from "fs";
import path from "path";
import { config } from "./config.js";

const dir = path.join(config.root, "logs");
const file = path.join(dir, "audit.log");

export const audit = (actor, action, details) => {
  const entry = { at: new Date().toISOString(), actor, action, ...details };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  } catch (error) {
    console.error("Could not write the audit log:", error.message);
  }
  console.log(`[audit] ${actor} ${action}${details.user ? ` for ${details.user}` : ""}`);
};

/**
 * Audit entries, newest first, filtered by tester, action, free text (user,
 * email, details) and date range (YYYY-MM-DD, UTC). Also returns the testers and
 * actions seen, for the filter menus.
 */
export const readAudit = ({ actor, action, q, from, to, limit = 300 } = {}) => {
  let lines = [];
  try {
    lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch {
    return { entries: [], actors: [], actions: [], total: 0 };
  }
  const all = [];
  for (const line of lines) {
    try { all.push(JSON.parse(line)); } catch { /* skip a damaged line */ }
  }
  const needle = String(q || "").trim().toLowerCase();
  const fromT = from ? Date.parse(`${from}T00:00:00Z`) : null;
  const toT = to ? Date.parse(`${to}T00:00:00Z`) + 864e5 : null;
  const matches = all.filter(e =>
    (!actor || e.actor === actor) &&
    (!action || e.action === action) &&
    (fromT == null || Date.parse(e.at) >= fromT) &&
    (toT == null || Date.parse(e.at) < toT) &&
    (!needle || JSON.stringify(e).toLowerCase().includes(needle))
  );
  return {
    total: matches.length,
    entries: matches.reverse().slice(0, Math.min(1000, Number(limit) || 300)),
    actors: [...new Set(all.map(e => e.actor).filter(Boolean))].sort(),
    actions: [...new Set(all.map(e => e.action).filter(Boolean))].sort(),
  };
};
