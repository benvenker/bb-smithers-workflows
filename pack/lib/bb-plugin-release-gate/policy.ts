import { z } from "zod/v4";

export const releaseGateSurfaceSchema = z.enum(["backend", "frontend"]);
export type ReleaseGateSurface = z.infer<typeof releaseGateSurfaceSchema>;

export const releaseGateCommandSchema = z
  .object({
    executable: z.string().min(1).describe('Executable name, or "$packageManager" for the detected npm/Bun binary.'),
    args: z.array(z.string()).default([]),
    timeoutMs: z.number().int().positive().max(60 * 60_000).default(10 * 60_000),
  })
  .strict();

export const releaseGateStaticCheckSchema = releaseGateCommandSchema.extend({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
});

export const releaseGateArtifactSchema = z
  .object({
    path: z.string().min(1).describe("Path relative to pluginRoot."),
    required: z.boolean().default(true),
    minBytes: z.number().int().nonnegative().optional(),
    maxBytes: z.number().int().positive().optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  })
  .strict()
  .superRefine((artifact, ctx) => {
    if (artifact.minBytes !== undefined && artifact.maxBytes !== undefined && artifact.minBytes > artifact.maxBytes) {
      ctx.addIssue({ code: "custom", message: "minBytes cannot exceed maxBytes" });
    }
  });

export const releaseGateWaiverSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    scope: z.string().min(1).describe("Exact failure key, such as harness:frontend or artifact:dist/app.js."),
    reason: z.string().min(20),
    expiresAt: z.iso.datetime().optional(),
  })
  .strict();

export const releaseGateLiveCheckSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    command: releaseGateCommandSchema,
    mutating: z.boolean().default(false),
    rollback: releaseGateCommandSchema.optional(),
    verifyRollback: releaseGateCommandSchema.optional(),
  })
  .strict()
  .superRefine((check, ctx) => {
    if (check.mutating && !check.rollback) {
      ctx.addIssue({ code: "custom", path: ["rollback"], message: "mutating live checks require rollback" });
    }
    if (!check.mutating && (check.rollback || check.verifyRollback)) {
      ctx.addIssue({ code: "custom", message: "non-mutating live checks cannot declare rollback commands" });
    }
    if (check.verifyRollback && !check.rollback) {
      ctx.addIssue({ code: "custom", path: ["verifyRollback"], message: "verifyRollback requires rollback" });
    }
  });

export const releaseGateRolloutSchema = z
  .object({
    pluginId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    source: z.string().min(1).optional(),
  })
  .strict();

function executableName(command: z.infer<typeof releaseGateCommandSchema>): string {
  return command.executable.split(/[\\/]/).at(-1)?.toLowerCase() ?? command.executable.toLowerCase();
}

function normalizedPolicyPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function commandTargetsHarnessSource(
  command: z.infer<typeof releaseGateCommandSchema>,
  sources: readonly string[],
): boolean {
  const args = new Set(command.args.map(normalizedPolicyPath));
  return sources.some((source) => args.has(normalizedPolicyPath(source)));
}

function isExactBbPluginCommand(
  command: z.infer<typeof releaseGateCommandSchema>,
  operation: string,
  operand: string,
  options: readonly string[],
): boolean {
  const expectedArgs = ["plugin", operation, operand, ...options];
  return executableName(command) === "bb"
    && command.args.length === expectedArgs.length
    && command.args.every((arg, index) => arg === expectedArgs[index]);
}

function verifyCommandMutationReason(command: z.infer<typeof releaseGateCommandSchema>): string | null {
  const executable = executableName(command);
  const args = command.args.map((arg) => arg.toLowerCase());
  const first = args[0] ?? "";
  if (["sh", "bash", "zsh", "fish", "pwsh", "powershell", "cmd", "npx", "bunx"].includes(executable)) {
    return `${executable} can hide or install a mutating command; use a direct executable or package-manager script`;
  }
  if (["git", "gh"].includes(executable)) return `${executable} is not allowed in verify-phase commands`;
  if (executable === "npm" && ["install", "i", "ci", "add", "remove", "uninstall", "update", "publish", "unpublish", "version"].includes(first)) {
    return `npm ${first} is not allowed in verify mode`;
  }
  if (executable === "bun" && ["install", "i", "add", "remove", "update", "publish", "x"].includes(first)) {
    return `bun ${first} is not allowed in verify mode`;
  }
  if (executable === "bb" && args[0] === "plugin" && ["install", "update", "reload", "remove", "enable", "disable", "dev", "config"].includes(args[1] ?? "")) {
    return `bb plugin ${args[1]} is a live mutation and belongs only in release actions`;
  }
  return null;
}

