/**
 * Telegram channel — full rewrite (the previous implementation was
 * placeholder-grade). Single-user by design:
 *
 *  - PAIRING: the bot only talks to its owner. TELEGRAM_OWNER_ID in the env
 *    pins it explicitly; otherwise the first human to /start the bot gets
 *    paired and persisted (router_state 'telegram:owner_id'). Everyone else
 *    is politely refused — this bot can drive a whole computer.
 *  - THINKING: from the moment an owner message arrives until Warden's next
 *    reply is delivered, the chat shows the native "typing…" indicator, so
 *    the phone gets the same "it's working" feel as the dashboard. The
 *    orchestrator's task-announcement message arrives mid-turn as its own
 *    bubble (same double-message pattern as the dashboard).
 *  - MEDIA IN: voice notes are transcribed locally (Whisper) and fed to the
 *    agent as text; photos and documents are downloaded into
 *    WORKSPACE_ROOT/telegram-inbox/ and referenced by path so the agent can
 *    actually open them.
 *  - TEXT OUT: plain text (the orchestrator speaks, it doesn't format),
 *    chunked under Telegram's 4096 limit on paragraph boundaries, with 429
 *    retry-after honoured and one retry on transient network errors.
 *  - RESILIENCE: long-polling wrapped in an auto-restart loop with
 *    exponential backoff; a crash in grammy never takes the channel down
 *    for good.
 */
import fs from 'fs';
import path from 'path';
import { Bot, GrammyError, HttpError, InputFile } from 'grammy';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, NewMessage, OnInboundMessage } from '../types.js';
import { readEnvFile } from '../env.js';
import { getRouterState, setRouterState } from '../db.js';
import { WORKSPACE_ROOT } from '../config.js';
import { logger } from '../logger.js';

const JID_PREFIX = 'tg:';
const MAX_CHUNK = 4000; // headroom under Telegram's 4096 hard limit
const TYPING_INTERVAL_MS = 4500; // typing action expires after ~5s
const TYPING_MAX_MS = 5 * 60 * 1000;

function log(msg: string, extra?: object) {
  logger.info({ channel: 'telegram', ...(extra || {}) }, msg);
}
function warn(msg: string, extra?: object) {
  logger.warn({ channel: 'telegram', ...(extra || {}) }, msg);
}

