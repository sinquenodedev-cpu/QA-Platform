import crypto from "crypto";
import bcrypt from "bcryptjs";
import { QA_GROUP_NAME, TEST_EMAIL_DOMAIN, config, isTestEmail } from "./config.js";
import { badRequest, pool, query, transaction } from "./db.js";
import { BIA_COLUMNS, PRESETS, addDays, biaValues, generateMeasurements, weekStart } from "./scenarios.js";

const requireTestUser = user => {
  if (!user) throw badRequest("User not found.");
  if (!isTestEmail(user.email)) {
    throw badRequest(`Only test users (${TEST_EMAIL_DOMAIN}) can be changed from the QA platform.`);
  }
};

export const searchUsers = async ({ q = "", testOnly = false, role = 1 }) => {
  const where = ["u.role = ?", "u.deleted_at IS NULL"];
  const params = [role];
  if (q.trim()) {
    where.push("(u.email LIKE ? OR CONCAT(u.firstname, ' ', u.lastname) LIKE ? OR CAST(u.sinque_id AS CHAR) = ?)");
    params.push(`%${q.trim()}%`, `%${q.trim()}%`, q.trim());
  }
  if (testOnly) {
    where.push("u.email LIKE ?");
    params.push(`%${TEST_EMAIL_DOMAIN}`);
  }
  const rows = await query(
    `SELECT u.id, u.sinque_id, u.firstname, u.lastname, u.email, u.gender, u.created_at,
            (SELECT MAX(w.measurement_date) FROM userweights w WHERE w.user_id = u.id AND w.collection_method <> 3) AS last_measurement,
            (SELECT COUNT(*) FROM userweights w WHERE w.user_id = u.id AND w.collection_method <> 3) AS measurement_count
     FROM users u
     WHERE ${where.join(" AND ")}
     ORDER BY u.created_at DESC
     LIMIT 50`,
    params
  );
  return rows.map(r => ({ ...r, is_test_user: isTestEmail(r.email) }));
};

export const getUser = async id =>
  (await query(
    `SELECT id, sinque_id, firstname, lastname, email, gender, date_of_birth, language, weight_unit,
            weight, height, height_unit, status, role, created_at
     FROM users WHERE id = ? AND deleted_at IS NULL`,
    [id]
  ))[0] ?? null;

const WEEKS = 12;

/** Profile, groups, raw readings and per-week counts for the user page. */
export const getUserDetail = async id => {
  const user = await getUser(id);
  if (!user) return null;

  const thisMonday = weekStart(new Date());
  const from = addDays(thisMonday, -7 * WEEKS);
  const measurements = await query(
    `SELECT id, measurement_date, net_weight, scale_id, has_bia_data, bfr_bia, muscleMass_bia, vwc_bia, uvi_bia,
            collection_method, status
     FROM userweights
     WHERE user_id = ? AND collection_method <> 3 AND measurement_date >= ?
     ORDER BY measurement_date DESC`,
    [id, from]
  );

  // Raw per-week numbers (Monday-Sunday, UTC), the inputs the report is built from.
  const weeks = [];
  for (let i = 0; i <= WEEKS; i++) {
    const start = addDays(thisMonday, -7 * i);
    const end = addDays(start, 7);
    const inWeek = measurements.filter(m => new Date(m.measurement_date) >= start && new Date(m.measurement_date) < end);
    const weights = inWeek.map(m => Number(m.net_weight)).filter(Number.isFinite);
    weeks.push({
      week_start: start.toISOString().slice(0, 10),
      label: i === 0 ? "this week" : i === 1 ? "last week (report)" : "",
      measurements: inWeek.length,
      days: new Set(inWeek.map(m => new Date(m.measurement_date).toISOString().slice(0, 10))).size,
      avg_weight: weights.length ? Math.round((weights.reduce((a, b) => a + b, 0) / weights.length) * 100) / 100 : null,
      bia_readings: inWeek.filter(m => m.has_bia_data).length,
    });
  }

  const groups = await query(
    `SELECT ug.id, g.id AS group_id, g.name AS group_name, sg.id AS subgroup_id, sg.name AS subgroup_name
     FROM usergroups ug
     LEFT JOIN \`groups\` g ON g.id = ug.group_id
     LEFT JOIN subgroups sg ON sg.id = ug.subgroup_id
     WHERE ug.user_id = ?`,
    [id]
  );

  const storedReports = await query(
    `SELECT week_start, measurements_count, measurement_days, adherence_category, weekly_weight,
            weight_change_speed, weight_loss_rate, updated_at
     FROM user_weekly_reports WHERE user_id = ? ORDER BY week_start DESC`,
    [id]
  ).catch(() => null); // table missing on this database

  return {
    user: { ...user, is_test_user: isTestEmail(user.email) },
    groups,
    weeks,
    measurements,
    stored_reports: storedReports,
  };
};

