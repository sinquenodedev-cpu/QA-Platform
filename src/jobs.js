// Background jobs: long checks run on the server while the tester keeps working.
// The page polls /api/jobs for progress. Jobs live in memory, so a restart clears them.
const jobs = new Map();
let seq = 0;
const KEEP_MS = 12 * 60 * 60 * 1000;

const summary = j => ({
  id: j.id, kind: j.kind, title: j.title, actor: j.actor, link: j.link,
  status: j.status, progress: j.progress, outcome: j.outcome, error: j.error,
  started_at: j.started_at, finished_at: j.finished_at,
});

const prune = () => {
  const cutoff = Date.now() - KEEP_MS;
  for (const [id, j] of jobs) if (j.finished_at && new Date(j.finished_at) < cutoff) jobs.delete(id);
};

/**
 * Starts fn(progress) in the background and returns the job right away.
 * progress(done, total, label) updates what the page shows. outcome(result) turns the
 * result into a one-line { text, ok } for the panel and the notification.
 */
export const startJob = ({ kind, title, actor, link = null, outcome = () => null }, fn) => {
  prune();
  const job = {
    id: `${Date.now().toString(36)}${(++seq).toString(36)}`,
    kind, title, actor, link,
    status: "running",
    progress: { done: 0, total: null, label: "Starting…" },
    started_at: new Date().toISOString(), finished_at: null,
    result: null, outcome: null, error: null,
  };
  jobs.set(job.id, job);
  const progress = (done, total, label) => Object.assign(job.progress, { done, total, ...(label ? { label } : {}) });
  Promise.resolve()
    .then(() => fn(progress))
    .then(result => {
      job.result = result;
      job.outcome = outcome(result);
      job.status = "done";
    })
    .catch(error => {
      job.status = "failed";
      job.error = error.message;
      console.error(`Job ${job.kind} (${job.id}) failed:`, error.message);
    })
    .finally(() => { job.finished_at = new Date().toISOString(); });
  return summary(job);
};

/** The tester's recent jobs, newest first. */
export const listJobs = actor => [...jobs.values()].filter(j => j.actor === actor).reverse().slice(0, 20).map(summary);

/** One job with its result (only for the tester who started it). */
export const getJob = (id, actor) => {
  const j = jobs.get(id);
  if (!j || j.actor !== actor) throw Object.assign(new Error("Job not found. It may have finished before the tool restarted."), { status: 404 });
  return { ...summary(j), result: j.result };
};
