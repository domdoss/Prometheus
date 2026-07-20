import { spawn, spawnSync, execSync, ChildProcess } from 'node:child_process';
import { existsSync, statSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentInput, AgentOutput } from './types.js';
import { logger } from './logger.js';

// IPC input directory — matches the agent runner's IPC_DIR/input path
const IPC_INPUT_DIR = path.join(
  process.env.WARDEN_IPC_DIR || path.join(os.tmpdir(), 'warden-ipc'),
  'input',
);

const DEFAULT_EXECUTABLE = 'node';
const DEFAULT_EXECUTABLE_ARGS = ['dist/agent-runner/index.js'];

export type CallbackHandler = (args: any) => Promise<any>;
export type CallbackMap = Record<string, CallbackHandler>;

export type AgentRunInput = AgentInput & {
  executable?: string;
  executableArgs?: string[];
  callbacks?: CallbackMap;
  /** When set (e.g. 'heimdall'), runSubAgentBackground spawns the named sub-agent
   *  directly instead of the orchestrator. */
  agent?: string;
  chatJid?: string;
  groupFolder?: string;
  isMain?: boolean;
};

/**
 * Spawn a background sub-agent (e.g. Heimdall, the security agent) in a FRESH
 * child process with its OWN self-contained CALLBACK pump — it does NOT touch
 * the global `agentState`/persistent orchestrator child, so it runs alongside
 * the main loop without clashing. Fire-and-forget: the host does not await it;
 * the child runs the sub-agent, its tool calls are handled by `input.callbacks`
 * (send_message / close_security_alert / webcam_capture / security_log), and it
 * exits when done. Heimdall's user-facing output goes via its own send_message
 * callback; the raw "SECURITY ALERT" trigger is consumed here, not by the
 * orchestrator, so the main chat isn't muddied.
 */
export function runSubAgentBackground(input: AgentRunInput): void {
  const exe = input.executable ?? DEFAULT_EXECUTABLE;
  const exeArgs = input.executableArgs ?? DEFAULT_EXECUTABLE_ARGS;
  const env = { ...process.env, WORKSPACE_ROOT: input.workspaceRoot, AGENT_TIMEOUT: String(input.timeoutMs) };
  const child = spawn(exe, exeArgs, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const callbacks = input.callbacks ?? {};
  const agentName = input.agent || 'heimdall';

  let stdoutBuf = '';
  let insideCallback = false;
  let callbackLines: string[] = [];

  const writeResp = (payload: any) => {
    try {
      child.stdin.write('CALLBACK_RESPONSE_START\n');
      child.stdin.write(JSON.stringify(payload) + '\n');
      child.stdin.write('CALLBACK_RESPONSE_END\n');
    } catch { /* child gone */ }
  };

  const handleCb = async (raw: string) => {
    let parsed: any;
    try { parsed = JSON.parse(raw); } catch { writeResp({ error: 'bad callback JSON' }); return; }
    const tool = parsed.tool;
    const handler = callbacks[tool];
    if (!handler) { writeResp({ id: parsed.id, error: `no handler for tool: ${tool}` }); return; }
    try {
      const r = await handler(parsed.args);
      writeResp({ id: parsed.id, ...(r || {}) });
    } catch (err: any) {
      writeResp({ id: parsed.id, ok: false, error: err?.message ?? String(err) });
    }
  };

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() ?? '';
    for (const line of lines) {
      if (insideCallback) {
        if (line === 'CALLBACK_END') {
          insideCallback = false;
          void handleCb(callbackLines.join('\n'));
          callbackLines = [];
          continue;
        }
        callbackLines.push(line);
        continue;
      }
      if (line === 'CALLBACK_START') { insideCallback = true; callbackLines = []; continue; }
      // Live status from the background agent → surface in the dashboard's
      // progress bar (shared with the orchestrator's, but labeled by phase).
      if (line.startsWith('---WARDEN_STATUS---')) {
        try {
          const e = JSON.parse(line.slice('---WARDEN_STATUS---'.length).trim());
          if (e.label && e.label !== lastProgressLabel) {
            lastProgressLabel = e.label;
            pushProgress({ ts: e.ts || Date.now(), kind: 'status', phase: e.phase || agentName, label: e.label, jobs: 0 });
          }
        } catch { /* malformed */ }
        continue;
      }
      // OUTPUT_START/END and other stdout lines are ignored (fire-and-forget;
      // the agent's user-facing output went out via send_message callbacks).
    }
  });
  child.stderr.on('data', (c: Buffer) => {
    const t = c.toString().trim();
    if (t) logger.info(`bg-agent[${agentName}]: ${t.slice(0, 300)}`);
  });
  child.on('exit', (code, signal) => {
    logger.info({ agent: agentName, code, signal }, `bg-agent[${agentName}]: exited`);
  });
  child.on('error', (err) => {
    logger.warn({ err, agent: agentName }, `bg-agent[${agentName}]: spawn error`);
  });

  const payload = JSON.stringify({
    agent: agentName,
    prompt: input.prompt,
    model: input.model,
    workspaceRoot: input.workspaceRoot,
    chatJid: input.chatJid || 'owner@local',
    groupFolder: input.groupFolder || 'owner',
    isMain: input.isMain ?? true,
    timeoutMs: input.timeoutMs,
  });
  logger.info({ agent: agentName, payloadLen: payload.length }, `bg-agent[${agentName}]: spawning`);
  try { child.stdin.write(payload); } catch (err) { logger.warn({ err }, `bg-agent[${agentName}]: stdin write failed`); }
}

