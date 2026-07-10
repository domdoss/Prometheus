import crypto from 'crypto';
import { execSync, spawn, spawnSync } from 'child_process';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { transcribeLocal } from './transcription.js';
import { killCurrentAgent, getLiveStatus } from './agent-spawn.js';
import {
  ASSISTANT_NAME,
  CONTAINER_IMAGE,
  DEFAULT_MODEL_MODE,
  IDLE_TIMEOUT,
  LOCAL_ASSISTANT_NAME,
  DATA_DIR,
  GROUPS_DIR,
  OLLAMA_CHAT_MODEL,
  OLLAMA_URL,
  STORE_DIR,
  TIMEZONE,
  CLOUD_MODELS,
  isCustomApiAllowed,
} from './config.js';
import { ollamaIsAvailable } from './ollama-client.js';
import { ollamaModelSupportsThinking } from './ollama-native.js';
import {
  Channel,
  NewMessage,
  ScheduledTask,
} from './types.js';
import type { RegisteredGroup } from './group-folder.js';
import {
  getBackupConfig,
  saveBackupConfig,
  listBackups,
  createFullBackup,
  createIncrementalBackup,
  restoreBackup,
  deleteBackup,
  getBackupArchivePath,
} from './backup.js';
import {
  scrubFile,
  loadVaultIndex,
  getVaultEntry,
  readScrubbed,
  readMapping,
  deleteVaultEntry,
  updateVaultEntryStatus,
  unscrub,
  loadDictionary,
  saveDictionary,
  VAULT_DIR,
  SCRUBBED_DIR,
} from './scrubber.js';
import {
  addMcpServer,
  loadMcpServers,
  removeMcpServer,
  setMcpServerEnabled,
} from './mcp-registry.js';
import {
  createTask,
  createUserTask,
  getAllChats,
  getAllTasks,
  deleteTask,
  deleteUserTask,
  getLastBotMessageTimestamp,
  getBotMessagesSince,
  getDueUserTasks,
  getMessagesSince,
  getRecentMessages,
  getTaskById,
  getUserTasks,
  markTaskRun,
  searchMessages,
  searchTasks,
  storeChatMetadata,
  updateTask,
  updateUserTask,
  getRouterState,
  setRouterState,
  createEmailAccount,
  getEmailAccounts,
  getEmailAccount,
  updateEmailAccount,
  deleteEmailAccount,
  createEmailDraft,
  getEmailDraftsByAccount,
  deleteEmailDraft,
  createSmsAccount,
  getSmsAccounts,
  getSmsAccount,
  updateSmsAccount,
  deleteSmsAccount,
  storeSmsMessage,
  getSmsMessages,
  insertNotification,
  getNotifications,
  getUnreadNotificationCount,
  markAllNotificationsRead,
  markNotificationRead,
  clearAllNotifications,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  listCalendarEvents,
  getCalendarEvent,
  getUserAlarms,
  createAlarm,
  updateAlarm,
  deleteAlarm as deleteAlarmDb,
  getDueAlarms,
  markAlarmFired,
  snoozeAlarm as snoozeAlarmDb,
  disableOneTimeAlarm,
  getProjectsForUser,
  getProjectsByGroup,
  getAllProjects,
  getArchivedProjectsForUser,
  getArchivedProjectsByGroup,
  getProject,
  createProject,
  updateProject,
  archiveProject,
  restoreProject,
  completeProject,
  deleteProject,
  getProjectFinancials,
  updateProjectFinancials,
  getProjectDeliverables,
  addProjectDeliverable,
  toggleDeliverable,
  deleteDeliverable,
  updateDeliverable,
  getProjectBlockers,
  addProjectBlocker,
  deleteBlocker,
  getProjectPriorities,
  addProjectPriority,
  deleteProjectPriority,
  getTimesheetEntries,
  addTimesheetEntry,
  deleteTimesheetEntry,
  getTimesheetSummary,
  updateTimesheetEntry,
  getActiveTimers,
  startTimer,
  stopTimer,
  deleteTimer,
  addUserApiKey,
  getUserApiKeys,
  updateUserApiKey,
  deleteUserApiKey,
  getAllUserApiKeys,
  getUserApiUsage,
  getUserApiUsageSummary,
  getGlobalApiUsage,
  getOAuthAccountsByUser,
  updateOAuthAccount as updateOAuthAccountDb,
  getAdminCustomApis,
  getAdminCustomApi,
  createAdminCustomApi,
  updateAdminCustomApi,
  deleteAdminCustomApi,
  deleteSession,
  getCompanies,
  getCompany,
  createCompany,
  updateCompany,
  deleteCompany,
  getUserChannelConnections,
  getUserChannelConnection,
  upsertUserChannelConnection,
  deleteUserChannelConnection,
  updateUserChannelStatus,
  createPasswordResetToken,
  getPasswordResetToken,
  deletePasswordResetToken,
  getUserByEmail,
} from './db.js';
import { getDb } from './db.js';
import { AgentSessionStore } from './agent-session-store.js';
import { encryptApiKey } from './encryption.js';
import httpProxy from 'http-proxy';
import { WebSocketServer, WebSocket } from 'ws';
import { spawnPty, nodePtyIsAvailable, type PtySession } from './pty-server.js';

// Quick HTTP probe — confirms an in-container service is actually serving,
// not just that the docker port mapping exists.
function probeLocalPort(port: number, path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path, timeout: 800 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}
import { generateICS, parseICS } from './ical.js';
import { fetchEmails, sendEmail, testConnection } from './email.js';
import { sendSMS, fetchMessages as fetchSmsMessages, testConnection as testSmsConnection, testCredentials as testSmsCredentials } from './sms.js';

const STATUS_PORT = parseInt(process.env.STATUS_PORT || '3200', 10);

interface StatusDeps {
  // GroupQueue is gone; queue is kept as a no-op stub slot for compatibility.
  // Methods called on it (getStatus/closeStdin/stopGroup) are inert.
  queue: {
    getStatus(): any;
    closeStdin(_jid: string): void;
    stopGroup(_jid: string): boolean;
    [k: string]: any;
  };
  channels: Channel[];
  registeredGroups: () => Record<string, RegisteredGroup>;
  startedAt: number;
  getMessagesForDashboard: (
    chatJid: string,
    since: string,
    limit?: number,
    idea?: string,
  ) => NewMessage[];
  getAllTasks: () => ScheduledTask[];
  storeMessage: (msg: NewMessage) => void;
  sendChannelMessage: (jid: string, text: string, senderName?: string) => Promise<void>;
  advanceCursor: (jid: string, timestamp: string) => void;
  clearSessions?: (folder: string) => void;
  reconnectChannel?: (type: string) => Promise<boolean>;
  createUserWhatsApp?: (userId: string, authDir: string) => Promise<Channel>;
}

let deps: StatusDeps;

const sseClients = new Map<string, http.ServerResponse[]>();

// Notification queue for polling fallback (SSE may fail behind some HTTP/3 proxies)
const notifQueue = new Map<string, Array<{ payload: string; ts: number }>>();
const NOTIF_QUEUE_MAX = 200;
const NOTIF_QUEUE_TTL = 300_000; // 5 minutes — long enough to survive brief disconnects

// In-memory thinking buffer per chatJid — last 50 words from stderr thinking tokens
const thinkingBuffer = new Map<string, string[]>();

export function getThinkingText(chatJid: string): string {
  return (thinkingBuffer.get(chatJid) || []).join(' ');
}

export function clearThinking(chatJid: string): void {
  thinkingBuffer.delete(chatJid);
}

export function pushActivityLine(userId: string, line: string, chatJid: string): void {
  const payload = JSON.stringify({ type: 'agent_activity', line, from: chatJid });
  for (const client of sseClients.get(userId) || []) {
    try { client.write(`data: ${payload}\n\n`); } catch {}
  }
  // Extract thinking words from dim-coded stderr lines (ANSI \x1b[2m = thinking)
  if (line.includes('\x1b[2m')) {
    const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (clean) {
      const buf = thinkingBuffer.get(chatJid) || [];
      const words = clean.split(/\s+/).filter(w => w);
      buf.push(...words);
      while (buf.length > 50) buf.shift();
      thinkingBuffer.set(chatJid, buf);
    }
  }
}

// ── Inbox cache: 5-minute TTL, warmed by a background timer ─────────────
const INBOX_CACHE_TTL_MS = 5 * 60 * 1000;
const inboxCache = new Map<string, { emails: any[]; fetchedAt: number }>();

export function startInboxCacheWarmer(): void {
  const warm = async () => {
    try {
      const { getEmailAccounts } = await import('./db.js');
      const { fetchEmails } = await import('./email.js');
      for (const acct of getEmailAccounts()) {
        if (!acct.enabled) continue;
        try {
          const emails = await fetchEmails(acct.id, 'INBOX', 20);
          inboxCache.set(`${acct.id}:INBOX`, { emails, fetchedAt: Date.now() });
        } catch { /* account unreachable — keep whatever cache exists */ }
      }
    } catch { /* never let the warmer crash the server */ }
  };
  void warm(); // prime on boot
  setInterval(warm, INBOX_CACHE_TTL_MS).unref?.();
}

