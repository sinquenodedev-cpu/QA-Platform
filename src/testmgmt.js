// Test management for any project: suites of test cases, and test runs (one per
// release or sprint) where each case is marked passed, failed, blocked or skipped,
// with notes and screenshots as evidence.
import fs from "fs";
import path from "path";
import { badRequest } from "./db.js";
import { dataPath, newId, now, readJson, updateJson, writeJson } from "./store.js";

const file = (project, name) => dataPath("projects", project.key, `${name}.json`);
const STATUSES = ["passed", "failed", "blocked", "skipped"];
const PRIORITIES = ["high", "medium", "low"];

// ---------- suites ----------
export const listSuites = project => {
  const suites = readJson(file(project, "suites"), []);
  const cases = readJson(file(project, "cases"), []);
  return suites.map(s => ({ ...s, cases: cases.filter(c => c.suite_id === s.id).length }));
};

export const saveSuite = (project, body, actor) => updateJson(file(project, "suites"), [], suites => {
  const name = String(body.name || "").trim();
  if (!name) throw badRequest("Give the suite a name.");
  const existing = body.id && suites.find(s => s.id === body.id);
  if (existing) {
    Object.assign(existing, { name, description: String(body.description || ""), updated_at: now() });
    return existing;
  }
  const s = { id: newId("s"), name, description: String(body.description || ""), created_by: actor, created_at: now() };
  suites.push(s);
  return s;
});

export const deleteSuite = (project, id) => {
  const cases = readJson(file(project, "cases"), []);
  if (cases.some(c => c.suite_id === id)) throw badRequest("Move or delete the suite's test cases first.");
  updateJson(file(project, "suites"), [], suites => suites.splice(suites.findIndex(s => s.id === id) >>> 0, 1));
  return { removed: id };
};

// ---------- cases ----------
const cleanCase = (c, suiteIds) => {
  const title = String(c.title || "").trim();
  if (!title) throw badRequest("A test case needs a title.");
  if (!suiteIds.includes(c.suite_id)) throw badRequest("Pick a suite for the test case.");
  const steps = (Array.isArray(c.steps) ? c.steps : []).map(s => (typeof s === "string" ? { action: s, expected: "" } : s))
    .map(s => ({ action: String(s.action || "").trim(), expected: String(s.expected || "").trim() })).filter(s => s.action || s.expected);
  return {
    suite_id: c.suite_id,
    title: title.slice(0, 200),
    preconditions: String(c.preconditions || "").trim(),
    steps,
    expected: String(c.expected || "").trim(),
    priority: PRIORITIES.includes(c.priority) ? c.priority : "medium",
    tags: (Array.isArray(c.tags) ? c.tags : String(c.tags || "").split(",")).map(t => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 10),
    jira: (Array.isArray(c.jira) ? c.jira : String(c.jira || "").split(",")).map(k => String(k).trim().toUpperCase()).filter(k => /^[A-Z][A-Z0-9]*-\d+$/.test(k)),
    source: c.source || "manual",
  };
};

export const listCases = (project, { suite } = {}) => {
  const cases = readJson(file(project, "cases"), []);
  return suite ? cases.filter(c => c.suite_id === suite) : cases;
};

export const saveCase = (project, body, actor) => {
  const suiteIds = readJson(file(project, "suites"), []).map(s => s.id);
  return updateJson(file(project, "cases"), [], cases => {
    const data = cleanCase(body, suiteIds);
    const existing = body.id && cases.find(c => c.id === body.id);
    if (existing) {
      Object.assign(existing, data, { updated_by: actor, updated_at: now() });
      return existing;
    }
    const next = cases.reduce((n, c) => Math.max(n, Number(String(c.id).match(/(\d+)$/)?.[1]) || 0), 0) + 1;
    const c = { id: `${project.key}-TC${String(next).padStart(3, "0")}`, ...data, created_by: actor, created_at: now() };
    cases.push(c);
    return c;
  });
};

/** Adds several cases at once (e.g. the AI's test cases from a Jira ticket). */
export const importCases = (project, { suite_id, cases: list }, actor) => {
  if (!Array.isArray(list) || !list.length) throw badRequest("Nothing to add.");
  return { added: list.slice(0, 50).map(c => saveCase(project, { ...c, suite_id }, actor)) };
};

export const deleteCase = (project, id) => {
  updateJson(file(project, "cases"), [], cases => { const i = cases.findIndex(c => c.id === id); if (i >= 0) cases.splice(i, 1); });
  return { removed: id };
};

// ---------- runs ----------
const runSummary = r => {
  const counts = { passed: 0, failed: 0, blocked: 0, skipped: 0, untested: 0 };
  for (const id of r.case_ids) counts[r.results[id]?.status || "untested"]++;
  return { ...r, results: undefined, counts, total: r.case_ids.length };
};

export const listRuns = project => readJson(file(project, "runs"), []).slice().reverse().map(runSummary);

