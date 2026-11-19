// QA checks that use the deployed dev API: preset expectations, the dashboard
// overview, the real report link, and full preset runs in a fresh test group.
import fs from "fs";
import path from "path";
import { audit } from "./audit.js";
import { fetchOverview, fetchProgress, fetchReport, loginToken } from "./api.js";
import { buildCase } from "./ai/casefile.js";
import { TEST_EMAIL_DOMAIN, config, isTestEmail } from "./config.js";
import { badRequest, query } from "./db.js";
import { assignProfessional, createGroup, createProfessional, createSubgroup, listProfessions, resetProfessionalPassword } from "./orgs.js";
import { PACE_LABEL } from "./rules.js";
import { PRESETS } from "./scenarios.js";
import { createScenarioUser } from "./users.js";

const same = (a, b) => (a ?? null) === (b ?? null);
const near = (a, b, tol) => (a == null || b == null ? a == null && b == null : Math.abs(Number(a) - Number(b)) <= tol);

// ---------- 1. Preset expectations ----------

/** Does the report match what the preset is meant to produce? Plus the rule check. */
export const presetCheck = async (userId, presetKey) => {
  const preset = PRESETS.find(p => p.key === presetKey);
  if (!preset) throw badRequest("Unknown preset.");
  const c = await buildCase(userId);
  if (!c.report) return { preset: preset.key, title: preset.title, expect: preset.expect, pass: false, error: c.apiError, intent: [], rules: [] };

  const r = c.report;
  const want = preset.want || {};
  const intent = [];
  const add = (field, shown, wanted, ok) => intent.push({ field, shown, expected: wanted, ok });
  if ("measurements" in want) add("Measurements last week", r.last_week_measurement_count, want.measurements, Number(r.last_week_measurement_count) === want.measurements);
  if ("adherence" in want) add("Adherence", r.adherence?.adherence ?? null, want.adherence, same(r.adherence?.adherence, want.adherence));
  if ("trend" in want) {
    const shown = r.body_composition_analysis?.trendAnalysis ?? null;
    add("Trend confidence", shown ?? "hidden", want.trend ?? "hidden", same(shown, want.trend));
  }
  if ("pace" in want) add("Weight change pace", r.weight_change_pace || "Unavailable", want.pace, (r.weight_change_pace || "Unavailable") === want.pace);
  if ("whiteScale" in want) add("White-scale data", r.is_white_scale_data, want.whiteScale, r.is_white_scale_data === want.whiteScale);

  const rules = c.checks;
  return {
    preset: preset.key,
    title: preset.title,
    expect: preset.expect,
    pass: intent.every(x => x.ok) && rules.every(x => x.ok),
    intent,
    rules,
  };
};

// ---------- 2 + 3. Dashboard access, overview check, report link ----------

const BOT_NAME = "QA Overview Bot";

/**
 * The tool's own test professional, made group manager of the user's group. The
 * dashboard only counts group manager, subgroup manager and group admin as access;
 * a direct professionalgroups assignment doesn't show users in the overview.
 */
const botToken = async ({ groupId }, actor) => {
  let [bot] = await query("SELECT id, email FROM professionals WHERE name = ? AND email LIKE ? ORDER BY id LIMIT 1", [BOT_NAME, `%${TEST_EMAIL_DOMAIN}`]);
  if (!bot) {
    const [profession] = await listProfessions();
    const created = await createProfessional({ name: BOT_NAME, professionId: profession?.id, language: "EN", dashboard: true });
    bot = { id: created.id, email: created.email };
    audit(actor, "create overview bot", { professional: bot.email });
  }
  const [has] = await query("SELECT id FROM groupmanagers WHERE professional_id = ? AND group_id = ? AND status = 1", [bot.id, groupId]);
  if (!has) {
    await assignProfessional({ professionalId: bot.id, via: "group-manager", groupId });
    audit(actor, "make overview bot group manager", { professional: bot.email, group_id: groupId });
  }
  try {
    return { token: await loginToken(bot.email, config.testPassword, true), source: `test professional “${BOT_NAME}”` };
  } catch {
    await resetProfessionalPassword(bot.id);
    return { token: await loginToken(bot.email, config.testPassword, true), source: `test professional “${BOT_NAME}”` };
  }
};

const membershipOf = async userId => {
  const [m] = await query(
    `SELECT ug.group_id, ug.subgroup_id, g.name AS group_name, sg.name AS subgroup_name
     FROM usergroups ug LEFT JOIN \`groups\` g ON g.id = ug.group_id LEFT JOIN subgroups sg ON sg.id = ug.subgroup_id
     WHERE ug.user_id = ? AND ug.status = 1 AND ug.deleted_at IS NULL ORDER BY ug.id DESC LIMIT 1`,
    [userId]
  );
  if (!m) throw badRequest("This user isn't in any group, so they don't appear in the overview.");
  return m;
};

