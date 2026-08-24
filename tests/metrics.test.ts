import Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { createSchema, recomputeContentBytes } from "../src/db.js";
import { registerMetricsTools } from "../src/tools/metrics.js";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type RegisteredTool = { handler: (args: unknown) => Promise<ToolResult>; inputSchema: unknown };
type ToolMap = Record<string, RegisteredTool>;
type InternalServer = McpServer & {
  _registeredTools: ToolMap;
  validateToolInput(tool: RegisteredTool, args: unknown, name: string): Promise<unknown>;
  executeToolHandler(tool: RegisteredTool, args: unknown, extra: unknown): Promise<ToolResult>;
};

function makeServer(): { server: McpServer; db: Database.Database } {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  createSchema(db);
  recomputeContentBytes(db);
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerMetricsTools(server, db);
  return { server, db };
}

async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const internal = server as unknown as InternalServer;
  const tool = internal._registeredTools[name];
  if (!tool) throw new Error(`Tool '${name}' not registered`);
  const validatedArgs = await internal.validateToolInput(tool, args, name);
  return internal.executeToolHandler(tool, validatedArgs, {});
}

describe("record_metric", () => {
  it("records a data point and normalizes the series name", async () => {
    const { server, db } = makeServer();
    const r = await callTool(server, "record_metric", {
      name: "  Body-Weight ",
      value: 72.4,
      unit: "kg",
    });
    expect(r.content[0].text).toContain("body-weight = 72.4 kg");
    const row = db.prepare("SELECT name, value, unit FROM metrics").get() as {
      name: string;
      value: number;
      unit: string;
    };
    expect(row.name).toBe("body-weight");
    expect(row.value).toBe(72.4);
  });

  it("accepts an explicit measured_at date", async () => {
    const { server, db } = makeServer();
    await callTool(server, "record_metric", {
      name: "resting-hr",
      value: 41,
      measured_at: "2026-07-01",
    });
    const row = db.prepare("SELECT measured_at FROM metrics").get() as { measured_at: string };
    expect(row.measured_at).toBe("2026-07-01");
  });

  it("warns when the unit differs from the series' previous entry", async () => {
    const { server } = makeServer();
    await callTool(server, "record_metric", { name: "body-weight", value: 72.4, unit: "kg" });
    const r = await callTool(server, "record_metric", {
      name: "body-weight",
      value: 159.6,
      unit: "lb",
    });
    expect(r.content[0].text).toContain("Unit differs");
  });

  it("counts toward content_bytes via triggers", async () => {
    const { server, db } = makeServer();
    const before = Number(
      (db.prepare("SELECT value FROM meta WHERE key='content_bytes'").get() as { value: string })
        .value,
    );
    await callTool(server, "record_metric", {
      name: "body-weight",
      value: 72.4,
      unit: "kg",
      note: "morning",
    });
    const after = Number(
      (db.prepare("SELECT value FROM meta WHERE key='content_bytes'").get() as { value: string })
        .value,
    );
    // name(11) + unit(2) + note(7)
    expect(after - before).toBe(20);
  });

  it("recompute includes metrics rows", async () => {
    const { server, db } = makeServer();
    await callTool(server, "record_metric", { name: "resting-hr", value: 41, unit: "bpm" });
    db.prepare("UPDATE meta SET value = 0 WHERE key='content_bytes'").run();
    recomputeContentBytes(db);
    const n = Number(
      (db.prepare("SELECT value FROM meta WHERE key='content_bytes'").get() as { value: string })
        .value,
    );
    // name(10) + unit(3)
    expect(n).toBe(13);
  });
});

