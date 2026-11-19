// The QA platform's AI features. Numbers and comparisons are done in code (rules.js);
// the AI explains, summarises, drafts, and turns plain language into settings.
import { TEST_EMAIL_DOMAIN, isTestEmail } from "../config.js";
import { badRequest, query } from "../db.js";
import { PRESETS } from "../scenarios.js";
import { lastCompletedWeekStart } from "../rules.js";
import { buildCase } from "./casefile.js";
import { askJson } from "./llm.js";

export const REPORT_RULES = `
SINQUE WEEKLY BODY-COMPOSITION REPORT — RULES
- Weeks run Monday 00:00 to next Monday 00:00 UTC; Sunday readings count. The report always describes LAST completed week ("report week"), never the current unfinished week.
- Measurements last week = number of readings in the report week (not days). Readings with collection_method 3 (system-entered) are ignored.
- Adherence looks at DISTINCT DAYS measured in the report week and the 2 weeks before it (3 weeks), checked in this order:
  1. No reading in the 3 months before the end of the report week → "Needs reactivation" (label "Reactivate").
  2. Account 3 weeks old or less → "Onboarding".
  3. 0 days in total → "No Activity" (label "Inactive").
  4. Fewer than 6 days in total, or 2+ weeks with 0 days → "Low Adherence" (label "Low").
  5. 3+ days in each of the 3 weeks → "High Adherence" (label "High").
  6. At least one week with 3+ days (one empty week allowed) → "Adequate".
- Trend confidence follows adherence: High/Adequate → "Strong", Low → "Limited", Onboarding → "Building", Inactive/Reactivate → "Unavailable". It is hidden when there were fewer than 2 measurements last week.
- Most reliable weekly weight (AW2F): average each day's readings; average those into a week average; days at/above the week average get weight = number of such days, days below get weight = number of days below; weighted mean, 2 decimals.
- Weight change speed (kg/week): the report week's AW2F (or the week before if the report week is empty) minus the AW2F of the nearest week at least 2 weeks earlier that has data (looking back at most 4 weeks from the report week), divided by the number of weeks between them. No such pair → no speed.
- Pace compares the speed with the "adequate" weekly loss band for the user's gender and age group (under 40 / 40-59 / over 60; unknown birth date counts as over 60):
  female: under 40 -0.60..-0.41, 40-59 -0.55..-0.31, over 60 -0.45..-0.31; male: under 40 -0.75..-0.51, 40-59 -0.60..-0.41, over 60 -0.50..-0.31.
  Inside the band → "Adequate" (label "Balanced"); faster loss (more negative) → "Fast" (label "Imbalanced"); slower, flat or gaining → "Slow" (label "Steady"); no speed → "Unavailable".
- Arrow: speed below -0.1 → down, above +0.1 → up, otherwise none.
- Muscle change on the muscle card must equal the skeletal-muscle change in the "progress since baseline" table.
- Baseline = the user's first 14 days of measurements. Body-composition values only come from white-scale (BIA) readings.
- Known separate issue: Muscle Engine Score comes from a database view (vw_qls_weekly) and can exceed 100%.
`.trim();

const STYLE = "Write plain, friendly English for QA testers. Short sentences. No jargon, no code, no SQL. Use the user reference (e.g. #12827), never a name.";

// ---------- 1. Explain a report ----------
export const explainReport = async (userId, actor) => {
  const c = await buildCase(userId);
  if (!c.report) throw badRequest(`Can't explain: ${c.apiError}`);
  const answer = await askJson({
    actor,
    system: `You are a QA analyst for the Sinque app. Explain why a user's weekly report shows what it shows, using ONLY the data given and these rules.
${REPORT_RULES}
The input has "expected_by_rules" (computed by an independent implementation of the rules), "shown_by_api" (what the app shows) and "checks" (field-by-field comparison). Trust the computed numbers; do not redo arithmetic differently.
${STYLE}
Answer as JSON: {"verdict":"looks correct"|"possible bug"|"bug","headline":string,"sections":[{"field":string,"shown":string,"verdict":"ok"|"bug"|"check","explanation":string}],"next_steps":[string]}.
Cover: measurements last week, adherence, trend confidence, weight change pace (with the speed and the band), weekly weight, and anything in "checks" that failed. In each explanation, point to the specific weeks/days/readings that decide the result.`,
    input: c.anonymous,
  });
  return { ...answer, checks: c.checks, expected: c.expected };
};

