// Test data cleanup: everything the tool created on dev (test users, "QA " groups,
// test professionals), with "delete what's older than N days". Users, groups and
// professionals are marked deleted the way the backend does; a professional's
// manager/assignment rows (access the tool granted) are removed.
import { QA_GROUP_NAME, TEST_EMAIL_DOMAIN, isTestEmail } from "./config.js";
import { badRequest, query, transaction } from "./db.js";
import { jiraEnabled, listTickets } from "./jira.js";

const DOMAIN = `%${TEST_EMAIL_DOMAIN}`;
const ageDays = d => Math.floor((Date.now() - new Date(d)) / 86400000);
// Scenario users get a back-dated created_at (their "account age"), so the real
// creation time comes from the stamp the tool puts in every test email: …-20261027105819@…
const madeAt = (email, fallback) => {
  const m = String(email).match(/-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\d*)@/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : new Date(fallback);
}

/** Test users linked to open Jira tickets are kept: someone is still working on them. */
const openTicketUsers = async () => {
  if (!jiraEnabled()) return new Map();
  try {
    const { tickets } = await listTickets({ scope: "qa", status: "open", limit: 200 });
    const map = new Map();
    for (const t of tickets) for (const id of t.sinque_ids) map.set(id, [...(map.get(id) || []), t.key]);
    return map;
  } catch {
    return new Map();
  }
};

export const inventory = async () => {
  const [users, groups, pros, tickets] = await Promise.all([
    query(
      `SELECT u.id, u.sinque_id, u.firstname, u.lastname, u.email, u.created_at,
              (SELECT COUNT(*) FROM userweights w WHERE w.user_id = u.id) AS readings,
              (SELECT GROUP_CONCAT(DISTINCT g.name ORDER BY g.name SEPARATOR ', ') FROM usergroups ug JOIN \`groups\` g ON g.id = ug.group_id WHERE ug.user_id = u.id) AS group_names
         FROM users u WHERE u.email LIKE ? AND u.role = 1 AND u.deleted_at IS NULL ORDER BY u.created_at DESC`, [DOMAIN]),
    query(
      `SELECT g.id, g.name, g.created_at,
              (SELECT COUNT(*) FROM subgroups s WHERE s.group_id = g.id AND (s.deleted = 0 OR s.deleted IS NULL)) AS subgroups,
              (SELECT COUNT(DISTINCT u.id) FROM usergroups ug JOIN users u ON u.id = ug.user_id WHERE ug.group_id = g.id AND u.deleted_at IS NULL) AS members,
              (SELECT COUNT(DISTINCT u.id) FROM usergroups ug JOIN users u ON u.id = ug.user_id WHERE ug.group_id = g.id AND u.deleted_at IS NULL AND u.email NOT LIKE ?) AS real_members
         FROM \`groups\` g WHERE g.name LIKE 'QA %' AND (g.deleted = 0 OR g.deleted IS NULL) ORDER BY g.created_at DESC`, [DOMAIN]),
    query(
      `SELECT p.id, p.user_id, p.name, p.email, p.created_at,
              (SELECT COUNT(*) FROM groupmanagers gm WHERE gm.professional_id = p.id) AS group_manager,
              (SELECT COUNT(*) FROM subgroupmanagers sm WHERE sm.professional_id = p.id) AS subgroup_manager,
              (SELECT COUNT(*) FROM professionalgroups pg WHERE pg.professional_id = p.id) AS assigned,
              (SELECT GROUP_CONCAT(DISTINCT g.name ORDER BY g.name SEPARATOR ', ') FROM groupmanagers gm JOIN \`groups\` g ON g.id = gm.group_id
                WHERE gm.professional_id = p.id AND g.name NOT LIKE 'QA %') AS real_groups
         FROM professionals p WHERE p.email LIKE ? AND (p.deleted = 0 OR p.deleted IS NULL) ORDER BY p.created_at DESC`, [DOMAIN]),
    openTicketUsers(),
  ]);
  return {
    users: users.map(u => ({
      id: u.id, sinque_id: u.sinque_id, name: `${u.firstname} ${u.lastname}`.trim(), email: u.email, created_at: madeAt(u.email, u.created_at), age_days: ageDays(madeAt(u.email, u.created_at)),
      readings: Number(u.readings), groups: u.group_names || "", tickets: tickets.get(u.sinque_id) || [],
    })),
    groups: groups.map(g => ({
      id: g.id, name: g.name, created_at: g.created_at, age_days: ageDays(g.created_at),
      subgroups: Number(g.subgroups), members: Number(g.members), real_members: Number(g.real_members), is_default: g.name === QA_GROUP_NAME,
    })),
    professionals: pros.map(p => ({
      id: p.id, name: p.name, email: p.email, created_at: madeAt(p.email, p.created_at), age_days: ageDays(madeAt(p.email, p.created_at)),
      access: Number(p.group_manager) + Number(p.subgroup_manager) + Number(p.assigned), real_groups: p.real_groups || "",
    })),
  };
};

