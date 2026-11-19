// Jira coverage: for the tickets in the open sprint (or open tickets), which have
// test cases, whether they've been run, and whether they pass. Counts both the
// test cases written on the ticket page and project test cases linked to the ticket.
import { readTestCases, sprintTickets } from "./jira.js";
import { listCases, listRuns, getRun } from "./testmgmt.js";

/** Latest result per project test case, across runs (newest run first). */
const latestResults = project => {
  const latest = new Map();
  for (const summary of listRuns(project)) {
    let run;
    try { run = getRun(project, summary.id); } catch { continue; }
    for (const [caseId, r] of Object.entries(run.results || {})) {
      if (!latest.has(caseId)) latest.set(caseId, { status: r.status, at: r.at, run: run.name, run_id: run.id });
    }
  }
  return latest;
};

export const jiraCoverage = async project => {
  const data = await sprintTickets(project.jira_project);
  const cases = listCases(project);
  const results = latestResults(project);
  const tickets = data.tickets.map(t => {
    const own = readTestCases(t.key)?.test_cases || [];
    const linked = cases.filter(c => (c.jira || []).includes(t.key));
    const linkedResults = linked.map(c => results.get(c.id)).filter(Boolean);
    const passed = own.filter(c => c.result?.pass === true).length + linkedResults.filter(r => r.status === "passed").length;
    const failed = own.filter(c => c.result?.pass === false).length + linkedResults.filter(r => r.status === "failed" || r.status === "blocked").length;
    const total = own.length + linked.length;
    const automated = linked.filter(c => c.automation?.steps?.length).length;
    const status = !total ? "none" : failed ? "failing" : passed === total ? "passing" : passed ? "partial" : "not_run";
    return {
      key: t.key, url: t.url, summary: t.summary, type: t.type, type_icon: t.type_icon, status: t.status, status_category: t.status_category,
      assignee: t.assignee, sprint: t.sprint,
      cases: { total, own: own.length, linked: linked.map(c => ({ id: c.id, title: c.title, result: results.get(c.id)?.status || null })), passed, failed, automated },
      coverage: status,
    };
  });
  const count = s => tickets.filter(t => t.coverage === s).length;
  const withCases = tickets.filter(t => t.cases.total).length;
  return {
    mode: data.mode, sprints: data.sprints, project: data.project, base_url: data.base_url,
    total: tickets.length, with_cases: withCases, percent: tickets.length ? Math.round((withCases / tickets.length) * 100) : 0,
    counts: { none: count("none"), not_run: count("not_run"), partial: count("partial"), failing: count("failing"), passing: count("passing") },
    tickets,
  };
};
