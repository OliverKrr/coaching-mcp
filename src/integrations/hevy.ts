import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolError, toolText } from "../utils/errors.js";

/**
 * Opt-in Hevy integration: a thin client for the full Hevy public API surface
 * (workouts, routines, exercise templates & history, routine folders, body
 * measurements, user info). Tools are registered only for users who stored
 * their own Hevy API key on the account page — each user talks to Hevy as
 * themselves, the server holds no shared credential. An invalid key answers
 * with guidance instead of a stack trace: the tool response IS the "please
 * re-connect" notification channel.
 *
 * Wire-format constraints (per the Hevy OpenAPI spec): request bodies wrap
 * their payload (`{workout:…}`, `{routine:…}`, `{routine_folder:…}`,
 * `{exercise:…}`) EXCEPT body measurements, which are flat and reject null
 * for omitted fields. Workout sets support `rpe`; routine sets support
 * `rep_range` instead. A routine's folder cannot be changed via update.
 */

const DEFAULT_API_BASE = "https://api.hevyapp.com/v1";

export class HevyAuthError extends Error {}

export class HevyClient {
  private templatesCache?: Array<Record<string, unknown>>;

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

  // -- workouts --------------------------------------------------------------
  getWorkoutCount(): Promise<unknown> {
    return this.request("GET", "/workouts/count");
  }
  getWorkouts(page: number, pageSize: number): Promise<unknown> {
    return this.request("GET", `/workouts?page=${page}&pageSize=${pageSize}`);
  }
  getWorkout(id: string): Promise<unknown> {
    return this.request("GET", `/workouts/${encodeURIComponent(id)}`);
  }
  getWorkoutEvents(page: number, pageSize: number, since: string): Promise<unknown> {
    return this.request(
      "GET",
      `/workouts/events?page=${page}&pageSize=${pageSize}&since=${encodeURIComponent(since)}`,
    );
  }
  createWorkout(workout: unknown): Promise<unknown> {
    return this.request("POST", "/workouts", { workout });
  }
  updateWorkout(id: string, workout: unknown): Promise<unknown> {
    return this.request("PUT", `/workouts/${encodeURIComponent(id)}`, { workout });
  }

  // -- routines --------------------------------------------------------------
  getRoutines(page: number, pageSize: number): Promise<unknown> {
    return this.request("GET", `/routines?page=${page}&pageSize=${pageSize}`);
  }
  getRoutine(id: string): Promise<unknown> {
    return this.request("GET", `/routines/${encodeURIComponent(id)}`);
  }
  createRoutine(routine: unknown): Promise<unknown> {
    return this.request("POST", "/routines", { routine });
  }
  updateRoutine(id: string, routine: unknown): Promise<unknown> {
    return this.request("PUT", `/routines/${encodeURIComponent(id)}`, { routine });
  }

  // -- exercise templates & history -------------------------------------------
  getExerciseTemplates(page: number, pageSize: number): Promise<unknown> {
    return this.request("GET", `/exercise_templates?page=${page}&pageSize=${pageSize}`);
  }
  getExerciseTemplate(id: string): Promise<unknown> {
    return this.request("GET", `/exercise_templates/${encodeURIComponent(id)}`);
  }
  createExerciseTemplate(exercise: unknown): Promise<unknown> {
    return this.request("POST", "/exercise_templates", { exercise });
  }
  getExerciseHistory(id: string, startDate?: string, endDate?: string): Promise<unknown> {
    const q = new URLSearchParams();
    if (startDate) q.set("start_date", startDate);
    if (endDate) q.set("end_date", endDate);
    const suffix = q.size > 0 ? `?${q.toString()}` : "";
    return this.request("GET", `/exercise_history/${encodeURIComponent(id)}${suffix}`);
  }

  /**
   * Full template catalog (built-in + the user's custom ones), fetched at the
   * endpoint's max page size and cached per client — i.e. per MCP session, so
   * one user's custom templates never leak into another session.
   */
  async allExerciseTemplates(refresh = false): Promise<Array<Record<string, unknown>>> {
    if (!refresh && this.templatesCache) return this.templatesCache;
    const all: Array<Record<string, unknown>> = [];
    for (let page = 1; ; page++) {
      const res = (await this.request("GET", `/exercise_templates?page=${page}&pageSize=100`)) as {
        page_count?: number;
        exercise_templates?: Array<Record<string, unknown>>;
      };
      all.push(...(res.exercise_templates ?? []));
      if (page >= (res.page_count ?? 1)) break;
    }
    this.templatesCache = all;
    return all;
  }

