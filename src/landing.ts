import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServeContext } from "./context.js";
import { htmlEscape, page, sendHtml } from "./http-util.js";
import { ROUTINE_TEMPLATES } from "./routine-templates.js";

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
      ? `Du bist mein persönlicher Ausdauer-Coach. Dein gesamtes Coaching-Wissen liegt im
Coaching-MCP-Connector — nicht in diesem Prompt.

Zu Beginn JEDER Session — nicht verhandelbar:
1. Rufe zuerst get_coaching_context auf und folge exakt der dort beschriebenen Arbeitsweise.
2. Rufe list_open_items auf und geh offene Punkte durch, bevor du coachst.
3. Wenn der Connector nicht erreichbar ist, sag das offen — improvisiere kein Coaching aus dem
   Chat-Gedächtnis.

Datums-Anker: Nimm niemals ein Datum an. Bestätige das heutige Datum (frag mich zur Not), bevor
du irgendetwas planst, und nenne bei Wochenplänen jeden Tag mit Kalenderdatum.`
      : `You are my personal endurance coach. All of your coaching knowledge lives in the coaching
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

<p class="muted">${t.footer}</p>`,
    ),
  );
}

/** /routines — the scheduled-task templates, ready to copy, in the page language. */
export function renderRoutines(
  ctx: ServeContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): void {
  const base = ctx.cfg.publicUrl;
  const lang = pickLang(req, url);
  const t = lang === "de" ? DE : EN;

  const cards = ROUTINE_TEMPLATES.map(
    (r) => `<div class="card">
<details${r.id === "weekly-review" ? " open" : ""}>
<summary style="cursor:pointer"><strong>${htmlEscape(r.title[lang])}</strong> — <span class="muted">${htmlEscape(r.cadence[lang])}</span></summary>
<pre style="white-space:pre-wrap;background:#f6f6f6;padding:.75rem;border-radius:6px;font-size:.82rem">${htmlEscape(r.prompt[lang])}</pre>
</details>
</div>`,
  ).join("\n");

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
${cards}
<p class="muted">${t.routinesFooter}</p>`,
    ),
  );
}

const EN = {
  title: "Your AI coaching hub",
  intro:
    "A personal endurance-coaching memory for Claude: your goals, zones, plans, journal, and open items — private, per person, editable by you. Access is by invitation.",
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
    "<strong>Start your first conversation</strong> in that project. The coach will interview you — language, goals, background, schedule, injuries — and build your personal coaching knowledge base from it. Just answer; nothing to configure.",
  projectTitle: "Project instructions (copy & paste)",
  projectIntro: "Paste this into your Claude project's instructions and adapt freely:",
  optionalTitle: "Optional integrations — more data, better coaching",
  optionalFitness:
    '<strong>Fitness data:</strong> connect your training platform as a second Claude connector so the coach sees real load, wellness, and plans — e.g. intervals.icu via an MCP connector such as <a href="https://icusync.icu/" target="_blank" rel="noopener noreferrer">IcuSync</a>. Coaching works without it; data-driven check-ins work better with it.',
  optionalHevy:
    "<strong>Strength logging (Hevy):</strong> connect your own Hevy account on the account page (Integrations — requires Hevy Pro) and the coach can read your workouts and manage routines directly.",
  routinesTitle: "Automatic check-ins (optional)",
  routinesBody:
    "Let the coach come to you: a weekly review, an evening briefing, a morning readiness check — as scheduled tasks in your own Claude account. Ready-to-copy templates:",
  routinesIntro:
    "These run as scheduled tasks in YOUR Claude account — the coaching server never starts conversations itself. Setup per routine:",
  routinesStep1: "In Claude, create a scheduled task with the cadence shown on the template.",
  routinesStep2:
    "Copy the template below as the task prompt and fill the [placeholders]; if you have no fitness-data connector, delete those steps — the routine degrades gracefully.",
  routinesStep3:
    "Done — output (pushes, journal entries) automatically arrives in your preferred coaching language.",
  routinesFooter:
    "The weekly review writes the check-in of record, the evening preview briefs tomorrow's quality session, the morning check raises readiness flags only — no overlaps.",
  backToGuide: "← Back to the setup guide",
  dataTitle: "Your data",
  dataBody:
    "Everything the coach knows about you is yours: view and edit every document, download a full export, or delete your account at",
  footer: "Coaching content is stored per user; nobody else can read yours.",
};

const DE: typeof EN = {
  title: "Dein KI-Coaching-Hub",
  intro:
    "Ein persönliches Ausdauer-Coaching-Gedächtnis für Claude: deine Ziele, Zonen, Pläne, dein Trainingstagebuch und offene Punkte — privat, pro Person, von dir selbst editierbar. Zugang nur auf Einladung.",
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
    "<strong>Erste Unterhaltung starten</strong> in diesem Projekt. Der Coach interviewt dich — Sprache, Ziele, Vorgeschichte, Zeitbudget, Verletzungen — und baut daraus deine persönliche Coaching-Wissensbasis auf. Einfach antworten; nichts zu konfigurieren.",
  projectTitle: "Projekt-Anweisungen (kopieren & einfügen)",
  projectIntro: "Füge das in die Anweisungen deines Claude-Projekts ein und passe es frei an:",
  optionalTitle: "Optionale Integrationen — mehr Daten, besseres Coaching",
  optionalFitness:
    '<strong>Fitness-Daten:</strong> verbinde deine Trainingsplattform als zweiten Claude-Connector, damit der Coach echte Belastung, Wellness und Pläne sieht — z. B. intervals.icu über einen MCP-Connector wie <a href="https://icusync.icu/" target="_blank" rel="noopener noreferrer">IcuSync</a>. Coaching funktioniert auch ohne; datengetriebene Check-ins werden damit deutlich besser.',
  optionalHevy:
    "<strong>Krafttraining (Hevy):</strong> verbinde dein eigenes Hevy-Konto auf der Account-Seite (Integrationen — erfordert Hevy Pro), dann kann der Coach deine Workouts lesen und Routinen direkt verwalten.",
  routinesTitle: "Automatische Check-ins (optional)",
  routinesBody:
    "Lass den Coach auf dich zukommen: Weekly Review, Abend-Briefing, Morgen-Readiness-Check — als geplante Aufgaben in deinem eigenen Claude-Konto. Fertige Vorlagen zum Kopieren:",
  routinesIntro:
    "Diese laufen als geplante Aufgaben in DEINEM Claude-Konto — der Coaching-Server startet nie selbst Unterhaltungen. Einrichtung pro Routine:",
  routinesStep1:
    "In Claude eine geplante Aufgabe mit dem auf der Vorlage angegebenen Rhythmus anlegen.",
  routinesStep2:
    "Die Vorlage unten als Aufgaben-Prompt kopieren und die [Platzhalter] ausfüllen; ohne Fitness-Daten-Connector die betreffenden Schritte einfach löschen — die Routine funktioniert auch ohne.",
  routinesStep3:
    "Fertig — die Ausgaben (Pushes, Journaleinträge) kommen automatisch in deiner bevorzugten Coaching-Sprache.",
  routinesFooter:
    "Der Weekly Review schreibt den offiziellen Check-in, das Abend-Preview brieft die morgige Quality-Session, der Morgen-Check meldet nur Readiness-Flags — keine Überschneidungen.",
  backToGuide: "← Zurück zur Einrichtungs-Anleitung",
  dataTitle: "Deine Daten",
  dataBody:
    "Alles, was der Coach über dich weiß, gehört dir: alle Dokumente ansehen und bearbeiten, einen vollständigen Export herunterladen oder deinen Account löschen unter",
  footer: "Coaching-Inhalte werden pro Person gespeichert; niemand sonst kann deine lesen.",
};