/**
 * Default `exec_request` callback handler. The agent-runner's Bash tool emits
 * an exec_request callback with `{ command, args, cwd, env }`; this handler
 * runs the command in a VISIBLE tmux session named `warden-shell` so the user
 * can watch commands execute in real-time by attaching to that session.
 *
 * The command is sent as-is — no wrapper, no marker echo. The shell's own
 * `PROMPT_COMMAND` writes the exit code of each command to a sentinel file
 * (`/tmp/.warden_last_exit`); we poll that file's mtime to detect completion.
 * The pane shows only the real command + real output, exactly like a normal
 * interactive bash session.
 *
 * If the `warden-shell` session doesn't exist, it's created automatically
 * with an init script that installs the PROMPT_COMMAND hook.
 */
const WARDEN_SHELL_SESSION = 'warden-shell';
const WARDEN_SHELL_INIT = '/tmp/warden-shell-init.sh';
const WARDEN_LAST_EXIT = '/tmp/.warden_last_exit';

function ensureWardenShellSession(): boolean {
  try {
    // Write the init script that installs our PROMPT_COMMAND hook. Idempotent.
    try {
      writeFileSync(WARDEN_SHELL_INIT,
        `[ -f /etc/bash.bashrc ] && source /etc/bash.bashrc\n` +
        `[ -f ~/.bashrc ] && source ~/.bashrc\n` +
        `__warden_precmd() { local ec=$?; echo "$ec" > ${WARDEN_LAST_EXIT}; }\n` +
        `PROMPT_COMMAND="__warden_precmd${'$'}{PROMPT_COMMAND:+;${'$'}PROMPT_COMMAND}"\n` +
        `export PS1='[warden] \\w\\$ '\n`,
        { mode: 0o644 });
    } catch { /* best-effort */ }

    try {
      execSync(`tmux has-session -t ${WARDEN_SHELL_SESSION} 2>/dev/null`, { encoding: 'utf-8' });
      // Session exists — but PROMPT_COMMAND may not be active if the session was
      // created outside of ensureWardenShellSession (e.g. manually, or via start.sh).
      // Source the init script into the live session if the sentinel file is absent.
      if (!existsSync(WARDEN_LAST_EXIT)) {
        try {
          spawnSync('tmux', ['send-keys', '-t', WARDEN_SHELL_SESSION, `source ${WARDEN_SHELL_INIT}`, 'Enter'], { encoding: 'utf-8', timeout: 3000 });
          const start = Date.now();
          while (Date.now() - start < 2000) {
            if (existsSync(WARDEN_LAST_EXIT)) break;
            try { execSync('sleep 0.05', { encoding: 'utf-8' }); } catch { break; }
          }
        } catch { /* best-effort */ }
      }
      return true;
    } catch {
      execSync(`tmux new-session -d -s ${WARDEN_SHELL_SESSION} -x 200 -y 50 bash --rcfile ${WARDEN_SHELL_INIT}`, { encoding: 'utf-8' });
      // Give bash a moment to source its init and fire the first PROMPT_COMMAND.
      const start = Date.now();
      while (Date.now() - start < 2000) {
        if (existsSync(WARDEN_LAST_EXIT)) break;
        try { execSync('sleep 0.05', { encoding: 'utf-8' }); } catch { break; }
      }
      return true;
    }
  } catch {
    return false;
  }
}

