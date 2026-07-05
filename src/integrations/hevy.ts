import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolError, toolText } from "../utils/errors.js";

/**
 * Opt-in Hevy integration: a thin client for the Hevy public API plus the MCP
 * tools the coaching workflows use (workout reads, routine management). Tools
 * are registered only for users who stored their own Hevy API key on the
 * account page — each user talks to Hevy as themselves, the server holds no
 * shared credential. An invalid key answers with guidance instead of a stack
 * trace: the tool response IS the "please re-connect" notification channel.
 */

const DEFAULT_API_BASE = "https://api.hevyapp.com/v1";

export class HevyAuthError extends Error {}

export class HevyClient {
  constructor(
    private readonly apiKey: string,
    private readonly base: string = process.env.HEVY_API_BASE ?? DEFAULT_API_BASE,
  ) {}

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        "api-key": this.apiKey,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) {
      throw new HevyAuthError("Hevy rejected the API key");
    }
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw new Error(`Hevy API ${res.status}: ${text}`);
    }
    return res.json();
  }

  /** Cheap validity probe used before storing a key. */
  async validateKey(): Promise<boolean> {
    try {
      await this.request("GET", "/workouts/count");
      return true;
    } catch (err) {
      if (err instanceof HevyAuthError) return false;
      throw err;
    }
  }

  getWorkoutCount(): Promise<unknown> {
    return this.request("GET", "/workouts/count");
  }
  getWorkouts(page: number, pageSize: number): Promise<unknown> {
    return this.request("GET", `/workouts?page=${page}&pageSize=${pageSize}`);
  }
  getWorkout(id: string): Promise<unknown> {
    return this.request("GET", `/workouts/${encodeURIComponent(id)}`);
  }
  getRoutines(page: number, pageSize: number): Promise<unknown> {
    return this.request("GET", `/routines?page=${page}&pageSize=${pageSize}`);
  }
  createRoutine(routine: unknown): Promise<unknown> {
    return this.request("POST", "/routines", { routine });
  }
  updateRoutine(id: string, routine: unknown): Promise<unknown> {
    return this.request("PUT", `/routines/${encodeURIComponent(id)}`, { routine });
  }
  getExerciseTemplates(page: number, pageSize: number): Promise<unknown> {
    return this.request("GET", `/exercise_templates?page=${page}&pageSize=${pageSize}`);
  }
  getRoutineFolders(page: number, pageSize: number): Promise<unknown> {
    return this.request("GET", `/routine_folders?page=${page}&pageSize=${pageSize}`);
  }
  createRoutineFolder(title: string): Promise<unknown> {
    return this.request("POST", "/routine_folders", { routine_folder: { title } });
  }
}

const KEY_GUIDANCE =
  "Your Hevy API key was rejected. Update it on your account page (Integrations) and try again.";

const setSchema = z.object({
  type: z.enum(["normal", "warmup", "failure", "dropset"]).default("normal"),
  weightKg: z.number().nullish().describe("Weight in kg"),
  reps: z.number().int().nullish(),
  distanceMeters: z.number().int().nullish(),
  durationSeconds: z.number().int().nullish(),
});

const exerciseSchema = z.object({
  exerciseTemplateId: z.string().describe("From hevy_get_exercise_templates"),
  supersetId: z.number().int().nullish(),
  restSeconds: z.number().int().nullish(),
  notes: z.string().nullish(),
  sets: z.array(setSchema).min(1),
});

type ExerciseInput = z.infer<typeof exerciseSchema>;

function toApiExercises(exercises: ExerciseInput[]): unknown[] {
  return exercises.map((e) => ({
    exercise_template_id: e.exerciseTemplateId,
    superset_id: e.supersetId ?? null,
    rest_seconds: e.restSeconds ?? null,
    notes: e.notes ?? null,
    sets: e.sets.map((s) => ({
      type: s.type,
      weight_kg: s.weightKg ?? null,
      reps: s.reps ?? null,
      distance_meters: s.distanceMeters ?? null,
      duration_seconds: s.durationSeconds ?? null,
    })),
  }));
}