export function pushNotification(
  userId: string,
  data: { type: string; message: string; taskId?: string; from?: string },
): void {
  const nid = `n-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const payload = JSON.stringify({
    ...data,
    id: nid,
    userId,
    timestamp: new Date().toISOString(),
  });

  // Persist to database (single-user — OWNER_JID)
  try {
    insertNotification({
      userId,
      type: data.type,
      message: data.message,
      taskId: data.taskId,
    });
  } catch { /* db write failure shouldn't break SSE */ }

  // Native desktop notification — only for tasks and alarms, not chat messages.
  // Warden runs as the user's session, so notify-send reaches the Plasma
  // notification center directly. Fire and forget; a missing binary or dead DBus
  // must never break delivery.
  if (data.type === 'task' || data.type === 'alarm') {
    try {
      const title = data.type === 'task' ? 'Warden — reminder' : 'Warden — alarm';
      const body = (data.message || '').slice(0, 300);
      const child = spawn('notify-send', ['--app-name=Warden', '--icon=appointment-soon', title, body], {
        detached: true, stdio: 'ignore',
      });
      child.unref();
      child.on('error', () => { /* notify-send unavailable — SSE still delivered */ });
    } catch { /* never block notification delivery */ }
  }

  // Broadcast to ALL connected SSE clients (single-user — no per-user routing).
  let sentViaSSE = false;
  for (const [, clients] of sseClients) {
    for (const client of clients) {
      try {
        client.write(`data: ${payload}\n\n`);
        sentViaSSE = true;
      } catch {
        /* client disconnected */
      }
    }
  }

  // Queue for polling fallback only if SSE delivery failed
  if (!sentViaSSE) {
    const now = Date.now();
    if (!notifQueue.has(userId)) notifQueue.set(userId, []);
    const q = notifQueue.get(userId)!;
    q.push({ payload, ts: now });
    while (q.length > NOTIF_QUEUE_MAX) q.shift();
  }
}

function drainNotifQueue(userId: string, since?: number): string[] {
  const q = notifQueue.get(userId);
  if (!q || q.length === 0) return [];
  const cutoff = since || 0;
  const now = Date.now();
  const results: string[] = [];
  const delivered: typeof q = [];
  for (const item of q) {
    if (item.ts <= cutoff || now - item.ts > NOTIF_QUEUE_TTL) continue;
    results.push(item.payload);
    delivered.push(item);
  }
  // Remove delivered items, keep only those not yet returned
  if (results.length > 0) {
    const deliveredSet = new Set(delivered);
    notifQueue.set(userId, q.filter(i => !deliveredSet.has(i)));
  }
  return results;
}

const STATIC_DIR = path.resolve(process.cwd(), 'public');

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.ico': 'image/x-icon',
};

// --- Helpers ---

// Security headers applied to all responses
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-User-Session, X-Admin-Session, x-filename',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
};

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
  });
  res.end(JSON.stringify(data));
}

function error(res: http.ServerResponse, msg: string, status = 400): void {
  json(res, { error: msg }, status);
}

const MAX_BODY_SIZE = 50 * 1024 * 1024; // 50MB for regular API requests
const MAX_UPLOAD_SIZE = 1024 * 1024 * 1024; // 1GB for file uploads

function parseBody(req: http.IncomingMessage, maxSize: number = MAX_BODY_SIZE): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxSize) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJson(buf: Buffer): unknown {
  return JSON.parse(buf.toString('utf-8'));
}

function parseUrl(raw: string): { pathname: string; params: URLSearchParams } {
  const idx = raw.indexOf('?');
  if (idx === -1) return { pathname: raw, params: new URLSearchParams() };
  return {
    pathname: raw.slice(0, idx),
    params: new URLSearchParams(raw.slice(idx + 1)),
  };
}

/** Auto-commit changes in a group folder after file operations */
function autoCommitGroupFile(filePath: string): void {
  const relFromGroups = path.relative(GROUPS_DIR, filePath);
  const groupFolder = relFromGroups.split(path.sep)[0];
  const groupDir = path.join(GROUPS_DIR, groupFolder);
  if (!fs.existsSync(path.join(groupDir, '.git'))) return;
  try {
    execSync('git add -A && git diff --cached --quiet || git commit -m "Dashboard file change"', {
      cwd: groupDir, timeout: 5000, stdio: 'ignore',
      env: { ...process.env, GIT_AUTHOR_NAME: 'Warden', GIT_AUTHOR_EMAIL: 'dockbox@local', GIT_COMMITTER_NAME: 'Warden', GIT_COMMITTER_EMAIL: 'dockbox@local' },
    });
  } catch { /* non-fatal */ }
}

/** Resolve a relative path within GROUPS_DIR. Returns null if it escapes. */
function safePath(rel: string): string | null {
  if (rel.includes('..')) return null;
  const resolved = path.resolve(GROUPS_DIR, rel || '.');
  if (!resolved.startsWith(GROUPS_DIR)) return null;
  return resolved;
}

function serveStatic(res: http.ServerResponse, urlPath: string): void {
  // /beta/ → preview the beta dashboard at public/beta/. Beta edits happen here
  // before promotion to the live / root dashboard.
  if (urlPath === '/beta' || urlPath === '/beta/' || urlPath.startsWith('/beta/')) {
    const betaDir = path.join(STATIC_DIR, 'beta');
    let rel = (urlPath === '/beta' || urlPath === '/beta/') ? '/index.html' : urlPath.slice('/beta'.length);
    if (rel === '' || rel === '/') rel = '/index.html';
    const filePath = path.join(betaDir, rel);
    if (!filePath.startsWith(betaDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    const ext = path.extname(filePath);
    const mime = MIME[ext] || 'application/octet-stream';
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0', ...SECURITY_HEADERS });
      res.end(data);
    });
    return;
  }
  // Single-user local dashboard: serve the actual chat dashboard at root.
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  if (urlPath === '/login' || urlPath === '/signup' || urlPath === '/reset-password') {
    rel = '/index.html';
  }
  const filePath = path.join(STATIC_DIR, rel);
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0', ...SECURITY_HEADERS });
    res.end(data);
  });
}

// --- Password helpers ---

function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err) reject(err);
      resolve(salt + ':' + derived.toString('hex'));
    });
  });
}

function verifyPassword(password: string, stored: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const [salt, hash] = stored.split(':');
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err) reject(err);
      resolve(crypto.timingSafeEqual(Buffer.from(hash, 'hex'), derived));
    });
  });
}

function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

const TURNSTILE_SECRET =
  process.env.TURNSTILE_SECRET
  || readEnvFile(['TURNSTILE_SECRET']).TURNSTILE_SECRET
  || '0x4AAAAAADNaYWXE5XoK-cCLbFyp0DJEPYs';
if (TURNSTILE_SECRET === '0x4AAAAAADNaYWXE5XoK-cCLbFyp0DJEPYs') {
  logger.warn(
    'SECURITY: TURNSTILE_SECRET is not set (env var or env file) — falling back to the hardcoded default secret, which is compromised. Set TURNSTILE_SECRET in data/env/env.',
  );
}

async function verifyTurnstile(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  try {
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: TURNSTILE_SECRET, response: token }),
    });
    const data = await resp.json() as any;
    return data.success === true;
  } catch {
    return false;
  }
}

function validatePasswordStrength(pw: string): string | null {
  if (pw.length < 6) return 'Must be at least 6 characters';
  if (!/[A-Z]/.test(pw)) return 'Must contain an uppercase letter';
  if (!/[0-9]/.test(pw)) return 'Must contain a number';
  if (!/[^A-Za-z0-9]/.test(pw)) return 'Must contain a special character';
  return null;
}

// --- Route handlers ---

let _prevCpuTimes: Array<{ idle: number; total: number }> | null = null;

function getSystemMetrics() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const cpus = os.cpus();

  const currTimes = cpus.map(cpu => {
    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
    return { idle: cpu.times.idle, total };
  });

  let cpuPercent: number;
  if (_prevCpuTimes && _prevCpuTimes.length === currTimes.length) {
    // Delta-based: measure actual usage since last sample
    let idleDelta = 0, totalDelta = 0;
    for (let i = 0; i < currTimes.length; i++) {
      idleDelta += currTimes[i].idle - _prevCpuTimes[i].idle;
      totalDelta += currTimes[i].total - _prevCpuTimes[i].total;
    }
    cpuPercent = totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 100) : 0;
  } else {
    // First call: cumulative average (fallback)
    const cpuAvg = cpus.reduce((sum, cpu) => {
      const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
      return sum + (1 - cpu.times.idle / total);
    }, 0) / cpus.length;
    cpuPercent = Math.round(cpuAvg * 100);
  }
  _prevCpuTimes = currTimes;

  return {
    cpuPercent,
    cpuCores: cpus.length,
    memUsedBytes: usedMem,
    memTotalBytes: totalMem,
    memPercent: Math.round((usedMem / totalMem) * 100),
  };
}

async function handleStressTest(req: http.IncomingMessage, res: http.ServerResponse) {
  const raw = await parseBody(req);
  const body = JSON.parse(raw.toString());
  const count = Math.min(Math.max(parseInt(body.count, 10) || 10, 1), 100);
  const mode = body.mode === 'light' ? 'light' : 'heavy';

  const agentRunnerSrc = path.join(process.cwd(), 'container', 'agent-runner', 'src');
  if (!fs.existsSync(agentRunnerSrc)) {
    return json(res, { ok: false, error: 'agent-runner source not found' }, 500);
  }

  // For light mode, pre-compile once on host and mount the dist into every container
  const benchDistDir = path.join(DATA_DIR, 'sessions', '_bench', 'agent-runner-dist');
  if (mode === 'light') {
    const needsCompile = !fs.existsSync(path.join(benchDistDir, 'index.js'));
    if (needsCompile) {
      try {
        fs.mkdirSync(benchDistDir, { recursive: true });
        execSync(
          `npx tsc --outDir ${JSON.stringify(benchDistDir)} --rootDir ${JSON.stringify(agentRunnerSrc)} --target ES2022 --module NodeNext --moduleResolution NodeNext --esModuleInterop --skipLibCheck`,
          { cwd: path.join(process.cwd(), 'container', 'agent-runner'), timeout: 30000, stdio: 'ignore' },
        );
      } catch {
        return json(res, { ok: false, error: 'Pre-compile failed' }, 500);
      }
    }
  }

  const baseline = getSystemMetrics();
  const wallStart = Date.now();
  let peakCpu = baseline.cpuPercent;
  let peakMemPercent = baseline.memPercent;

  const metricsInterval = setInterval(() => {
    const m = getSystemMetrics();
    if (m.cpuPercent > peakCpu) peakCpu = m.cpuPercent;
    if (m.memPercent > peakMemPercent) peakMemPercent = m.memPercent;
  }, 125);

  const results: Array<{ index: number; bootMs: number; exitCode: number | null }> = [];
  const timestamp = Date.now();

  const promises = Array.from({ length: count }, (_, i) => {
    const containerName = `dockbox-bench-${i + 1}-${timestamp}`;
    const spawnTime = Date.now();

    const args = mode === 'light'
      ? [
          'run', '--rm', '--name', containerName,
          '--entrypoint', 'node',
          '-v', `${benchDistDir}:/tmp/dist:ro`,
          '-e', 'NODE_PATH=/app/node_modules',
          CONTAINER_IMAGE,
          '-e', 'process.exit(0)',
        ]
      : [
          'run', '--rm', '--name', containerName,
          '--entrypoint', '/bin/bash',
          '-v', `${agentRunnerSrc}:/app/src:ro`,
          CONTAINER_IMAGE,
          '-c', 'cd /app && npx tsc --outDir /tmp/dist 2>&1 >/dev/null && node -e "process.exit(0)"',
        ];

    return new Promise<void>((resolve) => {
      // container-runtime binary was removed; spawn will ENOENT and report exitCode -1.
      const proc = spawn('/usr/local/bin/container-runtime-deleted', args, { stdio: 'ignore' });

      proc.on('close', (code) => {
        results.push({ index: i + 1, bootMs: Date.now() - spawnTime, exitCode: code });
        resolve();
      });

      proc.on('error', () => {
        results.push({ index: i + 1, bootMs: Date.now() - spawnTime, exitCode: -1 });
        resolve();
      });
    });
  });

  await Promise.all(promises);
  clearInterval(metricsInterval);

  const finalMetrics = getSystemMetrics();
  if (finalMetrics.cpuPercent > peakCpu) peakCpu = finalMetrics.cpuPercent;
  if (finalMetrics.memPercent > peakMemPercent) peakMemPercent = finalMetrics.memPercent;

  const wallTimeMs = Date.now() - wallStart;
  const bootTimes = results.map(r => r.bootMs).sort((a, b) => a - b);
  const success = results.filter(r => r.exitCode === 0).length;

  return json(res, {
    ok: true,
    mode,
    count,
    wallTimeMs,
    avgBootMs: Math.round(bootTimes.reduce((a, b) => a + b, 0) / bootTimes.length),
    minBootMs: bootTimes[0],
    maxBootMs: bootTimes[bootTimes.length - 1],
    medianBootMs: bootTimes[Math.floor(bootTimes.length / 2)],
    peakCpuPercent: peakCpu,
    peakMemPercent,
    baselineCpuPercent: baseline.cpuPercent,
    baselineMemPercent: baseline.memPercent,
    success,
    failed: count - success,
    perContainer: results.sort((a, b) => a.index - b.index),
  });
}

function getStatusData() {
  const groups = deps.registeredGroups();
  const queueStatus = deps.queue.getStatus();
  const uptime = Math.floor((Date.now() - deps.startedAt) / 1000);

  const groupList = Object.entries(groups).map(([jid, g]) => {
    const qState: any = queueStatus.groups.find((q: any) => q.jid === jid);
    const live = getLiveStatus();
    return {
      jid,
      name: g.name,
      folder: g.folder,
      channel: g.folder.split('_')[0] || 'unknown',
      isMain: g.isMain || false,
      active: qState?.active || false,
      idle: qState?.idle || false,
      containerName: qState?.containerName || null,
      pendingMessages: qState?.pendingMessages || false,
      pendingTasks: qState?.pendingTasks || 0,
      parallelContainers: qState?.parallelContainers || 0,
      liveLabel: live.label || '',
      livePhase: live.phase || '',
      liveTools: live.tools || [],
      liveTs: live.ts || 0,
    };
  });

  return {
    assistant: ASSISTANT_NAME,
    localAssistant: LOCAL_ASSISTANT_NAME,
    uptime,
    channels: deps.channels.map((c) => c.name),
    activeContainers: Math.max(queueStatus.activeCount, queueStatus.groups.filter((g: any) => g.active).length),
    scheduledTasks: deps.getAllTasks().length,
    runningJobs: getLiveStatus().jobs || 0,
    groups: groupList,
    timestamp: new Date().toISOString(),
    ollamaChatModel: process.env.OLLAMA_CHAT_MODEL || OLLAMA_CHAT_MODEL,
    ollamaUrl: OLLAMA_URL,
    defaultModelMode: DEFAULT_MODEL_MODE,
    ollamaEnabled: getRouterState('ollama_enabled') === 'true',
    system: getSystemMetrics(),
  };
}

const WEB_DASHBOARD_JID = 'web:dashboard';

function getMainJid(): string | null {
  const groups = deps.registeredGroups();
  for (const [jid, g] of Object.entries(groups)) {
    if (g.isMain) return jid;
  }
  return null;
}

function resolveMessageJid(params: URLSearchParams): string {
  const jid = params.get('jid');
  if (jid) return jid;
  return WEB_DASHBOARD_JID;
}

async function handleMessages(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: URLSearchParams,
): Promise<void> {
  if (req.method === 'GET') {
    const jid = resolveMessageJid(params);
    const since = params.get('since') || '';
    const limit = parseInt(params.get('limit') || '50', 10);
    const idea = params.get('idea') || '';
    const messages = deps.getMessagesForDashboard(jid, since, limit, idea || undefined);
    return json(res, { messages, jid });
  }

  if (req.method === 'POST') {
    const body = parseJson(await parseBody(req)) as {
      text?: string;
      jid?: string;
      sender_name?: string;
      model?: string;
      is_bot_message?: boolean;
      verbose?: boolean;
      thinking?: boolean | string;
      idea?: string;
    };
    if (!body.text) return error(res, 'text required');
    const jid = body.jid || WEB_DASHBOARD_JID;

    // Bot message mode: store + relay without triggering agent
    if (body.is_bot_message) {
      const msg: NewMessage = {
        id: `bot-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        chat_jid: jid,
        sender: 'assistant',
        sender_name: body.sender_name || ASSISTANT_NAME,
        content: body.text,
        timestamp: new Date().toISOString(),
        is_from_me: false,
        is_bot_message: true,
        idea: getRouterState(`idea:${jid}`) || '',
      };
      deps.storeMessage(msg);
      if (!jid.startsWith('web:')) {
        deps.sendChannelMessage(jid, body.text).catch((err: any) => {
          logger.warn({ err, jid }, 'Failed to relay bot message to channel');
        });
      }
      return json(res, { ok: true, id: msg.id });
    }

    // Store model/mode preference for this JID — only when explicitly provided.
    // When body.model is absent/empty, keep the existing mode/model unchanged
    // so that a dropdown reset (e.g. from async Ollama model loading) doesn't
    // silently clear a user's "local" selection.
    if (typeof body.model === 'string' && body.model.startsWith('userkey:')) {
      // User's own API key — store key ID for routing
      const keyId = body.model.slice(8);
      setRouterState(`mode:${jid}`, 'userkey');
      setRouterState(`userkey:${jid}`, keyId);
      setRouterState(`model:${jid}`, '');
    } else if (typeof body.model === 'string' && body.model.startsWith('local:')) {
      const localModel = body.model.slice(6);
      setRouterState(`mode:${jid}`, 'local');
      setRouterState(`model:${jid}`, '');
      setRouterState(`userkey:${jid}`, '');
      if (localModel) setRouterState(`ollama_chat_model:${jid}`, localModel);
    } else if (body.model === 'local' || body.model === 'hybrid') {
      setRouterState(`mode:${jid}`, body.model);
      setRouterState(`model:${jid}`, '');
    } else if (body.model === 'auto') {
      // Explicit "auto" resets to default Claude routing
      setRouterState(`model:${jid}`, '');
      setRouterState(`mode:${jid}`, '');
    } else if (body.model) {
      setRouterState(`model:${jid}`, body.model);
      setRouterState(`mode:${jid}`, '');
    }
    // Store verbose preference for this JID (controls thinking output visibility)
    if (typeof body.verbose === 'boolean') {
      setRouterState(`verbose:${jid}`, body.verbose ? '1' : '0');
    }
    // If body.model is undefined/empty, leave current mode/model untouched

    // Store idea scope for prompt injection (not visible in stored message)
    if (body.idea) {
      setRouterState(`idea:${jid}`, body.idea);
    } else {
      setRouterState(`idea:${jid}`, '');
    }

    const msg: NewMessage = {
      id: `dashboard-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      chat_jid: jid,
      sender: 'dashboard',
      sender_name: body.sender_name || 'Admin',
      content: body.text,
      timestamp: new Date().toISOString(),
      is_from_me: true,
      is_bot_message: false,
      idea: body.idea || '',
    };
    deps.storeMessage(msg);

    // Relay to the actual channel if it's not a web-only JID
    if (!jid.startsWith('web:')) {
      const senderLabel = msg.sender_name || 'Admin';
      deps.sendChannelMessage(jid, body.text, senderLabel).catch((err: any) => {
        logger.warn({ err, jid }, 'Failed to relay dashboard message to channel');
      });
    } else {
      // For web JIDs, check if there's a linked channel JID and relay to it
      const groups = deps.registeredGroups();
      const thisGroup = groups[jid];
      if (thisGroup && thisGroup.folder) {
        for (const [linkedJid, g] of Object.entries(groups)) {
          if (g.folder === thisGroup.folder && linkedJid !== jid && !linkedJid.startsWith('web:')) {
            const senderLabel = msg.sender_name || 'Admin';
            deps.sendChannelMessage(linkedJid, body.text, senderLabel).catch((err: any) => {
              logger.warn({ err, jid: linkedJid }, 'Failed to relay dashboard message to linked channel');
            });
          }
        }
      }
    }

    return json(res, { ok: true, id: msg.id });
  }
}

// Cache of userId → allowed group folders, refreshed every 30s, so we don't
// call getAllRegisteredGroups() on every single file request.
const FOLDER_PERMISSION_TTL_MS = 30_000;
const folderPermissionCache = new Map<string, { folderSet: Set<string>; ts: number }>();

async function handleFiles(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  params: URLSearchParams,
): Promise<void> {
  const relPath = params.get('path') || '';

  // Single-user Warden: no per-user folder scoping. safePathUser is a thin
  // alias over safePath kept so call sites compile.
  function safePathUser(rel: string): string | null {
    if (rel.includes('..')) return null;
    const resolved = path.resolve(GROUPS_DIR, rel || '.');
    if (!resolved.startsWith(GROUPS_DIR)) return null;
    return resolved;
  }

  // DELETE
  if (req.method === 'DELETE') {
    const full = safePathUser(relPath);
    if (!full) return error(res, 'Invalid path', 403);
    if (!fs.existsSync(full)) return error(res, 'Not found', 404);
    try {
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        const recursive = params.get('recursive') === 'true';
        const children = fs.readdirSync(full);
        if (children.length > 0 && !recursive) {
          return error(res, 'Directory is not empty. Pass ?recursive=true to delete recursively.', 400);
        }
        fs.rmSync(full, { recursive: true });
      } else {
        fs.unlinkSync(full);
      }
      return json(res, { ok: true });
    } catch (e: any) {
      return error(res, e.message, 500);
    }
  }

  // POST routes
  if (req.method === 'POST') {
    if (pathname === '/api/files/upload') {
      const dir = safePathUser(relPath);
      if (!dir) return error(res, 'Invalid path', 403);
      const rawFilename = req.headers['x-filename'] as string;
      if (!rawFilename) return error(res, 'Invalid filename');
      const filename = decodeURIComponent(rawFilename);
      if (filename.includes('/') || filename.includes('..'))
        return error(res, 'Invalid filename');
      const data = await parseBody(req, MAX_UPLOAD_SIZE);
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, filename);
      fs.writeFileSync(filePath, data);
      return json(res, { ok: true });
    }
    if (pathname === '/api/files/mkdir') {
      const body = parseJson(await parseBody(req)) as { path?: string };
      if (!body.path) return error(res, 'path required');
      const full = safePathUser(body.path);
      if (!full) return error(res, 'Invalid path', 403);
      fs.mkdirSync(full, { recursive: true });

      return json(res, { ok: true });
    }
    if (pathname === '/api/files/revert') {
      const body = parseJson(await parseBody(req)) as { path?: string; hash?: string };
      if (!body.path || !body.hash) return error(res, 'path and hash required');
      if (!/^[a-f0-9]+$/.test(body.hash)) return error(res, 'Invalid hash');
      const full = safePathUser(body.path);
      if (!full) return error(res, 'Invalid path', 403);
      const relFromGroups = path.relative(GROUPS_DIR, full);
      const groupFolder = relFromGroups.split(path.sep)[0];
      const groupDir = path.join(GROUPS_DIR, groupFolder);
      const fileInGroup = path.relative(groupDir, full);
      try {
        const { execFileSync: efs, execSync: es } = require('child_process');
        const content = efs('git', ['show', `${body.hash}:${fileInGroup}`], { cwd: groupDir, timeout: 5000, encoding: 'utf-8' });
        fs.writeFileSync(full, content);
        // Auto-commit the revert — two-step to avoid shell interpolation.
        // stderr is piped so failures can be logged instead of swallowed.
        efs('git', ['add', '-A'], { cwd: groupDir, timeout: 5000, stdio: ['ignore', 'ignore', 'pipe'],
          env: { ...process.env, GIT_AUTHOR_NAME: 'Warden', GIT_AUTHOR_EMAIL: 'dockbox@local', GIT_COMMITTER_NAME: 'Warden', GIT_COMMITTER_EMAIL: 'dockbox@local' },
        });
        efs('git', ['commit', '-m', `Revert: ${fileInGroup} to ${body.hash.slice(0, 7)}`], {
          cwd: groupDir, timeout: 5000, stdio: ['ignore', 'ignore', 'pipe'],
          env: { ...process.env, GIT_AUTHOR_NAME: 'Warden', GIT_AUTHOR_EMAIL: 'dockbox@local', GIT_COMMITTER_NAME: 'Warden', GIT_COMMITTER_EMAIL: 'dockbox@local' },
        });
        return json(res, { ok: true });
      } catch (err: any) {
        logger.warn(
          { err: String(err), stderr: err?.stderr?.toString?.(), groupDir, file: fileInGroup },
          'Git revert operation failed',
        );
        return error(res, 'Revert failed', 500);
      }
    }
    if (pathname === '/api/files/rename') {
      const body = parseJson(await parseBody(req)) as {
        from?: string;
        to?: string;
      };
      if (!body.from || !body.to) return error(res, 'from and to required');
      const fromFull = safePathUser(body.from);
      const toFull = safePathUser(body.to);
      if (!fromFull || !toFull) return error(res, 'Invalid path', 403);
      fs.renameSync(fromFull, toFull);
      return json(res, { ok: true });
    }
    if (pathname === '/api/files/copy') {
      const body = parseJson(await parseBody(req)) as {
        from?: string;
        to?: string;
      };
      if (!body.from || !body.to) return error(res, 'from and to required');
      const fromFull = safePathUser(body.from);
      const toFull = safePathUser(body.to);
      if (!fromFull || !toFull) return error(res, 'Invalid path', 403);
      if (!fs.existsSync(fromFull)) return error(res, 'Source not found', 404);
      const stat = fs.statSync(fromFull);
      if (stat.isDirectory()) {
        fs.cpSync(fromFull, toFull, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(toFull), { recursive: true });
        fs.copyFileSync(fromFull, toFull);
      }
      return json(res, { ok: true });
    }
  }

  // GET routes
  if (req.method === 'GET') {
    if (pathname === '/api/files/list') {
      const full = safePathUser(relPath);
      if (!full) return error(res, 'Invalid path', 403);
      if (!fs.existsSync(full)) return error(res, 'Not found', 404);
      const stat = fs.statSync(full);
      if (!stat.isDirectory()) return error(res, 'Not a directory', 400);
      const recursive = params.get('recursive') === 'true';

      const listDir = (dir: string, prefix: string): any[] => {
        const entries: any[] = [];
        for (const name of fs.readdirSync(dir)) {
          if (name.startsWith('.')) continue; // Skip hidden files/dirs
          const entryPath = path.join(dir, name);
          let entryStat: fs.Stats;
          try { entryStat = fs.statSync(entryPath); } catch { continue; }
          if (entryStat.isDirectory()) {
            entries.push({ name: prefix + name, type: 'dir', size_bytes: 0, mtime: entryStat.mtimeMs / 1000 });
            if (recursive) {
              entries.push(...listDir(entryPath, prefix + name + '/'));
            }
          } else {
            const entry: any = {
              name: prefix + name,
              type: 'file',
              size_bytes: entryStat.size,
              mtime: entryStat.mtimeMs / 1000,
            };
            try {
              const hash = crypto.createHash('sha256').update(fs.readFileSync(entryPath)).digest('hex');
              entry.hash = `sha256:${hash}`;
            } catch { /* skip hash on read error */ }
            entries.push(entry);
          }
        }
        return entries;
      };

      // No per-user folder filtering in single-user Warden.
      const results = listDir(full, '');
      return json(res, results);
    }
    if (pathname === '/api/files/stat') {
      const full = safePathUser(relPath);
      if (!full) return error(res, 'Invalid path', 403);
      if (!fs.existsSync(full)) return error(res, 'Not found', 404);
      const stat = fs.statSync(full);
      const entry: any = {
        name: path.basename(full),
        type: stat.isDirectory() ? 'dir' : 'file',
        size_bytes: stat.isDirectory() ? 0 : stat.size,
        mtime: stat.mtimeMs / 1000,
      };
      if (!stat.isDirectory()) {
        try {
          entry.hash = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`;
        } catch { /* skip hash on read error */ }
      }
      return json(res, entry);
    }
    if (pathname === '/api/files/download') {
      const full = safePathUser(relPath);
      if (!full) return error(res, 'Invalid path', 403);
      if (!fs.existsSync(full)) return error(res, 'Not found', 404);
      if (fs.statSync(full).isDirectory()) {
        const dirName = path.basename(full);
        res.writeHead(200, {
          'Content-Type': 'application/gzip',
          'Content-Disposition': `attachment; filename="${dirName}.tar.gz"`,
        });
        const { spawn } = require('child_process');
        const tar = spawn('tar', ['-czf', '-', '-C', path.dirname(full), dirName]);
        tar.stdout.pipe(res);
        tar.stderr.on('data', () => {});
        tar.on('error', () => res.end());
        return;
      }
      const name = path.basename(full);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${name}"`,
      });
      fs.createReadStream(full).pipe(res);
      return;
    }
    if (pathname === '/api/files/serve') {
      const full = safePathUser(relPath);
      if (!full) return error(res, 'Invalid path', 403);
      if (!fs.existsSync(full) || fs.statSync(full).isDirectory())
        return error(res, 'Not found', 404);
      const ext = path.extname(full).toLowerCase();
      const contentType = MIME[ext] || 'application/octet-stream';
      const stat = fs.statSync(full);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Cache-Control': 'public, max-age=3600',
      });
      fs.createReadStream(full).pipe(res);
      return;
    }
    if (pathname === '/api/files/read') {
      const full = safePathUser(relPath);
      if (!full) return error(res, 'Invalid path', 403);
      if (!fs.existsSync(full) || fs.statSync(full).isDirectory())
        return error(res, 'Not found', 404);
      const stat = fs.statSync(full);
      if (stat.size > 50 * 1024 * 1024)
        return error(res, 'File too large (>50MB)', 413);
      // Handle docx files
      if (full.endsWith('.docx')) {
        try {
          const mammoth = await import('mammoth');
          const result = await mammoth.default.convertToHtml({ path: full });
          return json(res, { content: result.value, size: stat.size, format: 'html' });
        } catch (e: any) {
          return error(res, 'Failed to read docx', 500);
        }
      }
      // Handle PDF files — extract text via pdftotext
      if (full.endsWith('.pdf')) {
        try {
          const { execSync } = require('child_process');
          const { execFileSync } = require('child_process');
          const text = execFileSync('pdftotext', [full, '-'], { maxBuffer: 50 * 1024 * 1024 }).toString();
          return json(res, { content: text, size: stat.size, format: 'text' });
        } catch (e: any) {
          return error(res, 'Failed to read PDF', 500);
        }
      }
      const content = fs.readFileSync(full, 'utf-8');
      return json(res, { content, size: stat.size });
    }
    if (pathname === '/api/files/history') {
      const full = safePathUser(relPath);
      if (!full) return error(res, 'Invalid path', 403);
      // Find the group folder's git root
      const relFromGroups = path.relative(GROUPS_DIR, full);
      const groupFolder = relFromGroups.split(path.sep)[0];
      const groupDir = path.join(GROUPS_DIR, groupFolder);
      if (!fs.existsSync(path.join(groupDir, '.git')))
        return json(res, { versions: [] });
      const fileInGroup = path.relative(groupDir, full);
      try {
        const { execFileSync: efs2 } = require('child_process');
        const log = efs2('git', ['log', '--pretty=format:%H|%ai|%s', '--', fileInGroup], { cwd: groupDir, timeout: 5000, encoding: 'utf-8' });
        const versions = log.trim().split('\n').filter(Boolean).map((line: string) => {
          const [hash, date, ...msgParts] = line.split('|');
          return { hash, date, message: msgParts.join('|') };
        });
        return json(res, { versions });
      } catch {
        return json(res, { versions: [] });
      }
    }
    if (pathname === '/api/files/version') {
      const full = safePathUser(relPath);
      if (!full) return error(res, 'Invalid path', 403);
      const hash = params.get('hash');
      if (!hash || !/^[a-f0-9]+$/.test(hash)) return error(res, 'Invalid hash');
      const relFromGroups = path.relative(GROUPS_DIR, full);
      const groupFolder = relFromGroups.split(path.sep)[0];
      const groupDir = path.join(GROUPS_DIR, groupFolder);
      const fileInGroup = path.relative(groupDir, full);
      try {
        const { execFileSync: efs3 } = require('child_process');
        const content = efs3('git', ['show', `${hash}:${fileInGroup}`], { cwd: groupDir, timeout: 5000, encoding: 'utf-8' });
        return json(res, { content });
      } catch {
        return error(res, 'Version not found', 404);
      }
    }
    // Default: list directory
    const full = safePathUser(relPath);
    if (!full) return error(res, 'Invalid path', 403);
    if (!fs.existsSync(full)) {
      // Group folder may not be created on disk yet — return empty listing
      // instead of 404 so the UI can render an empty file pane gracefully.
      if (params.get('recursive') === 'true') return json(res, { files: [] });
      return json(res, { entries: [], path: relPath || '.' });
    }
    const stat = fs.statSync(full);
    if (!stat.isDirectory()) return error(res, 'Not a directory');

    // Recursive listing for file pickers
    if (params.get('recursive') === 'true') {
      const files: Array<{
        path: string;
        name: string;
        size: number;
        mtime: string;
      }> = [];
      const walkDir = (dir: string, prefix: string) => {
        try {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const rel = prefix ? prefix + '/' + entry.name : entry.name;
            if (entry.isDirectory()) {
              walkDir(path.join(dir, entry.name), rel);
            } else {
              try {
                const s = fs.statSync(path.join(dir, entry.name));
                files.push({
                  path: rel,
                  name: entry.name,
                  size: s.size,
                  mtime: s.mtime.toISOString(),
                });
              } catch {
                files.push({ path: rel, name: entry.name, size: 0, mtime: '' });
              }
            }
            if (files.length >= 2000) return;
          }
        } catch {}
      };
      walkDir(full, relPath || '');
      return json(res, { files });
    }

    // Build set of scrubbed file paths for badge indicators
    const vaultIndex = loadVaultIndex();
    const scrubbedPaths = new Set<string>();
    for (const entry of vaultIndex) {
      if (entry.status === 'scrubbed') {
        scrubbedPaths.add(entry.originalPath);
        // Also mark the .md replacement
        const mdPath = entry.originalPath.replace(/\.[^.]+$/, '.md');
        scrubbedPaths.add(mdPath);
      }
    }

    // Hide internal/system entries from file browser
    const HIDDEN_NAMES = new Set([
      'logs', 'conversations', '.claude',
    ]);
    let entries = fs.readdirSync(full)
      .filter((name) => !name.startsWith('.') && !HIDDEN_NAMES.has(name))
      .map((name) => {
      try {
        const s = fs.statSync(path.join(full, name));
        const fullPath = path.join(full, name);
        return {
          name,
          type: s.isDirectory() ? 'dir' : 'file',
          size: s.size,
          mtime: s.mtime.toISOString(),
          scrubbed: scrubbedPaths.has(fullPath),
        };
      } catch {
        return { name, type: 'file', size: 0, mtime: '', scrubbed: false };
      }
    });
    // No per-user folder filtering in single-user Warden.
    // Sort: dirs first, then alphabetical
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return json(res, { entries, path: relPath || '.' });
  }
}

