// UI automation without code: a test case gets plain steps ("click button Sign in",
// "fill field Email with …", "expect text Dashboard"), which the platform runs in a
// hidden Chromium (Playwright) against the project's environment. Every step gets
// a screenshot; a failed run keeps a video. The AI writes the steps from the test
// case and the real page, and suggests a fix when a step stops working.
//
// Privacy: what the AI sees of a page is its structure (buttons, fields, headings)
// with emails, phone numbers and the contents of tables and lists removed.
import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { askJson } from "./ai/llm.js";
import { config } from "./config.js";
import { readValues } from "./apivalues.js";
import { badRequest } from "./db.js";
import { dataPath, newId, now, readJson, updateJson } from "./store.js";

const STEP_TIMEOUT = 10000;
const KEEP_RUNS = 500;
const runsFile = project => dataPath("projects", project.key, "uiruns.json");
const runDir = (project, id) => dataPath("projects", project.key, "uiruns", id);

// ---------- steps ----------
export const ACTIONS = {
  open: { value: true, label: "Open page" },
  click: { target: true, label: "Click" },
  fill: { target: true, value: true, label: "Type into" },
  select: { target: true, value: true, label: "Choose option" },
  check: { target: true, label: "Tick" },
  uncheck: { target: true, label: "Untick" },
  press: { value: true, label: "Press key" },
  hover: { target: true, label: "Hover over" },
  wait: { label: "Wait" },
  expect_text: { value: true, label: "Expect text" },
  expect_no_text: { value: true, label: "Expect no text" },
  expect_visible: { target: true, label: "Expect visible" },
  expect_hidden: { target: true, label: "Expect gone" },
  expect_url: { value: true, label: "Expect address has" },
  expect_value: { target: true, value: true, label: "Expect field value" },
  expect_title: { value: true, label: "Expect page title has" },
};
const ROLES = ["button", "link", "checkbox", "radio", "heading", "tab", "option", "menuitem", "row", "cell", "combobox", "textbox", "switch", "dialog", "img", "listitem", "searchbox", "slider", "spinbutton", "navigation", "alert"];

export const cleanSteps = steps => (Array.isArray(steps) ? steps : []).slice(0, 80).map((s, i) => {
  const action = String(s.action || "").trim().toLowerCase();
  const spec = ACTIONS[action];
  if (!spec) throw badRequest(`Step ${i + 1}: “${s.action}” isn't a step type.`);
  const target = String(s.target ?? "").trim().slice(0, 300), value = String(s.value ?? "").slice(0, 2000);
  if (spec.target && !target) throw badRequest(`Step ${i + 1} (${spec.label}) needs something to act on, e.g. button "Sign in".`);
  if (spec.value && !value && action !== "fill") throw badRequest(`Step ${i + 1} (${spec.label}) needs a value.`);
  return { action, target, value, note: String(s.note || "").slice(0, 300) };
});

/** Saves a test case's automation (steps + start page). */
export const saveAutomation = (project, caseId, body, actor) => updateJson(dataPath("projects", project.key, "cases.json"), [], cases => {
  const c = cases.find(x => x.id === caseId);
  if (!c) throw Object.assign(new Error("Test case not found."), { status: 404 });
  if (body.remove) { delete c.automation; return { removed: true }; }
  const steps = cleanSteps(body.steps);
  c.automation = { steps, updated_at: now(), updated_by: actor, source: body.source === "ai" ? "ai" : "manual" };
  return c.automation;
});

