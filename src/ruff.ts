/**
 * In-process Python validation for the scripts store, via ruff compiled to
 * WebAssembly (`@astral-sh/ruff-wasm-nodejs`). Chosen over a `uvx ruff` child
 * process deliberately: no Python toolchain in the image, no runtime package
 * download, no writable filesystem or subprocess management — the linter is
 * an npm dependency pinned by the lockfile like everything else.
 *
 * The workspace is created lazily on first use (loading the WASM module costs
 * tens of ms and most sessions never save a script) and cached for the
 * process lifetime. Rule selection is deliberately narrow — parse errors plus
 * the F family and structural E rules — so an LLM-authored analysis script
 * gets real-mistake feedback (undefined names, unused imports) without style
 * noise. Target version tracks the Python the scripts actually run on.
 */

export type PythonDiagnostic = {
  code: string | null;
  message: string;
  row: number;
  column: number;
};

export type PythonCheck = {
  /** Parse errors — the code cannot run; saves are rejected. */
  syntaxErrors: PythonDiagnostic[];
  /** Lint findings — worth fixing, returned as warnings. */
  lintWarnings: PythonDiagnostic[];
};

type WasmDiagnostic = {
  code: string | null;
  message: string;
  start_location: { row: number; column: number };
};

type Workspace = { check(contents: string): WasmDiagnostic[] };

const RUFF_SETTINGS = {
  "target-version": "py312",
  lint: { select: ["E4", "E7", "E9", "F"] },
};

let workspacePromise: Promise<Workspace | undefined> | undefined;

function loadWorkspace(): Promise<Workspace | undefined> {
  workspacePromise ??= (async () => {
    try {
      const mod = (await import("@astral-sh/ruff-wasm-nodejs")) as unknown as {
        default?: Record<string, unknown>;
      } & Record<string, unknown>;
      const api = (mod.default ?? mod) as {
        Workspace: new (options: unknown, encoding: number) => Workspace;
        PositionEncoding: { Utf16: number };
      };
      return new api.Workspace(RUFF_SETTINGS, api.PositionEncoding.Utf16);
    } catch {
      // Validation is a quality gate, not a load-bearing dependency — a
      // missing/broken WASM module degrades to "no validation", never to
      // "no script saves".
      return undefined;
    }
  })();
  return workspacePromise;
}

/**
 * Check Python source. Returns undefined when the validator is unavailable
 * (callers proceed without validation and say so).
 */
export async function checkPython(code: string): Promise<PythonCheck | undefined> {
  const workspace = await loadWorkspace();
  if (!workspace) return undefined;
  let diagnostics: WasmDiagnostic[];
  try {
    diagnostics = workspace.check(code);
  } catch {
    return undefined;
  }
  const result: PythonCheck = { syntaxErrors: [], lintWarnings: [] };
  for (const d of diagnostics) {
    const mapped: PythonDiagnostic = {
      code: d.code,
      message: d.message,
      row: d.start_location.row,
      column: d.start_location.column,
    };
    if (d.code === null || d.code === "invalid-syntax") result.syntaxErrors.push(mapped);
    else result.lintWarnings.push(mapped);
  }
  return result;
}

export function formatDiagnostics(diags: PythonDiagnostic[], max = 10): string {
  const lines = diags
    .slice(0, max)
    .map((d) => `- line ${d.row}:${d.column}${d.code ? ` [${d.code}]` : ""} ${d.message}`);
  if (diags.length > max) lines.push(`- … and ${diags.length - max} more`);
  return lines.join("\n");
}