// ---------- 2. Bug spotting across users (rule checks in code, AI summary optional) ----------
const pool = async (items, limit, fn) => {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }));
  return out;
};

export const scanUsers = async ({ scope = "test", groupId, subgroupId, limit = 60 }, progress = () => {}) => {
  const max = Math.max(1, Math.min(150, Number(limit) || 60));
  const where = ["u.role = 1", "u.deleted_at IS NULL"];
  const params = [];
  if (scope === "group") {
    if (!groupId) throw badRequest("Pick a group to scan.");
    where.push("EXISTS (SELECT 1 FROM usergroups ug WHERE ug.user_id = u.id AND ug.group_id = ?" + (subgroupId ? " AND ug.subgroup_id = ?" : "") + ")");
    params.push(Number(groupId));
    if (subgroupId) params.push(Number(subgroupId));
  } else {
    where.push("u.email LIKE ?");
    params.push(`%${TEST_EMAIL_DOMAIN}`);
  }
  const users = await query(
    `SELECT u.id, u.sinque_id, u.firstname, u.lastname, u.email FROM users u WHERE ${where.join(" AND ")}
     ORDER BY u.created_at DESC LIMIT ${max}`,
    params
  );
  let checked = 0;
  progress(0, users.length, `Checking ${users.length} users`);
  const rows = await pool(users, 4, async u => {
    try {
      const c = await buildCase(u.id);
      const failed = c.checks.filter(x => !x.ok);
      return {
        id: u.id, sinque_id: u.sinque_id, name: `${u.firstname} ${u.lastname}`, email: u.email, is_test_user: isTestEmail(u.email),
        status: c.apiError ? "error" : failed.length ? "mismatch" : "ok",
        api_error: c.apiError, failed, checked: c.checks.length,
        adherence: c.report?.adherence?.new_name ?? null, pace: c.report?.weight_change_pace ?? null,
      };
    } catch (error) {
      return { id: u.id, sinque_id: u.sinque_id, name: `${u.firstname} ${u.lastname}`, email: u.email, status: "error", api_error: error.message, failed: [], checked: 0 };
    } finally {
      progress(++checked, users.length, `Checked ${checked} of ${users.length} users`);
    }
  });
  return {
    report_week_start: lastCompletedWeekStart().toISOString().slice(0, 10),
    scanned: rows.length,
    mismatches: rows.filter(r => r.status === "mismatch").length,
    errors: rows.filter(r => r.status === "error").length,
    rows,
  };
};

export const summarizeScan = async (scan, actor) => {
  const flagged = (scan.rows || []).filter(r => r.status !== "ok").slice(0, 60)
    .map(r => ({ ref: `#${r.sinque_id}`, status: r.status, api_error: r.api_error, failed: r.failed }));
  if (!flagged.length) return { headline: "No mismatches found.", patterns: [], next_steps: [] };
  return askJson({
    actor,
    system: `You are a QA lead. Below are users whose weekly report (from the dev API) disagrees with an independent implementation of the report rules.
${REPORT_RULES}
Group the problems into patterns (same field, same direction), estimate how many users each affects, and say what most likely causes each pattern.
${STYLE}
Answer as JSON: {"headline":string,"patterns":[{"title":string,"users":[string],"likely_cause":string,"severity":"high"|"medium"|"low"}],"next_steps":[string]}.`,
    input: { report_week_start: scan.report_week_start, scanned: scan.scanned, flagged },
  });
};

// ---------- 3. Scenario from a description ----------
const SPEC_HELP = `Scenario settings JSON:
{"label":string (short title),"gender":"Female"|"Male","age":number,"heightCm":number,"startWeightKg":number (weight at the OLDEST week),
"kgPerWeek":number (negative = losing; typical -1.2..+0.5),"noiseKg":number (0.1-0.5),
"daysPerWeek":number[] (measurement days per week, 0-7; index 0 = THIS unfinished week, 1 = last week = the report week, 2 = two weeks ago, ...; 6-20 entries),
"measurementsPerDay":1-3,"dayPattern":"spread"|"weekdays"|"sunday","whiteScale":boolean (BIA/body composition),
"accountAgeWeeks":number (must be >= daysPerWeek length unless the user is new),"language":"EN"|"NL"|"POR"}`;

