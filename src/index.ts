import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import http from 'node:http';
import path from 'path';
import { spawn, execSync } from 'node:child_process';

import {
  AGENT_TIMEOUT,
  ASSISTANT_NAME,
  DATA_DIR,
  OLLAMA_CHAT_MODEL,
  POLL_INTERVAL,
  TIMEZONE,
  WORKSPACE_ROOT,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import { runAgent, killCurrentAgent, CallbackMap, pushSupervisorNote, runSubAgentBackground } from './agent-spawn.js';
import {
  getBackupConfig,
  createFullBackup,
  createIncrementalBackup,
  listBackups,
} from './backup.js';
import {
  createTask,
  getAllTasks,
  updateTask,
  deleteTask,
  getEmailAccounts,
  getChatHistory,
  getMessagesForDashboard,
  getMessagesSince,
  getNewMessages,
  initDatabase,
  storeMessage,
  setRouterState,
  getRouterState,
  createProject,
  getProjectsByGroup,
  getProject,
  updateProject,
  archiveProject,
  completeProject,
  deleteProject,
  resolveProjectId,
  addProjectDeliverable,
  toggleDeliverable,
  deleteDeliverable,
  addProjectBlocker,
  deleteBlocker,
  addProjectPriority,
  deleteProjectPriority,
  getProjectFinancials,
  updateProjectFinancials,
} from './db.js';
import { fetchEmails, sendEmail } from './email.js';
import {
  listEvents, getEvent, upsertEvent, deleteEvent,
  listTodos, upsertTodo, deleteTodo,
} from './providers/caldav.js';
import {
  listContacts, searchContacts, getContact, upsertContact, deleteContact,
} from './providers/carddav.js';
import { addMcpServer, removeMcpServer, McpServerConfig } from './mcp-registry.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { formatLocalTime } from './timezone.js';
import { computeNextRun, startSchedulerLoop } from './task-scheduler.js';
import { startCalendarSyncPoller } from './calendar-sync.js';
import { projectAllDeliverables, startKontactWatcher } from './kontact-projection.js';
import { startStatusServer, pushNotification } from './status-server.js';
import { Channel, NewMessage, OWNER_JID, AgentInput, ScheduledTask } from './types.js';
import { logger } from './logger.js';
import { captureScreenshot, captureWebcam, captureWebcamFromSecurityApp, securityAppHasFrameServer, readHostImage } from './capture.js';
import { securityLog, saveKnownPerson } from './security-log.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

// ---------------------------------------------------------------------------
// BROWSER-AUTOMATION GUIDANCE (permanent instruction for the Warden agent)
// ---------------------------------------------------------------------------
// For any browser, media, screenshot, YouTube, or other web-content task,
// ALWAYS drive the already-running Chrome browser via Playwright, which is
// connected to the user's real Chrome profile on CDP port 9222
// (127.0.0.1:9222 — sessions, cookies, and sign-ins are all intact).
// Do NOT fall back to direct desktop automation tools such as xdotool or
// wtype for these tasks: they frequently fail on this host due to input
// group mismatch or timeout issues under the Wayland/KDE session.
// Preferred entry points are the Playwright MCP tools (browser_navigate,
// browser_click, browser_type, browser_snapshot, browser_take_screenshot,
// browser_evaluate, etc.). If a Playwright action fails, retry with an
// alternative Playwright approach (keyboard shortcut, browser_eval click,
// direct URL) rather than switching to xdotool/wtype.
// ---------------------------------------------------------------------------

/**
 * Single-chat orchestrator (Warden).
 *
 * All inbound messages from every channel land in the `messages` table with
 * `chat_jid = OWNER_JID`. The message loop polls that single chat, builds an
 * AgentInput, and calls runAgent() (./agent-spawn.ts). The agent's text reply
 * is stored as a bot message and forwarded to every connected channel.
 *
 * Group registration, container spawning, IPC watchers, and multi-user routing
 * are gone. Task 8 will wire runAgent's callback handler for send_message /
 * schedule_task / read_emails / send_email; until then, the agent's only
 * side-effect is its text output.
 */

let lastTimestamp = '';
let lastAgentTimestamp = '';
let messageLoopRunning = false;
export let agentProcessing = false;

const channels: Channel[] = [];

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  lastAgentTimestamp = getRouterState('last_agent_timestamp') || '';
  // Reset any stale processing state from a previous crash/restart.
  setRouterState('agent:processing', 'false');
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', lastAgentTimestamp);
}

const MERCURY_MEMORY_FILE = 'MERCURY_MEMORY.md';
const MERCURY_RECENT_MESSAGES = 12;
const MERCURY_CONTEXT_TURNS = 8;
const MERCURY_SUMMARY_EVERY = 15;

function mercuryMode(): 'off' | 'rag' | 'summary' | 'full' {
  const m = (getRouterState('mercury:mode') || 'full').toLowerCase();
  if (m === 'off' || m === 'rag' || m === 'summary') return m;
  return 'full';
}

function loadMercurySummary(): string | undefined {
  try {
    const root = WORKSPACE_ROOT.replace(/^~(?=\/|$)/, process.env.HOME ?? '');
    return fs.readFileSync(path.join(root, MERCURY_MEMORY_FILE), 'utf-8').trim() || undefined;
  } catch { return undefined; }
}

const STOPWORDS = new Set([
  'the','and','for','are','but','not','you','all','any','can','her','was','one','our','out','his','has','have','had','how','its','may','new','now','old','see','two','way','who','did','get','got','him','she','too','use','that','this','with','from','they','will','would','there','their','what','about','which','when','were','them','then','than','some','into','only','over','such','your','just','also','like','want','need','make','made','please','could','should','been','being','does','done','here','each','very','more','most','much','many','after','before','where','while','these','those','because','between','something','anything','thing','things','give','know','let','lets','tell','show','okay','yes','no','hey','hello','thanks','thank','going','doing','really','good','bad','yes','no',
]);

