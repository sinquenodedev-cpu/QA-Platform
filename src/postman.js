// Postman import: turns a Postman collection (v2.0 / v2.1 export) into API checks.
// - The collection's base URL variable ({{baseUrl}}, {{host}}, ...) is dropped, so
//   each check runs against whichever project environment is picked.
// - Secrets are never stored: tokens, API keys and passwords become
//   {{secret.NAME}}, read from QA_SECRET_NAME in .env when the check runs.
// - Requests that change data (POST, PUT, PATCH, DELETE) come in switched off.
// - Simple Postman tests (status, response time, body text) become assertions.
import { badRequest } from "./db.js";

const MAX_REQUESTS = 1000;
const SECRETISH = /token|secret|passw|pwd|api[-_ ]?key|apikey|auth|cookie|session|bearer|credential|private/i;
const SECRET_HEADERS = /^(authorization|cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token|proxy-authorization)$/i;

const snake = s => String(s).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase() || "VALUE";
const text = d => (typeof d === "string" ? d : d?.content || "");
// Form values are URL-encoded, but {{placeholders}} must stay readable for the runner.
const encodeKeepVars = v => v.split(/(\{\{[^{}]+\}\})/).map(part => (/^\{\{/.test(part) ? part : encodeURIComponent(part))).join("");

/** Reads the collection and returns the checks it would make, plus notes for the tester. */
export const parsePostman = input => {
  let col = input;
  if (typeof col === "string") {
    try { col = JSON.parse(col); } catch { throw badRequest("That file isn't valid JSON. Export the collection from Postman as Collection v2.1."); }
  }
  if (col?.collection?.info) col = col.collection; // Postman API format
  if (col?._postman_variable_scope || (Array.isArray(col?.values) && !col?.item)) {
    throw badRequest("That's a Postman environment file. Pick the collection file (Export collection → v2.1); add environments under Settings → your project.");
  }
  if (!col?.info || !Array.isArray(col.item)) throw badRequest("That doesn't look like a Postman collection. In Postman: ⋯ on the collection → Export → Collection v2.1.");

  const collectionName = String(col.info.name || "Postman").trim();
  const collectionKey = col.info._postman_id || snake(collectionName).toLowerCase();
  const vars = Object.fromEntries((col.variable || []).filter(v => v?.key && !v.disabled).map(v => [v.key, v.value == null ? "" : String(v.value)]));
  const secrets = new Set(), unknownVars = new Set(), baseValues = new Map();
  const notes = [];
  let untranslatedTests = 0, skippedFiles = 0, literalSecrets = 0, fromExamples = 0;

  const secretFor = name => { const n = snake(name); secrets.add(n); return `{{secret.${n}}}`; };

  /** pm.environment.set("token", pm.response.json().data.token) and friends → "save from the answer". */
  const SET_CALL = /(?:pm\.(?:environment|collectionVariables|globals|variables)\.set|postman\.set(?:Environment|Global)Variable)\(\s*["'`]([A-Za-z_]\w*)["'`]\s*,\s*(.+?)\)\s*;?\s*$/;
  let untranslatedSets = 0;
  const scriptLines = item => (item.event || []).filter(e => e.listen === "test").flatMap(e => [].concat(e.script?.exec || []));
  const savesOf = item => {
    const lines = scriptLines(item);
    const aliases = ["pm.response.json()", "JSON.parse(responseBody)"];
    for (const l of lines) {
      const m = l.match(/(?:var|let|const)\s+(\w+)\s*=\s*(?:pm\.response\.json\(\)|JSON\.parse\(\s*responseBody\s*\))/);
      if (m) aliases.push(m[1]);
    }
    const out = [];
    for (const l of lines) {
      const m = l.trim().match(SET_CALL);
      if (!m) continue;
      const [, name, rawExpr] = m;
      const expr = rawExpr.trim().replace(/\.toString\(\)$/, "");
      const header = expr.match(/^pm\.response\.headers\.get\(\s*["'`]([^"'`]+)["'`]\s*\)$/);
      if (header) { out.push({ name, from: "header", path: header[1] }); continue; }
      if (/^pm\.response\.code$/.test(expr)) { out.push({ name, from: "status", path: "" }); continue; }
      const alias = aliases.find(a => expr === a || expr.startsWith(`${a}.`) || expr.startsWith(`${a}[`));
      if (alias) {
        const path = expr.slice(alias.length).replace(/\[\s*["'`]([^"'`]+)["'`]\s*\]/g, ".$1").replace(/^\./, "");
        if (path && /^[\w.[\]]+$/.test(path)) { out.push({ name, from: "json", path }); continue; }
      }
      untranslatedSets++;
    }
    return out;
  };
  // Names some request saves: later requests keep {{name}} so the value is passed along.
  const produced = new Set();
  const collect = items => (items || []).forEach(it => (Array.isArray(it.item) ? collect(it.item) : savesOf(it).forEach(x => produced.add(x.name))));
  collect(col.item);
  untranslatedSets = 0; // counted again while walking

  /** Postman {{variables}} → platform form. */
  const convert = value => String(value ?? "").replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (all, name) => {
    if (name === "$timestamp" || name === "$isoTimestamp") return "{{now}}";
    if (name.startsWith("$")) { unknownVars.add(name); return all; }
    if (name.startsWith("secret.") || name.startsWith("login.") || name.startsWith("env.")) return all;
    if (produced.has(name)) return `{{${name}}}`;
    if (SECRETISH.test(name)) return secretFor(name);
    if (vars[name] !== undefined && vars[name] !== "") return vars[name];
    unknownVars.add(name);
    return all;
  });

  /** A header value typed straight into the collection that is really a secret: don't keep it. */
  const guardSecret = (headerName, value, label) => {
    const v = String(value ?? "");
    if (!v || /\{\{/.test(v)) return convert(v);
    if (SECRET_HEADERS.test(headerName) || SECRETISH.test(headerName)) {
      literalSecrets++;
      const scheme = v.match(/^(Bearer|Basic|Token)\s+/i)?.[1];
      const ref = secretFor(`${collectionName}_${label || headerName}`);
      return scheme ? `${scheme} ${ref}` : ref;
    }
    return v;
  };

  const authHeaders = auth => {
    if (!auth || auth.type === "noauth") return {};
    const get = (k) => {
      const list = Array.isArray(auth[auth.type]) ? auth[auth.type] : [];
      return list.find(x => x.key === k)?.value;
    };
    if (auth.type === "bearer") return { Authorization: guardSecret("Authorization", `Bearer ${get("token") ?? ""}`, "token") };
    if (auth.type === "basic") {
      const u = get("username"), p = get("password");
      if (/\{\{/.test(`${u}${p}`) || !(u || p)) {
        notes.push("Basic auth with variables: set it as an Authorization header with {{secret.NAME}} once imported.");
        return { Authorization: `Basic ${secretFor(`${collectionName}_basic`)}` };
      }
      literalSecrets++;
      return { Authorization: `Basic ${secretFor(`${collectionName}_basic`)}` };
    }
    if (auth.type === "apikey") {
      const where = get("in") || "header";
      if (where !== "header") { notes.push("API keys sent in the query string were left out: add them to the path as ?key={{secret.NAME}}."); return {}; }
      return { [get("key") || "x-api-key"]: guardSecret(get("key") || "x-api-key", get("value"), get("key") || "api_key") };
    }
    notes.push(`"${auth.type}" auth isn't converted: add its header by hand where needed.`);
    return {};
  };

  /** Address → path relative to the environment (or a full URL when the collection names a fixed host). */
  const toPath = url => {
    let raw = typeof url === "string" ? url : url?.raw;
    if (!raw && url && typeof url === "object") {
      const host = Array.isArray(url.host) ? url.host.join(".") : url.host || "";
      const pth = Array.isArray(url.path) ? url.path.join("/") : url.path || "";
      const q = (url.query || []).filter(x => !x.disabled).map(x => `${x.key}=${x.value ?? ""}`).join("&");
      raw = `${url.protocol ? `${url.protocol}://` : ""}${host}/${pth}${q ? `?${q}` : ""}`;
    }
    raw = String(raw || "/").trim();
    const lead = raw.match(/^\{\{\s*([^{}]+?)\s*\}\}/);
    if (lead) {
      if (vars[lead[1]]) baseValues.set(lead[1], vars[lead[1]]);
      else baseValues.set(lead[1], "");
      const rest = raw.slice(lead[0].length);
      return convert(rest.startsWith("/") ? rest : `/${rest}`);
    }
    if (/^https?:\/\//i.test(raw)) return convert(raw);
    if (raw.startsWith("/")) return convert(raw);
    return convert(`https://${raw}`);
  };

  const bodyOf = (req, headers) => {
    const b = req.body;
    if (!b || b.disabled) return "";
    const setType = t => { if (!Object.keys(headers).some(k => k.toLowerCase() === "content-type")) headers["Content-Type"] = t; };
    if (b.mode === "raw") {
      if ((b.options?.raw?.language || "json") === "json") setType("application/json");
      else if (b.options?.raw?.language === "xml") setType("application/xml");
      else setType("text/plain");
      return convert(b.raw || "");
    }
    if (b.mode === "urlencoded" || b.mode === "formdata") {
      const fields = (b[b.mode] || []).filter(x => !x.disabled);
      const files = fields.filter(x => x.type === "file");
      if (files.length) skippedFiles++;
      setType("application/x-www-form-urlencoded");
      return fields.filter(x => x.type !== "file")
        .map(x => `${encodeURIComponent(x.key)}=${SECRETISH.test(x.key) && !/\{\{/.test(x.value || "") && x.value ? secretFor(`${collectionName}_${x.key}`) : encodeKeepVars(convert(x.value ?? ""))}`).join("&");
    }
    if (b.mode === "graphql") {
      setType("application/json");
      let variables = {};
      try { variables = b.graphql?.variables ? JSON.parse(convert(b.graphql.variables)) : {}; } catch { /* keep empty */ }
      return JSON.stringify({ query: b.graphql?.query || "", variables });
    }
    if (b.mode === "file") skippedFiles++;
    return "";
  };

  /** Postman test scripts → assertions, for the common one-liners. */
  const assertionsOf = item => {
    const lines = (item.event || []).filter(e => e.listen === "test").flatMap(e => [].concat(e.script?.exec || []));
    const src = lines.join("\n");
    const out = [];
    for (const m of src.matchAll(/pm\.response\.to\.have\.status\(\s*(\d{3})\s*\)/g)) out.push({ type: "status", op: "=", value: m[1] });
    for (const m of src.matchAll(/pm\.expect\(\s*pm\.response\.code\s*\)\.to\.(?:eql|equal|be\.equal|eq)\(\s*(\d{3})\s*\)/g)) out.push({ type: "status", op: "=", value: m[1] });
    for (const m of src.matchAll(/pm\.expect\(\s*pm\.response\.code\s*\)\.to\.be\.oneOf\(\s*\[\s*(\d{3})/g)) out.push({ type: "status", op: "<", value: "400" });
    if (/pm\.response\.to\.be\.(ok|success)/.test(src)) out.push({ type: "status", op: "<", value: "300" });
    for (const m of src.matchAll(/pm\.expect\(\s*pm\.response\.responseTime\s*\)\.to\.be\.(?:below|lessThan|lt)\(\s*(\d+)\s*\)/g)) out.push({ type: "time", op: "<", value: m[1] });
    for (const m of src.matchAll(/pm\.response\.to\.have\.body\(\s*(["'])(.+?)\1\s*\)/g)) out.push({ type: "text", op: "contains", value: m[2] });
    for (const m of src.matchAll(/pm\.expect\(\s*pm\.response\.text\(\)\s*\)\.to\.include\(\s*(["'])(.+?)\1\s*\)/g)) out.push({ type: "text", op: "contains", value: m[2] });
    for (const m of src.matchAll(/pm\.response\.to\.have\.jsonBody\(\s*(["'])([\w.[\]]+)\1\s*\)/g)) out.push({ type: "json", path: m[2], op: "exists", value: "" });
    const meaningful = lines.filter(l => l.trim() && !/^\s*\/\//.test(l) && !SET_CALL.test(l.trim()) && !/(?:var|let|const)\s+\w+\s*=\s*(?:pm\.response\.json|JSON\.parse)/.test(l) && !/^[\s{}();]*$/.test(l)).length;
    if (meaningful && !out.length) untranslatedTests++;
    if (!out.length) {
      // No tests: use the status of the first saved example response, if any.
      const code = (item.response || []).find(r => r?.code)?.code;
      if (code) { out.push({ type: "status", op: "=", value: String(code) }); fromExamples++; }
    }
    const seen = new Set();
    return out.filter(a => { const k = JSON.stringify(a); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 20);
  };

  const checks = [];
  const walk = (items, folders, inheritedAuth) => {
    for (const it of items || []) {
      if (checks.length >= MAX_REQUESTS) return;
      if (Array.isArray(it.item)) {
        walk(it.item, [...folders, String(it.name || "Folder").trim()], it.auth || inheritedAuth);
        continue;
      }
      const req = typeof it.request === "string" ? { method: "GET", url: it.request } : it.request;
      if (!req) continue;
      const method = String(req.method || "GET").toUpperCase();
      const auth = req.auth || inheritedAuth;
      const headers = { ...authHeaders(auth) };
      for (const h of req.header || []) {
        if (h.disabled || !h.key) continue;
        headers[h.key] = guardSecret(h.key, h.value, h.key);
      }
      const body = method === "GET" ? "" : bodyOf(req, headers);
      const where = folders.join(" / ");
      const saves = savesOf(it);
      const path = toPath(req.url);
      // A login that hands a token to later requests doesn't change data: it can stay on.
      const signIn = saves.length && /log-?in|sign-?in|auth|token|session/i.test(`${path} ${it.name}`);
      checks.push({
        key: `postman:${collectionKey}:${where}/${it.name}:${method}`.slice(0, 200),
        name: String(it.name || `${method} request`).trim(),
        method,
        path,
        headers,
        saves,
        body,
        assertions: assertionsOf(it),
        group: (folders[0] || collectionName).slice(0, 40),
        tags: ["postman", ...folders.slice(1)].slice(0, 6),
        description: [text(req.description) || text(it.description), `Imported from Postman: ${collectionName}${where ? ` / ${where}` : ""}`].filter(Boolean).join("\n\n").slice(0, 600),
        enabled: method === "GET" || !!signIn,
      });
    }
  };
  walk(col.item, [], col.auth);
  if (!checks.length) throw badRequest("The collection has no requests.");

  const changing = checks.filter(c => !c.enabled).length;
  const passing = checks.filter(c => c.saves.length);
  if (passing.length) notes.push(`${passing.length} request${passing.length > 1 ? "s save" : " saves"} values for later ones (${[...produced].slice(0, 8).map(n => `{{${n}}}`).join(", ")}${produced.size > 8 ? " …" : ""}): checks that use them run those first automatically.`);
  if (untranslatedSets) notes.push(`${untranslatedSets} pm.environment.set(...) line${untranslatedSets > 1 ? "s" : ""} computed a value in a way that couldn't be converted. Add “Save from the answer” on those checks by hand.`);
  if (checks.length >= MAX_REQUESTS) notes.push(`Only the first ${MAX_REQUESTS} requests were read.`);
  if (changing) notes.push(`${changing} request${changing > 1 ? "s" : ""} that change${changing > 1 ? "" : "s"} data (POST, PUT, PATCH, DELETE) ${changing > 1 ? "come" : "comes"} in switched off, so "Run all" skips them. Turn on the ones that are safe to run.`);
  if (literalSecrets) notes.push(`The collection has tokens or passwords typed straight in (used in ${literalSecrets} request${literalSecrets > 1 ? "s" : ""}). They weren't saved: the checks use {{secret.NAME}} instead.`);
  if (secrets.size) notes.push(`Add these to the platform's .env before running: ${[...secrets].map(s => `QA_SECRET_${s}`).join(", ")}.`);
  const bases = [...baseValues.entries()];
  if (bases.length) {
    notes.push(`The address part ${bases.map(([k]) => `{{${k}}}`).join(", ")} was dropped: checks run against the environment you pick.${bases.some(([, v]) => v) ? ` The collection pointed at ${bases.filter(([, v]) => v).map(([, v]) => v).join(", ")}. Add it as an environment if it isn't one yet.` : ""}`);
  }
  if (unknownVars.size) notes.push(`These Postman variables have no value and stay as they are: ${[...unknownVars].slice(0, 12).map(v => `{{${v}}}`).join(", ")}${unknownVars.size > 12 ? " …" : ""}. Edit the checks that use them.`);
  if (untranslatedTests) notes.push(`${untranslatedTests} request${untranslatedTests > 1 ? "s have" : " has"} Postman test scripts that couldn't be converted; ${untranslatedTests > 1 ? "they check" : "it checks"} for a status below 400 until you add expectations.`);
  if (fromExamples) notes.push(`${fromExamples} check${fromExamples > 1 ? "s expect" : " expects"} the status of the saved example response.`);
  if (skippedFiles) notes.push(`${skippedFiles} request${skippedFiles > 1 ? "s upload" : " uploads"} files: the file parts were left out.`);

  const byMethod = {};
  for (const c of checks) byMethod[c.method] = (byMethod[c.method] || 0) + 1;
  return {
    collection: collectionName,
    checks,
    summary: { total: checks.length, by_method: byMethod, folders: [...new Set(checks.map(c => c.group))], switched_off: changing },
    secrets: [...secrets].map(s => `QA_SECRET_${s}`),
    notes: [...new Set(notes)],
  };
};
