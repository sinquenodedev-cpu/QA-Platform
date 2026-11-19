// Independent re-implementation of the weekly report rules. The QA tool uses it
// as an oracle: it recalculates what the report *should* say from the raw
// readings and compares that with what the dev API returns. Keep in step with
// packages/sinque/src/libs/weekly-report.calc.ts in sinque-backend.
import { addDays, weekStart } from "./scenarios.js";

const DAY_MS = 864e5;
const round2 = v => Math.round(v * 100) / 100;
const dayKey = d => new Date(d).toISOString().slice(0, 10);
const inWeek = (date, start) => {
  const t = new Date(date).getTime();
  return t >= start.getTime() && t < start.getTime() + 7 * DAY_MS;
};

export const lastCompletedWeekStart = (now = new Date()) => addDays(weekStart(now), -7);

export const weekActivity = (points, start) => {
  const rows = points.filter(p => inWeek(p.measurement_date, start));
  return { measurements: rows.length, days: new Set(rows.map(p => dayKey(p.measurement_date))).size };
};

/** "Most reliable weekly weight": daily averages weighted by how many days sit on each side of the week average. */
export const weeklyAw2f = (points, start) => {
  const byDay = new Map();
  for (const p of points) {
    const w = Number(p.net_weight);
    if (!Number.isFinite(w) || !inWeek(p.measurement_date, start)) continue;
    const k = dayKey(p.measurement_date);
    byDay.set(k, [...(byDay.get(k) || []), w]);
  }
  const daily = [...byDay.values()].map(ws => ws.reduce((a, b) => a + b, 0) / ws.length);
  if (!daily.length) return null;
  const avg = round2(daily.reduce((a, b) => a + b, 0) / daily.length);
  const atOrAbove = daily.filter(d => d >= avg).length;
  const below = daily.length - atOrAbove;
  let sum = 0, factors = 0;
  for (const d of daily) {
    const f = d >= avg ? atOrAbove : below;
    sum += d * f;
    factors += f;
  }
  return factors ? round2(sum / factors) : null;
};

export const classifyAdherence = ({ daysByWeek, userCreatedAt, reportWeekStart, lastMeasurementDate }) => {
  const reference = addDays(reportWeekStart, 7);
  const threeMonthsBefore = new Date(reference);
  threeMonthsBefore.setUTCMonth(threeMonthsBefore.getUTCMonth() - 3);
  if (!lastMeasurementDate || new Date(lastMeasurementDate) < threeMonthsBefore) return "Needs reactivation";
  const weeksSinceOnboarding = Math.floor((reference - new Date(userCreatedAt)) / (7 * DAY_MS)) + 1;
  if (weeksSinceOnboarding <= 3) return "Onboarding";
  const total = daysByWeek[0] + daysByWeek[1] + daysByWeek[2];
  const empty = daysByWeek.filter(d => d === 0).length;
  if (total === 0) return "No Activity";
  if (total < 6 || empty >= 2) return "Low Adherence";
  if (daysByWeek.every(d => d >= 3)) return "High Adherence";
  if (daysByWeek.some(d => d >= 3)) return "Adequate";
  return "Low Adherence";
};

/** kg/week: report week (or the week before) against the nearest week ≥2 weeks earlier with data, ≤4 weeks back. */
export const weightChangeSpeed = aw2f => {
  const has = i => aw2f[i] != null;
  const anchor = has(0) ? 0 : has(1) ? 1 : null;
  if (anchor == null) return null;
  for (let c = anchor + 2; c <= 4 && c < aw2f.length; c++) {
    if (has(c)) return { speed: round2((aw2f[anchor] - aw2f[c]) / (c - anchor)), anchor, compare: c };
  }
  return null;
};

export const classificationArrow = speed => (speed == null ? "null" : speed < -0.1 ? "down" : speed > 0.1 ? "up" : "null");

const BANDS = {
  female: { "under 40": [-0.6, -0.41], "40 - 59": [-0.55, -0.31], "over 60": [-0.45, -0.31] },
  male: { "under 40": [-0.75, -0.51], "40 - 59": [-0.6, -0.41], "over 60": [-0.5, -0.31] },
};

export const ageGroup = (dob, at) => {
  if (!dob) return "over 60";
  const b = new Date(dob);
  let age = at.getUTCFullYear() - b.getUTCFullYear();
  if (at.getUTCMonth() < b.getUTCMonth() || (at.getUTCMonth() === b.getUTCMonth() && at.getUTCDate() < b.getUTCDate())) age--;
  return age < 40 ? "under 40" : age <= 59 ? "40 - 59" : "over 60";
};

export const classifyWeightLossRate = ({ speed, gender, dob, at }) => {
  if (speed == null) return { rate: null, band: null };
  const g = String(gender || "").toLowerCase();
  const key = g === "female" || g === "f" ? "female" : g === "male" || g === "m" ? "male" : null;
  if (!key) return { rate: null, band: null };
  const group = ageGroup(dob, at);
  const [min, max] = BANDS[key][group];
  const rate = speed >= min && speed <= max ? "Adequate" : speed < min ? "Fast" : "Slow";
  return { rate, band: { gender: key, ageGroup: group, min, max } };
};

