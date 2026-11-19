// Everything needed to judge one user's weekly report, without personal data.
import { fetchReport } from "../api.js";
import { isTestEmail } from "../config.js";
import { badRequest, query } from "../db.js";
import { addDays } from "../scenarios.js";
import { compareReport, expectedReport, lastCompletedWeekStart } from "../rules.js";

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const loadReportInputs = async userId => {
  const [user] = await query(
    `SELECT id, sinque_id, firstname, lastname, email, gender, date_of_birth, language, weight_unit, created_at
     FROM users WHERE id = ? AND deleted_at IS NULL`,
    [userId]
  );
  if (!user) throw badRequest("User not found.");

  const start = lastCompletedWeekStart();
  const end = addDays(start, 7);
  const from = addDays(start, -28);
  const points = await query(
    `SELECT measurement_date, net_weight, has_bia_data FROM userweights
     WHERE user_id = ? AND collection_method <> 3 AND measurement_date >= ? AND measurement_date < ?
     ORDER BY measurement_date`,
    [userId, from, end]
  );
  const [{ last, avg }] = await query(
    `SELECT MAX(measurement_date) AS last, AVG(net_weight) AS avg FROM userweights
     WHERE user_id = ? AND collection_method <> 3 AND measurement_date < ?`,
    [userId, end]
  );
  return { user, points, lastMeasurementDate: last, lifetimeAverage: avg == null ? null : Number(avg) };
};

const ageOf = dob => (dob ? Math.floor((Date.now() - new Date(dob)) / 31557600000) : null);

/** The report fields people look at, as the API returned them. */
const shownReport = r => ({
  report_week_start: r.report_week_start,
  measurements_last_week: r.last_week_measurement_count,
  adherence: r.adherence && { category: r.adherence.adherence, label: r.adherence.new_name, color: r.adherence.color, message: r.adherence.message },
  trend_confidence: r.body_composition_analysis?.trendAnalysis ?? null,
  weight_change_pace: r.weight_change_pace,
  pace_message: r.weight_difference_message,
  speed_kg_per_week: r.weight_loss_speed,
  arrow: r.weight_difference_arrow,
  most_reliable_weekly_weight: r.average_weight,
  muscle_mass: r.muscle_volume,
  muscle_change_card: r.absolute_change,
  body_fat: r.fat_mass_percentage,
  visceral_fat: r.visceral_fat,
  muscle_engine_score: r.muscle_engine_score,
  baseline_progress: r.baseline_progress?.metrics,
  white_scale_data: r.is_white_scale_data,
});

/**
 * Case file for one user. `report` is null when the API call fails; `checks`
 * is then empty and `apiError` says why.
 */
export const buildCase = async userId => {
  const inputs = await loadReportInputs(userId);
  const { user, points } = inputs;
  const expected = expectedReport(inputs);

  let report = null, apiError = null;
  try {
    const res = await fetchReport(userId);
    if (res.ok && res.body?.data) report = res.body.data;
    else apiError = `API answered ${res.status}: ${res.body?.message || "no data"}`;
  } catch (error) {
    apiError = error.message;
  }
  const checks = report ? compareReport(report, expected, { weightUnit: user.weight_unit }) : [];

  const anonymous = {
    user: {
      ref: `#${user.sinque_id}`,
      gender: user.gender || null,
      age: ageOf(user.date_of_birth),
      account_created: String(new Date(user.created_at).toISOString()).slice(0, 10),
      app_language: user.language,
      weight_unit: user.weight_unit,
      test_user: isTestEmail(user.email),
    },
    readings_last_5_weeks: points.map(p => {
      const d = new Date(p.measurement_date);
      return { utc: d.toISOString().slice(0, 16).replace("T", " "), weekday: WEEKDAY[d.getUTCDay()], kg: Number(p.net_weight), white_scale: !!p.has_bia_data };
    }),
    last_measurement_before_report_week_end: inputs.lastMeasurementDate ? new Date(inputs.lastMeasurementDate).toISOString() : null,
    expected_by_rules: expected,
    shown_by_api: report ? shownReport(report) : null,
    api_error: apiError,
    checks,
  };

  return { user, expected, report, checks, apiError, anonymous };
};