function handleSettings(res: http.ServerResponse): void {
  const envVals = readEnvFile([
    'CALENDAR_TOKEN',
    'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
    'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET',
  ]);
  const googleId = process.env.GOOGLE_CLIENT_ID || envVals.GOOGLE_CLIENT_ID || '';
  const googleSecret = process.env.GOOGLE_CLIENT_SECRET || envVals.GOOGLE_CLIENT_SECRET || '';
  const msId = process.env.MICROSOFT_CLIENT_ID || envVals.MICROSOFT_CLIENT_ID || '';
  const msSecret = process.env.MICROSOFT_CLIENT_SECRET || envVals.MICROSOFT_CLIENT_SECRET || '';
  json(res, {
    assistantName: ASSISTANT_NAME,
    localAssistantName: LOCAL_ASSISTANT_NAME,
    timezone: TIMEZONE,
    containerImage: CONTAINER_IMAGE,
    containerTimeout: parseInt(process.env.CONTAINER_TIMEOUT || '7200000', 10),
    idleTimeout: IDLE_TIMEOUT,
    maxConcurrentContainers: 1,
    groupsDir: GROUPS_DIR,
    ollamaUrl: OLLAMA_URL,
    ollamaModel: process.env.OLLAMA_MODEL || '',
    ollamaChatModel: process.env.OLLAMA_CHAT_MODEL || OLLAMA_CHAT_MODEL,
    defaultModelMode: DEFAULT_MODEL_MODE,
    orchestratorModel: getRouterState('orchestrator:model') || getRouterState('global:default_model') || '',
    atlasModel: getRouterState('atlas:model') || '',
    councilSkepticModel: getRouterState('council:skeptic_model') || '',
    councilPragmatistModel: getRouterState('council:pragmatist_model') || '',
    councilSynthesistModel: getRouterState('council:synthesist_model') || '',
    ollamaEnabled: getRouterState('ollama_enabled') === 'true',
    automationModel: getRouterState('automation:model') || '',
    hybridPrivacy: getRouterState('hybrid_privacy') || '',
    localPrivateModel: getRouterState('local:private_model') || '',
    calendarToken: process.env.CALENDAR_TOKEN || envVals.CALENDAR_TOKEN || '',
    google_client_id: googleId,
    microsoft_client_id: msId,
    google_configured: !!(googleId && googleSecret),
    microsoft_configured: !!(msId && msSecret),
    orchestratorCtx: getRouterState('local:orchestrator_ctx') || '',
    subagentCtx: getRouterState('local:subagent_ctx') || '',
    atlasCtx: getRouterState('local:atlas_ctx') || '',
    toolsCtx: getRouterState('local:tools_ctx') || '',
    mercuryMode: getRouterState('mercury:mode') || 'full',
    mercuryModel: getRouterState('mercury:model') || '',
    mercuryCtx: getRouterState('local:mercury_ctx') || '',
    thinking: getRouterState('local:thinking')
      || getRouterState(`thinking:${WEB_DASHBOARD_JID}`)
      || 'true',
  });
}

async function handleSettingsSave(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = parseJson(await parseBody(req)) as Record<string, unknown>;
  const envMap: Record<string, string> = {
    assistantName: 'ASSISTANT_NAME',
    localAssistantName: 'LOCAL_ASSISTANT_NAME',
    timezone: 'TZ',
    containerImage: 'CONTAINER_IMAGE',
    containerTimeout: 'CONTAINER_TIMEOUT',
    idleTimeout: 'IDLE_TIMEOUT',
    maxConcurrentContainers: 'MAX_CONCURRENT_CONTAINERS',
    ollamaUrl: 'OLLAMA_URL',
    ollamaModel: 'OLLAMA_MODEL',
    ollamaChatModel: 'OLLAMA_CHAT_MODEL',
    defaultModelMode: 'DEFAULT_MODEL_MODE',
    calendarToken: 'CALENDAR_TOKEN',
    google_client_id: 'GOOGLE_CLIENT_ID',
    google_client_secret: 'GOOGLE_CLIENT_SECRET',
    microsoft_client_id: 'MICROSOFT_CLIENT_ID',
    microsoft_client_secret: 'MICROSOFT_CLIENT_SECRET',
  };

  // Router-state settings (not env vars)
  if (body.globalDefaultModel !== undefined) {
    setRouterState('orchestrator:model', String(body.globalDefaultModel));
  }
  if (body.hybridPrivacy !== undefined) {
    setRouterState('hybrid_privacy', String(body.hybridPrivacy));
  }
  if (body.localPrivateModel !== undefined) {
    setRouterState('local:private_model', String(body.localPrivateModel));
  }
  if (body.atlasModel !== undefined) {
    setRouterState('atlas:model', String(body.atlasModel));
  }
  if (body.councilSkepticModel !== undefined) {
    setRouterState('council:skeptic_model', String(body.councilSkepticModel));
  }
  if (body.councilPragmatistModel !== undefined) {
    setRouterState('council:pragmatist_model', String(body.councilPragmatistModel));
  }
  if (body.councilSynthesistModel !== undefined) {
    setRouterState('council:synthesist_model', String(body.councilSynthesistModel));
  }
  // Mirror toolcall model into router_state and live env so subprocess inherits it.
  if (body.ollamaChatModel !== undefined) {
    const mdl = String(body.ollamaChatModel);
    setRouterState('local:subagent_model', mdl);
    if (mdl) process.env.SUBAGENT_MODEL = mdl;
  }
  // Per-agent num_ctx overrides — stored in router_state, read by src/index.ts
  // and passed to the agent-runner via env (ORCHESTRATOR_NUM_CTX, etc.).
  // Empty string clears the override (agent-runner treats falsy as "use default").
  if (body.orchestratorCtx !== undefined) {
    setRouterState('local:orchestrator_ctx', String(body.orchestratorCtx || ''));
  }
  if (body.subagentCtx !== undefined) {
    setRouterState('local:subagent_ctx', String(body.subagentCtx || ''));
  }
  if (body.atlasCtx !== undefined) {
    setRouterState('local:atlas_ctx', String(body.atlasCtx || ''));
  }
  if (body.toolsCtx !== undefined) {
    setRouterState('local:tools_ctx', String(body.toolsCtx || ''));
  }
  if (body.mercuryMode !== undefined) {
    setRouterState('mercury:mode', String(body.mercuryMode || 'full'));
  }
  if (body.mercuryModel !== undefined) {
    setRouterState('mercury:model', String(body.mercuryModel || ''));
  }
  if (body.mercuryCtx !== undefined) {
    setRouterState('local:mercury_ctx', String(body.mercuryCtx || ''));
  }
  // Thinking default — stored globally and mirrored to owner JID so the
  // orchestrator picks it up on the next turn without requiring a restart.
  if (body.thinking !== undefined) {
    const t = String(body.thinking);
    const normalized = t === 'max' ? 'max' : t === 'false' || t === '0' ? '0' : 'true';
    setRouterState('local:thinking', normalized);
    setRouterState(`thinking:${WEB_DASHBOARD_JID}`, normalized);
  }

  // Track whether any router-state settings were saved
  const hadRouterState = body.globalDefaultModel !== undefined ||
    body.hybridPrivacy !== undefined || body.localPrivateModel !== undefined ||
    body.councilSkepticModel !== undefined || body.councilPragmatistModel !== undefined || body.councilSynthesistModel !== undefined ||
    body.mercuryMode !== undefined || body.mercuryModel !== undefined || body.mercuryCtx !== undefined || body.thinking !== undefined;

  const vars: Record<string, string> = {};
  for (const [key, envKey] of Object.entries(envMap)) {
    if (body[key] !== undefined && body[key] !== null) {
      vars[envKey] = String(body[key]);
    }
  }

  if (Object.keys(vars).length === 0 && !hadRouterState) return error(res, 'No settings provided');

  if (Object.keys(vars).length > 0) {
    const { writeEnvVars } = await import('./env.js');
    writeEnvVars(vars);
  }

  // Update process.env so changes take effect immediately without restart
  for (const [envKey, val] of Object.entries(vars)) {
    process.env[envKey] = val;
  }

  // If assistant name changed, update all group WARDEN.md files and trigger patterns
  const newName = vars.ASSISTANT_NAME;
  if (newName && newName !== ASSISTANT_NAME) {
    const oldName = ASSISTANT_NAME;
    // Update WARDEN.md files in all group folders
    try {
      const groupDirs = fs.readdirSync(GROUPS_DIR, { withFileTypes: true });
      for (const d of groupDirs) {
        if (!d.isDirectory()) continue;
        const claudePath = path.join(GROUPS_DIR, d.name, 'WARDEN.md');
        if (!fs.existsSync(claudePath)) continue;
        let content = fs.readFileSync(claudePath, 'utf-8');
        const updated = content
          .replace(new RegExp(`# ${oldName}\\b`, 'g'), `# ${newName}`)
          .replace(new RegExp(`You are ${oldName}\\b`, 'g'), `You are ${newName}`)
          .replace(new RegExp(`@${oldName}\\b`, 'gi'), `@${newName}`)
          .replace(new RegExp(`\\*\\*Name:\\*\\* ${oldName}\\b`, 'g'), `**Name:** ${newName}`);
        if (updated !== content) {
          fs.writeFileSync(claudePath, updated);
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to update WARDEN.md files with new assistant name');
    }

    // Update trigger patterns in registered_groups — multi-user layer removed;
    // triggers are gone. Skip.
  }

  return json(res, { ok: true, restart: true });
}

function readFtpConfig(folder: string): any | null {
  const p = path.join(GROUPS_DIR, folder, 'ftp-config.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeFtpConfig(folder: string, config: any): void {
  const p = path.join(GROUPS_DIR, folder, 'ftp-config.json');
  fs.writeFileSync(p, JSON.stringify(config, null, 2));
}

function readPushManifest(folder: string): Record<string, string> {
  const p = path.join(GROUPS_DIR, folder, '.last-push.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

const SKIP_FILES = new Set(['WARDEN.md', 'MEMORY.md', 'TODO.md', 'NOTES.md', 'JOURNAL.md', 'HEARTBEAT.md', 'config.json', 'topics.json', 'ftp-config.json', '.last-push.json']);
const SKIP_DIRS = new Set(['logs', '.claude']);

function buildFileManifest(rootDir: string): Record<string, string> {
  const manifest: Record<string, string> = {};
  function scan(dir: string, prefix: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.htaccess') continue;
      const full = path.join(dir, entry.name);
      const rel = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        scan(full, rel);
      } else {
        if (SKIP_FILES.has(entry.name)) continue;
        const hash = crypto.createHash('md5').update(fs.readFileSync(full)).digest('hex');
        manifest[rel] = hash;
      }
    }
  }
  scan(rootDir, '');
  return manifest;
}

function writePushManifest(folder: string, manifest: Record<string, string>): void {
  const p = path.join(GROUPS_DIR, folder, '.last-push.json');
  fs.writeFileSync(p, JSON.stringify(manifest));
}

// handleWebDev + userCanAccessFolder removed — never dispatched, depended on
// the removed multi-user layer.

const OLLAMA_THINKING_PATH = path.join(
  process.cwd(),
  'data',
  'config',
  'ollama-thinking.json',
);

function readOllamaThinking(): Record<string, boolean> {
  try {
    const raw = fs.readFileSync(OLLAMA_THINKING_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(parsed)) {
        out[k] = !!v;
      }
      return out;
    }
  } catch {}
  return {};
}

function writeOllamaThinking(thinking: Record<string, boolean>): void {
  const dir = path.dirname(OLLAMA_THINKING_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(OLLAMA_THINKING_PATH, JSON.stringify(thinking, null, 2));
}

const OLLAMA_FRIENDLY_NAMES_PATH = path.join(
  process.cwd(),
  'data',
  'config',
  'ollama-model-names.json',
);

function readOllamaFriendlyNames(): Record<string, string> {
  try {
    const raw = fs.readFileSync(OLLAMA_FRIENDLY_NAMES_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string' && v.trim()) out[k] = v.trim();
      }
      return out;
    }
  } catch {}
  return {};
}

function writeOllamaFriendlyNames(names: Record<string, string>): void {
  const dir = path.dirname(OLLAMA_FRIENDLY_NAMES_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(names)) {
    if (typeof k === 'string' && typeof v === 'string' && v.trim()) {
      clean[k] = v.trim();
    }
  }
  fs.writeFileSync(OLLAMA_FRIENDLY_NAMES_PATH, JSON.stringify(clean, null, 2));
}

async function handleOllamaTest(res: http.ServerResponse): Promise<void> {
  const { readEnvFile } = await import('./env.js');
  const envVars = readEnvFile(['OLLAMA_URL', 'OLLAMA_MODEL']);
  const ollamaUrl = process.env.OLLAMA_URL || envVars.OLLAMA_URL || 'http://127.0.0.1:11434';
  const ollamaModel = process.env.OLLAMA_MODEL || envVars.OLLAMA_MODEL || 'granite4:latest';
  const friendlyNames = readOllamaFriendlyNames();
  try {
    const resp = await fetch(`${ollamaUrl}/api/tags`);
    if (!resp.ok) {
      json(res, { ok: false, error: 'Ollama responded with ' + resp.status, friendlyNames });
      return;
    }
    const data = (await resp.json()) as { models?: Array<{ name: string }> };
    const models = (data.models || []).map((m: { name: string }) => m.name);
    const hasModel = models.some(
      (n: string) =>
        n === ollamaModel || n.startsWith(ollamaModel.split(':')[0]),
    );
    const thinkingConfig = readOllamaThinking();
    json(res, { ok: true, model: ollamaModel, available: hasModel, models, friendlyNames, cloudModels: CLOUD_MODELS, thinking: thinkingConfig });
  } catch {
    const thinkingConfig = readOllamaThinking();
    json(res, { ok: false, error: 'Cannot reach Ollama at ' + ollamaUrl, friendlyNames, cloudModels: CLOUD_MODELS, thinking: thinkingConfig });
  }
}

async function handleOllamaModelNames(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method === 'GET') {
    json(res, { names: readOllamaFriendlyNames() });
    return;
  }
  if (req.method === 'POST') {
    const body = parseJson(await parseBody(req)) as { names?: Record<string, string> };
    if (!body || typeof body.names !== 'object' || body.names === null) {
      return error(res, 'names object required');
    }
    try {
      writeOllamaFriendlyNames(body.names);
      json(res, { ok: true });
    } catch (e) {
      logger.error({ err: e }, 'Failed to write ollama friendly names');
      error(res, 'Failed to save', 500);
    }
    return;
  }
  error(res, 'Method not allowed', 405);
}

async function handleOllamaToggle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = parseJson(await parseBody(req)) as Record<string, unknown>;
  const enabled = body.enabled === true;
  setRouterState('ollama_enabled', enabled ? 'true' : 'false');
  json(res, { ok: true, enabled });
}