export const releaseGatePolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    packageManager: z.enum(["auto", "npm", "bun"]).default("auto"),
    surfaces: z.array(releaseGateSurfaceSchema).max(2).optional(),
    staticChecks: z.array(releaseGateStaticCheckSchema).default([]),
    harness: z
      .object({ backend: releaseGateCommandSchema.optional(), frontend: releaseGateCommandSchema.optional() })
      .strict()
      .default({}),
    harnessSources: z
      .object({
        backend: z.array(z.string().min(1)).default([]),
        frontend: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .default({ backend: [], frontend: [] }),
    build: releaseGateCommandSchema,
    artifacts: z.array(releaseGateArtifactSchema).default([]),
    waivers: z.array(releaseGateWaiverSchema).default([]),
    liveChecks: z.array(releaseGateLiveCheckSchema).default([]),
    requireReleaseApproval: z.boolean().default(true),
    rollout: releaseGateRolloutSchema.optional(),
    releaseActions: z
      .object({
        commit: releaseGateCommandSchema.optional(),
        push: releaseGateCommandSchema.optional(),
        publish: releaseGateCommandSchema.optional(),
        install: releaseGateCommandSchema.optional(),
        update: releaseGateCommandSchema.optional(),
        reload: releaseGateCommandSchema.optional(),
      })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((policy, ctx) => {
    const unique = (items: readonly string[], path: string) => {
      if (new Set(items).size !== items.length) {
        ctx.addIssue({ code: "custom", path: [path], message: `${path} ids must be unique` });
      }
    };
    unique(policy.staticChecks.map((check) => check.id), "staticChecks");
    unique(policy.liveChecks.map((check) => check.id), "liveChecks");
    unique(policy.waivers.map((waiver) => waiver.id), "waivers");
    if (policy.surfaces && new Set(policy.surfaces).size !== policy.surfaces.length) {
      ctx.addIssue({ code: "custom", path: ["surfaces"], message: "surfaces must be unique" });
    }
    for (const surface of ["backend", "frontend"] as const) {
      const sources = policy.harnessSources[surface] ?? [];
      if (policy.harness[surface] && sources.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["harnessSources", surface],
          message: `${surface} harness commands require at least one declared source path`,
        });
      }
      if (policy.harness[surface] && sources.length > 0 && !commandTargetsHarnessSource(policy.harness[surface], sources)) {
        ctx.addIssue({
          code: "custom",
          path: ["harness", surface],
          message: `${surface} harness command must target at least one declared harness source`,
        });
      }
      if (new Set(sources).size !== sources.length) {
        ctx.addIssue({ code: "custom", path: ["harnessSources", surface], message: `${surface} harness source paths must be unique` });
      }
    }
    const verifyCommands: Array<{ path: Array<string | number>; command: z.infer<typeof releaseGateCommandSchema> }> = [
      ...policy.staticChecks.map((command, index) => ({ path: ["staticChecks", index], command })),
      ...Object.entries(policy.harness).map(([surface, command]) => ({ path: ["harness", surface], command })),
      { path: ["build"], command: policy.build },
    ];
    for (const entry of verifyCommands) {
      const reason = verifyCommandMutationReason(entry.command);
      if (reason) ctx.addIssue({ code: "custom", path: entry.path, message: reason });
    }
    if (policy.rollout?.source) {
      const { pluginId, source } = policy.rollout;
      const { install, update, reload } = policy.releaseActions;
      if (!install || !isExactBbPluginCommand(install, "install", source, ["--yes", "--json"])) {
        ctx.addIssue({ code: "custom", path: ["releaseActions", "install"], message: `managed rollout install must run bb plugin install ${source} --yes --json` });
      }
      if (!update || !isExactBbPluginCommand(update, "update", pluginId, ["--yes"])) {
        ctx.addIssue({ code: "custom", path: ["releaseActions", "update"], message: `managed rollout update must run bb plugin update ${pluginId} --yes` });
      }
      if (!reload || !isExactBbPluginCommand(reload, "reload", pluginId, ["--json"])) {
        ctx.addIssue({ code: "custom", path: ["releaseActions", "reload"], message: `managed rollout reload must run bb plugin reload ${pluginId} --json` });
      }
    }
  });

export type ReleaseGatePolicy = z.infer<typeof releaseGatePolicySchema>;
export type ReleaseGateCommand = z.infer<typeof releaseGateCommandSchema>;
export type PackageManager = "npm" | "bun";

export function parseReleaseGatePolicy(value: unknown): ReleaseGatePolicy {
  return releaseGatePolicySchema.parse(value);
}

function pathParts(value: string): string[] {
  return value.replaceAll("\\", "/").split("/");
}

export function normalizeAbsolutePath(value: string): string {
  const normalized: string[] = [];
  const source = isAbsolutePath(value) ? value : `${process.cwd()}/${value}`;
  for (const part of pathParts(source)) {
    if (!part || part === ".") continue;
    if (part === "..") normalized.pop();
    else normalized.push(part);
  }
  return `/${normalized.join("/")}`;
}

export function isAbsolutePath(value: string): boolean {
  return value.startsWith("/");
}