export const execRequestHandler: CallbackHandler = async (args: any) => {
  const command: string = typeof args?.command === 'string' ? args.command : '';
  if (!command) return { ok: false, error: 'missing command' };
  const cwd: string | undefined = typeof args?.cwd === 'string' ? args.cwd : undefined;
  const timeoutMs: number = typeof args?.timeoutMs === 'number' ? args.timeoutMs : 120000;

  // Try the visible tmux session first. If tmux isn't available, fall back to direct spawn.
  const hasTmux = ensureWardenShellSession();
  if (hasTmux) {
    try {
      // Snapshot the sentinel file's mtime *before* sending — we detect completion
      // by watching this file's mtime change (PROMPT_COMMAND writes to it after
      // each command returns).
      let beforeMtime = 0;
      try { beforeMtime = statSync(WARDEN_LAST_EXIT).mtimeMs; } catch { /* not yet created */ }

      // Snapshot pane line count before sending so we know where new output starts.
      const capBefore = spawnSync('tmux', ['capture-pane', '-t', WARDEN_SHELL_SESSION, '-p', '-S', '-5000'], { encoding: 'utf-8', timeout: 5000 });
      const beforeLines = (capBefore.stdout || '').split('\n').length;

      // Send the command as-is — no cd prefix, no markers. The shell's cwd is
      // managed by the agent's own cd calls; prepending one here just pollutes
      // the pane and the captured output.
      const rawCmd = command;
      spawnSync('tmux', ['send-keys', '-t', WARDEN_SHELL_SESSION, '-l', rawCmd], { encoding: 'utf-8', timeout: 5000 });
      spawnSync('tmux', ['send-keys', '-t', WARDEN_SHELL_SESSION, 'Enter'], { encoding: 'utf-8', timeout: 5000 });

      // Poll the sentinel file's mtime — PROMPT_COMMAND writes to it after each
      // command completes. No marker text ever appears in the pane.
      const deadline = Date.now() + timeoutMs;
      let done = false;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 80));
        try {
          const mtime = statSync(WARDEN_LAST_EXIT).mtimeMs;
          if (mtime > beforeMtime) { done = true; break; }
        } catch { /* file gone briefly — keep waiting */ }
      }

      if (!done) {
        // Abort the still-running command so the shared shell isn't left wedged.
        try { spawnSync('tmux', ['send-keys', '-t', WARDEN_SHELL_SESSION, 'C-c'], { encoding: 'utf-8', timeout: 3000 }); } catch {}
        return { ok: false, error: `Command timed out after ${timeoutMs}ms` };
      }

      // Read the exit code written by PROMPT_COMMAND.
      let exitCode = 0;
      try { exitCode = parseInt(readFileSync(WARDEN_LAST_EXIT, 'utf-8').trim(), 10) || 0; } catch { /* missing */ }

      // Capture the pane after the command completes.
      const cap = spawnSync('tmux', ['capture-pane', '-t', WARDEN_SHELL_SESSION, '-p', '-S', '-5000'], { encoding: 'utf-8', timeout: 5000 });
      const lines = (cap.stdout || '').split('\n');
      // The new lines added since we sent the command start at beforeLines.
      // Layout: [0..beforeLines-1] = old content, [beforeLines] = command echo, [beforeLines+1..] = output, [last] = new prompt.
      const newLines = lines.slice(beforeLines);
      // Strip trailing blanks then the trailing prompt line.
      let outEnd = newLines.length;
      while (outEnd > 0 && !newLines[outEnd - 1].trim()) outEnd--;
      if (outEnd > 0 && /[\$%#]\s*$/.test(newLines[outEnd - 1])) outEnd--;
      // Skip index 0 (the command echo line) — always the first new line.
      const outLines = newLines.slice(1, outEnd);
      while (outLines.length && !outLines[outLines.length - 1].trim()) outLines.pop();
      const stdout = outLines.join('\n').trim();

      return { ok: true, result: { stdout, exitCode } };
    } catch (err: any) {
      // fall through to direct spawn
    }
  }

  // Fallback: direct spawn (no tmux available)
  try {
    const child = spawn(command, {
      cwd: cwd || process.cwd(),
      shell: '/bin/bash',
      env: { ...process.env, ...(args?.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* dead */ }
    }, timeoutMs);
    const exitInfo = await new Promise<{ code: number }>((resolve) => {
      child.on('close', (code) => resolve({ code: code ?? -1 }));
      child.on('error', () => resolve({ code: -1 }));
    });
    clearTimeout(timer);
    if (exitInfo.code !== 0 && stderr && !stdout) {
      stdout = stderr;
    }
    return { ok: true, result: { stdout, exitCode: exitInfo.code } };
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err) };
  }
};

