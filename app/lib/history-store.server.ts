import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

export type ClipboardHistoryEntry = {
  id: string;
  text: string;
  createdAt: number;
  sourceClientId: string;
  sourceClientName: string;
};

const defaultDbPath = path.join(process.cwd(), "data", "quickrelay-history.sqlite");
const historyDbPath = (process.env.HISTORY_DB_PATH ?? "").trim() || defaultDbPath;
const parsedMaxItems = Number(process.env.MAX_HISTORY_ITEMS ?? 50);
const maxHistoryItems = Number.isFinite(parsedMaxItems) ? Math.max(1, Math.floor(parsedMaxItems)) : 50;

fs.mkdirSync(path.dirname(historyDbPath), { recursive: true });

const db = new Database(historyDbPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS clipboard_history (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    source_client_id TEXT NOT NULL,
    source_client_name TEXT NOT NULL DEFAULT ''
  )
`);

const historyColumns = db.prepare(`PRAGMA table_info(clipboard_history)`).all() as Array<{ name: string }>;
if (!historyColumns.some((column) => column.name === "source_client_name")) {
  db.exec(`ALTER TABLE clipboard_history ADD COLUMN source_client_name TEXT NOT NULL DEFAULT ''`);
}

const selectHistoryStmt = db.prepare(`
  SELECT id, text, created_at AS createdAt, source_client_id AS sourceClientId, source_client_name AS sourceClientName
  FROM clipboard_history
  ORDER BY created_at DESC, rowid DESC
  LIMIT ?
`);

const selectLatestHistoryStmt = db.prepare(`
  SELECT id, text, created_at AS createdAt, source_client_id AS sourceClientId, source_client_name AS sourceClientName
  FROM clipboard_history
  ORDER BY created_at DESC, rowid DESC
  LIMIT 1
`);

const insertHistoryStmt = db.prepare(`
  INSERT INTO clipboard_history (id, text, created_at, source_client_id, source_client_name)
  VALUES (@id, @text, @createdAt, @sourceClientId, @sourceClientName)
`);

const selectOverflowIdsStmt = db.prepare(`
  SELECT id
  FROM clipboard_history
  ORDER BY created_at DESC, rowid DESC
  LIMIT -1 OFFSET ?
`);

const deleteHistoryByIdStmt = db.prepare(`
  DELETE FROM clipboard_history
  WHERE id = ?
`);

const clearHistoryStmt = db.prepare(`
  DELETE FROM clipboard_history
`);

const deleteSingleHistoryEntryStmt = db.prepare(`
  DELETE FROM clipboard_history
  WHERE id = ?
`);

function normalizeHistoryText(raw: string) {
  return raw.replace(/\r\n/g, "\n");
}

export function getHistoryDbPath() {
  return historyDbPath;
}

export function getMaxHistoryItems() {
  return maxHistoryItems;
}

export function listHistoryEntries(limit = maxHistoryItems) {
  return selectHistoryStmt.all(limit) as ClipboardHistoryEntry[];
}

export function clearHistoryEntries() {
  clearHistoryStmt.run();
}

export function deleteHistoryEntry(id: string) {
  const normalizedId = id.trim();
  if (!normalizedId) {
    return false;
  }
  const result = deleteSingleHistoryEntryStmt.run(normalizedId);
  return result.changes > 0;
}

export function appendHistoryEntry(entry: ClipboardHistoryEntry) {
  const normalizedText = normalizeHistoryText(entry.text);
  if (!normalizedText.trim()) {
    return null;
  }

  const latest = selectLatestHistoryStmt.get() as ClipboardHistoryEntry | undefined;
  if (latest && normalizeHistoryText(latest.text) === normalizedText) {
    return null;
  }

  insertHistoryStmt.run({
    id: entry.id,
    text: normalizedText,
    createdAt: entry.createdAt,
    sourceClientId: entry.sourceClientId,
    sourceClientName: entry.sourceClientName.trim()
  });

  const overflowRows = selectOverflowIdsStmt.all(maxHistoryItems) as Array<{ id: string }>;
  const removedIds = overflowRows.map((row) => row.id);
  if (removedIds.length > 0) {
    const trimHistory = db.transaction((ids: string[]) => {
      for (const id of ids) {
        deleteHistoryByIdStmt.run(id);
      }
    });
    trimHistory(removedIds);
  }

  return {
    entry: {
      ...entry,
      text: normalizedText
    },
    removedIds
  };
}
