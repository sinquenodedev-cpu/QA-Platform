// Home page overview for one project: what's there, how it's doing, and what needs attention.
// Read-only and cheap: everything comes from files in data/ and the in-memory health history.
import { getRun, listCases, listRuns, listSuites } from "./testmgmt.js";
import { projectsFor } from "./projects.js";
import { listChecks } from "./apichecks.js";
import { listUiRuns } from "./uiauto.js";
import { projectHealth } from "./health.js";
import { readAudit } from "./audit.js";
import { aiEnabled } from "./ai/llm.js";
import { jiraEnabled } from "./jira.js";
import { config, sinqueDbSet } from "./config.js";

const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
const DAY = 24 * 60 * 60 * 1000;

export const overview = project => {
  const sinque = project.pack === "sinque";
  const cases = listCases(project);
  const suites = listSuites(project);
  const runs = listRuns(project);
  const checks = listChecks(project).filter(c => c.enabled);
  const uiRuns = listUiRuns(project);
  const health = projectHealth(project);

  // ---- test cases ----
  const automated = cases.filter(c => c.automation?.steps?.length);
  const byPriority = { high: 0, medium: 0, low: 0 };
  for (const c of cases) if (c.priority in byPriority) byPriority[c.priority]++;

  // ---- test runs ----
  const open = runs.filter(r => r.status === "open");
  const closed = runs.filter(r => r.status === "closed");
  const lastClosed = closed[0] || null;
  const tested = r => r.total - r.counts.untested;
  const runView = r => r && {
    id: r.id, name: r.name, release: r.release || "", environment: r.environment || "", created_at: r.created_at, closed_at: r.closed_at || null,
    counts: r.counts, total: r.total, tested: tested(r), pass_rate: pct(r.counts.passed, tested(r)),
  };
  // Cases that have been in a run within the last 30 days.
  const recentCaseIds = new Set();
  const since = Date.now() - 30 * DAY;
  // listRuns hides results, but case_ids are kept: a case "in a recent run" counts as covered.
  for (const r of runs) if (Date.parse(r.created_at) >= since) for (const id of r.case_ids || []) recentCaseIds.add(id);
  const highNotRun = cases.filter(c => c.priority === "high" && !recentCaseIds.has(c.id));

  // ---- API checks ----
  const ran = checks.filter(c => c.last);
  const failing = ran.filter(c => !c.last.pass);
  const lastApiAt = ran.reduce((m, c) => (c.last.at > m ? c.last.at : m), "");

  // ---- UI automation: the latest result per case ----
  const latestUi = new Map();
  for (const r of uiRuns) if (!latestUi.has(r.case_id)) latestUi.set(r.case_id, r);
  const uiLatest = [...latestUi.values()];
  const uiFailing = uiLatest.filter(r => !r.pass);

  // ---- environments ----
  const targets = health.flatMap(e => e.targets.map(t => ({ env: e.name, base_url: e.base_url, production: e.production, ...t })));
  const down = targets.filter(t => t.last && !t.last.ok);
  const withAddress = project.environments.filter(e => e.base_url);

  // ---- what needs attention, most important first ----
  const attention = [];
  for (const t of down) attention.push({ tone: "bad", icon: "cloud", title: `${t.env} · ${t.name} is down`, detail: t.last.error || `Answered ${t.last.status}`, view: "home" });
  if (failing.length) attention.push({ tone: "bad", icon: "cloud", title: `${failing.length} API check${failing.length === 1 ? "" : "s"} failing`, detail: failing.slice(0, 3).map(c => c.name).join(", ") + (failing.length > 3 ? "…" : ""), view: "apichecks", action: "Open API checks" });
  if (uiFailing.length) attention.push({ tone: "bad", icon: "play", title: `${uiFailing.length} automated UI test${uiFailing.length === 1 ? "" : "s"} failing`, detail: uiFailing.slice(0, 3).map(r => r.case_title).join(", ") + (uiFailing.length > 3 ? "…" : ""), view: "cases", action: "Open test cases" });
  for (const r of open.filter(r => r.counts.failed).slice(0, 2)) attention.push({ tone: "warn", icon: "play", title: `${r.counts.failed} failed in “${r.name}”`, detail: `${tested(r)}/${r.total} tested so far`, run: r.id, action: "Open run" });
  if (highNotRun.length) attention.push({ tone: "warn", icon: "list", title: `${highNotRun.length} high-priority case${highNotRun.length === 1 ? "" : "s"} not run in 30 days`, detail: highNotRun.slice(0, 3).map(c => c.title).join(", ") + (highNotRun.length > 3 ? "…" : ""), view: "runs", action: "Start a run" });
  const stale = open.filter(r => Date.parse(r.created_at) < Date.now() - 14 * DAY);
  if (stale.length) attention.push({ tone: "info", icon: "play", title: `${stale.length} run${stale.length === 1 ? "" : "s"} open for over 2 weeks`, detail: "Close finished runs so reports stay accurate.", view: "runs", action: "Review runs" });
  if (checks.length && ran.length && lastApiAt && Date.parse(lastApiAt) < Date.now() - 7 * DAY) attention.push({ tone: "info", icon: "cloud", title: "API checks haven't run this week", detail: `Last run ${lastApiAt.slice(0, 10)}`, view: "apichecks", action: "Run them" });

  // ---- getting set up ----
  const setup = [
    { key: "env", done: withAddress.length > 0, label: "Add an environment address", hint: "Where the app and API live, for health and API checks", view: "projects", admin: true },
    ...(sinque ? [{ key: "sinque", done: sinqueDbSet() && !!config.apiBaseUrl, label: "Connect the Sinque DEV database and API", hint: "Settings → Sinque database and Sinque app", view: "settings", admin: true }] : []),
    { key: "cases", done: cases.length > 0, label: "Write your first test cases", hint: "By hand, from a Jira ticket with AI, or imported", view: "cases" },
    { key: "api", done: checks.length > 0, label: "Add API checks", hint: "Import a Postman collection or an OpenAPI spec", view: "apichecks" },
    { key: "jira", done: !!project.jira_project && jiraEnabled(), label: project.jira_project ? "Connect your Jira account" : "Link a Jira project", hint: project.jira_project ? "The Jira button next to your name" : "Team → Projects → Jira project key", view: project.jira_project ? "jira-me" : "projects" },
    { key: "ai", done: aiEnabled(), label: "Turn on AI", hint: "Settings → AI: writes test cases and automation steps", view: "settings", admin: true },
  ];

  // ---- a readiness score you can explain: average of the parts that have data ----
  const parts = [
    { label: "Last test run", value: lastClosed ? pct(lastClosed.counts.passed, tested(lastClosed)) : open[0] && tested(open[0]) ? pct(open[0].counts.passed, tested(open[0])) : null },
    { label: "API checks", value: pct(ran.length - failing.length, ran.length) },
    { label: "UI automation", value: pct(uiLatest.length - uiFailing.length, uiLatest.length) },
    { label: "Environments up", value: pct(targets.filter(t => t.last?.ok).length, targets.filter(t => t.last).length) },
  ];
  const known = parts.filter(p => p.value != null);
  const score = known.length ? Math.round(known.reduce((s, p) => s + p.value, 0) / known.length) : null;

  const activity = readAudit({ limit: 400 }).entries
    .filter(e => e.project === project.key || (sinque && !e.project))
    .slice(0, 8);

  return {
    project: { key: project.key, name: project.name, pack: project.pack || null, color: project.color, jira_project: project.jira_project || "" },
    readiness: { score, parts },
    cases: { total: cases.length, suites: suites.length, automated: automated.length, by_priority: byPriority, high_not_run: highNotRun.length },
    runs: { total: runs.length, open: open.slice(0, 4).map(runView), open_count: open.length, last_closed: runView(lastClosed) },
    api: { total: checks.length, ran: ran.length, passing: ran.length - failing.length, failing: failing.length, last_at: lastApiAt || null },
    ui: { cases: uiLatest.length, passing: uiLatest.length - uiFailing.length, failing: uiFailing.length, last_at: uiRuns[0]?.at || null },
    health,
    attention: attention.slice(0, 6),
    setup,
    activity,
  };
};

