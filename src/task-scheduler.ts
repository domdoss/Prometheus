import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE, TRIGGER_PATTERN } from './config.js';
import {
  deleteTask,
  getDueTasks,
  getTaskById,
  logTaskRun,
  pruneTaskRunLogs,
  storeMessage,
  updateTaskAfterRun,
} from './db.js';
import { resolveGroupFolderPath, type RegisteredGroup } from './group-folder.js';
import { logger } from './logger.js';
import { ScheduledTask } from './types.js';

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') {
    // After the task has run at least once, there is no next run — return null
    // so updateTaskAfterRun marks it completed. On the initial creation call
    // (task.last_run is null), convert the local schedule_value timestamp to a
    // UTC ISO string so getDueTasks' `next_run <= now` comparison (which uses
    // new Date().toISOString() = UTC) works correctly.
    if (task.last_run) return null;
    if (!task.schedule_value) return null;
    const d = new Date(task.schedule_value);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Guard against null/invalid next_run — fall back to now + interval
    const anchor = task.next_run ? new Date(task.next_run).getTime() : NaN;
    if (isNaN(anchor)) {
      logger.warn(
        { taskId: task.id, next_run: task.next_run },
        'Null or invalid next_run for interval task, falling back to now + interval',
      );
      return new Date(now + ms).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = anchor + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

/**
 * Minimal scheduler queue interface. The scheduler no longer runs agents — it
 * only injects the task prompt into the chat as a regular message and pokes the
 * normal message queue. enqueueMessageCheck asks the host to run a message-pickup
 * pass for a chat so the injected prompt is processed immediately rather than
 * waiting for the next poll tick.
 */
export interface SchedulerQueue {
  enqueueMessageCheck(jid: string): void;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  queue: SchedulerQueue;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  logger.info({ taskId: task.id }, 'Injecting scheduled task prompt into chat');

  // Heartbeat tasks bake the group's HEARTBEAT.md instructions into the prompt
  // so the agent acts on them immediately — no file-read tool call needed.
  let prompt = task.prompt;
  if (task.id.startsWith('heartbeat-')) {
    try {
      const dir = resolveGroupFolderPath(task.group_folder || 'owner');
      const heartbeat = fs.readFileSync(`${dir}/HEARTBEAT.md`, 'utf-8').trim();
      if (heartbeat) {
        prompt = `[HEARTBEAT] Execute the following instructions:\n\n---\n${heartbeat}\n---\n\nBe efficient and concise.`;
      }
    } catch {
      // No HEARTBEAT.md — use the prompt as-is.
    }
  }

  // A schedule is just a prompt on a crontab. Inject it into the chat as a
  // regular message attributed to Automation; the normal message pipeline picks
  // it up, so the orchestrator and the user both see it — indistinguishable
  // from the user typing the prompt. Prefix the trigger word only when the
  // group requires one. The model is whatever the orchestrator is already
  // configured to use — tasks don't carry their own.
  const group = Object.values(deps.registeredGroups()).find(
    (g) => g.folder === (task.group_folder || 'owner'),
  );
  const content =
    group?.requiresTrigger && !TRIGGER_PATTERN.test(prompt)
      ? `@${ASSISTANT_NAME} ${prompt}`
      : prompt;

  // is_from_me:true marks it owner-side; is_bot_message:false (the default) so
  // the message loop's pending query — which filters is_bot_message = 0 — picks
  // it up. The agent's reply then lands in the chat like any other response.
  try {
    storeMessage({
      id: `automation-${task.id}-${Date.now()}`,
      chat_jid: task.chat_jid,
      sender: 'automation',
      sender_name: 'Automation',
      content,
      timestamp: new Date().toISOString(),
      is_from_me: true,
      is_bot_message: false,
    });
  } catch (err) {
    logger.warn({ taskId: task.id, err }, 'Failed to store Automation chat message');
  }

  // Poke the normal message queue so the injected prompt is processed now
  // rather than on the next poll tick.
  deps.queue.enqueueMessageCheck(task.chat_jid);

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: Date.now() - startTime,
    status: 'success',
    result: 'Prompt injected into chat',
    error: null,
  });

  const nextRun = computeNextRun(task);

  // One-time tasks auto-delete after firing; recurring tasks get next_run recomputed.
  if (task.schedule_type === 'once') {
    deleteTask(task.id);
    logger.info({ taskId: task.id }, 'One-time task auto-deleted after firing');
  } else {
    updateTaskAfterRun(task.id, nextRun, 'Prompt injected into chat');
  }
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      // Prune task-run logs every loop tick (cheap; getDueTasks runs frequently).
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        void runTask(currentTask, deps);
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  // Periodic housekeeping: prune task-run logs every 12 hours.
  setInterval(() => {
    try {
      const pruned = pruneTaskRunLogs(100);
      logger.info({ pruned }, 'Task logs pruned (12h cycle)');
    } catch (err) {
      logger.warn({ err }, 'Prune task logs failed');
    }
  }, 12 * 60 * 60 * 1000).unref();

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}