/** The user's row in the dashboard's Group/Subgroup Overview, fetched as a dashboard user. */
const overviewRow = async (user, actor) => {
  const m = await membershipOf(user.id);
  const access = config.dashboardAdmin
    ? { token: await loginToken(config.dashboardAdmin.email, config.dashboardAdmin.password, true), source: "dashboard admin from .env" }
    : await botToken({ groupId: m.group_id, subgroupId: m.subgroup_id }, actor);
  const res = await fetchOverview(access.token, {
    name: `${user.firstname} ${user.lastname}`.trim(),
    groupIds: [m.group_id],
    subgroupIds: m.subgroup_id ? [m.subgroup_id] : [],
  });
  if (!res.ok) throw new Error(`The overview API answered ${res.status}: ${res.body?.message || "error"}`);
  const rows = res.body?.data?.data || [];
  return { membership: m, source: access.source, row: rows.find(r => String(r.user_id) === String(user.id)) || null };
};

const getUserRow = async userId => {
  const [u] = await query("SELECT id, sinque_id, firstname, lastname, email FROM users WHERE id = ? AND deleted_at IS NULL", [userId]);
  if (!u) throw badRequest("User not found.");
  return u;
};

/** Compares the user's overview row with their weekly report, column by column. */
export const overviewCheck = async (userId, actor) => {
  const user = await getUserRow(userId);
  const [{ row, membership, source }, reportRes, [latest]] = await Promise.all([
    overviewRow(user, actor),
    fetchReport(userId),
    query(
      `SELECT net_weight FROM userweights WHERE user_id = ? AND collection_method <> 3
       ORDER BY measurement_date DESC, created_at DESC LIMIT 1`,
      [userId]
    ),
  ]);
  const report = reportRes.body?.data;
  if (!row) {
    return { found: false, source, membership, note: "The user isn't in the overview the dashboard shows for their group. The dev dashboard may still be reading an old copy of the overview (reports_users_overview_computed) that doesn't include newer users." };
  }
  if (!report) throw new Error(`The report API answered ${reportRes.status}.`);

  const paceFromRow = row.weight_loss_rate ? PACE_LABEL[row.weight_loss_rate] || row.weight_loss_rate : "Unavailable";
  const comparisons = [
    { field: "Measurements last week", overview: row.measurements_last_week, report: report.last_week_measurement_count, ok: Number(row.measurements_last_week) === Number(report.last_week_measurement_count) },
    { field: "Adherence", overview: row.adherence_category, report: report.adherence?.adherence ?? null, ok: same(row.adherence_category, report.adherence?.adherence) },
    { field: "Weight change pace", overview: paceFromRow, report: report.weight_change_pace || "Unavailable", ok: paceFromRow === (report.weight_change_pace || "Unavailable") },
    { field: "Weight change speed (kg/week)", overview: row.weight_change_speed, report: report.weight_loss_speed || null, ok: near(row.weight_change_speed, report.weight_loss_speed === "" ? null : report.weight_loss_speed, 0.02) },
    { field: "Trend arrow", overview: row.classification_arrow, report: report.weight_difference_arrow, ok: same(row.classification_arrow, report.weight_difference_arrow) },
    { field: "Current weight (latest reading, kg)", overview: row.current_weight, report: latest ? Number(latest.net_weight) : null, ok: near(row.current_weight, latest?.net_weight, 0.01), note: "Compared with the latest reading in the database" },
  ];
  return {
    found: true,
    source,
    membership,
    row: {
      status_color: row.status_color, measurements_last_week: row.measurements_last_week, measurements_this_week: row.measurements_this_week,
      adherence_category: row.adherence_category, weight_loss_rate: row.weight_loss_rate, weight_change_speed: row.weight_change_speed,
      classification_arrow: row.classification_arrow, current_weight: row.current_weight, start_weight: row.start_weight,
      weight_vs_last_month: row.weight_vs_last_month, total_weight_difference: row.total_weight_difference,
    },
    comparisons,
    mismatches: comparisons.filter(x => !x.ok).length,
  };
};