  // -- routine folders ---------------------------------------------------------
  getRoutineFolders(page: number, pageSize: number): Promise<unknown> {
    return this.request("GET", `/routine_folders?page=${page}&pageSize=${pageSize}`);
  }
  getRoutineFolder(id: number): Promise<unknown> {
    return this.request("GET", `/routine_folders/${id}`);
  }
  createRoutineFolder(title: string): Promise<unknown> {
    return this.request("POST", "/routine_folders", { routine_folder: { title } });
  }

  // -- body measurements --------------------------------------------------------
  getBodyMeasurements(page: number, pageSize: number): Promise<unknown> {
    return this.request("GET", `/body_measurements?page=${page}&pageSize=${pageSize}`);
  }
  getBodyMeasurement(date: string): Promise<unknown> {
    return this.request("GET", `/body_measurements/${encodeURIComponent(date)}`);
  }
  createBodyMeasurement(measurement: Record<string, number | string>): Promise<unknown> {
    return this.request("POST", "/body_measurements", measurement);
  }
  updateBodyMeasurement(date: string, measurement: Record<string, number>): Promise<unknown> {
    return this.request("PUT", `/body_measurements/${encodeURIComponent(date)}`, measurement);
  }

  // -- user -----------------------------------------------------------------
  getUserInfo(): Promise<unknown> {
    return this.request("GET", "/user/info");
  }
}

const KEY_GUIDANCE =
  "Your Hevy API key was rejected. Update it on your account page (Integrations) and try again.";

// -- schemas & wire mapping ----------------------------------------------------

const SET_TYPES = ["normal", "warmup", "failure", "dropset"] as const;

const repRangeSchema = z.object({
  start: z.number().int().nullish(),
  end: z.number().int().nullish(),
});

const routineSetSchema = z.object({
  type: z.enum(SET_TYPES).default("normal"),
  weightKg: z.number().nullish().describe("Weight in kg"),
  reps: z.number().int().nullish(),
  repRange: repRangeSchema.nullish().describe("Target rep range, e.g. {start:8,end:12}"),
  distanceMeters: z.number().int().nullish(),
  durationSeconds: z.number().int().nullish(),
  customMetric: z.number().nullish(),
});

const workoutSetSchema = z.object({
  type: z.enum(SET_TYPES).default("normal"),
  weightKg: z.number().nullish().describe("Weight in kg"),
  reps: z.number().int().nullish(),
  distanceMeters: z.number().int().nullish(),
  durationSeconds: z.number().int().nullish(),
  rpe: z.number().nullish().describe("Rating of perceived exertion: 6–10 in 0.5 steps"),
  customMetric: z.number().nullish(),
});

const routineExerciseSchema = z.object({
  exerciseTemplateId: z.string().describe("From hevy_search_exercise_templates"),
  supersetId: z.number().int().nullish(),
  restSeconds: z.number().int().nullish(),
  notes: z.string().nullish(),
  sets: z.array(routineSetSchema).min(1),
});

const workoutExerciseSchema = z.object({
  exerciseTemplateId: z.string().describe("From hevy_search_exercise_templates"),
  supersetId: z.number().int().nullish(),
  notes: z.string().nullish(),
  sets: z.array(workoutSetSchema).min(1),
});

type RoutineExerciseInput = z.infer<typeof routineExerciseSchema>;
type WorkoutExerciseInput = z.infer<typeof workoutExerciseSchema>;