async function handleAutomationModel(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method === 'GET') {
    const model = getRouterState('automation:model') || '';
    return json(res, { model });
  }
  if (req.method === 'POST') {
    const body = parseJson(await parseBody(req)) as Record<string, unknown>;
    const model = String(body.model || '');
    setRouterState('automation:model', model);
    return json(res, { ok: true, model });
  }
  return error(res, 'Method not allowed', 405);
}

// getUserGroupScope removed — depended on the removed multi-user layer.

// handleGroups removed — /api/groups/* is 410-gated at the routing layer.

function handleTasks(res: http.ServerResponse): void {
  json(res, { tasks: deps.getAllTasks() });
}

// --- V2 helpers ---

function searchFiles(
  dir: string,
  query: string,
  results: Array<{ name: string; path: string; type: string }>,
  limit: number,
): void {
  if (results.length >= limit) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (results.length >= limit) return;
    if (entry.isDirectory()) {
      searchFiles(path.join(dir, entry.name), query, results, limit);
    } else if (entry.name.toLowerCase().includes(query.toLowerCase())) {
      const rel = path.relative(GROUPS_DIR, path.join(dir, entry.name));
      results.push({
        name: entry.name,
        path: rel,
        type: path.extname(entry.name).slice(1) || 'file',
      });
    }
  }
}

function searchVaultEntries(
  query: string,
  limit: number,
): Array<{ id: string; originalName: string; originalPath: string }> {
  const index = loadVaultIndex();
  const lq = query.toLowerCase();
  return index
    .filter(
      (e: any) =>
        e.originalName?.toLowerCase().includes(lq) ||
        e.originalPath?.toLowerCase().includes(lq),
    )
    .slice(0, limit);
}

// --- V2 API handlers ---

async function handleSearch(
  res: http.ServerResponse,
  params: URLSearchParams,
): Promise<void> {
  const q = params.get('q');
  if (!q) return error(res, 'Missing query parameter "q"');

  const messages = searchMessages(q, 'web:dashboard', 10).map((m) => ({
    id: m.id,
    content_snippet: m.content.slice(0, 200),
    chat_jid: m.chat_jid,
    timestamp: m.timestamp,
  }));
  const files: Array<{ name: string; path: string; type: string }> = [];
  searchFiles(GROUPS_DIR, q, files, 10);
  const vault = searchVaultEntries(q, 10);
  const tasks = searchTasks(q, 10).map((t) => ({
    id: t.id,
    prompt_snippet: t.prompt.slice(0, 200),
    status: t.status,
  }));
  json(res, { messages, files, vault, tasks });
}

function handleActivity(
  res: http.ServerResponse,
  params: URLSearchParams,
): void {
  const limit = Math.min(
    Math.max(1, parseInt(params.get('limit') || '20', 10)),
    100,
  );
  const items: Array<{
    type: string;
    title: string;
    detail: string;
    timestamp: string;
    group?: string;
  }> = [];

  const groups = deps.registeredGroups();
  const jidToFolder = new Map<string, string>();
  for (const [jid, g] of Object.entries(groups)) jidToFolder.set(jid, g.folder);

  for (const msg of getRecentMessages(limit)) {
    items.push({
      type: 'message',
      title: msg.sender_name || 'Unknown',
      detail: msg.content.slice(0, 200),
      timestamp: msg.timestamp,
      group: jidToFolder.get(msg.chat_jid),
    });
  }

  const allTasks = deps.getAllTasks();
  for (const task of allTasks.slice(0, limit)) {
    if (task.last_run) {
      items.push({
        type: 'task',
        title: `Task: ${task.prompt.slice(0, 60)}`,
        detail: `Status: ${task.status}`,
        timestamp: task.last_run,
        group: task.group_folder,
      });
    }
  }

  items.sort((a, b) => (b.timestamp > a.timestamp ? 1 : -1));
  json(res, { items: items.slice(0, limit) });
}

function handleNotifications(
  res: http.ServerResponse,
  params: URLSearchParams,
): void {
  const since = params.get('since') || '1970-01-01T00:00:00.000Z';
  const botMessages = getBotMessagesSince('web:dashboard', since, 50);
  json(res, {
    count: botMessages.length,
    items: botMessages.map((m) => ({
      id: m.id,
      preview: m.content.slice(0, 200),
      timestamp: m.timestamp,
    })),
  });
}

// Single broadcast SSE — replaces per-user /api/users/:id/notifications.
// All connected dashboard clients receive every notification (single-user system).
function handleNotificationsSse(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('data: {"type":"connected"}\n\n');
  const bucket = '__broadcast__';
  drainNotifQueue(bucket);
  if (!sseClients.has(bucket)) sseClients.set(bucket, []);
  sseClients.get(bucket)!.push(res);
  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { clearInterval(keepalive); }
  }, 30000);
  req.on('close', () => {
    clearInterval(keepalive);
    const clients = sseClients.get(bucket) || [];
    const filtered = clients.filter((c) => c !== res);
    if (filtered.length > 0) sseClients.set(bucket, filtered);
    else sseClients.delete(bucket);
  });
}

function handleHealth(res: http.ServerResponse): void {
  const mem = process.memoryUsage();
  json(res, {
    status: 'ok',
    uptime: Math.floor((Date.now() - deps.startedAt) / 1000),
    memory: {
      used: `${Math.round(mem.rss / 1024 / 1024)}MB`,
      total: `${Math.round(os.totalmem() / 1024 / 1024)}MB`,
    },
    containers: {
      active: 0,
      max: 1,
    },
    database: 'ok',
  });
}

function handleSkills(res: http.ServerResponse): void {
  const installed: Record<string, boolean> = {};
  // Channel detection
  const channelsDir = path.resolve(process.cwd(), 'src', 'channels');
  installed['add-telegram'] = fs.existsSync(
    path.join(channelsDir, 'telegram.ts'),
  );
  installed['add-slack'] = fs.existsSync(path.join(channelsDir, 'slack.ts'));
  installed['add-discord'] = fs.existsSync(
    path.join(channelsDir, 'discord.ts'),
  );
  installed['add-gmail'] =
    fs.existsSync(path.resolve(process.cwd(), 'src', 'gmail.ts')) ||
    fs.existsSync(path.resolve(process.cwd(), 'src', 'channels', 'gmail.ts'));
  installed['x-integration'] = fs.existsSync(
    path.resolve(process.cwd(), 'src', 'x-integration.ts'),
  );
  // Feature detection
  installed['add-pdf-reader'] = fs.existsSync(
    path.resolve(
      process.cwd(),
      'container',
      'skills',
      'pdf-reader',
      'SKILL.md',
    ),
  );
  installed['add-image-vision'] = fs.existsSync(
    path.resolve(process.cwd(), 'src', 'image.ts'),
  );
  installed['add-ollama-tool'] = fs.existsSync(
    path.resolve(process.cwd(), 'container', 'skills', 'ollama', 'SKILL.md'),
  );
  installed['add-compact'] = fs.existsSync(
    path.resolve(process.cwd(), 'container', 'skills', 'compact', 'SKILL.md'),
  );
  installed['add-parallel'] = fs.existsSync(
    path.resolve(process.cwd(), 'src', 'parallel.ts'),
  );
  installed['convert-to-apple-container'] = (() => {
    try {
      const rt = fs.readFileSync(
        path.resolve(process.cwd(), 'src', 'container-runtime.ts'),
        'utf8',
      );
      return rt.includes("'container'");
    } catch {
      return false;
    }
  })();
  // Container skill detection
  const skillsDir = path.resolve(process.cwd(), 'data', 'skills');
  installed['scrub'] = fs.existsSync(path.join(skillsDir, 'scrub', 'SKILL.md'));
  installed['agent-browser'] = fs.existsSync(
    path.join(skillsDir, 'agent-browser', 'SKILL.md'),
  );
  // Real user skills from data/skills — the set the agent actually loads.
  // enabled=false when frontmatter carries `disabled: true` (PATCH toggle).
  const user: Record<string, { enabled: boolean }> = {};
  try {
    for (const e of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(skillsDir, e.name, 'SKILL.md');
      if (!fs.existsSync(p)) continue;
      let enabled = true;
      try {
        const fm = fs.readFileSync(p, 'utf8').split(/^---\s*$/m)[1] ?? '';
        enabled = !/^disabled:\s*true\s*$/m.test(fm);
      } catch { /* unreadable — show as enabled */ }
      user[e.name] = { enabled };
    }
  } catch { /* skills dir missing */ }
  json(res, { installed, user });
}

