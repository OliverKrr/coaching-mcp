import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServeContext } from "./context.js";
import { htmlEscape, page, sendHtml } from "./http-util.js";
import { allRoutineTemplates } from "./topics.js";
import { REPO_URL } from "./version.js";

/**
 * Public landing page = the setup guide new users need to get from "invited"
 * to "coached". Bilingual (English/German) because that covers the common
 * deployment need without a full i18n layer: the language comes from
 * `?lang=de|en`, falling back to the browser's Accept-Language. Operators
 * share exactly one URL — this page.
 */

type Lang = "en" | "de";

function pickLang(req: IncomingMessage, url: URL): Lang {
  const q = url.searchParams.get("lang");
  if (q === "de" || q === "en") return q;
  return (req.headers["accept-language"] ?? "").toLowerCase().startsWith("de") ? "de" : "en";
}

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
      `<p class="muted" style="text-align:right"><a href="${base}/?lang=de">Deutsch</a> · <a href="${base}/?lang=en">English</a></p>
<h1>${t.title}</h1>
<p>${t.intro}</p>

<div class="card">
<h2>${t.setupTitle}</h2>
<ol>
<li>${t.step1}</li>
<li>${t.step2}<br><code>${htmlEscape(base)}</code></li>
<li>${t.step3}</li>
<li>${t.step4}</li>
<li>${t.step5}</li>
</ol>
</div>

<div class="card">
<h2>${t.projectTitle}</h2>
<p>${t.projectIntro}</p>
<pre style="white-space:pre-wrap;background:#f6f6f6;padding:.75rem;border-radius:6px;font-size:.85rem">${htmlEscape(projectInstructions)}</pre>
</div>

<div class="card">
<h2>${t.optionalTitle}</h2>
<ul>
<li>${t.optionalFitness}</li>
<li>${t.optionalHevy}</li>
</ul>
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

  const cards = allRoutineTemplates(ctx.cfg.seedDir)
    .map(
      (r) => `<div class="card">
<details>
<summary style="cursor:pointer"><strong>${htmlEscape(r.title)}</strong> <span class="muted">(${htmlEscape(r.packId)})</span> — <span class="muted">${htmlEscape(r.cadence)}</span></summary>
<pre style="white-space:pre-wrap;background:#f6f6f6;padding:.75rem;border-radius:6px;font-size:.82rem">${htmlEscape(r.body)}</pre>
</details>
</div>`,
    )
    .join("\n");

  sendHtml(
    res,
    200,
    page(
      t.routinesTitle,
      `<p class="muted" style="text-align:right"><a href="${base}/routines?lang=de">Deutsch</a> · <a href="${base}/routines?lang=en">English</a></p>
<p class="muted"><a href="${base}/?lang=${lang}">${t.backToGuide}</a></p>
<h1>${t.routinesTitle}</h1>
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
    ),
  );
}