/** Routine wire format. The API accepts `rep_range: null` on create but not on update — omit there. */
function toApiRoutineExercises(
  exercises: RoutineExerciseInput[],
  { omitNullRepRange }: { omitNullRepRange: boolean },
): unknown[] {
  return exercises.map((e) => ({
    exercise_template_id: e.exerciseTemplateId,
    superset_id: e.supersetId ?? null,
    rest_seconds: e.restSeconds ?? null,
    notes: e.notes ?? null,
    sets: e.sets.map((s) => ({
      type: s.type,
      weight_kg: s.weightKg ?? null,
      reps: s.reps ?? null,
      ...(s.repRange || !omitNullRepRange ? { rep_range: s.repRange ?? null } : {}),
      distance_meters: s.distanceMeters ?? null,
      duration_seconds: s.durationSeconds ?? null,
      custom_metric: s.customMetric ?? null,
    })),
  }));
}

function toApiWorkoutExercises(exercises: WorkoutExerciseInput[]): unknown[] {
  return exercises.map((e) => ({
    exercise_template_id: e.exerciseTemplateId,
    superset_id: e.supersetId ?? null,
    notes: e.notes ?? null,
    sets: e.sets.map((s) => ({
      type: s.type,
      weight_kg: s.weightKg ?? null,
      reps: s.reps ?? null,
      distance_meters: s.distanceMeters ?? null,
      duration_seconds: s.durationSeconds ?? null,
      rpe: s.rpe ?? null,
      custom_metric: s.customMetric ?? null,
    })),
  }));
}

const EXERCISE_TYPES = [
  "weight_reps",
  "reps_only",
  "bodyweight_reps",
  "bodyweight_assisted_reps",
  "duration",
  "weight_duration",
  "distance_duration",
  "short_distance_weight",
] as const;

const EQUIPMENT_CATEGORIES = [
  "none",
  "barbell",
  "dumbbell",
  "kettlebell",
  "machine",
  "plate",
  "resistance_band",
  "suspension",
  "other",
] as const;

const MUSCLE_GROUPS = [
  "abdominals",
  "shoulders",
  "biceps",
  "triceps",
  "forearms",
  "quadriceps",
  "hamstrings",
  "calves",
  "glutes",
  "abductors",
  "adductors",
  "lats",
  "upper_back",
  "traps",
  "lower_back",
  "chest",
  "cardio",
  "neck",
  "full_body",
  "other",
] as const;

/** camelCase tool params → the flat snake_case fields body-measurement writes use. */
const MEASUREMENT_FIELD_MAP: Record<string, string> = {
  weightKg: "weight_kg",
  leanMassKg: "lean_mass_kg",
  fatPercent: "fat_percent",
  neckCm: "neck_cm",
  shoulderCm: "shoulder_cm",
  chestCm: "chest_cm",
  leftBicepCm: "left_bicep_cm",
  rightBicepCm: "right_bicep_cm",
  leftForearmCm: "left_forearm_cm",
  rightForearmCm: "right_forearm_cm",
  abdomen: "abdomen",
  waist: "waist",
  hips: "hips",
  leftThigh: "left_thigh",
  rightThigh: "right_thigh",
  leftCalf: "left_calf",
  rightCalf: "right_calf",
};

const measurementShape = Object.fromEntries(
  Object.keys(MEASUREMENT_FIELD_MAP).map((k) => [k, z.number().nullish()]),
) as Record<keyof typeof MEASUREMENT_FIELD_MAP, z.ZodOptional<z.ZodNullable<z.ZodNumber>>>;

/** Only provided fields go on the wire — the API rejects null for omitted measurements. */
function toApiMeasurements(input: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [camel, snake] of Object.entries(MEASUREMENT_FIELD_MAP)) {
    const value = input[camel];
    if (typeof value === "number") out[snake] = value;
  }
  return out;
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

// Every Hevy tool talks to the external Hevy API (openWorldHint). Clients
// (e.g. claude.ai's connector UI) group tools by these hints.
const HEVY_READ = { readOnlyHint: true, openWorldHint: true } as const;
const HEVY_CREATE = { destructiveHint: false, openWorldHint: true } as const;
const HEVY_REPLACE = { destructiveHint: true, idempotentHint: true, openWorldHint: true } as const;

