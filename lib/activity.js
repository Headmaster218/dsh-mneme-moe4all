/** Track queued and running memory-distillation work by session. */
export function createActivityTracker() {
  const sessions = new Map();
  let revision = 0;

  return {
    begin(sessionId) {
      const id = String(sessionId ?? "");
      sessions.set(id, (sessions.get(id) ?? 0) + 1);
      revision++;
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        const remaining = (sessions.get(id) ?? 1) - 1;
        if (remaining > 0) sessions.set(id, remaining);
        else sessions.delete(id);
        revision++;
      };
    },
    snapshot() {
      let tasks = 0;
      for (const count of sessions.values()) tasks += count;
      return {
        active: tasks > 0,
        tasks,
        sessions: [...sessions.keys()].filter(Boolean),
        revision
      };
    }
  };
}
