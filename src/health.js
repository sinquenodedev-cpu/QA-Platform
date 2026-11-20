// Environment health: every 5 minutes the tool asks each environment's health
// addresses for an answer (GET only) and keeps the last 288 results (a day).
import { allProjects } from "./projects.js";
import { notifyHealth } from "./notify.js";

const EVERY_MS = 5 * 60 * 1000;
const KEEP = 288;
const history = new Map(); // "PROJECT/env/name" -> [{ at, ok, status, ms, error }]

const probe = async (env, target) => {
  const started = Date.now();
  try {
    const res = await fetch(`${env.base_url}${target.path}`, { method: "GET", signal: AbortSignal.timeout(10000), redirect: "manual" });
    // expect_status 0 = any answer below 500 counts as up.
    const ok = target.expect_status ? res.status === target.expect_status : res.status < 500;
    return { ok, status: res.status, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - started, error: e.name === "TimeoutError" ? "No answer within 10 seconds" : e.cause?.code || e.message };
  }
};

export const checkAll = async () => {
  for (const p of allProjects()) {
    for (const env of p.environments) {
      if (!env.base_url) continue;
      for (const t of env.health) {
        const key = `${p.key}/${env.id}/${t.name}`;
        const r = { at: new Date().toISOString(), ...(await probe(env, t)) };
        const list = history.get(key) || [];
        const prev = list.at(-1);
        if (prev && prev.ok !== r.ok) notifyHealth(p, env, t, !r.ok);
        list.push(r);
        history.set(key, list.slice(-KEEP));
      }
    }
  }
};

export const startHealth = () => {
  checkAll().catch(() => {});
  setInterval(() => checkAll().catch(() => {}), EVERY_MS).unref();
};

/** Health per environment of a project: latest result, uptime and a short history. */
export const projectHealth = project => project.environments.map(env => ({
  id: env.id, name: env.name, base_url: env.base_url, production: env.production,
  targets: env.health.map(t => {
    const list = history.get(`${project.key}/${env.id}/${t.name}`) || [];
    const last = list.at(-1) || null;
    return {
      name: t.name, path: t.path, last,
      uptime: list.length ? Math.round((list.filter(r => r.ok).length / list.length) * 1000) / 10 : null,
      recent: list.slice(-48).map(r => ({ ok: r.ok, ms: r.ms, at: r.at, status: r.status })),
    };
  }),
}));