describe("get_metrics", () => {
  it("lists all series with count, span and latest value when name omitted", async () => {
    const { server } = makeServer();
    await callTool(server, "record_metric", {
      name: "body-weight",
      value: 73.0,
      unit: "kg",
      measured_at: "2026-07-01",
    });
    await callTool(server, "record_metric", {
      name: "body-weight",
      value: 72.4,
      unit: "kg",
      measured_at: "2026-08-01",
    });
    await callTool(server, "record_metric", { name: "resting-hr", value: 41 });
    const text = (await callTool(server, "get_metrics", {})).content[0].text;
    expect(text).toContain(
      "**body-weight** [event]: 2 points, 2026-07-01 → 2026-08-01, latest 72.4 kg",
    );
    expect(text).toContain("**resting-hr**");
  });

  it("returns a series newest-first with min/avg/max stats", async () => {
    const { server } = makeServer();
    await callTool(server, "record_metric", {
      name: "body-weight",
      value: 73.0,
      unit: "kg",
      measured_at: "2026-07-01",
    });
    await callTool(server, "record_metric", {
      name: "body-weight",
      value: 72.0,
      unit: "kg",
      measured_at: "2026-08-01",
    });
    const text = (await callTool(server, "get_metrics", { name: "body-weight" })).content[0].text;
    expect(text).toContain("min 72 / avg 72.5 / max 73 kg");
    expect(text.indexOf("2026-08-01")).toBeLessThan(text.indexOf("2026-07-01"));
  });

  it("filters by since/until", async () => {
    const { server } = makeServer();
    await callTool(server, "record_metric", {
      name: "resting-hr",
      value: 40,
      measured_at: "2026-06-01",
    });
    await callTool(server, "record_metric", {
      name: "resting-hr",
      value: 45,
      measured_at: "2026-07-15",
    });
    const text = (
      await callTool(server, "get_metrics", {
        name: "resting-hr",
        since: "2026-07-01",
        until: "2026-07-31",
      })
    ).content[0].text;
    expect(text).toContain("45");
    expect(text).not.toContain("2026-06-01");
  });

  it("names known series when the requested one has no data", async () => {
    const { server } = makeServer();
    await callTool(server, "record_metric", { name: "resting-hr", value: 41 });
    const text = (await callTool(server, "get_metrics", { name: "body-weight" })).content[0].text;
    expect(text).toContain("No data points for 'body-weight'");
    expect(text).toContain("resting-hr");
  });

  it("suggests record_metric when nothing is tracked yet", async () => {
    const { server } = makeServer();
    const text = (await callTool(server, "get_metrics", {})).content[0].text;
    expect(text).toContain("No metrics recorded yet");
  });
});

