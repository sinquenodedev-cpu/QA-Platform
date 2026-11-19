// Values passed between API checks, and response shapes.
//
// Saved values: a check can save part of its answer (a token, a new record's id)
// under a name; later checks use it as {{name}}. Values are kept per project and
// environment, encrypted on disk, and shown masked when they look like secrets.
//
// Shapes: the field names and types of a JSON answer. A check with a saved shape
// fails when a field goes missing or changes type; new fields are only reported.
import { decrypt, encrypt } from "./secretbox.js";
import { dataPath, now, readJson, updateJson } from "./store.js";

const file = project => dataPath("projects", project.key, "apivalues.json");
export const RESERVED = /^(now|env|secret|login|sinque|random)$/i;
export const SECRETISH = /token|secret|passw|pwd|api[-_ ]?key|apikey|auth|cookie|session|bearer|credential|private/i;
export const VALUE_NAME = /^[A-Za-z_][\w]{0,39}$/;

/** {{name}} placeholders a text uses that could be saved values (not secret./login./env. ones). */
export const placeholdersIn = text => [...new Set([...String(text ?? "").matchAll(/\{\{\s*([A-Za-z_][\w]*)\s*\}\}/g)].map(m => m[1]).filter(n => !RESERVED.test(n)))];

export const readValues = (project, envId) => {
  const all = readJson(file(project), {})[envId] || {};
  const out = {};
  for (const [name, v] of Object.entries(all)) {
    try { out[name] = decrypt(v.value); } catch { /* key changed: treat as unset */ }
  }
  return out;
};

export const saveValues = (project, envId, values, from) => updateJson(file(project), {}, all => {
  all[envId] ||= {};
  for (const [name, value] of Object.entries(values)) {
    all[envId][name] = { value: encrypt(String(value)), from: from.name, check_id: from.id, at: now() };
  }
});

/** For the page: names, where they came from, and a preview that never shows a secret. */
export const listValues = (project, envId) => {
  const all = readJson(file(project), {})[envId] || {};
  return Object.entries(all).map(([name, v]) => {
    let value = "";
    try { value = decrypt(v.value); } catch { value = ""; }
    return { name, from: v.from, check_id: v.check_id, at: v.at, preview: maskValue(name, value) };
  }).sort((a, b) => a.name.localeCompare(b.name));
};

export const clearValues = (project, envId, name) => updateJson(file(project), {}, all => {
  if (!all[envId]) return { cleared: 0 };
  if (name) { const had = name in all[envId]; delete all[envId][name]; return { cleared: had ? 1 : 0 }; }
  const n = Object.keys(all[envId]).length;
  delete all[envId];
  return { cleared: n };
});

export const maskValue = (name, value) => {
  const v = String(value ?? "");
  if (SECRETISH.test(name) || v.length > 60 || /^eyJ/.test(v)) return v ? `${v.length >= 20 ? v.slice(0, 4) : ""}••• (${v.length} characters)` : "";
  return v;
};

// ---------- shapes ----------
const typeOf = v => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/** The shape of a JSON value: { type, fields? , items? }. Arrays merge their first items. */
export const shapeOf = (value, depth = 0) => {
  const t = typeOf(value);
  if (depth > 8) return { type: t };
  if (t === "object") {
    return { type: "object", fields: Object.fromEntries(Object.entries(value).slice(0, 200).map(([k, v]) => [k, shapeOf(v, depth + 1)])) };
  }
  if (t === "array") {
    const items = value.slice(0, 5).filter(x => x !== null).map(x => shapeOf(x, depth + 1));
    return { type: "array", ...(items.length ? { items: items.reduce(mergeShapes) } : {}) };
  }
  return { type: t };
};

/** Two samples of the same list item: keep fields seen in all of them as required. */
const mergeShapes = (a, b) => {
  if (a.type !== b.type) return a.type === "null" ? b : a;
  if (a.type === "object") {
    const fields = {};
    for (const k of Object.keys(a.fields)) if (k in b.fields) fields[k] = mergeShapes(a.fields[k], b.fields[k]);
    return { type: "object", fields };
  }
  if (a.type === "array") return a.items && b.items ? { type: "array", items: mergeShapes(a.items, b.items) } : a.items ? a : b;
  return a;
};

/** Compares an answer with a saved shape. null in either is allowed (optional values). */
export const compareShape = (expected, value) => {
  const missing = [], changed = [], added = [];
  const walk = (exp, v, at) => {
    if (!exp || exp.type === "any") return;
    const t = typeOf(v);
    if (v === undefined) { missing.push(at || "(answer)"); return; }
    if (t === "null" || exp.type === "null") return;
    const numberish = (exp.type === "integer" || exp.type === "number") && t === "number";
    if (exp.type !== t && !numberish) { changed.push(`${at || "(answer)"}: ${exp.type} → ${t}`); return; }
    if (t === "object" && exp.fields) {
      for (const [k, sub] of Object.entries(exp.fields)) {
        if (!(k in v)) { if (!sub.optional) missing.push(at ? `${at}.${k}` : k); continue; }
        walk(sub, v[k], at ? `${at}.${k}` : k);
      }
      for (const k of Object.keys(v)) if (!(k in exp.fields)) added.push(at ? `${at}.${k}` : k);
    }
    if (t === "array" && exp.items) v.slice(0, 5).forEach(item => walk(exp.items, item, `${at}[]`));
  };
  walk(expected, value, "");
  const uniq = a => [...new Set(a)];
  return { missing: uniq(missing), changed: uniq(changed), added: uniq(added), ok: !missing.length && !changed.length };
};

export const shapeFields = (s, at = "") => {
  if (!s) return 0;
  if (s.type === "object") return Object.entries(s.fields || {}).reduce((n, [, v]) => n + 1 + shapeFields(v), 0);
  if (s.type === "array") return shapeFields(s.items);
  return 0;
};