/** Split text into chunks <= MAX_CHUNK, preferring paragraph then line breaks. */
function chunkText(text: string): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > MAX_CHUNK) {
    let cut = rest.lastIndexOf('\n\n', MAX_CHUNK);
    if (cut < MAX_CHUNK / 2) cut = rest.lastIndexOf('\n', MAX_CHUNK);
    if (cut < MAX_CHUNK / 2) cut = rest.lastIndexOf(' ', MAX_CHUNK);
    if (cut < MAX_CHUNK / 2) cut = MAX_CHUNK;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export class TelegramChannel implements Channel {
  name = 'telegram';
  private bot: Bot;
  private token: string;
  private inbound: OnInboundMessage = () => {};
  private connected = false;
  private stopping = false;
  private restartDelayMs = 1000;
  private ownerChatId: string | null = null;
  private typingTimer: ReturnType<typeof setInterval> | null = null;
  private typingSince = 0;

  constructor(token: string) {
    this.token = token;
    this.bot = new Bot(token);
    this.ownerChatId =
      readEnvFile(['TELEGRAM_OWNER_ID']).TELEGRAM_OWNER_ID ||
      getRouterState('telegram:owner_id') ||
      null;
    this.wireHandlers();
  }

  // ── pairing ────────────────────────────────────────────────────────────
  private isOwner(chatId: string): boolean {
    return this.ownerChatId !== null && this.ownerChatId === chatId;
  }

  private pair(chatId: string, name: string): void {
    this.ownerChatId = chatId;
    setRouterState('telegram:owner_id', chatId);
    log(`Paired with owner ${name} (chat ${chatId})`);
  }

  // ── typing indicator ───────────────────────────────────────────────────
  private startTyping(chatId: string): void {
    this.stopTyping();
    this.typingSince = Date.now();
    const send = () => {
      if (Date.now() - this.typingSince > TYPING_MAX_MS) { this.stopTyping(); return; }
      this.bot.api.sendChatAction(Number(chatId), 'typing').catch(() => {});
    };
    send();
    this.typingTimer = setInterval(send, TYPING_INTERVAL_MS);
    this.typingTimer.unref?.();
  }

  private stopTyping(): void {
    if (this.typingTimer) { clearInterval(this.typingTimer); this.typingTimer = null; }
  }

  // ── media download ─────────────────────────────────────────────────────
  private async downloadFile(fileId: string, suggestedName: string): Promise<string | null> {
    try {
      const f = await this.bot.api.getFile(fileId);
      if (!f.file_path) return null;
      const url = `https://api.telegram.org/file/bot${this.token}/${f.file_path}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      const root = WORKSPACE_ROOT.replace(/^~(?=\/|$)/, process.env.HOME ?? '');
      const dir = path.join(root, 'telegram-inbox');
      fs.mkdirSync(dir, { recursive: true });
      const safe = suggestedName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'file';
      const dest = path.join(dir, `${Date.now()}-${safe}`);
      fs.writeFileSync(dest, buf);
      return dest;
    } catch (err: any) {
      warn(`file download failed: ${err?.message ?? err}`);
      return null;
    }
  }

  private async transcribeVoice(fileId: string): Promise<string | null> {
    try {
      const f = await this.bot.api.getFile(fileId);
      if (!f.file_path) return null;
      const url = `https://api.telegram.org/file/bot${this.token}/${f.file_path}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      const { transcribeLocal } = await import('../transcription.js');
      return await transcribeLocal(buf);
    } catch (err: any) {
      warn(`voice transcription failed: ${err?.message ?? err}`);
      return null;
    }
  }

  // ── inbound wiring ─────────────────────────────────────────────────────
  private deliver(chatId: string, senderName: string, content: string): void {
    const msg: NewMessage = {
      id: `tg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chat_jid: JID_PREFIX + chatId,
      sender: JID_PREFIX + chatId,
      sender_name: senderName,
      content,
      timestamp: new Date().toISOString(),
      is_from_me: false,
    };
    this.startTyping(chatId); // agent is about to think — show it
    this.inbound(JID_PREFIX + chatId, msg);
  }

  private wireHandlers(): void {
    this.bot.command('start', async (ctx) => {
      const chatId = String(ctx.chat.id);
      const name = ctx.from?.first_name || 'owner';
      if (!this.ownerChatId) {
        this.pair(chatId, name);
        await ctx.reply(`Paired. This device is now Warden's owner — just talk to me like you do on the dashboard.`);
        return;
      }
      if (this.isOwner(chatId)) {
        await ctx.reply(`Already paired and listening.`);
      } else {
        await ctx.reply(`This is a private assistant and it's already paired to its owner.`);
      }
    });

    this.bot.command('ping', async (ctx) => {
      if (this.isOwner(String(ctx.chat.id))) await ctx.reply('pong — channel alive.');
    });

    this.bot.on('message', async (ctx) => {
      const chatId = String(ctx.chat.id);
      const name = ctx.from?.first_name || 'user';
      if (!this.ownerChatId) {
        await ctx.reply(`Not paired yet — send /start to claim this bot.`);
        return;
      }
      if (!this.isOwner(chatId)) {
        warn(`Ignored message from non-owner chat ${chatId}`);
        return;
      }
      const m = ctx.message;

      if (m.text) {
        this.deliver(chatId, name, m.text);
        return;
      }
      if (m.voice || m.audio) {
        const fileId = (m.voice || m.audio)!.file_id;
        const transcript = await this.transcribeVoice(fileId);
        if (transcript && transcript.trim()) {
          this.deliver(chatId, name, transcript.trim());
        } else {
          await ctx.reply(`Couldn't transcribe that voice note — mind typing it?`);
        }
        return;
      }
      if (m.photo && m.photo.length > 0) {
        const largest = m.photo[m.photo.length - 1];
        const saved = await this.downloadFile(largest.file_id, 'photo.jpg');
        const caption = m.caption || 'Look at this image.';
        this.deliver(chatId, name, saved ? `${caption}\n[Image saved: ${saved}]` : caption);
        return;
      }
      if (m.document) {
        const saved = await this.downloadFile(m.document.file_id, m.document.file_name || 'document');
        const caption = m.caption || `I sent you a file.`;
        this.deliver(chatId, name, saved ? `${caption}\n[File saved: ${saved}]` : caption);
        return;
      }
      // Stickers, locations, etc. — acknowledge so the user isn't ghosted.
      await ctx.reply(`I can handle text, voice notes, photos, and files here.`);
    });

    // grammy-level error trap: log, never crash the process.
    this.bot.catch((err) => {
      const e = err.error;
      if (e instanceof GrammyError) warn(`Telegram API error: ${e.description}`);
      else if (e instanceof HttpError) warn(`Telegram network error: ${e.message}`);
      else warn(`Telegram handler error: ${(e as Error)?.message ?? e}`);
    });
  }

  // ── polling lifecycle with auto-restart ────────────────────────────────
  private startPolling(): void {
    if (this.stopping) return;
    this.bot
      .start({
        drop_pending_updates: true,
        onStart: (me) => {
          this.connected = true;
          this.restartDelayMs = 1000;
          log(`Telegram channel ready as @${me.username}${this.ownerChatId ? ` (owner ${this.ownerChatId})` : ' — awaiting /start pairing'}`);
        },
      })
      .catch((err) => {
        this.connected = false;
        if (this.stopping) return;
        warn(`Polling crashed: ${err?.message ?? err} — restarting in ${this.restartDelayMs / 1000}s`);
        setTimeout(() => this.startPolling(), this.restartDelayMs).unref?.();
        this.restartDelayMs = Math.min(this.restartDelayMs * 2, 60_000);
      });
  }

  // ── Channel interface ──────────────────────────────────────────────────
  onMessage(cb: OnInboundMessage): void {
    this.inbound = cb;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    this.startPolling();
  }

  async disconnect(): Promise<void> {
    this.stopping = true;
    this.stopTyping();
    try { await this.bot.stop(); } catch { /* already stopped */ }
    this.connected = false;
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.ownsJid(jid)) return;
    const chatId = jid.slice(JID_PREFIX.length);
    if (isTyping) this.startTyping(chatId);
    else this.stopTyping();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Outbound goes to the owner chat. Accept tg:-jids and, for messages
    // originating elsewhere (owner@local scheduler results etc.), fall back
    // to the paired owner so reminders reach the phone too.
    const chatId = this.ownsJid(jid) ? jid.slice(JID_PREFIX.length) : this.ownerChatId;
    if (!chatId) return;
    this.stopTyping(); // a reply is going out — thinking is over

    // [Image: <path>] refs → send as Telegram photos (with the surrounding
    // text as the caption) so alert frames show up on the phone. Path is
    // repo-relative; resolve from the Warden cwd.
    const imgRe = /\[Image:\s*([^\]]+)\]/gi;
    const images: string[] = [];
    let mm: RegExpExecArray | null;
    while ((mm = imgRe.exec(text)) !== null) images.push(mm[1].trim());
    const caption = text.replace(imgRe, '').trim();

    if (images.length > 0) {
      for (const rel of images) {
        const abs = path.isAbsolute(rel) ? rel : path.resolve(process.cwd(), rel);
        if (!fs.existsSync(abs)) { warn(`sendPhoto: image not found: ${abs}`); continue; }
        let attempt = 0;
        for (;;) {
          try {
            await this.bot.api.sendPhoto(Number(chatId), new InputFile(abs), {
              caption: caption.slice(0, 1024) || undefined,
            });
            break;
          } catch (err: any) {
            const retryAfter = err instanceof GrammyError ? err.parameters?.retry_after : undefined;
            if (retryAfter && attempt < 3) {
              attempt++;
              await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
              continue;
            }
            if (attempt < 1) { attempt++; await new Promise((r) => setTimeout(r, 1500)); continue; }
            warn(`sendPhoto failed permanently: ${err?.message ?? err}`);
            break;
          }
        }
      }
      // Any caption text beyond Telegram's 1024-char limit → follow-up text.
      if (caption.length > 1024) {
        for (const chunk of chunkText(caption.slice(1024))) {
          try { await this.bot.api.sendMessage(Number(chatId), chunk, { link_preview_options: { is_disabled: true } }); }
          catch (err: any) { warn(`caption follow-up failed: ${err?.message ?? err}`); }
        }
      }
      return;
    }

    const chunks = chunkText(text);
    for (const chunk of chunks) {
      let attempt = 0;
      for (;;) {
        try {
          await this.bot.api.sendMessage(Number(chatId), chunk, {
            link_preview_options: { is_disabled: true },
          });
          break;
        } catch (err: any) {
          // Rate limited: Telegram tells us exactly how long to wait.
          const retryAfter = err instanceof GrammyError ? err.parameters?.retry_after : undefined;
          if (retryAfter && attempt < 3) {
            attempt++;
            await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
            continue;
          }
          if (attempt < 1) { // one retry for transient network errors
            attempt++;
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
          warn(`sendMessage failed permanently: ${err?.message ?? err}`);
          return;
        }
      }
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token = process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  const channel = new TelegramChannel(token);
  channel.onMessage(opts.onMessage);
  void channel.connect();
  return channel;
});