const insertMeasurements = async (conn, userId, items) => {
  if (!items.length) return;
  const cols = ["user_id", "measurement_date", "user_weight", "net_weight", "collection_method", "status", "confirmed",
    "scale_id", "has_bia_data", ...BIA_COLUMNS, "created_at", "updated_at"];
  const rows = items.map(m => [
    userId, m.measurement_date, m.net_weight, m.net_weight, 1, 1, 1,
    m.bia ? 2 : 1, m.bia ? 1 : 0, ...BIA_COLUMNS.map(c => (m.bia ? m.bia[c] : null)),
    m.measurement_date, m.measurement_date,
  ]);
  await conn.query(`INSERT INTO userweights (${cols.join(", ")}) VALUES ?`, [rows]);
};

/** The QA Scenarios group and its default subgroup (app users must be in a subgroup). */
export const ensureQaGroup = async () => {
  let [group] = await query(
    "SELECT id FROM `groups` WHERE name = ? AND (deleted = 0 OR deleted IS NULL) ORDER BY id LIMIT 1",
    [QA_GROUP_NAME]
  );
  if (!group) {
    const [result] = await pool.query(
      "INSERT INTO `groups` (name, business_name, language, status, deleted, created_at, updated_at) VALUES (?, ?, 'EN', 1, 0, NOW(), NOW())",
      [QA_GROUP_NAME, "QA test scenarios"]
    );
    group = { id: result.insertId };
  }
  let [subgroup] = await query(
    "SELECT id FROM subgroups WHERE group_id = ? AND (deleted = 0 OR deleted IS NULL) ORDER BY id LIMIT 1",
    [group.id]
  );
  if (!subgroup) {
    const [result] = await pool.query(
      "INSERT INTO subgroups (group_id, name, language, show_weights, status, deleted, start_date, created_at, updated_at) VALUES (?, ?, 'EN', 1, 1, 0, NOW(), NOW(), NOW())",
      [group.id, QA_GROUP_NAME]
    );
    subgroup = { id: result.insertId };
  }
  return { groupId: group.id, subgroupId: subgroup.id };
};

/** Group/subgroup to put a user in: the given pair, or the QA Scenarios default. */
const resolveMembership = async ({ groupId, subgroupId }) => {
  if (!groupId) return ensureQaGroup();
  if (!subgroupId) throw badRequest("Pick a subgroup: every app user has to be in one.");
  return { groupId: Number(groupId), subgroupId: Number(subgroupId) };
};

const stamp = () => new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
const slugify = s => String(s || "custom").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/**
 * Creates a test app user (role 1) with generated measurements. The user is put
 * in `groupId`/`subgroupId` if given, otherwise in the QA Scenarios group.
 */
export const createScenarioUser = async ({ spec, preset, groupId, subgroupId }) => {
  const now = new Date();
  const measurements = generateMeasurements(spec, now);
  const email = `${slugify(preset || spec.label)}-${stamp()}${TEST_EMAIL_DOMAIN}`;
  const id = crypto.randomUUID();

  // The account can't be younger than its first reading.
  let createdAt = addDays(now, -7 * Math.max(0, Number(spec.accountAgeWeeks) || 0));
  if (measurements[0] && measurements[0].measurement_date < createdAt) createdAt = addDays(measurements[0].measurement_date, -1);

  const dob = new Date(Date.UTC(now.getUTCFullYear() - spec.age, 0, 15));
  const password = await bcrypt.hash(config.testPassword, 10);
  const membership = await resolveMembership({ groupId, subgroupId });

  await transaction(async conn => {
    await conn.query(
      `INSERT INTO users (id, firstname, lastname, language, date_of_birth, gender, email, password, role,
                          weight_unit, weight, weight_goal, height, height_unit, status, is_old_user, created_at, updated_at)
       VALUES (?, 'Scenario', ?, ?, ?, ?, ?, ?, 1, 'Kilograms', ?, 'Lose weight', ?, 'cm', 1, 0, ?, ?)`,
      [id, String(spec.label).slice(0, 60), spec.language, dob, spec.gender, email, password,
       spec.startWeightKg, String(spec.heightCm), createdAt, createdAt]
    );
    await conn.query(
      "INSERT INTO usergroups (user_id, group_id, subgroup_id, status, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
      [id, membership.groupId, membership.subgroupId, createdAt, createdAt]
    );
    await insertMeasurements(conn, id, measurements);
  });

  return { id, email, password: config.testPassword, measurements: measurements.length };
};

