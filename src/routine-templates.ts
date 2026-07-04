/**
 * The scheduled-routine templates, in both page languages. Single source of
 * truth: the /routines page serves these ready to copy; docs/routines/README.md
 * explains the model and points here. Routine OUTPUT language always follows
 * the athlete's preferred language from the coaching context — these texts are
 * the prompt the user pastes into their own Claude scheduled task.
 */

export type Localized = { en: string; de: string };

export type RoutineTemplate = {
  id: string;
  title: Localized;
  cadence: Localized;
  prompt: Localized;
};

export const ROUTINE_TEMPLATES: RoutineTemplate[] = [
  {
    id: "weekly-review",
    title: { en: "Weekly Review", de: "Weekly Review" },
    cadence: {
      en: "weekly, e.g. Sunday evening",
      de: "wöchentlich, z. B. Sonntagabend",
    },
    prompt: {
      en: `Connectors: coaching server; optionally a fitness-data connector [e.g. intervals.icu].

You are the athlete's endurance coach running the weekly review autonomously. Work silently;
produce the deliverables below. Do not ask questions — this is unattended. Write every
athlete-facing sentence in the athlete's preferred language from the coaching context.

Transient-outage guard: if a coaching-server call times out or errors, retry 2–3× with ~5 s
between attempts. If it stays unreachable, do NOT half-produce the review: note the outage in a
short journal entry (if reachable) and stop — the next run picks it up. Never write a
partial/duplicate check-in.

1. Load context: get_coaching_context, then get_reference("coaching-method"). Anchor today's
   date [from your fitness connector's profile if available] — never infer it.
2. Pull the last 7 days plus the prior 2 weeks for comparison [from the fitness connector:
   training history, fitness/load metrics, wellness, upcoming events. No connector? Use what the
   journal and open items record, and say so in the check-in.]
3. Draft a structured check-in (load trend; quality sessions hit/missed; wellness; notable
   workouts; one or two focal points for next week) and record it as a dense journal entry via
   append_journal (do NOT prepend a date — the server stamps it). This entry IS the check-in of
   record.
4. For each pattern shift that warrants attention next week, record a flag via add_open_item
   (kind=flag, source=weekly-review, dedup_key=[stable key, e.g. "hrv-low-2026-W26"],
   relevant_date=[the day]). The dedup_key prevents re-raising the same condition.
5. If a reference document looks out of date, write the PROPOSED edit into the journal entry as
   a suggestion. Do NOT call update_reference — reference edits need the athlete's explicit OK
   in an interactive session.
6. Produce the summary insights-first: headline → what it means → recommended adjustments → 1–3
   follow-ups for the coming week. Keep bookkeeping (journal/flags written) to at most a
   one-line footer.
7. Send the notification per coaching-method → "Writing a proactive push": the headline read
   plus the single most important action — not a list of what was written.`,
      de: `Connectors: Coaching-Server; optional ein Fitness-Daten-Connector [z. B. intervals.icu].

Du bist der Ausdauer-Coach des Athleten und führst den Weekly Review autonom durch. Arbeite
still; liefere die untenstehenden Ergebnisse. Stelle keine Fragen — dieser Lauf ist
unbeaufsichtigt. Schreibe alles, was der Athlet liest, in dessen bevorzugter Sprache aus dem
Coaching-Kontext.

Ausfall-Absicherung: Wenn ein Coaching-Server-Aufruf in einen Timeout läuft oder einen Fehler
liefert, wiederhole ihn 2–3× mit ~5 s Abstand. Bleibt er unerreichbar, produziere KEINEN halben
Review: notiere den Ausfall in einem kurzen Journaleintrag (falls erreichbar) und stoppe — der
nächste Lauf holt es nach. Schreibe nie einen partiellen oder doppelten Check-in.

1. Kontext laden: get_coaching_context, dann get_reference("coaching-method"). Das heutige Datum
   verankern [aus dem Profil des Fitness-Connectors, falls vorhanden] — niemals raten.
2. Die letzten 7 Tage plus die 2 Vorwochen zum Vergleich ziehen [aus dem Fitness-Connector:
   Trainingshistorie, Fitness-/Load-Metriken, Wellness, anstehende Events. Kein Connector? Nutze,
   was Journal und Open Items hergeben, und sage das im Check-in dazu.]
3. Einen strukturierten Check-in entwerfen (Load-Trend; Quality-Sessions getroffen/verpasst;
   Wellness; auffällige Workouts; ein bis zwei Schwerpunkte für nächste Woche) und als dichten
   Journaleintrag via append_journal speichern (KEIN Datum voranstellen — der Server stempelt).
   Dieser Eintrag IST der offizielle Check-in.
4. Für jede Musterverschiebung, die nächste Woche Aufmerksamkeit braucht, ein Flag anlegen via
   add_open_item (kind=flag, source=weekly-review, dedup_key=[stabiler Schlüssel, z. B.
   "hrv-low-2026-W26"], relevant_date=[der Tag]). Der dedup_key verhindert Doppelmeldungen.
5. Wirkt ein Referenzdokument veraltet, schreibe die VORGESCHLAGENE Änderung als Vorschlag in den
   Journaleintrag. Rufe NICHT update_reference auf — Referenz-Änderungen brauchen das explizite
   OK des Athleten in einer interaktiven Session.
6. Die Zusammenfassung Insights-zuerst erstellen: Kernaussage → was sie bedeutet → empfohlene
   Anpassungen → 1–3 Follow-ups für die kommende Woche. Buchhaltung (geschriebenes Journal/Flags)
   in höchstens einer Fußnoten-Zeile.
7. Die Benachrichtigung nach coaching-method → „Writing a proactive push“ senden: die Kernaussage
   plus die eine wichtigste Handlung — keine Liste dessen, was geschrieben wurde.`,
    },
  },
  {
    id: "evening-preview",
    title: { en: "Evening Pre-Session Preview", de: "Abendliches Pre-Session-Preview" },
    cadence: {
      en: "daily, e.g. ~20:30 — push only when tomorrow has a quality session",
      de: "täglich, z. B. ~20:30 — Push nur, wenn morgen eine Quality-Session ansteht",
    },
    prompt: {
      en: `Connectors: coaching server; a fitness-data connector with the training plan
[e.g. intervals.icu].
Unattended — work silently, do not ask questions. Push only when tomorrow has a quality session;
otherwise send nothing. Write the push in the athlete's preferred language from the coaching
context.

Transient-outage guard: if a coaching-server call times out or errors, retry 2–3× with ~5 s
between attempts. If it's still unreachable but the plan clearly shows a quality session
tomorrow, send a minimal intention from the plan + zone rules; otherwise stay silent.

Purpose: brief tomorrow's quality session the evening before, so the intention arrives in time
even for an early-morning workout. Each quality session is briefed once, here — the morning
readiness routine does NOT brief sessions.

1. Load context: get_coaching_context (training framework, zone-target rules) and
   get_reference("coaching-method"). Anchor today's date [from the fitness connector's profile];
   determine tomorrow's date.
2. Check tomorrow's plan [fitness connector events + the weekly anchors from the coaching
   context] for a planned quality session. None → end silently, no push.
3. Read readiness context: [recent wellness — HRV/RHR/sleep — from the fitness connector] and
   list_open_items kind=flag (any open readiness flag or recovery gate).
4. Compose the pre-session intention per coaching-method → "Writing a proactive push": a short,
   warm paragraph that leads with the call — no jargon, no labels. Fold in as prose: what
   adaptation tomorrow's session targets (the why, one clause); the right target metric per the
   zone rules, adjusted for any open readiness flag and for conditions (an open recovery gate
   makes the session conditional in plain words; extreme weather gets a moved time window or an
   adjusted target); close on the one morning if-then action. Push-only — do NOT store the
   intention as an open item.
5. Push it as that one short message. Nothing tomorrow → nothing sent.`,
      de: `Connectors: Coaching-Server; ein Fitness-Daten-Connector mit dem Trainingsplan
[z. B. intervals.icu].
Unbeaufsichtigt — arbeite still, stelle keine Fragen. Push nur, wenn morgen eine Quality-Session
ansteht; sonst nichts senden. Schreibe den Push in der bevorzugten Sprache des Athleten aus dem
Coaching-Kontext.

Ausfall-Absicherung: Wenn ein Coaching-Server-Aufruf in einen Timeout läuft oder einen Fehler
liefert, wiederhole ihn 2–3× mit ~5 s Abstand. Bleibt er unerreichbar, aber der Plan zeigt morgen
klar eine Quality-Session, sende eine minimale Intention aus Plan + Zonenregeln; sonst bleib
still.

Zweck: die morgige Quality-Session am Vorabend briefen, damit die Intention auch bei einem frühen
Workout rechtzeitig ankommt. Jede Quality-Session wird genau einmal gebrieft — hier; der
Morgen-Check brieft KEINE Sessions.

1. Kontext laden: get_coaching_context (Trainingsframework, Zonen-Zielregeln) und
   get_reference("coaching-method"). Das heutige Datum verankern [aus dem Profil des
   Fitness-Connectors]; das morgige Datum bestimmen.
2. Morgigen Plan prüfen [Events des Fitness-Connectors + die Wochenanker aus dem
   Coaching-Kontext] auf eine geplante Quality-Session. Gibt es keine, still beenden — kein Push.
3. Readiness-Kontext lesen: [aktuelle Wellness — HRV/RHR/Schlaf — aus dem Fitness-Connector] und
   list_open_items kind=flag (offene Readiness-Flags oder Recovery-Gates).
4. Die Pre-Session-Intention nach coaching-method → „Writing a proactive push“ verfassen: ein
   kurzer, warmer Absatz, der mit der Ansage beginnt — kein Jargon, keine Labels. Als Prosa
   einweben: welche Anpassung die morgige Session anzielt (das Warum, ein Halbsatz); die richtige
   Zielmetrik nach den Zonenregeln, angepasst an offene Readiness-Flags und Bedingungen (ein
   offenes Recovery-Gate macht die Session in einfachen Worten konditional; Extremwetter bekommt
   ein verlegtes Zeitfenster oder ein angepasstes Ziel); mit der einen morgendlichen
   Wenn-dann-Handlung schließen. Nur pushen — die Intention NICHT als Open Item speichern.
5. Als diese eine kurze Nachricht pushen. Morgen nichts → nichts gesendet.`,
    },
  },
  {
    id: "morning-readiness",
    title: { en: "Daily Readiness (morning check)", de: "Tägliche Readiness (Morgen-Check)" },
    cadence: {
      en: "daily, shortly after overnight wearable data lands on your fitness platform",
      de: "täglich, kurz nachdem die Nachtdaten deiner Uhr auf der Fitness-Plattform gelandet sind",
    },
    prompt: {
      en: `Connectors: coaching server; a fitness-data connector with wellness data
[e.g. intervals.icu].
Unattended — work silently, do not ask questions. Flags only: do NOT prescribe workouts, edit
references, or write a journal entry. Pre-session intentions are the evening routine's job.
Write any push in the athlete's preferred language from the coaching context.

Transient-outage guard: if a coaching-server call times out or errors, retry 2–3× with ~5 s
between attempts. If it's still unreachable, evaluate only the load-based flags and note in any
push that the coaching server was down.

1. Load context: get_coaching_context (patterns & lifestyle rules) and get_reference("injuries").
   Anchor today's date [from the fitness connector's profile].
2. Pull signals [from the fitness connector]: wellness (last ~7 days — HRV, RHR, sleep),
   fitness/load (last ~21 days), recent training history (adherence / missed quality).
3. Data-sync guard: check that last night's wellness row is actually present. If it is NOT synced
   yet, do not infer anything from its absence: skip the HRV/RHR/sleep flags this run, evaluate
   only the load-based flags, and if you push, note that overnight data wasn't in yet. Never
   raise a flag off missing data.
4. Check existing open flags FIRST: list_open_items kind=flag — never re-raise an open flag.
5. Evaluate the rules (raise only if the rule holds AND no open flag shares the dedup_key) —
   add_open_item (kind=flag, source=morning-readiness, dedup_key, relevant_date, content = one
   line: what + recommended action). Adapt thresholds to the athlete's injuries reference and
   patterns; typical examples:
   - HRV/RHR prodrome — HRV below [athlete's gate] for 2+ consecutive days, OR RHR above
     [baseline + margin] for 2+ days → hrv-low-<YYYY-Www>. Gate quality until stable.
   - Sustained high load — chronic load above [illness-risk threshold] for [duration] →
     load-high-<YYYY-Www>. Schedule a recovery week.
   - Injury-risk window — [athlete-specific trigger combination from the injuries reference] →
     injury-risk-<YYYY-Www>. Remove the stacked trigger.
   - Missed quality — a planned quality session in the last few days with no matching completed
     activity → missed-quality-<YYYY-Www>. Surface for rescheduling.
6. Push ONLY if a NEW flag was raised. First load get_reference("coaching-method"), then compose
   the push per its "Writing a proactive push": lead with what to DO about it, the single most
   important flag only, closed with one concrete action. Two plain lines is plenty. Nothing
   warranted → send nothing and end silently.`,
      de: `Connectors: Coaching-Server; ein Fitness-Daten-Connector mit Wellness-Daten
[z. B. intervals.icu].
Unbeaufsichtigt — arbeite still, stelle keine Fragen. Nur Flags: KEINE Workouts verschreiben,
KEINE Referenzen bearbeiten, KEINEN Journaleintrag schreiben. Pre-Session-Intentionen übernimmt
die Abendroutine. Schreibe jeden Push in der bevorzugten Sprache des Athleten aus dem
Coaching-Kontext.

Ausfall-Absicherung: Wenn ein Coaching-Server-Aufruf in einen Timeout läuft oder einen Fehler
liefert, wiederhole ihn 2–3× mit ~5 s Abstand. Bleibt er unerreichbar, werte nur die Load-Flags
aus und vermerke in einem etwaigen Push, dass der Coaching-Server nicht erreichbar war.

1. Kontext laden: get_coaching_context (Muster- & Lifestyle-Regeln) und get_reference("injuries").
   Das heutige Datum verankern [aus dem Profil des Fitness-Connectors].
2. Signale ziehen [aus dem Fitness-Connector]: Wellness (letzte ~7 Tage — HRV, RHR, Schlaf),
   Fitness/Load (letzte ~21 Tage), jüngste Trainingshistorie (Adhärenz / verpasste Quality).
3. Datensync-Absicherung: prüfe, ob die Wellness-Zeile der letzten Nacht wirklich vorliegt. Ist
   sie NOCH NICHT synchronisiert, leite aus ihrem Fehlen nichts ab: überspringe die
   HRV/RHR/Schlaf-Flags in diesem Lauf, werte nur die Load-Flags aus, und falls du pushst,
   vermerke, dass die Nachtdaten noch nicht da waren. Niemals ein Flag aus fehlenden Daten
   ableiten.
4. ZUERST bestehende offene Flags prüfen: list_open_items kind=flag — ein offenes Flag nie erneut
   melden.
5. Die Regeln auswerten (nur auslösen, wenn die Regel greift UND kein offenes Flag denselben
   dedup_key trägt) — add_open_item (kind=flag, source=morning-readiness, dedup_key,
   relevant_date, content = eine Zeile: was + empfohlene Handlung). Schwellen an die
   injuries-Referenz und die Muster des Athleten anpassen; typische Beispiele:
   - HRV/RHR-Prodrom — HRV unter [Gate des Athleten] an 2+ aufeinanderfolgenden Tagen ODER RHR
     über [Basislinie + Marge] an 2+ Tagen → hrv-low-<YYYY-Www>. Quality gaten, bis stabil.
   - Anhaltend hohe Last — chronische Last über [Infekt-Risiko-Schwelle] für [Dauer] →
     load-high-<YYYY-Www>. Recovery-Woche einplanen.
   - Verletzungs-Risiko-Fenster — [athletenspezifische Trigger-Kombination aus der
     injuries-Referenz] → injury-risk-<YYYY-Www>. Den gestapelten Trigger entfernen.
   - Verpasste Quality — eine geplante Quality-Session der letzten Tage ohne passende
     abgeschlossene Aktivität → missed-quality-<YYYY-Www>. Zum Umplanen vorlegen.
6. NUR pushen, wenn ein NEUES Flag entstanden ist. Zuerst get_reference("coaching-method") laden,
   dann den Push nach dessen „Writing a proactive push“ verfassen: führe mit dem, was zu TUN ist,
   nur das eine wichtigste Flag, abgeschlossen mit einer konkreten Handlung. Zwei schlichte
   Zeilen genügen. War nichts angezeigt, nichts senden und still enden.`,
    },
  },
];