// Labels the report shows for each category.
export const ADHERENCE_LABEL = {
  "High Adherence": "High", Adequate: "Adequate", "Low Adherence": "Low",
  "No Activity": "Inactive", Onboarding: "Onboarding", "Needs reactivation": "Reactivate",
};
export const TREND_LABEL = {
  "High Adherence": "Strong", Adequate: "Strong", "Low Adherence": "Limited",
  "No Activity": "Unavailable", Onboarding: "Building", "Needs reactivation": "Unavailable",
};
export const PACE_LABEL = { Fast: "Imbalanced", Adequate: "Balanced", Slow: "Steady" };

/**
 * What last week's report should say for a user, with the inputs behind each
 * number so a person (or the AI) can follow the reasoning.
 */
export const expectedReport = ({ user, points, lastMeasurementDate, lifetimeAverage, now = new Date() }) => {
  const start = lastCompletedWeekStart(now);
  const end = addDays(start, 7);
  const weeks = [0, 1, 2, 3, 4].map(i => addDays(start, -7 * i));
  const activity = weeks.map(ws => weekActivity(points, ws));
  const aw2f = weeks.map(ws => weeklyAw2f(points, ws));
  const adherence = classifyAdherence({
    daysByWeek: [activity[0].days, activity[1].days, activity[2].days],
    userCreatedAt: user.created_at,
    reportWeekStart: start,
    lastMeasurementDate,
  });
  const speedInfo = weightChangeSpeed(aw2f);
  const speed = speedInfo?.speed ?? null;
  const { rate, band } = classifyWeightLossRate({ speed, gender: user.gender, dob: user.date_of_birth, at: end });
  return {
    report_week_start: dayKey(start),
    report_week_end: dayKey(end),
    weeks: weeks.map((ws, i) => ({ week_start: dayKey(ws), weeks_before_report_week: i, ...activity[i], weekly_weight: aw2f[i] })),
    measurements_last_week: activity[0].measurements,
    days_last_week: activity[0].days,
    adherence_category: adherence,
    adherence_label: ADHERENCE_LABEL[adherence],
    trend_label: activity[0].measurements >= 2 ? TREND_LABEL[adherence] : null,
    weekly_weight: aw2f.find(v => v != null) ?? (lifetimeAverage != null ? round2(lifetimeAverage) : null),
    speed,
    speed_basis: speedInfo ? { from_week: dayKey(weeks[speedInfo.compare]), to_week: dayKey(weeks[speedInfo.anchor]), weeks_apart: speedInfo.compare - speedInfo.anchor } : null,
    arrow: classificationArrow(speed),
    weight_loss_rate: rate,
    pace_label: rate ? PACE_LABEL[rate] : "Unavailable",
    pace_band: band,
  };
};

const parseKg = text => {
  const m = String(text ?? "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

/**
 * Compares the dev API's report with the expected one. Returns one entry per
 * checked field; `ok: false` means they disagree.
 */
export const compareReport = (report, expected, { weightUnit } = {}) => {
  const checks = [];
  const add = (field, shown, should, ok, note = "") => checks.push({ field, shown, expected: should, ok, note });

  add("Measurements last week", report.last_week_measurement_count, expected.measurements_last_week,
    Number(report.last_week_measurement_count) === expected.measurements_last_week);

  const shownAdherence = report.adherence?.adherence ?? null;
  add("Adherence", shownAdherence, expected.adherence_category, shownAdherence === expected.adherence_category,
    `${expected.days_last_week} days last week; days per week (report week, then 2 before): ${expected.weeks.slice(0, 3).map(w => w.days).join(" / ")}`);

  const shownTrend = report.body_composition_analysis?.trendAnalysis ?? null;
  add("Trend confidence", shownTrend, expected.trend_label, (shownTrend || null) === (expected.trend_label || null),
    expected.trend_label ? "" : "Hidden when fewer than 2 measurements last week");

  add("Weight change pace", report.weight_change_pace || "Unavailable", expected.pace_label,
    (report.weight_change_pace || "Unavailable") === expected.pace_label,
    expected.pace_band ? `Adequate band for ${expected.pace_band.gender} ${expected.pace_band.ageGroup}: ${expected.pace_band.min} to ${expected.pace_band.max} kg/week` : "");

  const shownSpeed = report.weight_loss_speed === "" || report.weight_loss_speed == null ? null : Number(report.weight_loss_speed);
  add("Weight change speed (kg/week)", shownSpeed, expected.speed,
    shownSpeed == null || expected.speed == null ? shownSpeed === expected.speed : Math.abs(shownSpeed - expected.speed) <= 0.02);

  const isKg = !weightUnit || /kilo|kg/i.test(weightUnit);
  if (isKg) {
    const shownWeight = parseKg(report.average_weight);
    add("Most reliable weekly weight (kg)", shownWeight, expected.weekly_weight,
      shownWeight == null || expected.weekly_weight == null ? shownWeight === expected.weekly_weight : Math.abs(shownWeight - expected.weekly_weight) <= 0.15);
  }

  // Internal consistency: the muscle card and the baseline table must agree.
  const muscleRow = report.baseline_progress?.metrics?.find(m => m.key === "skeletal_muscle");
  if (muscleRow && muscleRow.change != null && isKg) {
    const card = parseKg(report.absolute_change);
    add("Muscle change: card vs baseline table", card, muscleRow.change, card != null && Math.abs(card - muscleRow.change) <= 0.05);
  }

  return checks;
};
