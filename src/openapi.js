// OpenAPI / Swagger import: one API check per endpoint, plus coverage (which
// endpoints of the spec have a check). Reads OpenAPI 3.x and Swagger 2.0, JSON or YAML.
// - Paths keep {id}-style parts unless the spec gives an example; the runner asks to fill them in.
// - Auth from the spec becomes {{secret.NAME}} headers; no secret is stored.
// - The success response's schema becomes the check's expected shape (optional).
// - Only GET checks start switched on.
import fs from "fs";
import { parse as parseYaml } from "yaml";
import { badRequest } from "./db.js";
import { dataPath, now, readJson, writeJson } from "./store.js";

const METHODS = ["get", "post", "put", "patch", "delete"];
const MAX = 1500;
const snake = s => String(s).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase() || "API";
const specFile = project => dataPath("projects", project.key, "openapi.json");

export const readSpecText = text => {
  const t = String(text || "").trim();
  if (!t) throw badRequest("The file is empty.");
  let doc;
  try { doc = JSON.parse(t); } catch {
    try { doc = parseYaml(t, { maxAliasCount: 200 }); } catch (e) { throw badRequest(`That isn't valid JSON or YAML: ${e.message.split("\n")[0]}`); }
  }
  if (!doc || typeof doc !== "object") throw badRequest("That isn't an OpenAPI or Swagger file.");
  if (!doc.openapi && doc.swagger !== "2.0") throw badRequest("That isn't an OpenAPI 3 or Swagger 2.0 spec (no “openapi” or “swagger” field at the top).");
  if (!doc.paths || typeof doc.paths !== "object") throw badRequest("The spec has no paths.");
  return doc;
};

/** Downloads a spec from its address (e.g. https://dev-api.example.com/swagger.json). */
export const fetchSpec = async url => {
  if (!/^https?:\/\/[^\s/]+/i.test(String(url || ""))) throw badRequest("Give the spec's full address, starting with https://");
  let res;
  try { res = await fetch(url, { headers: { Accept: "application/json, application/yaml, text/yaml, */*" }, signal: AbortSignal.timeout(20000), redirect: "follow" }); }
  catch (e) { throw badRequest(`Couldn't download the spec: ${e.name === "TimeoutError" ? "no answer within 20 seconds" : e.message}`); }
  if (!res.ok) throw badRequest(`Downloading the spec answered ${res.status}.`);
  const text = await res.text();
  if (text.length > 15 * 1024 * 1024) throw badRequest("The spec is over 15 MB.");
  if (/^\s*<(!doctype|html)/i.test(text)) throw badRequest("That address returned a web page, not a spec file. Use the address of the .json or .yaml file itself (for Swagger UI, often …/swagger/v1/swagger.json or …/v3/api-docs).");
  return text;
};