describe("delete_metric", () => {
  it("deletes a data point and releases its bytes", async () => {
    const { server, db } = makeServer();
    await callTool(server, "record_metric", { name: "resting-hr", value: 41, unit: "bpm" });
    const r = await callTool(server, "delete_metric", { id: 1, confirm: true });
    expect(r.content[0].text).toContain("#1 deleted");
    const n = Number(
      (db.prepare("SELECT value FROM meta WHERE key='content_bytes'").get() as { value: string })
        .value,
    );
    expect(n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM metrics").get()).toEqual({ n: 0 });
  });

  it("reports a missing id", async () => {
    const { server } = makeServer();
    const r = await callTool(server, "delete_metric", { id: 99, confirm: true });
    expect(r.content[0].text).toContain("No metric with id #99");
  });
});

describe("state series (validity windows)", () => {
  it("a new state value supersedes the previous one", async () => {
    const { server, db } = makeServer();
    await callTool(server, "record_metric", {
      name: "cycle-ftp",
      value: 250,
      unit: "W",
      measured_at: "2024-05-01",
      series_kind: "state",
    });
    const r = await callTool(server, "record_metric", {
      name: "cycle-ftp",
      value: 265,
      unit: "W",
      measured_at: "2026-08-01",
    });
    expect(r.content[0].text).toContain("Supersedes #1");
    const rows = db
      .prepare("SELECT id, valid_to FROM metrics WHERE name='cycle-ftp' ORDER BY id")
      .all() as Array<{ id: number; valid_to: string | null }>;
    expect(rows[0].valid_to).toBe("2026-08-01");
    expect(rows[1].valid_to).toBeNull();
  });

  it("get_metrics with no as_of returns exactly the current value", async () => {
    const { server } = makeServer();
    await callTool(server, "record_metric", {
      name: "cycle-ftp",
      value: 250,
      measured_at: "2024-05-01",
      series_kind: "state",
    });
    await callTool(server, "record_metric", {
      name: "cycle-ftp",
      value: 265,
      measured_at: "2026-08-01",
    });
    const text = (await callTool(server, "get_metrics", { name: "cycle-ftp" })).content[0].text;
    expect(text).toContain("265");
    expect(text).toContain("current since 2026-08-01");
    expect(text).not.toContain("#1 ");
    expect(text).toContain("1 superseded value");
  });

  it("as_of answers what was valid at a past date", async () => {
    const { server } = makeServer();
    await callTool(server, "record_metric", {
      name: "cycle-ftp",
      value: 250,
      measured_at: "2024-05-01",
      series_kind: "state",
    });
    await callTool(server, "record_metric", {
      name: "cycle-ftp",
      value: 265,
      measured_at: "2026-08-01",
    });
    const text = (await callTool(server, "get_metrics", { name: "cycle-ftp", as_of: "2025-06-15" }))
      .content[0].text;
    expect(text).toContain("as of 2025-06-15: 250");
    const before = (
      await callTool(server, "get_metrics", { name: "cycle-ftp", as_of: "2023-01-01" })
    ).content[0].text;
    expect(before).toContain("No value of 'cycle-ftp' was valid at 2023-01-01");
  });

  it("include_superseded shows the full trail with windows", async () => {
    const { server } = makeServer();
    await callTool(server, "record_metric", {
      name: "cycle-ftp",
      value: 250,
      measured_at: "2024-05-01",
      series_kind: "state",
    });
    await callTool(server, "record_metric", {
      name: "cycle-ftp",
      value: 265,
      measured_at: "2026-08-01",
    });
    const text = (
      await callTool(server, "get_metrics", { name: "cycle-ftp", include_superseded: true })
    ).content[0].text;
    expect(text).toContain("[2024-05-01 → 2026-08-01]");
    expect(text).toContain("[2026-08-01 → current]");
  });

  it("a historical backfill closes its own window, not the current one", async () => {
    const { server, db } = makeServer();
    await callTool(server, "record_metric", {
      name: "cycle-ftp",
      value: 265,
      measured_at: "2026-08-01",
      series_kind: "state",
    });
    const r = await callTool(server, "record_metric", {
      name: "cycle-ftp",
      value: 250,
      measured_at: "2024-05-01",
    });
    expect(r.content[0].text).toContain("Recorded as historical");
    const open = db
      .prepare("SELECT value FROM metrics WHERE name='cycle-ftp' AND valid_to IS NULL")
      .all() as Array<{ value: number }>;
    expect(open).toEqual([{ value: 265 }]);
  });

  it("event series never supersede — counting history stays intact", async () => {
    const { server, db } = makeServer();
    await callTool(server, "record_metric", {
      name: "weekly-volume",
      value: 66,
      unit: "km",
      measured_at: "2026-08-10",
    });
    await callTool(server, "record_metric", {
      name: "weekly-volume",
      value: 62,
      unit: "km",
      measured_at: "2026-08-17",
    });
    const open = db
      .prepare("SELECT COUNT(*) AS n FROM metrics WHERE name='weekly-volume' AND valid_to IS NULL")
      .get() as { n: number };
    expect(open.n).toBe(2);
    const text = (await callTool(server, "get_metrics", { name: "weekly-volume" })).content[0].text;
    expect(text).toContain("2 points");
    expect(text).toContain("66");
    expect(text).toContain("62");
  });

  it("the series kind is fixed once set", async () => {
    const { server } = makeServer();
    await callTool(server, "record_metric", {
      name: "cycle-ftp",
      value: 250,
      series_kind: "state",
    });
    const r = await callTool(server, "record_metric", {
      name: "cycle-ftp",
      value: 260,
      series_kind: "event",
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("fixed once set");
  });

  it("deleting the current state value re-opens the previous one", async () => {
    const { server, db } = makeServer();
    await callTool(server, "record_metric", {
      name: "cycle-ftp",
      value: 250,
      measured_at: "2024-05-01",
      series_kind: "state",
    });
    await callTool(server, "record_metric", {
      name: "cycle-ftp",
      value: 265,
      measured_at: "2026-08-01",
    });
    await callTool(server, "delete_metric", { id: 2, confirm: true });
    const open = db
      .prepare("SELECT value, valid_to FROM metrics WHERE name='cycle-ftp'")
      .all() as Array<{ value: number; valid_to: string | null }>;
    expect(open).toEqual([{ value: 250, valid_to: null }]);
  });

  it("the overview marks kinds and staleness", async () => {
    const { server } = makeServer();
    await callTool(server, "record_metric", {
      name: "cycle-ftp",
      value: 250,
      measured_at: "2024-05-01",
      series_kind: "state",
      stale_after_days: 180,
    });
    await callTool(server, "record_metric", { name: "weekly-volume", value: 66 });
    const text = (await callTool(server, "get_metrics", {})).content[0].text;
    expect(text).toContain("**cycle-ftp** [state]");
    expect(text).toContain("⚠ stale (recorded 2024-05-01, staleness 180 d)");
    expect(text).toContain("**weekly-volume** [event]");
  });
});
