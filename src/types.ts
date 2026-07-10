export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/dockbox/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

// The single chat key for the owner. All messages, tasks, and chats use this JID
// in the single-user Warden architecture.
export const OWNER_JID = 'owner@local';

export interface AgentInput {
  prompt: string;
  orchestratorModel?: string; // Warden (orchestrator) model
  model?: string;             // Atlas/Artemis model
  councilSkepticModel?: string;     // Council Skeptic seat model (optional, falls back to model)
  councilPragmatistModel?: string;   // Council Pragmatist seat model
  councilSynthesistModel?: string;  // Council Synthesist seat model
  sessionId: string;          // single session, constant
  workspaceRoot: string;
  history: NewMessage[];      // recent messages for context
  timeoutMs: number;
  memoryContext?: string;
  showThinking?: boolean | string;
  verbose?: boolean;
}

export interface AgentOutput {
  text: string;
  exitCode: number;
  durationMs: number;
  error?: string;
  userStopped?: boolean;
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  idea?: string;
}

export interface ScheduledTask {
  id: string;
  /** Legacy multi-group column, dropped in the single-user schema. Kept optional for rows/objects that still carry it. */
  group_folder?: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  sendMessage(jid: string, text: string, senderName?: string): Promise<void>;
  onMessage(cb: OnInboundMessage): void;
  // Optional methods retained by channel implementations that support them.
  // Callers must guard with `if (channel.ownsJid)` / optional chaining.
  ownsJid?(jid: string): boolean;
  isConnected?(): boolean;
  disconnect?(): Promise<void>;
  connect?(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  syncGroupMetadata?(force?: boolean): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
