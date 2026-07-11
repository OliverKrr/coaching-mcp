import { randomToken } from "./auth/db.js";

/**
 * Minimal Telegram Bot API client for operator notifications with inline
 * approve/reject buttons, plus opt-in user notifications. `TELEGRAM_API_BASE`
 * exists for tests only (mock API on 127.0.0.1); production always talks to
 * https://api.telegram.org.
 *
 * The webhook secret is regenerated on every boot — `setWebhook` is atomic and
 * idempotent, so the freshly announced secret is the only one Telegram will
 * send from then on. No secret ever needs to be configured or persisted.
 */

export type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;

export type TelegramUpdate = {
  message?: {
    message_id: number;
    from?: { id: number };
    chat: { id: number; type: string };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message?: { message_id: number; chat: { id: number }; text?: string };
    data?: string;
  };
};

export class TelegramBot {
  readonly adminChatId: string;
  readonly webhookSecret = randomToken();
  /** Bot username from getMe — needed for t.me deep links; set by setup(). */
  username: string | undefined;
  private readonly apiBase: string;
  private readonly log: (msg: string) => void;

  constructor(opts: {
    token: string;
    adminChatId: string;
    apiBase?: string;
    log: (msg: string) => void;
  }) {
    this.adminChatId = opts.adminChatId;
    this.apiBase = `${(opts.apiBase ?? "https://api.telegram.org").replace(/\/+$/, "")}/bot${opts.token}`;
    this.log = opts.log;
  }

  /** Call once on boot: resolve the bot username and announce the webhook. */
  async setup(publicUrl: string): Promise<void> {
    const me = (await this.api("getMe", {})) as { username?: string };
    this.username = me.username;
    await this.api("setWebhook", {
      url: `${publicUrl}/telegram/webhook`,
      secret_token: this.webhookSecret,
      allowed_updates: ["message", "callback_query"],
    });
    this.log(`telegram: webhook registered for @${this.username ?? "?"}`);
  }

  /** t.me opt-in deep link for a link token; undefined until setup() ran. */
  deepLink(token: string): string | undefined {
    return this.username ? `https://t.me/${this.username}?start=${token}` : undefined;
  }

  async sendMessage(chatId: string, text: string, keyboard?: InlineKeyboard): Promise<void> {
    await this.api("sendMessage", {
      chat_id: chatId,
      text,
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
  }

  /** Edit a sent message in place — the chat doubles as the audit trail. */
  async editMessageText(chatId: number, messageId: number, text: string): Promise<void> {
    await this.api("editMessageText", { chat_id: chatId, message_id: messageId, text });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.api("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  }

  private async api(method: string, payload: object): Promise<unknown> {
    const res = await fetch(`${this.apiBase}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: unknown;
      description?: string;
    };
    if (!res.ok || body.ok !== true) {
      throw new Error(`telegram ${method} failed: ${body.description ?? res.status}`);
    }
    return body.result;
  }
}