const EN = {
  title: "Your AI coaching hub",
  intro:
    "A personal coaching memory for Claude — training, nutrition, or any life topic you pick: your goals, plans, journal, and open items — private, per person, editable by you. Access is by invitation.",
  setupTitle: "Set up in five steps",
  step1:
    "<strong>Get invited.</strong> Ask the operator of this server to add your Google e-mail address to the invitation list.",
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
    '<strong>Fitness data:</strong> connect your training platform as a second Claude connector so the coach sees real load, wellness, and plans — e.g. intervals.icu via an MCP connector such as <a href="https://icusync.icu/" target="_blank" rel="noopener noreferrer">IcuSync</a>. Coaching works without it; data-driven check-ins work better with it.',
  optionalHevy:
    "<strong>Strength logging (Hevy):</strong> connect your own Hevy account on the account page (Integrations — requires Hevy Pro) and the coach can read your workouts and manage routines directly.",
  routinesTitle: "Automatic check-ins (optional)",
  routinesBody:
    "Let the coach come to you: a weekly review, a meal-planning check-in, a morning readiness check — as scheduled tasks in your own Claude account. How it works:",
  routinesIntro:
    "Routines run as scheduled tasks in YOUR Claude account — the coaching server never starts conversations itself. Setting one up:",
  routinesStep1:
    "<strong>Design it with your coach.</strong> In a normal conversation, say what you want (e.g. “a weekly check-in for my meal planning”). The coach designs the prompt with you — in your language, around your goal and timeframe — and stores it under Account → Routines.",
  routinesStep2:
    "<strong>Schedule it in Claude.</strong> Create a scheduled task with the routine's cadence and paste the stored prompt (from the chat or from your account page).",
  routinesStep3:
    "<strong>Adjust anytime.</strong> Ask the coach to revise or retire a routine, then update the scheduled task with the new prompt.",
  routinesFooter:
    "Routines never ask questions, stay silent when there is nothing actionable, and each has a goal and a review point — no notification noise.",
  routinesTemplatesTitle: "Templates the coach draws from",
  routinesTemplatesIntro:
    "English masters from the topic packs — your own routine is generated in your preferred language and tailored to you:",
  routinesNoTemplates: "No templates available on this server.",
  backToGuide: "← Back to the setup guide",
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
    "Ein persönliches Coaching-Gedächtnis für Claude — Training, Ernährung oder jedes andere Lebensthema deiner Wahl: deine Ziele, Pläne, dein Journal und offene Punkte — privat, pro Person, von dir selbst editierbar. Zugang nur auf Einladung.",
  setupTitle: "Einrichtung in fünf Schritten",
  step1:
    "<strong>Einladen lassen.</strong> Bitte den Betreiber dieses Servers, deine Google-E-Mail-Adresse auf die Einladungsliste zu setzen.",
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
    '<strong>Fitness-Daten:</strong> verbinde deine Trainingsplattform als zweiten Claude-Connector, damit der Coach echte Belastung, Wellness und Pläne sieht — z. B. intervals.icu über einen MCP-Connector wie <a href="https://icusync.icu/" target="_blank" rel="noopener noreferrer">IcuSync</a>. Coaching funktioniert auch ohne; datengetriebene Check-ins werden damit deutlich besser.',
  optionalHevy:
    "<strong>Krafttraining (Hevy):</strong> verbinde dein eigenes Hevy-Konto auf der Account-Seite (Integrationen — erfordert Hevy Pro), dann kann der Coach deine Workouts lesen und Routinen direkt verwalten.",
  routinesTitle: "Automatische Check-ins (optional)",
  routinesBody:
    "Lass den Coach auf dich zukommen: Weekly Review, Meal-Planning-Check-in, Morgen-Readiness-Check — als geplante Aufgaben in deinem eigenen Claude-Konto. So funktioniert es:",
  routinesIntro:
    "Routinen laufen als geplante Aufgaben in DEINEM Claude-Konto — der Coaching-Server startet nie selbst Unterhaltungen. Einrichtung:",
  routinesStep1:
    "<strong>Mit dem Coach entwerfen.</strong> Sag in einer normalen Unterhaltung, was du willst (z. B. „einen wöchentlichen Check-in für meine Essensplanung“). Der Coach entwirft den Prompt mit dir — in deiner Sprache, um dein Ziel und deinen Zeitrahmen herum — und speichert ihn unter Account → Routines.",
  routinesStep2:
    "<strong>In Claude planen.</strong> Eine geplante Aufgabe mit dem Rhythmus der Routine anlegen und den gespeicherten Prompt einfügen (aus dem Chat oder von deiner Account-Seite).",
  routinesStep3:
    "<strong>Jederzeit anpassen.</strong> Bitte den Coach, eine Routine zu überarbeiten oder stillzulegen, und aktualisiere dann die geplante Aufgabe mit dem neuen Prompt.",
  routinesFooter:
    "Routinen stellen keine Fragen, bleiben still, wenn es nichts Handlungsrelevantes gibt, und haben je ein Ziel und einen Review-Punkt — kein Benachrichtigungslärm.",
  routinesTemplatesTitle: "Vorlagen, aus denen der Coach schöpft",
  routinesTemplatesIntro:
    "Englische Master-Vorlagen aus den Themen-Packs — deine eigene Routine wird in deiner bevorzugten Sprache erstellt und auf dich zugeschnitten:",
  routinesNoTemplates: "Auf diesem Server sind keine Vorlagen verfügbar.",
  backToGuide: "← Zurück zur Einrichtungs-Anleitung",
  dataTitle: "Deine Daten",
  dataBody:
    "Alles, was der Coach über dich weiß, gehört dir: alle Dokumente ansehen und bearbeiten, einen vollständigen Export herunterladen oder deinen Account löschen unter",
  footer: "Coaching-Inhalte werden pro Person gespeichert; niemand sonst kann deine lesen.",
  openSource:
    "Die Server-Software ist Open Source auf %REPO% — Feature-Wünsche, Bug-Reports und Pull Requests willkommen (du kannst sogar deinen Coach bitten, sie einzureichen; sie dürfen nie persönliche Daten enthalten).",
};