/** "My work": the cases assigned to this tester in open runs, in every project they can open. */
export const myWork = (user, role) => {
  const me = String(user).toLowerCase(), rank = { high: 0, medium: 1, low: 2 };
  const runs = [];
  for (const p of projectsFor(me, role)) {
    for (const s of listRuns(p).filter(r => r.status === "open")) {
      const mine = Object.entries(s.assignees || {}).filter(([, who]) => who === me).map(([id]) => id);
      if (!mine.length) continue;
      const r = getRun(p, s.id);
      const cases = r.cases.filter(c => mine.includes(c.id)).map(c => ({ id: c.id, title: c.title, priority: c.priority, status: r.results[c.id]?.status || "untested" }));
      const todo = cases.filter(c => c.status === "untested").sort((a, b) => (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1));
      runs.push({
        project: { key: p.key, name: p.name, color: p.color }, run: { id: r.id, name: r.name, release: r.release, environment: r.environment, created_at: r.created_at },
        total: cases.length, done: cases.length - todo.length, failed: cases.filter(c => c.status === "failed").length, blocked: cases.filter(c => c.status === "blocked").length, todo,
      });
    }
  }
  runs.sort((a, b) => b.todo.length - a.todo.length);
  return { runs, todo: runs.reduce((n, r) => n + r.todo.length, 0) };
};
