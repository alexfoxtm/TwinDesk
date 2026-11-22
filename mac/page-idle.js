// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Build the settings page that is about to be shown, then the others one at a time
// while the browser is idle. Search, a deep link, the tour and the keyboard each
// call ensureAll before they look at every page. Loaded by mac/control.html only.
'use strict';

function createQueue(run) {
  const jobs = [];
  let scheduled = false;
  return {
    add(id) { jobs.push({ id, done: false }); },
    ensure(id) {
      const job = jobs.find((j) => j.id === id);
      if (!job || job.done) return false;
      job.done = true;
      run(id);
      return true;
    },
    ensureAll() {
      const ids = [];
      for (const job of jobs) {
        if (job.done) continue;
        job.done = true;
        ids.push(job.id);
        run(job.id);
      }
      return ids;
    },
    schedule(later) {
      if (scheduled) return;
      scheduled = true;
      const step = () => {
        const job = jobs.find((j) => !j.done);
        if (!job) return;
        job.done = true;
        run(job.id);
        if (jobs.some((j) => !j.done)) later(step);
      };
      later(step);
    },
    pending() { return jobs.filter((j) => !j.done).map((j) => j.id); },
  };
}

const api = { createQueue };
if (typeof module === 'object' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.PageIdle = api;
