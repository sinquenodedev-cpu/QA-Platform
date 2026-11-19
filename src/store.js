// Small JSON file store for the platform's own data (projects, test cases, runs,
// API checks). Writes go to a temp file first, so a crash never leaves half a file.
import fs from "fs";
import path from "path";
import { config } from "./config.js";

export const dataPath = (...parts) => path.join(config.root, "data", ...parts);

export const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
};

export const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);
  return value;
};

/** Read, change and save one file in one step. */
export const updateJson = (file, fallback, fn) => {
  const value = readJson(file, fallback);
  const result = fn(value);
  writeJson(file, value);
  return result;
};

export const newId = (prefix = "") => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const now = () => new Date().toISOString();
