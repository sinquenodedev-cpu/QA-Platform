// Projects: one per product the team tests. Sinque is built in and keeps its own
// "pack" (database, rule checks, scenarios); any other project gets the general
// QA features: test cases, runs, API checks, environment health and Jira.
import { config } from "./config.js";
import { badRequest } from "./db.js";
import { dataPath, now, readJson, writeJson } from "./store.js";

const FILE = dataPath("projects.json");

const SINQUE = () => ({
  key: "SINQUE",
  name: "Sinque",
  pack: "sinque",
  color: "#0e7490",
  jira_project: config.jira.project,
  members: [],
  environments: [{
    id: "dev", name: "DEV", base_url: config.apiBaseUrl, app_url: (config.dashboardUrl || "").replace(/\/+$/, ""), production: false,
    health: [{ name: "API", path: "/", expect_status: 0 }],
  }],
  created_at: "2026-10-01T00:00:00.000Z",
});

const isProdUrl = url => /prod/i.test(String(url || ""));

const clean = (p, existing) => {
  const key = String(p.key || existing?.key || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(key)) throw badRequest("The project key is 2–10 letters or digits, starting with a letter (e.g. ACME).");
  const name = String(p.name ?? existing?.name ?? "").trim();
  if (!name) throw badRequest("Give the project a name.");
  const envs = (Array.isArray(p.environments) ? p.environments : existing?.environments || []).map((e, i) => {
    const base = String(e.base_url || "").trim().replace(/\/+$/, "");
    if (base && !/^https?:\/\//i.test(base)) throw badRequest(`Environment “${e.name || i + 1}”: the address must start with http:// or https://.`);
    const app = String(e.app_url || "").trim().replace(/\/+$/, "");
    if (app && !/^https?:\/\//i.test(app)) throw badRequest(`Environment “${e.name || i + 1}”: the app address must start with http:// or https://.`);
    return {
      id: String(e.id || e.name || `env${i + 1}`).trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 20) || `env${i + 1}`,
      name: String(e.name || `Environment ${i + 1}`).trim().slice(0, 30),
      base_url: base,
      // Where the web app is, for UI tests (when it isn't the API's address).
      app_url: app,
      // Anything that looks like production is treated as production: read-only checks only.
      production: !!e.production || isProdUrl(base) || isProdUrl(app),
      health: (Array.isArray(e.health) ? e.health : []).slice(0, 10).map(h => ({
        name: String(h.name || h.path || "Check").slice(0, 40),
        path: String(h.path || "/").startsWith("/") ? String(h.path || "/") : `/${h.path}`,
        expect_status: Number(h.expect_status) || 0,
      })),
    };
  });
  return {
    key, name,
    pack: existing?.pack || null,
    color: /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : existing?.color || "#7c3aed",
    jira_project: String(p.jira_project ?? existing?.jira_project ?? "").trim().toUpperCase(),
    members: (Array.isArray(p.members) ? p.members : existing?.members || []).map(m => String(m).toLowerCase()).filter(Boolean),
    environments: envs,
    created_at: existing?.created_at || now(),
  };
};

export const allProjects = () => {
  const saved = readJson(FILE, []);
  const sinque = saved.find(p => p.key === "SINQUE");
  // Sinque's DEV connection always comes from .env, so it can't drift from the database the tool uses.
  const builtIn = { ...SINQUE(), ...(sinque || {}), pack: "sinque" };
  builtIn.environments = [SINQUE().environments[0], ...(sinque?.environments || []).filter(e => e.id !== "dev")];
  return [builtIn, ...saved.filter(p => p.key !== "SINQUE")];
};

/** Projects this tester may open (members empty = everyone). */
export const projectsFor = (user, role) =>
  allProjects().filter(p => role === "admin" || !p.members.length || p.members.includes(String(user).toLowerCase()));

export const getProject = (key, user, role) => {
  const p = projectsFor(user, role).find(x => x.key === String(key || "SINQUE").toUpperCase());
  if (!p) throw Object.assign(new Error("That project doesn't exist or you don't have access to it."), { status: 404 });
  return p;
};

export const environment = (project, envId) => {
  const e = project.environments.find(x => x.id === envId) || project.environments[0];
  if (!e) throw badRequest(`${project.name} has no environments yet. An admin can add one under Projects.`);
  if (!e.base_url) throw badRequest(`Environment ${e.name} has no address yet.`);
  return e;
};

export const saveProject = body => {
  const saved = readJson(FILE, []);
  const existing = allProjects().find(p => p.key === String(body.key || "").toUpperCase());
  if (body.create && existing) throw badRequest(`There's already a project with the key ${existing.key}.`);
  const p = clean(body, body.create ? null : existing);
  if (p.key === "SINQUE") {
    // Only the extras can change for Sinque; its DEV connection and pack are fixed.
    p.pack = "sinque";
    p.environments = p.environments.filter(e => e.id !== "dev");
  }
  writeJson(FILE, [...saved.filter(x => x.key !== p.key), p]);
  return allProjects().find(x => x.key === p.key);
};

export const deleteProject = key => {
  if (String(key).toUpperCase() === "SINQUE") throw badRequest("Sinque is built in and can't be removed.");
  const saved = readJson(FILE, []);
  if (!saved.some(p => p.key === key)) throw Object.assign(new Error("Project not found."), { status: 404 });
  writeJson(FILE, saved.filter(p => p.key !== key));
  return { removed: key };
};