export const getRun = (project, id) => {
  const r = readJson(file(project, "runs"), []).find(x => x.id === id);
  if (!r) throw Object.assign(new Error("Test run not found."), { status: 404 });
  const cases = readJson(file(project, "cases"), []);
  const suites = readJson(file(project, "suites"), []);
  return {
    ...runSummary(r), results: r.results,
    // A run keeps a copy of each case as it was when the run started.
    cases: r.case_ids.map(id => r.snapshot?.[id] || cases.find(c => c.id === id)).filter(Boolean),
    suites,
  };
};

export const createRun = (project, body, actor) => {
  const name = String(body.name || "").trim();
  if (!name) throw badRequest("Give the run a name, e.g. “Release 2.4 regression”.");
  const all = readJson(file(project, "cases"), []);
  const ids = Array.isArray(body.case_ids) && body.case_ids.length
    ? body.case_ids.filter(id => all.some(c => c.id === id))
    : all.filter(c => (body.suite_ids || []).includes(c.suite_id)).map(c => c.id);
  if (!ids.length) throw badRequest("Pick at least one suite or test case for the run.");
  const env = project.environments.find(e => e.id === body.environment);
  const r = {
    id: newId("r"), name, release: String(body.release || "").trim(), environment: env?.name || "",
    case_ids: ids, snapshot: Object.fromEntries(ids.map(id => [id, all.find(c => c.id === id)])),
    results: {}, status: "open", created_by: actor, created_at: now(),
  };
  updateJson(file(project, "runs"), [], runs => runs.push(r));
  return runSummary(r);
};

export const setResult = (project, runId, caseId, body, actor) => updateJson(file(project, "runs"), [], runs => {
  const r = runs.find(x => x.id === runId);
  if (!r) throw Object.assign(new Error("Test run not found."), { status: 404 });
  if (r.status === "closed") throw badRequest("This run is closed. Reopen it to change results.");
  if (!r.case_ids.includes(caseId)) throw badRequest("That test case isn't in this run.");
  if (body.status === null) { delete r.results[caseId]; return { cleared: caseId }; }
  if (!STATUSES.includes(body.status)) throw badRequest("Status must be passed, failed, blocked or skipped.");
  const prev = r.results[caseId] || {};
  r.results[caseId] = {
    status: body.status, note: String(body.note ?? prev.note ?? "").slice(0, 2000),
    evidence: prev.evidence || [], jira: body.jira ? [...new Set([...(prev.jira || []), body.jira])] : prev.jira || [],
    by: actor, at: now(),
  };
  return r.results[caseId];
});

export const setRunStatus = (project, runId, status, actor) => updateJson(file(project, "runs"), [], runs => {
  const r = runs.find(x => x.id === runId);
  if (!r) throw Object.assign(new Error("Test run not found."), { status: 404 });
  r.status = status === "closed" ? "closed" : "open";
  r[r.status === "closed" ? "closed_at" : "reopened_at"] = now();
  r[r.status === "closed" ? "closed_by" : "reopened_by"] = actor;
  return runSummary(r);
});

export const deleteRun = (project, runId) => {
  updateJson(file(project, "runs"), [], runs => { const i = runs.findIndex(r => r.id === runId); if (i >= 0) runs.splice(i, 1); });
  fs.rmSync(dataPath("projects", project.key, "evidence", runId), { recursive: true, force: true });
  return { removed: runId };
};

// ---------- evidence (screenshots and files) ----------
const ALLOWED = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "application/pdf": "pdf", "text/plain": "txt" };
export const addEvidence = (project, runId, caseId, { name, data }, actor) => {
  const m = String(data || "").match(/^data:([\w/+.-]+);base64,(.+)$/);
  if (!m || !ALLOWED[m[1]]) throw badRequest("Attach a PNG, JPG, GIF, WEBP, PDF or text file.");
  const bytes = Buffer.from(m[2], "base64");
  if (bytes.length > 5 * 1024 * 1024) throw badRequest("Files can be up to 5 MB.");
  const fileName = `${caseId}-${Date.now().toString(36)}.${ALLOWED[m[1]]}`;
  const dir = dataPath("projects", project.key, "evidence", runId);
  return updateJson(file(project, "runs"), [], runs => {
    const r = runs.find(x => x.id === runId);
    if (!r?.results[caseId]) throw badRequest("Set a result for the test case before adding evidence.");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fileName), bytes);
    const item = { file: fileName, name: String(name || fileName).slice(0, 120), type: m[1], size: bytes.length, by: actor, at: now() };
    r.results[caseId].evidence.push(item);
    return item;
  });
};

export const evidenceFile = (project, runId, fileName) => {
  if (!/^[\w.-]+$/.test(fileName) || !/^[\w]+$/.test(runId)) throw badRequest("Bad file name.");
  const p = dataPath("projects", project.key, "evidence", runId, fileName);
  if (!fs.existsSync(p)) throw Object.assign(new Error("File not found."), { status: 404 });
  const ext = path.extname(fileName).slice(1);
  return { path: p, type: Object.entries(ALLOWED).find(([, e]) => e === ext)?.[0] || "application/octet-stream" };
};

export const writeCases = (project, cases) => writeJson(file(project, "cases"), cases);
