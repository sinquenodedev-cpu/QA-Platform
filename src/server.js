import { config, sinqueDbSet, SINQUE_DB_MISSING, TEST_EMAIL_DOMAIN } from "./config.js";
import fs from "fs";
import http from "http";
import path from "path";
import { fetchReport, tryLogin } from "./api.js";
import { clientIp, createAuth } from "./auth.js";
import { query } from "./db.js";
import {
  assignProfessional, createGroup, createProfessional, createSubgroup, listGroups, listProfessionals,
  listProfessions, resetProfessionalPassword,
} from "./orgs.js";
import { PRESETS } from "./scenarios.js";
import {
  addMeasurements, clearStoredReports, createScenarioUser, deleteMeasurement, getUser, getUserDetail, searchUsers,
  setTestPassword, setUserGroup, updateMeasurement, deleteTestUsers, resetTestUser,
} from "./users.js";
import { audit, readAudit } from "./audit.js";
import { aiEnabled, aiInfo } from "./ai/llm.js";
import { resetSetting, saveSettings, settingsView, testSettings } from "./settings.js";
import { buildCase } from "./ai/casefile.js";
import { overviewCheck, presetCheck, reportHistory, reportLink, runAllPresets } from "./checks.js";
import { bugReportData } from "./bugreport.js";
import { cardPage, loginCard } from "./logincard.js";
import { homeData } from "./home.js";
import { getJob, listJobs, startJob } from "./jobs.js";
import { inventory, planCleanup, runCleanup } from "./cleanup.js";
import { allProjects, deleteProject, getProject, projectsFor, saveProject } from "./projects.js";
import {
  addEvidence, createRun, deleteCase, deleteRun, deleteSuite, evidenceFile, getRun, importCases, listCases, listRuns, listSuites,
  saveCase, saveSuite, setResult, setRunStatus,
} from "./testmgmt.js";
import { checkHistory, deleteCheck, importChecks, listChecks, orderForChain, recordShape, runCheck, saveCheck, saveRuns } from "./apichecks.js";
import { clearValues, listValues } from "./apivalues.js";
import { environment as projectEnvironment } from "./projects.js";
import { parsePostman } from "./postman.js";
import { jiraCoverage } from "./coverage.js";
import { getUiRun, listUiRuns, repairSteps, runUiCase, saveAutomation, uiRunFile, writeSteps, cleanSteps } from "./uiauto.js";
import { coverage as apiCoverage, fetchSpec, parseOpenApi, readSpecText, saveSpec } from "./openapi.js";
import { sinqueApiInfo } from "./sinqueapi.js";
import { connect as connectJira, connectionInfo as jiraConnection, disconnect as disconnectJira, requestContext } from "./jirauser.js";
import { checkAll, projectHealth, startHealth } from "./health.js";
import {
  addComment, createTicket, getTicket, postTestCases, updateTicket, jiraEnabled, jiraInfo, linkUsers, listTickets, readTestCases, saveTestCases, testCasesToWiki, ticketsFor,
} from "./jira.js";
import {
  addTester, changeOwnPassword, initTesters, listTesters, removeTester, resetTesterPassword, roleOf, setTesterRole,
} from "./testers.js";
import { aiSearch, clientReply, explainReport, genericTestCases, scanUsers, scenarioFromText, summarizeScan, testPlan, ticketTestCases } from "./ai/features.js";

const INDEX_HTML = path.join(config.root, "public", "index.html");
const LOGIN_HTML = path.join(config.root, "public", "login.html");
if (!initTesters(config.users)) {
  console.error('\n[sinque-qa-tool] No logins yet. Add QA_USERS to .env for the first admin, e.g. QA_USERS=alice:a-long-password\n');
  process.exit(1);
}
const auth = createAuth({ secret: config.sessionSecret });

const requireAdmin = req => {
  if (roleOf(req.actor) !== "admin") throw Object.assign(new Error("Only admins can do this."), { status: 403 });
};

/**
 * The API and the database must belong to the same environment. Ask the API for
 * a user that exists in our database: "User not found" means they don't match.
 */
let environmentCheck = { checked: false };
const checkEnvironment = async () => {
  if (!sinqueDbSet()) return (environmentCheck = { checked: true, ok: false, not_set: true, message: SINQUE_DB_MISSING });
  if (!config.apiBaseUrl) return (environmentCheck = { checked: true, ok: false, not_set: true, message: "The Sinque API address isn't set up yet. An admin can add it on the Settings page, under Sinque app." });
  try {
    const [user] = await query("SELECT id FROM users WHERE role = 1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1");
    if (!user) return (environmentCheck = { checked: true, ok: true, message: "No users to compare." });
    const res = await fetchReport(user.id);
    environmentCheck = res.status === 404
      ? { checked: true, ok: false, message: `The API at ${config.apiBaseUrl} doesn't know users from database "${config.db.database}". Use the API and database of the same environment.` }
      : { checked: true, ok: true, message: `API and database match (API answered ${res.status}).` };
  } catch (error) {
    environmentCheck = { checked: true, ok: false, message: `Could not reach the API: ${error.message}` };
  }
  console.log(`Environment check: ${environmentCheck.message}`);
  return environmentCheck;
};

const readBody = req =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => (data += c));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error("Invalid JSON body.")); }
    });
    req.on("error", reject);
  });

/** Login check without handing tokens to the browser. */
const loginSummary = ({ status, ok, body }) => ({
  status,
  ok,
  success: ok && !!body?.data?.accessToken || ok && !!body?.accessToken,
  message: body?.message || body?.error || body?.data?.message || (ok ? "Logged in" : "Login failed"),
  user: body?.data?.user ?? body?.user ?? null,
});

/** The project the tester has open (sent by the page as X-Project). */
const proj = req => getProject(req.headers["x-project"], req.actor, roleOf(req.actor));
const ID = "([\\w-]+)";

/** Creates a ticket's scenario test user, checks its report and links it to the ticket. */
const runTicketCase = async (key, caseId, actor) => {
  const data = readTestCases(key);
  const tc = data?.test_cases.find(t => t.id === caseId);
  if (!tc?.spec) throw Object.assign(new Error("That test case has no scenario to create."), { status: 400 });
  const created = await createScenarioUser({ spec: tc.spec, preset: null });
  const [user] = await query("SELECT sinque_id FROM users WHERE id = ?", [created.id]);
  const c = await buildCase(created.id);
  const failed = c.checks.filter(x => !x.ok);
  tc.result = {
    user_id: created.id, sinque_id: user?.sinque_id, email: created.email, at: new Date().toISOString(), by: actor,
    pass: !c.apiError && failed.length === 0, api_error: c.apiError, checks: c.checks,
  };
  // Link the new test user to the ticket so it shows up on both sides.
  if (jiraEnabled() && user?.sinque_id) {
    try { await linkUsers(key.toUpperCase(), [user.sinque_id]); tc.result.linked = true; } catch (error) { tc.result.link_error = error.message; }
  }
  // Re-read before saving: another run may have saved a result meanwhile.
  const latest = readTestCases(key) || data;
  const i = latest.test_cases.findIndex(t => t.id === caseId);
  if (i >= 0) latest.test_cases[i] = tc;
  saveTestCases(key, latest);
  audit(actor, "run ticket test case", { ticket: key.toUpperCase(), test_case: caseId, user_id: created.id, sinque_id: user?.sinque_id, pass: tc.result.pass });
  return tc;
};