const requireUser = user => {
  if (!user) throw badRequest("User not found.");
  return user;
};

const profileFor = (user, weightKg) => ({
  gender: user.gender === "Male" ? "Male" : "Female",
  age: user.date_of_birth ? new Date().getUTCFullYear() - new Date(user.date_of_birth).getUTCFullYear() : 45,
  heightCm: Number(user.height) || 168,
  startWeightKg: weightKg,
});

const num = (v, label) => {
  if (v === "" || v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw badRequest(`${label} must be a number.`);
  return n;
};

const parseWhen = value => {
  const date = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(String(value)) ? value : `${value}Z`);
  if (Number.isNaN(date.getTime())) throw badRequest("Pick a valid date and time.");
  return date;
};

/** The user's white-scale reading closest before `at` (or their latest), used as a base for new values. */
const referenceBia = async (userId, at, excludeId = null) => {
  const [ref] = await query(
    `SELECT net_weight, bfr_bia, muscleMass_bia, vwc_bia, uvi_bia FROM userweights
     WHERE user_id = ? AND has_bia_data = 1 AND bfr_bia > 0 AND muscleMass_bia > 0 AND net_weight > 0 AND (? IS NULL OR id <> ?)
     ORDER BY (measurement_date <= ?) DESC, ABS(TIMESTAMPDIFF(SECOND, measurement_date, ?)) ASC LIMIT 1`,
    [userId, excludeId, excludeId, at, at]
  );
  return ref ? { weight: Number(ref.net_weight), bfr: Number(ref.bfr_bia), muscle: Number(ref.muscleMass_bia), water: Number(ref.vwc_bia), visceral: Number(ref.uvi_bia) } : null;
};

/**
 * Body-composition values for a reading: typed values win. Anything left empty
 * continues from the user's own nearby white-scale reading, adjusted for the
 * weight difference, so one new reading doesn't make body fat or muscle jump.
 * Users without any white-scale reading get plausible values for the weight.
 */
const biaFor = (user, weightKg, typed = {}, ref = null) => {
  let generated = biaValues(weightKg, profileFor(user, weightKg));
  if (ref) {
    const r1 = v => Math.round(v * 10) / 10;
    const bfr = r1(ref.bfr + (weightKg - ref.weight) * 0.5);
    const fatMass = (weightKg * bfr) / 100;
    const lean = weightKg - fatMass;
    const refLean = ref.weight - (ref.weight * ref.bfr) / 100;
    generated = {
      ...generated,
      bfr_bia: bfr,
      sfr_bia: r1(bfr * 0.8),
      fatMass_bia: r1(fatMass),
      leanBodyMass_bia: r1(lean),
      muscleMass_bia: r1(refLean > 0 ? ref.muscle * (lean / refLean) : generated.muscleMass_bia),
      vwc_bia: Number.isFinite(ref.water) && ref.water > 0 ? ref.water : generated.vwc_bia,
      uvi_bia: Number.isFinite(ref.visceral) && ref.visceral > 0 ? ref.visceral : generated.uvi_bia,
    };
  }
  const bfr = num(typed.bfr_bia, "Body fat");
  const muscle = num(typed.muscleMass_bia, "Muscle mass");
  const water = num(typed.vwc_bia, "Hydration");
  const visceral = num(typed.uvi_bia, "Visceral fat");
  return {
    ...generated,
    ...(bfr != null ? { bfr_bia: bfr, fatMass_bia: Math.round(weightKg * bfr) / 100 } : {}),
    ...(muscle != null ? { muscleMass_bia: muscle } : {}),
    ...(water != null ? { vwc_bia: water } : {}),
    ...(visceral != null ? { uvi_bia: Math.round(visceral) } : {}),
  };
};

/**
 * Adds readings for any user: one reading at an exact time (`at`), or a series
 * starting on `startDate` (days x perDay, optional daily change).
 */