const clampSpec = (raw, base) => {
  const s = { ...base, ...raw };
  const n = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
  return {
    label: String(s.label || "AI scenario").slice(0, 60),
    gender: s.gender === "Male" ? "Male" : "Female",
    age: Math.round(n(s.age, 18, 95, 45)),
    heightCm: Math.round(n(s.heightCm, 140, 210, 168)),
    startWeightKg: n(s.startWeightKg, 35, 250, 80),
    kgPerWeek: n(s.kgPerWeek, -3, 2, -0.4),
    noiseKg: n(s.noiseKg, 0, 1.5, 0.3),
    daysPerWeek: (Array.isArray(s.daysPerWeek) && s.daysPerWeek.length ? s.daysPerWeek : base.daysPerWeek).slice(0, 52).map(d => Math.round(n(d, 0, 7, 0))),
    measurementsPerDay: Math.round(n(s.measurementsPerDay, 1, 3, 1)),
    dayPattern: ["spread", "weekdays", "sunday"].includes(s.dayPattern) ? s.dayPattern : "spread",
    whiteScale: s.whiteScale !== false,
    accountAgeWeeks: Math.round(n(s.accountAgeWeeks, 0, 520, 10)),
    language: ["EN", "NL", "POR"].includes(s.language) ? s.language : "EN",
  };
};

export const scenarioFromText = async (text, actor) => {
  if (!String(text || "").trim()) throw badRequest("Describe the user you want.");
  const answer = await askJson({
    actor,
    system: `You turn a QA tester's description of a test user into scenario settings for the eFutures QA platform.
${SPEC_HELP}
${REPORT_RULES}
Choose values that make the report show what the tester describes. Remember index 1 of daysPerWeek is the report week.
Answer as JSON: {"spec":<scenario settings>,"expected_report":string (one line: what the report should show),"assumptions":[string]}.`,
    input: String(text).slice(0, 4000),
  });
  return { spec: clampSpec(answer.spec || {}, PRESETS[0].spec), expected_report: answer.expected_report || "", assumptions: answer.assumptions || [] };
};

// ---------- 4. Test plan from a code change ----------
export const testPlan = async (text, actor) => {
  const change = String(text || "").trim();
  if (change.length < 20) throw badRequest("Paste a commit, pull request description or diff.");
  const answer = await askJson({
    actor,
    system: `You are a QA lead for the Sinque app. From a code change (commit message, PR description or diff), write a focused test plan for the weekly body-composition report and related screens.
${REPORT_RULES}
${SPEC_HELP}
Each scenario must be something the QA platform can create, with settings, and say exactly what the report should show.
Existing presets (reuse their ideas when they fit): ${PRESETS.map(p => `${p.key}: ${p.expect}`).join("; ")}.
${STYLE}
Answer as JSON: {"summary":string,"risks":[string],"scenarios":[{"title":string,"why":string,"spec":<scenario settings>,"expect":string}],"manual_checks":[string]}.
Give 3 to 8 scenarios, most important first.`,
    input: change.slice(0, 60000),
  });
  return {
    summary: answer.summary || "",
    risks: answer.risks || [],
    manual_checks: answer.manual_checks || [],
    scenarios: (answer.scenarios || []).slice(0, 10).map(s => ({ title: s.title, why: s.why, expect: s.expect, spec: clampSpec({ ...(s.spec || {}), label: s.title }, PRESETS[0].spec) })),
  };
};

// ---------- 5. Client reply draft ----------
export const clientReply = async ({ userId, complaint, language = "English", tone = "professional and warm" }, actor) => {
  if (!String(complaint || "").trim()) throw badRequest("Paste the client's message.");
  const c = await buildCase(userId);
  const answer = await askJson({
    actor,
    system: `You draft a reply to a client (a clinic or coach using Sinque) who questioned a user's weekly report. Use ONLY the data and rules given. Be honest: if the data shows a bug, say so plainly; if the report is correct, explain why kindly.
${REPORT_RULES}
Refer to the user only as {{USER_NAME}} (the tool fills in the real name). Don't invent fixes or dates; if something is a bug, say the team is fixing it. Write in ${language}, ${tone}. No internal jargon (no AW2F, no table names).
Answer as JSON: {"subject":string,"body":string (plain text with short paragraphs and bullet lines starting with "- "),"findings":[{"item":string,"status":"correct"|"bug"|"unclear","note":string}]}.`,
    input: { client_message: String(complaint).slice(0, 8000), case: c.anonymous },
  });
  const name = `${c.user.firstname} ${c.user.lastname}`.trim();
  const fill = s => String(s || "").replaceAll("{{USER_NAME}}", name);
  return { subject: fill(answer.subject), body: fill(answer.body), findings: answer.findings || [], checks: c.checks };
};

