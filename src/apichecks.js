// API checks: saved requests with expected results, run against a project's
// environment. Secrets are never stored in a check: {{secret.NAME}} is replaced
// with QA_SECRET_NAME from .env when the check runs.
import { badRequest } from "./db.js";
import { environment } from "./projects.js";
import { resetTokens, sinqueVars } from "./sinqueapi.js";
import { dataPath, newId, now, readJson, updateJson } from "./store.js";
import { RESERVED, VALUE_NAME, compareShape, maskValue, placeholdersIn, readValues, saveValues, shapeFields, shapeOf } from "./apivalues.js";

const file = (project, name) => dataPath("projects", project.key, `${name}.json`);
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const OPS = ["=", "!=", ">", ">=", "<", "<=", "contains", "exists", "missing"];

const KEEP_RUNS = 3000;

const fill = (text, env, vars = {}) => String(text ?? "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (all, name) => {
  if (name in vars) return vars[name] ?? "";
  if (name === "env.name") return env.name;
  if (name === "env.base_url") return env.base_url;
  if (name.startsWith("secret.")) {
    const v = process.env[`QA_SECRET_${name.slice(7).toUpperCase()}`];
    if (v == null) throw badRequest(`{{${name}}} isn't set. Add QA_SECRET_${name.slice(7).toUpperCase()} to the tool's .env.`);
    return v;
  }
  if (name === "now") return new Date().toISOString();
  return all;
});

const clean = c => {
  const name = String(c.name || "").trim();
  if (!name) throw badRequest("Give the check a name.");
  const method = METHODS.includes(String(c.method).toUpperCase()) ? String(c.method).toUpperCase() : "GET";
  const p = String(c.path || "/").trim();
  return {
    name: name.slice(0, 120),
    method,
    path: p.startsWith("/") || /^https?:/i.test(p) ? p : `/${p}`,
    headers: Object.fromEntries((Array.isArray(c.headers) ? c.headers : Object.entries(c.headers || {}).map(([k, v]) => ({ k, v })))
      .map(h => [String(h.k ?? h[0] ?? "").trim(), String(h.v ?? h[1] ?? "")]).filter(([k]) => k)),
    body: method === "GET" ? "" : String(c.body || ""),
    assertions: (Array.isArray(c.assertions) ? c.assertions : []).slice(0, 20).map(a => ({
      type: ["status", "time", "json", "text"].includes(a.type) ? a.type : "status",
      path: String(a.path || ""), op: OPS.includes(a.op) ? a.op : "=", value: a.value == null ? "" : String(a.value),
    })),
    tags: (Array.isArray(c.tags) ? c.tags : String(c.tags || "").split(",")).map(t => String(t).trim()).filter(Boolean),
    // Switched-off checks never run in "Run all" (e.g. ones that change data).
    enabled: c.enabled !== false,
    description: String(c.description || "").slice(0, 600),
    group: String(c.group || "").slice(0, 40),
    // Save parts of the answer for later checks: {{name}}.
    saves: (Array.isArray(c.saves) ? c.saves : []).slice(0, 10).map(s => ({
      name: String(s.name || "").trim(), from: ["json", "header", "status"].includes(s.from) ? s.from : "json", path: String(s.path || "").trim(),
    })).filter(s => VALUE_NAME.test(s.name) && !RESERVED.test(s.name) && (s.from === "status" || s.path)),
    ...(c.shape && typeof c.shape === "object" && JSON.stringify(c.shape).length < 200000 ? { shape: c.shape } : {}),
    ...(c.key ? { key: String(c.key).slice(0, 200) } : {}),
  };
};

/** Adds checks in one go, skipping any whose key is already there. */
export const importChecks = (project, list, actor) => updateJson(file(project, "apichecks"), [], checks => {
  const keys = new Set(checks.map(c => c.key).filter(Boolean));
  let added = 0;
  for (const raw of list) {
    if (raw.key && keys.has(raw.key)) continue;
    checks.push({ id: newId("a"), ...clean(raw), created_by: actor, created_at: now() });
    added++;
  }
  return { added, total: checks.length };
});