export function resolveInside(root: string, candidate: string): string {
  if (isAbsolutePath(candidate)) throw new Error(`Policy-owned path must be relative: ${candidate}`);
  const resolvedRoot = normalizeAbsolutePath(root);
  const resolvedCandidate = normalizeAbsolutePath(`${resolvedRoot}/${candidate}`);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}/`)) {
    throw new Error(`Policy-owned path escapes pluginRoot: ${candidate}`);
  }
  return resolvedCandidate;
}

export async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await Bun.file(path).text()) as unknown;
}

export async function detectPackageManager(
  pluginRoot: string,
  packageJson: Record<string, unknown>,
  requested: ReleaseGatePolicy["packageManager"],
): Promise<PackageManager> {
  if (requested === "npm" || requested === "bun") return requested;
  const declared = typeof packageJson.packageManager === "string" ? packageJson.packageManager : "";
  if (declared.startsWith("bun@")) return "bun";
  if (declared.startsWith("npm@")) return "npm";
  const hasBun = (await Bun.file(`${pluginRoot}/bun.lock`).exists()) || (await Bun.file(`${pluginRoot}/bun.lockb`).exists());
  const hasNpm = await Bun.file(`${pluginRoot}/package-lock.json`).exists();
  if (hasBun !== hasNpm) return hasBun ? "bun" : "npm";
  if (hasBun && hasNpm) throw new Error("Both Bun and npm lockfiles exist; set policy.packageManager explicitly");
  throw new Error("Cannot detect npm or Bun; add a lockfile, packageManager field, or policy override");
}

export function resolveSurfaces(policy: ReleaseGatePolicy, packageJson: Record<string, unknown>): ReleaseGateSurface[] {
  const bb = packageJson.bb;
  const manifestBb = typeof bb === "object" && bb !== null ? (bb as Record<string, unknown>) : {};
  const detected: ReleaseGateSurface[] = [];
  if (typeof manifestBb.server === "string" && manifestBb.server.length > 0) detected.push("backend");
  if (typeof manifestBb.app === "string" && manifestBb.app.length > 0) detected.push("frontend");
  return policy.surfaces ? [...policy.surfaces] : detected;
}

export function resolveCommand(command: ReleaseGateCommand, packageManager: PackageManager): ReleaseGateCommand {
  return {
    ...command,
    executable: command.executable === "$packageManager" ? packageManager : command.executable,
    args: command.args.map((arg) => arg.replaceAll("$packageManager", packageManager)),
  };
}

export interface OfficialHarnessSourceInspection {
  surface: ReleaseGateSurface;
  sourcePaths: string[];
  verifiedSourcePaths: string[];
  targetedSourcePaths: string[];
  verified: boolean;
  issues: string[];
}

function importsExactModule(source: string, moduleSpecifier: string): boolean {
  const escaped = moduleSpecifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    new RegExp(`\\bfrom\\s*["']${escaped}["']`),
    new RegExp(`\\bimport\\s*["']${escaped}["']`),
    new RegExp(`\\b(?:import|require)\\s*\\(\\s*["']${escaped}["']\\s*\\)`),
  ].some((pattern) => pattern.test(source));
}

export async function inspectOfficialHarnessSources(
  pluginRoot: string,
  policy: ReleaseGatePolicy,
  surface: ReleaseGateSurface,
): Promise<OfficialHarnessSourceInspection> {
  const sourcePaths = [...(policy.harnessSources[surface] ?? [])];
  const moduleSpecifier = surface === "backend" ? "@bb/plugin-sdk/testing" : "@bb/plugin-sdk/testing/app";
  const verifiedSourcePaths: string[] = [];
  const targetedSourcePaths: string[] = [];
  const issues: string[] = [];
  if (sourcePaths.length === 0) issues.push(`No ${surface} harnessSources are configured`);
  for (const sourcePath of sourcePaths) {
    try {
      const absolutePath = resolveInside(pluginRoot, sourcePath);
      const file = Bun.file(absolutePath);
      if (!(await file.exists())) {
        issues.push(`Harness source does not exist: ${sourcePath}`);
        continue;
      }
      const source = await file.text();
      if (importsExactModule(source, moduleSpecifier)) verifiedSourcePaths.push(sourcePath);
      else issues.push(`Harness source does not import ${moduleSpecifier}: ${sourcePath}`);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }
  const command = policy.harness[surface];
  if (command) {
    const args = new Set(command.args.map(normalizedPolicyPath));
    targetedSourcePaths.push(...verifiedSourcePaths.filter((sourcePath) => args.has(normalizedPolicyPath(sourcePath))));
  }
  if (verifiedSourcePaths.length > 0 && targetedSourcePaths.length === 0) {
    issues.push(`${surface} harness command does not target a verified official SDK test source`);
  }
  return { surface, sourcePaths, verifiedSourcePaths, targetedSourcePaths, verified: targetedSourcePaths.length > 0, issues };
}
