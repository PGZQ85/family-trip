// db adapter over Node's built-in SQLite, matching the D1 adapter in worker.js.
import { DatabaseSync } from "node:sqlite";

export function openDb(file) {
  const sqlite = new DatabaseSync(file);
  sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  return {
    all: async (sql, ...p) => sqlite.prepare(sql).all(...p),
    first: async (sql, ...p) => sqlite.prepare(sql).get(...p) ?? null,
    run: async (sql, ...p) => {
      const r = sqlite.prepare(sql).run(...p);
      return { lastId: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
    batch: async (stmts) => {
      sqlite.exec("BEGIN");
      try {
        const out = stmts.map(([sql, ...p]) => sqlite.prepare(sql).run(...p));
        sqlite.exec("COMMIT");
        return out;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
    close: () => sqlite.close(),
  };
}