export const addMeasurements = async (userId, input) => {
  const user = requireUser(await getUser(userId));
  const weightKg = num(input.weightKg, "Weight");
  if (weightKg == null || weightKg <= 0) throw badRequest("Weight is required.");

  const items = [];
  if (input.at) {
    const when = parseWhen(input.at);
    items.push({
      measurement_date: when,
      net_weight: weightKg,
      bia: input.whiteScale ? biaFor(user, weightKg, input.bia, await referenceBia(userId, when)) : null,
    });
  } else {
    const start = new Date(`${input.startDate}T00:00:00Z`);
    if (Number.isNaN(start.getTime())) throw badRequest("Pick a first day.");
    const ref = input.whiteScale ? await referenceBia(userId, start) : null;
    for (let d = 0; d < Math.max(1, Number(input.days) || 1); d++) {
      for (let k = 0; k < Math.max(1, Number(input.perDay) || 1); k++) {
        const date = addDays(start, d);
        date.setUTCHours(7 + k * 5, 10 + d, 0, 0);
        const weight = Math.round((weightKg + (Number(input.kgPerDay) || 0) * d) * 100) / 100;
        items.push({ measurement_date: date, net_weight: weight, bia: input.whiteScale ? biaFor(user, weight, {}, ref) : null });
      }
    }
  }
  await insertMeasurements(pool, userId, items);
  await clearStoredReports(userId);
  return { added: items.length, user, items: items.map(i => ({ measurement_date: i.measurement_date, net_weight: i.net_weight, bia: !!i.bia })) };
};

const MEASUREMENT_FIELDS = `id, measurement_date, net_weight, user_weight, scale_id, has_bia_data, bfr_bia,
  muscleMass_bia, vwc_bia, uvi_bia, collection_method, status`;

const getMeasurement = async (userId, measurementId) => {
  const [m] = await query(`SELECT ${MEASUREMENT_FIELDS} FROM userweights WHERE id = ? AND user_id = ?`, [measurementId, userId]);
  if (!m) throw badRequest("Measurement not found for this user.");
  return m;
};

/**
 * Edits one reading: date/time, weight and body composition. Turning BIA off
 * clears the body-composition values; turning it on fills any empty ones.
 */
export const updateMeasurement = async (userId, measurementId, input) => {
  const user = requireUser(await getUser(userId));
  const before = await getMeasurement(userId, measurementId);

  const weightKg = input.weightKg !== undefined ? num(input.weightKg, "Weight") : Number(before.net_weight);
  if (weightKg == null || weightKg <= 0) throw badRequest("Weight is required.");
  const when = input.at ? parseWhen(input.at) : new Date(before.measurement_date);
  const whiteScale = input.whiteScale !== undefined ? !!input.whiteScale : !!before.has_bia_data;

  const set = {
    measurement_date: when,
    net_weight: weightKg,
    user_weight: weightKg,
    has_bia_data: whiteScale ? 1 : 0,
    scale_id: whiteScale ? 2 : 1,
  };
  if (whiteScale) {
    // Keep stored values the user didn't touch; only fill what's missing.
    const typed = {
      bfr_bia: input.bia?.bfr_bia ?? before.bfr_bia,
      muscleMass_bia: input.bia?.muscleMass_bia ?? before.muscleMass_bia,
      vwc_bia: input.bia?.vwc_bia ?? before.vwc_bia,
      uvi_bia: input.bia?.uvi_bia ?? before.uvi_bia,
    };
    Object.assign(set, before.has_bia_data && !input.bia ? {} : biaFor(user, weightKg, typed, await referenceBia(userId, when, measurementId)));
  } else {
    for (const c of BIA_COLUMNS) set[c] = null;
  }

  const cols = Object.keys(set);
  await query(
    `UPDATE userweights SET ${cols.map(c => `${c} = ?`).join(", ")}, updated_at = NOW() WHERE id = ? AND user_id = ?`,
    [...cols.map(c => set[c]), measurementId, userId]
  );
  await clearStoredReports(userId);
  const after = await getMeasurement(userId, measurementId);
  return { user, before, after };
};

/** Deletes one reading and the rows that point at it, like the backend's own delete. */
export const deleteMeasurement = async (userId, measurementId) => {
  const user = requireUser(await getUser(userId));
  const before = await getMeasurement(userId, measurementId);
  await transaction(async conn => {
    for (const table of ["algorithmresults", "apiresponses", "apirequests"]) {
      await conn.query(`DELETE FROM ${table} WHERE user_weight_id = ? AND user_id = ?`, [measurementId, userId]);
    }
    await conn.query("DELETE FROM userweights WHERE id = ? AND user_id = ?", [measurementId, userId]);
  });
  await clearStoredReports(userId);
  return { user, before };
};