const isoUtcSecond = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "expected YYYY-MM-DDTHH:MM:SSZ");

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export function registerHevyTools(server: McpServer, client: HevyClient): void {
  // -- workouts --------------------------------------------------------------
  server.registerTool(
    "hevy_get_workout_count",
    {
      title: "Hevy: workout count",
      description: "Total number of workouts logged in the athlete's Hevy account.",
      inputSchema: {},
      annotations: HEVY_READ,
    },
    () => run("hevy_get_workout_count", () => client.getWorkoutCount()),
  );

  server.registerTool(
    "hevy_get_workouts",
    {
      title: "Hevy: list workouts",
      description: "List the athlete's Hevy workouts, newest first (paged).",
      inputSchema: pageArgs,
      annotations: HEVY_READ,
    },
    ({ page, pageSize }) => run("hevy_get_workouts", () => client.getWorkouts(page, pageSize)),
  );

  server.registerTool(
    "hevy_get_workout",
    {
      title: "Hevy: get workout",
      description: "One Hevy workout in full detail (exercises, sets, weights).",
      inputSchema: { workoutId: z.string() },
      annotations: HEVY_READ,
    },
    ({ workoutId }) => run("hevy_get_workout", () => client.getWorkout(workoutId)),
  );

  server.registerTool(
    "hevy_get_workout_events",
    {
      title: "Hevy: workout events",
      description:
        "Workout update/delete events since a timestamp (paged) — for incremental sync instead of re-reading all workouts.",
      inputSchema: {
        ...pageArgs,
        since: isoUtcSecond.default("1970-01-01T00:00:00Z"),
      },
      annotations: HEVY_READ,
    },
    ({ page, pageSize, since }) =>
      run("hevy_get_workout_events", () => client.getWorkoutEvents(page, pageSize, since)),
  );

  server.registerTool(
    "hevy_create_workout",
    {
      title: "Hevy: log workout",
      description:
        "Log a completed workout in Hevy (manual entry). Exercises reference template ids from hevy_search_exercise_templates.",
      inputSchema: {
        title: z.string().min(1),
        description: z.string().nullish(),
        startTime: isoUtcSecond,
        endTime: isoUtcSecond,
        isPrivate: z.boolean().default(false),
        exercises: z.array(workoutExerciseSchema).min(1),
      },
      annotations: HEVY_CREATE,
    },
    ({ title, description, startTime, endTime, isPrivate, exercises }) =>
      run("hevy_create_workout", () =>
        client.createWorkout({
          title,
          description: description ?? null,
          start_time: startTime,
          end_time: endTime,
          is_private: isPrivate,
          exercises: toApiWorkoutExercises(exercises),
        }),
      ),
  );

  server.registerTool(
    "hevy_update_workout",
    {
      title: "Hevy: replace workout",
      description: "Replace an existing Hevy workout entirely (same shape as hevy_create_workout).",
      annotations: HEVY_REPLACE,
      inputSchema: {
        workoutId: z.string(),
        title: z.string().min(1),
        description: z.string().nullish(),
        startTime: isoUtcSecond,
        endTime: isoUtcSecond,
        isPrivate: z.boolean().default(false),
        exercises: z.array(workoutExerciseSchema).min(1),
      },
    },
    ({ workoutId, title, description, startTime, endTime, isPrivate, exercises }) =>
      run("hevy_update_workout", () =>
        client.updateWorkout(workoutId, {
          title,
          description: description ?? null,
          start_time: startTime,
          end_time: endTime,
          is_private: isPrivate,
          exercises: toApiWorkoutExercises(exercises),
        }),
      ),
  );

  // -- routines --------------------------------------------------------------
  server.registerTool(
    "hevy_get_routines",
    {
      title: "Hevy: list routines",
      description: "List the athlete's Hevy routines (paged).",
      inputSchema: pageArgs,
      annotations: HEVY_READ,
    },
    ({ page, pageSize }) => run("hevy_get_routines", () => client.getRoutines(page, pageSize)),
  );

  server.registerTool(
    "hevy_get_routine",
    {
      title: "Hevy: get routine",
      description: "One Hevy routine in full detail.",
      inputSchema: { routineId: z.string() },
      annotations: HEVY_READ,
    },
    ({ routineId }) => run("hevy_get_routine", () => client.getRoutine(routineId)),
  );

  server.registerTool(
    "hevy_create_routine",
    {
      title: "Hevy: create routine",
      description:
        "Create a Hevy routine. Exercises reference template ids from hevy_search_exercise_templates; routine sets support repRange instead of rpe.",
      annotations: HEVY_CREATE,
      inputSchema: {
        title: z.string().min(1),
        folderId: z.number().int().nullish().describe("From hevy_get_routine_folders"),
        notes: z.string().nullish(),
        exercises: z.array(routineExerciseSchema).min(1),
      },
    },
    ({ title, folderId, notes, exercises }) =>
      run("hevy_create_routine", () =>
        client.createRoutine({
          title,
          folder_id: folderId ?? null,
          notes: notes ?? "",
          exercises: toApiRoutineExercises(exercises, { omitNullRepRange: false }),
        }),
      ),
  );

  server.registerTool(
    "hevy_update_routine",
    {
      title: "Hevy: replace routine",
      description:
        "Replace an existing Hevy routine's title/notes/exercises (the folder cannot be changed via update).",
      annotations: HEVY_REPLACE,
      inputSchema: {
        routineId: z.string(),
        title: z.string().min(1),
        notes: z.string().nullish(),
        exercises: z.array(routineExerciseSchema).min(1),
      },
    },
    ({ routineId, title, notes, exercises }) =>
      run("hevy_update_routine", () =>
        client.updateRoutine(routineId, {
          title,
          notes: notes ?? "",
          exercises: toApiRoutineExercises(exercises, { omitNullRepRange: true }),
        }),
      ),
  );

  // -- exercise templates & history -------------------------------------------
  server.registerTool(
    "hevy_search_exercise_templates",
    {
      title: "Hevy: search exercises",
      description:
        "Find exercise templates by title substring (optionally filtered by primary muscle group). Searches the full catalog including the user's custom exercises — prefer this over paging hevy_get_exercise_templates.",
      annotations: HEVY_READ,
      inputSchema: {
        query: z.string().min(1),
        muscleGroup: z.enum(MUSCLE_GROUPS).nullish(),
        refresh: z.boolean().default(false).describe("Bypass the session's catalog cache"),
      },
    },
    ({ query, muscleGroup, refresh }) =>
      run("hevy_search_exercise_templates", async () => {
        const all = await client.allExerciseTemplates(refresh);
        const q = query.toLowerCase();
        return all.filter(
          (tpl) =>
            String(tpl.title ?? "")
              .toLowerCase()
              .includes(q) &&
            (!muscleGroup || tpl.primary_muscle_group === muscleGroup),
        );
      }),
  );

  server.registerTool(
    "hevy_get_exercise_templates",
    {
      title: "Hevy: list exercise templates",
      description:
        "List Hevy exercise templates page by page (see also hevy_search_exercise_templates).",
      inputSchema: {
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(100).default(5),
      },
      annotations: HEVY_READ,
    },
    ({ page, pageSize }) =>
      run("hevy_get_exercise_templates", () => client.getExerciseTemplates(page, pageSize)),
  );

  server.registerTool(
    "hevy_get_exercise_template",
    {
      title: "Hevy: get exercise template",
      description: "One exercise template by id (title, type, muscle groups).",
      inputSchema: { exerciseTemplateId: z.string() },
      annotations: HEVY_READ,
    },
    ({ exerciseTemplateId }) =>
      run("hevy_get_exercise_template", () => client.getExerciseTemplate(exerciseTemplateId)),
  );

  server.registerTool(
    "hevy_get_exercise_history",
    {
      title: "Hevy: exercise history",
      description:
        "All logged sets of one exercise across workouts (optionally date-bounded) — progression analysis.",
      annotations: HEVY_READ,
      inputSchema: {
        exerciseTemplateId: z.string(),
        startDate: z.string().nullish().describe("ISO 8601 datetime with offset"),
        endDate: z.string().nullish().describe("ISO 8601 datetime with offset"),
      },
    },
    ({ exerciseTemplateId, startDate, endDate }) =>
      run("hevy_get_exercise_history", () =>
        client.getExerciseHistory(exerciseTemplateId, startDate ?? undefined, endDate ?? undefined),
      ),
  );

  server.registerTool(
    "hevy_create_exercise_template",
    {
      title: "Hevy: create custom exercise",
      description: "Create a custom exercise template in the athlete's Hevy account.",
      annotations: HEVY_CREATE,
      inputSchema: {
        title: z.string().min(1),
        exerciseType: z.enum(EXERCISE_TYPES),
        equipmentCategory: z.enum(EQUIPMENT_CATEGORIES),
        muscleGroup: z.enum(MUSCLE_GROUPS),
        otherMuscles: z.array(z.enum(MUSCLE_GROUPS)).default([]),
      },
    },
    ({ title, exerciseType, equipmentCategory, muscleGroup, otherMuscles }) =>
      run("hevy_create_exercise_template", () =>
        client.createExerciseTemplate({
          title,
          exercise_type: exerciseType,
          equipment_category: equipmentCategory,
          muscle_group: muscleGroup,
          other_muscles: otherMuscles,
        }),
      ),
  );

  // -- routine folders ---------------------------------------------------------
  server.registerTool(
    "hevy_get_routine_folders",
    {
      title: "Hevy: list routine folders",
      description: "List Hevy routine folders (paged).",
      inputSchema: pageArgs,
      annotations: HEVY_READ,
    },
    ({ page, pageSize }) =>
      run("hevy_get_routine_folders", () => client.getRoutineFolders(page, pageSize)),
  );

  server.registerTool(
    "hevy_get_routine_folder",
    {
      title: "Hevy: get routine folder",
      description: "One Hevy routine folder by id.",
      inputSchema: { folderId: z.number().int() },
      annotations: HEVY_READ,
    },
    ({ folderId }) => run("hevy_get_routine_folder", () => client.getRoutineFolder(folderId)),
  );

  server.registerTool(
    "hevy_create_routine_folder",
    {
      title: "Hevy: create routine folder",
      description: "Create a Hevy routine folder.",
      inputSchema: { title: z.string().min(1) },
      annotations: HEVY_CREATE,
    },
    ({ title }) => run("hevy_create_routine_folder", () => client.createRoutineFolder(title)),
  );

  // -- body measurements --------------------------------------------------------
  server.registerTool(
    "hevy_get_body_measurements",
    {
      title: "Hevy: list body measurements",
      description: "List the athlete's body measurements (weight, body fat, girths; paged).",
      inputSchema: {
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(10).default(10),
      },
      annotations: HEVY_READ,
    },
    ({ page, pageSize }) =>
      run("hevy_get_body_measurements", () => client.getBodyMeasurements(page, pageSize)),
  );

  server.registerTool(
    "hevy_get_body_measurement",
    {
      title: "Hevy: get body measurement",
      description: "The body measurement entry for one date (404 if none exists).",
      inputSchema: { date: isoDate },
      annotations: HEVY_READ,
    },
    ({ date }) => run("hevy_get_body_measurement", () => client.getBodyMeasurement(date)),
  );

  server.registerTool(
    "hevy_create_body_measurement",
    {
      title: "Hevy: record body measurement",
      description:
        "Record a body measurement for a date (one entry per date; use hevy_update_body_measurement if the date exists). Provide only the measured fields.",
      inputSchema: { date: isoDate, ...measurementShape },
      annotations: HEVY_CREATE,
    },
    (args) =>
      run("hevy_create_body_measurement", () =>
        client.createBodyMeasurement({ date: args.date, ...toApiMeasurements(args) }),
      ),
  );

  server.registerTool(
    "hevy_update_body_measurement",
    {
      title: "Hevy: update body measurement",
      description:
        "Update an existing date's body measurement. Only provided fields change; fields cannot be cleared.",
      inputSchema: { date: isoDate, ...measurementShape },
      annotations: HEVY_REPLACE,
    },
    (args) =>
      run("hevy_update_body_measurement", () =>
        client.updateBodyMeasurement(args.date, toApiMeasurements(args)),
      ),
  );

  // -- user -----------------------------------------------------------------
  server.registerTool(
    "hevy_get_user_info",
    {
      title: "Hevy: account info",
      description: "The athlete's Hevy account info (id, name, public profile URL).",
      inputSchema: {},
      annotations: HEVY_READ,
    },
    () => run("hevy_get_user_info", () => client.getUserInfo()),
  );
}