type ToolResponse = ReturnType<typeof toolText>;

async function run(context: string, fn: () => Promise<unknown>): Promise<ToolResponse> {
  try {
    return toolText(JSON.stringify(await fn(), null, 2));
  } catch (err) {
    if (err instanceof HevyAuthError) return toolText(KEY_GUIDANCE);
    return toolError(`${context}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const pageArgs = {
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(10).default(5),
};

export function registerHevyTools(server: McpServer, client: HevyClient): void {
  server.registerTool(
    "hevy_get_workout_count",
    {
      description: "Total number of workouts logged in the athlete's Hevy account.",
      inputSchema: {},
    },
    () => run("hevy_get_workout_count", () => client.getWorkoutCount()),
  );

  server.registerTool(
    "hevy_get_workouts",
    {
      description: "List the athlete's Hevy workouts, newest first (paged).",
      inputSchema: pageArgs,
    },
    ({ page, pageSize }) => run("hevy_get_workouts", () => client.getWorkouts(page, pageSize)),
  );

  server.registerTool(
    "hevy_get_workout",
    {
      description: "One Hevy workout in full detail (exercises, sets, weights).",
      inputSchema: { workoutId: z.string() },
    },
    ({ workoutId }) => run("hevy_get_workout", () => client.getWorkout(workoutId)),
  );

  server.registerTool(
    "hevy_get_routines",
    { description: "List the athlete's Hevy routines (paged).", inputSchema: pageArgs },
    ({ page, pageSize }) => run("hevy_get_routines", () => client.getRoutines(page, pageSize)),
  );

  server.registerTool(
    "hevy_create_routine",
    {
      description:
        "Create a Hevy routine. Exercises reference template ids from hevy_get_exercise_templates.",
      inputSchema: {
        title: z.string().min(1),
        folderId: z.number().int().nullish().describe("From hevy_get_routine_folders"),
        notes: z.string().nullish(),
        exercises: z.array(exerciseSchema).min(1),
      },
    },
    ({ title, folderId, notes, exercises }) =>
      run("hevy_create_routine", () =>
        client.createRoutine({
          title,
          folder_id: folderId ?? null,
          notes: notes ?? "",
          exercises: toApiExercises(exercises),
        }),
      ),
  );

  server.registerTool(
    "hevy_update_routine",
    {
      description: "Replace an existing Hevy routine's title/notes/exercises.",
      inputSchema: {
        routineId: z.string(),
        title: z.string().min(1),
        notes: z.string().nullish(),
        exercises: z.array(exerciseSchema).min(1),
      },
    },
    ({ routineId, title, notes, exercises }) =>
      run("hevy_update_routine", () =>
        client.updateRoutine(routineId, {
          title,
          notes: notes ?? "",
          exercises: toApiExercises(exercises),
        }),
      ),
  );

  server.registerTool(
    "hevy_get_exercise_templates",
    {
      description: "List Hevy exercise templates (paged) — source of exerciseTemplateId values.",
      inputSchema: pageArgs,
    },
    ({ page, pageSize }) =>
      run("hevy_get_exercise_templates", () => client.getExerciseTemplates(page, pageSize)),
  );

  server.registerTool(
    "hevy_get_routine_folders",
    { description: "List Hevy routine folders (paged).", inputSchema: pageArgs },
    ({ page, pageSize }) =>
      run("hevy_get_routine_folders", () => client.getRoutineFolders(page, pageSize)),
  );

  server.registerTool(
    "hevy_create_routine_folder",
    {
      description: "Create a Hevy routine folder.",
      inputSchema: { title: z.string().min(1) },
    },
    ({ title }) => run("hevy_create_routine_folder", () => client.createRoutineFolder(title)),
  );
}
