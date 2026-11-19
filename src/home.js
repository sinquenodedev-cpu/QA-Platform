// Everything the home page shows, in one call. Each part fails on its own, so a
// Jira or database hiccup doesn't blank the page.
import { readAudit } from "./audit.js";
import { presetRuns } from "./checks.js";
import { TEST_EMAIL_DOMAIN } from "./config.js";
import { query } from "./db.js";
import { jiraEnabled, listTickets } from "./jira.js";

const settle = async fn => {
  try { return await fn(); } catch (error) { return { error: error.message }; }
};

export const homeData = async () => {
  const domain = `%${TEST_EMAIL_DOMAIN}`;
  const [counts, jira, activity] = await Promise.all([
    settle(async () => {
      const [[users], [groups], [pros], [measured]] = await Promise.all([
        query("SELECT COUNT(*) n, SUM(created_at >= NOW() - INTERVAL 7 DAY) week FROM users WHERE email LIKE ? AND deleted_at IS NULL", [domain]),
        query("SELECT COUNT(*) n, SUM(created_at >= NOW() - INTERVAL 7 DAY) week FROM `groups` WHERE name LIKE 'QA %' AND (deleted = 0 OR deleted IS NULL)"),
        query("SELECT COUNT(*) n FROM professionals WHERE email LIKE ? AND (deleted = 0 OR deleted IS NULL)", [domain]),
        query(`SELECT COUNT(*) n FROM userweights w JOIN users u ON u.id = w.user_id
               WHERE u.email LIKE ? AND u.deleted_at IS NULL AND w.measurement_date >= NOW() - INTERVAL 7 DAY`, [domain]),
      ]);
      return {
        test_users: Number(users.n), test_users_week: Number(users.week || 0),
        qa_groups: Number(groups.n), qa_groups_week: Number(groups.week || 0),
        test_professionals: Number(pros.n),
        readings_week: Number(measured.n),
      };
    }),
    jiraEnabled() ? settle(() => listTickets({ scope: "qa", limit: 50 })) : null,
    settle(() => readAudit({ limit: 12 })),
  ]);
  const runs = presetRuns();
  return {
    counts,
    preset_runs: runs.slice(-10).reverse(),
    jira,
    activity,
  };
};
