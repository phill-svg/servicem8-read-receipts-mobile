// Just enough of the D1 prepare/bind/run/all/first/batch surface to exercise
// the poller end to end. Statements are matched on a distinctive fragment of
// their SQL -- crude, but it keeps the fake honest: an unrecognised query
// throws rather than quietly returning nothing and passing a test it shouldn't.
//
// bind() returns a *new* statement rather than mutating this one, matching real
// D1. That matters: batching prepares a statement once and binds it per row, so
// a fake that mutated in place would write the same row 50 times and the tests
// would still pass.
export function fakeDb({ tenants = [], notified = [], baselined = [] } = {}) {
  const state = {
    tenants: tenants.map((t) => ({ status: "active", ...t })),
    notified: [...notified],
    baselined: [...baselined],
    runs: [],
    nextRunId: 1,
    batches: [], // sizes of each batch() call, so tests can assert on chunking
  };

  function statement(sql, args) {
    return {
      bind: (...a) => statement(sql, a),

      async run() {
        if (sql.includes("INSERT INTO poll_runs")) {
          const id = state.nextRunId++;
          state.runs.push({ id, started_at: args[0], source: args[1], tenant_id: args[2], finished_at: null });
          return { meta: { last_row_id: id, changes: 1 } };
        }
        if (sql.includes("UPDATE poll_runs")) {
          const run = state.runs.find((r) => r.id === args[5]);
          if (run) Object.assign(run, { finished_at: args[0], ok: args[1], scanned: args[2], notified: args[3], error: args[4] });
          return { meta: { changes: run ? 1 : 0 } };
        }
        if (sql.includes("DELETE FROM poll_runs")) return { meta: { changes: 0 } };
        if (sql.includes("INSERT INTO notified_emails")) {
          const dup = state.notified.some((n) => n.tenant_id === args[0] && n.email_uuid === args[1]);
          if (!dup) state.notified.push({ tenant_id: args[0], email_uuid: args[1], job_uuid: args[2], opened_at: args[3] });
          return { meta: { changes: dup ? 0 : 1 } };
        }
        if (sql.includes("INSERT INTO tenant_baselines")) {
          if (!state.baselined.includes(args[0])) state.baselined.push(args[0]);
          return { meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE tenants SET status")) {
          const tenant = state.tenants.find((t) => t.tenant_id === args[1]);
          if (tenant) tenant.status = "reauth_required";
          return { meta: { changes: tenant ? 1 : 0 } };
        }
        throw new Error(`fakeDb: unexpected run() for ${sql}`);
      },

      async all() {
        if (sql.includes("SELECT email_uuid FROM notified_emails")) {
          return { results: state.notified.map((n) => ({ email_uuid: n.email_uuid })) };
        }
        if (sql.includes("FROM tenants WHERE status = 'active'")) {
          return { results: state.tenants.filter((t) => t.status === "active").map((t) => ({ tenant_id: t.tenant_id })) };
        }
        throw new Error(`fakeDb: unexpected all() for ${sql}`);
      },

      async first() {
        if (sql.includes("FROM tenant_baselines")) {
          return state.baselined.includes(args[0]) ? { tenant_id: args[0] } : null;
        }
        throw new Error(`fakeDb: unexpected first() for ${sql}`);
      },
    };
  }

  return {
    state,
    prepare: (sql) => statement(sql, []),
    async batch(statements) {
      state.batches.push(statements.length);
      const results = [];
      for (const st of statements) results.push(await st.run());
      return results;
    },
  };
}