async function handleTasksCrud(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<void> {
  // POST /api/tasks — create
  if (req.method === 'POST' && pathname === '/api/tasks') {
    const body = parseJson(await parseBody(req)) as any;
    if (!body.prompt || !body.schedule_type || !body.schedule_value) {
      return error(res, 'Missing required fields');
    }
    const VALID_SCHEDULE_TYPES = ['cron', 'interval', 'once'] as const;
    if (!VALID_SCHEDULE_TYPES.includes(body.schedule_type)) {
      return error(res, `Invalid schedule_type: must be cron, interval, or once`);
    }
    const scheduleType = body.schedule_type as 'cron' | 'interval' | 'once';
    let nextRun: string | null = null;
    if (scheduleType === 'cron') {
      try {
        nextRun = CronExpressionParser.parse(body.schedule_value, {
          tz: TIMEZONE,
        })
          .next()
          .toISOString();
      } catch {
        return error(res, 'Invalid cron expression');
      }
    } else if (scheduleType === 'interval') {
      const ms = parseInt(body.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) return error(res, 'Invalid interval');
      nextRun = new Date(Date.now() + ms).toISOString();
    } else if (scheduleType === 'once') {
      const d = new Date(body.schedule_value);
      if (isNaN(d.getTime())) return error(res, 'Invalid timestamp');
      nextRun = d.toISOString();
    }
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    createTask({
      id: taskId,
      chat_jid: body.chat_jid || 'web:dashboard',
      prompt: body.prompt,
      schedule_type: scheduleType,
      schedule_value: body.schedule_value,
      context_mode: body.context_mode || 'isolated',
      next_run: nextRun,
      status: 'active',
      created_at: new Date().toISOString(),
    });
    return json(res, { id: taskId, status: 'created' }, 201);
  }

  // PATCH /api/tasks/:id — update status
  const patchMatch = pathname.match(/^\/api\/tasks\/(.+)$/);
  if (req.method === 'PATCH' && patchMatch) {
    const task = getTaskById(patchMatch[1]);
    if (!task) return error(res, 'Task not found', 404);
    const body = parseJson(await parseBody(req)) as any;
    if (body.status && ['active', 'paused'].includes(body.status)) {
      updateTask(patchMatch[1], { status: body.status });
    }
    return json(res, { id: patchMatch[1], status: body.status });
  }

  // DELETE /api/tasks/bulk — delete active / inactive / all
  if (req.method === 'DELETE' && pathname === '/api/tasks/bulk') {
    const body = parseJson(await parseBody(req)) as any;
    const filter = body.filter;
    if (!['active', 'inactive', 'all'].includes(filter)) {
      return error(res, "filter must be 'active', 'inactive', or 'all'");
    }
    const tasks = getAllTasks();
    const toDelete = tasks.filter((t) =>
      filter === 'all' ? true : filter === 'active' ? t.status !== 'paused' : t.status === 'paused',
    );
    for (const t of toDelete) deleteTask(t.id);
    return json(res, { deleted: toDelete.length });
  }

  // DELETE /api/tasks/:id
  const deleteMatch = pathname.match(/^\/api\/tasks\/(.+)$/);
  if (req.method === 'DELETE' && deleteMatch) {
    const task = getTaskById(deleteMatch[1]);
    if (!task) return error(res, 'Task not found', 404);
    deleteTask(deleteMatch[1]);
    return json(res, { id: deleteMatch[1], status: 'deleted' });
  }

  return error(res, 'Not found', 404);
}

// --- Vault handlers ---

async function handleVault(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<void> {
  // User-scoped folder filter (set by user session handler)
  const userFolders: Set<string> | null = (req as any)._userFolders || null;
  function isAllowedPath(filePath: string): boolean {
    if (!userFolders) return true; // admin — no restriction
    const rel = path.relative(GROUPS_DIR, filePath);
    const topLevel = rel.split(path.sep)[0];
    return userFolders.has(topLevel);
  }
  // POST /api/vault/scrub — scrub selected files
  if (req.method === 'POST' && pathname === '/api/vault/scrub') {
    const body = parseJson(await parseBody(req)) as {
      paths?: string[];
      useOllama?: boolean;
    };
    if (!body.paths || !Array.isArray(body.paths) || body.paths.length === 0) {
      return error(res, 'paths array required');
    }

    const results: Array<{ path: string; entry?: any; error?: string; warnings?: string[]; ollamaUsed?: boolean }> = [];
    for (const relPath of body.paths) {
      const full = safePath(relPath);
      if (!full) {
        results.push({ path: relPath, error: 'Invalid path' });
        continue;
      }
      if (!isAllowedPath(full)) {
        results.push({ path: relPath, error: 'Access denied' });
        continue;
      }
      if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
        results.push({ path: relPath, error: 'Not a file' });
        continue;
      }
      // Skip files larger than 20MB
      if (fs.statSync(full).size > 20 * 1024 * 1024) {
        results.push({ path: relPath, error: 'File too large (>20MB)' });
        continue;
      }
      try {
        const { entry, warnings, ollamaUsed } = await scrubFile(full, body.useOllama !== false);
        results.push({ path: relPath, entry, warnings, ollamaUsed });
      } catch (e: any) {
        results.push({ path: relPath, error: e.message });
      }
    }
    return json(res, { results });
  }

  // POST /api/vault/dictionary — update dictionary
  if (req.method === 'POST' && pathname === '/api/vault/dictionary') {
    const body = parseJson(await parseBody(req)) as Record<string, string[]>;
    saveDictionary(body as any);
    return json(res, { ok: true });
  }

  // GET /api/vault/dictionary
  if (req.method === 'GET' && pathname === '/api/vault/dictionary') {
    return json(res, loadDictionary());
  }

  // GET /api/vault — list entries (scoped to user's folders if applicable)
  if (req.method === 'GET' && pathname === '/api/vault') {
    const entries = loadVaultIndex().filter((e: any) => isAllowedPath(e.originalPath || ''));
    return json(res, { entries });
  }

  // Routes with ID: /api/vault/{id}/...
  const idMatch = pathname.match(
    /^\/api\/vault\/([^/]+)\/(scrubbed|mapping|recombine)$/,
  );
  if (idMatch) {
    const [, id, action] = idMatch;

    const entry = getVaultEntry(id);
    if (entry && !isAllowedPath(entry.originalPath || '')) return error(res, 'Access denied', 403);
    if (!entry) return error(res, 'Vault entry not found', 404);

    if (req.method === 'GET' && action === 'scrubbed') {
      const content = readScrubbed(id);
      if (!content) return error(res, 'Scrubbed file not found', 404);
      return json(res, { content, entry });
    }

    if (req.method === 'GET' && action === 'mapping') {
      const mapping = readMapping(id);
      if (!mapping) return error(res, 'Mapping not found', 404);
      return json(res, { mapping, entry });
    }

    if (req.method === 'POST' && action === 'recombine') {
      const scrubbed = readScrubbed(id);
      const mapping = readMapping(id);
      if (!scrubbed || !mapping) return error(res, 'Missing vault data', 404);
      const recombined = unscrub(scrubbed, mapping);

      const ext = path.extname(entry.originalName).toLowerCase();
      const isBinary = ext === '.docx' || ext === '.pdf';

      if (isBinary && entry.originalPath && fs.existsSync(path.dirname(entry.originalPath))) {
        // Restore original binary from vault
        const vaultBinary = path.join(SCRUBBED_DIR, `${id}${ext}`);
        if (fs.existsSync(vaultBinary)) {
          fs.copyFileSync(vaultBinary, entry.originalPath);
        }
        // Remove the scrubbed .md
        const mdPath = entry.originalPath.replace(/\.[^.]+$/, '.md');
        if (fs.existsSync(mdPath)) fs.unlinkSync(mdPath);
      } else if (entry.originalPath && fs.existsSync(path.dirname(entry.originalPath))) {
        fs.writeFileSync(entry.originalPath, recombined);
      }

      updateVaultEntryStatus(id, 'recombined');
      return json(res, {
        content: recombined,
        entry: { ...entry, status: 'recombined' },
      });
    }
  }

  // DELETE /api/vault/{id}
  const deleteMatch = pathname.match(/^\/api\/vault\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteMatch) {
    const ok = deleteVaultEntry(deleteMatch[1]);
    if (!ok) return error(res, 'Entry not found', 404);
    return json(res, { ok: true });
  }

  return error(res, 'Not found', 404);
}

// handleWorkTasks removed — /api/work-tasks is 410-gated at the routing layer.

// handleUsers removed — /api/users/* and /api/companies/* are 410-gated.

// --- Session Links (removed; /api/session-links is 410-gated) ---

// handleSessionLinks removed.

// --- Container Management ---

async function handleAgentKill(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  await parseBody(req); // drain body (POST may carry a JSON blob)
  try {
    const killed = killCurrentAgent();
    logger.info({ killed }, 'Agent kill requested via dashboard');
    return json(res, { ok: true, killed });
  } catch (err: any) {
    logger.warn({ err }, 'Failed to kill agent');
    return json(res, { ok: false, killed: false, error: err.message });
  }
}

async function handleChatStop(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  scopeUserId?: string,
): Promise<void> {
  const body = parseJson(await parseBody(req)) as any;
  const jid = body.jid;
  if (!jid || typeof jid !== 'string') {
    return error(res, 'jid required');
  }
  // Multi-user scope check removed; single-user Warden has no per-user gates.
  void scopeUserId;
  // For the single-user backend, also kill the in-process agent directly.
  const killed = killCurrentAgent();
  if (body.soft) {
    // Soft stop: queue is a stub now; no-op.
    deps.queue.closeStdin(jid);
    logger.info({ jid }, 'Chat processing soft-stopped (queue is a stub)');
  } else {
    const stopped = deps.queue.stopGroup(jid);
    if (stopped) {
      logger.info({ jid }, 'Chat processing stopped by user');
    }
  }
  // Always clear the stale processing flag so dashboards stop showing "thinking".
  setRouterState('agent:processing', 'false');
  // Advance the message cursor so the stopped request is not retried.
  if (body.advance_cursor) {
    try {
      const since = getRouterState('last_agent_timestamp') || '';
      const pending = getMessagesSince(jid, since, ASSISTANT_NAME, 500);
      if (pending.length > 0) {
        const latest = pending[pending.length - 1]!.timestamp;
        setRouterState('last_agent_timestamp', latest);
        logger.info({ jid, latest }, 'Cursor advanced on user stop');
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to advance cursor on stop');
    }
  }
  return json(res, { ok: true, killed });
}


// Rate limiter for authentication-sensitive endpoints (login, signup, password reset)
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const signupAttempts = new Map<string, { count: number; resetAt: number }>();
const resetAttempts = new Map<string, { count: number; resetAt: number }>();
const LOGIN_RATE_LIMIT = 10;
const LOGIN_RATE_WINDOW = 60 * 1000; // 10 attempts per minute per IP
const SIGNUP_RATE_LIMIT = 3;
const SIGNUP_RATE_WINDOW = 60 * 60 * 1000; // 1 hour
const RESET_RATE_LIMIT = 5;
const RESET_RATE_WINDOW = 60 * 1000; // 5 attempts per minute per IP

// Real client IP: the server sits behind a Cloudflare tunnel, so the socket
// address is always the local tunnel endpoint. Prefer CF-Connecting-IP, then
// the first X-Forwarded-For hop, then the socket address (direct LAN access).
function getClientIp(req: http.IncomingMessage): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// --- Voice ---

async function handleVoice(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await parseBody(req);
  if (!body || body.length === 0) return error(res, 'No audio data');

  // Extract jid and sender_name from query string
  const { params } = parseUrl(req.url || '/');
  const jid = params.get('jid');
  if (!jid) return error(res, 'jid required');
  const senderName = params.get('sender_name') || 'Admin';

  try {
    const transcript = await transcribeLocal(body);
    if (!transcript) return error(res, 'Transcription failed', 500);

    // Store as a regular message and trigger the agent
    const msg: NewMessage = {
      id: `voice-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      chat_jid: jid,
      sender: 'dashboard',
      sender_name: senderName,
      content: transcript,
      timestamp: new Date().toISOString(),
      is_from_me: true,
      is_bot_message: false,
      idea: getRouterState(`idea:${jid}`) || '',
    };
    deps.storeMessage(msg);

    // Relay to actual channel if not web-only
    if (!jid.startsWith('web:')) {
      deps.sendChannelMessage(jid, transcript).catch((err: any) => {
        logger.warn({ err, jid }, 'Failed to relay voice message to channel');
      });
    }

    return json(res, { ok: true, transcript, id: msg.id });
  } catch (err: any) {
    logger.error({ err }, 'Voice transcription error');
    return error(res, 'Transcription error', 500);
  }
}

// --- Server ---

export function startStatusServer(d: StatusDeps): void {
  deps = d;
  startInboxCacheWarmer();

  // --- Email ---

  async function handleEmail(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    params: URLSearchParams,
    scopeUserId?: string,
  ): Promise<void> {
    // GET /api/email/accounts - list accounts
    if (req.method === 'GET' && pathname === '/api/email/accounts') {
      const userId = scopeUserId ?? (params.get('userId') || undefined);
      const accounts = getEmailAccounts(userId || null);
      const safe = accounts.map((a) => ({ ...a, password: '***' }));
      return json(res, { accounts: safe });
    }

    // POST /api/email/accounts - create account
    if (req.method === 'POST' && pathname === '/api/email/accounts') {
      const buf = await parseBody(req);
      const data = parseJson(buf) as any;
      if (!data.name || !data.email || !data.imap_host || !data.smtp_host || !data.username || !data.password) {
        return error(res, 'Missing required fields: name, email, imap_host, smtp_host, username, password');
      }
      const account = createEmailAccount({
        name: data.name,
        email: data.email,
        imap_host: data.imap_host,
        imap_port: data.imap_port,
        smtp_host: data.smtp_host,
        smtp_port: data.smtp_port,
        username: data.username,
        password: data.password,
        use_tls: data.use_tls,
        read_only: data.read_only !== false,
        enabled: data.enabled,
        user_id: scopeUserId ?? (data.user_id || null),
      });
      return json(res, { ok: true, account: { ...account, password: '***' } }, 201);
    }

    // PUT /api/email/accounts/:id - update account
    const accountMatch = pathname.match(/^\/api\/email\/accounts\/([^/]+)$/);
    // Ownership gate for mutations: a scoped user may only touch their own accounts.
    // 404 (not 403) so account IDs of other tenants are not disclosed.
    if (accountMatch && scopeUserId && (req.method === 'PUT' || req.method === 'DELETE')) {
      const existing = getEmailAccount(decodeURIComponent(accountMatch[1]));
      if (!existing || existing.user_id !== scopeUserId) return error(res, 'Account not found', 404);
    }
    if (req.method === 'PUT' && accountMatch) {
      const id = decodeURIComponent(accountMatch[1]);
      const buf = await parseBody(req);
      const data = parseJson(buf) as any;
      const updates: any = {};
      if (data.name !== undefined) updates.name = data.name;
      if (data.email !== undefined) updates.email = data.email;
      if (data.imap_host !== undefined) updates.imap_host = data.imap_host;
      if (data.imap_port !== undefined) updates.imap_port = data.imap_port;
      if (data.smtp_host !== undefined) updates.smtp_host = data.smtp_host;
      if (data.smtp_port !== undefined) updates.smtp_port = data.smtp_port;
      if (data.username !== undefined) updates.username = data.username;
      if (data.password !== undefined) updates.password = data.password;
      if (data.use_tls !== undefined) updates.use_tls = data.use_tls ? 1 : 0;
      if (data.read_only !== undefined) updates.read_only = data.read_only ? 1 : 0;
      if (data.enabled !== undefined) updates.enabled = data.enabled ? 1 : 0;
      // Scoped users cannot reassign account ownership
      if (data.user_id !== undefined && !scopeUserId) updates.user_id = data.user_id;

      const updated = updateEmailAccount(id, updates);
      if (!updated) return error(res, 'Account not found', 404);
      return json(res, { ok: true, account: { ...updated, password: '***' } });
    }

    // DELETE /api/email/accounts/:id - delete account
    if (req.method === 'DELETE' && accountMatch) {
      const id = decodeURIComponent(accountMatch[1]);
      const deleted = deleteEmailAccount(id);
      if (!deleted) return error(res, 'Account not found', 404);
      return json(res, { ok: true });
    }

    // GET /api/email/inbox - fetch emails
    if (req.method === 'GET' && pathname === '/api/email/inbox') {
      const accountId = params.get('accountId');
      if (!accountId) return error(res, 'accountId required');
      const folder = params.get('folder') || 'INBOX';
      const limit = parseInt(params.get('limit') || '20', 10);
      const offset = parseInt(params.get('offset') || '0', 10);
      const fresh = params.get('fresh') === '1';
      // Serve from the 5-minute cache unless the caller forces fresh (the
      // dashboard Refresh button). IMAP fetches take seconds; the cache makes
      // tab switches instant and a background timer keeps it warm.
      const cacheKey = `${accountId}:${folder}`;
      const cached = inboxCache.get(cacheKey);
      if (!fresh && cached && Date.now() - cached.fetchedAt < INBOX_CACHE_TTL_MS && cached.emails.length >= limit + offset) {
        const emails = cached.emails.slice(offset, offset + limit);
        return json(res, { emails, cachedAt: new Date(cached.fetchedAt).toISOString() });
      }
      try {
        const allEmails = await fetchEmails(accountId, folder, Math.max(limit + offset, 20));
        inboxCache.set(cacheKey, { emails: allEmails, fetchedAt: Date.now() });
        const emails = allEmails.slice(offset, offset + limit);
        return json(res, { emails });
      } catch (err: any) {
        // IMAP hiccup: fall back to stale cache rather than erroring the tab.
        if (cached) {
          return json(res, { emails: cached.emails.slice(offset, offset + limit), cachedAt: new Date(cached.fetchedAt).toISOString(), stale: true });
        }
        return error(res, err.message, 500);
      }
    }

    // GET /api/email/message - fetch single email by ID
    if (req.method === 'GET' && pathname === '/api/email/message') {
      const accountId = params.get('accountId');
      const emailId = params.get('emailId');
      if (!accountId) return error(res, 'accountId required');
      if (!emailId) return error(res, 'emailId required');
      try {
        const { getEmailById } = await import('./email.js');
        const email = await getEmailById(accountId, emailId);
        if (!email) return error(res, 'Email not found', 404);
        return json(res, { email });
      } catch (err: any) {
        return error(res, err.message, 500);
      }
    }

    // POST /api/email/send - send email
    if (req.method === 'POST' && pathname === '/api/email/send') {
      const buf = await parseBody(req);
      const data = parseJson(buf) as any;
      if (!data.accountId || !data.to || !data.subject || !data.body) {
        return error(res, 'Missing required fields: accountId, to, subject, body');
      }
      // sendEmail enforces read_only at the lowest level
      const result = await sendEmail(data.accountId, data.to, data.subject, data.body);
      if (!result.success) {
        return json(res, { ok: false, error: result.error }, 403);
      }
      return json(res, { ok: true, messageId: result.messageId });
    }

    // POST /api/email/test - test connection
    if (req.method === 'POST' && pathname === '/api/email/test') {
      const buf = await parseBody(req);
      const data = parseJson(buf) as any;
      if (!data.accountId) return error(res, 'accountId required');
      const result = await testConnection(data.accountId);
      return json(res, result);
    }

    // --- Draft endpoints ---
    // GET /api/email/drafts?accountId= - list drafts for account
    if (req.method === 'GET' && pathname === '/api/email/drafts') {
      const accountId = params.get('accountId');
      if (!accountId) return error(res, 'accountId required');
      const drafts = getEmailDraftsByAccount(accountId);
      return json(res, { drafts });
    }

    // DELETE /api/email/drafts/:id - delete a draft
    const deleteDraftMatch = pathname.match(/^\/api\/email\/drafts\/([^/]+)$/);
    if (req.method === 'DELETE' && deleteDraftMatch) {
      const draftId = decodeURIComponent(deleteDraftMatch[1]);
      const deleted = deleteEmailDraft(draftId);
      return json(res, { ok: deleted });
    }

    return error(res, 'Not found', 404);
  }

  async function handleSms(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    params: URLSearchParams,
    scopeUserId?: string,
  ): Promise<void> {
    // POST /api/sms/webhook/:accountId — Twilio inbound webhook (public, validated
    // via X-Twilio-Signature against the account's auth token)
    const webhookMatch = pathname.match(/^\/api\/sms\/webhook\/([^/]+)$/);
    if (req.method === 'POST' && webhookMatch) {
      const accountId = decodeURIComponent(webhookMatch[1]);
      const account = getSmsAccount(accountId);
      if (!account) return error(res, 'Account not found', 404);
      const raw = await parseBody(req);
      // Twilio posts application/x-www-form-urlencoded; accept JSON for manual/test posts
      const contentType = (req.headers['content-type'] as string | undefined) || '';
      let fields: Record<string, string> = {};
      if (contentType.includes('json')) {
        try { fields = (parseJson(raw) as Record<string, string>) || {}; } catch { fields = {}; }
      } else {
        for (const [k, v] of new URLSearchParams(raw.toString('utf-8'))) fields[k] = v;
      }
      // Validate X-Twilio-Signature: base64(HMAC-SHA1(authToken, fullUrl + sorted key+value pairs)).
      // If the account has no auth token configured, keep accepting (legacy setups) but warn loudly.
      if (account.auth_token) {
        const signature = (req.headers['x-twilio-signature'] as string | undefined) || '';
        const protoHeader = req.headers['x-forwarded-proto'];
        const proto = (typeof protoHeader === 'string' && protoHeader.split(',')[0].trim()) || 'https';
        const host = (req.headers['x-forwarded-host'] as string | undefined) || req.headers.host || '';
        const fullUrl = proto + '://' + host + (req.url || pathname);
        const payload = fullUrl + Object.keys(fields).sort().map((k) => k + fields[k]).join('');
        const expected = crypto.createHmac('sha1', account.auth_token).update(Buffer.from(payload, 'utf-8')).digest();
        let valid = false;
        try {
          const provided = Buffer.from(signature, 'base64');
          valid = provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
        } catch { valid = false; }
        if (!valid) {
          logger.warn({ accountId, url: fullUrl }, 'Rejected SMS webhook: invalid or missing X-Twilio-Signature');
          return error(res, 'Invalid signature', 403);
        }
      } else {
        logger.warn({ accountId }, 'SMS account has no auth token — accepting webhook WITHOUT Twilio signature validation');
      }
      const from = fields.From || fields.from || '';
      const msgBody = fields.Body || fields.body || '';
      const sid = fields.MessageSid || fields.messageSid || '';
      if (from && msgBody) {
        storeSmsMessage({
          account_id: accountId,
          direction: 'inbound',
          from_number: from,
          to_number: account.phone_number,
          body: msgBody,
          twilio_sid: sid,
          status: 'received',
        });
      }
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end('<Response/>');
      return;
    }

    // GET /api/sms/accounts
    if (req.method === 'GET' && pathname === '/api/sms/accounts') {
      // Scoped user sessions only ever see their own accounts (ignore ?userId)
      const userId = scopeUserId ?? (params.get('userId') || undefined);
      const accounts = getSmsAccounts(userId || null);
      const safe = accounts.map((a) => ({ ...a, auth_token: '***' }));
      return json(res, { accounts: safe });
    }

    // POST /api/sms/accounts
    if (req.method === 'POST' && pathname === '/api/sms/accounts') {
      const body = parseJson(await parseBody(req)) as any;
      if (!body.name || !body.phone_number || !body.account_sid || !body.auth_token) {
        return error(res, 'Missing required fields: name, phone_number, account_sid, auth_token');
      }
      const account = createSmsAccount({
        name: body.name,
        phone_number: body.phone_number,
        account_sid: body.account_sid,
        auth_token: body.auth_token,
        read_only: body.read_only !== false,
        enabled: body.enabled !== false,
        // Scoped user sessions always own the accounts they create
        user_id: scopeUserId ?? (body.user_id || null),
      });
      return json(res, { ok: true, account: { ...account, auth_token: '***' } }, 201);
    }

    // PUT /api/sms/accounts/:id
    const smsAccountMatch = pathname.match(/^\/api\/sms\/accounts\/([^/]+)$/);
    // Ownership gate for mutations: a scoped user may only touch their own accounts.
    // 404 (not 403) so account IDs of other tenants are not disclosed.
    if (smsAccountMatch && scopeUserId && (req.method === 'PUT' || req.method === 'DELETE')) {
      const existing = getSmsAccount(decodeURIComponent(smsAccountMatch[1]));
      if (!existing || existing.user_id !== scopeUserId) return error(res, 'Account not found', 404);
    }
    if (req.method === 'PUT' && smsAccountMatch) {
      const id = decodeURIComponent(smsAccountMatch[1]);
      const body = parseJson(await parseBody(req)) as any;
      const updated = updateSmsAccount(id, body);
      if (!updated) return error(res, 'Account not found', 404);
      const account = getSmsAccount(id);
      return json(res, { ok: true, account: account ? { ...account, auth_token: '***' } : null });
    }

    // DELETE /api/sms/accounts/:id
    if (req.method === 'DELETE' && smsAccountMatch) {
      const id = decodeURIComponent(smsAccountMatch[1]);
      const deleted = deleteSmsAccount(id);
      return json(res, { ok: deleted });
    }

    // GET /api/sms/messages
    if (req.method === 'GET' && pathname === '/api/sms/messages') {
      const accountId = params.get('accountId');
      if (!accountId) return error(res, 'accountId required');
      const limit = parseInt(params.get('limit') || '50', 10);
      const from = params.get('from') || undefined;
      const source = params.get('source') || 'twilio'; // 'twilio' | 'local'
      try {
        if (source === 'local') {
          const messages = getSmsMessages(accountId, limit, from);
          return json(res, { messages });
        }
        const messages = await fetchSmsMessages(accountId, limit, from);
        return json(res, { messages });
      } catch (e: any) {
        return error(res, e.message, 500);
      }
    }

    // POST /api/sms/send
    if (req.method === 'POST' && pathname === '/api/sms/send') {
      const body = parseJson(await parseBody(req)) as any;
      if (!body.accountId || !body.to || !body.body) {
        return error(res, 'accountId, to, and body are required');
      }
      const result = await sendSMS(body.accountId, body.to, body.body);
      if (!result.success) {
        return json(res, { ok: false, error: result.error }, result.error?.includes('Read Only') ? 403 : 500);
      }
      return json(res, { ok: true, messageSid: result.messageSid });
    }

    // POST /api/sms/test
    if (req.method === 'POST' && pathname === '/api/sms/test') {
      const body = parseJson(await parseBody(req)) as any;
      if (body.accountId) {
        const result = await testSmsConnection(body.accountId);
        return json(res, result);
      }
      if (body.account_sid && body.auth_token) {
        const result = await testSmsCredentials(body.account_sid, body.auth_token);
        return json(res, result);
      }
      return error(res, 'accountId or (account_sid + auth_token) required');
    }

    return error(res, 'Not found', 404);
  }

  async function handleOAuth(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    params: URLSearchParams,
  ): Promise<void> {
    // GET /api/oauth/start - begin OAuth flow
    if (req.method === 'GET' && pathname === '/api/oauth/start') {
      const provider = params.get('provider') as 'google' | 'microsoft';
      const userId = params.get('userId');
      const readOnly = params.get('read_only') !== 'false'; // DEFAULT READ ONLY unless explicitly false
      if (!provider || !userId) return error(res, 'provider and userId required');
      if (provider !== 'google' && provider !== 'microsoft') return error(res, 'Invalid provider');
      try {
        const { startOAuthFlow } = await import('./oauth.js');
        const authUrl = startOAuthFlow(provider, userId, readOnly);
        res.writeHead(302, { Location: authUrl });
        res.end();
        return;
      } catch (err: any) {
        logger.error({ err }, 'OAuth start failed');
        return error(res, err.message, 500);
      }
    }

    // GET /api/oauth/callback - OAuth redirect (no auth required)
    if (req.method === 'GET' && pathname === '/api/oauth/callback') {
      const code = params.get('code');
      const state = params.get('state');
      if (!code || !state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><p>Missing code or state parameter.</p></body></html>');
        return;
      }
      try {
        const { handleOAuthCallback } = await import('./oauth.js');
        const result = await handleOAuthCallback(code, state);
        const html = `<html><body><script>
  if (window.opener) {
    window.opener.postMessage({type:'oauth-success',provider:'${result.provider}'}, '*');
  }
  window.close();
</script><p>Connected! You can close this window.</p></body></html>`;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      } catch (err: any) {
        logger.error({ err }, 'OAuth callback failed');
        const safeMsg = err.message.replace(/[<>&"]/g, '');
        const html = `<html><body><p>OAuth error: ${safeMsg}</p><button onclick="window.close()">Close</button></body></html>`;
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(html);
      }
      return;
    }

    // GET /api/oauth/accounts - list accounts for user
    if (req.method === 'GET' && pathname === '/api/oauth/accounts') {
      const userId = params.get('userId');
      if (!userId) return error(res, 'userId required');
      try {
        const accounts = getOAuthAccountsByUser(userId).map((a) => ({
          id: a.id,
          provider: a.provider,
          email: a.email,
          calendar_enabled: a.calendar_enabled,
          email_enabled: a.email_enabled,
          enabled: a.enabled,
          last_calendar_sync: a.last_calendar_sync,
          created_at: a.created_at,
        }));
        return json(res, { accounts });
      } catch (err: any) {
        logger.error({ err }, 'Failed to get OAuth accounts');
        return error(res, err.message, 500);
      }
    }

    // DELETE /api/oauth/accounts/:id - revoke account
    const oauthAccountMatch = pathname.match(/^\/api\/oauth\/accounts\/([^/]+)$/);
    if (req.method === 'DELETE' && oauthAccountMatch) {
      const id = decodeURIComponent(oauthAccountMatch[1]);
      try {
        const { revokeOAuthAccount } = await import('./oauth.js');
        await revokeOAuthAccount(id);
        return json(res, { ok: true });
      } catch (err: any) {
        logger.error({ err }, 'Failed to revoke OAuth account');
        return error(res, err.message, 500);
      }
    }

    // PATCH /api/oauth/accounts/:id - update account settings
    if (req.method === 'PATCH' && oauthAccountMatch) {
      const id = decodeURIComponent(oauthAccountMatch[1]);
      try {
        const buf = await parseBody(req);
        const data = parseJson(buf) as Record<string, unknown>;
        const updates: Record<string, unknown> = {};
        if (data.calendar_enabled !== undefined) updates.calendar_enabled = data.calendar_enabled ? 1 : 0;
        if (data.email_enabled !== undefined) updates.email_enabled = data.email_enabled ? 1 : 0;
        if (data.enabled !== undefined) updates.enabled = data.enabled ? 1 : 0;
        const updated = updateOAuthAccountDb(id, updates);
        if (!updated) return error(res, 'Account not found', 404);
        // Strip tokens from response
        const safe = {
          id: updated.id,
          provider: updated.provider,
          email: updated.email,
          calendar_enabled: updated.calendar_enabled,
          email_enabled: updated.email_enabled,
          enabled: updated.enabled,
          last_calendar_sync: updated.last_calendar_sync,
          created_at: updated.created_at,
        };
        return json(res, { ok: true, account: safe });
      } catch (err: any) {
        logger.error({ err }, 'Failed to update OAuth account');
        return error(res, err.message, 500);
      }
    }

    // POST /api/oauth/accounts/:id/reconnect - re-auth an expired account
    const reconnectMatch = pathname.match(/^\/api\/oauth\/accounts\/([^/]+)\/reconnect$/);
    if (req.method === 'POST' && reconnectMatch) {
      const id = decodeURIComponent(reconnectMatch[1]);
      try {
        const { reconnectOAuthAccount } = await import('./oauth.js');
        const authUrl = reconnectOAuthAccount(id);
        res.writeHead(302, { Location: authUrl });
        res.end();
        return;
      } catch (err: any) {
        logger.error({ err }, 'OAuth reconnect failed');
        return error(res, err.message, 500);
      }
    }

    // POST /api/oauth/accounts/:id/sync-calendar - push events to provider
    const syncMatch = pathname.match(/^\/api\/oauth\/accounts\/([^/]+)\/sync-calendar$/);
    if (req.method === 'POST' && syncMatch) {
      const id = decodeURIComponent(syncMatch[1]);
      try {
        const buf = await parseBody(req);
        const data = parseJson(buf) as { eventIds: string[] | 'all_local' };
        if (!data.eventIds) return error(res, 'eventIds required');
        const { pushCalendarEvents } = await import('./calendar-sync.js');
        const result = await pushCalendarEvents(id, data.eventIds);
        return json(res, { ok: true, pushed: result.pushed, errors: result.errors });
      } catch (err: any) {
        logger.error({ err }, 'Calendar sync failed');
        return error(res, err.message, 500);
      }
    }

    // GET /api/oauth/accounts/:id/calendars - list provider calendars
    const calListMatch = pathname.match(/^\/api\/oauth\/accounts\/([^/]+)\/calendars$/);
    if (req.method === 'GET' && calListMatch) {
      const id = decodeURIComponent(calListMatch[1]);
      try {
        const { ensureFreshToken, getProviderInstance } = await import('./oauth.js');
        const { getOAuthAccount } = await import('./db.js');
        const oauthAccount = getOAuthAccount(id);
        if (!oauthAccount) return error(res, 'OAuth account not found', 404);
        const token = await ensureFreshToken(id);
        const provider = getProviderInstance(oauthAccount.provider as any);
        const calendars = await provider.listCalendars(token);
        return json(res, { ok: true, calendars });
      } catch (err: any) {
        logger.error({ err }, 'List calendars failed');
        return error(res, err.message, 500);
      }
    }

    return error(res, 'Not found', 404);
  }

  // --- Dashboard Page Edit Pipeline ---

  const DASHBOARD_EDITABLE_FILES = ['index.html', 'js/app.js', 'css/style.css'];
  const DASHBOARD_BETA_DIR = path.join(STATIC_DIR, 'beta');
  const DASHBOARD_BACKUP_DIR = path.join(DATA_DIR, 'dashboard-backups');

  function dashboardLivePath(file: string): string {
    return path.join(STATIC_DIR, file);
  }
  function dashboardBetaPath(file: string): string {
    return path.join(DASHBOARD_BETA_DIR, file);
  }

  function isDashboardEditableFile(file: string): boolean {
    return DASHBOARD_EDITABLE_FILES.includes(file) && !file.includes('..') && !path.isAbsolute(file);
  }

  function ensureDashboardBeta(): void {
    fs.mkdirSync(DASHBOARD_BETA_DIR, { recursive: true });
    // Seed beta copies from live if missing so /beta/ is a complete preview.
    for (const file of DASHBOARD_EDITABLE_FILES) {
      const live = dashboardLivePath(file);
      const beta = dashboardBetaPath(file);
      if (!fs.existsSync(beta) && fs.existsSync(live)) {
        fs.mkdirSync(path.dirname(beta), { recursive: true });
        fs.copyFileSync(live, beta);
      }
    }
  }

  async function handleDashboardPages(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): Promise<void> {
    // GET /api/dashboard-pages — list editable files with beta/live status
    if (req.method === 'GET' && pathname === '/api/dashboard-pages') {
      ensureDashboardBeta();
      const files = DASHBOARD_EDITABLE_FILES.map((file) => {
        const live = dashboardLivePath(file);
        const beta = dashboardBetaPath(file);
        const liveExists = fs.existsSync(live);
        const betaExists = fs.existsSync(beta);
        let dirty = false;
        if (liveExists && betaExists) {
          try {
            dirty = fs.readFileSync(live).toString() !== fs.readFileSync(beta).toString();
          } catch {}
        }
        return { file, live: liveExists, beta: betaExists, dirty };
      });
      return json(res, { files });
    }

    // GET /api/dashboard-pages/:file — read beta or live content (file may contain one slash, e.g. js/app.js)
    const readMatch = pathname.match(/^\/api\/dashboard-pages\/([^/]+(?:\/[^/]+)?)$/);
    if (req.method === 'GET' && readMatch) {
      const file = decodeURIComponent(readMatch[1]);
      if (!isDashboardEditableFile(file)) return error(res, 'invalid file');
      const which = new URL(req.url || '', `http://localhost`).searchParams.get('which') || 'beta';
      const target = which === 'live' ? dashboardLivePath(file) : dashboardBetaPath(file);
      if (!fs.existsSync(target)) return error(res, 'file not found');
      try {
        const content = fs.readFileSync(target, 'utf-8');
        return json(res, { file, which, content });
      } catch (err: any) {
        return error(res, String(err?.message ?? err));
      }
    }

    // GET /api/dashboard-pages/:file/diff — diff beta vs live (file may contain one slash)
    const diffMatch = pathname.match(/^\/api\/dashboard-pages\/([^/]+(?:\/[^/]+)?)\/diff$/);
    if (req.method === 'GET' && diffMatch) {
      const file = decodeURIComponent(diffMatch[1]);
      if (!isDashboardEditableFile(file)) return error(res, 'invalid file');
      const live = dashboardLivePath(file);
      const beta = dashboardBetaPath(file);
      if (!fs.existsSync(live)) return error(res, 'live file missing');
      if (!fs.existsSync(beta)) return error(res, 'beta file missing — save a draft first');
      try {
        const diff = spawnSync('diff', ['-u', live, beta], { encoding: 'utf-8' });
        return json(res, { file, diff: diff.stdout || diff.stderr || 'no differences' });
      } catch (err: any) {
        return error(res, String(err?.message ?? err));
      }
    }

    // POST /api/dashboard-pages/:file — save content to beta (file may contain one slash, e.g. js/app.js)
    const saveMatch = pathname.match(/^\/api\/dashboard-pages\/([^/]+(?:\/[^/]+)?)$/);
    if (req.method === 'POST' && saveMatch) {
      const file = decodeURIComponent(saveMatch[1]);
      if (!isDashboardEditableFile(file)) return error(res, 'invalid file');
      const body = parseJson(await parseBody(req)) as any;
      const content = typeof body?.content === 'string' ? body.content : '';
      ensureDashboardBeta();
      const beta = dashboardBetaPath(file);
      try {
        fs.mkdirSync(path.dirname(beta), { recursive: true });
        fs.writeFileSync(beta, content, 'utf-8');
        logger.info({ file }, 'dashboard page beta draft saved');
        return json(res, { ok: true, file, path: beta });
      } catch (err: any) {
        return error(res, String(err?.message ?? err));
      }
    }

    // POST /api/dashboard-pages/:file/promote — copy beta to live, backup live first (file may contain one slash)
    const promoteMatch = pathname.match(/^\/api\/dashboard-pages\/([^/]+(?:\/[^/]+)?)\/promote$/);
    if (req.method === 'POST' && promoteMatch) {
      const file = decodeURIComponent(promoteMatch[1]);
      if (!isDashboardEditableFile(file)) return error(res, 'invalid file');
      const live = dashboardLivePath(file);
      const beta = dashboardBetaPath(file);
      if (!fs.existsSync(beta)) return error(res, 'no beta draft to promote');
      try {
        fs.mkdirSync(DASHBOARD_BACKUP_DIR, { recursive: true });
        if (fs.existsSync(live)) {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const backup = path.join(DASHBOARD_BACKUP_DIR, `${file}.${stamp}`);
          fs.mkdirSync(path.dirname(backup), { recursive: true });
          fs.copyFileSync(live, backup);
        }
        fs.copyFileSync(beta, live);
        logger.info({ file }, 'dashboard page promoted to live');
        return json(res, { ok: true, file, backedUp: fs.existsSync(live) });
      } catch (err: any) {
        return error(res, String(err?.message ?? err));
      }
    }

    // POST /api/dashboard-pages/:file/revert — restore live from most recent backup (file may contain one slash)
    const revertMatch = pathname.match(/^\/api\/dashboard-pages\/([^/]+(?:\/[^/]+)?)\/revert$/);
    if (req.method === 'POST' && revertMatch) {
      const file = decodeURIComponent(revertMatch[1]);
      if (!isDashboardEditableFile(file)) return error(res, 'invalid file');
      try {
        const prefix = `${file}.`;
        const backups: { name: string; path: string }[] = [];
        const walk = (dir: string) => {
          for (const n of fs.readdirSync(dir)) {
            const p = path.join(dir, n);
            const st = fs.statSync(p);
            if (st.isDirectory()) walk(p);
            else if (path.relative(DASHBOARD_BACKUP_DIR, p).startsWith(prefix)) {
              const rel = path.relative(DASHBOARD_BACKUP_DIR, p);
              backups.push({ name: rel, path: p });
            }
          }
        };
        walk(DASHBOARD_BACKUP_DIR);
        backups.sort((a, b) => fs.statSync(b.path).mtimeMs - fs.statSync(a.path).mtimeMs);
        if (!backups.length) return error(res, 'no backup found');
        const live = dashboardLivePath(file);
        fs.copyFileSync(backups[0].path, live);
        logger.info({ file, backup: backups[0].name }, 'dashboard page reverted to backup');
        return json(res, { ok: true, file, backup: backups[0].name });
      } catch (err: any) {
        return error(res, String(err?.message ?? err));
      }
    }

    // DELETE /api/dashboard-pages/:file — remove beta draft (file may contain one slash, e.g. js/app.js)
    const deleteMatch = pathname.match(/^\/api\/dashboard-pages\/([^/]+(?:\/[^/]+)?)$/);
    if (req.method === 'DELETE' && deleteMatch) {
      const file = decodeURIComponent(deleteMatch[1]);
      if (!isDashboardEditableFile(file)) return error(res, 'invalid file');
      const beta = dashboardBetaPath(file);
      try {
        if (fs.existsSync(beta)) fs.unlinkSync(beta);
        return json(res, { ok: true });
      } catch (err: any) {
        return error(res, String(err?.message ?? err));
      }
    }

    return error(res, 'Not found', 404);
  }

  // --- Channel Management ---

  async function handleChannels(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): Promise<void> {
    // GET /api/channels — list channel status
    if (req.method === 'GET' && pathname === '/api/channels') {
      const envVals = readEnvFile(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'SLACK_BOT_TOKEN', 'SLACK_CHANNEL_ID']);
      const channelStatus: Array<{ type: string; configured: boolean; connected: boolean; chatId?: string; channelId?: string; tokenHint?: string }> = [];
      if (envVals.TELEGRAM_BOT_TOKEN) {
        const ch = deps.channels.find((c) => c.name === 'telegram');
        channelStatus.push({
          type: 'telegram',
          configured: true,
          connected: ch?.isConnected?.() || false,
          chatId: envVals.TELEGRAM_CHAT_ID || '',
          tokenHint: envVals.TELEGRAM_BOT_TOKEN.slice(-4),
        });
      }
      if (envVals.SLACK_BOT_TOKEN) {
        const ch = deps.channels.find((c) => c.name === 'slack');
        channelStatus.push({
          type: 'slack',
          configured: true,
          connected: ch?.isConnected?.() || false,
          channelId: envVals.SLACK_CHANNEL_ID || '',
          tokenHint: envVals.SLACK_BOT_TOKEN.slice(-4),
        });
      }
      // WhatsApp: check if auth state exists
      const waAuthPath = path.join(STORE_DIR, 'auth', 'creds.json');
      const waChannel = deps.channels.find((c) => c.name === 'whatsapp');
      const waQr = (waChannel as any)?.getQrStatus?.() || { connected: false, failed: false };
      if (fs.existsSync(waAuthPath) || waChannel) {
        channelStatus.push({
          type: 'whatsapp',
          configured: fs.existsSync(waAuthPath),
          connected: waQr.connected || waChannel?.isConnected?.() || false,
        });
      }
      return json(res, { channels: channelStatus });
    }

    // GET /api/channels/whatsapp/qr — get pending QR code for WhatsApp pairing
    if (req.method === 'GET' && pathname === '/api/channels/whatsapp/qr') {
      const waChannel = deps.channels.find((c) => c.name === 'whatsapp');
      const status = (waChannel as any)?.getQrStatus?.() || { qr: null, connected: false, failed: false };
      return json(res, status);
    }

    // POST /api/channels/telegram — save token + chat id and reconnect
    if (req.method === 'POST' && pathname === '/api/channels/telegram') {
      const body = parseJson(await parseBody(req)) as any;
      if (!body.token) return error(res, 'token required');
      const { writeEnvVars } = await import('./env.js');
      const vars: Record<string, string> = { TELEGRAM_BOT_TOKEN: body.token };
      if (body.chatId) vars.TELEGRAM_CHAT_ID = String(body.chatId);
      writeEnvVars(vars);
      process.env.TELEGRAM_BOT_TOKEN = body.token;
      if (body.chatId) process.env.TELEGRAM_CHAT_ID = String(body.chatId);
      const success = deps.reconnectChannel ? await deps.reconnectChannel('telegram') : false;
      return json(res, { ok: success });
    }

    // POST /api/channels/slack — save token + channel id and reconnect
    if (req.method === 'POST' && pathname === '/api/channels/slack') {
      const body = parseJson(await parseBody(req)) as any;
      if (!body.token) return error(res, 'token required');
      const { writeEnvVars } = await import('./env.js');
      const vars: Record<string, string> = { SLACK_BOT_TOKEN: body.token };
      if (body.channelId) vars.SLACK_CHANNEL_ID = String(body.channelId);
      writeEnvVars(vars);
      process.env.SLACK_BOT_TOKEN = body.token;
      if (body.channelId) process.env.SLACK_CHANNEL_ID = String(body.channelId);
      const success = deps.reconnectChannel ? await deps.reconnectChannel('slack') : false;
      return json(res, { ok: success });
    }

    // POST /api/channels/whatsapp — trigger WhatsApp connection (generates QR)
    if (req.method === 'POST' && pathname === '/api/channels/whatsapp') {
      const success = deps.reconnectChannel ? await deps.reconnectChannel('whatsapp') : false;
      return json(res, { ok: success });
    }

    // POST /api/channels/whatsapp/sync — force group discovery sync
    if (req.method === 'POST' && pathname === '/api/channels/whatsapp/sync') {
      const { setLastGroupSync } = await import('./db.js');
      setLastGroupSync('2000-01-01T00:00:00Z');
      const ch = deps.channels.find((c) => c.name === 'whatsapp');
      if (ch && (ch as any).syncGroupMetadata) {
        await (ch as any).syncGroupMetadata(true);
        return json(res, { ok: true });
      }
      return json(res, { ok: false, error: 'WhatsApp not connected' });
    }

    // POST /api/channels/:type/link — link a discovered chat to an existing group
    const linkMatch = pathname.match(/^\/api\/channels\/([^/]+)\/link$/);
    if (req.method === 'POST' && linkMatch) {
      const body = parseJson(await parseBody(req)) as any;
      if (!body.chatJid || !body.groupJid) return error(res, 'chatJid and groupJid required');
      const groups = deps.registeredGroups();
      const existingGroup = groups[body.groupJid];
      if (!existingGroup) return error(res, 'Group not found', 404);
      // Link the channel JID as an alias on the existing group (in-memory only;
      // multi-user linked_jids table removed).
      if (!existingGroup.linkedJids) existingGroup.linkedJids = [];
      if (!existingGroup.linkedJids.includes(body.chatJid)) existingGroup.linkedJids.push(body.chatJid);
      // Add to in-memory map so routing picks it up immediately
      groups[body.chatJid] = existingGroup;
      // Ensure chat entry exists for the channel JID
      const name = existingGroup.name || existingGroup.folder;
      storeChatMetadata(body.chatJid, new Date().toISOString(), name, linkMatch[1], false);
      return json(res, { ok: true });
    }

    // DELETE /api/channels/:type — disconnect and remove token
    const deleteMatch = pathname.match(/^\/api\/channels\/([^/]+)$/);
    if (req.method === 'DELETE' && deleteMatch) {
      const type = deleteMatch[1];
      if (type === 'telegram') {
        const { writeEnvVars } = await import('./env.js');
        writeEnvVars({ TELEGRAM_BOT_TOKEN: '' });
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else if (type === 'slack') {
        const { writeEnvVars } = await import('./env.js');
        writeEnvVars({ SLACK_BOT_TOKEN: '' });
        delete process.env.SLACK_BOT_TOKEN;
      }
      // Disconnect and remove channel FIRST (stops reconnect loop)
      const ch = deps.channels.find((c) => c.name === type);
      if (ch) await ch.disconnect?.();
      const chIdx = deps.channels.findIndex((c) => c.name === type);
      if (chIdx !== -1) deps.channels.splice(chIdx, 1);
      // THEN clear WhatsApp auth and discovered chats (after reconnect loop is stopped)
      if (type === 'whatsapp') {
        const waAuthDir = path.join(STORE_DIR, 'auth');
        try { fs.rmSync(waAuthDir, { recursive: true, force: true }); } catch {}
        try { const { deleteWhatsappChats } = await import('./db.js'); deleteWhatsappChats(); } catch {}
      }
      return json(res, { ok: true });
    }

    return error(res, 'Not found', 404);
  }

  // === Split-pane proxy (ttyd terminal + noVNC browser inside containers) ===
  const splitProxy = httpProxy.createProxyServer({ xfwd: false });
  const splitErrorPage = (msg: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Split-pane</title>` +
    `<style>html,body{margin:0;height:100%;background:#1e1e2e;color:#cbd5e1;font:14px/1.5 -apple-system,Segoe UI,sans-serif;display:flex;align-items:center;justify-content:center;text-align:center}` +
    `.box{max-width:380px;padding:24px}h1{font-size:15px;font-weight:600;margin:0 0 8px;color:#f1f5f9}p{margin:0 0 12px;color:#94a3b8}button{background:#2563eb;color:#fff;border:0;border-radius:6px;padding:8px 14px;font:inherit;cursor:pointer}</style>` +
    `</head><body><div class="box"><h1>Pane upstream not ready</h1><p>${msg}</p><button onclick="location.reload()">Retry</button></div></body></html>`;
  splitProxy.on('error', (err, _req, res) => {
    logger.warn({ err: err?.message }, 'Split-pane proxy error');
    if (res && 'writeHead' in res && !res.headersSent) {
      try {
        (res as http.ServerResponse).writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
        (res as http.ServerResponse).end(splitErrorPage('The terminal or browser service inside the container hasn\'t started yet. It usually takes a few seconds after the container spawns.'));
      } catch { /* socket already closed */ }
    } else if (res && 'destroy' in res) {
      try { (res as any).destroy(); } catch { /* ignore */ }
    }
  });


  function authorizeFolderForUserToken(_token: string | null | undefined, _folder: string): boolean {
    // Split-pane container proxy is removed; always deny.
    return false;
  }

  function parseCookies(header: string | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (!header) return out;
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
    }
    return out;
  }
  // Cookie name used for both /terminal/<folder>/* and /novnc/<folder>/*
  // sub-resource auth. Scoped per-folder so a token leak doesn't grant
  // cross-group access.
  const PANE_COOKIE = 'dockbox-pane-session';

  const server = http.createServer(async (req, res) => {
    const { pathname, params } = parseUrl(req.url || '/');

    // Security headers on all responses
    const reqOrigin = req.headers.origin;
    if (typeof reqOrigin === 'string') {
      // Only reflect origins from the same host (admin dashboard) or empty origin.
      // This prevents malicious websites from reading data cross-origin.
      // Allow cross-origin requests for thin client / whitelabel deployments
      res.setHeader('Access-Control-Allow-Origin', reqOrigin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // X-Frame-Options removed to allow whitelabel thin client embedding
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods':
          'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Filename, X-Admin-Session, X-User-Session',
      });
      res.end();
      return;
    }

    try {
      // --- Dropped route trees (single-user Warden: no admin, no per-user APIs) ---
      // The old multi-user / admin / group / company / work-task / session-link
      // route trees are gone. Surviving endpoints live directly under /api/*
      // (messages, tasks, email, files, vault, status, activity, voice,
      // notifications, etc.).
      if (pathname.startsWith('/api/admin/') || pathname === '/api/admin') {
        res.writeHead(410, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'admin routes removed' }));
        return;
      }
      if (/^\/api\/users\/[^/]+(\/.*)?$/.test(pathname)) {
        res.writeHead(410, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'per-user routes removed' }));
        return;
      }
      // Non-id multi-user routes — all backed by removed db/container code.
      if (pathname === '/api/users' || pathname === '/api/users/check-username') {
        res.writeHead(410, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'multi-user routes removed' }));
        return;
      }
      if (pathname === '/api/groups' && req.method === 'GET') {
        // Single-user Warden: return the one owner group, always active.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          groups: [{ jid: 'owner@local', name: 'Owner', folder: 'owner', is_main: true, active: getRouterState('agent:processing') === 'true', idle: getRouterState('agent:processing') !== 'true' }],
        }));
        return;
      }
      // /api/groups/:folder/ideas(:name) is still implemented below — carve it
      // out before 410-gating the rest of the removed /api/groups/* tree.
      if (pathname.startsWith('/api/groups') && !/^\/api\/groups\/[^/]+\/ideas(\/|$)/.test(pathname)) {
        res.writeHead(410, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'group routes removed' }));
        return;
      }
      if (pathname.startsWith('/api/companies')) {
        res.writeHead(410, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'company routes removed' }));
        return;
      }
      if (pathname.startsWith('/api/work-tasks')) {
        res.writeHead(410, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'work-task routes removed' }));
        return;
      }
      if (pathname.startsWith('/api/session-links')) {
        res.writeHead(410, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'session-link routes removed' }));
        return;
      }
      // Signup / forgot-password / login-info / reset-password depended on
      // the removed multi-user db layer; 410 them until they're re-implemented
      // for the single-user model (if ever).
      if (pathname === '/api/signup' || pathname === '/api/forgot-password' || pathname === '/api/login-info'
          || /^\/api\/reset-password\/[^/]+$/.test(pathname)) {
        res.writeHead(410, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'multi-user auth routes removed' }));
        return;
      }

      // --- Split-pane HTTP proxies (terminal HTML/assets + noVNC HTML/assets) ---
      // Container runtime is gone, so the ttyd/websockify split-pane is dead.
      // 410 the HTTP assets; the WS upgrade handler below also short-circuits.
      const termMatch = pathname.match(/^\/terminal\/([^/]+)(\/.*)?$/);
      const vncMatch = pathname.match(/^\/novnc\/([^/]+)(\/.*)?$/);
      if (termMatch || vncMatch) {
        res.writeHead(410, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'split-pane container proxy removed' }));
        return;
      }

      // --- Public routes (no auth required) ---

      // POST /api/sms/webhook/:accountId — Twilio inbound (public, no auth)
      const smsWebhookMatch = pathname.match(/^\/api\/sms\/webhook\/([^/]+)$/);
      if (smsWebhookMatch && req.method === 'POST') {
        return await handleSms(req, res, pathname, params);
      }

      // NOTE: /api/signup, /api/forgot-password, /api/reset-password/*, and
      // /api/users/:id/email were removed with the multi-user layer. They are
      // 410-gated above or by the /api/users/:id/* regex.

      if (pathname === '/api/admin/login') {
        res.writeHead(410, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'admin routes removed' }));
        return;
      }
      if (pathname === '/api/admin/verify') {
        res.writeHead(410, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'admin routes removed' }));
        return;
      }
      if (pathname === '/api/admin/logout') {
        res.writeHead(410, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'admin routes removed' }));
        return;
      }
      if (pathname === '/api/health') return handleHealth(res);

      // OAuth start + callback — no session headers required.
      // Start: browser popup navigates directly (no XHR headers). Security via HMAC-signed state.
      // Callback: redirect from Google/Microsoft. Security via state param validation.
      if ((pathname === '/api/oauth/callback' || pathname === '/api/oauth/start') && req.method === 'GET')
        return await handleOAuth(req, res, pathname, params);

      // Public access for standalone pages
      // --- Auth required for all /api/files and /api/messages ---

      // No auth gate — single-user Warden. All /api/* routes are open.
      // (Admin/user route trees are dropped above with 410 Gone.)

      // --- Authenticated admin routes ---
      if (pathname === '/api/stress-test' && req.method === 'POST')
        return await handleStressTest(req, res);
      if (pathname === '/api/agents/kill' && req.method === 'POST')
        return await handleAgentKill(req, res);
      if (pathname === '/api/chat/stop' && req.method === 'POST')
        return await handleChatStop(req, res);
      if (pathname === '/api/server/restart' && req.method === 'POST') {
        json(res, { ok: true });
        logger.info('Server restart requested via dashboard');
        setTimeout(() => process.exit(0), 500);
        return;
      }
      if (pathname === '/api/status') return json(res, getStatusData());
      if (pathname === '/api/process-logs' && req.method === 'GET') {
        try {
          const lines = Math.min(parseInt(params.get('lines') || '200', 10) || 200, 2000);
          const logFile = path.join(DATA_DIR, '..', 'logs', 'dockbox.log');
          const errFile = path.join(DATA_DIR, '..', 'logs', 'dockbox.error.log');
          const { execSync: execSyncLocal } = await import('child_process');
          let combined = '';
          try {
            combined = execSyncLocal(`tail -n ${lines} "${logFile}" 2>/dev/null || true`, { encoding: 'utf-8', timeout: 5000 });
          } catch { combined = ''; }
          // Strip ANSI escape codes
          combined = combined.replace(/\x1b\[[0-9;]*m/g, '');
          const sizes: Record<string, number> = {};
          for (const [key, file] of Object.entries({ stdout: logFile, stderr: errFile })) {
            try { sizes[key] = fs.statSync(file).size; } catch { sizes[key] = 0; }
          }
          return json(res, { ok: true, lines: combined.split('\n').filter(Boolean), sizes });
        } catch (err: any) {
          return json(res, { ok: false, error: String(err?.message ?? err) });
        }
      }
      if (pathname === '/api/process-logs' && req.method === 'POST') {
        try {
          const body = parseJson(await parseBody(req)) as { action?: string };
          if (body.action === 'truncate') {
            const logFile = path.join(DATA_DIR, '..', 'logs', 'dockbox.log');
            const errFile = path.join(DATA_DIR, '..', 'logs', 'dockbox.error.log');
            const { execSync: execSyncLocal } = await import('child_process');
            execSyncLocal(`: > "${logFile}"; : > "${errFile}"`, { timeout: 5000 });
            logger.info('process logs truncated via dashboard');
            return json(res, { ok: true });
          }
          return error(res, 'unknown action');
        } catch (err: any) {
          return json(res, { ok: false, error: String(err?.message ?? err) });
        }
      }
      if (pathname === '/api/messages')
        return await handleMessages(req, res, params);
      if (pathname.startsWith('/api/files'))
        return await handleFiles(req, res, pathname, params);
      if (pathname === '/api/settings' && req.method === 'GET')
        return handleSettings(res);
      if (pathname === '/api/settings' && req.method === 'POST')
        return await handleSettingsSave(req, res);
      if (pathname === '/api/audit/run' && req.method === 'POST') {
        try {
          const script = path.resolve(process.cwd(), 'tests/audit-agent-behavior.sh');
          if (!fs.existsSync(script)) return json(res, { ok: false, error: 'audit script not found at tests/audit-agent-behavior.sh' });
          const logPath = '/tmp/audit-100-run.log';
          // Kill any previous audit still running
          try {
            spawnSync('pkill', ['-f', 'audit-agent-behavior.sh'], { stdio: 'ignore' });
          } catch {}
          const out = fs.openSync(logPath, 'w');
          const err = fs.openSync(logPath, 'a');
          const child = spawn('bash', [script], { detached: true, stdio: ['ignore', out, err] });
          child.unref();
          fs.closeSync(out);
          fs.closeSync(err);
          logger.info({ pid: child.pid, log: logPath }, 'audit started');
          return json(res, { ok: true, log: logPath, pid: child.pid });
        } catch (err: any) {
          return json(res, { ok: false, error: String(err?.message ?? err) });
        }
      }
      if (pathname === '/api/audit/status' && req.method === 'GET') {
        try {
          const logPath = '/tmp/audit-100-run.log';
          let tail = '';
          try {
            const buf = fs.readFileSync(logPath, 'utf-8');
            tail = buf.split('\n').slice(-40).join('\n');
          } catch { tail = ''; }
          let running = false;
          try {
            const r = spawnSync('pgrep', ['-f', 'audit-agent-behavior.sh'], { encoding: 'utf-8' });
            running = (r.stdout || '').trim().length > 0;
          } catch {}
          return json(res, { ok: true, running, tail });
        } catch (err: any) {
          return json(res, { ok: false, error: String(err?.message ?? err) });
        }
      }
      if (pathname === '/api/open-terminal' && req.method === 'POST') {
        try {
          // Launch a desktop terminal attached to the `warden-shell` tmux session
          // where Atlas runs all bash commands — user can watch and interact live.
          // Session is created automatically if it doesn't exist yet.
          try { execSync('tmux has-session -t warden-shell 2>/dev/null'); }
          catch { execSync('tmux new-session -d -s warden-shell -x 200 -y 50 /bin/bash'); }
          const candidates: [string, string[]][] = [
            ['konsole', ['-e', 'tmux', 'attach-session', '-t', 'warden-shell']],
            ['gnome-terminal', ['--', 'tmux', 'attach-session', '-t', 'warden-shell']],
            ['xterm', ['-e', 'tmux', 'attach-session', '-t', 'warden-shell']],
            ['kitty', ['tmux', 'attach-session', '-t', 'warden-shell']],
            ['alacritty', ['-e', 'tmux', 'attach-session', '-t', 'warden-shell']],
          ];
          let launched = false;
          for (const [bin, args] of candidates) {
            try {
              spawn(bin, args, { detached: true, stdio: 'ignore' }).unref();
              launched = true;
              json(res, { ok: true, terminal: bin });
              break;
            } catch {}
          }
          if (!launched) error(res, 'No terminal emulator found', 500);
        } catch (e: any) {
          error(res, e?.message || 'Failed to open terminal', 500);
        }
        return;
      }
      if (pathname === '/api/ollama/test') return await handleOllamaTest(res);
      if (pathname === '/api/ollama/model-names')
        return await handleOllamaModelNames(req, res);
      if (pathname === '/api/ollama/thinking-support') {
        if (req.method === 'GET') return json(res, { thinking: readOllamaThinking() });
        if (req.method === 'POST') {
          const body = parseJson(await parseBody(req)) as { thinking?: Record<string, boolean> };
          if (!body || typeof body.thinking !== 'object') return error(res, 'thinking object required');
          writeOllamaThinking(body.thinking);
          return json(res, { ok: true });
        }
        return error(res, 'Method not allowed', 405);
      }
      if (pathname === '/api/ollama/toggle' && req.method === 'POST')
        return await handleOllamaToggle(req, res);
      if (pathname === '/api/automation/model')
        return await handleAutomationModel(req, res);
      // /api/groups, /api/work-tasks, /api/companies, /api/session-links,
      // /api/users (non-id), and /api/admin/* are 410-gated at the top of
      // this try-block — no dispatcher reaches here.
      if (pathname.startsWith('/api/dashboard-pages'))
        return await handleDashboardPages(req, res, pathname);
      if (pathname.startsWith('/api/channels'))
        return await handleChannels(req, res, pathname);
      if (pathname === '/api/tasks' && req.method === 'GET')
        return handleTasks(res);
      if (pathname.startsWith('/api/tasks'))
        return await handleTasksCrud(req, res, pathname);
      if (pathname.startsWith('/api/vault'))
        return await handleVault(req, res, pathname);
      if (pathname === '/api/search') return await handleSearch(res, params);
      if (pathname === '/api/activity') return handleActivity(res, params);
      if (pathname === '/api/notifications' && req.method === 'GET')
        return handleNotificationsSse(req, res);
      if (pathname === '/api/notifications/poll' && req.method === 'GET')
        return handleNotifications(res, params);
      // Single-user Warden stubs for dashboard endpoints that no longer have
      // multi-user backing stores. Return empty data so the UI doesn't 404.
      if (pathname === '/api/notification-list' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ notifications: [], unread: 0 }));
        return;
      }
      if (pathname === '/api/notification-list/read-all' && req.method === 'PATCH') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (pathname === '/api/api-keys' && req.method === 'GET') {
        // Single-user Warden: default user id is 'owner'
        const keys = getUserApiKeys('owner').map((k) => ({
          id: k.id,
          name: k.label || k.key_type,
          type: k.key_type,
          masked: k.encrypted_key.slice(0, 4) + '••••',
          baseUrl: k.base_url,
          defaultModel: k.default_model,
          isActive: !!k.is_active,
          createdAt: k.created_at,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ keys }));
        return;
      }
      if (pathname === '/api/api-keys' && req.method === 'POST') {
        const body = parseJson(await parseBody(req)) as Record<string, unknown>;
        const name = String(body.name || body.type || '').trim();
        const value = String(body.value || '').trim();
        const type = String(body.type || 'custom').trim();
        if (!name || !value) return error(res, 'name and value required');
        const enc = encryptApiKey(value);
        const id = crypto.randomUUID();
        addUserApiKey(
          id,
          'owner',
          type,
          enc.encrypted,
          enc.iv,
          enc.authTag,
          name,
          String(body.baseUrl || ''),
          String(body.defaultModel || ''),
          String(body.authHeaderFormat || 'Bearer {key}'),
        );
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id }));
        return;
      }
      const apiKeyMatch = pathname.match(/^\/api\/api-keys\/([^/]+)$/);
      if (apiKeyMatch && req.method === 'DELETE') {
        deleteUserApiKey(decodeURIComponent(apiKeyMatch[1]));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (pathname === '/api/automations' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tasks: [], scheduledTasks: [] }));
        return;
      }
      if (pathname === '/api/automations' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      const automationMatch = pathname.match(/^\/api\/automations\/([^/]+)$/);
      if (automationMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (pathname === '/api/heartbeat' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ content: '', enabled: false, model: '', lastRun: null }));
        return;
      }
      if (pathname === '/api/heartbeat' && req.method === 'PUT') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (pathname === '/api/alarms' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ alarms: [] }));
        return;
      }
      if (pathname === '/api/timers' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ timers: [] }));
        return;
      }
      if (pathname === '/api/projects' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ projects: [] }));
        return;
      }
      if (pathname === '/api/chats/discovered' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ chats: [] }));
        return;
      }
      if (pathname === '/api/calendar-token' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ token: '' }));
        return;
      }
      if (pathname === '/api/calendar-token' && req.method === 'PUT') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (pathname === '/api/calendar/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ events: [] }));
        return;
      }
      if (pathname === '/api/calendar/events' && req.method === 'POST') {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: `evt-${Date.now()}` }));
        return;
      }
      const calEventMatch = pathname.match(/^\/api\/calendar\/events\/([^/]+)$/);
      if (calEventMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (pathname === '/api/calendar/import' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (pathname.startsWith('/api/calendar/export') && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/calendar' });
        res.end('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');
        return;
      }
      // Ideas: sub-workspaces under a group folder. Stored as subdirectories of
      // WORKSPACE_ROOT. Empty list is fine for the single-user Warden default.
      const ideasMatch = pathname.match(/^\/api\/groups\/([^/]+)\/ideas$/);
      if (ideasMatch && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ideas: [] }));
        return;
      }
      if (ideasMatch && req.method === 'POST') {
        const body = parseJson(await parseBody(req)) as { name?: string };
        if (!body.name) return error(res, 'name required');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, name: body.name }));
        return;
      }
      const ideaDeleteMatch = pathname.match(/^\/api\/groups\/([^/]+)\/ideas\/([^/]+)$/);
      if (ideaDeleteMatch && req.method === 'DELETE') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (pathname === '/api/health') return handleHealth(res);

      // ------- MCP servers CRUD -------
      if (pathname === '/api/mcp-servers' && req.method === 'GET') {
        return json(res, { servers: loadMcpServers() });
      }
      if (pathname === '/api/mcp-servers' && req.method === 'POST') {
        const body = parseJson(await parseBody(req)) as any;
        const name = String(body?.name ?? '').trim();
        const command = String(body?.command ?? '').trim();
        if (!name || !/^[a-z0-9._-]+$/i.test(name)) {
          return error(res, 'invalid name (a-z 0-9 . _ - only)');
        }
        if (!command) return error(res, 'command is required');
        try {
          addMcpServer({
            name,
            command,
            args: Array.isArray(body?.args) ? body.args.map(String) : [],
            env: body?.env && typeof body.env === 'object' ? body.env : undefined,
            transport: 'stdio',
            enabled: body?.enabled === false ? false : true,
            description:
              typeof body?.description === 'string' ? body.description : undefined,
          });
          return json(res, { ok: true });
        } catch (e: any) {
          return error(res, String(e?.message ?? e));
        }
      }
      const mcpItemMatch = pathname.match(/^\/api\/mcp-servers\/([^/]+)$/);
      if (mcpItemMatch) {
        const name = decodeURIComponent(mcpItemMatch[1]);
        if (req.method === 'DELETE') {
          removeMcpServer(name);
          return json(res, { ok: true });
        }
        if (req.method === 'PATCH') {
          const body = parseJson(await parseBody(req)) as any;
          if (typeof body?.enabled !== 'boolean') {
            return error(res, 'enabled (boolean) required');
          }
          try {
            setMcpServerEnabled(name, body.enabled);
            return json(res, { ok: true });
          } catch (e: any) {
            return error(res, String(e?.message ?? e), 404);
          }
        }
      }

      // ------- Skills mutations (container/skills/<name>/SKILL.md) -------
      if (pathname === '/api/skills' && req.method === 'POST') {
        const body = parseJson(await parseBody(req)) as any;
        const skillName = String(body?.name ?? '').trim();
        const skillDesc = String(body?.description ?? '').trim();
        if (!skillName || !/^[a-z0-9-]+$/i.test(skillName)) {
          return error(res, 'invalid name (a-z 0-9 - only)');
        }
        if (!skillDesc) return error(res, 'description is required');
        const skillDir = path.resolve(
          process.cwd(),
          'data',
          'skills',
          skillName,
        );
        const skillPath = path.join(skillDir, 'SKILL.md');
        if (fs.existsSync(skillPath)) return error(res, 'skill already exists', 409);
        const instr = String(body?.instructions ?? '').trim();
        const whenToUse = String(body?.when_to_use ?? '').trim();
        const example = String(body?.example_prompt ?? '').trim();
        fs.mkdirSync(skillDir, { recursive: true });
        const frontmatter = [
          '---',
          `name: ${skillName}`,
          `description: ${JSON.stringify(skillDesc)}`,
          '---',
        ].join('\n');
        const parts: string[] = [];
        if (whenToUse) parts.push('## When to use', '', whenToUse, '');
        if (instr) parts.push('## Instructions', '', instr, '');
        if (example)
          parts.push(
            '## Example prompt',
            '',
            '> ' + example.replace(/\n/g, '\n> '),
            '',
          );
        const bodyMd =
          parts.length > 0
            ? parts.join('\n')
            : `# ${skillName}\n\n${skillDesc}\n`;
        fs.writeFileSync(skillPath, `${frontmatter}\n\n${bodyMd}`, 'utf8');
        return json(res, { ok: true, path: skillPath });
      }
      const skillItemMatch = pathname.match(/^\/api\/skills\/([^/]+)$/);
      if (skillItemMatch && req.method === 'DELETE') {
        const skillName = decodeURIComponent(skillItemMatch[1]);
        if (!/^[a-z0-9-]+$/i.test(skillName)) return error(res, 'invalid name');
        const skillDir = path.resolve(
          process.cwd(),
          'data',
          'skills',
          skillName,
        );
        const skillPath = path.join(skillDir, 'SKILL.md');
        if (!fs.existsSync(skillPath)) {
          return error(res, 'not found (or not a container skill)', 404);
        }
        fs.unlinkSync(skillPath);
        try {
          fs.rmdirSync(skillDir);
        } catch {
          // dir wasn't empty; leave it
        }
        return json(res, { ok: true });
      }
      if (skillItemMatch && req.method === 'PATCH') {
        const skillName = decodeURIComponent(skillItemMatch[1]);
        if (!/^[a-z0-9-]+$/i.test(skillName)) return error(res, 'invalid name');
        const body = parseJson(await parseBody(req)) as any;
        if (typeof body?.enabled !== 'boolean') {
          return error(res, 'enabled (boolean) required');
        }
        const skillPath = path.resolve(process.cwd(), 'data', 'skills', skillName, 'SKILL.md');
        if (!fs.existsSync(skillPath)) return error(res, 'not found', 404);
        let raw = fs.readFileSync(skillPath, 'utf8');
        // Toggle a `disabled: true` line inside the YAML frontmatter block;
        // the agent-runner's loadSkills skips skills carrying that flag.
        raw = raw.replace(/^disabled:\s*(true|false)\s*\n/m, '');
        if (!body.enabled) {
          raw = raw.replace(/^---\s*\n/, '---\ndisabled: true\n');
        }
        fs.writeFileSync(skillPath, raw, 'utf8');
        return json(res, { ok: true, enabled: body.enabled });
      }

      if (pathname === '/api/skills') return handleSkills(res);
      if (pathname.startsWith('/api/email'))
        return await handleEmail(req, res, pathname, params);
      if (pathname.startsWith('/api/sms'))
        return await handleSms(req, res, pathname, params);
      if (pathname.startsWith('/api/oauth'))
        return await handleOAuth(req, res, pathname, params);

      // --- Admin/user route trees dropped (single-user Warden) ---
      // /api/admin/* and /api/users/:id/* return 410 Gone via the early check above.
      if (pathname === '/api/voice' && req.method === 'POST')
        return await handleVoice(req, res);
      if (pathname.startsWith('/api/backup'))
        return await handleBackup(req, res, pathname);
      if (pathname.startsWith('/api/agent/sessions'))
        return await handleAgentSessions(req, res, pathname);
      if (pathname === '/api/chat/interrupt' && req.method === 'POST')
        return await handleChatInterrupt(req, res);

      // Local file preview — serves group files at /preview/{groupFolder}/path
      // so relative asset URLs (css/style.css, images/) resolve correctly in iframes
      if (pathname.startsWith('/preview/')) {
        const rel = decodeURIComponent(pathname.slice('/preview/'.length));
        if (rel.includes('..')) { error(res, 'Forbidden', 403); return; }
        const full = path.resolve(GROUPS_DIR, rel);
        if (!full.startsWith(GROUPS_DIR)) { error(res, 'Forbidden', 403); return; }
        if (!fs.existsSync(full)) { res.writeHead(404); res.end('Not found'); return; }
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          // Try index.html inside the directory
          const idx = path.join(full, 'index.html');
          if (fs.existsSync(idx)) {
            const ext = '.html';
            const mime = MIME[ext] || 'text/html';
            res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0', 'Pragma': 'no-cache', 'X-Frame-Options': 'ALLOWALL' });
            fs.createReadStream(idx).pipe(res);
            return;
          }
          res.writeHead(404); res.end('Not found'); return;
        }
        const ext = path.extname(full).toLowerCase();
        const mime = MIME[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0', 'Pragma': 'no-cache', 'X-Frame-Options': 'ALLOWALL' });
        fs.createReadStream(full).pipe(res);
        return;
      }

      // Static files
      serveStatic(res, pathname);
    } catch (err: any) {
      logger.error({ err, url: req.url }, 'Dashboard request error');
      error(res, 'Internal error', 500);
    }
  });

  // WebSocket upgrade proxy for the split-pane (ttyd + noVNC).
  // - /terminal/<folder>/ws  → ttyd (matches its --base-path)
  // - /ws/vnc/<folder>       → websockify root
  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const pathname = url.pathname;
      const cookies = parseCookies(req.headers.cookie);
      const token = url.searchParams.get('usersession') || cookies[PANE_COOKIE] || '';

      const termWsMatch = pathname.match(/^\/terminal\/([^/]+)\/ws$/);
      const vncWsMatch = pathname.match(/^\/ws\/vnc\/([^/]+)$/);
      if (!termWsMatch && !vncWsMatch) {
        // /api/terminal is handled by a separate upgrade listener (Task 19).
        // Don't 404 it — let the next listener take it.
        if (pathname === '/api/terminal') return;
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      const folder = decodeURIComponent((termWsMatch || vncWsMatch)![1]);
      void folder;
      // Split-pane container proxy is removed; deny the WS upgrade.
      socket.write('HTTP/1.1 410 Gone\r\n\r\n');
      socket.destroy();
      return;
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'Split-pane upgrade error');
      try { socket.destroy(); } catch {}
    }
  });

  // --- /api/terminal WebSocket: attaches to shared warden-shell tmux session ---
  // The dashboard terminal attaches to the SAME `warden-shell` tmux session
  // that the agent's Bash tool runs commands in (see execRequestHandler in
  // agent-spawn.ts). The user sees what Warden is doing in real-time and can
  // type commands themselves. `tmux new-session -A` creates the session if it
  // doesn't exist, or attaches to it if it does — so multiple dashboard tabs
  // all share the same live shell.
  const terminalWss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== '/api/terminal') return;
    if (!nodePtyIsAvailable()) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }
    terminalWss.handleUpgrade(req, socket, head, (ws) => {
      terminalWss.emit('connection', ws, req);
    });
  });

  terminalWss.on('connection', (ws: WebSocket) => {
    let session: PtySession | null = null;
    try {
      session = spawnPty({
        cols: 80,
        rows: 24,
        command: 'tmux',
        args: ['new-session', '-A', '-s', 'warden-shell', '-x', '200', '-y', '50', '/bin/bash'],
      });
    } catch (err: any) {
      logger.warn({ err: err?.message }, '/api/terminal: pty spawn failed');
      try { ws.close(1011, 'pty spawn failed'); } catch {}
      return;
    }

    const sendOutput = (data: Buffer) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ type: 'output', data: data.toString('base64') }));
      } catch { /* client gone */ }
    };
    session.onOutput(sendOutput);

    ws.on('message', (raw: Buffer) => {
      if (!session) return;
      let msg: any;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (msg?.type === 'input' && typeof msg.data === 'string') {
        try {
          session.write(Buffer.from(msg.data, 'base64').toString('utf8'));
        } catch { /* pty dead */ }
      } else if (msg?.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
        try { session.resize(msg.cols | 0, msg.rows | 0); } catch { /* ignore */ }
      }
    });

    ws.on('close', () => {
      try { session?.kill(); } catch { /* ignore */ }
      session = null;
    });
    ws.on('error', () => {
      try { session?.kill(); } catch { /* ignore */ }
      session = null;
    });
  });

  const bindHost = process.env.BIND_HOST || '0.0.0.0';
  server.listen(STATUS_PORT, bindHost, () => {
    logger.info({ port: STATUS_PORT, host: bindHost }, 'Warden Dashboard started');
  });

  // Hourly cleanup of expired user sessions removed (multi-user session table gone).

  setInterval(() => {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const dueTasks = getDueUserTasks(hhmm);
    for (const task of dueTasks) {
      markTaskRun(task.id);
      // Push browser notification
      pushNotification(task.user_id, {
        type: 'task',
        message: task.action,
        taskId: task.id,
      });
      // Send to chat if chat_notifications enabled
      if (task.chat_notifications && task.allowed_sessions.length > 0) {
        const jid = task.allowed_sessions[0];
        const msgContent = `Reminder: ${task.action}`;
        deps.storeMessage({
          id: `utask-msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          chat_jid: jid,
          sender: 'system',
          sender_name: task.user_name,
          content: msgContent,
          timestamp: new Date().toISOString(),
          is_from_me: true,
          is_bot_message: false,
        });
        // Relay to the actual channel (Telegram, WhatsApp, etc.)
        if (!jid.startsWith('web:')) {
          deps.sendChannelMessage(jid, msgContent).catch((err: any) => {
            logger.warn({ err, jid }, 'Failed to send user task reminder to channel');
          });
        }
      }
      logger.info(
        { taskId: task.id, userId: task.user_id, action: task.action },
        'User task fired',
      );
    }

    // Check alarms
    const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const currentDay = days[now.getDay()];
    const currentDate = now.toISOString().slice(0, 10);
    const dueAlarms = getDueAlarms(hhmm, currentDay, currentDate);
    for (const alarm of dueAlarms) {
      markAlarmFired(alarm.id);
      if (alarm.repeat_type === 'once') {
        disableOneTimeAlarm(alarm.id);
      }
      pushNotification(alarm.user_id, {
        type: 'alarm',
        message: alarm.label,
        taskId: alarm.id,
      });
      // Multi-user chat-session relay removed; single-user Warden delivers
      // alarms via pushNotification only.
      logger.info({ alarmId: alarm.id, userId: alarm.user_id, label: alarm.label }, 'Alarm fired');
    }
  }, 30000);
}

// ─── Backup handler ───────────────────────────────────────────────────────────

async function handleBackup(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<void> {
  const seg = pathname.replace(/^\/api\/backup\/?/, '');

  // GET /api/backup — list backups + config
  if (!seg && req.method === 'GET') {
    return json(res, { backups: listBackups(), config: getBackupConfig() });
  }

  // GET /api/backup/config
  if (seg === 'config' && req.method === 'GET') {
    return json(res, getBackupConfig());
  }

  // POST /api/backup/config
  if (seg === 'config' && req.method === 'POST') {
    const buf = await parseBody(req);
    const cfg = saveBackupConfig(JSON.parse(buf.toString()));
    return json(res, cfg);
  }

  // POST /api/backup/full
  if (seg === 'full' && req.method === 'POST') {
    try {
      const meta = await createFullBackup();
      return json(res, meta);
    } catch (err: any) {
      return error(res, err.message, 500);
    }
  }

  // POST /api/backup/incremental
  if (seg === 'incremental' && req.method === 'POST') {
    try {
      const meta = await createIncrementalBackup();
      if (!meta) return json(res, { skipped: true, message: 'No files changed' });
      return json(res, meta);
    } catch (err: any) {
      return error(res, err.message, 500);
    }
  }

  // POST /api/backup/restore/:id
  const restoreMatch = seg.match(/^restore\/(.+)$/);
  if (restoreMatch && req.method === 'POST') {
    const id = restoreMatch[1];
    try {
      await restoreBackup(id);
      return json(res, { ok: true, id });
    } catch (err: any) {
      return error(res, err.message, 500);
    }
  }

  // GET /api/backup/download/:id
  const dlMatch = seg.match(/^download\/(.+)$/);
  if (dlMatch && req.method === 'GET') {
    const id = dlMatch[1];
    const archivePath = getBackupArchivePath(id);
    if (!archivePath) return error(res, 'Backup not found', 404);
    const stat = fs.statSync(archivePath);
    const filename = path.basename(archivePath);
    res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': stat.size,
    });
    fs.createReadStream(archivePath).pipe(res);
    return;
  }

  // DELETE /api/backup/:id
  const deleteMatch = seg.match(/^([^/]+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    const id = deleteMatch[1];
    try {
      deleteBackup(id);
      return json(res, { ok: true });
    } catch (err: any) {
      return error(res, err.message, 500);
    }
  }

  return error(res, 'Not found', 404);
}

// Lazy-initialized agent session store
let _agentSessionStore: AgentSessionStore | null = null;
function getAgentSessionStore(): AgentSessionStore {
    if (!_agentSessionStore) {
        _agentSessionStore = new AgentSessionStore(getDb());
    }
    return _agentSessionStore;
}

async function handleChatInterrupt(
    _req: http.IncomingMessage,
    res: http.ServerResponse
): Promise<void> {
    // Container IPC mechanism removed; chat interrupts are no longer delivered
    // via the filesystem. 410 Gone.
    res.writeHead(410, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'chat interrupt IPC removed' }));
}

async function handleAgentSessions(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string
): Promise<void> {
    const store = getAgentSessionStore();
    const seg = pathname.replace(/^\/api\/agent\/sessions\/?/, '');

    // GET /api/agent/sessions?jid=...&limit= — list sessions
    if (!seg && req.method === 'GET') {
        const purl = new URL(req.url!, `http://${req.headers.host || 'localhost'}`);
        const jid = purl.searchParams.get('jid') || '';
        const limit = parseInt(purl.searchParams.get('limit') || '20', 10);
        const offset = parseInt(purl.searchParams.get('offset') || '0', 10);
        return json(res, store.listSessions(jid, limit, offset));
    }

    // POST /api/agent/sessions/search — FTS5 search
    if (seg === 'search' && req.method === 'POST') {
        const { jid, query, limit } = parseJson(await parseBody(req)) as any;
        if (!query) return error(res, 'query is required', 400);
        let results;
        if (jid) {
            results = store.searchMessages(jid, query, limit || 20);
        } else {
            results = store.searchAllSessions(query, limit || 20);
        }
        return json(res, results);
    }

    // GET /api/agent/sessions/:id/export
    if (seg.endsWith('/export') && req.method === 'GET') {
        const sessionId = seg.replace(/\/export$/, '');
        const session = store.getSession(sessionId);
        if (!session) return error(res, 'Session not found', 404);
        const messages = store.getMessages(sessionId, 10000);
        return json(res, { session, messages });
    }

    // GET /api/agent/sessions/:id
    if (seg && req.method === 'GET') {
        const session = store.getSession(seg);
        if (!session) return error(res, 'Session not found', 404);
        const messages = store.getMessages(seg);
        return json(res, { session, messages });
    }

    return error(res, 'Not found', 404);
}
