/** Track queued and running memory-distillation work by session. */
export function createActivityTracker() {
  const sessions = new Map();
  let revision = 0;

  return {
    begin(sessionId, cancel = null) {
      const id = String(sessionId ?? "");
      const task = { cancel, cancelRequested: false };
      const tasks = sessions.get(id) ?? new Set();
      tasks.add(task);
      sessions.set(id, tasks);
      revision++;
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        const current = sessions.get(id);
        current?.delete(task);
        if (!current?.size) sessions.delete(id);
        revision++;
      };
    },
    cancel(sessionId) {
      const tasks = sessions.get(String(sessionId ?? ""));
      if (!tasks) return 0;
      let cancelled = 0;
      for (const task of tasks) {
        if (task.cancelRequested) continue;
        task.cancelRequested = true;
        cancelled++;
        try { task.cancel?.(); } catch { /* cancellation stays best-effort */ }
      }
      if (cancelled) revision++;
      return cancelled;
    },
    snapshot() {
      let tasks = 0;
      for (const entries of sessions.values()) tasks += entries.size;
      return {
        active: tasks > 0,
        tasks,
        sessions: [...sessions.keys()].filter(Boolean),
        revision
      };
    }
  };
}
