import type { IncomingMessage, ServerResponse } from "node:http";
import { webAuth } from "./account.js";
import type { ServeContext } from "./context.js";
import { htmlEscape, sendHtml } from "./http-util.js";
import { pickLang, type Lang } from "./web/i18n.js";
import { page } from "./web/layout.js";
import { badge, copyBox } from "./web/ui.js";
import { allRoutineTemplates } from "./topics.js";
import { REPO_URL } from "./version.js";

/**
 * Public landing page = the setup guide new users need to get from "invited"
 * to "coached". Bilingual (English/German); the choice persists via the lang
 * cookie (web/i18n.ts). Operators share exactly one URL — this page. Signed-in
 * visitors are recognized (web session cookie) so the nav and the routines
 * page center on them.
 */

export function renderLanding(
  ctx: ServeContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): void {
  const base = ctx.cfg.publicUrl;
  const lang = pickLang(req, url);
  const t = lang === "de" ? DE : EN;

  const projectInstructions =
    lang === "de"
      ? `Du bist mein persönlicher Coach. Dein gesamtes Coaching-Wissen liegt im
Coaching-MCP-Connector — nicht in diesem Prompt.

Zu Beginn JEDER Session — nicht verhandelbar:
1. Rufe zuerst get_coaching_context auf und folge exakt der dort beschriebenen Arbeitsweise.
2. Rufe list_open_items auf und geh offene Punkte durch, bevor du coachst.
3. Wenn der Connector nicht erreichbar ist, sag das offen — improvisiere kein Coaching aus dem
   Chat-Gedächtnis.

Datums-Anker: Nimm niemals ein Datum an. Bestätige das heutige Datum (frag mich zur Not), bevor
du irgendetwas planst, und nenne bei Wochenplänen jeden Tag mit Kalenderdatum.`
      : `You are my personal coach. All of your coaching knowledge lives in the coaching
MCP connector — not in this prompt.

At the start of EVERY session — non-negotiable:
1. Call get_coaching_context first and follow its operating procedure exactly.
2. Call list_open_items and review open items before coaching.
3. If the connector is unreachable, say so openly — never improvise coaching from chat memory.

Date anchor: never assume a date. Confirm today's date (ask me if needed) before any planning,
and name every day with its calendar date in weekly plans.`;

  sendHtml(
    res,
    200,
    page(
      t.title,
      `<h1>${t.title}</h1>
<p>${t.intro}</p>

<div class="card">
<h2>${t.setupTitle}</h2>
<ol>
<li>${t.step1}</li>
<li>${t.step2}<br><code class="selectall">${htmlEscape(base)}</code></li>
<li>${t.step3}</li>
<li>${t.step4}</li>
<li>${t.step5}</li>
</ol>
</div>

<div class="card">
<h2>${t.projectTitle}</h2>
<p>${t.projectIntro}</p>
${copyBox(projectInstructions)}
</div>

<div class="card">
<h2>${t.optionalTitle}</h2>
<ul>
<li>${t.optionalFitness}</li>
<li>${t.optionalHevy}</li>
</ul>
</div>

<div class="card">
<h2>${t.telegramTitle}</h2>
<p>${t.telegramIntro}</p>
<ol>
<li>${t.telegramStep1.replace("%ACCOUNT%", `${base}/account`)}</li>
<li>${t.telegramStep2}</li>
<li>${t.telegramStep3}</li>
</ol>
<p class="muted">${t.telegramNote}</p>
</div>

<div class="card">
<h2>${t.routinesTitle}</h2>
<p>${t.routinesBody} <a href="${base}/routines?lang=${lang}">${htmlEscape(base.replace(/^https?:\/\//, ""))}/routines</a></p>
</div>

<div class="card">
<h2>${t.dataTitle}</h2>
<p>${t.dataBody} <a href="${base}/account">${htmlEscape(base.replace(/^https?:\/\//, ""))}/account</a></p>
</div>

<p class="muted">${t.footer} ${t.openSource.replace("%REPO%", `<a href="${REPO_URL}" target="_blank" rel="noopener noreferrer">GitHub</a>`)}</p>`,
      { nav: { base, active: "guide", lang, signedIn: webAuth(ctx, req) !== undefined, path: "" } },
    ),
  );
}

/**
 * /routines — how scheduled check-ins work, plus the topic packs' templates
 * (English masters) as reference material. A user's own routines — designed in
 * conversation, in their language — live on their account page.
 */
