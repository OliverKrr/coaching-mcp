import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { toolText, withErrorHandling } from "./utils/errors.js";

/**
 * Topic packs: installable coaching topics shipped as read-only markdown under
 * SEED_DIR/topics/<id>/. A pack bundles everything the assistant needs to
 * onboard a user into one coaching topic — a SKILL section skeleton plus
 * interview and instantiation instructions (topic.md), reference skeletons
 * (references/*.md), and routine templates (routines/*.md).
 *
 * Packs are delivered by read-only tools; instantiation goes through the
 * existing update_section / update_reference / save_routine writes, so the
 * assistant tailors the skeletons to the user during the interview and
 * everything stays visible in the account editor. Operators can add or
 * replace packs by mounting their own SEED_DIR — no code change needed.
 */

export type RoutineTemplate = {
  name: string;
  title: string;
  cadence: string;
  body: string;
};

export type TopicPack = {
  id: string;
  title: string;
  description: string;
  topicMd: string;
  references: Array<{ name: string; content: string }>;
  routines: RoutineTemplate[];
};

function readMdDir(dir: string): Array<{ name: string; content: string }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ name: f.replace(/\.md$/, ""), content: readFileSync(join(dir, f), "utf-8") }));
}

function firstHeading(md: string, fallback: string): string {
  return /^# (.+)$/m.exec(md)?.[1]?.trim() ?? fallback;
}

/** First non-empty, non-heading, non-"Key: value" line — the pack/template summary. */
function firstParagraphLine(md: string): string {
  for (const line of md.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || /^[A-Za-z-]+:\s/.test(trimmed)) continue;
    return trimmed;
  }
  return "";
}

function parseRoutineTemplate(name: string, content: string): RoutineTemplate {
  const cadence = /^Cadence:\s*(.+)$/m.exec(content)?.[1]?.trim() ?? "unspecified";
  return { name, title: firstHeading(content, name), cadence, body: content };
}

export function loadTopicPack(seedDir: string, id: string): TopicPack | undefined {
  const dir = join(seedDir, "topics", id);
  const topicPath = join(dir, "topic.md");
  if (!existsSync(topicPath)) return undefined;
  const topicMd = readFileSync(topicPath, "utf-8");
  return {
    id,
    title: firstHeading(topicMd, id),
    description: firstParagraphLine(topicMd),
    topicMd,
    references: readMdDir(join(dir, "references")),
    routines: readMdDir(join(dir, "routines")).map((f) => parseRoutineTemplate(f.name, f.content)),
  };
}

export function loadTopicPacks(seedDir: string): TopicPack[] {
  const topicsDir = join(seedDir, "topics");
  if (!existsSync(topicsDir)) return [];
  return readdirSync(topicsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => loadTopicPack(seedDir, e.name))
    .filter((p): p is TopicPack => p !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Every routine template across all packs — the /routines page renders these. */
export function allRoutineTemplates(seedDir: string): Array<RoutineTemplate & { packId: string }> {
  return loadTopicPacks(seedDir).flatMap((p) => p.routines.map((r) => ({ ...r, packId: p.id })));
}

function assemblePack(pack: TopicPack): string {
  const parts = [pack.topicMd.trimEnd()];
  for (const ref of pack.references) {
    parts.push(
      `REFERENCE SKELETON \`${ref.name}\` (write via update_reference, tailored to the user):\n\n${ref.content.trimEnd()}`,
    );
  }
  for (const routine of pack.routines) {
    parts.push(
      `ROUTINE TEMPLATE \`${routine.name}\` (offer after onboarding; instantiate in the user's preferred language and store via save_routine):\n\n${routine.body.trimEnd()}`,
    );
  }
  return parts.join("\n\n===\n\n");
}

export function registerTopicTools(server: McpServer, seedDir: string): void {
  server.registerTool(
    "list_topic_packs",
    {
      description:
        "List the coaching topic packs available on this server (e.g. training, nutrition, " +
        "custom). Call during onboarding — or whenever the user wants coaching on a new area of " +
        "life — then get_topic_pack for each topic the user picks.",
      inputSchema: {},
    },
    () =>
      withErrorHandling("list_topic_packs", () => {
        const packs = loadTopicPacks(seedDir);
        if (packs.length === 0) {
          return toolText(
            "No topic packs available on this server. Onboard the user free-form: agree on the topic's goal, create sections/references with the existing write tools.",
          );
        }
        return toolText(
          "Available topic packs (get_topic_pack(id) returns interview + skeletons):\n" +
            packs
              .map(
                (p) =>
                  `- **${p.id}** — ${p.title}: ${p.description} (${p.references.length} reference skeletons, ${p.routines.length} routine templates)`,
              )
              .join("\n"),
        );
      }),
  );

  server.registerTool(
    "get_topic_pack",
    {
      description:
        "Get one topic pack in full: instantiation instructions, SKILL section skeleton, " +
        "onboarding interview, reference skeletons, and routine templates. Follow its " +
        "instructions to onboard the user into the topic using the existing write tools.",
      inputSchema: {
        name: z.string().min(1).describe("Pack id, e.g. 'training', 'nutrition', 'custom'"),
      },
    },
    ({ name }) =>
      withErrorHandling("get_topic_pack", () => {
        const pack = loadTopicPack(seedDir, name);
        if (!pack) {
          const available = loadTopicPacks(seedDir)
            .map((p) => p.id)
            .join(", ");
          return toolText(`Topic pack '${name}' not found. Available: ${available || "none"}`);
        }
        return toolText(assemblePack(pack));
      }),
  );
}
