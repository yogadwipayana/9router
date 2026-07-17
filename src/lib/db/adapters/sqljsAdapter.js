import fs from "node:fs";
import initSqlJs from "sql.js";
import { PRAGMA_SQL } from "../schema.js";

let SQL = null;

async function loadSql() {
  if (SQL) return SQL;
  SQL = await initSqlJs();
  return SQL;
}

export async function createSqlJsAdapter(filePath) {
  const SQLLib = await loadSql();
  const buf = fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
  const db = new SQLLib.Database(buf);
  db.exec(PRAGMA_SQL);
  // Schema is created/synced by migrate.js after adapter init

  let dirty = false;
  let saveTimer = null;
  let firstDirtyAt = 0;
  // persist() re-exports the ENTIRE database to disk, so writes are debounced.
  // The debounce slides on every write; MAX_SAVE_DELAY caps the slide so a
  // sustained write burst still hits disk at a bounded interval instead of
  // deferring the (whole-file) save indefinitely.
  const SAVE_DEBOUNCE_MS = 250;
  const MAX_SAVE_DELAY_MS = 2000;

  function persist() {
    const data = db.export();
    fs.writeFileSync(filePath, Buffer.from(data));
    dirty = false;
  }

  function scheduleSave() {
    if (!dirty) {
      dirty = true;
      firstDirtyAt = Date.now();
    }
    if (saveTimer) {
      // Cap reached — let the pending timer fire instead of sliding again.
      if (Date.now() - firstDirtyAt >= MAX_SAVE_DELAY_MS) return;
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (dirty) {
        try { persist(); } catch (e) { console.error("[sqljs] save failed:", e); }
      }
    }, SAVE_DEBOUNCE_MS);
    saveTimer?.unref?.();
  }

  // sql.js is the only adapter that re-compiled every statement per call —
  // keep a small reuse cache. sqlite recompiles cached handles itself after
  // schema changes, and calls never overlap (everything here is sync).
  const STMT_CACHE_MAX = 100;
  const stmtCache = new Map();

  function getStmt(sql) {
    let stmt = stmtCache.get(sql);
    if (stmt) {
      stmt.reset();
      return stmt;
    }
    stmt = db.prepare(sql);
    if (stmtCache.size >= STMT_CACHE_MAX) {
      const [oldSql, oldStmt] = stmtCache.entries().next().value;
      try { oldStmt.free(); } catch {}
      stmtCache.delete(oldSql);
    }
    stmtCache.set(sql, stmt);
    return stmt;
  }

  function freeStmtCache() {
    for (const stmt of stmtCache.values()) {
      try { stmt.free(); } catch {}
    }
    stmtCache.clear();
  }

  function paramsObj(params) {
    if (!params || (Array.isArray(params) && params.length === 0)) return undefined;
    return params;
  }

  function run(sql, params = []) {
    const stmt = getStmt(sql);
    stmt.bind(paramsObj(params));
    stmt.step();
    const changes = db.getRowsModified();
    const lastInsertRowid = db.exec("SELECT last_insert_rowid() as id")[0]?.values?.[0]?.[0] ?? null;
    scheduleSave();
    return { changes, lastInsertRowid };
  }

  function get(sql, params = []) {
    const stmt = getStmt(sql);
    stmt.bind(paramsObj(params));
    if (stmt.step()) return stmt.getAsObject();
    return undefined;
  }

  function all(sql, params = []) {
    const stmt = getStmt(sql);
    stmt.bind(paramsObj(params));
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  }

  function exec(sql) {
    db.exec(sql);
    scheduleSave();
  }

  function transaction(fn) {
    const sp = `sp_${Math.random().toString(36).slice(2)}`;
    db.exec(`SAVEPOINT ${sp}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${sp}`);
      scheduleSave();
      return result;
    } catch (e) {
      try { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); } catch {}
      throw e;
    }
  }

  function close() {
    if (saveTimer) clearTimeout(saveTimer);
    if (dirty) persist();
    freeStmtCache();
    db.close();
  }

  // Flush on shutdown
  const flush = () => { if (dirty) try { persist(); } catch {} };
  process.on("beforeExit", flush);
  process.on("SIGINT", flush);
  process.on("SIGTERM", flush);

  return { driver: "sql.js", run, get, all, exec, transaction, close, raw: db };
}