/** Stored weekly reports are a cache; clearing them makes the API rebuild from current data. */
export const clearStoredReports = async userId => {
  const [result] = await pool.query("DELETE FROM user_weekly_reports WHERE user_id = ?", [userId]).catch(() => [{ affectedRows: 0 }]);
  return { cleared: result.affectedRows };
};

export const setTestPassword = async userId => {
  requireTestUser(await getUser(userId));
  await query("UPDATE users SET password = ?, status = 1, is_old_user = 0 WHERE id = ?", [
    await bcrypt.hash(config.testPassword, 10),
    userId,
  ]);
  return { password: config.testPassword };
};

export const setUserGroup = async (userId, { groupId, subgroupId }) => {
  requireTestUser(await getUser(userId));
  const membership = await resolveMembership({ groupId, subgroupId });
  await transaction(async conn => {
    await conn.query("DELETE FROM usergroups WHERE user_id = ?", [userId]);
    await conn.query(
      "INSERT INTO usergroups (user_id, group_id, subgroup_id, status, created_at, updated_at) VALUES (?, ?, ?, 1, NOW(), NOW())",
      [userId, membership.groupId, membership.subgroupId]
    );
  });
  return { ok: true };
};

// ---------- Delete / reset test users ----------

/**
 * Deletes test users the way the backend does: marks them deleted (soft delete),
 * so they disappear from the apps, the dashboard and the overview, while related
 * records stay intact. Real users are never touched.
 */
export const deleteTestUsers = async (ids, actor) => {
  const list = [...new Set((Array.isArray(ids) ? ids : [ids]).map(String))].slice(0, 500);
  if (!list.length) throw badRequest("Pick at least one test user.");
  const rows = await query("SELECT id, email FROM users WHERE id IN (?) AND deleted_at IS NULL", [list]);
  const real = rows.filter(r => !isTestEmail(r.email));
  if (real.length) throw badRequest(`Only test users (${TEST_EMAIL_DOMAIN}) can be deleted. ${real.length} of the selected users are real.`);
  if (!rows.length) return { deleted: 0, users: [] };
  await query("UPDATE users SET deleted_at = NOW(), deleted_by = ? WHERE id IN (?)", [`qa-tool:${actor}`.slice(0, 50), rows.map(r => r.id)]);
  return { deleted: rows.length, users: rows.map(r => r.email) };
};

/**
 * Wipes a test user's measurements and regenerates them from a preset, also
 * resetting the profile values the preset depends on (age, gender, height,
 * account age). The user keeps their id, email, password and group.
 */
export const resetTestUser = async (userId, presetKey) => {
  const user = await getUser(userId);
  requireTestUser(user);
  const guess = PRESETS.find(p => user.email.startsWith(`${p.key}-`));
  const preset = PRESETS.find(p => p.key === presetKey) || guess;
  if (!preset) throw badRequest("Pick a preset to reset this user to.");

  const spec = preset.spec;
  const now = new Date();
  const measurements = generateMeasurements(spec, now);
  let createdAt = addDays(now, -7 * Math.max(0, Number(spec.accountAgeWeeks) || 0));
  if (measurements[0] && measurements[0].measurement_date < createdAt) createdAt = addDays(measurements[0].measurement_date, -1);
  const dob = new Date(Date.UTC(now.getUTCFullYear() - spec.age, 0, 15));

  await transaction(async conn => {
    for (const table of ["algorithmresults", "apiresponses", "apirequests"]) {
      await conn.query(`DELETE FROM ${table} WHERE user_id = ?`, [userId]);
    }
    await conn.query("DELETE FROM userweights WHERE user_id = ?", [userId]);
    await conn.query("DELETE FROM user_weekly_reports WHERE user_id = ?", [userId]).catch(() => undefined);
    await conn.query(
      `UPDATE users SET lastname = ?, gender = ?, date_of_birth = ?, height = ?, weight = ?, language = ?,
              created_at = ?, status = 1, is_old_user = 0, updated_at = NOW() WHERE id = ?`,
      [String(preset.title).slice(0, 60), spec.gender, dob, String(spec.heightCm), spec.startWeightKg, spec.language, createdAt, userId]
    );
    await insertMeasurements(conn, userId, measurements);
  });
  return { user: user.email, preset: preset.key, title: preset.title, measurements: measurements.length };
};