// Persistent agent child — kept alive between messages to avoid MCP reconnect
// overhead. Replaced only when it dies or is explicitly killed.
let persistentChild: ChildProcess | null = null;
// currentAgent is the same as persistentChild; kept for killCurrentAgent compat.
let currentAgent: ChildProcess | null = null;
let userStoppedAgent = false;

// Per-turn shared state — reset at the start of each runAgent call and
// mutated by the shared stdout listener that stays open across turns.
const agentState = {
  callbacks: {} as CallbackMap,
  startedAt: 0,
  resolve: null as ((out: AgentOutput) => void) | null,
  stderr: '',
  stdoutBuf: '',
  captured: '',
  insideOutput: false,
  insideCallback: false,
  callbackLines: [] as string[],
  turnTimeout: null as ReturnType<typeof setTimeout> | null,
};

// Live verbose-status label emitted by the agent-runner child via
// ---WARDEN_STATUS---{...json} markers on stdout. The dashboard polls
// /api/status and renders this so the user can see what Warden is doing
// right now (e.g. "The Council: round 2 of 4 — Skeptic, Pragmatist
// deliberating..."). Cleared on turn end.
export const liveStatus = {
  jid: 'owner@local',
  phase: '',
  label: '',
  tools: [] as string[],
  jobs: 0,
  ts: 0,
};

// Ring buffer of recent progress events for the dashboard's collapsible
// "Live activity" panel. Each entry is one real status change (an atlas tool
// call, a council round, a delegation) or a supervisor note from an
// orchestrator monitor-tick. The dashboard polls /api/status and renders the
// last N here as a grouped, expandable history — so progress lives in the
// dashboard instead of as a stream of canned chat bubbles.
export interface ProgressEvent {
  ts: number;
  kind: 'status' | 'supervisor' | 'done' | 'error';
  phase: string;
  label: string;
  jobs: number;
}
const PROGRESS_MAX = 40;
export const progressHistory: ProgressEvent[] = [];
let lastProgressLabel = '';

export function getProgressHistory(): ProgressEvent[] {
  return progressHistory.slice(-PROGRESS_MAX);
}

function pushProgress(entry: ProgressEvent): void {
  progressHistory.push(entry);
  if (progressHistory.length > PROGRESS_MAX) {
    progressHistory.splice(0, progressHistory.length - PROGRESS_MAX);
  }
}

/** Append a supervisor note (an orchestrator monitor-tick report). Public so
 *  the progress_event callback in src/index.ts can route tick prose here
 *  instead of to the chat. */