const routes = [
  ["GET", /^\/api\/info$/, async () => ({
    db_host: config.db.host || "",
    db_name: config.db.database || "",
    api_base_url: config.apiBaseUrl,
    test_password: config.testPassword,
    test_domain: TEST_EMAIL_DOMAIN,
    environment: environmentCheck.checked ? environmentCheck : await checkEnvironment(),
    ai_enabled: aiEnabled(),
    ai: aiInfo(),
    jira_enabled: jiraEnabled(),
    jira_project: config.jira.project,
    presets: PRESETS,
  })],

  ["GET", /^\/api\/home$/, () => homeData()],
  ["GET", /^\/api\/jobs$/, req => listJobs(req.actor)],

  // ---------- Platform: projects ----------
  ["GET", /^\/api\/projects$/, req => projectsFor(req.actor, roleOf(req.actor))],
  ["POST", /^\/api\/projects$/, async req => {
    requireAdmin(req);
    const r = saveProject({ ...(await readBody(req)), create: true });
    audit(req.actor, "create project", { project: r.key, name: r.name });
    checkAll().catch(() => {});
    return r;
  }],
  ["PUT", /^\/api\/projects\/([A-Z0-9]+)$/, async (req, url, [key]) => {
    requireAdmin(req);
    const r = saveProject({ ...(await readBody(req)), key });
    audit(req.actor, "update project", { project: r.key });
    checkAll().catch(() => {});
    return r;
  }],
  ["DELETE", /^\/api\/projects\/([A-Z0-9]+)$/, (req, url, [key]) => {
    requireAdmin(req);
    const r = deleteProject(key);
    audit(req.actor, "remove project", { project: key });
    return r;
  }],

  // Environment health
  ["GET", /^\/api\/health$/, req => projectHealth(proj(req))],
  ["POST", /^\/api\/health\/check$/, async req => { const p = proj(req); await checkAll(); return projectHealth(p); }],

  // Test suites and cases
  ["GET", /^\/api\/suites$/, req => listSuites(proj(req))],
  ["POST", /^\/api\/suites$/, async req => {
    const p = proj(req), r = saveSuite(p, await readBody(req), req.actor);
    audit(req.actor, "save test suite", { project: p.key, suite: r.name });
    return r;
  }],
  ["DELETE", new RegExp(`^/api/suites/${ID}$`), (req, url, [id]) => {
    const p = proj(req), r = deleteSuite(p, id);
    audit(req.actor, "delete test suite", { project: p.key, suite: id });
    return r;
  }],
  ["GET", /^\/api\/cases$/, (req, url) => listCases(proj(req), { suite: url.searchParams.get("suite") })],
  ["POST", /^\/api\/cases$/, async req => {
    const p = proj(req), r = saveCase(p, await readBody(req), req.actor);
    audit(req.actor, "save test case", { project: p.key, test_case: r.id });
    return r;
  }],
  ["POST", /^\/api\/cases\/import$/, async req => {
    const p = proj(req), r = importCases(p, await readBody(req), req.actor);
    audit(req.actor, "add test cases", { project: p.key, count: r.added.length });
    return r;
  }],
  ["DELETE", new RegExp(`^/api/cases/${ID}$`), (req, url, [id]) => {
    const p = proj(req), r = deleteCase(p, id);
    audit(req.actor, "delete test case", { project: p.key, test_case: id });
    return r;
  }],
  ["POST", /^\/api\/cases\/ai$/, async req => {
    const p = proj(req), body = await readBody(req);
    const key = String(body.ticket_key || "").trim().toUpperCase();
    return startJob({
      kind: "ai-cases", title: key ? `Write test cases for ${key}` : "Write test cases from a requirement", actor: req.actor, link: { view: "cases" },
      outcome: d => ({ text: `${d.test_cases.length} test cases ready to review`, ok: true }),
    }, async progress => {
      progress(0, 2, key ? `Reading ${key}` : "Reading the requirement");
      const ticket = key ? await getTicket(key) : null;
      progress(1, 2, "The AI is writing test cases");
      const d = await genericTestCases({ project: p, ticket, text: body.text }, req.actor);
      audit(req.actor, "AI test cases", { project: p.key, ticket: key || null, test_cases: d.test_cases.length });
      return { ...d, project: p.key, ticket: key || null };
    });
  }],

  // UI automation of a test case
  ["PUT", new RegExp(`^/api/cases/${ID}/automation$`), async (req, url, [id]) => {
    const p = proj(req), body = await readBody(req), r = saveAutomation(p, id, body, req.actor);
    audit(req.actor, body.remove ? "remove UI automation" : "save UI automation", { project: p.key, test_case: id, steps: body.remove ? 0 : r.steps.length });
    return r;
  }],
  ["POST", new RegExp(`^/api/cases/${ID}/automation/write$`), async (req, url, [id]) => {
    const p = proj(req), body = await readBody(req);
    const c = listCases(p).find(x => x.id === id);
    if (!c) throw Object.assign(new Error("Test case not found."), { status: 404 });
    return startJob({
      kind: "ui-write", title: `Write UI steps for ${id}`, actor: req.actor, link: { view: "cases" },
      outcome: d => ({ text: `${d.steps.length} steps written${d.questions.length ? `, ${d.questions.length} question${d.questions.length > 1 ? "s" : ""}` : ""}`, ok: true }),
    }, async progress => {
      const r = await writeSteps(p, c, body.environment, String(body.start_path || "/").trim(), req.actor, progress);
      audit(req.actor, "AI UI steps", { project: p.key, test_case: id, steps: r.steps.length });
      return r;
    });
  }],
  ["POST", new RegExp(`^/api/cases/${ID}/automation/run$`), async (req, url, [id]) => {
    const p = proj(req), body = await readBody(req);
    const c = listCases(p).find(x => x.id === id);
    if (!c) throw Object.assign(new Error("Test case not found."), { status: 404 });
    // "Try it" runs the steps in the editor without saving them.
    const testCase = Array.isArray(body.steps) ? { ...c, automation: { steps: cleanSteps(body.steps) } } : c;
    return startJob({
      kind: "ui-run", title: `UI test ${id}`, actor: req.actor, link: { view: "cases" },
      outcome: r => ({ text: r.pass ? `Passed (${r.steps.length} steps)` : `Failed at step ${r.failed_step || "?"}`, ok: r.pass }),
    }, async progress => {
      const r = await runUiCase(p, testCase, body.environment, req.actor, { onStep: progress });
      audit(req.actor, "run UI test", { project: p.key, test_case: id, environment: r.environment, pass: r.pass });
      return r;
    });
  }],
  ["GET", /^\/api\/ui\/runs$/, (req, url) => listUiRuns(proj(req), url.searchParams.get("case"))],
  ["GET", new RegExp(`^/api/ui/runs/${ID}$`), (req, url, [id]) => getUiRun(proj(req), id)],
  ["POST", new RegExp(`^/api/ui/runs/${ID}/repair$`), async (req, url, [id]) => {
    const p = proj(req), run = getUiRun(p, id);
    const c = listCases(p).find(x => x.id === run.case_id);
    if (!c) throw Object.assign(new Error("The test case was deleted."), { status: 404 });
    return startJob({
      kind: "ui-repair", title: `Fix UI steps for ${c.id}`, actor: req.actor, link: { view: "cases" },
      outcome: d => ({ text: `${d.changed.length} step${d.changed.length === 1 ? "" : "s"} changed`, ok: true }),
    }, async progress => {
      progress(0, 1, "The AI is looking at the page where it failed");
      const r = await repairSteps(p, c, id, req.actor);
      audit(req.actor, "AI fix UI steps", { project: p.key, test_case: c.id, changed: r.changed.length });
      return r;
    });
  }],
  // Runs every automated case of a test run and records the results with screenshots.
  ["POST", new RegExp(`^/api/runs/${ID}/automated$`), async (req, url, [runId]) => {
    const p = proj(req), body = await readBody(req), run = getRun(p, runId);
    if (run.status === "closed") throw Object.assign(new Error("This run is closed. Reopen it to run the automated cases."), { status: 400 });
    const library = new Map(listCases(p).map(c => [c.id, c]));
    // The latest saved steps are used, even if the case changed after the run started.
    const cases = run.cases.map(c => library.get(c.id) || c).filter(c => c.automation?.steps?.length && (!body.only_untested || !run.results[c.id]));
    if (!cases.length) throw Object.assign(new Error("No automated test cases in this run. Open a test case and automate it first."), { status: 400 });
    const envId = body.environment || p.environments.find(e => e.name === run.environment)?.id;
    return startJob({
      kind: "ui-run-all", title: `UI tests in ${run.name}`, actor: req.actor, link: { view: "run", id: runId },
      outcome: r => ({ text: `${r.passed} of ${r.total} automated cases pass`, ok: r.passed === r.total }),
    }, async progress => {
      let passed = 0;
      const out = [];
      for (const [i, c] of cases.entries()) {
        progress(i, cases.length, `${c.id} ${c.title}`);
        let r;
        try { r = await runUiCase(p, c, envId, req.actor, { testRunId: runId }); }
        catch (e) { out.push({ case_id: c.id, error: e.message }); continue; }
        if (r.pass) passed++;
        const note = r.pass
          ? `Automated UI test passed on ${r.environment}: ${r.steps.length} steps in ${(r.ms / 1000).toFixed(1)} s.`
          : `Automated UI test failed on ${r.environment}. ${r.error}`;
        setResult(p, runId, c.id, { status: r.pass ? "passed" : "failed", note }, req.actor);
        const shot = [...r.steps].reverse().find(s => s.shot);
        if (shot) {
          const f = uiRunFile(p, r.id, shot.shot);
          addEvidence(p, runId, c.id, { name: `UI test step ${shot.n}.jpg`, data: `data:image/jpeg;base64,${fs.readFileSync(f.path).toString("base64")}` }, req.actor);
        }
        out.push({ case_id: c.id, pass: r.pass, ui_run: r.id, error: r.error });
      }
      audit(req.actor, "run automated cases", { project: p.key, run: run.name, passed, total: cases.length });
      return { total: cases.length, passed, results: out };
    });
  }],

  // Test runs
  ["GET", /^\/api\/runs$/, req => listRuns(proj(req))],
  ["POST", /^\/api\/runs$/, async req => {
    const p = proj(req), r = createRun(p, await readBody(req), req.actor);
    audit(req.actor, "start test run", { project: p.key, run: r.name, test_cases: r.total });
    return r;
  }],
  ["GET", new RegExp(`^/api/runs/${ID}$`), (req, url, [id]) => getRun(proj(req), id)],
  ["DELETE", new RegExp(`^/api/runs/${ID}$`), (req, url, [id]) => {
    requireAdmin(req);
    const p = proj(req), r = deleteRun(p, id);
    audit(req.actor, "delete test run", { project: p.key, run: id });
    return r;
  }],
  ["POST", new RegExp(`^/api/runs/${ID}/status$`), async (req, url, [id]) => {
    const p = proj(req), r = setRunStatus(p, id, (await readBody(req)).status, req.actor);
    audit(req.actor, r.status === "closed" ? "close test run" : "reopen test run", { project: p.key, run: r.name });
    return r;
  }],
  ["POST", new RegExp(`^/api/runs/${ID}/results/${ID}$`), async (req, url, [id, caseId]) => {
    const p = proj(req), body = await readBody(req), r = setResult(p, id, caseId, body, req.actor);
    audit(req.actor, "test result", { project: p.key, run: id, test_case: caseId, status: body.status ?? "cleared" });
    return r;
  }],
  ["POST", new RegExp(`^/api/runs/${ID}/results/${ID}/evidence$`), async (req, url, [id, caseId]) => {
    const p = proj(req), r = addEvidence(p, id, caseId, await readBody(req), req.actor);
    audit(req.actor, "add evidence", { project: p.key, run: id, test_case: caseId, file: r.name });
    return r;
  }],
  ["POST", new RegExp(`^/api/runs/${ID}/results/${ID}/jira$`), async (req, url, [id, caseId]) => {
    const p = proj(req);
    if (!p.jira_project) throw Object.assign(new Error("This project has no Jira project key yet."), { status: 400 });
    const body = await readBody(req);
    const t = await createTicket({ summary: body.summary, markdown: body.markdown, issueType: body.issueType || "Bug", fileName: `${caseId}-failed`, actor: req.actor, jiraProject: p.jira_project, labels: [`qa-${p.key.toLowerCase()}`, `qa-run-${id}`, ...(p.pack === "sinque" ? ["sinque-qa"] : [])] });
    const run = getRun(p, id);
    setResult(p, id, caseId, { status: run.results[caseId]?.status || "failed", jira: t.key }, req.actor);
    audit(req.actor, "create jira ticket", { project: p.key, ticket: t.key, run: id, test_case: caseId });
    return t;
  }],

  // API checks
  ["GET", /^\/api\/apichecks$/, req => listChecks(proj(req))],
  // Postman collection → API checks. preview: true only reads it; otherwise adds the picked ones.
  ["POST", /^\/api\/apichecks\/import\/postman$/, async req => {
    const p = proj(req), body = await readBody(req);
    const parsed = parsePostman(body.collection);
    const have = new Set(listChecks(p).map(c => c.key).filter(Boolean));
    if (body.preview) {
      return {
        ...parsed,
        checks: parsed.checks.map(c => ({ key: c.key, name: c.name, method: c.method, path: c.path, group: c.group, enabled: c.enabled, assertions: c.assertions.length, exists: have.has(c.key) })),
        summary: { ...parsed.summary, already: parsed.checks.filter(c => have.has(c.key)).length },
      };
    }
    const pick = Array.isArray(body.keys) ? new Set(body.keys) : null;
    const chosen = parsed.checks.filter(c => !pick || pick.has(c.key));
    const r = importChecks(p, chosen, req.actor);
    audit(req.actor, "import postman collection", { project: p.key, collection: parsed.collection, added: r.added, skipped: chosen.length - r.added });
    return { ...r, skipped: chosen.length - r.added, collection: parsed.collection, secrets: parsed.secrets, notes: parsed.notes };
  }],
  // OpenAPI / Swagger spec → API checks (a file's text, or its address). preview: true only reads it.
  ["POST", /^\/api\/apichecks\/import\/openapi$/, async req => {
    const p = proj(req), body = await readBody(req);
    const text = body.url ? await fetchSpec(body.url) : body.spec;
    const parsed = parseOpenApi(readSpecText(text), { prefix: body.prefix, shapes: body.shapes !== false });
    const have = new Set(listChecks(p).map(c => c.key).filter(Boolean));
    if (body.preview) {
      return {
        ...parsed, endpoints: undefined,
        checks: parsed.checks.map(c => ({ key: c.key, name: c.name, method: c.method, path: c.path, group: c.group, enabled: c.enabled, assertions: c.assertions.length + (c.shape ? 1 : 0), exists: have.has(c.key) })),
        summary: { ...parsed.summary, already: parsed.checks.filter(c => have.has(c.key)).length },
      };
    }
    const pick = Array.isArray(body.keys) ? new Set(body.keys) : null;
    const chosen = parsed.checks.filter(c => !pick || pick.has(c.key));
    const r = importChecks(p, chosen, req.actor);
    saveSpec(p, parsed, body.prefix, req.actor);
    audit(req.actor, "import openapi spec", { project: p.key, spec: parsed.title, endpoints: parsed.endpoints.length, added: r.added });
    return { ...r, skipped: chosen.length - r.added, collection: parsed.title, secrets: parsed.secrets, notes: parsed.notes };
  }],
  ["GET", /^\/api\/apichecks\/coverage$/, req => { const p = proj(req); return apiCoverage(p, listChecks(p)); }],
  ["GET", /^\/api\/apichecks\/info$/, req => (proj(req).pack === "sinque" ? sinqueApiInfo() : {})],
  ["POST", /^\/api\/apichecks$/, async req => {
    const p = proj(req), r = saveCheck(p, await readBody(req), req.actor);
    audit(req.actor, "save API check", { project: p.key, check: r.name });
    return r;
  }],
  ["DELETE", new RegExp(`^/api/apichecks/${ID}$`), (req, url, [id]) => {
    const p = proj(req), r = deleteCheck(p, id);
    audit(req.actor, "delete API check", { project: p.key, check: id });
    return r;
  }],
  // Values saved from answers, per environment
  ["GET", /^\/api\/apichecks\/values$/, (req, url) => {
    const p = proj(req), env = projectEnvironment(p, url.searchParams.get("environment"));
    return { environment: env.name, values: listValues(p, env.id) };
  }],
  ["DELETE", /^\/api\/apichecks\/values$/, (req, url) => {
    const p = proj(req), env = projectEnvironment(p, url.searchParams.get("environment"));
    const r = clearValues(p, env.id, url.searchParams.get("name") || null);
    audit(req.actor, "clear saved API values", { project: p.key, environment: env.name, name: url.searchParams.get("name") || "all" });
    return r;
  }],
  ["POST", new RegExp(`^/api/apichecks/${ID}/shape$`), async (req, url, [id]) => {
    const p = proj(req), r = await recordShape(p, id, (await readBody(req)).environment, req.actor);
    audit(req.actor, "keep API response shape", { project: p.key, check: r.run.name, fields: r.fields });
    return r;
  }],
  ["GET", new RegExp(`^/api/apichecks/${ID}/history$`), (req, url, [id]) => checkHistory(proj(req), id)],
  ["POST", new RegExp(`^/api/apichecks/${ID}/run$`), async (req, url, [id]) => {
    const p = proj(req), check = listChecks(p).find(c => c.id === id);
    if (!check) throw Object.assign(new Error("API check not found."), { status: 404 });
    return runCheck(p, check, (await readBody(req)).environment, req.actor);
  }],
  ["POST", /^\/api\/apichecks\/run-all$/, async req => {
    const p = proj(req), body = await readBody(req), envId = body.environment;
    // Only switched-on checks, optionally one group (service) or tag.
    const checks = orderForChain(listChecks(p).filter(c => c.enabled && (!body.group || c.group === body.group) && (!body.tag || (c.tags || []).includes(body.tag))));
    if (!checks.length) throw Object.assign(new Error("No switched-on API checks to run here."), { status: 400 });
    const env = p.environments.find(e => e.id === envId) || p.environments[0];
    return startJob({
      kind: "api-checks", title: `API checks on ${p.name} ${env?.name || ""}`.trim(), actor: req.actor, link: { view: "apichecks" },
      outcome: r => ({ text: `${r.passed} of ${r.total} API checks pass`, ok: r.passed === r.total }),
    }, async progress => {
      let passed = 0;
      const runs = [], failed = [];
      for (const [i, c] of checks.entries()) {
        progress(i, checks.length, `${c.method} ${c.path}`);
        try {
          const r = await runCheck(p, c, envId, req.actor, { save: false });
          runs.push(r);
          if (r.pass) passed++; else failed.push({ name: c.name, status: r.status, error: r.error });
        } catch (error) { failed.push({ name: c.name, error: error.message }); }
        if (runs.length >= 25) saveRuns(p, runs.splice(0));
      }
      saveRuns(p, runs);
      audit(req.actor, "run API checks", { project: p.key, environment: env?.name, group: body.group || null, passed, total: checks.length });
      return { total: checks.length, passed, failed: failed.slice(0, 100) };
    });
  }],

  // Test data cleanup
  ["GET", /^\/api\/cleanup$/, () => inventory()],
  ["POST", /^\/api\/cleanup\/plan$/, async req => planCleanup(await readBody(req))],
  ["POST", /^\/api\/cleanup$/, async req => {
    requireAdmin(req);
    const body = await readBody(req);
    const r = await runCleanup(body, req.actor);
    audit(req.actor, "clean up test data", { users: r.users, groups: r.groups, professionals: r.professionals, skipped: r.skipped.length, older_than_days: body.olderThanDays ?? null });
    return r;
  }],
  ["GET", /^\/api\/jobs\/([\w]+)$/, (req, url, [id]) => getJob(id, req.actor)],

  // Team: tester accounts (admins only, except changing your own password)
  ["GET", /^\/api\/team$/, req => { requireAdmin(req); return listTesters(); }],
  ["POST", /^\/api\/team$/, async req => {
    requireAdmin(req);
    const body = await readBody(req);
    const created = addTester(body, req.actor);
    audit(req.actor, "add tester", { tester: created.name, role: created.role });
    return created;
  }],
  ["POST", /^\/api\/team\/([\w.-]+)\/reset$/, (req, url, [name]) => {
    requireAdmin(req);
    const r = resetTesterPassword(name);
    audit(req.actor, "reset tester password", { tester: r.name });
    return r;
  }],
  ["PUT", /^\/api\/team\/([\w.-]+)$/, async (req, url, [name]) => {
    requireAdmin(req);
    const r = setTesterRole(name, (await readBody(req)).role, req.actor);
    audit(req.actor, "change tester role", { tester: r.name, role: r.role });
    return r;
  }],
  ["DELETE", /^\/api\/team\/([\w.-]+)$/, (req, url, [name]) => {
    requireAdmin(req);
    const r = removeTester(name, req.actor);
    audit(req.actor, "remove tester", { tester: r.removed });
    return r;
  }],
  // Settings page (admins): AI provider, database, Sinque app, shared Jira
  ["GET", /^\/api\/settings$/, req => { requireAdmin(req); return settingsView(); }],
  ["POST", /^\/api\/settings\/(\w+)\/test$/, async (req, url, [id]) => { requireAdmin(req); return testSettings(id, (await readBody(req)).values); }],
  ["PUT", /^\/api\/settings\/(\w+)$/, async (req, url, [id]) => {
    requireAdmin(req);
    const { values, clear } = await readBody(req);
    const r = await saveSettings(id, values, req.actor, Array.isArray(clear) ? clear : []);
    // Only the names of what changed go to the audit log, never the values.
    if (r.saved.length) audit(req.actor, "change settings", { section: id, settings: r.saved.join(", ") });
    if (r.saved.length && (id === "database" || id === "sinque")) checkEnvironment();
    return r;
  }],
  ["DELETE", /^\/api\/settings\/key\/(\w+)$/, (req, url, [key]) => {
    requireAdmin(req);
    const r = resetSetting(key, req.actor);
    audit(req.actor, "reset setting to .env", { setting: key });
    if (/^(DATABASE_|API_BASE_URL)/.test(key)) checkEnvironment();
    return r;
  }],

  // The tester's own Jira connection
  ["GET", /^\/api\/me\/jira$/, req => jiraConnection(req.actor)],
  ["POST", /^\/api\/me\/jira$/, async req => {
    const r = await connectJira(req.actor, await readBody(req));
    audit(req.actor, "connect own jira", { account: r.account });
    return r;
  }],
  ["DELETE", /^\/api\/me\/jira$/, req => {
    const r = disconnectJira(req.actor);
    audit(req.actor, "disconnect own jira", {});
    return r;
  }],
  ["POST", /^\/api\/me\/password$/, async req => {
    const { current, next } = await readBody(req);
    const r = await changeOwnPassword(req.actor, current, next);
    audit(req.actor, "change own password", {});
    return r;
  }],

  // Audit log
  ["GET", /^\/api\/audit$/, (req, url) => readAudit(Object.fromEntries(url.searchParams))],

  // Test users: delete / reset, bug report, phone login QR
  ["POST", /^\/api\/users\/delete$/, async req => {
    const r = await deleteTestUsers((await readBody(req)).ids, req.actor);
    audit(req.actor, "delete test users", { count: r.deleted, users: r.users });
    return r;
  }],
  ["POST", /^\/api\/users\/([\w-]+)\/reset$/, async (req, url, [id]) => {
    const r = await resetTestUser(id, (await readBody(req)).preset);
    audit(req.actor, "reset test user", { user: r.user, user_id: id, preset: r.preset, measurements: r.measurements });
    return r;
  }],
  ["GET", /^\/api\/users\/([\w-]+)\/bug-report$/, (req, url, [id]) => bugReportData(id, req.actor, { includeOverview: url.searchParams.get("overview") === "1" })],
  ["GET", /^\/api\/users\/([\w-]+)\/login-card$/, (req, url, [id]) => loginCard(req, id, auth)],

  // Jira: tickets from bug reports, linked to users by label
  ["GET", /^\/api\/jira\/info$/, req => jiraInfo(proj(req).jira_project || config.jira.project)],
  ["POST", /^\/api\/jira\/tickets$/, async req => {
    const body = await readBody(req);
    const p = proj(req);
    const r = await createTicket({ ...body, actor: req.actor, jiraProject: p.jira_project || config.jira.project, labels: ["sinque-qa", `qa-${p.key.toLowerCase()}`] });
    audit(req.actor, "create jira ticket", { ticket: r.key, sinque_id: body.sinqueId ?? null, summary: body.summary });
    return r;
  }],
  ["POST", /^\/api\/jira\/tickets\/lookup$/, async req => ({ tickets: await ticketsFor((await readBody(req)).sinque_ids || []) })],
  ["GET", /^\/api\/jira\/coverage$/, req => jiraCoverage(proj(req))],
  ["GET", /^\/api\/jira\/tickets$/, (req, url) => listTickets({ ...Object.fromEntries(url.searchParams), jiraProject: proj(req).jira_project })],
  ["GET", /^\/api\/jira\/tickets\/([A-Za-z][A-Za-z0-9]*-\d+)$/, (req, url, [key]) => getTicket(key)],

  // Test cases from a ticket: generate (AI), run scenario cases, post back to Jira
  ["POST", /^\/api\/jira\/tickets\/([A-Za-z][A-Za-z0-9]*-\d+)\/test-cases$/, async (req, url, [key]) => {
    const ticketKey = key.toUpperCase();
    const { post: postToJira } = await readBody(req);
    return startJob({
      kind: "test-cases", title: `Write test cases for ${ticketKey}`, actor: req.actor, link: { view: "ticket", key: ticketKey },
      outcome: d => ({ text: `${d.test_cases.length} test cases written${d.jira_state?.posted && d.jira_state.up_to_date ? " and posted to Jira" : d.post_error ? `, not posted: ${d.post_error}` : ""}`, ok: !d.post_error }),
    }, async progress => {
      const steps = postToJira ? 4 : 3;
      progress(0, steps, "Reading the ticket and linked users");
      const ticket = await getTicket(ticketKey);
      progress(1, steps, "The AI is writing test cases");
      // Keep the link to the Jira comment, so posting again updates it.
      const previous = readTestCases(ticket.key);
      const fresh = await ticketTestCases(ticket, req.actor);
      if (previous?.jira_comment) fresh.jira_comment = previous.jira_comment;
      let data = saveTestCases(ticket.key, fresh);
      audit(req.actor, "generate test cases", { ticket: ticket.key, test_cases: data.test_cases.length });
      if (postToJira) {
        progress(3, steps, "Posting to Jira");
        try {
          data = await postTestCases(ticket.key, req.actor);
          audit(req.actor, "post test cases to jira", { ticket: ticket.key, test_cases: data.test_cases.length, updated: data.updated, automatic: true });
        } catch (error) { data.post_error = error.message; }
      }
      progress(steps, steps, "Saved");
      return data;
    });
  }],
  ["POST", /^\/api\/jira\/tickets\/([A-Za-z][A-Za-z0-9]*-\d+)\/test-cases\/([\w-]+)\/run$/, (req, url, [key, caseId]) => runTicketCase(key, caseId, req.actor)],
  ["POST", /^\/api\/jira\/tickets\/([A-Za-z][A-Za-z0-9]*-\d+)\/test-cases\/run-all$/, (req, url, [key]) => {
    const ids = (readTestCases(key)?.test_cases || []).filter(t => t.spec).map(t => t.id);
    if (!ids.length) throw Object.assign(new Error("This ticket has no scenario test cases."), { status: 400 });
    const ticket = key.toUpperCase();
    return startJob({
      kind: "ticket-run", title: `Run ${ids.length} scenario${ids.length > 1 ? "s" : ""} for ${ticket}`, actor: req.actor, link: { view: "ticket", key: ticket },
      outcome: r => ({ text: `${r.passed} of ${r.total} scenarios match the rules`, ok: r.passed === r.total }),
    }, async progress => {
      let passed = 0;
      for (const [i, id] of ids.entries()) {
        progress(i, ids.length, `Creating and checking ${id}`);
        if ((await runTicketCase(ticket, id, req.actor)).result.pass) passed++;
      }
      progress(ids.length, ids.length, "Done");
      return { ticket, total: ids.length, passed };
    });
  }],
  ["POST", /^\/api\/jira\/tickets\/([A-Za-z][A-Za-z0-9]*-\d+)\/test-cases\/([\w-]+)\/result$/, async (req, url, [key, caseId]) => {
    const data = readTestCases(key);
    const tc = data?.test_cases.find(t => t.id === caseId);
    if (!tc) throw Object.assign(new Error("Test case not found."), { status: 404 });
    const { pass, note } = await readBody(req);
    tc.result = pass === null ? undefined : { ...(tc.result || {}), manual: true, pass: !!pass, note: String(note || "").slice(0, 500), at: new Date().toISOString(), by: req.actor };
    saveTestCases(key, data);
    audit(req.actor, "mark ticket test case", { ticket: key.toUpperCase(), test_case: caseId, pass: pass === null ? "cleared" : !!pass });
    return tc;
  }],
  // Edit the ticket itself, and add or edit its test cases by hand
  ["PUT", /^\/api\/jira\/tickets\/([A-Za-z][A-Za-z0-9]*-\d+)$/, async (req, url, [key]) => {
    const body = await readBody(req);
    const r = await updateTicket(key.toUpperCase(), { summary: body.summary, description: body.description });
    audit(req.actor, "edit jira ticket", { ticket: r.key, changed: r.changed.join(", ") });
    return r;
  }],
  ["POST", /^\/api\/jira\/tickets\/([A-Za-z][A-Za-z0-9]*-\d+)\/test-cases\/manual$/, async (req, url, [raw]) => {
    const key = raw.toUpperCase(), body = await readBody(req);
    const title = String(body.title || "").trim();
    if (!title) throw Object.assign(new Error("A test case needs a title."), { status: 400 });
    const data = readTestCases(key) || { ticket: key, generated_at: new Date().toISOString(), generated_by: req.actor, summary: "", area: "", likely_cause: "", acceptance: [], questions: [], test_cases: [] };
    const steps = (Array.isArray(body.steps) ? body.steps : String(body.steps || "").split(/\r?\n/)).map(x => String(x).trim()).filter(Boolean);
    const fields = {
      title: title.slice(0, 200),
      kind: ["scenario", "manual", "edge", "regression"].includes(body.kind) ? body.kind : "manual",
      priority: ["high", "medium", "low"].includes(body.priority) ? body.priority : "medium",
      preconditions: String(body.preconditions || "").trim(), steps, expected: String(body.expected || "").trim(),
    };
    let tc = body.id && data.test_cases.find(t => t.id === body.id);
    if (tc) {
      // A scenario stays a scenario only while it still has its settings.
      if (fields.kind === "scenario" && !tc.spec) fields.kind = "manual";
      Object.assign(tc, fields, { edited_by: req.actor, edited_at: new Date().toISOString() });
    } else {
      const next = data.test_cases.reduce((n, t) => Math.max(n, Number(String(t.id).match(/(\d+)$/)?.[1]) || 0), 0) + 1;
      tc = { id: `${key}-TC${String(next).padStart(2, "0")}`, ...fields, kind: fields.kind === "scenario" ? "manual" : fields.kind, spec: null, source: "manual", created_by: req.actor, created_at: new Date().toISOString() };
      data.test_cases.push(tc);
    }
    if (Array.isArray(body.acceptance)) data.acceptance = body.acceptance.map(String).filter(Boolean);
    saveTestCases(key, data);
    audit(req.actor, body.id ? "edit ticket test case" : "add ticket test case", { ticket: key, test_case: tc.id });
    return data;
  }],
  ["POST", /^\/api\/jira\/tickets\/([A-Za-z][A-Za-z0-9]*-\d+)\/test-cases\/details$/, async (req, url, [raw]) => {
    const key = raw.toUpperCase(), body = await readBody(req), data = readTestCases(key);
    if (!data) throw Object.assign(new Error("Add a test case first."), { status: 400 });
    const list = v => (Array.isArray(v) ? v : String(v || "").split(/\r?\n/)).map(x => String(x).trim()).filter(Boolean);
    Object.assign(data, { summary: String(body.summary ?? data.summary).trim(), likely_cause: String(body.likely_cause ?? data.likely_cause).trim(), acceptance: list(body.acceptance ?? data.acceptance), questions: list(body.questions ?? data.questions) });
    saveTestCases(key, data);
    audit(req.actor, "edit ticket test details", { ticket: key });
    return data;
  }],
  ["DELETE", /^\/api\/jira\/tickets\/([A-Za-z][A-Za-z0-9]*-\d+)\/test-cases\/([\w-]+)$/, (req, url, [raw, caseId]) => {
    const key = raw.toUpperCase(), data = readTestCases(key);
    const i = data?.test_cases.findIndex(t => t.id === caseId) ?? -1;
    if (i < 0) throw Object.assign(new Error("Test case not found."), { status: 404 });
    data.test_cases.splice(i, 1);
    saveTestCases(key, data);
    audit(req.actor, "delete ticket test case", { ticket: key, test_case: caseId });
    return data;
  }],
  ["POST", /^\/api\/jira\/tickets\/([A-Za-z][A-Za-z0-9]*-\d+)\/test-cases\/comment$/, async (req, url, [key]) => {
    const r = await postTestCases(key, req.actor, { overwrite: !!(await readBody(req)).overwrite });
    audit(req.actor, "post test cases to jira", { ticket: key.toUpperCase(), test_cases: r.test_cases.length, updated: r.updated, where: r.where });
    return r;
  }],

  // QA checks against the deployed dev API
  ["GET", /^\/api\/presets\/check\/([\w-]+)$/, (req, url, [id]) => presetCheck(id, url.searchParams.get("preset"))],
  ["POST", /^\/api\/presets\/run$/, async req => {
    const body = await readBody(req);
    return startJob({
      kind: "presets", title: "Run all presets", actor: req.actor, link: { view: "presets" },
      outcome: r => ({ text: `${r.passed} of ${r.results.length} presets pass`, ok: r.failed === 0 }),
    }, progress => runAllPresets(body, req.actor, progress));
  }],
  ["GET", /^\/api\/users\/([\w-]+)\/overview-check$/, (req, url, [id]) => overviewCheck(id, req.actor)],
  ["GET", /^\/api\/users\/([\w-]+)\/report-link$/, (req, url, [id]) => reportLink(id, req.actor)],
  ["GET", /^\/api\/users\/([\w-]+)\/history$/, (req, url, [id]) => reportHistory(id)],

  // AI features. Rule checks run in code; the AI explains, summarises and drafts.
  ["GET", /^\/api\/ai\/check\/([\w-]+)$/, async (req, url, [id]) => {
    const c = await buildCase(id);
    return { checks: c.checks, expected: c.expected, api_error: c.apiError };
  }],
  ["POST", /^\/api\/ai\/explain\/([\w-]+)$/, async (req, url, [id]) => {
    audit(req.actor, "AI explain report", { user_id: id });
    return explainReport(id, req.actor);
  }],
  ["POST", /^\/api\/ai\/scan$/, async req => {
    const body = await readBody(req);
    audit(req.actor, "rule scan", { scope: body.scope, group_id: body.groupId, subgroup_id: body.subgroupId });
    return startJob({
      kind: "scan", title: body.scope === "group" ? "Report checker: group" : "Report checker: test users", actor: req.actor, link: { view: "checker" },
      outcome: r => ({ text: r.mismatches || r.errors ? `${r.mismatches} mismatch${r.mismatches === 1 ? "" : "es"}, ${r.errors} error${r.errors === 1 ? "" : "s"} in ${r.scanned} users` : `All ${r.scanned} reports match the rules`, ok: !r.mismatches && !r.errors }),
    }, progress => scanUsers(body, progress));
  }],
  ["POST", /^\/api\/ai\/scan\/summary$/, async req => summarizeScan(await readBody(req), req.actor)],
  ["POST", /^\/api\/ai\/scenario$/, async req => scenarioFromText((await readBody(req)).text, req.actor)],
  ["POST", /^\/api\/ai\/test-plan$/, async req => testPlan((await readBody(req)).text, req.actor)],
  ["POST", /^\/api\/ai\/client-reply$/, async req => {
    const body = await readBody(req);
    audit(req.actor, "AI client reply draft", { user_id: body.userId });
    return clientReply(body, req.actor);
  }],
  ["POST", /^\/api\/ai\/search$/, async req => aiSearch((await readBody(req)).text, req.actor)],

  // Users
  ["GET", /^\/api\/users$/, (req, url) =>
    searchUsers({ q: url.searchParams.get("q") ?? "", testOnly: url.searchParams.get("test") === "1" })],
  ["GET", /^\/api\/users\/([\w-]+)$/, async (req, url, [id]) => (await getUserDetail(id)) ?? Promise.reject(Object.assign(new Error("User not found."), { status: 404 }))],
  ["GET", /^\/api\/users\/([\w-]+)\/report$/, async (req, url, [id]) => {
    if (url.searchParams.get("refresh") === "1") await clearStoredReports(id);
    return fetchReport(id);
  }],
  ["POST", /^\/api\/users\/([\w-]+)\/measurements$/, async (req, url, [id]) => {
    const { user, items, added } = await addMeasurements(id, await readBody(req));
    audit(req.actor, "add measurements", { user: user.email, user_id: id, added: items });
    return { added };
  }],
  ["PUT", /^\/api\/users\/([\w-]+)\/measurements\/(\d+)$/, async (req, url, [id, mid]) => {
    const { user, before, after } = await updateMeasurement(id, mid, await readBody(req));
    audit(req.actor, "edit measurement", { user: user.email, user_id: id, measurement_id: Number(mid), before, after });
    return { updated: after };
  }],
  ["DELETE", /^\/api\/users\/([\w-]+)\/measurements\/(\d+)$/, async (req, url, [id, mid]) => {
    const { user, before } = await deleteMeasurement(id, mid);
    audit(req.actor, "delete measurement", { user: user.email, user_id: id, measurement_id: Number(mid), before });
    return { deleted: Number(mid) };
  }],
  ["POST", /^\/api\/users\/([\w-]+)\/password$/, (req, url, [id]) => setTestPassword(id)],
  ["POST", /^\/api\/users\/([\w-]+)\/group$/, async (req, url, [id]) => setUserGroup(id, await readBody(req))],
  ["POST", /^\/api\/users\/([\w-]+)\/login-check$/, async (req, url, [id]) => {
    const user = await getUser(id);
    return loginSummary(await tryLogin(user.email, config.testPassword));
  }],
  ["POST", /^\/api\/scenarios$/, async req => createScenarioUser(await readBody(req))],

  // Groups
  ["GET", /^\/api\/groups$/, (req, url) => listGroups({ q: url.searchParams.get("q") ?? "" })],
  ["POST", /^\/api\/groups$/, async req => createGroup(await readBody(req))],
  ["POST", /^\/api\/subgroups$/, async req => createSubgroup(await readBody(req))],

  // Professionals
  ["GET", /^\/api\/professions$/, () => listProfessions()],
  ["GET", /^\/api\/professionals$/, (req, url) => listProfessionals({ testOnly: url.searchParams.get("all") !== "1" })],
  ["POST", /^\/api\/professionals$/, async req => createProfessional(await readBody(req))],
  ["POST", /^\/api\/professionals\/([\w-]+)\/access$/, async (req, url, [id]) => assignProfessional({ ...(await readBody(req)), professionalId: id })],
  ["POST", /^\/api\/professionals\/([\w-]+)\/password$/, (req, url, [id]) => resetProfessionalPassword(id)],
  ["POST", /^\/api\/professionals\/([\w-]+)\/login-check$/, async (req, url, [id]) => {
    const [p] = await query("SELECT email FROM professionals WHERE id = ?", [id]);
    return loginSummary(await tryLogin(p.email, config.testPassword, true));
  }],
];

