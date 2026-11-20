// In-app notifications: things a tester should hear about without opening Home.
// Stored in data/notifications.json. A notice goes to one tester ("to") or to everyone
// who can open the project ("*"). Nobody is told about something they did themselves.
import { dataPath, newId, now, readJson, updateJson } from "./store.js";
import { projectsFor } from "./projects.js";

const FILE = dataPath("notifications.json");
const KEEP = 500;

/** Adds a notice. Never throws: a notice must not break the action that caused it. */
export const notify = ({ project, to = "*", actor = null, tone = "info", icon = "info", title, detail = "", link = null }) => {
  try {
    updateJson(FILE, [], all => {
      all.push({ id: newId("n_"), at: now(), project, to: String(to).toLowerCase(), actor: actor ? String(actor).toLowerCase() : null, tone, icon,
        title: String(title).slice(0, 200), detail: String(detail || "").slice(0, 300), link, read_by: [] });
      all.splice(0, Math.max(0, all.length - KEEP));
    });
  } catch (e) {
    console.warn(`[notify] ${e.message}`);
  }
};

const visibleTo = (user, role) => {
  const u = String(user).toLowerCase();
  const projects = new Set(projectsFor(u, role).map(p => p.key));
  return n => projects.has(n.project) && (n.to === "*" || n.to === u) && n.actor !== u;
};

/** The latest notices this tester may see, newest first. */
export const listNotifications = (user, role, limit = 40) => {
  const u = String(user).toLowerCase();
  const mine = readJson(FILE, []).filter(visibleTo(user, role)).reverse();
  return {
    unread: mine.filter(n => !n.read_by.includes(u)).length,
    items: mine.slice(0, limit).map(({ read_by, to, ...n }) => ({ ...n, read: read_by.includes(u) })),
  };
};

/** Marks some notices (or all of them) as read for this tester. */
export const markRead = (user, role, ids) => {
  const u = String(user).toLowerCase(), can = visibleTo(user, role);
  const pick = Array.isArray(ids) ? new Set(ids) : null;
  updateJson(FILE, [], all => {
    for (const n of all) if (can(n) && (!pick || pick.has(n.id)) && !n.read_by.includes(u)) n.read_by.push(u);
  });
  return listNotifications(user, role);
};

const names = (list, n = 3) => list.slice(0, n).join(", ") + (list.length > n ? ` and ${list.length - n} more` : "");

/** API check results: tell the project when checks start failing or come back. */
export const notifyApiRuns = (project, prevLast, runs) => {
  const broke = [], fixed = [];
  for (const r of runs) {
    const before = prevLast.get(r.check_id);
    if (!r.pass && (!before || before.pass)) broke.push(r.name);
    if (r.pass && before && !before.pass) fixed.push(r.name);
  }
  const actor = runs[0]?.by || null;
  if (broke.length) notify({ project: project.key, actor, tone: "bad", icon: "cloud", title: broke.length === 1 ? `API check “${broke[0]}” started failing` : `${broke.length} API checks started failing`, detail: broke.length === 1 ? `In ${project.name}` : names(broke), link: { view: "apichecks" } });
  if (fixed.length) notify({ project: project.key, actor, tone: "good", icon: "check", title: fixed.length === 1 ? `API check “${fixed[0]}” is passing again` : `${fixed.length} API checks are passing again`, detail: fixed.length === 1 ? `In ${project.name}` : names(fixed), link: { view: "apichecks" } });
};

/** A UI test result: tell the project when it starts failing or recovers. */
export const notifyUiRun = (project, before, run) => {
  if (!run.pass && (!before || before.pass)) notify({ project: project.key, actor: run.by, tone: "bad", icon: "play", title: `UI test failing: ${run.case_title}`, detail: run.failed_step ? `Step ${run.failed_step} failed on ${run.environment}` : `On ${run.environment}`, link: { view: "cases", case: run.case_id } });
  if (run.pass && before && !before.pass) notify({ project: project.key, actor: run.by, tone: "good", icon: "check", title: `UI test passing again: ${run.case_title}`, detail: `On ${run.environment}`, link: { view: "cases", case: run.case_id } });
};

/** Someone recorded a new failure in a run another tester started. */
export const notifyRunFailure = (project, run, caseTitle, actor) => {
  if (!run.created_by || run.created_by === actor) return;
  notify({ project: project.key, to: run.created_by, actor, tone: "warn", icon: "play", title: `New failure in your run “${run.name}”`, detail: `${caseTitle} · marked failed by ${actor}`, link: { view: "runs", run: run.id } });
};

/** A tester was given cases to test in a run. */
export const notifyAssigned = (project, run, who, n, actor) => notify({
  project: project.key, to: who, actor, tone: "info", icon: "user-check",
  title: `${n} case${n === 1 ? "" : "s"} assigned to you in “${run.name}”`,
  detail: `By ${actor}${run.release ? ` · release ${run.release}` : ""}`, link: { view: "mywork" },
});

/** Environment health changed: down, or back up. */
export const notifyHealth = (project, env, target, down) => notify({
  project: project.key, tone: down ? "bad" : "good", icon: down ? "cloud" : "check",
  title: down ? `${env.name} · ${target.name} is down` : `${env.name} · ${target.name} is back up`,
  detail: env.base_url ? `${env.base_url}${target.path}` : "", link: { view: "home" },
});
