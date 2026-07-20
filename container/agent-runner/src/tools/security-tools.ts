import { registry } from '../tool-registry.js';
import { writeCallbackAsync } from '../index.js';

async function callHost(tool: string, args: any, timeoutMs = 10000): Promise<any> {
    try {
        return await writeCallbackAsync(tool, args, timeoutMs);
    } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
    }
}

// Security Mode tools (Heimdall, the background security agent). The standalone
// detector app holds an alert OPEN until Warden closes it; close_security_alert
// re-arms it. alert_security is the MOCK external-escalation call (no real guard
// service yet — it just acknowledges it would alert them). send_message lets
// Heimdall tell the user about an abnormal alert. get_time + security_log let it
// reference events by exact time and persist/query a conditions history.

registry.register({
    name: 'dismiss_security_flag',
    description:
        "Dismiss a flagged review and re-arm the detector. Call this ONCE, ONLY when you DECLARE " +
        "the flagged detection NORMAL (a non-event) — it clears the flag so the detector can review " +
        "the next detection. This does NOT close a spawned alert — you cannot close alerts; only " +
        "the guard at the keyboard can (STAND DOWN button). Never call this on an abnormal alert.",
    schema: { type: 'object', properties: {} },
    handler: async (_args, _context) => {
        const resp = await callHost('close_security_alert', {});
        if (resp?.ok) return 'Flag dismissed — detector re-armed.';
        return `Could not dismiss flag: ${resp?.error || 'security app not reachable'}`;
    },
    toolset: 'security',
    tier: 'public',
});

registry.register({
    name: 'alert_security',
    description:
        "Escalate the current security alert to the security service (a call-to-action for a real " +
        "guard/response). Call this when you have judged the alert ABNORMAL and want to raise the " +
        "alarm. NOTE: this is currently a MOCK stub — there is no real security service wired yet, " +
        "so this call does not actually contact anyone; it just acknowledges the escalation. Call " +
        "it for real regardless so the escalation path is exercised.",
    schema: {
        type: 'object',
        properties: {
            reason: { type: 'string', description: 'Why you are escalating (what is abnormal).' },
        },
        required: ['reason'],
    },
    handler: async (args, _context) => {
        const reason = String(args?.reason || '').trim();
        // MOCK — no external call is made yet. The tool exists so Heimdall calls
        // it for real and the escalation path is wired; swap the body for a real
        // HTTP call to a guard/dispatch service when one exists.
        return `Mock Alert: If there were security guards I would be alerting them now.${reason ? ` (reason: ${reason})` : ''}`;
    },
    toolset: 'security',
    tier: 'public',
});

registry.register({
    name: 'open_security_alert',
    description:
        "Spawn the security alert on the detector: opens the red STAND DOWN button + flips the " +
        "detector to ALERTED. Call this ONCE, only when you DECLARE the flagged detection ABNORMAL, " +
        "after alert_security and send_message. Do NOT call it for a normal/non-event. The alert " +
        "then stays open until the guard at the keyboard presses STAND DOWN.",
    schema: {
        type: 'object',
        properties: {
            reason: { type: 'string', description: 'Why this is an alert (abnormal).' },
        },
    },
    handler: async (args, _context) => {
        const resp = await callHost('open_security_alert', { reason: String(args?.reason || '') });
        if (resp?.ok) return 'Security alert opened on the detector (red button).';
        return `Could not open security alert: ${resp?.error || 'detector app not reachable'}`;
    },
    toolset: 'security',
    tier: 'public',
});

registry.register({
    name: 'save_known_person',
    description:
        "Save a keyframe for a person you RECOGNIZE as normal (e.g. the owner) so the detector " +
        "skips flagging them in future — no Heimdall round-trip for known people. Call this ONCE, " +
        "ONLY on a NORMAL verdict, with a label (e.g. 'owner') and the frame_path of the alert " +
        "frame (the [Image: ...] path from the task, e.g. 'groups/owner/attachments/sec-<ts>.jpg'). " +
        "The detector pHash-compares new frames to saved keyframes and skips flagging matches. " +
        "Do NOT call this for an abnormal/unknown person.",
    schema: {
        type: 'object',
        properties: {
            label: { type: 'string', description: 'A name for this person, e.g. "owner".' },
            frame_path: { type: 'string', description: 'The alert frame path from the task [Image: ...].' },
        },
        required: ['label', 'frame_path'],
    },
    handler: async (args, _context) => {
        const resp = await callHost('save_known_person', {
            label: String(args?.label || ''),
            frame_path: String(args?.frame_path || ''),
        });
        if (resp?.ok) return `Saved known person "${args?.label}" — the detector will skip flagging them.`;
        return `Could not save known person: ${resp?.error || 'unknown error'}`;
    },
    toolset: 'security',
    tier: 'public',
});