export function renderRoutines(
  ctx: ServeContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): void {
  const base = ctx.cfg.publicUrl;
  const lang = pickLang(req, url);
  const t = lang === "de" ? DE : EN;
  const auth = webAuth(ctx, req);

  let ownSection = "";
  if (auth) {
    const rows = ctx.tenants
      .open(auth.userId)
      .prepare(
        "SELECT name, cadence, prompt, status, updated_at FROM routines ORDER BY (status != 'active'), name",
      )
      .all() as Array<{
      name: string;
      cadence: string;
      prompt: string;
      status: string;
      updated_at: string;
    }>;
    const ownCards = rows
      .map(
        (r) => `<div class="card">
<p><strong>${htmlEscape(r.name)}</strong> ${badge(r.status === "active" ? "ok" : "muted", r.status)} <span class="muted">· ${htmlEscape(r.cadence)}</span> — <a href="${base}/account/data/routines/edit?name=${encodeURIComponent(r.name)}">${t.ownEdit}</a><br>
<span class="muted">${t.ownUpdated} ${htmlEscape(r.updated_at)} UTC — ${t.ownUpdatedHint}</span></p>
<details><summary class="muted">${t.ownShowPrompt}</summary>${copyBox(r.prompt)}</details>
</div>`,
      )
      .join("\n");
    ownSection = `<h2>${t.ownTitle}</h2>
<p class="muted">${t.ownIntro}</p>
${ownCards || `<p class="muted">${t.ownNone}</p>`}
<h2>${t.howTitle}</h2>`;
  }

  const cards = allRoutineTemplates(ctx.cfg.seedDir)
    .map(
      (r) => `<div class="card">
<details>
<summary><strong>${htmlEscape(r.title)}</strong> <span class="muted">(${htmlEscape(r.packId)})</span> — <span class="muted">${htmlEscape(r.cadence)}</span></summary>
${copyBox(r.body)}
</details>
</div>`,
    )
    .join("\n");

  sendHtml(
    res,
    200,
    page(
      t.routinesTitle,
      `<h1>${t.routinesTitle}</h1>
${ownSection}
<p>${t.routinesIntro}</p>
<ol>
<li>${t.routinesStep1}</li>
<li>${t.routinesStep2}</li>
<li>${t.routinesStep3}</li>
</ol>
<p class="muted">${t.routinesFooter}</p>
<h2>${t.routinesTemplatesTitle}</h2>
<p class="muted">${t.routinesTemplatesIntro}</p>
${cards || `<p class="muted">${t.routinesNoTemplates}</p>`}`,
      { nav: { base, active: "routines", lang, signedIn: auth !== undefined, path: "/routines" } },
    ),
  );
}