// ---------- targets ----------
/** `button "Sign in"`, `field "Email"`, `text "Welcome"`, `testid login`, `css .x`, or plain words. */
const locate = (page, target) => {
  const t = String(target).trim();
  const quoted = t.match(/^([a-z]+)\s+"(.*)"$/i) || t.match(/^([a-z]+)\s+'(.*)'$/i);
  const raw = t.match(/^(testid|css|xpath)\s+(.+)$/i);
  if (raw) {
    const [, kind, v] = raw;
    if (kind.toLowerCase() === "testid") return page.getByTestId(v.replace(/^["']|["']$/g, ""));
    if (kind.toLowerCase() === "xpath") return page.locator(`xpath=${v}`);
    return page.locator(v);
  }
  if (quoted) {
    const kind = quoted[1].toLowerCase(), name = quoted[2];
    if (kind === "field" || kind === "input") {
      return page.getByLabel(name).or(page.getByPlaceholder(name)).or(page.getByRole("textbox", { name })).or(page.getByRole("combobox", { name }));
    }
    if (kind === "label") return page.getByLabel(name);
    if (kind === "placeholder") return page.getByPlaceholder(name);
    if (kind === "text") return page.getByText(name);
    if (kind === "alt") return page.getByAltText(name);
    if (kind === "title") return page.getByTitle(name);
    if (ROLES.includes(kind)) return page.getByRole(kind, { name });
    throw badRequest(`“${kind}” isn't a kind of thing on a page. Use button, link, field, text, checkbox, heading, tab, testid or css.`);
  }
  const name = t.replace(/^["']|["']$/g, "");
  return page.getByRole("button", { name }).or(page.getByRole("link", { name })).or(page.getByLabel(name))
    .or(page.getByPlaceholder(name)).or(page.getByText(name, { exact: true }));
};

// ---------- values ----------
const SECRET_REF = /\{\{\s*secret\.([\w]+)\s*\}\}/g;
const fillValue = (text, ctx) => String(text ?? "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (all, name) => {
  if (name.startsWith("secret.")) {
    const key = `QA_SECRET_${name.slice(7).toUpperCase()}`;
    if (process.env[key] == null) throw badRequest(`{{${name}}} isn't set. Add ${key} to the platform's .env.`);
    if (process.env[key].length >= 3) ctx.secrets?.add(process.env[key]);
    return process.env[key];
  }
  if (name === "now") return ctx.started;
  if (name === "random") return ctx.random;
  // Sinque: the dashboard QA login from Settings → Sinque app.
  if (name === "sinque.dashboard_email" || name === "sinque.dashboard_password") {
    if (ctx.project?.pack !== "sinque") throw badRequest(`{{${name}}} only works in the Sinque project.`);
    const a = config.dashboardAdmin;
    if (!a) throw badRequest("Add the dashboard QA email and password under Settings → Sinque app first.");
    if (name.endsWith("password")) { ctx.secrets?.add(a.password); return a.password; }
    return a.email;
  }
  if (name === "env.base_url") return ctx.env.base_url;
  if (name === "env.app_url") return ctx.appUrl;
  if (name in ctx.values) return ctx.values[name];
  throw badRequest(`{{${name}}} has no value. Use {{secret.NAME}}, {{random}}, {{now}} or a value an API check saved.`);
});
/** How a value is shown in results: secrets never. */
const shownValue = v => String(v ?? "").replace(SECRET_REF, "•••").replace(/\{\{\s*sinque\.dashboard_password\s*\}\}/g, "•••");
/** Removes secret values that were typed during the run from anything stored (addresses, errors). */
const scrub = (text, ctx) => {
  let t = String(text ?? "");
  for (const v of ctx.secrets) { t = t.split(v).join("•••"); t = t.split(encodeURIComponent(v)).join("•••"); }
  return t.replace(/([?&](?:password|passwd|pwd|pw|token|access_token|key|apikey|secret)=)[^&#]*/gi, "$1•••");
};

// ---------- page structure for the AI ----------
const DATA_ROLES = /^(row|cell|gridcell|rowheader|columnheader|listitem|table|grid|rowgroup|list|article|feed|treeitem|option)\b/;
const KEEP_IN_DATA = /^(button|checkbox|radio|switch|textbox|combobox|searchbox|menuitem|tab|columnheader)\b/;
export const safeSnapshot = (text, max = 14000) => {
  const out = [];
  const dataDepth = [];
  for (let line of String(text || "").split("\n")) {
    const indent = line.match(/^\s*/)[0].length;
    while (dataDepth.length && indent <= dataDepth[dataDepth.length - 1]) dataDepth.pop();
    const body = line.trim().replace(/^- /, "");
    if (/^\/url:/.test(body)) continue;
    const inData = dataDepth.length > 0;
    if (DATA_ROLES.test(body)) dataDepth.push(indent);
    if (inData && !KEEP_IN_DATA.test(body)) {
      // keep the role, drop what it says
      line = line.replace(/^(\s*- [\w-]+)(?:\s+"[^"]*")?(.*?)(:\s.*)?$/, (all, role, attrs, content) => `${role}${attrs.replace(/"[^"]*"/g, "")}${content ? ": …" : ""}`);
    }
    line = line
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
      .replace(/\+?\d[\d\s().-]{7,}\d/g, "[number]");
    if (line.length > 200) line = `${line.slice(0, 200)}…`;
    out.push(line);
  }
  // collapse runs of identical redacted lines (long tables)
  const squashed = [];
  let repeat = 0;
  for (const l of out) {
    if (squashed.length && squashed[squashed.length - 1] === l) { repeat++; continue; }
    if (repeat) { squashed.push(`${" ".repeat(squashed[squashed.length - 1].match(/^\s*/)[0].length)}  (… ${repeat} more like this)`); repeat = 0; }
    squashed.push(l);
  }
  const textOut = squashed.join("\n");
  return textOut.length > max ? `${textOut.slice(0, max)}\n… (page structure cut short)` : textOut;
};

// ---------- browser ----------
let browserPromise = null;
const browser = async () => {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true }).catch(e => {
      browserPromise = null;
      throw new Error(/Executable doesn't exist|browserType.launch/.test(e.message)
        ? "The browser for UI tests isn't installed on the platform's machine. Run: npx playwright install chromium"
        : e.message);
    });
    browserPromise.then(b => b.on("disconnected", () => { browserPromise = null; })).catch(() => {});
  }
  return browserPromise;
};

const appUrlFor = env => (env.app_url || env.base_url || "").replace(/\/+$/, "");
const absolute = (appUrl, v) => (/^https?:\/\//i.test(v) ? v : `${appUrl}${v.startsWith("/") ? "" : "/"}${v}`);
const usableEnv = (project, envId) => {
  // UI tests only need the app's address, not an API address.
  const env = project.environments.find(x => x.id === envId) || project.environments[0];
  if (!env) throw badRequest(`${project.name} has no environments yet. Add one under Settings → ${project.name}.`);
  if (env.production) throw badRequest(`${env.name} is production: UI tests click and type, so they only run on test environments.`);
  const appUrl = appUrlFor(env);
  if (!appUrl) throw badRequest(`${env.name} has no address. Add the app's address under Settings → ${project.name} → Environments.`);
  return { env, appUrl };
};

const friendly = (e, step) => {
  const m = String(e?.message || e);
  if (/Timeout \d+ms exceeded|TimeoutError/.test(m) || e?.name === "TimeoutError") {
    if (step.action.startsWith("expect_")) return null; // expectations write their own message
    return `Couldn't find ${step.target || "it"} on the page within ${STEP_TIMEOUT / 1000} s.`;
  }
  if (/strict mode violation/.test(m)) return `${step.target} matches more than one thing on the page. Be more specific, e.g. add the button's exact text.`;
  if (/net::ERR_NAME_NOT_RESOLVED|ENOTFOUND/.test(m)) return "The app's address can't be found. Check the environment's address.";
  if (/net::ERR_CONNECTION_REFUSED|ECONNREFUSED/.test(m)) return "The app didn't answer at that address.";
  if (/not an <input>|Element is not an <input>|not a <select>/.test(m)) return `${step.target} isn't a field you can type into or choose from.`;
  return m.split("\n")[0].replace(/^locator\.\w+: /, "").slice(0, 300);
};

const poll = async (fn, timeout = STEP_TIMEOUT) => {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) { last = await fn(); if (last.ok) return last; await new Promise(r => setTimeout(r, 250)); }
  return last;
};

const doStep = async (page, step, ctx) => {
  const value = ["fill", "select", "press", "open", "wait"].includes(step.action) || step.action.startsWith("expect_") ? fillValue(step.value, ctx) : step.value;
  const loc = () => locate(page, step.target).first();
  const settle = () => page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
  switch (step.action) {
    case "open":
      await page.goto(absolute(ctx.appUrl, value || "/"), { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      return;
    case "click": await loc().click(); await settle(); return;
    case "fill": await loc().fill(value); return;
    case "select": await loc().selectOption({ label: value }).catch(() => loc().selectOption(value)); return;
    case "check": await loc().check(); return;
    case "uncheck": await loc().uncheck(); return;
    case "press": if (step.target) await loc().press(value); else await page.keyboard.press(value); await settle(); return;
    case "hover": await loc().hover(); return;
    case "wait":
      if (step.target) { await loc().waitFor({ state: "visible", timeout: 30000 }); return; }
      await page.waitForTimeout(Math.min(30000, Number(value) || 1000));
      return;
    case "expect_text": {
      const ok = await page.getByText(value).first().waitFor({ state: "visible" }).then(() => true, () => false);
      if (!ok) throw new Error(`Expected to see “${shownValue(step.value)}” on the page, but it isn't there.`);
      return;
    }
    case "expect_no_text": {
      const ok = await page.getByText(value).first().waitFor({ state: "hidden" }).then(() => true, () => false);
      if (!ok) throw new Error(`“${shownValue(step.value)}” is still on the page.`);
      return;
    }
    case "expect_visible": {
      const ok = await loc().waitFor({ state: "visible" }).then(() => true, () => false);
      if (!ok) throw new Error(`Expected ${step.target} to be on the page, but it isn't.`);
      return;
    }
    case "expect_hidden": {
      const ok = await loc().waitFor({ state: "hidden" }).then(() => true, () => false);
      if (!ok) throw new Error(`${step.target} is still on the page.`);
      return;
    }
    case "expect_url": {
      const r = await poll(async () => ({ ok: page.url().includes(value), got: page.url() }));
      if (!r.ok) throw new Error(`Expected the address to contain “${value}”, but it's ${r.got}.`);
      return;
    }
    case "expect_title": {
      const r = await poll(async () => { const t = await page.title(); return { ok: t.toLowerCase().includes(value.toLowerCase()), got: t }; });
      if (!r.ok) throw new Error(`Expected the page title to contain “${value}”, but it's “${r.got}”.`);
      return;
    }
    case "expect_value": {
      const r = await poll(async () => { const v = await loc().inputValue({ timeout: 2000 }).catch(() => null); return { ok: v === value, got: v }; });
      if (!r.ok) throw new Error(r.got === null ? `Couldn't find ${step.target} to read its value.` : `Expected ${step.target} to hold “${shownValue(step.value)}”, but it holds “${r.got}”.`);
      return;
    }
    default: throw badRequest(`Unknown step “${step.action}”.`);
  }
};

const ariaOf = async page => {
  try { return safeSnapshot(await page.locator("body").ariaSnapshot({ timeout: 5000 })); } catch { return ""; }
};

/** Runs a test case's steps. onStep(i, total, label) reports progress. */
export const runUiCase = async (project, testCase, envId, actor, { onStep = () => {}, testRunId = null } = {}) => {
  const steps = testCase.automation?.steps || [];
  if (!steps.length) throw badRequest(`${testCase.id} isn't automated yet. Open it and add steps, or let the AI write them.`);
  const { env, appUrl } = usableEnv(project, envId);
  const id = newId("ui");
  const dir = runDir(project, id);
  fs.mkdirSync(dir, { recursive: true });
  const started = Date.now();
  const ctx = { env, appUrl, started: new Date().toISOString(), random: Math.random().toString(36).slice(2, 8), values: readValues(project, env.id), secrets: new Set(), project };
  const b = await browser();
  const context = await b.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir, size: { width: 1280, height: 800 } }, locale: "en-GB" });
  const page = await context.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT);
  const consoleErrors = [];
  page.on("console", m => { if (m.type() === "error" && consoleErrors.length < 20) consoleErrors.push(m.text().slice(0, 300)); });
  page.on("pageerror", e => { if (consoleErrors.length < 20) consoleErrors.push(String(e.message).slice(0, 300)); });
  const results = [];
  let failedAt = -1, error = null;
  try {
    // A case that doesn't open a page itself starts on the app's home page.
    if (steps[0].action !== "open") await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    for (const [i, step] of steps.entries()) {
      onStep(i, steps.length, `${ACTIONS[step.action].label} ${step.target || shownValue(step.value)}`.trim());
      const t0 = Date.now();
      let stepError = null;
      try { await doStep(page, step, ctx); } catch (e) { stepError = friendly(e, step) || e.message; }
      const shot = `${String(i + 1).padStart(2, "0")}.jpg`;
      await page.screenshot({ path: path.join(dir, shot), type: "jpeg", quality: 55, timeout: 10000 }).catch(() => {});
      results.push({ n: i + 1, action: step.action, target: step.target, value: shownValue(step.value), note: step.note, ok: !stepError, ms: Date.now() - t0, error: stepError && scrub(stepError, ctx), shot: fs.existsSync(path.join(dir, shot)) ? shot : null, url: scrub(page.url(), ctx) });
      if (stepError) {
        failedAt = i; error = scrub(`Step ${i + 1}: ${stepError}`, ctx);
        fs.writeFileSync(path.join(dir, "page.txt"), scrub(await ariaOf(page), ctx));
        break;
      }
    }
  } catch (e) {
    error = scrub(friendly(e, { action: "open", target: appUrl }) || e.message, ctx);
  }
  const video = page.video();
  await context.close().catch(() => {});
  let videoFile = null;
  try {
    const vp = await video?.path();
    if (vp && fs.existsSync(vp)) {
      if (error) { fs.renameSync(vp, path.join(dir, "video.webm")); videoFile = "video.webm"; }
      else fs.rmSync(vp, { force: true });
    }
  } catch { /* no video */ }
  for (let i = results.length; i < steps.length; i++) results.push({ n: i + 1, action: steps[i].action, target: steps[i].target, value: shownValue(steps[i].value), note: steps[i].note, ok: null, skipped: true });
  const run = {
    id, case_id: testCase.id, case_title: testCase.title, environment: env.name, env_id: env.id, app_url: appUrl,
    pass: !error, error, failed_step: failedAt >= 0 ? failedAt + 1 : null, steps: results, video: videoFile,
    console_errors: consoleErrors.map(m => scrub(m, ctx)), ms: Date.now() - started, at: now(), by: actor, test_run_id: testRunId,
  };
  updateJson(runsFile(project), [], all => {
    all.push(run);
    const drop = all.splice(0, Math.max(0, all.length - KEEP_RUNS));
    for (const r of drop) fs.rmSync(runDir(project, r.id), { recursive: true, force: true });
  });
  return run;
};

export const listUiRuns = (project, caseId) => readJson(runsFile(project), []).filter(r => !caseId || r.case_id === caseId).slice(-30).reverse();
export const getUiRun = (project, id) => {
  const r = readJson(runsFile(project), []).find(x => x.id === id);
  if (!r) throw Object.assign(new Error("UI run not found."), { status: 404 });
  return r;
};
const TYPES = { jpg: "image/jpeg", webm: "video/webm", txt: "text/plain; charset=utf-8" };
export const uiRunFile = (project, id, name) => {
  if (!/^[\w]+$/.test(id) || !/^[\w.-]+\.(jpg|webm)$/.test(name)) throw badRequest("Bad file name.");
  const p = path.join(runDir(project, id), name);
  if (!fs.existsSync(p)) throw Object.assign(new Error("File not found."), { status: 404 });
  return { path: p, type: TYPES[path.extname(name).slice(1)] };
};

// ---------- AI ----------
const secretNames = project => [
  ...Object.keys(process.env).filter(k => k.startsWith("QA_SECRET_")).map(k => `{{secret.${k.slice(10)}}}`),
  ...(project?.pack === "sinque" && config.dashboardAdmin ? ["{{sinque.dashboard_email}} (the dashboard QA login's email)", "{{sinque.dashboard_password}} (its password)"] : []),
];
const VOCAB = `Step types (action → what it needs):
- open: value = a path like "/login" (or a full address on the same app)
- click / check / uncheck / hover: target
- fill: target + value (text to type)
- select: target + value (the option's visible text)
- press: value = a key like "Enter" or "Tab" (target optional)
- wait: value = milliseconds, or target = wait until it shows
- expect_text / expect_no_text: value = text on the page
- expect_visible / expect_hidden: target
- expect_url / expect_title: value = part of the address / title
- expect_value: target + value (a field's current value)
Targets name things the way a person sees them, using the page structure's roles and names:
  button "Sign in", link "Forgot password?", field "Email" (a text box by its label or placeholder),
  checkbox "Remember me", heading "Dashboard", tab "Reports", text "Welcome", testid login-button, css .some-class (last resort).
Values: {{secret.NAME}} for passwords and other secrets (never write a real password), {{random}} for something unique (e.g. "qa-{{random}}@example.com"), {{now}} for the current time.`;

const shapeAnswer = a => ({
  steps: cleanSteps((a.steps || []).map(s => ({ action: s.action, target: s.target, value: s.value, note: s.note }))),
  questions: (Array.isArray(a.questions) ? a.questions : []).map(String).slice(0, 8),
  explanation: String(a.explanation || "").slice(0, 1000),
});

/** Opens the start page and asks the AI to turn the test case into steps. */
export const writeSteps = async (project, testCase, envId, startPath, actor, progress = () => {}) => {
  const { env, appUrl } = usableEnv(project, envId);
  progress(0, 3, `Opening ${appUrl}${startPath || "/"}`);
  const b = await browser();
  const context = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  let snapshot = "", title = "", url = "";
  try {
    await page.goto(absolute(appUrl, startPath || "/"), { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
    snapshot = await ariaOf(page); title = await page.title(); url = page.url();
  } catch (e) {
    throw badRequest(`Couldn't open ${appUrl}${startPath || "/"}: ${friendly(e, { action: "open" })}`);
  } finally { await context.close().catch(() => {}); }
  progress(1, 3, "The AI is writing the steps");
  const answer = await askJson({
    actor,
    system: `You turn a manual test case into steps for a browser test runner. ${VOCAB}
Rules:
- Start with an open step for the start page's path.
- Use targets whose names appear in the page structure when possible; for later pages you can't see, use the names the test case mentions.
- Fields: prefer field "<label>".
- End with expect_* steps that check the test case's expected result.
- Never copy personal data from the page. Never invent passwords: use {{secret.NAME}} from the available list, or {{secret.TEST_PASSWORD}} and say so in questions.
- If something is unclear (which account, which data), still write your best steps and list the questions.
Answer as JSON: {"steps":[{"action":"","target":"","value":"","note":""}],"questions":[""],"explanation":""}`,
    input: {
      test_case: { title: testCase.title, preconditions: testCase.preconditions, steps: testCase.steps, expected: testCase.expected },
      app: { address: appUrl, environment: env.name },
      start_page: { address: url, title, structure: snapshot },
      available_secrets: secretNames(project),
    },
  });
  progress(3, 3, "Done");
  return { ...shapeAnswer(answer), start_path: startPath || "/" };
};

/** After a failed run: the AI suggests corrected steps from the page as it was when the step failed. */
export const repairSteps = async (project, testCase, runId, actor) => {
  const run = getUiRun(project, runId);
  if (run.pass) throw badRequest("That run passed: nothing to fix.");
  const steps = testCase.automation?.steps || [];
  let snapshot = "";
  try { snapshot = fs.readFileSync(path.join(runDir(project, runId), "page.txt"), "utf8"); } catch { /* none */ }
  const failed = run.steps.find(s => s.ok === false);
  const answer = await askJson({
    actor,
    system: `A browser test failed. Suggest corrected steps. ${VOCAB}
Rules:
- Keep steps that worked unless they caused the failure. Fix the failing step (and later ones if needed) using the names in the page structure at the moment it failed.
- If the app itself looks broken (an error message, a real bug), don't hide it: keep the step and say so in the explanation.
- Never copy personal data from the page.
Answer as JSON: {"steps":[...full corrected list...],"explanation":"what you changed and why","questions":[]}`,
    input: {
      test_case: { title: testCase.title, steps: testCase.steps, expected: testCase.expected },
      current_steps: steps,
      failed_step: { number: run.failed_step, error: failed?.error, address: failed?.url },
      page_at_failure: snapshot || "(not available)",
      available_secrets: secretNames(project),
    },
  });
  const fixed = shapeAnswer(answer);
  const changed = fixed.steps.map((s, i) => (JSON.stringify(s) !== JSON.stringify(steps[i] ? { ...steps[i], note: s.note } : null) ? i : -1)).filter(i => i >= 0);
  return { ...fixed, changed };
};