export const parseOpenApi = (doc, { prefix = "", shapes = true } = {}) => {
  const v2 = doc.swagger === "2.0";
  const title = String(doc.info?.title || "API").trim();
  const notes = [];
  const secrets = new Set();
  let refsMissing = 0;

  // ---------- $ref ----------
  const resolve = (ref) => {
    if (!/^#\//.test(ref)) { refsMissing++; return {}; }
    return ref.slice(2).split("/").map(p => p.replace(/~1/g, "/").replace(/~0/g, "~")).reduce((o, k) => (o == null ? o : o[k]), doc) ?? (refsMissing++, {});
  };
  const deref = (o, seen = new Set()) => {
    if (!o || typeof o !== "object") return o;
    if (o.$ref) {
      if (seen.has(o.$ref)) return { type: "object", _circular: true };
      return deref(resolve(o.$ref), new Set([...seen, o.$ref]));
    }
    return o;
  };

  // ---------- server ----------
  let server = "", serverPath = "";
  if (v2) {
    server = doc.host ? `${(doc.schemes || ["https"])[0]}://${doc.host}${doc.basePath || ""}` : doc.basePath || "";
    serverPath = doc.basePath && doc.basePath !== "/" ? doc.basePath.replace(/\/+$/, "") : "";
  } else {
    let s = doc.servers?.[0]?.url || "";
    for (const [k, v] of Object.entries(doc.servers?.[0]?.variables || {})) s = s.replaceAll(`{${k}}`, v.default ?? "");
    server = s;
    try { serverPath = s ? new URL(s, "http://relative.invalid").pathname.replace(/\/+$/, "") : ""; } catch { serverPath = ""; }
  }
  const pre = String(prefix || "").trim().replace(/\/+$/, "");
  const usePrefix = pre && !pre.startsWith("/") ? `/${pre}` : pre;

  // ---------- samples from schemas ----------
  const sample = (schema, depth = 0) => {
    const s = deref(schema);
    if (!s || depth > 5) return null;
    if (s.example !== undefined) return s.example;
    if (s.default !== undefined) return s.default;
    if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
    if (s.allOf) return Object.assign({}, ...s.allOf.map(x => sample(x, depth + 1)).filter(x => x && typeof x === "object"));
    if (s.oneOf || s.anyOf) return sample((s.oneOf || s.anyOf)[0], depth + 1);
    const type = Array.isArray(s.type) ? s.type.find(t => t !== "null") : s.type || (s.properties ? "object" : s.items ? "array" : "string");
    if (type === "object") {
      const out = {};
      for (const [k, v] of Object.entries(s.properties || {}).slice(0, 40)) {
        const val = deref(v);
        if (val?.readOnly) continue;
        out[k] = sample(val, depth + 1);
      }
      return out;
    }
    if (type === "array") return [sample(s.items, depth + 1)].filter(x => x !== null);
    if (type === "integer" || type === "number") return s.minimum ?? 1;
    if (type === "boolean") return true;
    const f = s.format || "";
    if (f === "email") return "qa+{{now}}@example.com";
    if (f === "date-time") return "{{now}}";
    if (f === "date") return new Date().toISOString().slice(0, 10);
    if (f === "uuid") return "00000000-0000-4000-8000-000000000000";
    if (f === "uri" || f === "url") return "https://example.com";
    if (f === "password") return "{{secret.TEST_PASSWORD}}";
    return "string";
  };

  // ---------- schema → expected shape ----------
  const toShape = (schema, depth = 0) => {
    const s = deref(schema);
    if (!s || depth > 8 || s._circular) return { type: "any" };
    if (s.allOf) {
      const parts = s.allOf.map(x => toShape(x, depth + 1)).filter(p => p.type === "object");
      return parts.length ? { type: "object", fields: Object.assign({}, ...parts.map(p => p.fields)) } : { type: "any" };
    }
    if (s.oneOf || s.anyOf) return { type: "any" };
    const types = Array.isArray(s.type) ? s.type : [s.type];
    const type = types.find(t => t && t !== "null") || (s.properties ? "object" : s.items ? "array" : null);
    if (!type) return { type: "any" };
    if (type === "object") {
      if (!s.properties) return { type: "object" };
      const req = new Set(s.required || []);
      return {
        type: "object",
        fields: Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, { ...toShape(v, depth + 1), ...(req.has(k) ? {} : { optional: true }) }])),
      };
    }
    if (type === "array") return { type: "array", ...(s.items ? { items: toShape(s.items, depth + 1) } : {}) };
    if (type === "integer") return { type: "number" };
    return { type };
  };

  // ---------- auth ----------
  const schemes = v2 ? doc.securityDefinitions || {} : doc.components?.securitySchemes || {};
  const authFor = op => {
    const reqs = op.security ?? doc.security ?? [];
    if (!reqs.length) return {};
    const names = Object.keys(reqs[0] || {});
    const headers = {};
    for (const n of names) {
      const sc = deref(schemes[n]);
      if (!sc) continue;
      const secretName = snake(`${title}_${n}`);
      if ((sc.type === "http" && /bearer/i.test(sc.scheme)) || sc.type === "oauth2" || sc.type === "openIdConnect") {
        secrets.add(secretName); headers.Authorization = `Bearer {{secret.${secretName}}}`;
      } else if ((sc.type === "http" && /basic/i.test(sc.scheme)) || sc.type === "basic") {
        secrets.add(secretName); headers.Authorization = `Basic {{secret.${secretName}}}`;
      } else if (sc.type === "apiKey" && sc.in === "header") {
        secrets.add(secretName); headers[sc.name] = `{{secret.${secretName}}}`;
      } else if (sc.type === "apiKey") {
        notes.push(`The “${n}” key goes in the ${sc.in}: add it to the paths as needed (e.g. ?${sc.name}={{secret.${secretName}}}).`);
      }
    }
    return headers;
  };

  // ---------- endpoints ----------
  const checks = [], endpoints = [];
  let withShape = 0, needIds = 0;
  for (const [tpl, item] of Object.entries(doc.paths)) {
    const pathItem = deref(item) || {};
    for (const method of METHODS) {
      const op = pathItem[method];
      if (!op || checks.length >= MAX) continue;
      const M = method.toUpperCase();
      const params = [...(pathItem.parameters || []), ...(op.parameters || [])].map(x => deref(x)).filter(Boolean);
      const example = p => p.example ?? p.schema?.example ?? p["x-example"] ?? (p.examples && Object.values(p.examples)[0]?.value) ?? p.schema?.default ?? p.default;
      let path = tpl.replace(/\{([^}]+)\}/g, (all, name) => {
        const p = params.find(x => x.in === "path" && x.name === name);
        const ex = p ? example(p) : undefined;
        return ex !== undefined && ex !== null ? encodeURIComponent(String(ex)) : all;
      });
      if (/\{[^}]+\}/.test(path)) needIds++;
      const query = params.filter(p => p.in === "query" && p.required).map(p => `${encodeURIComponent(p.name)}=${encodeURIComponent(String(example(p) ?? sample(p.schema || { type: p.type }) ?? ""))}`);
      if (query.length) path += `?${query.join("&")}`;
      const headers = { ...authFor(op) };
      for (const p of params.filter(x => x.in === "header" && x.required)) headers[p.name] = String(example(p) ?? sample(p.schema || { type: p.type }) ?? "");

      let body = "";
      if (M !== "GET") {
        if (v2) {
          const bp = params.find(p => p.in === "body");
          const form = params.filter(p => p.in === "formData");
          if (bp) { body = JSON.stringify(bp.schema?.example ?? sample(bp.schema), null, 2); headers["Content-Type"] = "application/json"; }
          else if (form.length) { body = form.filter(p => p.type !== "file").map(p => `${encodeURIComponent(p.name)}=${encodeURIComponent(String(example(p) ?? sample({ type: p.type }) ?? ""))}`).join("&"); headers["Content-Type"] = "application/x-www-form-urlencoded"; }
        } else {
          const content = deref(op.requestBody)?.content || {};
          const jsonType = Object.keys(content).find(t => /json/i.test(t));
          const formType = Object.keys(content).find(t => /x-www-form-urlencoded/i.test(t));
          if (jsonType) {
            const c = content[jsonType];
            const ex = c.example ?? (c.examples && deref(Object.values(c.examples)[0])?.value);
            body = JSON.stringify(ex ?? sample(c.schema), null, 2);
            headers["Content-Type"] = jsonType;
          } else if (formType) {
            const obj = sample(content[formType].schema) || {};
            body = Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
            headers["Content-Type"] = formType;
          }
        }
      }

      const responses = op.responses || {};
      const ok = Object.keys(responses).filter(k => /^2\d\d$/.test(k)).sort()[0] || Object.keys(responses).find(k => /^2XX$/i.test(k));
      const assertions = ok && /^\d{3}$/.test(ok) ? [{ type: "status", op: "=", value: ok }] : [{ type: "status", op: "<", value: "300" }];
      let shape = null;
      if (shapes && ok) {
        const r = deref(responses[ok]);
        const schema = v2 ? r?.schema : (() => { const c = r?.content || {}; const t = Object.keys(c).find(x => /json/i.test(x)); return t ? c[t].schema : null; })();
        if (schema) { const sh = toShape(schema); if (sh.type !== "any") { shape = sh; withShape++; } }
      }
      const name = String(op.summary || op.operationId || `${M} ${tpl}`).trim().slice(0, 120);
      const group = String(op.tags?.[0] || title).slice(0, 40);
      const key = `openapi:${snake(title).toLowerCase()}:${M} ${tpl}`.slice(0, 200);
      endpoints.push({ key, method: M, path: tpl, name, group, deprecated: !!op.deprecated });
      checks.push({
        key, name, method: M, path: `${usePrefix}${path}`, headers, body, assertions,
        group, tags: ["openapi", ...(op.deprecated ? ["deprecated"] : [])],
        description: [String(op.description || "").trim(), `From the ${title} spec: ${M} ${tpl}`].filter(Boolean).join("\n\n").slice(0, 600),
        enabled: M === "GET" && !/\{[^}]+\}/.test(path),
        ...(shape ? { shape } : {}),
      });
    }
  }
  if (!checks.length) throw badRequest("The spec has no GET, POST, PUT, PATCH or DELETE operations.");
  if (checks.length >= MAX) notes.push(`Only the first ${MAX} endpoints were read.`);
  const off = checks.filter(c => !c.enabled).length;
  if (off) notes.push(`${off} check${off > 1 ? "s come" : " comes"} in switched off: ones that change data (POST, PUT, PATCH, DELETE), and GETs that still need an id. Turn on the ones that are safe to run.`);
  if (needIds) notes.push(`${needIds} path${needIds > 1 ? "s have" : " has"} parts like {id} with no example in the spec. Edit those checks with a real id, or a saved value like {{orderId}}.`);
  if (secrets.size) notes.push(`Add these to the platform's .env before running: ${[...secrets].map(s => `QA_SECRET_${s}`).join(", ")}.`);
  if (withShape) notes.push(`${withShape} check${withShape > 1 ? "s also check" : " also checks"} that the answer has the fields and types the spec describes.`);
  if (refsMissing) notes.push(`${refsMissing} reference${refsMissing > 1 ? "s point" : " points"} to other files and couldn't be read; those parts are checked loosely.`);
  if (server) notes.push(`The spec's server is ${server}. Checks run against the environment you pick${usePrefix ? `, with ${usePrefix} in front of each path` : ""}.`);

  const byMethod = {};
  for (const c of checks) byMethod[c.method] = (byMethod[c.method] || 0) + 1;
  return {
    title, version: String(doc.info?.version || ""), server, server_path: serverPath,
    checks, endpoints,
    summary: { total: checks.length, by_method: byMethod, folders: [...new Set(checks.map(c => c.group))], switched_off: off, with_shape: withShape },
    secrets: [...secrets].map(s => `QA_SECRET_${s}`),
    notes: [...new Set(notes)],
  };
};