const EN = {
  title: "Your AI coaching hub",
  intro:
    "A personal coaching memory for Claude — training, nutrition, or any life topic you pick: your goals, plans, journal, and open items — private, per person, editable by you. Access is per person: request it with your first sign-in, the operator approves.",
  setupTitle: "Set up in five steps",
  step1:
    "<strong>Request access.</strong> The first time you sign in with Google (next two steps), your access request goes to the operator of this server — you'll see a confirmation page. Once approved, simply sign in again. Tip: connect Telegram on that page (see below) and the bot messages you the moment you're in.",
  step2:
    "<strong>Connect Claude.</strong> In the Claude app or claude.ai (Pro/Max plan): Settings → Connectors → <em>Add custom connector</em> → paste this URL:",
  step3:
    "<strong>Sign in with Google</strong> when the browser window opens, and allow the connection.",
  step4:
    "<strong>Create a Claude Project</strong> called e.g. “Coaching” and paste the project instructions below into its instructions field. (Optional, but it makes every conversation start correctly.)",
  step5:
    "<strong>Start your first conversation</strong> in that project. The coach will interview you — language, goals, and which topics you want coaching on (training, nutrition, or anything else) — and build your personal coaching knowledge base from it. Just answer; nothing to configure.",
  projectTitle: "Project instructions (copy & paste)",
  projectIntro: "Paste this into your Claude project's instructions and adapt freely:",
  optionalTitle: "Optional integrations — more data, better coaching",
  optionalFitness:
    '<strong>Fitness data:</strong> connect your training platform so the coach sees real load, wellness, and plans — e.g. intervals.icu via an MCP connector such as <a href="https://icusync.icu/" target="_blank" rel="noopener noreferrer">IcuSync</a>. Attach it on your account page under <em>Connected MCP servers</em> and its tools ride along in this one connector — so this works even on Claude plans that allow only a single custom connector. (You sign in to that service as yourself, with your own account there; on paid Claude plans you can alternatively add it as a second connector directly.) Coaching works without it; data-driven check-ins work better with it.',
  optionalHevy:
    "<strong>Strength logging (Hevy):</strong> connect your own Hevy account on the account page (Integrations — requires Hevy Pro) and the coach can read your workouts and manage routines directly.",
  telegramTitle: "Telegram (optional): notifications, coach pushes & quick capture",
  telegramIntro:
    "Connect the server's Telegram bot and three things start working: you are notified the moment your access is approved (and when your storage quota changes), your coach can deliver scheduled check-in summaries straight to your phone, and <strong>anything you text the bot lands in your coaching journal</strong> — jot down a thought on the go and your coach picks it up at the next session. Strictly opt-in — the bot can only ever message you after <em>you</em> start the chat. Connecting:",
  telegramStep1:
    '<strong>Open your personal connect link.</strong> It is on the confirmation page after your first sign-in, and anytime on your <a href="%ACCOUNT%">account page</a> (Profile → Telegram).',
  telegramStep2:
    "<strong>Press <em>Start</em></strong> in the Telegram chat that opens (works in the app and on the web). The bot confirms the connection.",
  telegramStep3:
    "<strong>Done.</strong> No phone number or Telegram profile data reaches this server — the link only tells the bot which coaching account your chat belongs to. Bot chats travel through Telegram's servers (not end-to-end encrypted), so treat captures like any normal chat message. Disconnect anytime on your account page.",
  telegramNote:
    "The connect link only appears when the operator has set up a Telegram bot for this server.",
  routinesTitle: "Automatic check-ins (optional)",
  routinesBody:
    "Let the coach come to you: a weekly review, a meal-planning check-in, a morning readiness check — as scheduled tasks in your own Claude account. How it works:",
  routinesIntro:
    "Routines run as scheduled tasks in YOUR Claude account — the coaching server never starts conversations itself. Setting one up:",
  routinesStep1:
    "<strong>Design it with your coach.</strong> In a normal conversation, say what you want (e.g. “a weekly check-in for my meal planning”). The coach designs the prompt with you — in your language, around your goal and timeframe — and stores it under Account → Routines.",
  routinesStep2:
    "<strong>Schedule it in Claude.</strong> Create a scheduled task with the routine's cadence and paste the stored prompt into it. The task runs that <em>pasted copy</em> — the routine stored here is the master, and the two are never synced automatically.",
  routinesStep3:
    "<strong>Improve it anytime.</strong> Reply directly in a run's chat to try adjustments, then make the change permanent: ask your coach in a normal conversation (or edit the routine here), and paste the updated prompt into the scheduled task again — an edit here never reaches the scheduled task on its own.",
  routinesFooter:
    "Routines never ask questions, send at most one quiet all-clear line when there is nothing actionable, and each has a goal and a review point — no notification noise.",
  routinesTemplatesTitle: "Templates the coach draws from",
  routinesTemplatesIntro:
    "English masters from the topic packs — your own routine is generated in your preferred language and tailored to you:",
  routinesNoTemplates: "No templates available on this server.",
  ownTitle: "Your routines",
  ownIntro:
    "Designed with your coach. The routine stored here is the master copy; the Claude scheduled task runs whatever prompt you last pasted into it. After any change here, copy the prompt into the scheduled task again — nothing syncs automatically.",
  ownNone: "No routines yet — ask your coach to design a check-in with you.",
  ownEdit: "edit",
  ownShowPrompt: "Show prompt (copy & paste into a scheduled task)",
  ownUpdated: "prompt updated",
  ownUpdatedHint: "changed it since you scheduled it? Paste the prompt into the task again.",
  howTitle: "How it works",
  dataTitle: "Your data",
  dataBody:
    "Everything the coach knows about you is yours: view and edit every document, download a full export, or delete your account at",
  footer: "Coaching content is stored per user; nobody else can read yours.",
  openSource:
    "The server software is open source on %REPO% — feature requests, bug reports, and pull requests welcome (you can even ask your coach to file them; they must never contain personal data).",
};