export const listChecks = project => {
  const checks = readJson(file(project, "apichecks"), []);
  const last = new Map();
  for (const r of readJson(file(project, "apiruns"), [])) last.set(r.check_id, r);
  return checks.map(c => ({ ...c, enabled: c.enabled !== false, last: last.get(c.id) || null }));
};

export const saveRuns = (project, runs) => {
  if (!runs.length) return;
  updateJson(file(project, "apiruns"), [], all => { all.push(...runs); all.splice(0, Math.max(0, all.length - KEEP_RUNS)); });
};

// Tokens and passwords never end up in the stored response.
const redact = text => String(text).replace(/("(?:accessToken|refreshToken|idToken|token|password|secret)"\s*:\s*")[^"]*"/gi, '$1•••"');

export const saveCheck = (project, body, actor) => updateJson(file(project, "apichecks"), [], checks => {
  const bad = (body.saves || []).find(s => s.name && (!VALUE_NAME.test(String(s.name).trim()) || RESERVED.test(String(s.name).trim())));
  if (bad) throw badRequest(`“${bad.name}” can't be a value name: use letters, digits and _ (not now, env, secret, login or sinque).`);
  const data = clean(body);
  const existing = body.id && checks.find(c => c.id === body.id);
  if (existing) {
    Object.assign(existing, data, { updated_by: actor, updated_at: now() });
    if (body.shape === null) { delete existing.shape; delete existing.shape_at; delete existing.shape_by; }
    return existing;
  }
  const c = { id: newId("a"), ...data, created_by: actor, created_at: now() };
  checks.push(c);
  return c;
});

/** Removes the checks a test function picks (used to refresh generated checks). */
export const removeChecks = (project, pickFn) => updateJson(file(project, "apichecks"), [], checks => {
  const before = checks.length;
  for (let i = checks.length - 1; i >= 0; i--) if (pickFn(checks[i])) checks.splice(i, 1);
  return { removed: before - checks.length };
});

export const deleteCheck = (project, id) => {
  updateJson(file(project, "apichecks"), [], checks => { const i = checks.findIndex(c => c.id === id); if (i >= 0) checks.splice(i, 1); });
  return { removed: id };
};

// "data.items[0].name", "[0].email" and "0.email" all work.
const pick = (obj, p) => String(p || "").replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean).reduce((v, k) => {
  if (v == null) return undefined;
  if (k === "length") return Array.isArray(v) || typeof v === "string" ? v.length : v[k];
  return v[k];
}, obj);

const compare = (actual, op, expected) => {
  if (op === "exists") return actual !== undefined && actual !== null;
  if (op === "missing") return actual === undefined || actual === null;
  // A value that isn't there fails every other comparison (except "not equal").
  if (actual === undefined || actual === null) return op === "!=";
  if (op === "contains") return String(typeof actual === "object" ? JSON.stringify(actual) : actual).includes(expected);
  const a = Number(actual), e = Number(expected);
  const numeric = Number.isFinite(a) && Number.isFinite(e) && expected !== "";
  const A = numeric ? a : String(typeof actual === "object" ? JSON.stringify(actual) : actual), E = numeric ? e : expected;
  return { "=": A === E, "!=": A !== E, ">": A > E, ">=": A >= E, "<": A < E, "<=": A <= E }[op];
};

/** Puts checks that save a value before the checks that use it (otherwise keeps the order). */
export const orderForChain = checks => {
  const savers = new Map();
  for (const c of checks) for (const s of c.saves || []) if (!savers.has(s.name)) savers.set(s.name, c.id);
  const byId = new Map(checks.map(c => [c.id, c]));
  const done = new Set(), out = [];
  const visit = (c, trail = new Set()) => {
    if (done.has(c.id) || trail.has(c.id)) return;
    trail.add(c.id);
    const uses = placeholdersIn([c.path, c.body, ...Object.values(c.headers || {})].join(" "));
    for (const n of uses) { const from = byId.get(savers.get(n)); if (from && from.id !== c.id) visit(from, trail); }
    done.add(c.id); out.push(c);
  };
  checks.forEach(c => visit(c));
  return out;
};

