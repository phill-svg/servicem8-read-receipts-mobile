// D1 doubles as this add-on's log sink.
//
// There is no staff-facing UI here and no practical way to tail Worker logs
// from where this gets maintained, so every poll -- cron-driven or manual --
// records what it did and what went wrong. That makes the two questions that
// actually stall a live install ("did the cron fire at all?" and "did the
// token refresh fail?") answerable with one D1 query instead of guesswork.

const MAX_ERROR_CHARS = 2000;
const KEEP_RUNS = 500; // bounded so the table can't grow without limit

// Errors reaching here are mostly ServiceM8 API/OAuth failures whose response
// body is the useful part -- keep the text, drop the stack, cap the length.
export function describeError(err) {
  if (err === null || err === undefined) return null;
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.slice(0, MAX_ERROR_CHARS);
}

// Written before any work starts, so a run that dies mid-flight still leaves a
// row behind (finished_at NULL) rather than vanishing.
export async function startRun(db, { source, tenantId = null }) {
  // Bookkeeping must never be what breaks the actual job -- if poll_runs is
  // missing or D1 is unhappy, the poll still goes ahead unrecorded.
  try {
    const res = await db
      .prepare(`INSERT INTO poll_runs (started_at, source, tenant_id) VALUES (?, ?, ?)`)
      .bind(Date.now(), source, tenantId)
      .run();
    return res.meta.last_row_id;
  } catch (err) {
    console.error("diagnostics: could not record poll run start", err);
    return null;
  }
}

export async function finishRun(db, id, { ok, scanned = null, notified = null, error = null }) {
  if (!id) return;
  try {
    await db
      .prepare(`UPDATE poll_runs SET finished_at = ?, ok = ?, scanned = ?, notified = ?, error = ? WHERE id = ?`)
      .bind(Date.now(), ok ? 1 : 0, scanned, notified, describeError(error), id)
      .run();
  } catch (err) {
    console.error("diagnostics: could not record poll run result", err);
  }
}

export async function pruneRuns(db) {
  await db
    .prepare(`DELETE FROM poll_runs WHERE id NOT IN (SELECT id FROM poll_runs ORDER BY id DESC LIMIT ?)`)
    .bind(KEEP_RUNS)
    .run();
}

// Guards /debug/poll-all against being hammered (each run costs real ServiceM8
// API calls). Cron runs are never blocked -- only manually triggered ones.
export async function manualRunStartedRecently(db, withinMs) {
  const row = await db
    .prepare(`SELECT started_at FROM poll_runs WHERE source = 'manual' AND tenant_id IS NULL ORDER BY id DESC LIMIT 1`)
    .first();
  return Boolean(row && Date.now() - row.started_at < withinMs);
}
