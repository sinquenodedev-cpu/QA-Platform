// The Settings page: admins change the platform's .env settings in the browser.
// Saved values go to data/settings.json (secrets encrypted) and win over .env;
// they apply straight away, without a restart. Secrets never go back to the page.
import { SETTINGS_FILE, config, envBase, readOverrides, reloadConfig } from "./config.js";
import { SETTING_FIELDS, SETTING_GROUPS, devGuard } from "./settingsfields.js";
import { badRequest, resetPool, testDatabase } from "./db.js";
import { encrypt } from "./secretbox.js";
import { writeJson } from "./store.js";
import { resetTokens } from "./sinqueapi.js";
import { PROVIDERS, aiInfo, testAi } from "./ai/llm.js";

const field = key => SETTING_FIELDS.find(f => f.key === key);
const group = id => SETTING_GROUPS.find(g => g.id === id) || (() => { throw badRequest("Unknown settings section."); })();

/** What the page shows: every field, where its value comes from, and never a secret's value. */
export const settingsView = () => {
  const { values = {}, changed = {} } = readOverrides();
  const groups = SETTING_GROUPS.map(g => ({
    ...g,
    fields: g.fields.map(f => {
      const here = f.key in values, inEnv = envBase[f.key] !== undefined && envBase[f.key] !== "";
      const current = process.env[f.key];
      return {
        ...f,
        value: f.secret ? "" : current ?? "",
        set: !!current,
        source: here ? "settings" : inEnv ? "env" : "default",
        env_set: inEnv,
        changed_at: changed[f.key]?.at || null,
        changed_by: changed[f.key]?.by || null,
      };
    }),
  }));
  return { groups, ai: aiInfo() };
};

/** Candidate values for a section: what the form sent, else what's in use now. Blank secrets keep the current one. */
const candidate = (g, sent = {}, clear = []) => {
  const out = {};
  for (const f of g.fields) {
    const has = Object.prototype.hasOwnProperty.call(sent, f.key);
    let v = has ? String(sent[f.key] ?? "").trim() : process.env[f.key] ?? "";
    if (f.secret && has && v === "") v = process.env[f.key] ?? "";
    if (clear.includes(f.key)) v = "";
    if (v === "" && f.default && !f.secret) v = f.default;
    out[f.key] = v;
  }
  return out;
};

const validate = (g, v) => {
  for (const f of g.fields) {
    const value = v[f.key];
    const guard = devGuard(f.key, value);
    if (guard) throw badRequest(guard);
    if (f.required && !value) throw badRequest(`${f.label} can't be empty.`);
    if (!value) continue;
    if (f.type === "number" && !/^\d+$/.test(value)) throw badRequest(`${f.label} must be a whole number.`);
    if (f.type === "url" && !/^https?:\/\/[^\s/]+/i.test(value)) throw badRequest(`${f.label} must start with https://`);
    if (f.type === "select" && !f.options.some(o => o.value === value)) throw badRequest(`Pick one of the options for ${f.label}.`);
    if (f.key === "JIRA_PROJECT" && !/^[A-Z][A-Z0-9]{1,9}$/.test(value)) throw badRequest("Jira project keys are capital letters and digits, like SA.");
  }
  if (g.id === "sinque" && v.TEST_PASSWORD && v.TEST_PASSWORD.length < 6) throw badRequest("Use at least 6 characters for the test password.");
};

const dbConfig = v => ({
  host: v.DATABASE_HOST, port: Number(v.DATABASE_PORT || 3306), database: v.DATABASE_NAME, user: v.DATABASE_USERNAME, password: v.DATABASE_PASSWORD,
});

const describeDbError = e =>
  e.code === "ER_ACCESS_DENIED_ERROR" ? "The database refused that username and password."
  : e.code === "ER_BAD_DB_ERROR" ? "There's no database with that name on this host."
  : e.code === "ER_NO_SUCH_TABLE" ? "Connected, but this database has no Sinque users table."
  : /ENOTFOUND|EAI_AGAIN/.test(e.code || "") ? "That host can't be found. Check the address."
  : /ETIMEDOUT|ECONNREFUSED/.test(e.code || e.message || "") ? "The host didn't answer. Check the address, port and that you're on the VPN or allowed IPs."
  : e.message;

