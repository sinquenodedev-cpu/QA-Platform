// Loads .env and refuses to run against anything but the DEV environment.
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import dotenv from "dotenv";
import { decrypt } from "./secretbox.js";
import { SETTING_KEYS, devGuard } from "./settingsfields.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });

// Values saved on the Settings page (data/settings.json) win over .env.
// The .env values are kept so "Use .env" can go back to them.
export const SETTINGS_FILE = path.join(root, "data", "settings.json");
export const envBase = Object.fromEntries(SETTING_KEYS.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));

export const readOverrides = () => {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch { return { values: {} }; }
};
/** Saved value as plain text (secrets are stored encrypted). */
export const overrideValue = v => (v && typeof v === "object" ? decrypt(v) : v);

/** Puts .env plus the saved settings into process.env. */
export const applyOverrides = () => {
  const { values = {} } = readOverrides();
  for (const k of SETTING_KEYS) {
    let v;
    if (k in values) {
      try { v = overrideValue(values[k]); } catch { v = envBase[k]; console.warn(`[settings] ${k} could not be decrypted; using .env`); }
    } else v = envBase[k];
    if (v === undefined || v === null) delete process.env[k]; else process.env[k] = String(v);
  }
};
applyOverrides();

/** username -> password, from QA_USERS (first-start seed only). */
const loadUsers = raw =>
  new Map(
    String(raw || "")
      .split(",")
      .map(entry => entry.trim())
      .filter(Boolean)
      .map(entry => {
        const i = entry.indexOf(":");
        return i > 0 ? [entry.slice(0, i).trim().toLowerCase(), entry.slice(i + 1)] : null;
      })
      .filter(pair => pair && pair[0] && pair[1])
  );

const fail = message => {
  console.error(`\n[sinque-qa-tool] ${message}\n`);
  process.exit(1);
};

const env = process.env;

// The Sinque database and API are optional: without them the platform runs and only the
// Sinque tools are off until an admin sets them on the Settings page. When set, they must be DEV.
for (const name of ["DATABASE_HOST", "API_BASE_URL"]) {
  if (devGuard(name, env[name])) fail(`${name}=${env[name]} does not look like DEV. This tool only runs against the DEV environment.`);
}

// QA_USERS only seeds the first admin accounts; after that they're managed in the tool.
const users = loadUsers(env.QA_USERS);
for (const [name, password] of users) {
  if (password.length < 10) fail(`The password for "${name}" in QA_USERS is too short (use at least 10 characters).`);
}

/** Everything that comes from settings, read fresh from process.env. */
const fromEnv = () => ({
  db: {
    host: env.DATABASE_HOST,
    port: Number(env.DATABASE_PORT || 3306),
    database: env.DATABASE_NAME,
    user: env.DATABASE_USERNAME,
    password: env.DATABASE_PASSWORD,
  },
  apiBaseUrl: (env.API_BASE_URL || "").replace(/\/+$/, ""),
  testPassword: env.TEST_PASSWORD || "Test@1234",
  // Dev dashboard, for links to the real report page.
  dashboardUrl: (env.DASHBOARD_URL || "https://dev-sinqueadmin.efuturesworld.com").replace(/\/+$/, ""),
  // Optional dashboard admin (role 2) login for the overview check. Without it the
  // tool uses its own test professional, given access to the user's group.
  dashboardAdmin: env.QA_DASHBOARD_EMAIL && env.QA_DASHBOARD_PASSWORD
    ? { email: env.QA_DASHBOARD_EMAIL, password: env.QA_DASHBOARD_PASSWORD }
    : null,
  // Jira Cloud, for tickets from bug reports. Off until JIRA_EMAIL and JIRA_API_TOKEN are set.
  jira: {
    baseUrl: (env.JIRA_BASE_URL || "https://ew2health-team.atlassian.net").replace(/\/+$/, ""),
    project: env.JIRA_PROJECT || "SA",
    issueType: env.JIRA_ISSUE_TYPE || "Bug",
    email: env.JIRA_EMAIL || "",
    token: env.JIRA_API_TOKEN || "",
  },
});

export const config = {
  root,
  users,
  // Optional. Without it sessions are signed with a random key and end when the tool restarts.
  sessionSecret: env.SESSION_SECRET || "",
  port: Number(env.PORT || 4321),
  ...fromEnv(),
};

/** Are the Sinque database settings filled in? */
export const sinqueDbSet = () => !!(config.db.host && config.db.database);
export const SINQUE_DB_MISSING = "The Sinque database isn't set up yet. An admin can add it on the Settings page, under Sinque database.";

/** After the Settings page saves: re-read the saved settings into config (same object, so every module sees it). */
export const reloadConfig = () => {
  applyOverrides();
  const next = fromEnv();
  Object.assign(config.db, next.db);
  Object.assign(config.jira, next.jira);
  const { db, jira, ...rest } = next;
  Object.assign(config, rest);
};

// Every user/professional the tool creates gets this email domain. example.com is
// reserved for testing: it passes email validation and never delivers mail.
export const TEST_EMAIL_DOMAIN = "@sinque-qa.example.com";
export const QA_GROUP_NAME = "QA Scenarios";

export const isTestEmail = email => !!email && email.toLowerCase().endsWith(TEST_EMAIL_DOMAIN);
