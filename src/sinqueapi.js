// Sinque pack: logins and IDs for API checks. {{login.app}} and {{login.dashboard}}
// become access tokens; {{sinque.*}} become IDs of the platform's own API test
// accounts. Those accounts are test data, created once and kept in data/sinque-api.json.
import { loginToken } from "./api.js";
import { config } from "./config.js";
import { query } from "./db.js";
import { assignProfessional, createProfessional, listProfessions } from "./orgs.js";
import { PRESETS } from "./scenarios.js";
import { dataPath, readJson, writeJson } from "./store.js";
import { createScenarioUser } from "./users.js";

const FILE = dataPath("sinque-api.json");
const TOKEN_MS = 30 * 60 * 1000;
const tokens = new Map(); // kind -> { token, at }
let preparing = null;

/** The API test accounts, created the first time they're needed. */
const accounts = async () => {
  const saved = readJson(FILE, null);
  if (saved) {
    const [u] = await query("SELECT id FROM users WHERE id = ? AND deleted_at IS NULL", [saved.app_user_id]);
    const [p] = await query("SELECT id FROM professionals WHERE id = ? AND (deleted = 0 OR deleted IS NULL)", [saved.professional_id]);
    if (u && p) return saved;
  }
  preparing ||= (async () => {
    const preset = PRESETS.find(p => p.key === "high-adherence");
    const user = await createScenarioUser({ spec: { ...preset.spec, label: "API checks user" }, preset: "api-checks" });
    const [row] = await query(
      `SELECT u.sinque_id, ug.group_id, ug.subgroup_id FROM users u LEFT JOIN usergroups ug ON ug.user_id = u.id WHERE u.id = ? LIMIT 1`, [user.id]);
    const [profession] = await listProfessions();
    const pro = await createProfessional({ name: "QA API Bot", professionId: profession?.id, language: "EN", dashboard: true });
    // Manager of the test user's QA group only, so dashboard endpoints have something to show.
    if (row?.group_id) await assignProfessional({ professionalId: pro.id, via: "group-manager", groupId: row.group_id });
    const data = {
      app_user_id: user.id, app_email: user.email, sinque_id: row?.sinque_id ?? null,
      group_id: row?.group_id ?? null, subgroup_id: row?.subgroup_id ?? null,
      professional_id: pro.id, professional_email: pro.email, created_at: new Date().toISOString(),
    };
    return writeJson(FILE, data);
  })().finally(() => { preparing = null; });
  return preparing;
};

const token = async kind => {
  const hit = tokens.get(kind);
  if (hit && Date.now() - hit.at < TOKEN_MS) return hit.token;
  const a = await accounts();
  const t = kind === "dashboard"
    ? config.dashboardAdmin
      ? await loginToken(config.dashboardAdmin.email, config.dashboardAdmin.password, true)
      : await loginToken(a.professional_email, config.testPassword, true)
    : await loginToken(a.app_email, config.testPassword, false);
  tokens.set(kind, { token: t, at: Date.now() });
  return t;
};

/** Values for the placeholders used in the text of a check. */
export const sinqueVars = async text => {
  const s = String(text);
  if (!/\{\{\s*(login|sinque)\./.test(s)) return {};
  const vars = {};
  const a = await accounts();
  Object.assign(vars, {
    "sinque.user_id": a.app_user_id, "sinque.sinque_id": a.sinque_id, "sinque.group_id": a.group_id,
    "sinque.subgroup_id": a.subgroup_id, "sinque.professional_id": a.professional_id,
    "sinque.app_email": a.app_email, "sinque.test_password": config.testPassword,
  });
  if (/\{\{\s*login\.app\s*\}\}/.test(s)) vars["login.app"] = await token("app");
  if (/\{\{\s*login\.dashboard\s*\}\}/.test(s)) vars["login.dashboard"] = await token("dashboard");
  return vars;
};

/** For the API checks page: who the checks sign in as. */
export const sinqueApiInfo = () => {
  const a = readJson(FILE, null);
  return {
    app: a ? `${a.app_email} (Sinque #${a.sinque_id})` : "created on the first run",
    dashboard: config.dashboardAdmin ? `${config.dashboardAdmin.email} (dashboard admin from .env)` : a ? `${a.professional_email} (test professional)` : "created on the first run",
  };
};

/** Forget cached tokens (e.g. after a 401). */
export const resetTokens = () => tokens.clear();