const describeSave = s => (s.from === "status" ? "status" : s.from === "header" ? `header ${s.path}` : s.path);

/** Runs one check against an environment and records the result (save: false lets a batch save once).
 * Values it uses ({{name}}) that another check saves are fetched first by running that check. */
export const runCheck = async (project, check, envId, actor, { save = true, retried = false, refresh = false, depth = 0, keepJson = false } = {}) => {
  const env = environment(project, envId);
  if (env.production && check.method !== "GET") {
    throw badRequest(`${env.name} is a production environment: only GET checks can run there.`);
  }
  const all = [check.path, check.body, ...Object.values(check.headers || {})].join(" ");
  const needs = placeholdersIn(all);
  let saved = readValues(project, env.id);
  const chain = [], usesSaved = [];
  if (needs.length) {
    const checks = readJson(file(project, "apichecks"), []);
    const ran = new Set();
    for (const name of needs) {
      const from = checks.find(c => c.id !== check.id && (c.saves || []).some(s => s.name === name));
      if (from) usesSaved.push(name);
      if (!from || ran.has(from.id) || (name in saved && !refresh)) continue;
      if (from.enabled === false && !(name in saved)) {
        throw badRequest(`{{${name}}} comes from “${from.name}”, which is switched off. Turn it on, or run it once with its Run button.`);
      }
      if (depth >= 5) throw badRequest(`Too many checks in a row are needed to get {{${name}}}. Check that two checks don't need each other's values.`);
      ran.add(from.id);
      const r = await runCheck(project, from, envId, actor, { save, depth: depth + 1 });
      chain.push({ id: from.id, name: from.name, pass: r.pass, status: r.status, ms: r.ms });
      if (!(r.saved || []).some(v => v.name === name)) {
        throw badRequest(`“${from.name}” ran first to get {{${name}}}, but ${r.error ? `it failed: ${r.error}` : `its answer (status ${r.status}) didn't have it`}.`);
      }
      saved = readValues(project, env.id);
    }
  }
  const vars = { ...saved, ...(project.pack === "sinque" ? await sinqueVars(all) : {}) };
  const url = /^https?:/i.test(check.path) ? fill(check.path, env, vars) : `${env.base_url}${fill(check.path, env, vars)}`;
  const headers = Object.fromEntries(Object.entries(check.headers || {}).map(([k, v]) => [k, fill(v, env, vars)]));
  const body = check.method === "GET" ? undefined : fill(check.body, env, vars) || undefined;
  const left = placeholdersIn([url, body, ...Object.values(headers)].join(" "));
  if (left.length) {
    throw badRequest(`{{${left[0]}}} has no value yet. Add “Save from the answer” to the check that gets it (e.g. the login), or run that check first.`);
  }
  if (/\{[\w]+\}/.test(url)) throw badRequest(`Fill in the ${url.match(/\{[\w]+\}/)[0]} part of the address first.`);
  if (body && !Object.keys(headers).some(k => k.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
  const started = Date.now();
  let status = 0, text = "", json = null, error = null, resHeaders = {};
  try {
    const res = await fetch(url, { method: check.method, headers, body, signal: AbortSignal.timeout(20000) });
    status = res.status;
    resHeaders = Object.fromEntries(res.headers);
    text = await res.text();
    try { json = JSON.parse(text); } catch { /* not JSON */ }
  } catch (e) {
    error = e.name === "TimeoutError" ? "No answer within 20 seconds" : e.message;
  }
  const ms = Date.now() - started;
  // An expired login gets one fresh try: the platform's own, or a token another check saved.
  if (status === 401 && !retried && /\{\{\s*login\./.test(all)) { resetTokens(); return runCheck(project, check, envId, actor, { save, retried: true, depth, keepJson }); }
  if (status === 401 && !retried && usesSaved.length) return runCheck(project, check, envId, actor, { save, retried: true, refresh: true, depth, keepJson });
  const results = error ? [] : (check.assertions.length ? check.assertions : [{ type: "status", op: "<", value: "400" }]).map(a => {
    const actual = a.type === "status" ? status : a.type === "time" ? ms : a.type === "text" ? text : pick(json, a.path);
    const ok = a.type === "json" && json == null ? false : compare(actual, a.op, a.value);
    const shown = typeof actual === "object" && actual !== null ? JSON.stringify(actual).slice(0, 120) : actual === undefined ? "missing" : String(actual).slice(0, 120);
    return { ...a, actual: a.type === "text" ? `${text.length} characters` : shown, ok: !!ok };
  });
  if (!error && check.shape) {
    if (json == null) results.push({ type: "shape", path: "", op: "matches", value: "saved shape", actual: "the answer isn't JSON", ok: false });
    else {
      const d = compareShape(check.shape, json);
      const bits = [
        d.missing.length && `missing: ${d.missing.slice(0, 6).join(", ")}${d.missing.length > 6 ? ` +${d.missing.length - 6}` : ""}`,
        d.changed.length && `changed: ${d.changed.slice(0, 6).join(", ")}${d.changed.length > 6 ? ` +${d.changed.length - 6}` : ""}`,
        d.added.length && `new: ${d.added.slice(0, 6).join(", ")}${d.added.length > 6 ? ` +${d.added.length - 6}` : ""}`,
      ].filter(Boolean);
      results.push({ type: "shape", path: "", op: "matches", value: "saved shape", actual: bits.join(" · ") || "same fields and types", ok: d.ok, shape: d });
    }
  }
  const savedNow = [];
  if (!error) {
    const found = {};
    for (const s of check.saves || []) {
      const v = s.from === "status" ? status : s.from === "header" ? resHeaders[s.path.toLowerCase()] : pick(json, s.path);
      const ok = v !== undefined && v !== null && v !== "";
      if (ok) { found[s.name] = typeof v === "object" ? JSON.stringify(v) : String(v); savedNow.push({ name: s.name, preview: maskValue(s.name, found[s.name]) }); }
      results.push({ type: "save", path: describeSave(s), op: "save as", value: s.name, actual: ok ? maskValue(s.name, found[s.name]) : "missing", ok });
    }
    if (Object.keys(found).length) saveValues(project, env.id, found, check);
  }
  const run = {
    id: newId("ar"), check_id: check.id, name: check.name, environment: env.name, method: check.method, url: url.replace(/([?&](?:token|key|apikey|password)=)[^&]+/gi, "$1•••"),
    status, ms, error, pass: !error && results.every(r => r.ok), results, saved: savedNow, ran_first: chain,
    response: redact(text.slice(0, 2500)), at: now(), by: actor,
  };
  if (save) saveRuns(project, [run]);
  if (keepJson) Object.defineProperty(run, "json", { value: json, enumerable: false });
  return run;
};

/** Runs a check and keeps the shape of its JSON answer as the expected shape. */
export const recordShape = async (project, id, envId, actor) => {
  const check = readJson(file(project, "apichecks"), []).find(c => c.id === id);
  if (!check) throw Object.assign(new Error("API check not found."), { status: 404 });
  const { shape: _old, ...withoutShape } = check; // run without the old shape: the new answer is what's kept
  const run = await runCheck(project, withoutShape, envId, actor, { keepJson: true });
  if (run.error) throw badRequest(`The check didn't get an answer: ${run.error}`);
  if (run.status >= 400) throw badRequest(`The answer was status ${run.status}. Keep the shape of a successful answer.`);
  if (run.json == null) throw badRequest("The answer isn't JSON, so there's no shape to keep.");
  const shape = shapeOf(run.json);
  updateJson(file(project, "apichecks"), [], checks => {
    const c = checks.find(x => x.id === id);
    if (c) Object.assign(c, { shape, shape_at: now(), shape_by: actor });
  });
  return { shape, fields: shapeFields(shape), run };
};

export const checkHistory = (project, checkId) => readJson(file(project, "apiruns"), []).filter(r => r.check_id === checkId).slice(-20).reverse();