/** Link to the user's report page on the dev dashboard, with a valid token. */
export const reportLink = async (userId, actor) => {
  const user = await getUserRow(userId);
  let token = null, source = null;
  try {
    const { row, source: via } = await overviewRow(user, actor);
    if (row?.public_report_token) { token = row.public_report_token; source = `overview API (as ${via})`; }
  } catch { /* fall back to a stored token */ }
  if (!token && isTestEmail(user.email)) {
    // Sign in as the test user and take the link the app itself is given.
    try {
      const res = await fetchProgress(await loginToken(user.email, config.testPassword));
      const link = res.body?.data?.publicReportUrl;
      const fromApp = link ? new URL(link, config.dashboardUrl).searchParams.get("token") : null;
      if (fromApp) { token = fromApp; source = "the app's progress screen (signed in as the test user)"; }
    } catch { /* fall back to a stored token */ }
  }
  if (!token) {
    const [t] = await query(
      `SELECT jwt_token FROM public_report_tokens
       WHERE user_id = ? AND used_at IS NULL AND expires_at > NOW() AND jwt_token IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    if (t) { token = t.jwt_token; source = "existing token in the database"; }
  }
  if (!token) throw badRequest("No report token is available for this user yet. Open them once in the dashboard's Group/Subgroup Overview, then try again.");
  return { url: `${config.dashboardUrl}/public/evolve-report?userId=${encodeURIComponent(userId)}&token=${encodeURIComponent(token)}`, source };
};

// ---------- 1 + 5. Run every preset in a fresh test group ----------

/**
 * Creates a QA group + subgroup, one user per preset in it, and a professional
 * with dashboard access; then checks every user's report against its preset.
 */
// A summary of each "Run all presets", newest last (kept for the home page).
const runsFile = () => path.join(config.root, "data", "preset-runs.json");
export const presetRuns = () => {
  try { return JSON.parse(fs.readFileSync(runsFile(), "utf8")); } catch { return []; }
};
const savePresetRun = run => {
  fs.mkdirSync(path.dirname(runsFile()), { recursive: true });
  fs.writeFileSync(runsFile(), JSON.stringify([...presetRuns(), run].slice(-50), null, 1));
};

export const runAllPresets = async ({ name, keys }, actor, progress = () => {}) => {
  const label = String(name || "").trim() || `Preset run ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  progress(0, null, "Creating the test group and a group manager");
  const group = await createGroup({ name: label });
  const subgroup = await createSubgroup({ groupId: group.id, name: `${label} · main` });
  const [profession] = await listProfessions();
  const pro = await createProfessional({ name: `QA Coach ${label}`.slice(0, 60), professionId: profession?.id, language: "EN", dashboard: true });
  // Group manager: the access type the dashboard overview recognises.
  await assignProfessional({ professionalId: pro.id, via: "group-manager", groupId: group.id });
  audit(actor, "run all presets", { group_id: group.id, group: `QA ${label}`, professional: pro.email });

  const chosen = PRESETS.filter(p => !keys?.length || keys.includes(p.key));
  const results = [];
  for (const [i, p] of chosen.entries()) {
    progress(i, chosen.length, `Creating and checking “${p.title}”`);
    try {
      const u = await createScenarioUser({ spec: { ...p.spec, label: p.title }, preset: p.key, groupId: group.id, subgroupId: subgroup.id });
      results.push({ ...(await presetCheck(u.id, p.key)), user_id: u.id, email: u.email });
    } catch (error) {
      results.push({ preset: p.key, title: p.title, expect: p.expect, pass: false, error: error.message, intent: [], rules: [] });
    }
  }
  savePresetRun({
    at: new Date().toISOString(), by: actor, group: { id: group.id, name: `QA ${label}` },
    total: results.length, passed: results.filter(r => r.pass).length,
    failed_presets: results.filter(r => !r.pass).map(r => r.title || r.preset),
  });
  return {
    group: { id: group.id, name: `QA ${label}` },
    subgroup: { id: subgroup.id, name: `QA ${label} · main` },
    professional: { email: pro.email, password: pro.password },
    user_password: config.testPassword,
    passed: results.filter(r => r.pass).length,
    failed: results.filter(r => !r.pass).length,
    results,
  };
};

// ---------- 4. Report history ----------

/** Stored weekly reports for a user, newest first, with the fields people compare. */
export const reportHistory = async userId => {
  const rows = await query(
    `SELECT week_start, updated_at, report_data FROM user_weekly_reports WHERE user_id = ? ORDER BY week_start DESC LIMIT 20`,
    [userId]
  ).catch(() => null);
  if (rows === null) return { available: false, weeks: [] };
  return {
    available: true,
    weeks: rows.map(r => {
      const d = typeof r.report_data === "string" ? JSON.parse(r.report_data) : r.report_data || {};
      return {
        week_start: String(r.week_start instanceof Date ? r.week_start.toISOString() : r.week_start).slice(0, 10),
        saved_at: r.updated_at,
        measurements: d.measurements_count,
        days: d.measurement_days,
        days_by_week: d.days_by_week,
        adherence: d.adherence_category,
        weekly_weight: d.weekly_weight_kg,
        speed: d.weight_change_speed,
        pace: d.weight_loss_rate,
        arrow: d.classification_arrow,
        body_fat: d.body_fat_pct,
        muscle: d.muscle_mass_kg,
        visceral: d.visceral_fat_index,
      };
    }),
  };
};