// ---------- 6. Plain-language search ----------
const SEARCH_FIELDS = `Filter JSON (all optional):
{"text":string (name/email/Sinque ID contains),"test_users_only":boolean,"group_name":string (contains),"subgroup_name":string (contains),
"gender":"Female"|"Male","age_min":number,"age_max":number,
"measurements_last_week_min":number,"measurements_last_week_max":number,
"adherence":["High Adherence"|"Adequate"|"Low Adherence"|"No Activity"|"Onboarding"|"Needs reactivation"],
"pace":["Fast"|"Adequate"|"Slow"|"none"],"speed_min":number,"speed_max":number (kg/week, negative = losing),
"last_measured_within_days":number,"not_measured_for_days":number,"has_white_scale_data":boolean,
"sort":"newest"|"oldest"|"most_measurements"|"fastest_loss"}
Adherence/pace/speed/measurements-last-week come from last week's saved weekly report.`;

export const aiSearch = async (text, actor) => {
  if (!String(text || "").trim()) throw badRequest("Type what you're looking for.");
  const { filter = {}, understood = "" } = await askJson({
    actor,
    system: `Turn a QA tester's search into a filter for the eFutures QA platform. Use only the fields listed; leave out anything not asked for.
${SEARCH_FIELDS}
Labels: "High"=High Adherence, "Low"=Low Adherence, "Inactive"=No Activity, "Reactivate"=Needs reactivation, "Imbalanced"=Fast, "Balanced"=Adequate, "Steady"=Slow, "Unavailable"=none.
Answer as JSON: {"filter":<filter>,"understood":string (one sentence: what you searched for)}.`,
    input: String(text).slice(0, 1000),
  });
  return { understood, filter, users: await runSearch(filter) };
};

const ADHERENCE_VALUES = ["High Adherence", "Adequate", "Low Adherence", "No Activity", "Onboarding", "Needs reactivation"];