function tokenizeMercury(text: string): string[] {
  return (text || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

/** Lightweight RAG over conversation history: retrieve older turns relevant to the current user message(s). */
function mercuryRetrieveRelevant(newMessages: NewMessage[], topK = MERCURY_CONTEXT_TURNS): NewMessage[] {
  const query = newMessages
    .filter((m) => !m.is_bot_message)
    .map((m) => m.content || '')
    .join(' ');
  const keywords = tokenizeMercury(query);
  if (keywords.length === 0) return [];

  // Search a deeper window of older messages, excluding the recent verbatim window.
  const deepHistory = getChatHistory(OWNER_JID, 120) as unknown as NewMessage[];
  const candidates = deepHistory.slice(0, -MERCURY_RECENT_MESSAGES);
  if (candidates.length === 0) return [];

  const scored = candidates.map((m) => {
    const words = tokenizeMercury(m.content || '');
    let score = 0;
    for (const kw of keywords) {
      if (words.includes(kw)) score += 1;
      if ((m.content || '').toLowerCase().includes(kw)) score += 0.5;
    }
    return { m, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored
    .filter((s) => s.score > 0)
    .slice(0, topK)
    .map((s) => s.m)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/**
 * Build the XML prompt for the agent: Mercury rolling summary + RAG-retrieved
 * older context + recent chat history + the new actionable messages from the owner.
 */
function buildPrompt(newMessages: NewMessage[]): string {
  let prompt = '';

  const mode = mercuryMode();

  // Mercury rolling memory — compacted context from older conversation turns.
  if (mode === 'summary' || mode === 'full') {
    const mercury = loadMercurySummary();
    if (mercury) {
      prompt += `<mercury_summary>\n${mercury}\n</mercury_summary>\n\n`;
    }
  }

  // Mercury RAG: pull older conversation snippets relevant to the current ask.
  if (mode === 'rag' || mode === 'full') {
    const relevant = mercuryRetrieveRelevant(newMessages);
    if (relevant.length > 0) {
      const lines = relevant.map((m) => {
        const role = m.is_bot_message ? ASSISTANT_NAME : (m.sender_name || 'User');
        return `<message sender="${role}" history="relevant">${m.content}</message>`;
      });
      prompt += `<mercury_context count="${relevant.length}">\n${lines.join('\n')}\n</mercury_context>\n\n`;
    }
  }

  // Get recent conversation context including bot replies (not just user messages).
  // getMessagesForDashboard returns both sides of the conversation.
  const pendingIds = new Set(newMessages.map((m) => m.id));
  // Fetch last N+2 messages (both sides) and exclude the current pending ones to
  // get up to N turns of real back-and-forth context.
  const rawHistory = getChatHistory(OWNER_JID, MERCURY_RECENT_MESSAGES + 2) as unknown as NewMessage[];
  // Exclude Heimdall (the background security agent) messages — its abnormal
  // alerts are stored for the user/dashboard, but the orchestrator must NOT see
  // them in its history (otherwise it parrots/acknowledges them next turn).
  const contextMessages = rawHistory
    .filter((m) => !pendingIds.has(m.id) && (m.sender_name || '') !== 'Heimdall')
    .slice(-MERCURY_RECENT_MESSAGES);

  if (contextMessages.length > 0) {
    const MAX_HISTORY_CHARS = 12000;
    let histChars = 0;
    const trimmed: NewMessage[] = [];
    for (let i = contextMessages.length - 1; i >= 0; i--) {
      const m = contextMessages[i]!;
      const len = (m.content || '').length;
      if (histChars + len > MAX_HISTORY_CHARS && trimmed.length > 0) break;
      trimmed.unshift(m);
      histChars += len;
    }
    const histLines = trimmed.map((m) => {
      const role = m.is_bot_message ? ASSISTANT_NAME : (m.sender_name || 'User');
      const time = formatLocalTime(m.timestamp, TIMEZONE);
      return `<message sender="${role}" time="${time}" history="true">${m.content}</message>`;
    });
    prompt += `<chat_history count="${trimmed.length}">\n${histLines.join('\n')}\n</chat_history>\n\n`;
  }
  prompt += formatMessages(newMessages, TIMEZONE);
  return prompt;
}

/** Strip internal/thinking blocks + sanitize true internal /tmp paths from agent output. */
function cleanAgentText(raw: string): string {
  return raw
    .replace(/<internal>[\s\S]*?<\/internal>/g, '')
    // Strip known internal build/IPC paths completely
    .replace(/\/tmp\/dist\//g, '')
    .replace(/\/tmp\/input\.json/g, 'input')
    .replace(/\/tmp\/warden-ipc\/[^\s)'"`,]*/g, '')
    .replace(/\/tmp\/agent-runner[^\s)'"`,]*/g, '')
    // For other /tmp paths: strip the directory prefix but keep the basename so
    // filenames remain readable in responses (e.g. /tmp/foo/bar/file.txt → file.txt).
    // This avoids leaking internal workspace paths while keeping names like "file1.txt"
    // visible when the agent reports results.
    .replace(/\/tmp\/[^\s)'"`,]*\/([^\/\s)'"`,]+)/g, '$1')
    // Any remaining bare /tmp paths with no subdirectory
    .replace(/\/tmp\/[a-zA-Z0-9._-]+(?=[^\w/]|$)/g, '[tmp]')
    .replace(/\[thinking\][\s\S]*?\[\/thinking\]\s*/g, '')
    .replace(/<(?:think|reasoning)>[\s\S]*?<\/(?:think|reasoning)>\s*/g, '')
    .replace(/<\/?(?:think|reasoning)>\s*/g, '')
    .replace(/\[\/thinking\]\s*/g, '')
    .trim();
}

/** Forward the bot's reply to every connected channel + persist to DB. */
async function deliverReply(text: string): Promise<void> {
  const messageId = `bot-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  storeMessage({
    id: messageId,
    chat_jid: OWNER_JID,
    sender: 'assistant:local',
    sender_name: ASSISTANT_NAME,
    content: text,
    timestamp: new Date().toISOString(),
    is_from_me: false,
    is_bot_message: true,
  });
  await Promise.allSettled(
    channels.map((ch) =>
      ch.sendMessage(OWNER_JID, text).catch((err) =>
        logger.warn({ channel: ch.name, err }, 'Failed to deliver reply to channel'),
      ),
    ),
  );
}

/**
 * Build the parent-side callback map the agent-runner can invoke when the
 * agent calls one of the side-effecting tools (send_message, schedule_task,
 * read_emails, send_email, install_mcp_server, uninstall_mcp_server,
 * create_skill). Each handler runs in the Warden parent process and has
 * access to the DB, channels, and filesystem.
 *
 * Handlers return `{ ok: true, ... }` on success or `{ ok: false, error }`
 * on failure. The agent-runner parser surfaces the error to the agent.
 */
export function buildAgentCallbacks(): CallbackMap {
  return {
    send_message: async (args: any) => {
      try {
        const text = typeof args?.text === 'string' ? args.text : '';
        if (!text) return { ok: false, error: 'missing text' };

        // `type: 'notification'` is intermediate agent narration during tool
        // calls — drop it. Only the final writeOutput response should appear
        // in the chat history.
        if (args?.type === 'notification') {
          return { ok: true, skipped: true };
        }

        const messageId = `bot-cb-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        storeMessage({
          id: messageId,
          chat_jid: OWNER_JID,
          sender: 'assistant:local',
          sender_name: ASSISTANT_NAME,
          content: text,
          timestamp: new Date().toISOString(),
          is_from_me: false,
          is_bot_message: true,
        });
        const targetChannel = typeof args?.channel === 'string'
          ? channels.find((c) => c.name === args.channel)
          : undefined;
        const targets = targetChannel ? [targetChannel] : channels;
        await Promise.allSettled(
          targets.map((ch) =>
            ch.sendMessage(OWNER_JID, text).catch((err) =>
              logger.warn({ channel: ch.name, err }, 'send_message callback: channel send failed'),
            ),
          ),
        );
        return { ok: true, messageId };
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    },

    schedule_task: async (args: any) => {
      try {
        const prompt = typeof args?.prompt === 'string' ? args.prompt : '';
        if (!prompt) return { ok: false, error: 'missing prompt' };
        const scheduleType = args?.schedule_type === 'cron' || args?.schedule_type === 'interval' || args?.schedule_type === 'once'
          ? args.schedule_type
          : 'once';
        const scheduleValue = typeof args?.schedule_value === 'string' ? args.schedule_value : '';
        if (!scheduleValue && scheduleType !== 'once') {
          return { ok: false, error: 'missing schedule_value' };
        }
        const contextMode = args?.context_mode === 'group' || args?.context_mode === 'isolated'
          ? args.context_mode
          : 'isolated';
        const taskId = `task-cb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const now = new Date().toISOString();
        const task: ScheduledTask = {
          id: taskId,
          chat_jid: OWNER_JID,
          prompt,
          schedule_type: scheduleType,
          schedule_value: scheduleValue,
          context_mode: contextMode,
          next_run: null,
          last_run: null,
          last_result: null,
          status: 'active',
          created_at: now,
        };
        task.next_run = computeNextRun(task);
        createTask(task);
        logger.info({ taskId, scheduleType, scheduleValue }, 'schedule_task callback: task created');
        return { ok: true, taskId };
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    },

    list_tasks: async () => {
      try {
        const tasks = getAllTasks();
        return { ok: true, tasks };
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    },

    cancel_task: async (args: any) => {
      try {
        const id = typeof args?.task_id === 'string' ? args.task_id : '';
        if (!id) return { ok: false, error: 'missing task_id' };
        deleteTask(id);
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    },

    pause_task: async (args: any) => {
      try {
        const id = typeof args?.task_id === 'string' ? args.task_id : '';
        if (!id) return { ok: false, error: 'missing task_id' };
        updateTask(id, { status: 'paused' });
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    },

    resume_task: async (args: any) => {
      try {
        const id = typeof args?.task_id === 'string' ? args.task_id : '';
        if (!id) return { ok: false, error: 'missing task_id' };
        updateTask(id, { status: 'active' });
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    },

    update_task: async (args: any) => {
      try {
        const id = typeof args?.task_id === 'string' ? args.task_id : '';
        if (!id) return { ok: false, error: 'missing task_id' };
        const updates: any = {};
        if (args?.prompt) updates.prompt = args.prompt;
        if (args?.schedule_type) updates.schedule_type = args.schedule_type;
        if (args?.schedule_value) updates.schedule_value = args.schedule_value;
        updateTask(id, updates);
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    },

    read_emails: async (args: any) => {
      try {
        const folder = typeof args?.folder === 'string' ? args.folder : 'INBOX';
        const limit = typeof args?.limit === 'number' ? args.limit : 20;
        // The agent doesn't supply an accountId; pick the first enabled account.
        const accounts = getEmailAccounts(null);
        const account = accounts.find((a) => a.enabled);
        if (!account) {
          // TODO: wire to actual email function once an account is configured.
          return { ok: false, error: 'no enabled email account' };
        }
        const search = typeof args?.since === 'string' ? args.since : undefined;
        const emails = await fetchEmails(account.id, folder, limit, search);
        return { ok: true, emails };
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    },

    send_email: async (args: any) => {
      try {
        const to = typeof args?.to === 'string' ? args.to : '';
        const subject = typeof args?.subject === 'string' ? args.subject : '';
        const body = typeof args?.body === 'string' ? args.body : '';
        if (!to || !subject || !body) {
          return { ok: false, error: 'missing to/subject/body' };
        }
        const accounts = getEmailAccounts(null);
        const account = accounts.find((a) => a.enabled && !a.read_only);
        if (!account) {
          // TODO: wire to actual email function once a writable account is configured.
          return { ok: false, error: 'no enabled read-write email account' };
        }
        const result = await sendEmail(account.id, to, subject, body);
        if (!result.success) return { ok: false, error: result.error ?? 'send failed' };
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    },

    // ─── Calendar (stateless CalDAV against local Radicale) ──────────────
    list_calendar_events: async (args: any) => {
      try {
        const events = await listEvents(args?.start, args?.end);
        return { ok: true, events };
      } catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
    },
    create_calendar_event: async (args: any) => {
      try {
        const title = typeof args?.title === 'string' ? args.title : '';
        const start = typeof args?.start_time === 'string' ? args.start_time : '';
        if (!title || !start) return { ok: false, error: 'missing title/start_time' };
        const uid = args?.event_id || `jarvis-evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const ev = {
          uid,
          title,
          description: args?.description,
          start,
          end: args?.end_time,
          allDay: args?.all_day === true,
          location: args?.location,
        };
        const r = await upsertEvent(ev);
        if (!r.ok) return r;
        return { ok: true, eventId: uid, etag: r.etag };
      } catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
    },
    update_calendar_event: async (args: any) => {
      try {
        const uid = typeof args?.event_id === 'string' ? args.event_id : '';
        if (!uid) return { ok: false, error: 'missing event_id' };
        const existing = await getEvent(uid);
        if (!existing) return { ok: false, error: 'event not found' };
        const ev = {
          uid,
          title: args?.title ?? existing.title,
          description: args?.description ?? existing.description,
          start: args?.start_time ?? existing.start,
          end: args?.end_time ?? existing.end,
          allDay: args?.start_time ? (args?.all_day === true) : existing.allDay,
          location: args?.location ?? existing.location,
        };
        const r = await upsertEvent(ev, existing.etag);
        if (!r.ok) return r;
        return { ok: true, eventId: uid, etag: r.etag };
      } catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
    },
    delete_calendar_event: async (args: any) => {
      try {
        const uid = typeof args?.event_id === 'string' ? args.event_id : '';
        if (!uid) return { ok: false, error: 'missing event_id' };
        return await deleteEvent(uid);
      } catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
    },

    // ─── Contacts (stateless CardDAV against local Radicale) ────────────
    list_contacts: async (args: any) => {
      try {
        if (args?.query) {
          const contacts = await searchContacts(String(args.query));
          return { ok: true, contacts };
        }
        const contacts = await listContacts();
        return { ok: true, contacts };
      } catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
    },
    search_contacts: async (args: any) => {
      try {
        const q = typeof args?.query === 'string' ? args.query : '';
        const contacts = await searchContacts(q);
        return { ok: true, contacts };
      } catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
    },
    get_contact: async (args: any) => {
      try {
        const c = await getContact(String(args?.uid || ''));
        if (!c) return { ok: false, error: 'contact not found' };
        return { ok: true, contact: c };
      } catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
    },
    create_contact: async (args: any) => {
      try {
        const uid = args?.uid || `jarvis-contact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const c = {
          uid,
          fullName: args?.full_name,
          givenName: args?.given_name,
          familyName: args?.family_name,
          email: args?.email ? (Array.isArray(args.email) ? args.email : [args.email]) : [],
          phone: args?.phone ? (Array.isArray(args.phone) ? args.phone : [args.phone]) : [],
          org: args?.org,
          title: args?.title,
          note: args?.note,
        };
        const r = await upsertContact(c);
        if (!r.ok) return r;
        return { ok: true, contactId: uid, etag: r.etag };
      } catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
    },
    update_contact: async (args: any) => {
      try {
        const uid = typeof args?.uid === 'string' ? args.uid : '';
        if (!uid) return { ok: false, error: 'missing uid' };
        const existing = await getContact(uid);
        if (!existing) return { ok: false, error: 'contact not found' };
        const c = {
          uid,
          fullName: args?.full_name ?? existing.fullName,
          givenName: args?.given_name ?? existing.givenName,
          familyName: args?.family_name ?? existing.familyName,
          email: args?.email ? (Array.isArray(args.email) ? args.email : [args.email]) : existing.email,
          phone: args?.phone ? (Array.isArray(args.phone) ? args.phone : [args.phone]) : existing.phone,
          org: args?.org ?? existing.org,
          title: args?.title ?? existing.title,
          note: args?.note ?? existing.note,
          extra: existing.extra,
        };
        const r = await upsertContact(c, existing.etag);
        if (!r.ok) return r;
        return { ok: true, contactId: uid, etag: r.etag };
      } catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
    },
    delete_contact: async (args: any) => {
      try {
        return await deleteContact(String(args?.uid || ''));
      } catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
    },

    // ─── Todos (VTODO in the same /cal/ collection) ──────────────────────
    list_todos: async (_args: any) => {
      try {
        const todos = await listTodos();
        return { ok: true, todos };
      } catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
    },
    create_todo: async (args: any) => {
      try {
        const summary = typeof args?.summary === 'string' ? args.summary : '';
        if (!summary) return { ok: false, error: 'missing summary' };
        const uid = args?.uid || `jarvis-todo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const todo = {
          uid,
          summary,
          description: args?.description,
          status: 'NEEDS-ACTION' as const,
          priority: typeof args?.priority === 'number' ? args.priority : undefined,
          due: args?.due,
          dtstart: args?.start,
          relatedTo: args?.related_to,
        };
        const r = await upsertTodo(todo);
        if (!r.ok) return r;
        return { ok: true, todoId: uid, etag: r.etag };
      } catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
    },
    complete_todo: async (args: any) => {
      try {
        const uid = typeof args?.uid === 'string' ? args.uid : '';
        if (!uid) return { ok: false, error: 'missing uid' };
        const todos = await listTodos();
        const existing = todos.find((t) => t.uid === uid);
        if (!existing) return { ok: false, error: 'todo not found' };
        const todo = {
          ...existing,
          status: 'COMPLETED' as const,
          completed: new Date().toISOString().slice(0, 19).replace('T', 'T'),
        };
        const r = await upsertTodo(todo, existing.etag);
        if (!r.ok) return r;
        return { ok: true, todoId: uid };
      } catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
    },
    delete_todo: async (args: any) => {
      try {
        return await deleteTodo(String(args?.uid || ''));
      } catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
    },

    // ─── Project management (wired to db.ts) ────────────────────────────────
    list_projects: async (_args: any) => {
      try {
        const projects = getProjectsByGroup(OWNER_JID);
        return { ok: true, data: projects };
      } catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
    },
    create_project: async (args: any) => {
      try {
        const name = typeof args?.name === 'string' ? args.name : '';
        if (!name) return { ok: false, error: 'missing name' };
        const project = createProject({
          name,
          group_jid: OWNER_JID,
          description: typeof args?.description === 'string' ? args.description : '',
          due_date: typeof args?.dueDate === 'string' ? args.dueDate : undefined,
          project_code: typeof args?.projectCode === 'string' ? args.projectCode : undefined,
        });
        return { ok: true, project };
      } catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
    },
    get_project: async (args: any) => {
      try {
        const id = typeof args?.projectId === 'string' ? args.projectId : '';
        const resolved = resolveProjectId(id) || id;
        const project = getProject(resolved);
        if (!project) return { ok: false, error: 'project not found' };
        return { ok: true, data: project };
      } catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
    },
    update_project: async (args: any) => {
      try {
        const id = typeof args?.projectId === 'string' ? args.projectId : '';
        const resolved = resolveProjectId(id) || id;
        const updates: any = {};
        if (typeof args?.name === 'string') updates.name = args.name;
        if (typeof args?.description === 'string') updates.description = args.description;
        if (typeof args?.status === 'string') updates.status = args.status;
        if (typeof args?.dueDate === 'string') updates.due_date = args.dueDate;
        if (typeof args?.projectCode === 'string') updates.project_code = args.projectCode;
        const project = updateProject(resolved, updates);
        if (!project) return { ok: false, error: 'project not found' };
        return { ok: true, data: project };
      } catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
    },
    archive_project: async (args: any) => {
      try {
        const id = typeof args?.projectId === 'string' ? args.projectId : '';
        const resolved = resolveProjectId(id) || id;
        const ok = archiveProject(resolved);
        return ok ? { ok: true } : { ok: false, error: 'project not found' };
      } catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
    },
    complete_project: async (args: any) => {
      try {
        const id = typeof args?.projectId === 'string' ? args.projectId : '';
        const resolved = resolveProjectId(id) || id;
        const ok = completeProject(resolved);
        return ok ? { ok: true } : { ok: false, error: 'project not found' };
      } catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
    },
    delete_project: async (args: any) => {
      try {
        const id = typeof args?.projectId === 'string' ? args.projectId : '';
        const resolved = resolveProjectId(id) || id;
        const ok = deleteProject(resolved);
        return ok ? { ok: true } : { ok: false, error: 'project not found' };
      } catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
    },
    add_deliverable: async (args: any) => {
      try {
        const id = typeof args?.projectId === 'string' ? args.projectId : '';
        const name = typeof args?.name === 'string' ? args.name : '';
        if (!name) return { ok: false, error: 'missing name' };
        const resolved = resolveProjectId(id) || id;
        const d = addProjectDeliverable(resolved, name, typeof args?.dueDate === 'string' ? args.dueDate : undefined);
        void projectAllDeliverables().catch(() => { /* best-effort: Radicale may be down */ });
        return { ok: true, data: d };
      } catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
    },
    toggle_deliverable: async (args: any) => {
      try {
        const id = typeof args?.deliverableId === 'string' ? args.deliverableId : '';
        const d = toggleDeliverable(id);
        if (!d) return { ok: false, error: 'deliverable not found' };
        void projectAllDeliverables().catch(() => { /* best-effort */ });
        return { ok: true, data: d };
      } catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
    },
    delete_deliverable: async (args: any) => {
      try {
        const id = typeof args?.deliverableId === 'string' ? args.deliverableId : '';
        const ok = deleteDeliverable(id);
        if (ok) void projectAllDeliverables().catch(() => { /* best-effort */ });
        return ok ? { ok: true } : { ok: false, error: 'deliverable not found' };
      } catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
    },
    add_blocker: async (args: any) => {
      try {
        const id = typeof args?.projectId === 'string' ? args.projectId : '';
        const desc = typeof args?.description === 'string' ? args.description : '';
        if (!desc) return { ok: false, error: 'missing description' };
        const resolved = resolveProjectId(id) || id;
        const sev = typeof args?.severity === 'string' ? args.severity : 'medium';
        const b = addProjectBlocker(resolved, desc, sev);
        return { ok: true, data: b };
      } catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
    },
    delete_blocker: async (args: any) => {
      try {
        const id = typeof args?.blockerId === 'string' ? args.blockerId : '';
        const ok = deleteBlocker(id);
        return ok ? { ok: true } : { ok: false, error: 'blocker not found' };
      } catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
    },
    add_priority: async (args: any) => {
      try {
        const id = typeof args?.projectId === 'string' ? args.projectId : '';
        const item = typeof args?.item === 'string' ? args.item : '';
        if (!item) return { ok: false, error: 'missing item' };
        const resolved = resolveProjectId(id) || id;
        const impact = typeof args?.impact === 'string' ? args.impact : 'medium';
        const p = addProjectPriority(resolved, item, impact);
        return { ok: true, data: p };
      } catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
    },
    delete_priority: async (args: any) => {
      try {
        const id = typeof args?.priorityId === 'string' ? args.priorityId : '';
        const ok = deleteProjectPriority(id);
        return ok ? { ok: true } : { ok: false, error: 'priority not found' };
      } catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
    },
    update_financials: async (args: any) => {
      try {
        const id = typeof args?.projectId === 'string' ? args.projectId : '';
        const resolved = resolveProjectId(id) || id;
        const updates: any = {};
        if (typeof args?.budget === 'number') updates.budget = args.budget;
        if (typeof args?.spent === 'number') updates.spent = args.spent;
        if (typeof args?.revenue === 'number') updates.revenue = args.revenue;
        if (typeof args?.notes === 'string') updates.notes = args.notes;
        const f = updateProjectFinancials(resolved, updates);
        return { ok: true, data: f };
      } catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
    },

    install_mcp_server: async (args: any) => {
      try {
        const name = typeof args?.name === 'string' ? args.name : '';
        const command = typeof args?.command === 'string' ? args.command : '';
        if (!name || !command) {
          return { ok: false, error: 'missing name or command' };
        }
        const entry: McpServerConfig = {
          name,
          command,
          args: Array.isArray(args?.args) ? args.args.map(String) : [],
          env: args?.env && typeof args.env === 'object' ? args.env : undefined,
          transport: 'stdio',
          enabled: true,
        };
        addMcpServer(entry);
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    },

    uninstall_mcp_server: async (args: any) => {
      try {
        const name = typeof args?.name === 'string' ? args.name : '';
        if (!name) return { ok: false, error: 'missing name' };
        removeMcpServer(name);
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    },

    create_skill: async (args: any) => {
      try {
        const name = typeof args?.name === 'string' ? args.name : '';
        if (!name || !/^[a-z0-9-]+$/i.test(name)) {
          return { ok: false, error: 'invalid skill name (must match /^[a-z0-9-]+$/i)' };
        }
        // Guard against path traversal — the regex above already rejects slashes,
        // but be explicit so a future regex change can't create an escape.
        if (name.includes('..') || name.includes('/') || name.includes(path.sep)) {
          return { ok: false, error: 'invalid skill name' };
        }
        const description = typeof args?.description === 'string' ? args.description : '';
        const tools = Array.isArray(args?.tools) ? args.tools : [];
        const instructions = typeof args?.instructions === 'string' ? args.instructions : '';
        const whenToUse = typeof args?.when_to_use === 'string' ? args.when_to_use : '';
        const examplePrompt = typeof args?.example_prompt === 'string' ? args.example_prompt : '';
        const parameters = Array.isArray(args?.parameters) ? args.parameters : [];
        const steps = Array.isArray(args?.steps) ? args.steps : [];
        if (!description) {
          return { ok: false, error: 'missing description' };
        }
        const skillsRoot = path.join(DATA_DIR, 'skills');
        const skillDir = path.join(skillsRoot, name);
        fs.mkdirSync(skillDir, { recursive: true });
        const frontmatter = [
          '---',
          `name: ${name}`,
          `description: ${JSON.stringify(description)}`,
          tools.length ? `tools: ${JSON.stringify(tools)}` : null,
          '---',
        ].filter(Boolean).join('\n');

        const bodyParts: string[] = [];
        if (whenToUse) {
          bodyParts.push('## When to use', '', whenToUse.trim(), '');
        }
        if (parameters.length > 0) {
          bodyParts.push('## Parameters', '');
          for (const p of parameters) {
            const pname = typeof p?.name === 'string' ? p.name : '';
            const pdesc = typeof p?.description === 'string' ? p.description : '';
            const pex = typeof p?.example === 'string' && p.example ? ` (example: \`${p.example}\`)` : '';
            if (pname) bodyParts.push(`- **${pname}** — ${pdesc}${pex}`);
          }
          bodyParts.push('');
        }
        if (steps.length > 0) {
          bodyParts.push('## Steps', '');
          steps.forEach((s: any, i: number) => {
            const sdesc = typeof s?.description === 'string' ? s.description : '';
            const stool = typeof s?.tool === 'string' && s.tool ? ` [tool: \`${s.tool}\`${typeof s?.key_args === 'string' && s.key_args ? ` — \`${s.key_args}\`` : ''}]` : '';
            bodyParts.push(`${i + 1}. ${sdesc}${stool}`);
          });
          bodyParts.push('');
        }
        if (examplePrompt) {
          bodyParts.push('## Example prompt', '', '> ' + examplePrompt.trim().replace(/\n/g, '\n> '), '');
        }
        if (instructions) {
          bodyParts.push('## Notes', '', instructions.trim(), '');
        }
        const body = bodyParts.length > 0
          ? bodyParts.join('\n')
          : `# ${name}\n\n${description}\n`;
        const skillPath = path.join(skillDir, 'SKILL.md');
        fs.writeFileSync(skillPath, `${frontmatter}\n\n${body}\n`, 'utf8');
        return { ok: true, path: skillPath };
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    },

    get_chat_history: async (args: any) => {
      try {
        const limit = typeof args?.limit === 'number' ? Math.min(args.limit, 100) : 50;
        const messages = getMessagesForDashboard(OWNER_JID, '', limit);
        return { ok: true, messages };
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    },

    open_app: async (args: any) => {
      try {
        const app = typeof args?.app === 'string' ? args.app.trim() : '';
        if (!app) return { ok: false, error: 'missing app name' };
        const extraArgs: string[] = Array.isArray(args?.args) ? args.args.map(String) : [];
        const hostEnv = {
          ...process.env,
          DISPLAY: process.env.DISPLAY || ':0',
          WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || '',
          XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE || '',
          XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`,
          DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || '',
        };
        const { spawn: nodeSpawn } = await import('child_process');
        const child = nodeSpawn(app, extraArgs, {
          env: hostEnv,
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        logger.info({ app, args: extraArgs }, 'open_app: launched host application');
        return { ok: true, message: `Launched ${app}` };
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    },

    // ─── Host-side image capture ───────────────────────────────────────────
    // Screenshots, webcam frames, and arbitrary host image files are captured
    // here in the orchestrator process (which has the host display + devices),
    // not inside the container. The container tool pushes the returned base64
    // into its vision-context queue.

    desktop_screenshot: async (args: any) => {
      try {
        const windowTitle =
          typeof args?.window_title === 'string' && args.window_title.trim()
            ? args.window_title.trim()
            : undefined;
        let region: { x: number; y: number; w: number; h: number } | undefined;
        const r = args?.region;
        if (r && typeof r === 'object') {
          const w = Math.max(0, Math.round(+r.w || 0));
          const h = Math.max(0, Math.round(+r.h || 0));
          if (w > 0 && h > 0) {
            region = { x: Math.round(+r.x || 0), y: Math.round(+r.y || 0), w, h };
          }
        }
        const cap = await captureScreenshot({ windowTitle, region });
        logger.info(
          { width: cap.width, height: cap.height, mediaType: cap.mediaType, windowTitle, region },
          'desktop_screenshot: captured on host',
        );
        return { ok: true, image: cap.image, mediaType: cap.mediaType, width: cap.width, height: cap.height };
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    },

    webcam_capture: async (args: any) => {
      try {
        // Prefer the Security Mode app's frame server when it's running — the
        // security app owns /dev/video0 for its cheap detector, so grabbing the
        // device directly would fail with "device busy". Fall back to ffmpeg.
        let cap;
        let source = 'ffmpeg';
        if (await securityAppHasFrameServer()) {
          try {
            cap = await captureWebcamFromSecurityApp();
            source = 'security-app';
          } catch (err: any) {
            logger.warn({ err }, 'webcam_capture: security frame server up but fetch failed — falling back to ffmpeg');
            cap = await captureWebcam({
              device: typeof args?.device === 'string' ? args.device : undefined,
              width: typeof args?.width === 'number' ? args.width : undefined,
            });
          }
        } else {
          cap = await captureWebcam({
            device: typeof args?.device === 'string' ? args.device : undefined,
            width: typeof args?.width === 'number' ? args.width : undefined,
          });
        }
        logger.info(
          { source, width: cap.width, height: cap.height, mediaType: cap.mediaType },
          'webcam_capture: captured on host',
        );
        return { ok: true, image: cap.image, mediaType: cap.mediaType, width: cap.width, height: cap.height };
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    },

    read_image: async (args: any) => {
      try {
        const p = typeof args?.path === 'string' ? args.path.trim() : '';
        if (!p) return { ok: false, error: 'missing path' };
        const cap = await readHostImage(p);
        logger.info(
          { path: p, width: cap.width, height: cap.height, mediaType: cap.mediaType },
          'read_image: loaded host image',
        );
        return { ok: true, image: cap.image, mediaType: cap.mediaType, width: cap.width, height: cap.height, path: p };
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    },

    // Orchestrator monitor-tick reports route HERE (not send_message), so the
    // tick's supervision prose lands in the dashboard's progress panel instead
    // of spamming the chat. The chat only carries completed-task reports
    // (inbox digest) and interventions.
    progress_event: async (args: any) => {
      try {
        const text = typeof args?.text === 'string' ? args.text : '';
        if (!text.trim()) return { ok: true, skipped: true };
        pushSupervisorNote(text);
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    },

    // ─── Security Mode ─────────────────────────────────────────────────────
    // Close the open security alert on the standalone detector app, re-arming
    // it so it can raise the next alert. The detector holds an alert OPEN until
    // this is called (one alert per incident, not one per detection).
    close_security_alert: async (_args: any) => {
      const url = process.env.WARDEN_SECURITY_CLOSE_URL || 'http://127.0.0.1:8765/alert/close';
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        try {
          const res = await fetch(url, { method: 'POST', signal: controller.signal });
          const body = await res.text().catch(() => '');
          logger.info({ status: res.status, body: body.slice(0, 120) }, 'close_security_alert: detector re-armed');
          return { ok: res.ok, state: body };
        } finally {
          clearTimeout(timer);
        }
      } catch (err: any) {
        logger.warn({ err }, 'close_security_alert: security app not reachable');
        return { ok: false, error: String(err?.message ?? err) };
      }
    },

    // Heimdall's conditions log (own sqlite store, store/security.db). Records
    // each alert assessment with an exact timestamp, and queries history by
    // local-time range so Heimdall can reference events by time/date.
    security_log: async (args: any) => {
      return securityLog(args);
    },

    // Heimdall recognized a person as normal → save their keyframe so the
    // detector skips flagging them (application-side pHash compare).
    save_known_person: async (args: any) => {
      return saveKnownPerson(args);
    },

    // Heimdall declared the flagged detection ABNORMAL → spawn the alert on the
    // detector (red STAND DOWN button + ALERTED state). Mirrors close_security_alert.
    open_security_alert: async (_args: any) => {
      const url = process.env.WARDEN_SECURITY_OPEN_URL || 'http://127.0.0.1:8765/alert/open';
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        try {
          const res = await fetch(url, { method: 'POST', signal: controller.signal });
          const body = await res.text().catch(() => '');
          logger.info({ status: res.status, body: body.slice(0, 120) }, 'open_security_alert: detector ALERTED');
          return { ok: res.ok, state: body };
        } finally {
          clearTimeout(timer);
        }
      } catch (err: any) {
        logger.warn({ err }, 'open_security_alert: security app not reachable');
        return { ok: false, error: String(err?.message ?? err) };
      }
    },

    // Orchestrator → Heimdall direct. Spawn Heimdall in the background with the
    // passed message; Heimdall records it in security_log as context for future
    // reviews (it does not reply in the chat). This is how the orchestrator tells
    // the security agent something (instead of routing through Atlas).
    tell_heimdall: async (args: any) => {
      const message = typeof args?.message === 'string' ? args.message : '';
      if (!message.trim()) return { ok: false, error: 'missing message' };
      const tz = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
      const localNow = new Date().toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T');
      const task = `Current local time is ${localNow} (timezone ${tz}).\n\nA message was passed to you from the orchestrator/user: "${message}". Record it in security_log (action: record, assessment=normal, condition=<the passed note>) so future reviews can use it as context, then STOP. Do not send_message.`;
      const heimdallModel =
        (getRouterState('orchestrator:model') || getRouterState('global:default_model') || '').replace(/^local:/, '')
        || undefined;
      try {
        runSubAgentBackground({
          agent: 'heimdall',
          prompt: task,
          model: heimdallModel,
          sessionId: 'owner',
          workspaceRoot: WORKSPACE_ROOT,
          chatJid: OWNER_JID,
          groupFolder: 'owner',
          isMain: true,
          timeoutMs: 3 * 60 * 1000,
          callbacks: buildAgentCallbacks(),
        } as any);
        logger.info({ msgLen: message.length }, 'tell_heimdall: spawned Heimdall to record message');
        return { ok: true };
      } catch (err: any) {
        logger.warn({ err }, 'tell_heimdall: failed to spawn Heimdall');
        return { ok: false, error: String(err?.message ?? err) };
      }
    },

  };
}

let mercuryTurnCounter = 0;

function maybeUpdateMercurySummary(): void {
  mercuryTurnCounter++;
  if (mercuryTurnCounter % MERCURY_SUMMARY_EVERY === 0) {
    void updateMercurySummary();
  }
}

/**
 * Mercury — automatic rolling conversation compaction.
 *
 * Reads the last ~40 messages, preserves the most recent turns verbatim, and
 * asks the orchestrator model to compress the older turns into a concise
 * summary of facts, decisions, open questions, and relevant context. Writes the
 * result to MERCURY_MEMORY.md so every subsequent prompt starts with compact
 * context instead of an ever-growing transcript.
 *
 * Runs asynchronously after each reply so it never blocks the chat flow.
 */
async function updateMercurySummary(): Promise<void> {
  try {
    const raw = getChatHistory(OWNER_JID, 45) as unknown as NewMessage[];
    if (raw.length <= MERCURY_RECENT_MESSAGES + 3) return;

    const recent = raw.slice(-MERCURY_RECENT_MESSAGES);
    const older = raw.slice(0, -MERCURY_RECENT_MESSAGES);
    if (older.length === 0) return;

    const olderLines = older.map((m) => {
      const role = m.is_bot_message ? ASSISTANT_NAME : (m.sender_name || 'User');
      return `${role}: ${m.content}`;
    }).join('\n');

    const summaryPrompt =
      `You are Mercury — a conversation compaction layer for Warden. Summarize the following older conversation turns into a concise memory note. ` +
      `Preserve facts, decisions, values, file paths, URLs, and any open tasks or questions. ` +
      `Drop pleasantries, filler, and exact wording unless it's important. ` +
      `Do NOT include the most recent ${MERCURY_RECENT_MESSAGES} turns; they are kept verbatim. ` +
      `Write in short bullet/paragraph form so the main agent can scan it quickly.\n\n${olderLines}\n\nMercury summary:`;

    const model = (getRouterState('mercury:model') || getRouterState('orchestrator:model') || getRouterState('global:default_model') || '').replace(/^local:/, '') || undefined;
    const mercuryInput: AgentInput = {
      prompt: summaryPrompt,
      sessionId: 'mercury',
      workspaceRoot: WORKSPACE_ROOT,
      history: [],
      timeoutMs: 120_000,
      orchestratorModel: model,
      showThinking: 'false',
      verbose: false,
    };

    const result = await runAgent({ ...mercuryInput, callbacks: {} });
    let summary = cleanAgentText(result.text || '');
    try {
      const parsed = JSON.parse(summary);
      if (parsed && typeof parsed === 'object' && typeof parsed.result === 'string') summary = cleanAgentText(parsed.result);
    } catch { /* not JSON */ }
    if (!summary.trim()) return;

    const root = WORKSPACE_ROOT.replace(/^~(?=\/|$)/, process.env.HOME ?? '');
    const mercuryPath = path.join(root, MERCURY_MEMORY_FILE);
    const stamp = new Date().toISOString();
    const entry = `# Mercury summary updated ${stamp}\n\n${summary}\n\n---\n\n`;
    fs.writeFileSync(mercuryPath, entry, 'utf8');
    logger.info({ chars: summary.length }, 'Mercury summary updated');
  } catch (err: any) {
    logger.warn({ err: err?.message ?? err }, 'Mercury summary update failed');
  }
}

/**
 * Poll the single owner chat for new messages since the last agent run.
 * If any are present, build an AgentInput and call runAgent().
 */
async function processOwnerMessages(): Promise<void> {
  // Re-sync cursor with router state in case an external stop/advance changed it.
  lastAgentTimestamp = getRouterState('last_agent_timestamp') || lastAgentTimestamp;
  const since = lastAgentTimestamp;
  const pending = getMessagesSince(OWNER_JID, since, ASSISTANT_NAME);
  if (pending.length === 0) return;

  // ── "Close the alert" — the person at the keyboard re-arms the detector ──
  // Heimdall never closes an ABNORMAL alert itself; the user closes it after
  // they've checked / acted on it. This intercepts that command and calls the
  // close_security_alert host callback directly (the orchestrator doesn't own
  // that tool), then acknowledges — no orchestrator turn needed.
  const closeText = pending.some((m) => {
    const s = (m.content || '').toLowerCase();
    return (/\b(close|clear|dismiss)\b/.test(s) && /\balert|security|intruder|threat\b/.test(s))
      || /\b(stand\s+down|all\s+clear)\b/.test(s)
      || /close.*alert/.test(s);
  });
  if (closeText) {
    lastAgentTimestamp = pending[pending.length - 1]!.timestamp;
    saveState();
    let reply = 'Security alert closed — detector re-armed.';
    try {
      const r = await buildAgentCallbacks().close_security_alert({});
      if (r && r.ok === false) reply = `Tried to close the security alert: ${r.error || 'detector app not reachable'}.`;
    } catch (err: any) {
      reply = `Could not close the security alert: ${err?.message ?? err}.`;
    }
    const ack: NewMessage = {
      id: `sec-close-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chat_jid: OWNER_JID,
      sender: 'assistant',
      sender_name: ASSISTANT_NAME,
      content: reply,
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: true,
    };
    storeMessage(ack);
    pushNotification('owner', { type: 'chat_complete', message: reply, from: OWNER_JID });
    logger.info({ chatJid: OWNER_JID }, 'Security alert closed by user → detector re-armed');
    return;
  }

  // ── Security Mode auto-trigger ──────────────────────────────────────────
  // If the pending batch is a security-camera alert (posted by the standalone
  // detector app), hand it to Heimdall — the background security sub-agent —
  // instead of running the orchestrator on it. Heimdall reads SECURITY.md +
  // the attached frame, decides normal vs abnormal, and either dies silently
  // (close_security_alert) or alerts the user (send_message). This keeps the
  // orchestrator out of the alert path so the main chat isn't muddied.
  const isSecurityAlert = pending.some((m) => (m.content || '').startsWith('SECURITY ALERT'));
  if (isSecurityAlert) {
    // Advance the cursor so the alert isn't re-processed.
    lastAgentTimestamp = pending[pending.length - 1]!.timestamp;
    saveState();
    logger.info({ chatJid: OWNER_JID, messageCount: pending.length }, 'Security alert → routing to Heimdall (background)');

    // Inject the current local time (so Heimdall can reference events by time)
    // and build a compact task from ONLY the latest flag. A backlog of flags can
    // queue while Heimdall is busy; Heimdall should only look at the LAST thing
    // sent (the current frame), not process stale older flags one-by-one.
    const tz = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const localNow = new Date().toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T');
    const secAlerts = pending.filter((m) => (m.content || '').startsWith('SECURITY ALERT'));
    const latest = secAlerts.length > 0 ? secAlerts[secAlerts.length - 1] : pending[pending.length - 1]!;
    const alertText = latest.content || '';
    const task = `Current local time is ${localNow} (timezone ${tz}).\n\n${alertText}`;

    // ENGRAINED: log every flag to security.db the moment it's routed to Heimdall,
    // so a flag is ALWAYS recorded even if Heimdall crashes before it can write its
    // own assessment. Heimdall adds its normal/abnormal verdict on top.
    try {
      const m = /SECURITY ALERT — (.+?) at (\S+)\./.exec(alertText);
      securityLog({
        action: 'record',
        alert_ts: m?.[2] || localNow,
        camera: 'webcam0',
        assessment: 'flagged',
        condition: m?.[1] || 'security flag',
        escalated: false,
        data: { flag: alertText.slice(0, 500) },
      });
    } catch { /* best-effort */ }

    // Heimdall shares the orchestrator's model (the one the dashboard sets via
    // orchestrator:model / global:default_model) — the same model that makes
    // webcam_capture vision work for the orchestrator. A non-vision model
    // (e.g. deepseek-v4-pro:cloud) rejects the image and Heimdall crashes.
    const heimdallModel =
      (getRouterState('orchestrator:model') || getRouterState('global:default_model') || '').replace(/^local:/, '')
      || undefined;

    try {
      runSubAgentBackground({
        agent: 'heimdall',
        prompt: task,
        model: heimdallModel,
        sessionId: 'owner',
        workspaceRoot: WORKSPACE_ROOT,
        chatJid: OWNER_JID,
        groupFolder: 'owner',
        isMain: true,
        timeoutMs: 5 * 60 * 1000,
        callbacks: buildAgentCallbacks(),
      } as any);
    } catch (err: any) {
      logger.warn({ err }, 'Security alert: failed to spawn Heimdall');
    }
    return; // do NOT run the orchestrator for security alerts
  }

  const prompt = buildPrompt(pending);

  // Advance cursor before invoking the agent so a crash between cursor advance
  // and agent completion doesn't re-process the same messages.
  const previousCursor = lastAgentTimestamp;
  lastAgentTimestamp = pending[pending.length - 1]!.timestamp;
  saveState();

  logger.info(
    { chatJid: OWNER_JID, messageCount: pending.length },
    'Processing messages for owner chat',
  );

  // Sync tools model into env so agent subprocess inherits it
  const subagentModel = getRouterState('local:subagent_model');
  if (subagentModel) process.env.SUBAGENT_MODEL = subagentModel;

  // Sync per-agent num_ctx overrides from dashboard settings into env.
  // Atlas has no override — it always gets the model max (see getNumCtx).
  // Always assign (even when empty) so clearing the field in the dashboard
  // actually clears the override — otherwise the previous value sticks across
  // turns and ollama never sees the smaller ctx.
  const orchCtx = getRouterState('local:orchestrator_ctx');
  process.env.ORCHESTRATOR_NUM_CTX = orchCtx || '';
  const subCtx = getRouterState('local:subagent_ctx');
  process.env.SUBAGENT_NUM_CTX = subCtx || '';
  const atlasCtx = getRouterState('local:atlas_ctx');
  process.env.ATLAS_NUM_CTX = atlasCtx || '';
  const toolsCtx = getRouterState('local:tools_ctx');
  process.env.TOOLS_NUM_CTX = toolsCtx || '';
  const mercuryCtx = getRouterState('local:mercury_ctx');
  process.env.MERCURY_NUM_CTX = mercuryCtx || '';

  // Load workspace memory files and inject into agent context every turn.
  const memoryContext = (() => {
    const root = WORKSPACE_ROOT.replace(/^~(?=\/|$)/, process.env.HOME ?? '');
    try {
      const content = fs.readFileSync(path.join(root, 'MEMORY.md'), 'utf-8').trim();
      return content || undefined;
    } catch { return undefined; }
  })();

  const input: AgentInput = {
    prompt,
    sessionId: 'owner',
    workspaceRoot: WORKSPACE_ROOT,
    history: pending,
    timeoutMs: 10 * 60 * 1000, // orchestrator turns must be short: Atlas is always async; a stuck model/tool call recovers in 10 min
    memoryContext,
    orchestratorModel: (getRouterState('orchestrator:model') || getRouterState('global:default_model') || '').replace(/^local:/, '') || undefined,
    model: (getRouterState('atlas:model') || '').replace(/^local:/, '') || undefined,
    councilSkepticModel: (getRouterState('council:skeptic_model') || '').replace(/^local:/, '') || undefined,
    councilPragmatistModel: (getRouterState('council:pragmatist_model') || '').replace(/^local:/, '') || undefined,
    councilSynthesistModel: (getRouterState('council:synthesist_model') || '').replace(/^local:/, '') || undefined,
    showThinking: getRouterState(`thinking:${OWNER_JID}`)
      || getRouterState('local:thinking')
      || 'true',
    verbose: true,
  };

  agentProcessing = true;
  setRouterState('agent:processing', 'true');
  let output;
  try {
    output = await runAgent({ ...input, callbacks: buildAgentCallbacks() });
  } catch (err) {
    agentProcessing = false;
    setRouterState('agent:processing', 'false');
    logger.error({ err }, 'runAgent threw');
    // Roll back cursor so the message gets retried on the next loop tick.
    lastAgentTimestamp = previousCursor;
    saveState();
    return;
  }
  agentProcessing = false;
  setRouterState('agent:processing', 'false');
  if (output.userStopped) {
    logger.info('Agent run stopped by user; no reply delivered and cursor stays advanced');
    return;
  }

  let rawText = cleanAgentText(output.text);
  // Agent-runner emits JSON: {"status":"success","result":"..."} — extract the text.
  // If result is null/empty/non-string, the agent produced no user-facing reply — drop it
  // rather than forwarding the raw envelope (e.g. '{"status":"success","result":null}') to the chat.
  try {
    const parsed = JSON.parse(rawText);
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.result === 'string' && parsed.result.trim()) {
        rawText = cleanAgentText(parsed.result);
      } else {
        rawText = '';
      }
    }
  } catch { /* not JSON, use as-is */ }
  const text = rawText;
  if (!text) {
    if (output.error) {
      logger.warn(
        { error: output.error, exitCode: output.exitCode },
        'Agent returned no text + an error',
      );
    }
    return;
  }

  await deliverReply(text);

  // Mercury: asynchronously compact the conversation after each turn so the
  // context window keeps flowing without manual resets.
  void maybeUpdateMercurySummary();

  // Push a notification so the dashboard SSE can react even if it polls slowly.
  pushNotification('owner', {
    type: 'chat_complete',
    message: text,
    from: OWNER_JID,
  });
}

// Bare stop commands a user can send as a chat message (Telegram/voice) to
// kill an in-flight agent run. Deliberately strict — the message must be
// nothing but the stop word, so "stop by the store" never triggers it.
const STOP_COMMAND_RE = /^\s*(stop|cancel|abort|halt|never\s?mind|nvm|shut up)[\s.!]*$/i;

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;
  logger.info(`Warden running (single chat: ${OWNER_JID})`);

  // The agent run is fired without awaiting so this loop keeps polling while
  // it works — otherwise a long run (e.g. an atlas delegation) blocks message
  // pickup entirely and a chat "stop" can't take effect until it finishes.
  // The flag guards re-entry: exactly one run at a time.
  let agentRunInFlight = false;

  while (true) {
    try {
      const { messages, newTimestamp } = getNewMessages(
        [OWNER_JID],
        lastTimestamp,
        ASSISTANT_NAME,
      );
      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');
        lastTimestamp = newTimestamp;
        saveState();
        if (agentRunInFlight) {
          const stopMsg = [...messages].reverse().find((m) => STOP_COMMAND_RE.test(m.content || ''));
          if (stopMsg) {
            logger.info({ text: stopMsg.content }, 'Stop command received mid-run — killing agent');
            killCurrentAgent();
            // Consume everything up to and including the stop message so it
            // isn't replayed as a prompt on the next tick. Messages sent
            // after the stop stay pending and start a fresh run.
            lastAgentTimestamp = stopMsg.timestamp;
            saveState();
          }
          // Non-stop messages queue as before: processOwnerMessages picks
          // them up via lastAgentTimestamp once the current run resolves.
        }
      }
      if (!agentRunInFlight) {
        agentRunInFlight = true;
        void processOwnerMessages()
          .catch((err) => logger.error({ err }, 'Error in message loop'))
          .finally(() => { agentRunInFlight = false; });
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: if messages arrived between the last agent run and a
 * crash, the cursor is stale. Roll it back so the next loop tick processes
 * them.
 */
function recoverPendingMessages(): void {
  const pending = getMessagesSince(OWNER_JID, lastAgentTimestamp, ASSISTANT_NAME);
  if (pending.length > 0) {
    logger.info(
      { pendingCount: pending.length },
      'Recovery: found unprocessed messages for owner chat',
    );
  }
}

// Dedicated persistent Chrome profile for Warden automation.
// Chrome runs as a standalone process with --remote-debugging-port. The
// agent-runner's native browser_* tools attach to it over CDP (playwright-core
// connectOverCDP); when an agent session ends the CDP connection drops but
// Chrome (and every open tab) stays alive.
// Sign into Google once; the profile persists across restarts.
const CHROME_CDP_PORT = 9222;
const WARDEN_CHROME_PROFILE = path.join(process.env.HOME ?? '/root', '.config', 'playwright-jarvis');
const CHROME_BIN = '/usr/bin/google-chrome-stable';

// dockbox runs as a systemd user unit without DISPLAY/XAUTHORITY in its env,
// so Chrome can't reach the X server and dies on launch. Discover the active
// session's display env from a running user process (plasmashell, kded, or
// anything with DISPLAY set) so Chrome can attach to the visible session.
function discoverDisplayEnv(): { DISPLAY?: string; XAUTHORITY?: string } {
  const uid = process.getuid?.() ?? 0;
  // Prefer processes likely to own the user's graphical session.
  const candidates = ['plasmashell', 'kded', 'gnome-shell', 'Xwayland', 'Xorg', 'sway', 'i3'];
  for (const name of candidates) {
    try {
      const pids = execSync(`pgrep -u ${uid} -x ${name} 2>/dev/null`, { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
      for (const pid of pids) {
        const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
        const DISPLAY = env.find((e) => e.startsWith('DISPLAY='));
        const XAUTHORITY = env.find((e) => e.startsWith('XAUTHORITY='));
        if (DISPLAY) {
          return {
            DISPLAY: DISPLAY.slice('DISPLAY='.length),
            XAUTHORITY: XAUTHORITY ? XAUTHORITY.slice('XAUTHORITY='.length) : undefined,
          };
        }
      }
    } catch { /* try next candidate */ }
  }
  // Fallback: scan any user process for DISPLAY.
  try {
    const pids = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p));
    for (const pid of pids) {
      try {
        const stat = fs.statSync(`/proc/${pid}`);
        if (stat.uid !== uid) continue;
        const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
        const DISPLAY = env.find((e) => e.startsWith('DISPLAY='));
        if (DISPLAY) {
          const XAUTHORITY = env.find((e) => e.startsWith('XAUTHORITY='));
          return {
            DISPLAY: DISPLAY.slice('DISPLAY='.length),
            XAUTHORITY: XAUTHORITY ? XAUTHORITY.slice('XAUTHORITY='.length) : undefined,
          };
        }
      } catch { /* process died */ }
    }
  } catch { /* /proc unreadable */ }
  return {};
}

function spawnChrome(): void {
  // Clear stale profile locks so Chrome doesn't refuse to start after a crash.
  try {
    fs.rmSync(path.join(WARDEN_CHROME_PROFILE, 'SingletonLock'), { force: true });
    fs.rmSync(path.join(WARDEN_CHROME_PROFILE, 'SingletonSocket'), { force: true });
  } catch { /* ignore */ }
  const displayEnv = discoverDisplayEnv();
  const child = spawn(CHROME_BIN, [
    `--remote-debugging-port=${CHROME_CDP_PORT}`,
    `--user-data-dir=${WARDEN_CHROME_PROFILE}`,
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=LockProfileCookieDatabase',
  ], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...displayEnv },
  });
  child.on('error', (err) => logger.warn({ err }, 'Chrome spawn failed'));
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', (chunk: Buffer) => {
    const line = chunk.toString('utf8').trim();
    if (line) logger.debug({ chrome: line }, 'chrome stderr');
  });
  child.on('exit', (code, signal) => {
    logger.warn({ code, signal }, 'Chrome process exited');
  });
  child.unref();
  logger.info({ cdpPort: CHROME_CDP_PORT, ...displayEnv }, 'Launched persistent Chrome');
}

function startChromeWatchdog(): void {
  // Kill any stale chrome on this port before starting fresh.
  try { execSync(`pkill -f "remote-debugging-port=${CHROME_CDP_PORT}" 2>/dev/null`); } catch {}
  let chromeLaunchTime = Date.now();
  let chromeFailures = 0;

  function restartChrome(reason: string): void {
    logger.warn({ reason, chromeFailures }, 'Relaunching Chrome');
    try { execSync(`pkill -f "remote-debugging-port=${CHROME_CDP_PORT}" 2>/dev/null`); } catch {}
    chromeFailures = 0;
    chromeLaunchTime = Date.now();
    spawnChrome();
  }

  spawnChrome();

  const httpOk = (url: string, timeoutMs = 3000) =>
    new Promise<boolean>((resolve) => {
      const req = http.get(url, { timeout: timeoutMs }, (res) => {
        res.resume();
        resolve(res.statusCode != null && res.statusCode >= 200 && res.statusCode < 500);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      setTimeout(() => { req.destroy(); resolve(false); }, timeoutMs);
    });

  // Re-check every 15 seconds; restart Chrome only after repeated failures
  // and never within a 10 s grace period after a fresh launch.
  setInterval(async () => {
    const now = Date.now();
    if (now - chromeLaunchTime < 10000) return;

    const chromeUp = await httpOk(`http://localhost:${CHROME_CDP_PORT}/json/version`, 3000);
    if (!chromeUp) {
      chromeFailures++;
      if (chromeFailures >= 3) {
        restartChrome('Chrome CDP unreachable');
      }
      return;
    }
    chromeFailures = 0;
  }, 15000).unref();
}


async function main(): Promise<void> {
  initDatabase();
  logger.info('Database initialized');
  startChromeWatchdog();
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    for (const ch of channels) {
      try { await (ch as any).disconnect?.(); } catch { /* ignore */ }
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks — every channel routes inbound messages to OWNER_JID.
  const channelOpts = {
    onMessage: (_chatJid: string, msg: NewMessage) => {
      // Force every inbound message to OWNER_JID — the single chat.
      storeMessage({ ...msg, chat_jid: OWNER_JID });
    },
  };

  // Create and connect all registered channels. Each channel self-registers
  // via the barrel import above. Factories return null when credentials are
  // missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    try {
      await (channel as any).connect?.();
      channels.push(channel);
    } catch (err) {
      logger.error({ channel: channelName, err }, 'Channel failed to connect — skipping');
    }
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start status server. Task 11 will slim its deps down; for now we pass
  // stubs for the group/queue fields it still expects.
  startStatusServer({
    queue: { enqueueMessageCheck() {}, enqueueTask() {}, setActiveMode() {}, getStatus: () => {
      const processing = getRouterState('agent:processing') === 'true';
      return {
        activeCount: processing ? 1 : 0,
        groups: [{
          jid: OWNER_JID,
          active: processing,
          idle: !processing,
          containerName: null,
          pendingMessages: false,
          pendingTasks: 0,
          parallelContainers: 0,
        }],
      };
    }, killIfModeChanged: () => false, closeStdin() {}, notifyIdle() {}, stopGroup() {}, isActive: () => false, sendMessage: () => false, getIdleWithPending: () => [], wasUserStopped: () => false, isKilling: () => false, shutdown: async () => {}, registerProcess() {} } as any,
    channels,
    registeredGroups: () => ({ [OWNER_JID]: { name: 'Owner', folder: 'owner', trigger: '', added_at: '', isMain: true, requiresTrigger: false } }) as any,
    startedAt: Date.now(),
    getMessagesForDashboard: (_jid: string, since: string, limit?: number, idea?: string) =>
      getMessagesForDashboard(OWNER_JID, since, limit ?? 500, idea),
    getAllTasks: () => getAllTasks(),
    storeMessage,
    sendChannelMessage: async (jid: string, text: string, _senderName?: string) => {
      const formatted = formatOutbound(text);
      if (!formatted) return;
      const channel = findChannel(channels, jid);
      if (channel) await channel.sendMessage(jid, formatted);
    },
    advanceCursor: (_jid: string, timestamp: string) => {
      lastAgentTimestamp = timestamp;
      saveState();
    },
    clearSessions: () => {
      // No-op: sessions are owned by the agent-runner child process now.
    },
    reconnectChannel: async (type: string) => {
      try {
        const factory = getChannelFactory(type);
        if (!factory) return false;
        // Remove existing channel of this type if present
        const existingIdx = channels.findIndex((c) => c.name === type);
        if (existingIdx >= 0) {
          const old = channels[existingIdx];
          try { await (old as any).disconnect?.(); } catch { /* ignore */ }
          channels.splice(existingIdx, 1);
        }
        // WhatsApp needs forceConnect to generate a QR code when creds are missing
        const isWa = type === 'whatsapp';
        const newChannel = factory({
          onMessage: (chatJid, msg) => storeMessage({ ...msg, chat_jid: OWNER_JID }),
          ...(isWa ? { forceConnect: true } : {}),
        });
        if (!newChannel) return false;
        try {
          await (newChannel as any).connect?.();
        } catch { /* connect is optional; some channels auto-connect in constructor */ }
        channels.push(newChannel);
        return true;
      } catch (err) {
        logger.error({ type, err }, 'reconnectChannel failed');
        return false;
      }
    },
  });

  // Start the scheduled-task loop. The scheduler no longer runs agents — it
  // injects each due task's prompt into the owner chat as a regular message
  // (attributed to Automation) and lets the normal message pipeline handle it.
  // The message loop polls the owner chat every POLL_INTERVAL, so the injected
  // prompt is picked up without an explicit poke; enqueueMessageCheck is a
  // no-op here (it exists for the GroupQueue architecture).
  startSchedulerLoop({
    registeredGroups: () => ({ [OWNER_JID]: { name: 'Owner', folder: 'owner', trigger: '', added_at: '', isMain: true, requiresTrigger: false } }) as any,
    queue: { enqueueMessageCheck: () => {} },
  });

  startCalendarSyncPoller();
  // Kontact projection: mirror project deliverables to/from the shared
  // Radicale /cal/ collection. No-ops cleanly if Radicale isn't provisioned.
  startKontactWatcher();
  void projectAllDeliverables().catch(() => { /* best-effort at boot */ });

  // ── Backup scheduler ─────────────────────────────────────────────────────
  // Check every minute whether a scheduled backup is due.
  // Seed from existing backups so a restart doesn't immediately trigger a new one.
  const existingBackups = (() => { try { return listBackups(); } catch { return []; } })();
  const lastFull = existingBackups.find((b) => b.type === 'full');
  const lastIncr = existingBackups.find((b) => b.type === 'incremental');
  let lastFullBackup: Date | null = lastFull ? new Date(lastFull.createdAt) : null;
  let lastIncrBackup: Date | null = lastIncr ? new Date(lastIncr.createdAt) : null;
  setInterval(async () => {
    try {
      const cfg = getBackupConfig();
      const now = new Date();

      if (cfg.fullEnabled && cfg.fullSchedule) {
        const interval = CronExpressionParser.parse(cfg.fullSchedule, { currentDate: now });
        const prev = interval.prev().toDate();
        if (!lastFullBackup || prev > lastFullBackup) {
          lastFullBackup = now;
          try { await createFullBackup(); }
          catch (err) { logger.error({ err }, 'Scheduled full backup failed'); }
        }
      }

      if (cfg.incrEnabled && cfg.incrSchedule) {
        const interval = CronExpressionParser.parse(cfg.incrSchedule, { currentDate: now });
        const prev = interval.prev().toDate();
        if (!lastIncrBackup || prev > lastIncrBackup) {
          lastIncrBackup = now;
          try { await createIncrementalBackup(); }
          catch (err) { logger.error({ err }, 'Scheduled incremental backup failed'); }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Backup scheduler error');
    }
  }, 60_000);

  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start Warden');
    process.exit(1);
  });
}