// Orchestrator → Heimdall direct. The orchestrator calls this to pass a message
// to the Heimdall security agent (e.g. "the person with glasses is the owner,
// normal") instead of routing through Atlas. Heimdall records it in security_log
// as context for future reviews. tier:'public' + toolset 'chat' keeps it
// orchestrator-only (sub-agents don't include 'chat'; 'public' keeps it out of
// BOTH_TOOL_DEFS so it doesn't leak to sub-agents).
registry.register({
    name: 'tell_heimdall',
    description:
        "Send a message directly to Heimdall, the background security agent. Use this when the " +
        "user wants to tell the security agent something (e.g. 'the person with glasses is the " +
        "owner — that's normal', or a fact about the space) so Heimdall records it and factors it " +
        "into future alert decisions. Do NOT use Atlas or other agents for security-agent " +
        "communication — use this. Heimdall records the message silently; it will not reply in " +
        "the chat. Returns confirmation.",
    schema: {
        type: 'object',
        properties: {
            message: { type: 'string', description: 'The message to pass to Heimdall.' },
        },
        required: ['message'],
    },
    handler: async (args, _context) => {
        const resp = await callHost('tell_heimdall', { message: String(args?.message || '') });
        if (resp?.ok) return `Told Heimdall: ${String(args?.message || '').slice(0, 120)}. It will record this for future reviews.`;
        return `Could not reach Heimdall: ${resp?.error || 'unknown error'}`;
    },
    toolset: 'chat',
    tier: 'public',
});

registry.register({
    name: 'send_message',
    description:
        "Send a message to the user (or another chat) immediately. Use this to tell the user about " +
        "an ABNORMAL security alert — concisely, what you saw and whether they should be concerned. " +
        "Do NOT use this for normal/non-events (die silently).",
    schema: {
        type: 'object',
        properties: {
            text: { type: 'string', description: 'The message text to send.' },
            target_jid: { type: 'string', description: 'Optional target chat jid; defaults to the owner chat.' },
            sender: { type: 'string', description: 'Optional sender identity name (e.g. "Heimdall").' },
        },
        required: ['text'],
    },
    handler: async (args, _context) => {
        const resp = await callHost('send_message', {
            text: String(args?.text || ''),
            target_jid: args?.target_jid,
            sender: args?.sender || 'Heimdall',
        });
        if (resp?.ok) return 'Message sent.';
        return `send_message failed: ${resp?.error || 'unknown error'}`;
    },
    toolset: 'security',
    tier: 'public',
});

registry.register({
    name: 'security_log',
    description:
        "Record or query Heimdall's security-conditions log (a persistent sqlite store of every " +
        "alert assessment, by time). ACTION 'record': append a row {timestamp, alert_ts, assessment " +
        "('normal'|'abnormal'), condition, escalated (bool)}. ACTION 'query': return rows within an " +
        "optional since/until local-time range (YYYY-MM-DDTHH:MM:SS), newest-first, up to limit. Use " +
        "this to keep a dated history of what happened and to look back by time/date.",
    schema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['record', 'query'], description: "'record' to append, 'query' to read." },
            assessment: { type: 'string', enum: ['normal', 'abnormal'], description: "record: your judgment." },
            condition: { type: 'string', description: "record: what you saw (e.g. 'owner at desk', 'unknown person', 'camera covered')." },
            alert_ts: { type: 'string', description: "record: the alert timestamp from the task." },
            escalated: { type: 'boolean', description: "record: whether you called alert_security." },
            since: { type: 'string', description: "query: lower bound local time (YYYY-MM-DDTHH:MM:SS)." },
            until: { type: 'string', description: "query: upper bound local time (YYYY-MM-DDTHH:MM:SS)." },
            limit: { type: 'number', description: "query: max rows (default 50)." },
        },
        required: ['action'],
    },
    handler: async (args, _context) => {
        const resp = await callHost('security_log', args || {});
        if (resp?.ok) {
            if ((args as any)?.action === 'query') return resp.summary || 'No matching rows.';
            return 'Logged.';
        }
        return `security_log failed: ${resp?.error || 'unknown error'}`;
    },
    toolset: 'security',
    tier: 'public',
});