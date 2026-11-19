// Data for a user's bug report: profile, recent measurements, the report as the
// dev API shows it, the rule check and (optionally) the overview check. The page
// turns it into Markdown or a printable PDF.
import { buildCase } from "./ai/casefile.js";
import { overviewCheck } from "./checks.js";
import { config } from "./config.js";
import { getUserDetail } from "./users.js";

export const bugReportData = async (userId, actor, { includeOverview = false } = {}) => {
  const [detail, c] = await Promise.all([getUserDetail(userId), buildCase(userId)]);
  if (!detail) throw Object.assign(new Error("User not found."), { status: 404 });
  const u = detail.user;
  let overview = null;
  if (includeOverview) {
    try { overview = await overviewCheck(userId, actor); } catch (error) { overview = { error: error.message }; }
  }
  const r = c.report;
  return {
    generated_at: new Date().toISOString(),
    generated_by: actor,
    environment: { database: config.db.database, api: config.apiBaseUrl, dashboard: config.dashboardUrl },
    user: {
      name: `${u.firstname} ${u.lastname}`.trim(),
      email: u.email,
      sinque_id: u.sinque_id,
      user_id: u.id,
      gender: u.gender,
      age: u.date_of_birth ? Math.floor((Date.now() - new Date(u.date_of_birth)) / 31557600000) : null,
      language: u.language,
      joined: u.created_at,
      test_user: u.is_test_user,
      groups: detail.groups.map(g => `${g.group_name}${g.subgroup_name ? " / " + g.subgroup_name : ""}`),
    },
    report: r && {
      week_start: r.report_week_start,
      week_end: r.report_week_end,
      measurements_last_week: r.last_week_measurement_count,
      adherence: r.adherence?.new_name,
      adherence_category: r.adherence?.adherence,
      trend_confidence: r.body_composition_analysis?.trendAnalysis ?? null,
      pace: r.weight_change_pace,
      speed: r.weight_loss_speed,
      weekly_weight: r.average_weight,
      muscle_mass: r.muscle_volume,
      muscle_change: r.absolute_change,
      body_fat: r.fat_mass_percentage?.value,
      visceral_fat: r.visceral_fat?.value,
      muscle_engine_score: r.muscle_engine_score,
      baseline: r.baseline_progress?.metrics || [],
      messages: [r.adherence?.message, r.weight_difference_message].filter(Boolean),
    },
    api_error: c.apiError,
    rule_checks: c.checks,
    expected: c.expected,
    overview,
    weeks: detail.weeks.slice(0, 6),
    measurements: detail.measurements.slice(0, 40).map(m => ({
      at: m.measurement_date, weight: m.net_weight, white_scale: !!m.has_bia_data,
      body_fat: m.bfr_bia, muscle: m.muscleMass_bia, hydration: m.vwc_bia, visceral: m.uvi_bia,
    })),
  };
};
