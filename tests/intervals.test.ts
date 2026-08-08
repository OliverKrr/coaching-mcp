// coaching-mcp/tests/intervals.test.ts — mock Intervals.icu on 127.0.0.1
// (tests never touch the network).
import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CSV_MAX_CHARS,
  IntervalsClient,
  filterActivities,
  parseIntervalsCredentials,
  registerIntervalsTools,
  toCsv,
  weekStartOf,
  weeklySummary,
} from "../src/integrations/intervals.js";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type RegisteredTool = { handler: (args: unknown) => Promise<ToolResult>; inputSchema: unknown };
type InternalServer = McpServer & {
  _registeredTools: Record<string, RegisteredTool>;
  validateToolInput(tool: RegisteredTool, args: unknown, name: string): Promise<unknown>;
  executeToolHandler(tool: RegisteredTool, args: unknown, extra: unknown): Promise<ToolResult>;
};

const ACTIVITIES = [
  {
    id: "a1",
    start_date_local: "2026-07-27T07:30:00",
    type: "Run",
    name: "Morning run",
    distance: 12000,
    moving_time: 3600,
    icu_training_load: 80,
    icu_intensity: 75,
    average_heartrate: 150,
    total_elevation_gain: 120,
    carbs_used_g: 99, // noise field that must not leak into default CSV
  },
  {
    id: "a2",
    start_date_local: "2026-07-28T18:00:00",
    type: "Ride",
    name: 'Commute, with "quotes"',
    distance: 5000,
    moving_time: 900,
    icu_training_load: 10,
    icu_intensity: 40,
    average_heartrate: 110,
    total_elevation_gain: 20,
  },
  {
    id: "a3",
    start_date_local: "2026-07-28T19:30:00",
    type: "WeightTraining",
    name: "Gym",
    distance: null,
    moving_time: 2700,
    icu_training_load: 45,
    icu_intensity: null,
    average_heartrate: 120,
    total_elevation_gain: null,
  },
  {
    id: "a4",
    start_date_local: "2026-08-03T09:00:00",
    type: "Ride",
    name: "Long ride",
    distance: 87000,
    moving_time: 12000,
    icu_training_load: 190,
    icu_intensity: 80,
    average_heartrate: 140,
    total_elevation_gain: 900,
  },
];

const WELLNESS = [
  {
    id: "2026-08-01",
    ctl: 82.1,
    atl: 70.4,
    restingHR: 42,
    hrv: 55.2,
    sleepSecs: 27000,
    weight: 71.5,
  },
  {
    id: "2026-08-02",
    ctl: 81.7,
    atl: 68.9,
    restingHR: 41,
    hrv: null,
    sleepSecs: 25200,
    weight: null,
  },
];

let mock: Server;
let base: string;
let lastAuth: string | undefined;
let lastUrl: string | undefined;

beforeAll(async () => {
  mock = createServer((req, res) => {
    lastAuth = req.headers.authorization;
    lastUrl = req.url;
    const url = req.url ?? "";
    if (lastAuth !== `Basic ${Buffer.from("API_KEY:good-key").toString("base64")}`) {
      res.writeHead(403).end("forbidden");
      return;
    }
    if (url.startsWith("/api/v1/athlete/i12345/activities")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(ACTIVITIES));
    } else if (url.startsWith("/api/v1/athlete/i12345/wellness")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(WELLNESS));
    } else if (url === "/api/v1/athlete/i12345") {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ id: "i12345" }));
    } else {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const addr = mock.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  base = `http://127.0.0.1:${addr.port}/api/v1`;
});

afterAll(() => {
  mock.close();
});

function makeClient(apiKey = "good-key"): IntervalsClient {
  return new IntervalsClient({ athleteId: "i12345", apiKey }, base);
}

async function callTool(
  client: IntervalsClient,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerIntervalsTools(server, client);
  const internal = server as unknown as InternalServer;
  const tool = internal._registeredTools[name];
  if (!tool) throw new Error(`Tool '${name}' not registered`);
  const validatedArgs = await internal.validateToolInput(tool, args, name);
  return internal.executeToolHandler(tool, validatedArgs, {});
}

describe("parseIntervalsCredentials", () => {
  it("accepts well-formed JSON and rejects everything else", () => {
    expect(parseIntervalsCredentials('{"athleteId":"i1","apiKey":"k"}')).toEqual({
      athleteId: "i1",
      apiKey: "k",
    });
    expect(parseIntervalsCredentials('{"athleteId":"i1"}')).toBeUndefined();
    expect(parseIntervalsCredentials('{"athleteId":"","apiKey":"k"}')).toBeUndefined();
    expect(parseIntervalsCredentials("not json")).toBeUndefined();
  });
});

describe("IntervalsClient", () => {
  it("authenticates with Basic API_KEY and validates credentials", async () => {
    expect(await makeClient().validateCredentials()).toBe(true);
    expect(await makeClient("bad-key").validateCredentials()).toBe(false);
  });
});

describe("toCsv", () => {
  it("quotes per RFC 4180 and serializes nested objects", () => {
    const csv = toCsv([{ a: 'say "hi"', b: { x: 1 }, c: null, d: 3 }], ["a", "b", "c", "d"]);
    expect(csv).toBe('a,b,c,d\n"say ""hi""","{""x"":1}",,3');
  });
});