/** "Test" button: checks a section's values without saving them. */
export const testSettings = async (id, sent) => {
  const g = group(id);
  const v = candidate(g, sent);
  validate(g, v);
  if (id === "database") {
    try {
      const { users } = await testDatabase(dbConfig(v));
      return { ok: true, message: `Connected to ${v.DATABASE_NAME}: ${users.toLocaleString()} users.` };
    } catch (e) { return { ok: false, message: describeDbError(e) }; }
  }
  if (id === "ai") {
    const choice = v.AI_PROVIDER || "auto";
    if (choice === "off") return { ok: true, message: "AI is set to off." };
    const provider = choice === "auto" ? Object.keys(PROVIDERS).find(p => v[PROVIDERS[p].keyVar]) || "claude" : choice;
    const P = PROVIDERS[provider];
    const key = v[P.keyVar];
    const model = v[P.modelVar] || P.model;
    try {
      const r = await testAi({ provider, key, model });
      return { ok: r.ok, message: `${P.label} (${model}) answered in ${(r.ms / 1000).toFixed(1)} s.` };
    } catch (e) { return { ok: false, message: e.message }; }
  }
  if (id === "jira") {
    if (!v.JIRA_EMAIL || !v.JIRA_API_TOKEN) return { ok: false, message: "Add the shared account email and API token to test it." };
    try {
      const auth = `Basic ${Buffer.from(`${v.JIRA_EMAIL}:${v.JIRA_API_TOKEN}`).toString("base64")}`;
      const me = await fetch(`${v.JIRA_BASE_URL.replace(/\/+$/, "")}/rest/api/3/myself`, { headers: { Authorization: auth, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
      if (me.status === 401 || me.status === 403) return { ok: false, message: "Jira didn't accept that email and token." };
      if (!me.ok) return { ok: false, message: `Jira answered ${me.status}.` };
      const who = await me.json();
      const proj = await fetch(`${v.JIRA_BASE_URL.replace(/\/+$/, "")}/rest/api/3/project/${encodeURIComponent(v.JIRA_PROJECT || "SA")}`, { headers: { Authorization: auth, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
      return proj.ok
        ? { ok: true, message: `Signed in as ${who.displayName}. Project ${v.JIRA_PROJECT || "SA"} found.` }
        : { ok: false, message: `Signed in as ${who.displayName}, but project ${v.JIRA_PROJECT || "SA"} wasn't found or isn't visible to this account.` };
    } catch (e) { return { ok: false, message: `Couldn't reach Jira: ${e.message}` }; }
  }
  if (id === "sinque") {
    if (!v.API_BASE_URL) return { ok: false, message: "Add the API address to test it." };
    try {
      const res = await fetch(`${v.API_BASE_URL.replace(/\/+$/, "")}/auth/login`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(15000),
      });
      return res.status >= 500
        ? { ok: false, message: `The API answered ${res.status}.` }
        : { ok: true, message: `The API is up (it answered ${res.status} to an empty login, as expected).` };
    } catch (e) { return { ok: false, message: `Couldn't reach the API: ${e.message}` }; }
  }
  return { ok: true, message: "Nothing to test here." };
};

/** Saves a section. `values` holds only the fields the admin changed; blank secrets keep the current one. */
export const saveSettings = async (id, sent = {}, actor, clear = []) => {
  const g = group(id);
  const v = candidate(g, sent, clear);
  validate(g, v);
  // A database that doesn't answer would break every page: refuse it.
  if (id === "database") {
    try { await testDatabase(dbConfig(v)); } catch (e) { throw badRequest(`Not saved. ${describeDbError(e)}`); }
  }
  const data = readOverrides();
  data.values ||= {}; data.changed ||= {};
  const changedKeys = [];
  for (const f of g.fields) {
    if (!Object.prototype.hasOwnProperty.call(sent, f.key) && !clear.includes(f.key)) continue;
    const value = v[f.key];
    if (value === (process.env[f.key] ?? "")) continue;
    data.values[f.key] = f.secret && value ? encrypt(value) : value;
    data.changed[f.key] = { at: new Date().toISOString(), by: actor };
    changedKeys.push(f.key);
  }
  if (changedKeys.length) {
    writeJson(SETTINGS_FILE, data);
    applyChanges(id);
  }
  return { saved: changedKeys, ...settingsView() };
};

/** "Use .env": forget the saved value of one setting. */
export const resetSetting = (key, actor) => {
  const f = field(key);
  if (!f) throw badRequest("Unknown setting.");
  if (devGuard(key, envBase[key])) throw badRequest(devGuard(key, envBase[key]));
  const data = readOverrides();
  if (!data.values || !(key in data.values)) return settingsView();
  delete data.values[key];
  data.changed ||= {};
  data.changed[key] = { at: new Date().toISOString(), by: actor, reset: true };
  writeJson(SETTINGS_FILE, data);
  applyChanges(f.group);
  return settingsView();
};

/** Make a saved section take effect now. */
const applyChanges = id => {
  reloadConfig();
  if (id === "database") resetPool();
  if (id === "sinque" || id === "database") resetTokens();
};

export const settingsSummary = () => ({ db: `${config.db.host} / ${config.db.database}`, api: config.apiBaseUrl, ai: aiInfo() });