export const saveSpec = (project, parsed, prefix, actor) => writeJson(specFile(project), {
  title: parsed.title, version: parsed.version, server: parsed.server, prefix: prefix || "",
  endpoints: parsed.endpoints, imported_at: now(), imported_by: actor,
});

// ---------- coverage ----------
const segment = s => (/^\{\{?[^}]+\}?\}$|^:\w+$|^\d+$|^[0-9a-f]{8,}$|^[0-9a-f-]{36}$/i.test(s) ? "*" : s.toLowerCase());
const normal = (p, prefix = "") => {
  let x = String(p || "").split("?")[0];
  if (/^https?:\/\//i.test(x)) { try { x = new URL(x.replace(/\{\{[^}]+\}\}/g, "x")).pathname; } catch { /* keep */ } }
  if (prefix && x.toLowerCase().startsWith(prefix.toLowerCase())) x = x.slice(prefix.length);
  return x.split("/").filter(Boolean).map(segment).join("/");
};

/** Which spec endpoints have API checks. */
export const coverage = (project, checks) => {
  const spec = readJson(specFile(project), null);
  if (!spec) return { spec: null };
  const prefix = spec.prefix || "";
  const index = new Map();
  for (const c of checks) {
    const k = `${c.method} ${normal(c.path, prefix)}`;
    if (!index.has(k)) index.set(k, []);
    index.get(k).push(c);
  }
  const used = new Set();
  const endpoints = spec.endpoints.map(e => {
    const k = `${e.method} ${normal(e.path)}`;
    const list = index.get(k) || [];
    list.forEach(c => used.add(c.id));
    const last = list.map(c => c.last).filter(Boolean).sort((a, b) => b.at.localeCompare(a.at))[0];
    return { ...e, checks: list.map(c => ({ id: c.id, name: c.name, enabled: c.enabled, pass: c.last ? c.last.pass : null })), status: !list.length ? "none" : !last ? "not_run" : list.every(c => !c.last || c.last.pass) ? "passing" : "failing" };
  });
  const covered = endpoints.filter(e => e.checks.length).length;
  return {
    spec: { title: spec.title, version: spec.version, imported_at: spec.imported_at, imported_by: spec.imported_by, prefix },
    total: endpoints.length, covered, percent: endpoints.length ? Math.round((covered / endpoints.length) * 100) : 0,
    passing: endpoints.filter(e => e.status === "passing").length, failing: endpoints.filter(e => e.status === "failing").length,
    not_in_spec: checks.filter(c => !used.has(c.id)).length,
    endpoints,
  };
};

export const hasSpec = project => fs.existsSync(specFile(project));
