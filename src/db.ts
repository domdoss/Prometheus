import crypto from 'crypto';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  STORE_DIR,
} from './config.js';
import { logger } from './logger.js';
import {
  NewMessage,
  OWNER_JID,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

let db: Database.Database;

export function getDb(): Database.Database {
  return db;
}

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      idea TEXT DEFAULT '',
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_chat_jid_timestamp ON messages(chat_jid, timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_chat_bot ON messages(chat_jid, is_bot_message, timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      context_mode TEXT DEFAULT 'isolated',
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS automations (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      time TEXT NOT NULL,
      action TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      last_run TEXT
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT DEFAULT 'On Track',
      progress INTEGER DEFAULT 0,
      due_date TEXT,
      project_code TEXT DEFAULT '',
      group_jid TEXT NOT NULL DEFAULT '',
      owner TEXT NOT NULL DEFAULT '',
      shared_with TEXT DEFAULT '[]',
      archived INTEGER DEFAULT 0,
      archived_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_priorities (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      item TEXT NOT NULL,
      impact TEXT DEFAULT 'medium',
      rank INTEGER DEFAULT 0,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_financials (
      project_id TEXT PRIMARY KEY,
      budget REAL DEFAULT 0,
      spent REAL DEFAULT 0,
      revenue REAL DEFAULT 0,
      notes TEXT DEFAULT '',
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_deliverables (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      due_date TEXT,
      done INTEGER DEFAULT 0,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_blockers (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      blocker TEXT NOT NULL,
      severity TEXT DEFAULT 'medium',
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_timesheet (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      hours REAL NOT NULL,
      description TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS active_timers (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      description TEXT DEFAULT '',
      started_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS email_accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      imap_host TEXT NOT NULL,
      imap_port INTEGER DEFAULT 993,
      smtp_host TEXT NOT NULL,
      smtp_port INTEGER DEFAULT 587,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      use_tls INTEGER DEFAULT 1,
      read_only INTEGER DEFAULT 1,
      enabled INTEGER DEFAULT 1,
      oauth_account_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS email_drafts (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      to_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES email_accounts(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS sms_accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      name TEXT NOT NULL,
      phone_number TEXT NOT NULL,
      account_sid TEXT NOT NULL,
      auth_token TEXT NOT NULL,
      read_only INTEGER DEFAULT 1,
      enabled INTEGER DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sms_messages (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      from_number TEXT NOT NULL,
      to_number TEXT NOT NULL,
      body TEXT NOT NULL,
      twilio_sid TEXT,
      status TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES sms_accounts(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sms_msg_account ON sms_messages(account_id, created_at);

    CREATE TABLE IF NOT EXISTS oauth_accounts (
      id               TEXT PRIMARY KEY,
      user_id          TEXT NOT NULL,
      provider         TEXT NOT NULL,
      scopes           TEXT NOT NULL,
      access_token     TEXT NOT NULL,
      refresh_token    TEXT NOT NULL,
      token_iv         TEXT NOT NULL,
      token_auth_tag   TEXT NOT NULL,
      refresh_iv       TEXT NOT NULL,
      refresh_auth_tag TEXT NOT NULL,
      expires_at       TEXT NOT NULL,
      email            TEXT,
      calendar_enabled INTEGER DEFAULT 1,
      email_enabled    INTEGER DEFAULT 1,
      enabled          INTEGER DEFAULT 1,
      last_calendar_sync TEXT,
      created_at       TEXT,
      updated_at       TEXT
    );

    CREATE TABLE IF NOT EXISTS user_notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      task_id TEXT,
      read INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notif_user ON user_notifications(user_id, created_at);

    CREATE TABLE IF NOT EXISTS calendar_events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      start_time TEXT NOT NULL,
      end_time TEXT,
      all_day INTEGER DEFAULT 0,
      location TEXT DEFAULT '',
      recurrence TEXT DEFAULT '',
      color TEXT DEFAULT '',
      assigned_to TEXT,
      created_by TEXT,
      work_task_id TEXT,
      calendar_source TEXT DEFAULT 'local',
      ical_uid TEXT,
      provider_calendar_id TEXT DEFAULT '',
      provider_calendar_name TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cal_start ON calendar_events(start_time);
    CREATE INDEX IF NOT EXISTS idx_cal_user ON calendar_events(assigned_to);

    CREATE TABLE IF NOT EXISTS user_alarms (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT 'Alarm',
      alarm_time TEXT NOT NULL,
      alarm_date TEXT,
      repeat_type TEXT DEFAULT 'once',
      repeat_days TEXT DEFAULT '',
      enabled INTEGER DEFAULT 1,
      snooze_until TEXT,
      last_fired TEXT,
      sound TEXT DEFAULT 'default',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_alarm_user ON user_alarms(user_id);
    CREATE INDEX IF NOT EXISTS idx_alarm_enabled ON user_alarms(enabled);
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS user_api_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      key_type TEXT NOT NULL,
      encrypted_key TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      base_url TEXT DEFAULT '',
      default_model TEXT DEFAULT '',
      auth_header_format TEXT DEFAULT 'Bearer {key}',
      is_active INTEGER DEFAULT 1,
      usage_tokens INTEGER DEFAULT 0,
      usage_cost_cents INTEGER DEFAULT 0,
      last_used_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_api_keys_user ON user_api_keys(user_id, created_at);
  `);

}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);

  // Performance: WAL mode for concurrent reads, larger cache, memory-mapped I/O
  db.pragma('journal_mode = WAL');
  db.pragma('cache_size = -64000');     // 64MB cache
  db.pragma('mmap_size = 268435456');   // 256MB mmap
  db.pragma('foreign_keys = ON');        // Enforce referential integrity
  db.pragma('busy_timeout = 5000');      // Wait instead of throwing SQLITE_BUSY under concurrent writes
  db.pragma('synchronous = NORMAL');     // Safe with WAL; avoids fsync on every commit

  // Run desktop schema migration before createSchema so legacy tables are
  // backed up and dropped before the new canonical schema is applied.
  migrateToDesktopSchema(db);

  createSchema(db);

  // Idempotent column migrations for DBs created before a column was added.
  // CREATE TABLE IF NOT EXISTS won't alter an existing table, so add missing
  // columns here. ALTER fails harmlessly if the column already exists.
  for (const [table, col, def] of [
    ['email_accounts', 'oauth_account_id', 'TEXT'],
  ] as const) {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch { /* already exists */ }
  }

  // Ensure the OWNER_JID chat row exists so messages.chat_jid FK is satisfied.
  // The migration inserts this conditionally; on a fresh or already-migrated
  // DB it would be missing without this guard.
  db.prepare(
    `INSERT OR IGNORE INTO chats (jid, name, last_message_time, channel, is_group)
     VALUES (?, 'Owner', NULL, NULL, 0)`,
  ).run(OWNER_JID);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  createSchema(db);
}

/**
 * Migrate from the legacy multi-user/group schema to the single-user Warden
 * desktop schema. Detects if old tables exist; if not, returns (fresh install
 * or already migrated). Otherwise:
 *   1. Backs up the DB to data/backups/pre-desktop-migration-{timestamp}.db.
 *   2. Finds the main group (is_main = 1 row in registered_groups).
 *   3. Re-maps its messages + scheduled_tasks to OWNER_JID.
 *   4. Deletes non-main group messages + tasks.
 *   5. Drops the legacy tables.
 */
export function migrateToDesktopSchema(database: Database.Database): void {
  const tables = database.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('registered_groups','dashboard_users','user_sessions','session_links','user_work_tasks')",
  ).all() as { name: string }[];

  if (tables.length === 0) return; // already migrated or fresh install

  // Backup before destructive migration. Skip for in-memory test DBs.
  if (database.name !== ':memory:') {
    const backupPath = path.join(
      path.dirname(database.name),
      `backups/pre-desktop-migration-${Date.now()}.db`,
    );
    try {
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      database.backup(backupPath);
      logger.info({ backupPath }, 'desktop schema migration: backup written');
    } catch (err) {
      logger.warn({ err }, 'desktop schema migration: backup failed, proceeding anyway');
    }
  }

  // Find the main group folder (is_main = 1 row in registered_groups).
  const mainGroup = database.prepare(
    "SELECT folder FROM registered_groups WHERE is_main = 1 LIMIT 1",
  ).get() as { folder: string } | undefined;

  if (mainGroup) {
    // Re-map messages and scheduled_tasks from the main group's JID to OWNER_JID.
    // Legacy chats table has no folder column; the JID lives in registered_groups.
    const mainJidRow = database.prepare(
      'SELECT jid FROM registered_groups WHERE folder = ? LIMIT 1',
    ).get(mainGroup.folder) as { jid: string } | undefined;
    const mainJid = mainJidRow?.jid;
    if (mainJid) {
      // Ensure the OWNER_JID chat row exists before re-keying messages to it,
      // so the messages.chat_jid FK constraint is satisfied.
      const ownerName = database.prepare(
        'SELECT name FROM chats WHERE jid = ?',
      ).get(mainJid) as { name: string | null } | undefined;
      database.prepare(
        `INSERT OR IGNORE INTO chats (jid, name, last_message_time, channel, is_group)
         VALUES (?, ?, NULL, NULL, 0)`,
      ).run(OWNER_JID, ownerName?.name ?? OWNER_JID);

      database.prepare('UPDATE messages SET chat_jid = ? WHERE chat_jid = ?')
        .run(OWNER_JID, mainJid);
      database.prepare('UPDATE scheduled_tasks SET chat_jid = ? WHERE chat_jid = ?')
        .run(OWNER_JID, mainJid);
    }
    // Delete non-main group messages + tasks. task_run_logs has no ON DELETE
    // CASCADE on its task_id FK, so we must clear those rows before deleting tasks.
    database.prepare('DELETE FROM messages WHERE chat_jid != ?').run(OWNER_JID);
    database.prepare(
      'DELETE FROM task_run_logs WHERE task_id IN (SELECT id FROM scheduled_tasks WHERE chat_jid != ?)',
    ).run(OWNER_JID);
    database.prepare('DELETE FROM scheduled_tasks WHERE chat_jid != ?').run(OWNER_JID);
  }

  // Drop the multi-user/group tables.
  for (const t of tables) {
    database.exec(`DROP TABLE IF EXISTS ${t.name}`);
  }

  logger.info(
    { mainGroup: mainGroup?.folder, dropped: tables.map((t) => t.name) },
    'desktop schema migration complete',
  );
}

/**
 * Store chat metadata only (no message content).
 * Single-user Warden: always uses OWNER_JID as the chat JID; the chatJid
 * parameter is accepted for signature compatibility but ignored.
 */
export function storeChatMetadata(
  _chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(OWNER_JID, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(OWNER_JID, OWNER_JID, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * Single-user Warden: always uses OWNER_JID as the chat JID.
 */
export function updateChatName(_chatJid: string, name: string, channel?: string): void {
  const ch = channel ?? null;
  const isGroup = 0;
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET
      name = excluded.name,
      channel = COALESCE(excluded.channel, channel),
      is_group = CASE WHEN excluded.is_group != 0 THEN excluded.is_group ELSE is_group END
  `,
  ).run(OWNER_JID, name, new Date().toISOString(), ch, isGroup);
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(timestamp?: string): void {
  const ts = timestamp || new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(ts);
}

export function deleteWhatsappChats(): void {
  db.prepare("DELETE FROM chats WHERE channel = 'whatsapp' OR jid LIKE '%@g.us' OR jid LIKE '%@s.whatsapp.net'").run();
}

/**
 * Store a message with full content.
 * Single-user Warden: chat_jid is always OWNER_JID; the msg.chat_jid field
 * is accepted for interface compatibility but ignored.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, idea) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    OWNER_JID,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.idea || '',
  );
}

export function getNewMessages(
  _jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 500,
): { messages: NewMessage[]; newTimestamp: string } {
  // Single-user Warden: always query the OWNER_JID chat.
  const jids = [OWNER_JID];
  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getChatHistory(
  _chatJid: string,
  limit: number = 200,
  before?: string,
  idea?: string,
): Array<{ sender_name: string; content: string; timestamp: string; is_bot_message: number }> {
  const jids = [OWNER_JID];
  const placeholders = jids.map(() => '?').join(',');
  const ideaFilter = idea !== undefined && idea !== ''
    ? `AND idea = ?`
    : `AND (idea = '' OR idea IS NULL)`;
  const sql = before
    ? `SELECT sender_name, content, timestamp, is_bot_message FROM messages
       WHERE chat_jid IN (${placeholders}) AND timestamp < ? AND content != '' AND content IS NOT NULL ${ideaFilter}
       ORDER BY timestamp DESC LIMIT ?`
    : `SELECT sender_name, content, timestamp, is_bot_message FROM messages
       WHERE chat_jid IN (${placeholders}) AND content != '' AND content IS NOT NULL ${ideaFilter}
       ORDER BY timestamp DESC LIMIT ?`;
  const rows = before
    ? (idea !== undefined && idea !== ''
        ? db.prepare(sql).all(...jids, before, idea, limit)
        : db.prepare(sql).all(...jids, before, limit))
    : (idea !== undefined && idea !== ''
        ? db.prepare(sql).all(...jids, idea, limit)
        : db.prepare(sql).all(...jids, limit));
  return (rows as any[]).reverse();
}

export function getLastBotMessageTimestamp(_chatJid: string): string | null {
  const row = db
    .prepare(
      'SELECT timestamp FROM messages WHERE chat_jid = ? AND is_bot_message = 1 ORDER BY timestamp DESC LIMIT 1',
    )
    .get(OWNER_JID) as { timestamp: string } | undefined;
  return row?.timestamp || null;
}

export function getLastMessageInfo(_chatJid: string): { timestamp: string; is_bot_message: number } | null {
  const row = db
    .prepare(
      'SELECT timestamp, is_bot_message FROM messages WHERE chat_jid = ? AND content != \'\' AND content IS NOT NULL ORDER BY timestamp DESC LIMIT 1',
    )
    .get(OWNER_JID) as { timestamp: string; is_bot_message: number } | undefined;
  return row || null;
}

export function getMessagesSince(
  _chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 500,
  idea?: string,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const ideaFilter = idea !== undefined && idea !== ''
    ? `AND idea = ?`
    : `AND (idea = '' OR idea IS NULL)`;
  const jids = [OWNER_JID];
  const placeholders = jids.map(() => '?').join(',');
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE chat_jid IN (${placeholders}) AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
        ${ideaFilter}
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return (idea !== undefined && idea !== ''
    ? db.prepare(sql).all(...jids, sinceTimestamp, `${botPrefix}:%`, idea, limit)
    : db.prepare(sql).all(...jids, sinceTimestamp, `${botPrefix}:%`, limit)) as NewMessage[];
}

/**
 * Get messages for dashboard display — includes bot messages so both sides
 * of the conversation are visible.
 */
export function getMessagesForDashboard(
  _chatJid: string,
  sinceTimestamp: string,
  limit: number = 200,
  idea?: string,
): NewMessage[] {
  const jids = [OWNER_JID];
  const placeholders = jids.map(() => '?').join(',');
  const ideaFilter = idea !== undefined && idea !== ''
    ? `AND idea = ?`
    : `AND (idea = '' OR idea IS NULL)`;
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
      FROM messages
      WHERE chat_jid IN (${placeholders}) AND timestamp > ?
        AND content != '' AND content IS NOT NULL
        ${ideaFilter}
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  const params = idea !== undefined && idea !== ''
    ? [...jids, sinceTimestamp, idea, limit]
    : [...jids, sinceTimestamp, limit];
  return db.prepare(sql).all(...params) as NewMessage[];
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    OWNER_JID,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

/** Prune old task_run_logs, keeping at most `keep` rows per task. */
export function pruneTaskRunLogs(keep = 100): number {
  const result = db.prepare(
    `
    DELETE FROM task_run_logs WHERE id NOT IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY run_at DESC) AS rn
        FROM task_run_logs
      ) WHERE rn <= ?
    )
  `,
  ).run(keep);
  return result.changes;
}

// --- V2 query functions ---

function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, c => '\\' + c);
}

export function searchMessages(
  query: string,
  _chatJid: string,
  limit: number = 50,
): Array<{ id: string; content: string; chat_jid: string; timestamp: string }> {
  return db
    .prepare(
      `SELECT id, content, chat_jid, timestamp FROM messages
       WHERE chat_jid = ? AND content LIKE ? ESCAPE '\\'
       ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(OWNER_JID, `%${escapeLike(query)}%`, limit) as Array<{
    id: string;
    content: string;
    chat_jid: string;
    timestamp: string;
  }>;
}

export function searchTasks(
  query: string,
  limit: number = 50,
): Array<{ id: string; prompt: string; status: string }> {
  return db
    .prepare(
      `SELECT id, prompt, status FROM scheduled_tasks
       WHERE prompt LIKE ? ESCAPE '\\'
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(`%${escapeLike(query)}%`, limit) as Array<{
    id: string;
    prompt: string;
    status: string;
  }>;
}

export function getRecentMessages(
  limit: number = 50,
): Array<{
  id: string;
  chat_jid: string;
  sender_name: string;
  content: string;
  timestamp: string;
}> {
  return db
    .prepare(
      `SELECT id, chat_jid, sender_name, content, timestamp FROM messages
       WHERE content != '' AND content IS NOT NULL
       ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(limit) as Array<{
    id: string;
    chat_jid: string;
    sender_name: string;
    content: string;
    timestamp: string;
  }>;
}

export function getBotMessagesSince(
  _chatJid: string,
  sinceTimestamp: string,
  limit: number = 200,
): Array<{ id: string; content: string; timestamp: string }> {
  return db
    .prepare(
      `SELECT id, content, timestamp FROM messages
       WHERE chat_jid = ? AND is_bot_message = 1 AND timestamp > ?
       ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(OWNER_JID, sinceTimestamp, limit) as Array<{
    id: string;
    content: string;
    timestamp: string;
  }>;
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function deleteSession(groupFolder: string): boolean {
  const result = db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
  return result.changes > 0;
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Automations (formerly user_tasks) ---

// --- User Tasks (now automations) ---

export function getUserTasks(userId: string): any[] {
  return db
    .prepare('SELECT * FROM automations WHERE user_id = ? ORDER BY time')
    .all(userId)
    .map((t: any) => ({
      ...t,
      enabled: !!t.enabled,
    }));
}

export function createUserTask(
  userId: string,
  task: { time: string; action: string },
): any {
  const id = `utask-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    'INSERT INTO automations (id, user_id, time, action) VALUES (?, ?, ?, ?)',
  ).run(id, userId, task.time, task.action);
  return {
    id,
    user_id: userId,
    time: task.time,
    action: task.action,
    enabled: true,
    last_run: null,
  };
}

export function updateUserTask(
  taskId: string,
  updates: { time?: string; action?: string; enabled?: boolean },
): any | undefined {
  const existing = db
    .prepare('SELECT * FROM automations WHERE id = ?')
    .get(taskId) as any;
  if (!existing) return undefined;
  const time = updates.time ?? existing.time;
  const action = updates.action ?? existing.action;
  const enabled =
    updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : existing.enabled;
  db.prepare(
    'UPDATE automations SET time = ?, action = ?, enabled = ? WHERE id = ?',
  ).run(time, action, enabled, taskId);
  return { ...existing, time, action, enabled: !!enabled };
}

export function deleteUserTask(taskId: string): boolean {
  return (
    db.prepare('DELETE FROM automations WHERE id = ?').run(taskId).changes > 0
  );
}

export function getDueUserTasks(currentTime: string): any[] {
  return db
    .prepare(
      "SELECT t.* FROM automations t WHERE t.enabled = 1 AND t.time = ? AND (t.last_run IS NULL OR t.last_run < date('now'))",
    )
    .all(currentTime)
    .map((t: any) => ({
      ...t,
      enabled: true,
    }));
}

export function markTaskRun(taskId: string): void {
  db.prepare(
    "UPDATE automations SET last_run = datetime('now') WHERE id = ?",
  ).run(taskId);
}

// --- Work Tasks ---

export interface WorkTask {
  id: string;
  title: string;
  description: string;
  notes: string;
  status: string;
  priority: string;
  assigned_to: string | null;
  created_by: string;
  due_date: string | null;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

export function getWorkTasks(userId?: string): WorkTask[] {
  if (userId) {
    return db
      .prepare('SELECT * FROM user_work_tasks WHERE assigned_to = ? ORDER BY created_at DESC')
      .all(userId) as WorkTask[];
  }
  return db
    .prepare('SELECT * FROM user_work_tasks ORDER BY created_at DESC')
    .all() as WorkTask[];
}

export function getWorkTask(taskId: string): WorkTask | undefined {
  return db
    .prepare('SELECT * FROM user_work_tasks WHERE id = ?')
    .get(taskId) as WorkTask | undefined;
}

export function createWorkTask(task: {
  title: string;
  description?: string;
  notes?: string;
  priority?: string;
  assigned_to?: string;
  created_by: string;
  due_date?: string;
  project_id?: string;
}): WorkTask {
  const id = `wtask-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO user_work_tasks (id, title, description, notes, priority, assigned_to, created_by, due_date, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, task.title, task.description || '', task.notes || '', task.priority || 'medium', task.assigned_to || null, task.created_by, task.due_date || null, task.project_id || null, now, now);
  return getWorkTask(id)!;
}

export function updateWorkTask(taskId: string, updates: Partial<WorkTask>): WorkTask | undefined {
  const existing = getWorkTask(taskId);
  if (!existing) return undefined;
  const fields: string[] = [];
  const values: any[] = [];
  if (updates.title !== undefined) { fields.push('title = ?'); values.push(updates.title); }
  if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
  if (updates.notes !== undefined) { fields.push('notes = ?'); values.push(updates.notes); }
  if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
  if (updates.priority !== undefined) { fields.push('priority = ?'); values.push(updates.priority); }
  if (updates.assigned_to !== undefined) { fields.push('assigned_to = ?'); values.push(updates.assigned_to); }
  if (updates.due_date !== undefined) { fields.push('due_date = ?'); values.push(updates.due_date); }
  if (updates.project_id !== undefined) { fields.push('project_id = ?'); values.push(updates.project_id); }
  if (fields.length === 0) return existing;
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(taskId);
  db.prepare(`UPDATE user_work_tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  const updated = getWorkTask(taskId);
  if (updates.status !== undefined && updated && updated.project_id) {
    recalcProjectProgress(updated.project_id);
  }
  return updated;
}

export function deleteWorkTask(taskId: string): boolean {
  const existing = getWorkTask(taskId);
  const ok = (db.prepare('DELETE FROM user_work_tasks WHERE id = ?').run(taskId).changes as number) > 0;
  if (ok && existing && existing.project_id) {
    recalcProjectProgress(existing.project_id);
  }
  return ok;
}

// --- Dashboard Users ---

export function getUsers(): any[] {
  return db
    .prepare('SELECT * FROM dashboard_users ORDER BY created_at')
    .all()
    .map((u: any) => {
      const { password_hash, ...rest } = u;
      return {
        ...rest,
        allowed_sessions: JSON.parse(u.allowed_sessions || '[]'),
        chat_notifications: !!u.chat_notifications,
        has_password: !!password_hash,
        is_admin: !!u.is_admin,
        webdev_locked: !!u.webdev_locked,
      };
    });
}

// --- Projects ---

export interface Project {
  id: string;
  name: string;
  description: string;
  status: string;
  progress: number;
  due_date: string | null;
  project_code: string;
  group_jid: string;
  owner: string;
  shared_with: string;
  archived: number;
  archived_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectFinancials {
  project_id: string;
  budget: number;
  spent: number;
  revenue: number;
  notes: string;
}

export interface ProjectDeliverable {
  id: string;
  project_id: string;
  name: string;
  due_date: string | null;
  done: number;
}

export interface ProjectBlocker {
  id: string;
  project_id: string;
  blocker: string;
  severity: string;
}

export interface ProjectPriority {
  id: string;
  project_id: string;
  item: string;
  impact: string;
  rank: number;
}

export interface TimesheetEntry {
  id: string;
  project_id: string;
  user_id: string;
  date: string;
  hours: number;
  description: string;
  created_at: string;
}

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function getProjectsByGroup(groupJid: string): Project[] {
  return db.prepare(
    `SELECT * FROM projects WHERE group_jid = ? AND archived = 0 ORDER BY created_at DESC`
  ).all(groupJid) as Project[];
}

export function getProjectsForUser(_userId: string): Project[] {
  // Single-user Warden: no per-user session scoping. Return all projects.
  return getAllProjects();
}

export function getAllProjects(): Project[] {
  return db.prepare(
    `SELECT * FROM projects WHERE archived = 0 ORDER BY created_at DESC`
  ).all() as Project[];
}

export function getArchivedProjectsForUser(_userId: string): Project[] {
  // Single-user Warden: no per-user session scoping. Return all archived.
  return db.prepare(
    `SELECT * FROM projects WHERE archived = 1 ORDER BY archived_at DESC`
  ).all() as Project[];
}

export function getArchivedProjectsByGroup(groupJid: string): Project[] {
  return db.prepare(
    `SELECT * FROM projects WHERE group_jid = ? AND archived = 1 ORDER BY archived_at DESC`
  ).all(groupJid) as Project[];
}

export function getProject(projectId: string): Project | undefined {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
}

/** Resolve a project ID — accepts either the real ID or a project_code. */
export function resolveProjectId(idOrCode: string): string | undefined {
  const direct = db.prepare('SELECT id FROM projects WHERE id = ?').get(idOrCode) as { id: string } | undefined;
  if (direct) return direct.id;
  const byCode = db.prepare('SELECT id FROM projects WHERE project_code = ? COLLATE NOCASE').get(idOrCode) as { id: string } | undefined;
  return byCode?.id;
}

export function createProject(data: { name: string; group_jid: string; description?: string; status?: string; due_date?: string; project_code?: string }): Project {
  const id = genId();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO projects (id, name, description, status, progress, due_date, project_code, group_jid, owner, shared_with, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, '', '[]', ?, ?)`
  ).run(id, data.name, data.description || '', data.status || 'On Track', data.due_date || null, data.project_code || '', data.group_jid, now, now);
  db.prepare('INSERT INTO project_financials (project_id) VALUES (?)').run(id);
  return getProject(id)!;
}

export function updateProject(projectId: string, updates: Partial<Pick<Project, 'name' | 'description' | 'status' | 'progress' | 'due_date' | 'project_code' | 'group_jid'>>): Project | undefined {
  const existing = getProject(projectId);
  if (!existing) return undefined;
  const fields: string[] = [];
  const values: any[] = [];
  for (const [key, val] of Object.entries(updates)) {
    if (val !== undefined && ['name', 'description', 'status', 'progress', 'due_date', 'project_code', 'group_jid'].includes(key)) {
      fields.push(`${key} = ?`);
      values.push(val);
    }
  }
  if (fields.length === 0) return existing;
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(projectId);
  db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getProject(projectId);
}

export function archiveProject(projectId: string): boolean {
  const now = new Date().toISOString();
  return db.prepare('UPDATE projects SET archived = 1, archived_at = ?, updated_at = ? WHERE id = ?').run(now, now, projectId).changes > 0;
}

export function restoreProject(projectId: string): boolean {
  const now = new Date().toISOString();
  return db.prepare('UPDATE projects SET archived = 0, archived_at = NULL, updated_at = ? WHERE id = ?').run(now, projectId).changes > 0;
}

export function completeProject(projectId: string): boolean {
  const now = new Date().toISOString();
  return db.prepare("UPDATE projects SET status = 'Completed', progress = 100, completed_at = ?, archived = 1, archived_at = ?, updated_at = ? WHERE id = ?").run(now, now, now, projectId).changes > 0;
}

export function deleteProject(projectId: string): boolean {
  return db.prepare('DELETE FROM projects WHERE id = ?').run(projectId).changes > 0;
}

// Recalculate progress from deliverables
export function recalcProjectProgress(projectId: string): void {
  const deliverables = getProjectDeliverables(projectId);
  if (deliverables.length === 0) return;
  // Deliverables: done = 1 point
  const delPoints = deliverables.filter(d => d.done).length;
  const progress = Math.round(delPoints / deliverables.length * 100);
  db.prepare('UPDATE projects SET progress = ?, updated_at = ? WHERE id = ?').run(progress, new Date().toISOString(), projectId);
}

// --- Project Financials ---

export function getProjectFinancials(projectId: string): ProjectFinancials {
  const row = db.prepare('SELECT * FROM project_financials WHERE project_id = ?').get(projectId) as ProjectFinancials | undefined;
  return row || { project_id: projectId, budget: 0, spent: 0, revenue: 0, notes: '' };
}

export function updateProjectFinancials(projectId: string, data: Partial<Omit<ProjectFinancials, 'project_id'>>): ProjectFinancials {
  const existing = getProjectFinancials(projectId);
  db.prepare(
    `INSERT INTO project_financials (project_id, budget, spent, revenue, notes) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET budget=excluded.budget, spent=excluded.spent, revenue=excluded.revenue, notes=excluded.notes`
  ).run(
    projectId,
    data.budget ?? existing.budget,
    data.spent ?? existing.spent,
    data.revenue ?? existing.revenue,
    data.notes ?? existing.notes,
  );
  return getProjectFinancials(projectId);
}

// --- Project Deliverables ---

export function getProjectDeliverables(projectId: string): ProjectDeliverable[] {
  return db.prepare('SELECT * FROM project_deliverables WHERE project_id = ? ORDER BY done ASC, due_date ASC').all(projectId) as ProjectDeliverable[];
}

export function addProjectDeliverable(projectId: string, name: string, dueDate?: string): ProjectDeliverable {
  const id = genId();
  db.prepare('INSERT INTO project_deliverables (id, project_id, name, due_date) VALUES (?, ?, ?, ?)').run(id, projectId, name, dueDate || null);
  recalcProjectProgress(projectId);
  return db.prepare('SELECT * FROM project_deliverables WHERE id = ?').get(id) as ProjectDeliverable;
}

export function toggleDeliverable(deliverableId: string): ProjectDeliverable | undefined {
  const d = db.prepare('SELECT * FROM project_deliverables WHERE id = ?').get(deliverableId) as ProjectDeliverable | undefined;
  if (!d) return undefined;
  db.prepare('UPDATE project_deliverables SET done = ? WHERE id = ?').run(d.done ? 0 : 1, deliverableId);
  recalcProjectProgress(d.project_id);
  return db.prepare('SELECT * FROM project_deliverables WHERE id = ?').get(deliverableId) as ProjectDeliverable;
}

/** Set a deliverable's done state to an explicit value (used by the Kontact
 *  VTODO mirror-back so a checkbox toggle in KOrganizer flows into the project
 *  graph, not just a flip-from-current). */
export function setDeliverableDone(deliverableId: string, done: 0 | 1): boolean {
  const d = db.prepare('SELECT project_id FROM project_deliverables WHERE id = ?').get(deliverableId) as { project_id: string } | undefined;
  if (!d) return false;
  const changes = db.prepare('UPDATE project_deliverables SET done = ? WHERE id = ? AND done != ?').run(done, deliverableId, done).changes;
  if (changes > 0) recalcProjectProgress(d.project_id);
  return changes > 0;
}

export function updateDeliverable(deliverableId: string, name?: string, dueDate?: string | null): ProjectDeliverable | undefined {
  const d = db.prepare('SELECT * FROM project_deliverables WHERE id = ?').get(deliverableId) as ProjectDeliverable | undefined;
  if (!d) return undefined;
  const newName = name !== undefined ? name : d.name;
  const newDue = dueDate !== undefined ? dueDate : d.due_date;
  db.prepare('UPDATE project_deliverables SET name = ?, due_date = ? WHERE id = ?').run(newName, newDue, deliverableId);
  return db.prepare('SELECT * FROM project_deliverables WHERE id = ?').get(deliverableId) as ProjectDeliverable;
}

export function deleteDeliverable(deliverableId: string): boolean {
  const d = db.prepare('SELECT project_id FROM project_deliverables WHERE id = ?').get(deliverableId) as { project_id: string } | undefined;
  const ok = db.prepare('DELETE FROM project_deliverables WHERE id = ?').run(deliverableId).changes > 0;
  if (ok && d) recalcProjectProgress(d.project_id);
  return ok;
}

// --- Project Blockers ---

export function getProjectBlockers(projectId: string): ProjectBlocker[] {
  return db.prepare('SELECT * FROM project_blockers WHERE project_id = ?').all(projectId) as ProjectBlocker[];
}

export function addProjectBlocker(projectId: string, blocker: string, severity?: string): ProjectBlocker {
  const id = genId();
  db.prepare('INSERT INTO project_blockers (id, project_id, blocker, severity) VALUES (?, ?, ?, ?)').run(id, projectId, blocker, severity || 'medium');
  return db.prepare('SELECT * FROM project_blockers WHERE id = ?').get(id) as ProjectBlocker;
}

export function deleteBlocker(blockerId: string): boolean {
  return db.prepare('DELETE FROM project_blockers WHERE id = ?').run(blockerId).changes > 0;
}

// --- Project Priorities ---

export function getProjectPriorities(projectId: string): ProjectPriority[] {
  return db.prepare('SELECT * FROM project_priorities WHERE project_id = ? ORDER BY rank ASC').all(projectId) as ProjectPriority[];
}

export function addProjectPriority(projectId: string, item: string, impact?: string): ProjectPriority {
  const id = genId();
  const maxRank = (db.prepare('SELECT MAX(rank) as mr FROM project_priorities WHERE project_id = ?').get(projectId) as any)?.mr || 0;
  db.prepare('INSERT INTO project_priorities (id, project_id, item, impact, rank) VALUES (?, ?, ?, ?, ?)').run(id, projectId, item, impact || 'medium', maxRank + 1);
  return db.prepare('SELECT * FROM project_priorities WHERE id = ?').get(id) as ProjectPriority;
}

export function deleteProjectPriority(priorityId: string): boolean {
  return db.prepare('DELETE FROM project_priorities WHERE id = ?').run(priorityId).changes > 0;
}

// --- Timesheet ---

export function getTimesheetEntries(projectId: string): (TimesheetEntry & { user_name?: string })[] {
  return db.prepare(
    `SELECT t.*, u.name AS user_name FROM project_timesheet t
     LEFT JOIN dashboard_users u ON t.user_id = u.id
     WHERE t.project_id = ? ORDER BY t.date DESC, t.created_at DESC`
  ).all(projectId) as (TimesheetEntry & { user_name?: string })[];
}

export function addTimesheetEntry(data: { project_id: string; user_id: string; date: string; hours: number; description?: string }): TimesheetEntry {
  const id = genId();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO project_timesheet (id, project_id, user_id, date, hours, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, data.project_id, data.user_id, data.date, data.hours, data.description || '', now);
  return db.prepare('SELECT * FROM project_timesheet WHERE id = ?').get(id) as TimesheetEntry;
}

export function deleteTimesheetEntry(entryId: string): boolean {
  return db.prepare('DELETE FROM project_timesheet WHERE id = ?').run(entryId).changes > 0;
}

export function getTimesheetSummary(projectId: string): { total_hours: number; by_user: { user_id: string; user_name: string; hours: number }[] } {
  const total = (db.prepare('SELECT COALESCE(SUM(hours), 0) as total FROM project_timesheet WHERE project_id = ?').get(projectId) as any).total;
  const byUser = db.prepare(
    `SELECT t.user_id, u.name AS user_name, SUM(t.hours) AS hours
     FROM project_timesheet t LEFT JOIN dashboard_users u ON t.user_id = u.id
     WHERE t.project_id = ? GROUP BY t.user_id ORDER BY hours DESC`
  ).all(projectId) as { user_id: string; user_name: string; hours: number }[];
  return { total_hours: total, by_user: byUser };
}

// --- Active Timers ---

export interface ActiveTimer {
  id: string;
  project_id: string;
  user_id: string;
  description: string;
  started_at: string;
  project_name?: string;
  user_name?: string;
}

export function getActiveTimers(projectId?: string): ActiveTimer[] {
  if (projectId) {
    return db.prepare(
      `SELECT t.*, p.name AS project_name, u.name AS user_name FROM active_timers t
       LEFT JOIN projects p ON t.project_id = p.id
       LEFT JOIN dashboard_users u ON t.user_id = u.id
       WHERE t.project_id = ? ORDER BY t.started_at DESC`
    ).all(projectId) as ActiveTimer[];
  }
  return db.prepare(
    `SELECT t.*, p.name AS project_name, u.name AS user_name FROM active_timers t
     LEFT JOIN projects p ON t.project_id = p.id
     LEFT JOIN dashboard_users u ON t.user_id = u.id
     ORDER BY t.started_at DESC`
  ).all() as ActiveTimer[];
}

export function startTimer(data: { project_id: string; user_id: string; description?: string }): ActiveTimer {
  const id = genId();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO active_timers (id, project_id, user_id, description, started_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, data.project_id, data.user_id, data.description || '', now);
  return db.prepare(
    `SELECT t.*, p.name AS project_name, u.name AS user_name FROM active_timers t
     LEFT JOIN projects p ON t.project_id = p.id LEFT JOIN dashboard_users u ON t.user_id = u.id
     WHERE t.id = ?`
  ).get(id) as ActiveTimer;
}

export function stopTimer(timerId: string): TimesheetEntry | null {
  const timer = db.prepare('SELECT * FROM active_timers WHERE id = ?').get(timerId) as ActiveTimer | undefined;
  if (!timer) return null;
  const started = new Date(timer.started_at);
  const elapsed = (Date.now() - started.getTime()) / 3600000; // hours
  const hours = Math.round(elapsed * 4) / 4; // round to nearest 15 min
  const date = new Date().toISOString().split('T')[0];
  const entry = addTimesheetEntry({
    project_id: timer.project_id,
    user_id: timer.user_id,
    date,
    hours: Math.max(hours, 0.25), // minimum 15 min
    description: timer.description,
  });
  db.prepare('DELETE FROM active_timers WHERE id = ?').run(timerId);
  return entry;
}

export function deleteTimer(timerId: string): boolean {
  return db.prepare('DELETE FROM active_timers WHERE id = ?').run(timerId).changes > 0;
}

export function updateTimesheetEntry(entryId: string, updates: { date?: string; hours?: number; description?: string }): TimesheetEntry | undefined {
  const existing = db.prepare('SELECT * FROM project_timesheet WHERE id = ?').get(entryId) as TimesheetEntry | undefined;
  if (!existing) return undefined;
  const fields: string[] = [];
  const values: any[] = [];
  if (updates.date !== undefined) { fields.push('date = ?'); values.push(updates.date); }
  if (updates.hours !== undefined) { fields.push('hours = ?'); values.push(updates.hours); }
  if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
  if (fields.length === 0) return existing;
  values.push(entryId);
  db.prepare(`UPDATE project_timesheet SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return db.prepare('SELECT * FROM project_timesheet WHERE id = ?').get(entryId) as TimesheetEntry;
}

// --- Email Accounts ---

export interface EmailAccount {
  id: string;
  user_id: string | null;
  name: string;
  email: string;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  username: string;
  password: string;
  use_tls: number;
  read_only: number;
  enabled: number;
  created_at: string;
  oauth_account_id?: string | null;
}

export function createEmailAccount(account: {
  name: string;
  email: string;
  imap_host: string;
  imap_port?: number;
  smtp_host: string;
  smtp_port?: number;
  username: string;
  password: string;
  use_tls?: boolean;
  read_only?: boolean;
  enabled?: boolean;
  user_id?: string | null;
}): EmailAccount {
  const id = `email-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO email_accounts (id, user_id, name, email, imap_host, imap_port, smtp_host, smtp_port, username, password, use_tls, read_only, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    account.user_id ?? null,
    account.name,
    account.email,
    account.imap_host,
    account.imap_port ?? 993,
    account.smtp_host,
    account.smtp_port ?? 587,
    account.username,
    account.password,
    account.use_tls === false ? 0 : 1,
    account.read_only === false ? 0 : 1, // DEFAULT READ ONLY
    account.enabled === false ? 0 : 1,
    now,
  );
  return getEmailAccount(id)!;
}

export function getEmailAccounts(_userId?: string | null): EmailAccount[] {
  // Single-user: every account belongs to the owner. The old multi-user
  // scoping (NULL-owned "system" accounts vs per-user rows) silently hid
  // accounts saved with user_id='owner' from unscoped calls — the dashboard
  // and iris both saw an empty list. Scoping dropped; return everything.
  return db
    .prepare('SELECT * FROM email_accounts ORDER BY created_at DESC')
    .all() as EmailAccount[];
}

export function getEmailAccount(id: string): EmailAccount | undefined {
  return db
    .prepare('SELECT * FROM email_accounts WHERE id = ?')
    .get(id) as EmailAccount | undefined;
}

export function updateEmailAccount(
  id: string,
  updates: Partial<Omit<EmailAccount, 'id' | 'created_at'>>,
): EmailAccount | undefined {
  const existing = getEmailAccount(id);
  if (!existing) return undefined;

  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
  if (updates.email !== undefined) { fields.push('email = ?'); values.push(updates.email); }
  if (updates.imap_host !== undefined) { fields.push('imap_host = ?'); values.push(updates.imap_host); }
  if (updates.imap_port !== undefined) { fields.push('imap_port = ?'); values.push(updates.imap_port); }
  if (updates.smtp_host !== undefined) { fields.push('smtp_host = ?'); values.push(updates.smtp_host); }
  if (updates.smtp_port !== undefined) { fields.push('smtp_port = ?'); values.push(updates.smtp_port); }
  if (updates.username !== undefined) { fields.push('username = ?'); values.push(updates.username); }
  if (updates.password !== undefined) { fields.push('password = ?'); values.push(updates.password); }
  if (updates.use_tls !== undefined) { fields.push('use_tls = ?'); values.push(updates.use_tls); }
  if (updates.read_only !== undefined) { fields.push('read_only = ?'); values.push(updates.read_only); }
  if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled); }
  if (updates.user_id !== undefined) { fields.push('user_id = ?'); values.push(updates.user_id); }
  if (updates.oauth_account_id !== undefined) { fields.push('oauth_account_id = ?'); values.push(updates.oauth_account_id); }

  if (fields.length === 0) return existing;

  values.push(id);
  db.prepare(`UPDATE email_accounts SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getEmailAccount(id);
}

export function deleteEmailAccount(id: string): boolean {
  return db.prepare('DELETE FROM email_accounts WHERE id = ?').run(id).changes > 0;
}

// --- Email Drafts ---

export interface EmailDraft {
  id: string;
  account_id: string;
  to_email: string;
  subject: string;
  body: string;
  created_at: string;
}

export function createEmailDraft(draft: {
  account_id: string;
  to_email: string;
  subject: string;
  body: string;
}): EmailDraft {
  const id = `draft-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO email_drafts (id, account_id, to_email, subject, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, draft.account_id, draft.to_email, draft.subject, draft.body, now);
  return getEmailDraft(id)!;
}

export function getEmailDraft(id: string): EmailDraft | undefined {
  return db.prepare('SELECT * FROM email_drafts WHERE id = ?').get(id) as EmailDraft | undefined;
}

export function getEmailDraftsByAccount(accountId: string): EmailDraft[] {
  return db
    .prepare('SELECT * FROM email_drafts WHERE account_id = ? ORDER BY created_at DESC')
    .all(accountId) as EmailDraft[];
}

export function deleteEmailDraft(id: string): boolean {
  return db.prepare('DELETE FROM email_drafts WHERE id = ?').run(id).changes > 0;
}

// --- SMS Accounts ---

export interface SmsAccount {
  id: string;
  user_id: string | null;
  name: string;
  phone_number: string;
  account_sid: string;
  auth_token: string;
  read_only: number;
  enabled: number;
  created_at: string;
}

export interface SmsMessage {
  id: string;
  account_id: string;
  direction: string;
  from_number: string;
  to_number: string;
  body: string;
  twilio_sid: string | null;
  status: string | null;
  created_at: string;
}

export function createSmsAccount(account: {
  name: string;
  phone_number: string;
  account_sid: string;
  auth_token: string;
  read_only?: boolean;
  enabled?: boolean;
  user_id?: string | null;
}): SmsAccount {
  const id = `sms-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sms_accounts (id, user_id, name, phone_number, account_sid, auth_token, read_only, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    account.user_id || null,
    account.name,
    account.phone_number,
    account.account_sid,
    account.auth_token,
    account.read_only === false ? 0 : 1,
    account.enabled === false ? 0 : 1,
    now,
  );
  return getSmsAccount(id)!;
}

export function getSmsAccounts(userId?: string | null): SmsAccount[] {
  if (userId === undefined) {
    // System-level call — only return unowned accounts
    return db
      .prepare('SELECT * FROM sms_accounts WHERE user_id IS NULL ORDER BY created_at DESC')
      .all() as SmsAccount[];
  }
  if (userId) {
    return db
      .prepare('SELECT * FROM sms_accounts WHERE user_id = ? ORDER BY created_at DESC')
      .all(userId) as SmsAccount[];
  }
  // Explicit null = no accounts. Never leak all accounts.
  return [];
}

export function getSmsAccount(id: string): SmsAccount | undefined {
  return db.prepare('SELECT * FROM sms_accounts WHERE id = ?').get(id) as SmsAccount | undefined;
}

export function updateSmsAccount(
  id: string,
  updates: Partial<Pick<SmsAccount, 'name' | 'phone_number' | 'account_sid' | 'auth_token' | 'read_only' | 'enabled'>>,
): boolean {
  const fields: string[] = [];
  const values: any[] = [];
  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
  if (updates.phone_number !== undefined) { fields.push('phone_number = ?'); values.push(updates.phone_number); }
  if (updates.account_sid !== undefined) { fields.push('account_sid = ?'); values.push(updates.account_sid); }
  if (updates.auth_token !== undefined) { fields.push('auth_token = ?'); values.push(updates.auth_token); }
  if (updates.read_only !== undefined) { fields.push('read_only = ?'); values.push(updates.read_only); }
  if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled); }
  if (fields.length === 0) return false;
  values.push(id);
  return db.prepare(`UPDATE sms_accounts SET ${fields.join(', ')} WHERE id = ?`).run(...values).changes > 0;
}

export function deleteSmsAccount(id: string): boolean {
  return db.prepare('DELETE FROM sms_accounts WHERE id = ?').run(id).changes > 0;
}

export function storeSmsMessage(msg: {
  account_id: string;
  direction: string;
  from_number: string;
  to_number: string;
  body: string;
  twilio_sid?: string;
  status?: string;
}): SmsMessage {
  const id = `smsmsg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sms_messages (id, account_id, direction, from_number, to_number, body, twilio_sid, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, msg.account_id, msg.direction, msg.from_number, msg.to_number, msg.body, msg.twilio_sid || null, msg.status || null, now);
  return db.prepare('SELECT * FROM sms_messages WHERE id = ?').get(id) as SmsMessage;
}

export function getSmsMessages(accountId: string, limit: number = 100, fromNumber?: string): SmsMessage[] {
  if (fromNumber) {
    return db
      .prepare('SELECT * FROM sms_messages WHERE account_id = ? AND (from_number = ? OR to_number = ?) ORDER BY created_at DESC LIMIT ?')
      .all(accountId, fromNumber, fromNumber, limit) as SmsMessage[];
  }
  return db
    .prepare('SELECT * FROM sms_messages WHERE account_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(accountId, limit) as SmsMessage[];
}

// --- OAuth accounts ---

export interface OAuthAccount {
  id: string;
  user_id: string;
  provider: string;
  scopes: string;
  access_token: string;
  refresh_token: string;
  token_iv: string;
  token_auth_tag: string;
  refresh_iv: string;
  refresh_auth_tag: string;
  expires_at: string;
  email: string | null;
  calendar_enabled: number;
  email_enabled: number;
  enabled: number;
  last_calendar_sync: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export function createOAuthAccount(data: {
  id: string;
  user_id: string;
  provider: string;
  scopes: string;
  access_token: string;
  refresh_token: string;
  token_iv: string;
  token_auth_tag: string;
  refresh_iv: string;
  refresh_auth_tag: string;
  expires_at: string;
  email?: string | null;
  calendar_enabled?: number;
  email_enabled?: number;
  enabled?: number;
}): OAuthAccount {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO oauth_accounts (id, user_id, provider, scopes, access_token, refresh_token, token_iv, token_auth_tag, refresh_iv, refresh_auth_tag, expires_at, email, calendar_enabled, email_enabled, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    data.id,
    data.user_id,
    data.provider,
    data.scopes,
    data.access_token,
    data.refresh_token,
    data.token_iv,
    data.token_auth_tag,
    data.refresh_iv,
    data.refresh_auth_tag,
    data.expires_at,
    data.email ?? null,
    data.calendar_enabled ?? 1,
    data.email_enabled ?? 1,
    data.enabled ?? 1,
    now,
    now,
  );
  return getOAuthAccount(data.id)!;
}

export function getOAuthAccount(id: string): OAuthAccount | undefined {
  return db
    .prepare('SELECT * FROM oauth_accounts WHERE id = ?')
    .get(id) as OAuthAccount | undefined;
}

export function getOAuthAccountsByUser(userId: string): OAuthAccount[] {
  return db
    .prepare('SELECT * FROM oauth_accounts WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as OAuthAccount[];
}

export function getOAuthAccountsWithCalendar(): OAuthAccount[] {
  return db
    .prepare('SELECT * FROM oauth_accounts WHERE calendar_enabled = 1 AND enabled = 1')
    .all() as OAuthAccount[];
}

export function updateOAuthAccount(
  id: string,
  updates: Partial<Omit<OAuthAccount, 'id' | 'created_at'>>,
): OAuthAccount | undefined {
  const existing = getOAuthAccount(id);
  if (!existing) return undefined;

  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.user_id !== undefined) { fields.push('user_id = ?'); values.push(updates.user_id); }
  if (updates.provider !== undefined) { fields.push('provider = ?'); values.push(updates.provider); }
  if (updates.scopes !== undefined) { fields.push('scopes = ?'); values.push(updates.scopes); }
  if (updates.access_token !== undefined) { fields.push('access_token = ?'); values.push(updates.access_token); }
  if (updates.refresh_token !== undefined) { fields.push('refresh_token = ?'); values.push(updates.refresh_token); }
  if (updates.token_iv !== undefined) { fields.push('token_iv = ?'); values.push(updates.token_iv); }
  if (updates.token_auth_tag !== undefined) { fields.push('token_auth_tag = ?'); values.push(updates.token_auth_tag); }
  if (updates.refresh_iv !== undefined) { fields.push('refresh_iv = ?'); values.push(updates.refresh_iv); }
  if (updates.refresh_auth_tag !== undefined) { fields.push('refresh_auth_tag = ?'); values.push(updates.refresh_auth_tag); }
  if (updates.expires_at !== undefined) { fields.push('expires_at = ?'); values.push(updates.expires_at); }
  if (updates.email !== undefined) { fields.push('email = ?'); values.push(updates.email); }
  if (updates.calendar_enabled !== undefined) { fields.push('calendar_enabled = ?'); values.push(updates.calendar_enabled); }
  if (updates.email_enabled !== undefined) { fields.push('email_enabled = ?'); values.push(updates.email_enabled); }
  if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled); }
  if (updates.last_calendar_sync !== undefined) { fields.push('last_calendar_sync = ?'); values.push(updates.last_calendar_sync); }

  if (fields.length === 0) return existing;

  // Always set updated_at
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());

  values.push(id);
  db.prepare(`UPDATE oauth_accounts SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getOAuthAccount(id);
}

export function deleteOAuthAccount(id: string): boolean {
  return db.prepare('DELETE FROM oauth_accounts WHERE id = ?').run(id).changes > 0;
}

export function getEmailAccountByOAuthId(oauthAccountId: string): EmailAccount | undefined {
  return db
    .prepare('SELECT * FROM email_accounts WHERE oauth_account_id = ?')
    .get(oauthAccountId) as EmailAccount | undefined;
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }
}

// --- User Notifications ---

export interface UserNotification {
  id: string;
  user_id: string;
  type: string;
  message: string;
  task_id: string | null;
  read: number;
  created_at: string;
}

export function insertNotification(n: {
  userId: string;
  type: string;
  message: string;
  taskId?: string;
}): string {
  const id = `notif-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO user_notifications (id, user_id, type, message, task_id, read, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)`,
  ).run(id, n.userId, n.type, n.message, n.taskId || null, now);

  // Keep max 100 per user — delete oldest beyond that
  db.prepare(
    `DELETE FROM user_notifications WHERE user_id = ? AND id NOT IN (SELECT id FROM user_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 500)`,
  ).run(n.userId, n.userId);

  return id;
}

export function getNotifications(userId: string, limit: number = 50): UserNotification[] {
  return db.prepare(
    `SELECT * FROM user_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
  ).all(userId, limit) as UserNotification[];
}

export function getUnreadNotificationCount(userId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) as count FROM user_notifications WHERE user_id = ? AND read = 0`,
  ).get(userId) as { count: number };
  return row.count;
}

export function markNotificationRead(notifId: string, userId: string): boolean {
  const result = db.prepare(
    `UPDATE user_notifications SET read = 1 WHERE id = ? AND user_id = ?`,
  ).run(notifId, userId);
  return result.changes > 0;
}

export function markAllNotificationsRead(userId: string): number {
  const result = db.prepare(
    `UPDATE user_notifications SET read = 1 WHERE user_id = ? AND read = 0`,
  ).run(userId);
  return result.changes;
}

export function deleteNotification(notifId: string, userId: string): boolean {
  const result = db.prepare(
    `DELETE FROM user_notifications WHERE id = ? AND user_id = ?`,
  ).run(notifId, userId);
  return result.changes > 0;
}

export function clearAllNotifications(userId: string): number {
  const result = db.prepare(
    `DELETE FROM user_notifications WHERE user_id = ?`,
  ).run(userId);
  return result.changes;
}

// --- Calendar Events ---

export interface CalendarEvent {
  id: string;
  title: string;
  description: string;
  start_time: string;
  end_time: string | null;
  all_day: number;
  location: string;
  recurrence: string;
  color: string;
  assigned_to: string | null;
  created_by: string | null;
  work_task_id: string | null;
  calendar_source: string;
  ical_uid: string | null;
  provider_calendar_id: string;
  provider_calendar_name: string;
  created_at: string;
  updated_at: string;
}

export function getCalendarEvent(id: string): CalendarEvent | undefined {
  return db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id) as CalendarEvent | undefined;
}

export function listCalendarEvents(filter?: {
  start?: string;
  end?: string;
  assigned_to?: string;
}): CalendarEvent[] {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter?.start) {
    conditions.push('start_time >= ?');
    values.push(filter.start);
  }
  if (filter?.end) {
    conditions.push('start_time <= ?');
    values.push(filter.end);
  }
  if (filter?.assigned_to) {
    conditions.push('assigned_to = ?');
    values.push(filter.assigned_to);
  }

  const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
  return db.prepare(`SELECT * FROM calendar_events${where} ORDER BY start_time ASC`).all(...values) as CalendarEvent[];
}

export function createCalendarEvent(event: {
  title: string;
  description?: string;
  start_time: string;
  end_time?: string;
  all_day?: boolean;
  location?: string;
  recurrence?: string;
  color?: string;
  assigned_to?: string;
  created_by?: string;
  work_task_id?: string;
  calendar_source?: string;
  ical_uid?: string;
  provider_calendar_id?: string;
  provider_calendar_name?: string;
}): CalendarEvent {
  const id = `cal-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO calendar_events (id, title, description, start_time, end_time, all_day, location, recurrence, color, assigned_to, created_by, work_task_id, calendar_source, ical_uid, provider_calendar_id, provider_calendar_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    event.title,
    event.description || '',
    event.start_time,
    event.end_time || null,
    event.all_day ? 1 : 0,
    event.location || '',
    event.recurrence || '',
    event.color || '',
    event.assigned_to || null,
    event.created_by || null,
    event.work_task_id || null,
    event.calendar_source || 'local',
    event.ical_uid || null,
    event.provider_calendar_id || '',
    event.provider_calendar_name || '',
    now,
    now,
  );
  return getCalendarEvent(id)!;
}

export function updateCalendarEvent(id: string, updates: Partial<CalendarEvent>): CalendarEvent | undefined {
  const existing = getCalendarEvent(id);
  if (!existing) return undefined;

  const fields: string[] = [];
  const values: unknown[] = [];

  const allowedFields = ['title', 'description', 'start_time', 'end_time', 'all_day', 'location', 'recurrence', 'color', 'assigned_to', 'work_task_id', 'calendar_source', 'ical_uid', 'provider_calendar_id', 'provider_calendar_name'] as const;
  for (const f of allowedFields) {
    if (updates[f] !== undefined) {
      fields.push(`${f} = ?`);
      values.push(updates[f]);
    }
  }

  if (fields.length === 0) return existing;

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  db.prepare(`UPDATE calendar_events SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getCalendarEvent(id);
}

export function deleteCalendarEvent(id: string): boolean {
  return db.prepare('DELETE FROM calendar_events WHERE id = ?').run(id).changes > 0;
}

// --- User Alarms ---

export interface UserAlarm {
  id: string;
  user_id: string;
  label: string;
  alarm_time: string;
  alarm_date: string | null;
  repeat_type: string;
  repeat_days: string;
  enabled: boolean;
  snooze_until: string | null;
  last_fired: string | null;
  sound: string;
  created_at: string;
}

export function getUserAlarms(userId: string): UserAlarm[] {
  return (db.prepare('SELECT * FROM user_alarms WHERE user_id = ? ORDER BY alarm_time').all(userId) as any[])
    .map((a) => ({ ...a, enabled: !!a.enabled }));
}

export function getAlarmById(alarmId: string): UserAlarm | undefined {
  const row = db.prepare('SELECT * FROM user_alarms WHERE id = ?').get(alarmId) as any;
  return row ? { ...row, enabled: !!row.enabled } : undefined;
}

export function createAlarm(userId: string, alarm: {
  label: string;
  alarm_time: string;
  alarm_date?: string;
  repeat_type?: string;
  repeat_days?: string;
  sound?: string;
}): UserAlarm {
  const id = `alarm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    `INSERT INTO user_alarms (id, user_id, label, alarm_time, alarm_date, repeat_type, repeat_days, sound)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, userId, alarm.label, alarm.alarm_time, alarm.alarm_date || null,
        alarm.repeat_type || 'once', alarm.repeat_days || '', alarm.sound || 'default');
  return getAlarmById(id)!;
}

export function updateAlarm(alarmId: string, updates: Partial<{
  label: string;
  alarm_time: string;
  alarm_date: string | null;
  repeat_type: string;
  repeat_days: string;
  enabled: number;
  snooze_until: string | null;
  sound: string;
}>): UserAlarm | undefined {
  const allowedCols = new Set([
    'label',
    'alarm_time',
    'alarm_date',
    'repeat_type',
    'repeat_days',
    'enabled',
    'snooze_until',
    'sound',
  ]);
  const setClauses: string[] = [];
  const values: any[] = [];
  for (const [k, v] of Object.entries(updates)) {
    if (!allowedCols.has(k)) continue;
    setClauses.push(`${k} = ?`);
    values.push(v);
  }
  if (setClauses.length === 0) return getAlarmById(alarmId);
  values.push(alarmId);
  db.prepare(`UPDATE user_alarms SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
  return getAlarmById(alarmId);
}

export function deleteAlarm(alarmId: string): boolean {
  return db.prepare('DELETE FROM user_alarms WHERE id = ?').run(alarmId).changes > 0;
}

export function getDueAlarms(currentTime: string, currentDay: string, currentDate: string): any[] {
  // Single-user Warden: no dashboard_users table — user_name is always 'Owner'.
  return (db.prepare(`
    SELECT a.*, 'Owner' as user_name
    FROM user_alarms a
    WHERE a.enabled = 1
      AND a.alarm_time = ?
      AND (a.snooze_until IS NULL OR a.snooze_until <= datetime('now'))
      AND (a.last_fired IS NULL OR a.last_fired < datetime('now', '-30 seconds'))
  `).all(currentTime) as any[])
    .filter((a) => {
      if (a.repeat_type === 'once') return a.alarm_date === currentDate;
      if (a.repeat_type === 'daily') return true;
      if (a.repeat_type === 'weekdays') return ['mon','tue','wed','thu','fri'].includes(currentDay);
      if (a.repeat_type === 'weekends') return ['sat','sun'].includes(currentDay);
      if (a.repeat_type === 'custom') return a.repeat_days.split(',').includes(currentDay);
      return false;
    });
}

export function markAlarmFired(alarmId: string): void {
  db.prepare("UPDATE user_alarms SET last_fired = datetime('now') WHERE id = ?").run(alarmId);
}

export function snoozeAlarm(alarmId: string, minutes: number): void {
  db.prepare("UPDATE user_alarms SET snooze_until = datetime('now', '+' || ? || ' minutes') WHERE id = ?").run(minutes, alarmId);
}

export function disableOneTimeAlarm(alarmId: string): void {
  db.prepare("UPDATE user_alarms SET enabled = 0 WHERE id = ? AND repeat_type = 'once'").run(alarmId);
}

// ====================== Per-user API keys ======================

export interface UserApiKeyRow {
  id: string;
  user_id: string;
  key_type: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  label: string;
  base_url: string;
  default_model: string;
  auth_header_format: string;
  is_active: number;
  usage_tokens: number;
  usage_cost_cents: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export function addUserApiKey(
  id: string,
  userId: string,
  keyType: string,
  encrypted: string,
  iv: string,
  authTag: string,
  label: string,
  baseUrl?: string,
  defaultModel?: string,
  authHeaderFormat: string = 'Bearer {key}',
): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO user_api_keys (id, user_id, key_type, encrypted_key, iv, auth_tag, label, base_url, default_model, auth_header_format, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, keyType, encrypted, iv, authTag, label, baseUrl || '', defaultModel || '', authHeaderFormat, now, now);
}

export function getUserApiKeyById(keyId: string): UserApiKeyRow | undefined {
  return db.prepare('SELECT * FROM user_api_keys WHERE id = ?').get(keyId) as UserApiKeyRow | undefined;
}

export function getUserApiKeys(userId: string): UserApiKeyRow[] {
  return db.prepare(
    'SELECT * FROM user_api_keys WHERE user_id = ? ORDER BY created_at DESC',
  ).all(userId) as UserApiKeyRow[];
}

export function getActiveUserApiKey(userId: string, keyType?: string): UserApiKeyRow | undefined {
  if (keyType) {
    return db.prepare(
      'SELECT * FROM user_api_keys WHERE user_id = ? AND key_type = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1',
    ).get(userId, keyType) as UserApiKeyRow | undefined;
  }
  return db.prepare(
    'SELECT * FROM user_api_keys WHERE user_id = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1',
  ).get(userId) as UserApiKeyRow | undefined;
}

export function updateUserApiKey(keyId: string, updates: { label?: string; is_active?: number }): void {
  const now = new Date().toISOString();
  const sets: string[] = ['updated_at = ?'];
  const params: any[] = [now];
  if (updates.label !== undefined) { sets.push('label = ?'); params.push(updates.label); }
  if (updates.is_active !== undefined) { sets.push('is_active = ?'); params.push(updates.is_active); }
  params.push(keyId);
  db.prepare(`UPDATE user_api_keys SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function deleteUserApiKey(keyId: string): void {
  db.prepare('DELETE FROM user_api_keys WHERE id = ?').run(keyId);
}

export function getAllUserApiKeys(): UserApiKeyRow[] {
  return db.prepare('SELECT * FROM user_api_keys ORDER BY user_id, created_at DESC').all() as UserApiKeyRow[];
}

export function getActiveUserApiKeyByType(userId: string, keyType: string): UserApiKeyRow | undefined {
  return db.prepare(
    'SELECT * FROM user_api_keys WHERE user_id = ? AND key_type = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1',
  ).get(userId, keyType) as UserApiKeyRow | undefined;
}


// ====================== API usage logging ======================

export function logApiUsage(
  userId: string,
  keyId: string,
  groupFolder: string | null,
  model: string | null,
  inputTokens: number,
  outputTokens: number,
  costCents: number,
): void {
  const now = new Date().toISOString();
  const totalTokens = inputTokens + outputTokens;
  db.prepare(`
    INSERT INTO api_usage_log (user_id, key_id, group_folder, model, input_tokens, output_tokens, estimated_cost_cents, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, keyId, groupFolder, model, inputTokens, outputTokens, costCents, now);

  // Update running totals on the key
  db.prepare(`
    UPDATE user_api_keys SET usage_tokens = usage_tokens + ? WHERE id = ?
  `).run(totalTokens, keyId);
}

export function getUserApiUsage(userId: string, sinceDays = 30): any[] {
  return db.prepare(`
    SELECT * FROM api_usage_log WHERE user_id = ? AND created_at >= datetime('now', '-' || ? || ' days')
    ORDER BY created_at DESC
  `).all(userId, sinceDays);
}

export function getGlobalApiUsage(sinceDays = 30): any[] {
  return db.prepare(`
    SELECT u.user_id, d.name as user_name, u.model,
           SUM(u.input_tokens) as total_input, SUM(u.output_tokens) as total_output,
           SUM(u.estimated_cost_cents) as total_cost_cents, COUNT(*) as request_count
    FROM api_usage_log u
    LEFT JOIN dashboard_users d ON u.user_id = d.id
    WHERE u.created_at >= datetime('now', '-' || ? || ' days')
    GROUP BY u.user_id, u.model
    ORDER BY total_cost_cents DESC
  `).all(sinceDays);
}

export function getUserApiUsageSummary(userId: string, period?: string, days?: number): { byModelRows: any[]; dailyRows: any[] } {
  let startStr: string;
  let endStr: string;

  if (days && days > 0) {
    // Rolling N-day window
    const now = new Date();
    const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    startStr = start.toISOString();
    endStr = now.toISOString();
  } else {
    // Calendar month (default)
    const now = new Date();
    const yr = period ? parseInt(period.split('-')[0]) : now.getFullYear();
    const mo = period ? parseInt(period.split('-')[1]) - 1 : now.getMonth();
    const start = new Date(yr, mo, 1);
    const end = new Date(yr, mo + 1, 1);
    startStr = start.toISOString();
    endStr = end.toISOString();
  }

  const byModelRows = db.prepare(`
    SELECT model,
           COUNT(*) as requests,
           SUM(input_tokens) as input_tokens,
           SUM(output_tokens) as output_tokens,
           SUM(estimated_cost_cents) as cost_cents
    FROM api_usage_log
    WHERE user_id = ? AND created_at >= ? AND created_at < ?
    GROUP BY model
  `).all(userId, startStr, endStr) as any[];

  const dailyRows = db.prepare(`
    SELECT DATE(created_at) as date,
           COUNT(*) as requests,
           SUM(input_tokens) + SUM(output_tokens) as tokens
    FROM api_usage_log
    WHERE user_id = ? AND created_at >= ? AND created_at < ?
    GROUP BY DATE(created_at)
    ORDER BY date
  `).all(userId, startStr, endStr) as any[];

  return { byModelRows, dailyRows };
}

// --- Admin Custom APIs ---

export interface AdminCustomApi {
  id: string;
  name: string;
  method: string;
  url: string;
  headers: string;
  body: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export function getAdminCustomApis(): AdminCustomApi[] {
  return db.prepare('SELECT * FROM admin_custom_apis ORDER BY name').all() as AdminCustomApi[];
}

export function getAdminCustomApi(id: string): AdminCustomApi | undefined {
  return db.prepare('SELECT * FROM admin_custom_apis WHERE id = ?').get(id) as AdminCustomApi | undefined;
}

export function createAdminCustomApi(api: Omit<AdminCustomApi, 'id' | 'created_at' | 'updated_at'>): AdminCustomApi {
  const id = `capi-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO admin_custom_apis (id, name, method, url, headers, body, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, api.name, api.method, api.url, api.headers || '{}', api.body || '', api.description || '', now, now);
  return { ...api, id, created_at: now, updated_at: now };
}

export function updateAdminCustomApi(id: string, updates: Partial<AdminCustomApi>): boolean {
  const sets: string[] = [];
  const params: any[] = [];
  if (updates.name !== undefined) { sets.push('name = ?'); params.push(updates.name); }
  if (updates.method !== undefined) { sets.push('method = ?'); params.push(updates.method); }
  if (updates.url !== undefined) { sets.push('url = ?'); params.push(updates.url); }
  if (updates.headers !== undefined) { sets.push('headers = ?'); params.push(updates.headers); }
  if (updates.body !== undefined) { sets.push('body = ?'); params.push(updates.body); }
  if (updates.description !== undefined) { sets.push('description = ?'); params.push(updates.description); }
  if (sets.length === 0) return false;
  sets.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);
  return db.prepare(`UPDATE admin_custom_apis SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes > 0;
}

export function deleteAdminCustomApi(id: string): boolean {
  return db.prepare('DELETE FROM admin_custom_apis WHERE id = ?').run(id).changes > 0;
}

export interface GlobalModelEndpoint {
  id: string;
  name: string;
  model_id: string;
  base_url: string;
  api_key?: string;
  description?: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export function getGlobalModelEndpoints(): GlobalModelEndpoint[] {
  return db.prepare('SELECT * FROM global_model_endpoints WHERE is_active = 1 ORDER BY name').all() as GlobalModelEndpoint[];
}

export function getGlobalModelEndpointByModelId(modelId: string): GlobalModelEndpoint | undefined {
  return db.prepare('SELECT * FROM global_model_endpoints WHERE model_id = ? AND is_active = 1').get(modelId) as GlobalModelEndpoint | undefined;
}

export function seedCanadAiEndpoint(): void {
  const existing = db.prepare("SELECT id FROM global_model_endpoints WHERE model_id = ?").get('canadai') as any;
  if (!existing) {
    const id = `gme-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO global_model_endpoints (id, name, model_id, base_url, description, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, 'CanadAI', 'canadai', 'https://api.augureai.com/v1', 'Augure AI - Full Ollama-compatible endpoint with tool support', 1, now, now);
  }
}

// --- Companies ---

export interface Company {
  slug: string;
  name: string;
  logo_url: string | null;
  brand_color: string;
  custom_domain: string | null;
  calendly_link: string | null;
  is_whitelabel: number;
  created_at: string;
}

export function getCompanies(): Company[] {
  return db.prepare('SELECT * FROM companies ORDER BY created_at').all() as Company[];
}

export function getCompany(slug: string): Company | undefined {
  return db.prepare('SELECT * FROM companies WHERE slug = ?').get(slug) as Company | undefined;
}

export function createCompany(data: { slug: string; name: string; logo_url?: string | null; brand_color?: string; custom_domain?: string | null; calendly_link?: string | null; is_whitelabel?: number }): void {
  db.prepare(
    'INSERT INTO companies (slug, name, logo_url, brand_color, custom_domain, calendly_link, is_whitelabel) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(data.slug, data.name, data.logo_url || null, data.brand_color || '#2563eb', data.custom_domain || null, data.calendly_link || null, data.is_whitelabel || 0);
}

export function updateCompany(slug: string, data: { name?: string; logo_url?: string | null; brand_color?: string; custom_domain?: string | null; calendly_link?: string | null; is_whitelabel?: number }): void {
  const existing = getCompany(slug);
  if (!existing) return;
  db.prepare(
    'UPDATE companies SET name = ?, logo_url = ?, brand_color = ?, custom_domain = ?, calendly_link = ?, is_whitelabel = ? WHERE slug = ?',
  ).run(
    data.name ?? existing.name, data.logo_url ?? existing.logo_url, data.brand_color ?? existing.brand_color,
    data.custom_domain ?? existing.custom_domain, data.calendly_link ?? existing.calendly_link, data.is_whitelabel ?? existing.is_whitelabel, slug,
  );
}

export function deleteCompany(slug: string): void {
  db.prepare('DELETE FROM companies WHERE slug = ?').run(slug);
}

// --- User Channel Connections ---

export function getUserChannelConnections(userId?: string): any[] {
  if (userId) {
    return db.prepare('SELECT * FROM user_channel_connections WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  }
  return db.prepare('SELECT * FROM user_channel_connections ORDER BY created_at DESC').all();
}

export function getUserChannelConnection(userId: string, channelType: string): any | undefined {
  return db.prepare('SELECT * FROM user_channel_connections WHERE user_id = ? AND channel_type = ?').get(userId, channelType);
}

export function upsertUserChannelConnection(conn: {
  user_id: string;
  channel_type: string;
  status?: string;
  credentials?: string;
  auth_dir?: string;
  phone_number?: string;
  bot_username?: string;
  error_message?: string;
}): void {
  const id = `${conn.user_id}:${conn.channel_type}`;
  const existing = getUserChannelConnection(conn.user_id, conn.channel_type);
  if (existing) {
    const sets: string[] = [];
    const vals: any[] = [];
    if (conn.status !== undefined) { sets.push('status = ?'); vals.push(conn.status); }
    if (conn.credentials !== undefined) { sets.push('credentials = ?'); vals.push(conn.credentials); }
    if (conn.auth_dir !== undefined) { sets.push('auth_dir = ?'); vals.push(conn.auth_dir); }
    if (conn.phone_number !== undefined) { sets.push('phone_number = ?'); vals.push(conn.phone_number); }
    if (conn.bot_username !== undefined) { sets.push('bot_username = ?'); vals.push(conn.bot_username); }
    if (conn.error_message !== undefined) { sets.push('error_message = ?'); vals.push(conn.error_message); }
    if (sets.length > 0) {
      vals.push(conn.user_id, conn.channel_type);
      db.prepare(`UPDATE user_channel_connections SET ${sets.join(', ')} WHERE user_id = ? AND channel_type = ?`).run(...vals);
    }
  } else {
    db.prepare(
      'INSERT INTO user_channel_connections (id, user_id, channel_type, status, credentials, auth_dir, phone_number, bot_username, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id, conn.user_id, conn.channel_type,
      conn.status ?? 'disconnected', conn.credentials ?? '{}',
      conn.auth_dir ?? null, conn.phone_number ?? null,
      conn.bot_username ?? null, conn.error_message ?? null,
    );
  }
}

export function deleteUserChannelConnection(userId: string, channelType: string): void {
  db.prepare('DELETE FROM user_channel_connections WHERE user_id = ? AND channel_type = ?').run(userId, channelType);
}

export function updateUserChannelStatus(
  userId: string,
  channelType: string,
  status: string,
  extra?: { phone_number?: string; bot_username?: string; error_message?: string },
): void {
  const sets = ['status = ?'];
  const vals: any[] = [status];
  if (status === 'connected') {
    sets.push("last_connected_at = datetime('now')");
  }
  if (extra?.phone_number !== undefined) { sets.push('phone_number = ?'); vals.push(extra.phone_number); }
  if (extra?.bot_username !== undefined) { sets.push('bot_username = ?'); vals.push(extra.bot_username); }
  if (extra?.error_message !== undefined) { sets.push('error_message = ?'); vals.push(extra.error_message); }
  vals.push(userId, channelType);
  db.prepare(`UPDATE user_channel_connections SET ${sets.join(', ')} WHERE user_id = ? AND channel_type = ?`).run(...vals);
}

export function createPasswordResetToken(userId: string): string {
  // Delete any existing tokens for this user first
  db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(userId);
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes
  db.prepare('INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);
  return token;
}

export function getPasswordResetToken(token: string): { user_id: string; expires_at: string } | null {
  const row = db.prepare('SELECT user_id, expires_at FROM password_reset_tokens WHERE token = ?').get(token) as any;
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    db.prepare('DELETE FROM password_reset_tokens WHERE token = ?').run(token);
    return null;
  }
  return row;
}

export function deletePasswordResetToken(token: string): void {
  db.prepare('DELETE FROM password_reset_tokens WHERE token = ?').run(token);
}

export function deleteExpiredResetTokens(): void {
  db.prepare('DELETE FROM password_reset_tokens WHERE expires_at < ?').run(new Date().toISOString());
}

export function getUserByEmail(_email: string): any {
  // Single-user Warden: no dashboard_users table. Returns undefined.
  return undefined;
}