export function pushSupervisorNote(text: string): void {
  const trimmed = (text || '').trim();
  if (!trimmed) return;
  pushProgress({
    ts: Date.now(),
    kind: 'supervisor',
    phase: liveStatus.phase || 'orchestrator',
    label: trimmed.slice(0, 240),
    jobs: liveStatus.jobs,
  });
}

export function getLiveStatus() {
  return { ...liveStatus };
}

export function clearLiveStatus() {
  liveStatus.phase = '';
  liveStatus.label = '';
  liveStatus.tools = [];
  liveStatus.jobs = 0;
  liveStatus.ts = 0;
}

function resetTurnState(callbacks: CallbackMap, resolve: (out: AgentOutput) => void, timeoutMs: number) {
  if (agentState.turnTimeout) { clearTimeout(agentState.turnTimeout); agentState.turnTimeout = null; }
  agentState.callbacks = callbacks;
  agentState.startedAt = Date.now();
  agentState.resolve = resolve;
  agentState.stderr = '';
  agentState.stdoutBuf = '';
  agentState.captured = '';
  agentState.insideOutput = false;
  agentState.insideCallback = false;
  agentState.callbackLines = [];
  agentState.turnTimeout = setTimeout(() => {
    const r = agentState.resolve;
    if (!r) return;
    agentState.resolve = null;
    // Kill the stuck persistent child
    if (persistentChild) {
      try { persistentChild.kill('SIGTERM'); } catch { /* dead */ }
      persistentChild = null;
      currentAgent = null;
    }
    r({ text: agentState.captured, exitCode: -1, durationMs: Date.now() - agentState.startedAt, error: `agent timeout after ${timeoutMs}ms` });
  }, timeoutMs);
}

function writeCallbackResponse(payload: any) {
  if (!persistentChild?.stdin) return;
  try {
    persistentChild.stdin.write('CALLBACK_RESPONSE_START\n');
    persistentChild.stdin.write(JSON.stringify(payload) + '\n');
    persistentChild.stdin.write('CALLBACK_RESPONSE_END\n');
  } catch (err) {
    logger.warn({ err }, 'agent-spawn: failed to write callback response');
  }
}

async function handleCallback(raw: string) {
  let parsed: { tool?: string; args?: any; id?: string };
  try { parsed = JSON.parse(raw); } catch (err) {
    logger.warn({ err, raw }, 'agent-spawn: bad callback JSON');
    writeCallbackResponse({ error: 'bad callback JSON' });
    return;
  }
  const tool = parsed.tool;
  const id = parsed.id;
  if (!tool) { writeCallbackResponse({ id, error: 'missing tool field' }); return; }
  const handler = agentState.callbacks[tool];
  if (!handler) {
    logger.warn({ tool }, 'agent-spawn: callback with no registered handler');
    writeCallbackResponse({ id, error: `no handler for tool: ${tool}` });
    return;
  }
  try {
    const result = await handler(parsed.args);
    if (result && (result as any).ok === false) {
      logger.warn({ tool, error: (result as any).error }, 'agent-spawn: callback handler returned error');
    }
    writeCallbackResponse({ id, ...result });
  } catch (err: any) {
    logger.warn({ tool, err }, 'agent-spawn: callback handler threw');
    writeCallbackResponse({ id, ok: false, error: err?.message ?? String(err) });
  }
}