/**
 * What "older than N days" would delete, and what it keeps and why. Groups go only
 * when none of their members stay; users on open tickets and the default group stay.
 */
export const planCleanup = async ({ olderThanDays = 7 } = {}) => {
  const days = Math.max(0, Math.min(3650, Number(olderThanDays)));
  const inv = await inventory();
  const users = [], kept = [];
  for (const u of inv.users) {
    if (u.age_days < days) continue;
    if (u.tickets.length) kept.push({ type: "user", id: u.id, name: u.name, reason: `On open ticket ${u.tickets.join(", ")}` });
    else users.push(u.id);
  }
  const going = new Set(users);
  const staying = inv.users.filter(u => !going.has(u.id));
  const groups = [];
  for (const g of inv.groups) {
    if (g.age_days < days) continue;
    if (g.is_default) { kept.push({ type: "group", id: g.id, name: g.name, reason: "Default group for new test users" }); continue; }
    if (g.real_members) { kept.push({ type: "group", id: g.id, name: g.name, reason: `${g.real_members} real user${g.real_members > 1 ? "s" : ""} in it` }); continue; }
    const stay = staying.filter(u => u.groups.split(", ").includes(g.name)).length;
    if (stay) kept.push({ type: "group", id: g.id, name: g.name, reason: `${stay} test user${stay > 1 ? "s" : ""} in it stay${stay > 1 ? "" : "s"}` });
    else groups.push(g.id);
  }
  const professionals = inv.professionals.filter(p => p.age_days >= days).map(p => p.id);
  return { older_than_days: days, users, groups, professionals, kept, inventory: inv };
};

/** Deletes the given test users, QA groups and test professionals. Anything else is refused. */
export const runCleanup = async ({ users = [], groups = [], professionals = [] }, actor) => {
  const by = `qa-tool:${actor}`.slice(0, 50);
  const uids = [...new Set(users.map(String))];
  const gids = [...new Set(groups.map(Number).filter(Boolean))];
  const pids = [...new Set(professionals.map(String))];
  if (!uids.length && !gids.length && !pids.length) throw badRequest("Nothing selected.");

  const userRows = uids.length ? await query("SELECT id, email FROM users WHERE id IN (?) AND deleted_at IS NULL", [uids]) : [];
  if (userRows.some(r => !isTestEmail(r.email))) throw badRequest("Only test users can be deleted here.");
  const groupRows = gids.length ? await query("SELECT id, name FROM `groups` WHERE id IN (?) AND (deleted = 0 OR deleted IS NULL)", [gids]) : [];
  if (groupRows.some(g => !g.name.startsWith("QA "))) throw badRequest("Only groups whose name starts with “QA ” can be deleted here.");
  const proRows = pids.length ? await query("SELECT id, user_id, email FROM professionals WHERE id IN (?) AND (deleted = 0 OR deleted IS NULL)", [pids]) : [];
  if (proRows.some(p => !isTestEmail(p.email))) throw badRequest("Only test professionals can be deleted here.");
  if (!userRows.length && !groupRows.length && !proRows.length) throw badRequest("Nothing to delete: the selection was already deleted or doesn't exist.");

  const skipped = [];
  await transaction(async conn => {
    if (userRows.length) {
      await conn.query("UPDATE users SET deleted_at = NOW(), deleted_by = ? WHERE id IN (?)", [by, userRows.map(r => r.id)]);
    }
    for (const g of groupRows) {
      // A group goes only when nobody (after the users above) is left in it.
      const [[left]] = await conn.query(
        "SELECT COUNT(DISTINCT u.id) AS n FROM usergroups ug JOIN users u ON u.id = ug.user_id WHERE ug.group_id = ? AND u.deleted_at IS NULL", [g.id]);
      if (Number(left.n)) { skipped.push({ type: "group", id: g.id, name: g.name, reason: `${left.n} user${left.n > 1 ? "s" : ""} still in it` }); continue; }
      await conn.query("UPDATE subgroups SET deleted = 1, updated_at = NOW() WHERE group_id = ?", [g.id]);
      await conn.query("UPDATE `groups` SET deleted = 1, updated_at = NOW() WHERE id = ?", [g.id]);
    }
    if (proRows.length) {
      const ids = proRows.map(p => p.id);
      // Access rows count as access as long as they exist, so they're removed.
      await conn.query("DELETE FROM groupmanagers WHERE professional_id IN (?)", [ids]);
      await conn.query("DELETE FROM subgroupmanagers WHERE professional_id IN (?)", [ids]);
      await conn.query("DELETE FROM professionalgroups WHERE professional_id IN (?)", [ids]);
      await conn.query("UPDATE professionals SET deleted = 1, updated_at = NOW() WHERE id IN (?)", [ids]);
      await conn.query("UPDATE users SET deleted_at = NOW(), deleted_by = ? WHERE id IN (?)", [by, proRows.map(p => p.user_id)]);
    }
  });
  return {
    users: userRows.length,
    groups: groupRows.length - skipped.length,
    professionals: proRows.length,
    skipped,
  };
};
