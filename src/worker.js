// Cloudflare Workers entry: API on /api/*, static files from ./public via the ASSETS binding, data in D1 (SQLite).
import { handle } from "./api.js";

const d1 = (DB) => ({
  raw: DB, // lets api.js create the tables once per isolate, not per request
  all: async (sql, ...p) => (await DB.prepare(sql).bind(...p).all()).results,
  first: (sql, ...p) => DB.prepare(sql).bind(...p).first(),
  run: async (sql, ...p) => {
    const r = await DB.prepare(sql).bind(...p).run();
    return { lastId: r.meta.last_row_id, changes: r.meta.changes };
  },
  // D1 batches run as a single transaction.
  batch: async (stmts) => DB.batch(stmts.map(([sql, ...p]) => DB.prepare(sql).bind(...p))),
});

export default {
  async fetch(request, env) {
    const res = await handle(request, d1(env.DB), { ip: request.headers.get("CF-Connecting-IP") || "unknown" });
    return res ?? env.ASSETS.fetch(request);
  },
};