const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);
  try {
    // Phone login card behind a QR code: the signed link is the key, no session needed.
    const card = url.pathname.match(/^\/card\/([\w.-]+)$/);
    if (req.method === "GET" && card) {
      const { status, html } = await cardPage(card[1], auth);
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
      res.end(html);
      return;
    }

    // Login: the only pages reachable without a session.
    if (url.pathname === "/login") {
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(fs.readFileSync(LOGIN_HTML));
        return;
      }
      if (req.method === "POST") {
        const { username, password } = await readBody(req);
        const result = await auth.check(username, password, clientIp(req));
        if (!result.ok) {
          console.warn(`Failed login for "${String(username).slice(0, 40)}" from ${clientIp(req)}`);
          send(res, 401, { error: result.error });
          return;
        }
        console.log(`${result.user} signed in from ${clientIp(req)}`);
        res.setHeader("Set-Cookie", auth.sessionCookie(req, result.user));
        send(res, 200, { user: result.user });
        return;
      }
    }
    if (req.method === "POST" && url.pathname === "/logout") {
      res.setHeader("Set-Cookie", auth.clearCookie(req));
      send(res, 200, { ok: true });
      return;
    }

    const user = auth.userFrom(req);
    req.actor = user;
    if (!user) {
      if (url.pathname.startsWith("/api/")) {
        send(res, 401, { error: "Please sign in again." });
      } else {
        res.writeHead(302, { Location: "/login" });
        res.end();
      }
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/me") {
      send(res, 200, { user, role: roleOf(user) });
      return;
    }
    if (req.method !== "GET") console.log(`${user}: ${req.method} ${url.pathname}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(INDEX_HTML));
      return;
    }
    const ui = req.method === "GET" && url.pathname.match(/^\/uifiles\/([A-Z0-9]+)\/([\w]+)\/([\w.-]+)$/);
    if (ui) {
      const f = uiRunFile(getProject(ui[1], user, roleOf(user)), ui[2], ui[3]);
      const size = fs.statSync(f.path).size;
      // Videos need range requests to play and seek.
      const range = req.headers.range && req.headers.range.match(/bytes=(\d*)-(\d*)/);
      if (range) {
        const start = range[1] ? Number(range[1]) : 0, end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        res.writeHead(206, { "Content-Type": f.type, "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1, "Cache-Control": "private, max-age=3600" });
        fs.createReadStream(f.path, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, { "Content-Type": f.type, "Content-Length": size, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" });
      fs.createReadStream(f.path).pipe(res);
      return;
    }
    const ev = req.method === "GET" && url.pathname.match(/^\/files\/([A-Z0-9]+)\/([\w]+)\/([\w.-]+)$/);
    if (ev) {
      const f = evidenceFile(getProject(ev[1], user, roleOf(user)), ev[2], ev[3]);
      res.writeHead(200, { "Content-Type": f.type, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" });
      res.end(fs.readFileSync(f.path));
      return;
    }
    // The rule oracle, so the Rules page's examples run the exact code the checks use.
    const LIB = { "/lib/rules.js": "rules.js", "/lib/scenarios.js": "scenarios.js" };
    if (req.method === "GET" && LIB[url.pathname]) {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(fs.readFileSync(path.join(config.root, "src", LIB[url.pathname])));
      return;
    }
    for (const [method, pattern, handler] of routes) {
      const match = req.method === method && url.pathname.match(pattern);
      if (match) {
        // Jira calls (also from jobs started here) use this tester's own Jira login.
        send(res, 200, await requestContext.run({ actor: user }, () => handler(req, url, match.slice(1))));
        return;
      }
    }
    send(res, 404, { error: "Not found." });
  } catch (error) {
    if (!error.status) console.error(error);
    send(res, error.status || 500, { error: error.message || String(error) });
  }
});

server.on("error", error => {
  if (error.code === "EADDRINUSE") {
    console.error(`\n[sinque-qa-tool] Port ${config.port} is already in use. Is the tool already running? Set PORT in .env to use another port.\n`);
    process.exit(1);
  }
  throw error;
});

server.listen(config.port, process.env.HOST || "127.0.0.1", () => {
  console.log(`\neFutures QA platform: http://localhost:${config.port}`);
  console.log(`Sinque DB:  ${sinqueDbSet() ? `${config.db.host} / ${config.db.database}` : "not set (Sinque tools off until it's added on the Settings page)"}`);
  console.log(`Sinque API: ${config.apiBaseUrl || "not set (reports and login checks off until it's added on the Settings page)"}`);
  console.log(`Testers:  ${listTesters().map(t => `${t.name}${t.role === "admin" ? " (admin)" : ""}`).join(", ")}`);
  console.log(`Projects: ${allProjects().map(p => p.name).join(", ")}\n`);
  checkEnvironment();
  startHealth();
});