function onPersistentStdoutData(chunk: Buffer) {
  agentState.stdoutBuf += chunk.toString();
  logger.info(
    { chunkLen: chunk.length, totalLen: agentState.stdoutBuf.length, preview: chunk.toString().slice(0, 200) },
    'agent-spawn: stdout chunk',
  );
  const lines = agentState.stdoutBuf.split('\n');
  agentState.stdoutBuf = lines.pop() ?? '';
  for (const line of lines) {
    if (agentState.insideCallback) {
      if (line === 'CALLBACK_END') {
        agentState.insideCallback = false;
        const raw = agentState.callbackLines.join('\n');
        agentState.callbackLines = [];
        void handleCallback(raw);
        continue;
      }
      agentState.callbackLines.push(line);
      continue;
    }
    if (line === 'CALLBACK_START') { agentState.insideCallback = true; agentState.callbackLines = []; continue; }
    // Live verbose-status updates from the agent-runner child. The child
    // writes `---WARDEN_STATUS---{json}` to stdout whenever it wants to
    // surface what it's doing right now (e.g. council round progress,
    // sub-agent delegation, tool execution). We stash the latest one and
    // expose it via /api/status → dashboard "verbose bar".
    if (line.startsWith('---WARDEN_STATUS---')) {
      try {
        const json = line.slice('---WARDEN_STATUS---'.length).trim();
        const entry = JSON.parse(json);
        liveStatus.phase = entry.phase || '';
        liveStatus.label = entry.label || '';
        liveStatus.tools = Array.isArray(entry.tools) ? entry.tools : [];
        liveStatus.jobs = typeof entry.jobs === 'number' ? entry.jobs : 0;
        liveStatus.ts = entry.ts || Date.now();
        // Buffer real progress for the dashboard panel — only when the label
        // actually changes, so a job that emits the same status repeatedly
        // doesn't flood the history with identical entries.
        if (liveStatus.label && liveStatus.label !== lastProgressLabel) {
          lastProgressLabel = liveStatus.label;
          pushProgress({
            ts: liveStatus.ts,
            kind: 'status',
            phase: liveStatus.phase,
            label: liveStatus.label,
            jobs: liveStatus.jobs,
          });
        }
      } catch { /* ignore malformed status lines */ }
      continue;
    }
    if (line === 'OUTPUT_START' || line === '---WARDEN_OUTPUT_START---') { agentState.insideOutput = true; continue; }
    if (line === 'OUTPUT_END' || line === '---WARDEN_OUTPUT_END---') {
      agentState.insideOutput = false;
      // Turn ended — clear the live verbose-status so the dashboard doesn't
      // keep showing "The Council round 2..." after the turn is over.
      clearLiveStatus();
      const r = agentState.resolve;
      if (r) {
        agentState.resolve = null;
        if (agentState.turnTimeout) { clearTimeout(agentState.turnTimeout); agentState.turnTimeout = null; }
        const wasUserStopped = userStoppedAgent;
        if (wasUserStopped) {
          userStoppedAgent = false;
          r({ text: '', exitCode: 0, durationMs: Date.now() - agentState.startedAt, userStopped: true });
          return;
        }
        r({ text: agentState.captured, exitCode: 0, durationMs: Date.now() - agentState.startedAt });
      }
      // Keep child alive for next turn — do NOT end stdin or kill
      continue;
    }
    if (agentState.insideOutput) agentState.captured += line + '\n';
  }
}

function setupPersistentChild(child: ChildProcess, startedAt: number) {
  persistentChild = child;
  currentAgent = child;
  child.stdout!.on('data', onPersistentStdoutData);
  // Runner diagnostics arrive on stderr. Log them live: the persistent child
  // never exits, so the exit-time stderr dump below never fires for it and
  // warnings (stream aborts, degenerate-generation strips) were invisible.
  let stderrLineBuf = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    agentState.stderr += text;
    if (agentState.stderr.length > 200_000) agentState.stderr = agentState.stderr.slice(-100_000);
    stderrLineBuf += text;
    const lines = stderrLineBuf.split('\n');
    stderrLineBuf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (t) logger.info(`agent-runner: ${t.slice(0, 500)}`);
    }
  });
  child.on('exit', (code, signal) => {
    const exitCode = code ?? (signal ? -1 : -1);
    if (exitCode !== 0 && agentState.stderr) {
      try { writeFileSync('/tmp/agent-runner-last-error.log', agentState.stderr); } catch { /* ignore */ }
    }
    logger.info({ exitCode, signal, stderrLen: agentState.stderr.length, stderrTail: agentState.stderr.slice(-2000) }, 'agent-spawn: child exited');
    if (persistentChild === child) { persistentChild = null; currentAgent = null; }
    const r = agentState.resolve;
    if (r) {
      agentState.resolve = null;
      if (agentState.turnTimeout) { clearTimeout(agentState.turnTimeout); agentState.turnTimeout = null; }
      const wasUserStopped = userStoppedAgent;
      if (wasUserStopped) {
        userStoppedAgent = false;
        r({ text: '', exitCode: 0, durationMs: Date.now() - startedAt, userStopped: true });
        return;
      }
      r({ text: agentState.captured, exitCode, durationMs: Date.now() - startedAt,
        error: exitCode !== 0 ? `agent exited with code ${exitCode}${signal ? ` (signal ${signal})` : ''}; stderr: ${agentState.stderr.slice(-1500)}` : undefined });
    }
  });
  child.on('error', (err) => {
    if (persistentChild === child) { persistentChild = null; currentAgent = null; }
    const r = agentState.resolve;
    if (r) {
      agentState.resolve = null;
      r({ text: agentState.captured, exitCode: -1, durationMs: Date.now() - startedAt, error: `spawn error: ${err.message}` });
    }
  });
}