/** Fixed, parameterised query built from the whitelisted filter. The AI never writes SQL. */
const runSearch = async f => {
  const week = lastCompletedWeekStart().toISOString().slice(0, 10);
  const where = ["u.role = 1", "u.deleted_at IS NULL"];
  const params = [week];
  const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);

  if (f.text) { where.push("(u.email LIKE ? OR CONCAT(u.firstname,' ',u.lastname) LIKE ? OR CAST(u.sinque_id AS CHAR) = ?)"); params.push(`%${f.text}%`, `%${f.text}%`, String(f.text)); }
  if (f.test_users_only) { where.push("u.email LIKE ?"); params.push(`%${TEST_EMAIL_DOMAIN}`); }
  if (f.group_name) { where.push("EXISTS (SELECT 1 FROM usergroups ug JOIN `groups` g ON g.id = ug.group_id WHERE ug.user_id = u.id AND g.name LIKE ?)"); params.push(`%${f.group_name}%`); }
  if (f.subgroup_name) { where.push("EXISTS (SELECT 1 FROM usergroups ug JOIN subgroups sg ON sg.id = ug.subgroup_id WHERE ug.user_id = u.id AND sg.name LIKE ?)"); params.push(`%${f.subgroup_name}%`); }
  if (f.gender === "Female" || f.gender === "Male") { where.push("u.gender = ?"); params.push(f.gender); }
  if (num(f.age_min) != null) { where.push("TIMESTAMPDIFF(YEAR, u.date_of_birth, CURDATE()) >= ?"); params.push(num(f.age_min)); }
  if (num(f.age_max) != null) { where.push("TIMESTAMPDIFF(YEAR, u.date_of_birth, CURDATE()) <= ?"); params.push(num(f.age_max)); }
  if (num(f.measurements_last_week_min) != null) { where.push("COALESCE(wr.measurements_count, 0) >= ?"); params.push(num(f.measurements_last_week_min)); }
  if (num(f.measurements_last_week_max) != null) { where.push("COALESCE(wr.measurements_count, 0) <= ?"); params.push(num(f.measurements_last_week_max)); }
  const adherence = (Array.isArray(f.adherence) ? f.adherence : []).filter(a => ADHERENCE_VALUES.includes(a));
  if (adherence.length) { where.push("wr.adherence_category IN (?)"); params.push(adherence); }
  const pace = Array.isArray(f.pace) ? f.pace : [];
  const paceVals = pace.filter(p => ["Fast", "Adequate", "Slow"].includes(p));
  if (pace.length) {
    where.push(`(${[paceVals.length ? "wr.weight_loss_rate IN (?)" : null, pace.includes("none") ? "(wr.id IS NOT NULL AND wr.weight_loss_rate IS NULL)" : null].filter(Boolean).join(" OR ") || "1=0"})`);
    if (paceVals.length) params.push(paceVals);
  }
  if (num(f.speed_min) != null) { where.push("wr.weight_change_speed >= ?"); params.push(num(f.speed_min)); }
  if (num(f.speed_max) != null) { where.push("wr.weight_change_speed <= ?"); params.push(num(f.speed_max)); }
  // Conditions on the last reading go in HAVING, against the per-user subquery below.
  const having = [];
  const havingParams = [];
  if (num(f.last_measured_within_days) != null) { having.push("last_measurement >= NOW() - INTERVAL ? DAY"); havingParams.push(num(f.last_measured_within_days)); }
  if (num(f.not_measured_for_days) != null) { having.push("(last_measurement IS NULL OR last_measurement < NOW() - INTERVAL ? DAY)"); havingParams.push(num(f.not_measured_for_days)); }
  if (f.has_white_scale_data === true) where.push("EXISTS (SELECT 1 FROM userweights b WHERE b.user_id = u.id AND b.has_bia_data = 1)");
  if (f.has_white_scale_data === false) where.push("NOT EXISTS (SELECT 1 FROM userweights b WHERE b.user_id = u.id AND b.has_bia_data = 1)");
  const order = { oldest: "u.created_at ASC", most_measurements: "measurement_count DESC", fastest_loss: "wr.weight_change_speed IS NULL, wr.weight_change_speed ASC" }[f.sort] || "u.created_at DESC";

  const rows = await query(
    `SELECT u.id, u.sinque_id, u.firstname, u.lastname, u.email, u.gender, u.created_at,
            (SELECT MAX(w.measurement_date) FROM userweights w WHERE w.user_id = u.id AND w.collection_method <> 3) AS last_measurement,
            (SELECT COUNT(*) FROM userweights w WHERE w.user_id = u.id AND w.collection_method <> 3) AS measurement_count,
            wr.measurements_count AS measurements_last_week, wr.adherence_category, wr.weight_loss_rate, wr.weight_change_speed
     FROM users u
     LEFT JOIN user_weekly_reports wr ON wr.user_id = u.id AND wr.week_start = ?
     WHERE ${where.join(" AND ")}
     ${having.length ? `HAVING ${having.join(" AND ")}` : ""}
     ORDER BY ${order}
     LIMIT 100`,
    [...params, ...havingParams]
  );
  return rows.map(r => ({ ...r, is_test_user: isTestEmail(r.email) }));
};

// ---------- 7. Test cases from a Jira ticket ----------
const redact = (text, names) => {
  let s = String(text || "")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/\+?\d[\d\s-]{8,}\d/g, "[phone]");
  for (const n of names) if (n && n.length > 2) s = s.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[name]");
  return s;
};

/**
 * Turns a ticket (and the data of the users it's linked to) into test cases. Names,
 * emails and phone numbers are removed before anything goes to the AI.
 */
