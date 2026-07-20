import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { STORE_DIR } from './config.js';

// Heimdall's own conditions log — a robust, open-ended sqlite store separate
// from the message DB. Every security assessment is recorded here with its
// exact timestamp so Heimdall can reference events by time/date and learn
// normal patterns (e.g. the same person arriving/leaving at the same times).
//
// The schema is deliberately open: structured columns cover the queryable
// fields, and a JSON `data` column holds anything else Heimdall wants to
// record (durations, tags, extra counts, freeform notes) so it can handle any
// task without a schema migration. WAL mode so a dashboard reader and Heimdall
// writing concurrently don't block each other.

const DB_PATH = path.join(STORE_DIR, 'security.db');

let db: Database.Database | null = null;

const KNOWN_FIELDS = new Set([
  'action', 'alert_ts', 'camera', 'assessment', 'condition',
  'person_count', 'escalated', 'tags',
]);

function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS security_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      alert_ts TEXT,
      camera TEXT,
      assessment TEXT,
      condition TEXT,
      person_count INTEGER,
      escalated INTEGER DEFAULT 0,
      tags TEXT,
      data TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_security_log_ts ON security_log(ts);
    CREATE INDEX IF NOT EXISTS idx_security_log_assessment ON security_log(assessment);
    CREATE INDEX IF NOT EXISTS idx_security_log_camera ON security_log(camera);
    CREATE TABLE IF NOT EXISTS known_persons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      frame_path TEXT NOT NULL,
      phash TEXT,
      created_at TEXT NOT NULL
    );
  `);
  // In-place migrations: add any columns missing from an older schema (CREATE
  // TABLE IF NOT EXISTS won't upgrade an existing table). Idempotent — skips
  // columns that already exist. This lets the schema evolve without losing data.
  const have = new Set((db.prepare("PRAGMA table_info(security_log)").all() as { name: string }[]).map((c) => c.name));
  const expected: { col: string; def: string }[] = [
    { col: 'camera', def: 'TEXT' },
    { col: 'person_count', def: 'INTEGER' },
    { col: 'tags', def: 'TEXT' },
    { col: 'data', def: 'TEXT' },
    { col: 'created_at', def: "TEXT NOT NULL DEFAULT ''" },
  ];
  for (const { col, def } of expected) {
    if (!have.has(col)) db.exec(`ALTER TABLE security_log ADD COLUMN ${col} ${def};`);
  }
  return db;
}

interface Row {
  ts: string; alert_ts: string | null; camera: string | null;
  assessment: string | null; condition: string | null; person_count: number | null;
  escalated: number; tags: string | null; data: string | null;
}

function parseTags(v: any): string | null {
  if (v == null) return null;
  if (Array.isArray(v)) return v.map((x) => String(x)).join(',');
  if (typeof v === 'string') return v;
  return null;
}

export function securityLog(args: any): { ok: boolean; summary?: string; error?: string; rows?: any[] } {
  try {
    const action = args?.action;
    const d = getDb();

    if (action === 'record') {
      // Known fields → columns; everything else → JSON data.
      const extras: Record<string, any> = {};
      for (const k of Object.keys(args || {})) {
        if (!KNOWN_FIELDS.has(k) && k !== 'data') extras[k] = (args as any)[k];
      }
      if (args?.data && typeof args.data === 'object') Object.assign(extras, args.data);
      const ts = typeof args?.ts === 'string' ? args.ts : new Date().toISOString();
      d.prepare(
        `INSERT INTO security_log
         (ts, alert_ts, camera, assessment, condition, person_count, escalated, tags, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        ts,
        typeof args?.alert_ts === 'string' ? args.alert_ts : null,
        typeof args?.camera === 'string' ? args.camera : null,
        (typeof args?.assessment === 'string' ? args.assessment : null),
        (typeof args?.condition === 'string' ? args.condition : null),
        (typeof args?.person_count === 'number' ? args.person_count : null),
        args?.escalated ? 1 : 0,
        parseTags(args?.tags),
        Object.keys(extras).length ? JSON.stringify(extras) : null,
        new Date().toISOString(),
      );
      return { ok: true };
    }

    if (action === 'query') {
      const since = typeof args?.since === 'string' ? args.since : null;
      const until = typeof args?.until === 'string' ? args.until : null;
      const assessment = typeof args?.assessment === 'string' ? args.assessment : null;
      const camera = typeof args?.camera === 'string' ? args.camera : null;
      const limit = Math.min(Math.max(parseInt(args?.limit, 10) || 50, 1), 1000);
      let sql = 'SELECT ts, alert_ts, camera, assessment, condition, person_count, escalated, tags, data FROM security_log';
      const cond: string[] = [];
      const params: any[] = [];
      if (since) { cond.push('ts >= ?'); params.push(since); }
      if (until) { cond.push('ts <= ?'); params.push(until); }
      if (assessment) { cond.push('assessment = ?'); params.push(assessment); }
      if (camera) { cond.push('camera = ?'); params.push(camera); }
      if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
      sql += ' ORDER BY ts DESC LIMIT ?';
      params.push(limit);
      const rows = d.prepare(sql).all(...params) as Row[];
      if (rows.length === 0) return { ok: true, summary: 'No matching rows.', rows: [] };
      const lines = rows.map((r) => {
        const tags = r.tags ? ` [${r.tags}]` : '';
        const ppl = r.person_count != null ? ` ${r.person_count}p` : '';
        const extra = r.data ? ` {${r.data}}` : '';
        return `[${r.ts}]${r.camera ? ' ' + r.camera : ''} ${r.assessment || '?'}${r.escalated ? ' (escalated)' : ''}${ppl}${tags} — ${r.condition || ''}${extra}`;
      });
      return { ok: true, summary: `${rows.length} row(s):\n` + lines.join('\n'), rows: rows as any };
    }

    if (action === 'stats') {
      // Quick aggregates for "what's normal here" — counts by assessment, by
      // hour-of-day, by camera — so Heimdall can reason about patterns.
      const since = typeof args?.since === 'string' ? args.since : null;
      const where = since ? 'WHERE ts >= ?' : '';
      const params = since ? [since] : [];
      const byAssessment = d.prepare(
        `SELECT assessment, COUNT(*) n FROM security_log ${where} GROUP BY assessment`,
      ).all(...params) as { assessment: string | null; n: number }[];
      const total = byAssessment.reduce((s, r) => s + r.n, 0);
      const lines = byAssessment.map((r) => `${r.assessment || 'null'}: ${r.n}`);
      return { ok: true, summary: `${total} record(s)${since ? ` since ${since}` : ''} — ${lines.join(', ') || 'none'}` };
    }

    return { ok: false, error: `unknown action: ${action} (use record | query | stats)` };
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/**
 * Save a known-person keyframe so the detector can skip flagging them
 * (application-side pHash compare). The host inserts {label, frame_path}; the
 * detector computes the pHash later (it has the image lib). Idempotent on label:
 * if a known_persons row with the same label exists, update its frame_path.
 */
export function saveKnownPerson(args: any): { ok: boolean; error?: string } {
  try {
    const label = typeof args?.label === 'string' ? args.label.trim() : '';
    const framePath = typeof args?.frame_path === 'string' ? args.frame_path.trim() : '';
    if (!label || !framePath) return { ok: false, error: 'label and frame_path required' };
    const d = getDb();
    const existing = d.prepare('SELECT id FROM known_persons WHERE label = ?').get(label) as { id: number } | undefined;
    if (existing) {
      d.prepare('UPDATE known_persons SET frame_path = ?, phash = NULL WHERE id = ?').run(framePath, existing.id);
    } else {
      d.prepare('INSERT INTO known_persons (label, frame_path, phash, created_at) VALUES (?, ?, NULL, ?)')
        .run(label, framePath, new Date().toISOString());
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}