/**
 * Kill the currently-running agent child process, if any.
 * Returns true if a process was killed, false if none was running.
 */
export function killCurrentAgent(): boolean {
  const proc = persistentChild || currentAgent;
  if (!proc || proc.killed) {
    persistentChild = null;
    currentAgent = null;
    return false;
  }
  try {
    userStoppedAgent = true;
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        try { proc.kill('SIGKILL'); } catch { /* dead */ }
      }
    }, 2000).unref();
    return true;
  } catch {
    persistentChild = null;
    currentAgent = null;
    return false;
  } finally {
    persistentChild = null;
    currentAgent = null;
  }
}

export function runAgent(input: AgentRunInput): Promise<AgentOutput> {
  return new Promise((resolve) => {
    const callbacks = input.callbacks ?? {};
    userStoppedAgent = false;

    // Reuse the persistent child if it's still alive.
    if (persistentChild && !persistentChild.killed && persistentChild.exitCode === null) {
      resetTurnState(callbacks, resolve, input.timeoutMs);
      try {
        mkdirSync(IPC_INPUT_DIR, { recursive: true });
        writeFileSync(
          `${IPC_INPUT_DIR}/msg-${Date.now()}.json`,
          JSON.stringify({ type: 'message', text: input.prompt, showThinking: input.showThinking, verbose: input.verbose }),
        );
        logger.info({ promptLen: input.prompt.length }, 'agent-spawn: routed via IPC (persistent agent)');
      } catch (err) {
        logger.warn({ err }, 'agent-spawn: IPC write failed — will spawn fresh next turn');
        persistentChild = null;
        currentAgent = null;
        // Fall through to spawn a fresh child for this turn via a tail call.
        // (resolve is already set in agentState, so just recurse once)
        void runAgent(input).then(resolve);
      }
      return;
    }

    // Spawn a fresh persistent child.
    const exe = input.executable ?? DEFAULT_EXECUTABLE;
    const exeArgs = input.executableArgs ?? DEFAULT_EXECUTABLE_ARGS;
    const env = { ...process.env, WORKSPACE_ROOT: input.workspaceRoot, AGENT_TIMEOUT: String(input.timeoutMs) };
    const child = spawn(exe, exeArgs, { env, stdio: ['pipe', 'pipe', 'pipe'] });

    resetTurnState(callbacks, resolve, input.timeoutMs);
    setupPersistentChild(child, agentState.startedAt);

    const payload = JSON.stringify({
      prompt: input.prompt,
      orchestratorModel: input.orchestratorModel,
      model: input.model,
      councilSkepticModel: input.councilSkepticModel,
      councilPragmatistModel: input.councilPragmatistModel,
      councilSynthesistModel: input.councilSynthesistModel,
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      history: input.history,
      timeoutMs: input.timeoutMs,
      memoryContext: input.memoryContext,
      showThinking: input.showThinking,
      verbose: input.verbose,
    });
    logger.info({ payloadLen: payload.length, historyLen: input.history?.length ?? 0 }, 'agent-spawn: writing payload to child stdin');
    try {
      child.stdin.write(payload);
      // Keep stdin open — needed for callback responses and future IPC turns.
    } catch (err) {
      logger.warn({ err }, 'agent-spawn: failed to write stdin');
    }
  });
}