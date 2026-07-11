import type { IncomingMessage, ServerResponse } from "node:http";
import {
  consumeTelegramLinkToken,
  deleteQuotaRequest,
  findUserByTelegramChat,
  setUserTelegramChat,
} from "./auth/db.js";
import type { ServeContext } from "./context.js";
import { readBody, sendJson } from "./http-util.js";
import { approveUser, grantQuota, rejectUser } from "./membership.js";
import {
  contentBytes,
  quotaBytesForUser,
  quotaExceededMessage,
  TELEGRAM_CAPTURES_PER_HOUR,
} from "./quota.js";
import { RateLimiter } from "./ratelimit.js";
import type { TelegramBot, TelegramUpdate } from "./telegram.js";

/** Per-user quick-capture budget, shared across the process like authRateLimiter. */
const captureRateLimiter = new RateLimiter(TELEGRAM_CAPTURES_PER_HOUR, 60 * 60 * 1000);

/**
 * POST /telegram/webhook — updates from the Telegram Bot API. Two layers of
 * authentication: the per-boot secret announced via setWebhook (header) proves
 * the sender is Telegram, and admin actions additionally require the callback
 * to come from the operator's own chat id. Always ends 200 once authenticated,
 * because Telegram retries anything else.
 */
export async function handleTelegramWebhook(
  ctx: ServeContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const bot = ctx.notify.telegram;
  if (!bot) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  if (req.headers["x-telegram-bot-api-secret-token"] !== bot.webhookSecret) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  let update: TelegramUpdate;
  try {
    update = JSON.parse(await readBody(req)) as TelegramUpdate;
  } catch {
    sendJson(res, 400, { error: "invalid_body" });
    return;
  }

  try {
    if (update.callback_query) await handleCallback(ctx, bot, update.callback_query);
    else if (update.message) await handleMessage(ctx, bot, update.message);
  } catch (err) {
    ctx.log(`telegram webhook error: ${err instanceof Error ? err.message : String(err)}`);
  }
  sendJson(res, 200, { ok: true });
}

async function handleCallback(
  ctx: ServeContext,
  bot: TelegramBot,
  cq: NonNullable<TelegramUpdate["callback_query"]>,
): Promise<void> {
  // Only the operator's own chat may drive membership transitions.
  if (String(cq.from.id) !== bot.adminChatId) {
    ctx.log(`telegram callback from non-admin chat ${cq.from.id} ignored`);
    await bot.answerCallbackQuery(cq.id).catch(() => {});
    return;
  }
  const outcome = applyCallbackAction(ctx, cq.data ?? "");
  await bot.answerCallbackQuery(cq.id, outcome).catch(() => {});
  if (cq.message) {
    const text = `${cq.message.text ?? ""}\n\n${outcome} — ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`;
    await bot.editMessageText(cq.message.chat.id, cq.message.message_id, text).catch(() => {});
  }
}

function applyCallbackAction(ctx: ServeContext, data: string): string {
  const approve = /^approve:(u_[0-9a-f]+)$/.exec(data);
  if (approve) {
    const user = approveUser(ctx, approve[1] as string);
    return user ? `✅ Approved ${user.email}` : "User no longer exists";
  }
  const reject = /^reject:(u_[0-9a-f]+)$/.exec(data);
  if (reject) {
    const user = rejectUser(ctx, reject[1] as string);
    return user ? `❌ Rejected ${user.email}` : "User no longer exists";
  }
  const quota = /^quota:(u_[0-9a-f]+):(\d{1,6})$/.exec(data);
  if (quota) {
    const mb = Number(quota[2]);
    const user = grantQuota(ctx, quota[1] as string, mb);
    return user ? `✅ Granted ${mb} MB to ${user.email}` : "User no longer exists";
  }
  const ignore = /^quotaignore:(u_[0-9a-f]+)$/.exec(data);
  if (ignore) {
    deleteQuotaRequest(ctx.authDb, ignore[1] as string);
    return "Request dismissed";
  }
  return "Unknown action";
}

async function handleMessage(
  ctx: ServeContext,
  bot: TelegramBot,
  msg: NonNullable<TelegramUpdate["message"]>,
): Promise<void> {
  if (msg.chat.type !== "private") return;
  const chatId = String(msg.chat.id);

  if (msg.text?.startsWith("/start")) {
    const token = msg.text.split(" ")[1];
    const userId = token ? consumeTelegramLinkToken(ctx.authDb, token) : undefined;
    if (userId) {
      setUserTelegramChat(ctx.authDb, userId, chatId);
      ctx.log(`telegram linked for ${userId}`);
      await bot.sendMessage(
        chatId,
        "Connected. You will get a message here about your access and storage quota, and your coach can send you check-in summaries. Anything you write me lands in your coaching journal for the next session.",
      );
    } else {
      await bot.sendMessage(
        chatId,
        "This bot delivers notifications for a coaching server. To connect your account, use the personal link shown on the server's pages — this one is missing or expired.",
      );
    }
    return;
  }

  await captureToJournal(ctx, bot, chatId, msg.text);
}

/**
 * Quick capture: a plain text from a linked, active user is appended to their
 * coaching journal — an LLM-free inbox the coach reads at the next session
 * start. Everything else gets a short explanation instead of silence.
 */
async function captureToJournal(
  ctx: ServeContext,
  bot: TelegramBot,
  chatId: string,
  text: string | undefined,
): Promise<void> {
  const user = findUserByTelegramChat(ctx.authDb, chatId);
  if (!user) {
    await bot.sendMessage(
      chatId,
      "This chat is not connected to a coaching account. Use the personal link on the server's pages to connect it.",
    );
    return;
  }
  if (user.status !== "active") {
    await bot.sendMessage(chatId, "Your coaching access is not active — nothing was saved.");
    return;
  }
  if (!text?.trim() || text.startsWith("/")) {
    await bot.sendMessage(
      chatId,
      "Send me a plain text message and I will save it to your coaching journal — your coach reads it at the next session. (Photos and commands are not supported.)",
    );
    return;
  }
  if (!captureRateLimiter.allowKey(user.id)) {
    await bot.sendMessage(
      chatId,
      `Capture limit reached (${TELEGRAM_CAPTURES_PER_HOUR}/hour) — try again later.`,
    );
    return;
  }
  const entry = `[via Telegram] ${text.trim()}`;
  const db = ctx.tenants.open(user.id);
  const usage = contentBytes(db);
  const quotaBytes = quotaBytesForUser(user, ctx.cfg.quotaDefaultMb);
  if (usage + entry.length > quotaBytes) {
    await bot.sendMessage(chatId, `Not saved — ${quotaExceededMessage(usage, quotaBytes)}`);
    return;
  }
  db.prepare("INSERT INTO journal(entry) VALUES (?)").run(entry);
  ctx.log(`telegram capture saved for ${user.id}`);
  await bot.sendMessage(
    chatId,
    "Saved to your coaching journal — your coach will see it at the next session.",
  );
}
