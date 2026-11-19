// Groups, subgroups and professionals for QA.
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { TEST_EMAIL_DOMAIN, config, isTestEmail } from "./config.js";
import { badRequest, pool, query, transaction } from "./db.js";

const code = () => crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
const slugify = s => String(s || "qa").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);

export const listGroups = async ({ q = "" } = {}) => {
  const groups = await query(
    `SELECT g.id, g.name, g.group_code, g.language, g.status,
            (SELECT COUNT(*) FROM usergroups ug WHERE ug.group_id = g.id) AS members
     FROM \`groups\` g
     WHERE (g.deleted = 0 OR g.deleted IS NULL) ${q.trim() ? "AND g.name LIKE ?" : ""}
     ORDER BY g.id DESC
     LIMIT 200`,
    q.trim() ? [`%${q.trim()}%`] : []
  );
  if (!groups.length) return [];
  const subgroups = await query(
    `SELECT sg.id, sg.group_id, sg.name, sg.subgroup_code,
            (SELECT COUNT(*) FROM usergroups ug WHERE ug.subgroup_id = sg.id) AS members
     FROM subgroups sg
     WHERE sg.group_id IN (?) AND (sg.deleted = 0 OR sg.deleted IS NULL)
     ORDER BY sg.name`,
    [groups.map(g => g.id)]
  );
  return groups.map(g => ({ ...g, subgroups: subgroups.filter(s => s.group_id === g.id) }));
};

export const createGroup = async ({ name, language = "EN" }) => {
  if (!name?.trim()) throw badRequest("Group name is required.");
  const [result] = await pool.query(
    `INSERT INTO \`groups\` (name, business_name, language, status, group_code, deleted, start_date, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, 0, NOW(), NOW(), NOW())`,
    [`QA ${name.trim()}`, "Created by QA platform", language, code()]
  );
  return { id: result.insertId };
};

export const createSubgroup = async ({ groupId, name, language = "EN", showWeights = true }) => {
  if (!groupId || !name?.trim()) throw badRequest("Group and subgroup name are required.");
  const [result] = await pool.query(
    `INSERT INTO subgroups (group_id, name, language, show_weights, status, subgroup_code, deleted, start_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, 0, NOW(), NOW(), NOW())`,
    [Number(groupId), `QA ${name.trim()}`, language, showWeights ? 1 : 0, code()]
  );
  return { id: result.insertId };
};

export const listProfessions = () => query("SELECT id, profession FROM professions WHERE status = 1 OR status IS NULL ORDER BY profession");

export const listProfessionals = async ({ testOnly = true } = {}) => {
  const professionals = await query(
    `SELECT p.id, p.user_id, p.name, p.email, p.is_enable_dashboard, p.status, pr.profession, u.created_at
     FROM professionals p
     JOIN users u ON u.id = p.user_id
     LEFT JOIN professions pr ON pr.id = p.profession_id
     WHERE (p.deleted = 0 OR p.deleted IS NULL) ${testOnly ? "AND p.email LIKE ?" : ""}
     ORDER BY u.created_at DESC
     LIMIT 100`,
    testOnly ? [`%${TEST_EMAIL_DOMAIN}`] : []
  );
  if (!professionals.length) return [];
  const ids = professionals.map(p => p.id);
  const access = await query(
    `SELECT 'direct' AS via, pg.professional_id, g.name AS group_name, sg.name AS subgroup_name
       FROM professionalgroups pg LEFT JOIN \`groups\` g ON g.id = pg.group_id LEFT JOIN subgroups sg ON sg.id = pg.subgroup_id
       WHERE pg.professional_id IN (?)
     UNION ALL
     SELECT 'group manager', gm.professional_id, g.name, NULL
       FROM groupmanagers gm LEFT JOIN \`groups\` g ON g.id = gm.group_id
       WHERE gm.professional_id IN (?)
     UNION ALL
     SELECT 'subgroup manager', sm.professional_id, g.name, sg.name
       FROM subgroupmanagers sm LEFT JOIN subgroups sg ON sg.id = sm.subgroup_id LEFT JOIN \`groups\` g ON g.id = sg.group_id
       WHERE sm.professional_id IN (?)`,
    [ids, ids, ids]
  );
  return professionals.map(p => ({
    ...p,
    is_test: isTestEmail(p.email),
    access: access.filter(a => a.professional_id === p.id),
  }));
};