export const ticketTestCases = async (ticket, actor) => {
  const names = ticket.users.flatMap(u => [`${u.firstname} ${u.lastname}`.trim(), u.firstname, u.lastname]).filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const cases = [];
  for (const u of ticket.users.slice(0, 3)) {
    try { cases.push((await buildCase(u.id)).anonymous); } catch { /* user without data */ }
  }
  const answer = await askJson({
    actor,
    system: `You are a senior QA engineer for Sinque, a weight-management app (mobile app for clients, web dashboard for coaches and clinics, weekly body-composition reports). From a Jira ticket, write the test cases a tester needs to verify the fix and guard against regressions.
${REPORT_RULES}
${SPEC_HELP}
Kinds: "scenario" = a test user the QA platform can create with scenario settings (only for weekly-report behaviour; include "spec"); "manual" = steps a tester follows in the app or dashboard; "edge" = a boundary or unusual case; "regression" = something nearby that must keep working.
If the ticket includes data of linked users, use it: the first test case should reproduce the reported problem as closely as possible.
Each test case: a clear title, preconditions, numbered steps (short, one action each), and an exact expected result (values or labels where the rules define them).
${STYLE}
Answer as JSON: {"summary":string (what the ticket is about, 1-2 sentences),"area":string,"likely_cause":string (your best guess, or "" if unclear),
"test_cases":[{"title":string,"kind":"scenario"|"manual"|"edge"|"regression","priority":"high"|"medium"|"low","preconditions":string,"steps":[string],"expected":string,"spec":<scenario settings>|null}],
"acceptance":[string] (acceptance criteria for closing the ticket),"questions":[string] (anything unclear to ask the ticket author)}.
Give 5 to 12 test cases, most important first.`,
    input: {
      ticket: {
        key: ticket.key, type: ticket.type, priority: ticket.priority, status: ticket.status,
        summary: redact(ticket.summary, names),
        description: redact(ticket.description, names).slice(0, 30000),
        comments: ticket.comments.map(c => redact(c.body, names).slice(0, 3000)),
      },
      linked_users: cases,
    },
  });
  const kinds = ["scenario", "manual", "edge", "regression"];
  return {
    ticket: ticket.key,
    generated_at: new Date().toISOString(),
    generated_by: actor,
    summary: answer.summary || "",
    area: answer.area || "",
    likely_cause: answer.likely_cause || "",
    acceptance: answer.acceptance || [],
    questions: answer.questions || [],
    test_cases: (answer.test_cases || []).slice(0, 15).map((t, i) => {
      const kind = kinds.includes(t.kind) ? t.kind : "manual";
      return {
        id: `${ticket.key}-TC${String(i + 1).padStart(2, "0")}`,
        title: String(t.title || `Test case ${i + 1}`),
        kind,
        priority: ["high", "medium", "low"].includes(t.priority) ? t.priority : "medium",
        preconditions: t.preconditions || "",
        steps: (Array.isArray(t.steps) ? t.steps : [t.steps]).filter(Boolean).map(String),
        expected: t.expected || "",
        spec: kind === "scenario" && t.spec ? clampSpec({ ...t.spec, label: t.title }, PRESETS[0].spec) : null,
      };
    }),
  };
};

// ---------- 8. Test cases for any project (no product data) ----------
/**
 * Writes manual test cases from a Jira ticket or pasted requirement, for projects
 * without a pack. Emails and phone numbers are removed before anything goes to the AI.
 */
export const genericTestCases = async ({ project, ticket, text }, actor) => {
  const source = ticket
    ? { key: ticket.key, type: ticket.type, summary: redact(ticket.summary, []), description: redact(ticket.description, []).slice(0, 30000), comments: ticket.comments.map(c => redact(c.body, []).slice(0, 3000)) }
    : { requirement: redact(text, []).slice(0, 30000) };
  if (!ticket && String(text || "").trim().length < 20) throw badRequest("Paste a requirement, user story or ticket text (a few sentences at least).");
  const answer = await askJson({
    actor,
    system: `You are a senior QA engineer for the product "${project.name}". From a Jira ticket or a requirement, write the test cases a tester needs: the happy path first, then validation, edge cases, permissions and regressions around it.
Each test case: a clear title, preconditions, numbered steps where every step has an action and what should happen, and a priority.
Write plain, friendly English for testers. No code. Don't invent product details that the text doesn't support; put open points in "questions".
Answer as JSON: {"summary":string,"test_cases":[{"title":string,"kind":"functional"|"validation"|"edge"|"permission"|"regression","priority":"high"|"medium"|"low","preconditions":string,"steps":[{"action":string,"expected":string}],"tags":[string]}],"questions":[string]}.
Give 5 to 15 test cases, most important first.`,
    input: source,
  });
  return {
    summary: answer.summary || "",
    questions: answer.questions || [],
    test_cases: (answer.test_cases || []).slice(0, 20).map(t => ({
      title: String(t.title || "Test case"),
      priority: ["high", "medium", "low"].includes(t.priority) ? t.priority : "medium",
      preconditions: t.preconditions || "",
      steps: (Array.isArray(t.steps) ? t.steps : []).map(s => (typeof s === "string" ? { action: s, expected: "" } : { action: String(s.action || ""), expected: String(s.expected || "") })),
      tags: [...new Set([t.kind, ...(Array.isArray(t.tags) ? t.tags : [])].filter(Boolean).map(x => String(x).toLowerCase()))],
      jira: ticket ? [ticket.key] : [],
      source: ticket ? `ai:${ticket.key}` : "ai",
    })),
  };
};