describe("filterActivities / weekStartOf / weeklySummary", () => {
  it("drops short distance activities but keeps zero-distance ones", () => {
    const filtered = filterActivities(ACTIVITIES, { excludeBelowKm: 8 });
    expect(filtered.map((a) => a.id)).toEqual(["a1", "a3", "a4"]);
  });

  it("filters by type", () => {
    const filtered = filterActivities(ACTIVITIES, { types: ["Ride"] });
    expect(filtered.map((a) => a.id)).toEqual(["a2", "a4"]);
  });

  it("computes week starts for monday and sunday weeks", () => {
    expect(weekStartOf("2026-07-28", "monday")).toBe("2026-07-27"); // Tue → Mon
    expect(weekStartOf("2026-07-27", "monday")).toBe("2026-07-27"); // Mon → itself
    expect(weekStartOf("2026-07-28", "sunday")).toBe("2026-07-26");
    expect(weekStartOf("2026-08-03", "monday")).toBe("2026-08-03");
  });

  it("aggregates per week and type with an ALL row", () => {
    const rows = weeklySummary(ACTIVITIES, "monday");
    const week1All = rows.find((r) => r.week === "2026-07-27" && r.type === "ALL");
    expect(week1All).toMatchObject({ activities: 3, distance_km: 17, load: 135 });
    expect(week1All?.moving_time_h).toBeCloseTo(2.0, 2);
    const week1Run = rows.find((r) => r.week === "2026-07-27" && r.type === "Run");
    expect(week1Run).toMatchObject({ activities: 1, distance_km: 12, load: 80 });
    // ALL sorts last within its week.
    const week1Rows = rows.filter((r) => r.week === "2026-07-27");
    expect(week1Rows[week1Rows.length - 1]?.type).toBe("ALL");
    const week2All = rows.find((r) => r.week === "2026-08-03" && r.type === "ALL");
    expect(week2All).toMatchObject({ activities: 1, distance_km: 87, load: 190 });
  });
});

describe("icu_export_activities", () => {
  it("returns lean default-field CSV without noise fields", async () => {
    const result = await callTool(makeClient(), "icu_export_activities", {
      oldest: "2026-07-01",
      newest: "2026-08-08",
    });
    const text = result.content[0].text;
    const [header, ...rows] = text.split("\n");
    expect(header).toBe(
      "start_date_local,type,name,distance,moving_time,icu_training_load,icu_intensity,average_heartrate,total_elevation_gain",
    );
    expect(rows).toHaveLength(4);
    expect(text).not.toContain("carbs_used_g");
    expect(text).toContain('"Commute, with ""quotes"""');
    expect(lastUrl).toContain("oldest=2026-07-01");
    expect(lastUrl).toContain("newest=2026-08-08");
  });

  it("applies field selection and filters", async () => {
    const result = await callTool(makeClient(), "icu_export_activities", {
      oldest: "2026-07-01",
      fields: ["start_date_local", "type", "distance"],
      types: ["Ride"],
      excludeBelowKm: 8,
    });
    const lines = result.content[0].text.split("\n");
    expect(lines[0]).toBe("start_date_local,type,distance");
    expect(lines).toHaveLength(2); // header + the long ride; commute excluded
    expect(lines[1]).toContain("87000");
  });

  it("answers auth failures with reconnect guidance, not a stack trace", async () => {
    const result = await callTool(makeClient("bad-key"), "icu_export_activities", {
      oldest: "2026-07-01",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("account page");
  });
});

describe("icu_export_wellness", () => {
  it("returns default wellness fields with empty cells for nulls", async () => {
    const result = await callTool(makeClient(), "icu_export_wellness", {
      oldest: "2026-08-01",
      newest: "2026-08-02",
    });
    const lines = result.content[0].text.split("\n");
    expect(lines[0]).toBe("id,ctl,atl,restingHR,hrv,sleepSecs,weight");
    expect(lines[2]).toBe("2026-08-02,81.7,68.9,41,,25200,");
  });
});

describe("icu_export_weekly_summary", () => {
  it("returns the aggregated CSV", async () => {
    const result = await callTool(makeClient(), "icu_export_weekly_summary", {
      oldest: "2026-07-01",
    });
    const text = result.content[0].text;
    expect(text.split("\n")[0]).toBe("week,type,activities,distance_km,moving_time_h,load");
    expect(text).toContain("2026-07-27,ALL,3,17,2,135");
    expect(text).toContain("2026-08-03,Ride,1,87,3.33,190");
  });
});

describe("size guard", () => {
  it("refuses oversized exports with guidance", async () => {
    // Field names land verbatim in the CSV header — enough long ones push the
    // result past the cap regardless of row count.
    const wide = Array.from({ length: 300 }, (_, i) => `f${"x".repeat(500)}_${i}`);
    const result = await callTool(makeClient(), "icu_export_activities", {
      oldest: "2026-07-01",
      fields: wide,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("too large");
    expect(result.content[0].text.length).toBeLessThan(CSV_MAX_CHARS);
  });
});
