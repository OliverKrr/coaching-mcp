import type { User } from "./auth/db.js";
import type { InlineKeyboard, TelegramBot } from "./telegram.js";

/**
 * Operator + user notifications. Two optional channels: a plain fire-and-forget
 * webhook (`NOTIFY_URL` — any service accepting a text POST) and a Telegram bot
 * (interactive: admin messages carry inline approve/reject/grant buttons; the
 * callbacks land on /telegram/webhook). Every send is best-effort — a failed
 * notification is logged and must never break a login or a write. The admin
 * page remains the source of truth either way.
 */
export class NotifyService {
  constructor(
    private readonly log: (msg: string) => void,
    readonly telegram: TelegramBot | undefined,
    private readonly webhookUrl: string | undefined,
  ) {}

  get configured(): boolean {
    return this.telegram !== undefined || this.webhookUrl !== undefined;
  }

  /** New self-registration → admin, with Approve/Reject buttons on Telegram. */
  signupRequest(user: User): void {
    const text = `New coaching access request:\n${user.name ? `${user.name} — ` : ""}${user.email}`;
    this.toAdmin(text, [
      [
        { text: "✅ Approve", callback_data: `approve:${user.id}` },
        { text: "❌ Reject", callback_data: `reject:${user.id}` },
      ],
    ]);
  }

  /** Quota-increase request → admin, with grant presets on Telegram. */
  quotaRequest(user: User, reason: string, usageBytes: number, currentQuotaMb: number): void {
    const usageMb = (usageBytes / (1024 * 1024)).toFixed(1);
    const half = Math.ceil(currentQuotaMb * 1.5);
    const double = currentQuotaMb * 2;
    const text =
      `Storage quota request from ${user.email}:\n"${reason}"\n` +
      `Currently using ${usageMb} MB of ${currentQuotaMb} MB.`;
    this.toAdmin(text, [
      [
        { text: `Grant ${half} MB`, callback_data: `quota:${user.id}:${half}` },
        { text: `Grant ${double} MB`, callback_data: `quota:${user.id}:${double}` },
        { text: "Ignore", callback_data: `quotaignore:${user.id}` },
      ],
    ]);
  }

  /** Approval → the user, if they opted in via the Telegram deep link. */
  userApproved(user: User, publicUrl: string): void {
    this.toUser(
      user,
      `Your coaching access was approved. Connect your assistant at ${publicUrl}/ — the guide there walks you through it.`,
    );
  }

  /** Quota grant → the user, if linked. */
  quotaGranted(user: User, newQuotaMb: number): void {
    this.toUser(user, `Your storage quota was raised to ${newQuotaMb} MB.`);
  }

  private toAdmin(text: string, keyboard: InlineKeyboard): void {
    if (this.webhookUrl) {
      const url = this.webhookUrl;
      fetch(url, {
        method: "POST",
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: text,
      }).catch((err: unknown) => {
        this.log(`notify webhook failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    if (this.telegram) {
      this.telegram.sendMessage(this.telegram.adminChatId, text, keyboard).catch((err: unknown) => {
        this.log(`telegram notify failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  private toUser(user: User, text: string): void {
    if (!this.telegram || !user.telegram_chat_id) return;
    this.telegram.sendMessage(user.telegram_chat_id, text).catch((err: unknown) => {
      this.log(`telegram user notify failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}