const DE: typeof EN = {
  title: "Dein KI-Coaching-Hub",
  intro:
    "Ein persönliches Coaching-Gedächtnis für Claude — Training, Ernährung oder jedes andere Lebensthema deiner Wahl: deine Ziele, Pläne, dein Journal und offene Punkte — privat, pro Person, von dir selbst editierbar. Zugang pro Person: mit der ersten Anmeldung anfragen, der Betreiber schaltet frei.",
  setupTitle: "Einrichtung in fünf Schritten",
  step1:
    "<strong>Zugang anfragen.</strong> Bei deiner ersten Google-Anmeldung (nächste zwei Schritte) geht deine Zugangsanfrage an den Betreiber dieses Servers — du siehst eine Bestätigungsseite. Nach der Freischaltung meldest du dich einfach erneut an. Tipp: verbinde auf dieser Seite Telegram (siehe unten), dann meldet sich der Bot, sobald du drin bist.",
  step2:
    "<strong>Claude verbinden.</strong> In der Claude-App oder auf claude.ai (Pro/Max-Abo): Einstellungen → Connectors → <em>Eigenen Connector hinzufügen</em> → diese URL einfügen:",
  step3:
    "<strong>Mit Google anmelden</strong>, sobald sich das Browser-Fenster öffnet, und die Verbindung erlauben.",
  step4:
    "<strong>Claude-Projekt anlegen</strong>, z. B. „Coaching“, und die Projekt-Anweisungen unten in das Anweisungsfeld einfügen. (Optional, sorgt aber dafür, dass jede Unterhaltung richtig startet.)",
  step5:
    "<strong>Erste Unterhaltung starten</strong> in diesem Projekt. Der Coach interviewt dich — Sprache, Ziele und welche Themen du gecoacht haben willst (Training, Ernährung oder etwas ganz anderes) — und baut daraus deine persönliche Coaching-Wissensbasis auf. Einfach antworten; nichts zu konfigurieren.",
  projectTitle: "Projekt-Anweisungen (kopieren & einfügen)",
  projectIntro: "Füge das in die Anweisungen deines Claude-Projekts ein und passe es frei an:",
  optionalTitle: "Optionale Integrationen — mehr Daten, besseres Coaching",
  optionalFitness:
    '<strong>Fitness-Daten:</strong> verbinde deine Trainingsplattform, damit der Coach echte Belastung, Wellness und Pläne sieht — z. B. intervals.icu über einen MCP-Connector wie <a href="https://icusync.icu/" target="_blank" rel="noopener noreferrer">IcuSync</a>. Hänge ihn auf deiner Account-Seite unter <em>Connected MCP servers</em> an, dann laufen seine Tools in diesem einen Connector mit — das funktioniert also auch mit Claude-Tarifen, die nur einen einzigen eigenen Connector erlauben. (Du meldest dich bei dem Dienst als du selbst an, mit deinem eigenen Konto dort; mit bezahltem Claude-Tarif kannst du ihn alternativ direkt als zweiten Connector hinzufügen.) Coaching funktioniert auch ohne; datengetriebene Check-ins werden damit deutlich besser.',
  optionalHevy:
    "<strong>Krafttraining (Hevy):</strong> verbinde dein eigenes Hevy-Konto auf der Account-Seite (Integrationen — erfordert Hevy Pro), dann kann der Coach deine Workouts lesen und Routinen direkt verwalten.",
  telegramTitle: "Telegram (optional): Benachrichtigungen, Coach-Pushes & Quick Capture",
  telegramIntro:
    "Verbinde den Telegram-Bot dieses Servers, dann funktionieren drei Dinge: du wirst benachrichtigt, sobald dein Zugang freigeschaltet wird (und wenn sich dein Speicherkontingent ändert), dein Coach kann geplante Check-in-Zusammenfassungen direkt aufs Handy schicken, und <strong>alles, was du dem Bot schreibst, landet in deinem Coaching-Journal</strong> — unterwegs einen Gedanken festhalten, der Coach greift ihn in der nächsten Session auf. Strikt opt-in — der Bot kann dir überhaupt erst schreiben, nachdem <em>du</em> den Chat gestartet hast. Verbinden:",
  telegramStep1:
    '<strong>Öffne deinen persönlichen Verbindungslink.</strong> Er steht auf der Bestätigungsseite nach deiner ersten Anmeldung und jederzeit auf deiner <a href="%ACCOUNT%">Account-Seite</a> (Profil → Telegram).',
  telegramStep2:
    "<strong>Tippe auf <em>Start</em></strong> im Telegram-Chat, der sich öffnet (funktioniert in der App und im Web). Der Bot bestätigt die Verbindung.",
  telegramStep3:
    "<strong>Fertig.</strong> Weder Telefonnummer noch Telegram-Profildaten erreichen diesen Server — der Link sagt dem Bot nur, zu welchem Coaching-Account dein Chat gehört. Bot-Chats laufen über Telegrams Server (nicht Ende-zu-Ende-verschlüsselt) — behandle Captures wie jede normale Chat-Nachricht. Trennen geht jederzeit auf der Account-Seite.",
  telegramNote:
    "Der Verbindungslink erscheint nur, wenn der Betreiber einen Telegram-Bot für diesen Server eingerichtet hat.",
  routinesTitle: "Automatische Check-ins (optional)",
  routinesBody:
    "Lass den Coach auf dich zukommen: Weekly Review, Meal-Planning-Check-in, Morgen-Readiness-Check — als geplante Aufgaben in deinem eigenen Claude-Konto. So funktioniert es:",
  routinesIntro:
    "Routinen laufen als geplante Aufgaben in DEINEM Claude-Konto — der Coaching-Server startet nie selbst Unterhaltungen. Einrichtung:",
  routinesStep1:
    "<strong>Mit dem Coach entwerfen.</strong> Sag in einer normalen Unterhaltung, was du willst (z. B. „einen wöchentlichen Check-in für meine Essensplanung“). Der Coach entwirft den Prompt mit dir — in deiner Sprache, um dein Ziel und deinen Zeitrahmen herum — und speichert ihn unter Account → Routines.",
  routinesStep2:
    "<strong>In Claude planen.</strong> Eine geplante Aufgabe mit dem Rhythmus der Routine anlegen und den gespeicherten Prompt einfügen. Die Aufgabe führt diese <em>eingefügte Kopie</em> aus — die hier gespeicherte Routine ist das Original, und beide werden nie automatisch synchronisiert.",
  routinesStep3:
    "<strong>Jederzeit verbessern.</strong> Antworte direkt im Chat eines Laufs, um Anpassungen auszuprobieren, und mach die Änderung dann dauerhaft: bitte deinen Coach in einer normalen Unterhaltung (oder bearbeite die Routine hier) — und füge den aktualisierten Prompt erneut in die geplante Aufgabe ein. Eine Änderung hier erreicht die geplante Aufgabe nie von selbst.",
  routinesFooter:
    "Routinen stellen keine Fragen, melden ohne Handlungsbedarf höchstens eine kurze Entwarnungszeile und haben je ein Ziel und einen Review-Punkt — kein Benachrichtigungslärm.",
  routinesTemplatesTitle: "Vorlagen, aus denen der Coach schöpft",
  routinesTemplatesIntro:
    "Englische Master-Vorlagen aus den Themen-Packs — deine eigene Routine wird in deiner bevorzugten Sprache erstellt und auf dich zugeschnitten:",
  routinesNoTemplates: "Auf diesem Server sind keine Vorlagen verfügbar.",
  ownTitle: "Deine Routinen",
  ownIntro:
    "Mit deinem Coach entworfen. Die hier gespeicherte Routine ist das Original; die geplante Aufgabe in Claude führt den Prompt aus, den du zuletzt eingefügt hast. Nach jeder Änderung hier den Prompt erneut in die geplante Aufgabe kopieren — nichts synchronisiert sich automatisch.",
  ownNone: "Noch keine Routinen — bitte deinen Coach, einen Check-in mit dir zu entwerfen.",
  ownEdit: "bearbeiten",
  ownShowPrompt: "Prompt anzeigen (kopieren & als geplante Aufgabe einfügen)",
  ownUpdated: "Prompt geändert",
  ownUpdatedHint: "seit dem Einplanen geändert? Prompt erneut in die Aufgabe einfügen.",
  howTitle: "So funktioniert es",
  dataTitle: "Deine Daten",
  dataBody:
    "Alles, was der Coach über dich weiß, gehört dir: alle Dokumente ansehen und bearbeiten, einen vollständigen Export herunterladen oder deinen Account löschen unter",
  footer: "Coaching-Inhalte werden pro Person gespeichert; niemand sonst kann deine lesen.",
  openSource:
    "Die Server-Software ist Open Source auf %REPO% — Feature-Wünsche, Bug-Reports und Pull Requests willkommen (du kannst sogar deinen Coach bitten, sie einzureichen; sie dürfen nie persönliche Daten enthalten).",
};