/** A professional is a role-5 user plus a professionals row; dashboard login uses TEST_PASSWORD. */
export const createProfessional = async ({ name, professionId, language = "EN", dashboard = true }) => {
  if (!name?.trim()) throw badRequest("Name is required.");
  if (!professionId) throw badRequest("Pick a profession.");
  const email = `pro-${slugify(name)}-${Date.now().toString(36)}${TEST_EMAIL_DOMAIN}`;
  const userId = crypto.randomUUID();
  const [firstname, ...rest] = name.trim().split(/\s+/);
  const password = await bcrypt.hash(config.testPassword, 10);

  const professionalId = crypto.randomUUID();
  await transaction(async conn => {
    await conn.query(
      `INSERT INTO users (id, firstname, lastname, email, password, role, status, is_old_user, language, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 5, 1, 0, ?, NOW(), NOW())`,
      [userId, firstname, rest.join(" ") || "QA", email, password, language]
    );
    await conn.query(
      `INSERT INTO professionals (id, user_id, name, email, email_dashboard, profession_id, language, status, deleted,
                                  is_enable_dashboard, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, NOW(), NOW())`,
      [professionalId, userId, name.trim(), email, email, professionId, language, dashboard ? 1 : 0]
    );
  });

  return { id: professionalId, user_id: userId, email, password: config.testPassword };
};

const requireTestProfessional = async professionalId => {
  const [p] = await query("SELECT id, user_id, email FROM professionals WHERE id = ?", [professionalId]);
  if (!p) throw badRequest("Professional not found.");
  if (!isTestEmail(p.email)) throw badRequest(`Only test professionals (${TEST_EMAIL_DOMAIN}) can be changed from the QA platform.`);
  return p;
};

/**
 * Gives a test professional access to a group or subgroup, the three ways the
 * backend supports: direct assignment, group manager, or subgroup manager.
 */
export const assignProfessional = async ({ professionalId, via, groupId, subgroupId }) => {
  const p = await requireTestProfessional(professionalId);
  if (via === "direct") {
    if (!groupId) throw badRequest("Pick a group.");
    await query(
      "INSERT INTO professionalgroups (professional_id, group_id, subgroup_id, status, created_at, updated_at) VALUES (?, ?, ?, 1, NOW(), NOW())",
      [p.id, Number(groupId), subgroupId ? Number(subgroupId) : null]
    );
  } else if (via === "group-manager") {
    if (!groupId) throw badRequest("Pick a group.");
    await query(
      "INSERT INTO groupmanagers (group_id, user_id, professional_id, status, created_at, updated_at) VALUES (?, ?, ?, 1, NOW(), NOW())",
      [Number(groupId), p.user_id, p.id]
    );
  } else if (via === "subgroup-manager") {
    if (!subgroupId) throw badRequest("Pick a subgroup.");
    await query(
      "INSERT INTO subgroupmanagers (subgroup_id, user_id, professional_id, status, created_at, updated_at) VALUES (?, ?, ?, 1, NOW(), NOW())",
      [Number(subgroupId), p.user_id, p.id]
    );
  } else {
    throw badRequest("Unknown access type.");
  }
  return { ok: true };
};

export const resetProfessionalPassword = async professionalId => {
  const p = await requireTestProfessional(professionalId);
  await query("UPDATE users SET password = ?, status = 1, is_old_user = 0 WHERE id = ?", [
    await bcrypt.hash(config.testPassword, 10),
    p.user_id,
  ]);
  return { password: config.testPassword };
};
