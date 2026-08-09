// smithers-source: authored
// smithers-metadata-version: 1
// smithers-display-name: BB Plugin Release Gate
// smithers-description: Deterministic policy-driven verification and gated release workflow for BB plugins.
// smithers-tags: bb, plugins, release, verification
/** @jsxImportSource smthrs */
import { createSmithers, UI } from "smthrs";
import { z } from "zod/v4";
import {
  detectPackageManager,
  inspectOfficialHarnessSources,
  isAbsolutePath,
  normalizeAbsolutePath,
  parseReleaseGatePolicy,
  readJsonFile,
  releaseGatePolicySchema,
  resolveCommand,
  resolveInside,
  resolveSurfaces,
  type PackageManager,
  type ReleaseGateCommand,
  type ReleaseGatePolicy,
  type ReleaseGateSurface,
} from "../lib/bb-plugin-release-gate/policy";

const inputSchema = z
  .object({
    pluginRoot: z.string().min(1).refine(isAbsolutePath, "pluginRoot must be absolute").default(process.cwd()),
    policyPath: z.string().min(1).default(".bb/release-gate.json"),
    mode: z.enum(["verify", "release"]).default("verify"),
  })
  .strict();

const commandEvidenceSchema = z.object({
  id: z.string(),
  command: z.array(z.string()),
  ok: z.boolean(),
  exitCode: z.number().int(),
  durationMs: z.number().int().nonnegative(),
  outputTail: z.string(),
});

const loadPolicySchema = z.object({
  summary: z.string(),
  pluginName: z.string(),
  policyJson: z.string(),
  manifestJson: z.string(),
  autoSurfaces: z.array(z.enum(["backend", "frontend"])),
  declaredSurfaces: z.array(z.enum(["backend", "frontend"])),
  waiversJson: z.string(),
});

const crossValidateSchema = z.object({
  summary: z.string(),
  ok: z.boolean(),
  issues: z.array(z.string()),
  resolvedSurfaces: z.array(z.enum(["backend", "frontend"])),
  resolvedWaiverIds: z.array(z.string()),
});

const discoverEnvSchema = z.object({
  summary: z.string(),
  packageManager: z.enum(["npm", "bun"]),
  resolvedCommandsJson: z.string(),
});

const staticGatesSchema = z.object({
  summary: z.string(),
  checks: z.array(commandEvidenceSchema),
  allPassed: z.boolean(),
});

const sdkFallbackSchema = z.object({
  summary: z.string(),
  status: z.enum(["not-applicable", "fallback-required", "fallback-missing", "official-available", "indeterminate"]),
  dependencySpec: z.string().nullable(),
  engineRange: z.string().nullable(),
  officialVersion: z.string().nullable(),
  migrationInstructions: z.string().nullable(),
  outputTail: z.string(),
});

const harnessSchema = z.object({
  summary: z.string(),
  surface: z.enum(["backend", "frontend"]),
  sourcePaths: z.array(z.string()),
  verifiedSourcePaths: z.array(z.string()),
  targetedSourcePaths: z.array(z.string()),
  ran: z.boolean(),
  ok: z.boolean(),
  exitCode: z.number().int(),
  outputTail: z.string(),
});

const artifactEvidenceSchema = z.object({
  path: z.string(),
  exists: z.boolean(),
  required: z.boolean(),
  ok: z.boolean(),
  size: z.number().int().nonnegative().nullable(),
  sha256: z.string().nullable(),
  issues: z.array(z.string()),
});

const buildSchema = z.object({
  summary: z.string(),
  ok: z.boolean(),
  exitCode: z.number().int(),
  outputTail: z.string(),
  artifacts: z.array(artifactEvidenceSchema),
});

const inspectArtifactsSchema = z.object({
  summary: z.string(),
  ok: z.boolean(),
  findings: z.array(z.object({ scope: z.string(), severity: z.literal("error"), message: z.string() })),
});

const failureSchema = z.object({ scope: z.string(), message: z.string() });
const waivedItemSchema = failureSchema.extend({ waiverId: z.string(), reason: z.string() });
const verdictSchema = z.object({
  summary: z.string(),
  verdict: z.enum(["pass", "fail", "waived"]),
  blockingFailures: z.array(failureSchema),
  waivedItems: z.array(waivedItemSchema),
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
  reportArtifact: z.string(),
});

const reportSchema = z.object({ summary: z.string(), markdownReport: z.string() });
const liveCheckSchema = z.object({
  summary: z.string(),
  checkId: z.string(),
  mutating: z.boolean(),
  checkOk: z.boolean(),
  rollbackExecuted: z.boolean(),
  rollbackVerified: z.boolean(),
  outputTail: z.string(),
});
const acceptanceVerdictSchema = z.object({
  summary: z.string(),
  ok: z.boolean(),
  failures: z.array(failureSchema),
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
  artifact: z.string(),
});
const approvalSchema = z.object({
  approved: z.boolean(),
  note: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
});
const bindingGuardSchema = z.object({ summary: z.string(), ok: z.boolean(), boundHash: z.string() });
const releaseActionSchema = z.object({
  summary: z.string(),
  action: z.enum(["commit", "push", "publish", "install", "update", "reload"]),
  ok: z.boolean(),
  exitCode: z.number().int(),
  outputTail: z.string(),
});
const releasePlanSchema = z.object({
  summary: z.string(),
  pluginId: z.string(),
  intendedRevision: z.string().regex(/^[a-f0-9]{40}$/),
  rolloutMode: z.enum(["legacy", "absent", "updatable", "current"]),
  actions: z.array(z.enum(["commit", "push", "publish", "install", "update", "reload"])),
});
const rolloutVerificationSchema = z.object({
  summary: z.string(),
  pluginId: z.string(),
  intendedRevision: z.string().regex(/^[a-f0-9]{40}$/),
  installedRevision: z.string().nullable(),
  ok: z.boolean(),
  outputTail: z.string(),
});
const releaseReportSchema = z.object({
  summary: z.string(),
  verdict: z.enum(["pass", "waived"]),
  artifact: z.string(),
});

export const releaseGateSchemas = {
  input: inputSchema,
  loadPolicy: loadPolicySchema,
  crossValidate: crossValidateSchema,
  discoverEnv: discoverEnvSchema,
  sdkFallback: sdkFallbackSchema,
  staticGates: staticGatesSchema,
  harness: harnessSchema,
  build: buildSchema,
  inspectArtifacts: inspectArtifactsSchema,
  verdict: verdictSchema,
  report: reportSchema,
  liveCheck: liveCheckSchema,
  acceptanceVerdict: acceptanceVerdictSchema,
  approval: approvalSchema,
  bindingGuard: bindingGuardSchema,
  releaseAction: releaseActionSchema,
  releasePlan: releasePlanSchema,
  rolloutVerification: rolloutVerificationSchema,
  releaseReport: releaseReportSchema,
} as const;

const { Workflow, Task, Sequence, Parallel, Branch, Approval, smithers, outputs } = createSmithers({
  input: inputSchema,
  loadPolicy: loadPolicySchema,
  crossValidate: crossValidateSchema,
  discoverEnv: discoverEnvSchema,
  sdkFallback: sdkFallbackSchema,
  staticGates: staticGatesSchema,
  harness: harnessSchema,
  build: buildSchema,
  inspectArtifacts: inspectArtifactsSchema,
  verdict: verdictSchema,
  report: reportSchema,
  liveCheck: liveCheckSchema,
  acceptanceVerdict: acceptanceVerdictSchema,
  releaseApproval: approvalSchema,
  releaseGuard: bindingGuardSchema,
  releaseAction: releaseActionSchema,
  releasePlan: releasePlanSchema,
  rolloutVerification: rolloutVerificationSchema,
  rolloutAssertion: bindingGuardSchema,
  releaseReport: releaseReportSchema,
});

type CommandEvidence = z.infer<typeof commandEvidenceSchema>;
type HarnessEvidence = z.infer<typeof harnessSchema>;
type LiveEvidence = z.infer<typeof liveCheckSchema>;
type ReleaseAction = keyof ReleaseGatePolicy["releaseActions"];
type RolloutMode = z.infer<typeof releasePlanSchema>["rolloutMode"];
const RELEASE_ACTIONS: readonly ReleaseAction[] = ["commit", "push", "publish", "install", "update", "reload"];
const REQUIRED_ROLLOUT_ACTIONS: readonly ReleaseAction[] = ["install", "reload"];
const REQUIRED_MANAGED_ROLLOUT_ACTIONS: readonly ReleaseAction[] = ["install", "update", "reload"];

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function tail(value: string, max = 12_000): string {
  return value.length <= max ? value : value.slice(value.length - max);
}

async function runCommand(
  command: ReleaseGateCommand,
  packageManager: PackageManager,
  cwd: string,
  id: string,
): Promise<CommandEvidence> {
  const resolved = resolveCommand(command, packageManager);
  const argv = [resolved.executable, ...resolved.args];
  const started = Date.now();
  try {
    const processHandle = Bun.spawn(argv, { cwd, env: process.env, stdout: "pipe", stderr: "pipe" });
    const timeoutHandle = setTimeout(() => processHandle.kill(), resolved.timeoutMs);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
      processHandle.exited,
    ]);
    clearTimeout(timeoutHandle);
    const combined = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
    return {
      id,
      command: argv,
      ok: exitCode === 0,
      exitCode,
      durationMs: Date.now() - started,
      outputTail: tail(combined),
    };
  } catch (error) {
    return {
      id,
      command: argv,
      ok: false,
      exitCode: -1,
      durationMs: Date.now() - started,
      outputTail: error instanceof Error ? error.message : String(error),
    };
  }
}

function sha256(value: string | ArrayBuffer): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function evidenceHash(value: unknown): string {
  return sha256(JSON.stringify(canonicalize(value)));
}

function isWaiverCurrent(expiresAt: string | undefined): boolean {
  return !expiresAt || Date.parse(expiresAt) > Date.now();
}

function crossValidatePolicy(
  policy: ReleaseGatePolicy,
  autoSurfaces: ReleaseGateSurface[],
  declaredSurfaces: ReleaseGateSurface[],
): z.infer<typeof crossValidateSchema> {
  const issues: string[] = [];
  for (const surface of autoSurfaces) {
    if (!declaredSurfaces.includes(surface)) issues.push(`Policy omits manifest ${surface} surface`);
  }
  for (const surface of declaredSurfaces) {
    if (!autoSurfaces.includes(surface)) issues.push(`Policy declares ${surface}, but package.json exposes no ${surface} entry point`);
    if (!policy.harness[surface]) issues.push(`Policy declares ${surface}, but no official SDK harness command is configured`);
  }
  for (const surface of ["backend", "frontend"] as const) {
    if (policy.harness[surface] && !declaredSurfaces.includes(surface)) {
      issues.push(`${surface} harness is configured for an undeclared surface`);
    }
  }
  return {
    summary: issues.length === 0 ? "Policy and package manifest agree" : `${issues.length} policy/manifest contradictions`,
    ok: issues.length === 0,
    issues,
    resolvedSurfaces: declaredSurfaces,
    resolvedWaiverIds: policy.waivers.map((waiver) => waiver.id),
  };
}

async function artifactEvidence(pluginRoot: string, policy: ReleaseGatePolicy) {
  return Promise.all(
    policy.artifacts.map(async (artifact) => {
      const absolutePath = resolveInside(pluginRoot, artifact.path);
      const file = Bun.file(absolutePath);
      const exists = await file.exists();
      const issues: string[] = [];
      let size: number | null = null;
      let hash: string | null = null;
      if (!exists) {
        if (artifact.required) issues.push("required artifact is missing");
      } else {
        const bytes = await file.arrayBuffer();
        size = bytes.byteLength;
        hash = sha256(bytes);
        if (artifact.minBytes !== undefined && size < artifact.minBytes) issues.push(`size ${size} is below ${artifact.minBytes}`);
        if (artifact.maxBytes !== undefined && size > artifact.maxBytes) issues.push(`size ${size} exceeds ${artifact.maxBytes}`);
        if (artifact.sha256 && hash !== artifact.sha256) issues.push(`sha256 ${hash} does not match ${artifact.sha256}`);
      }
      return { path: artifact.path, exists, required: artifact.required, ok: issues.length === 0, size, sha256: hash, issues };
    }),
  );
}

function verifyEvidenceSnapshot(args: {
  crossValidate: z.infer<typeof crossValidateSchema>;
  sdkFallback: z.infer<typeof sdkFallbackSchema>;
  staticGates: z.infer<typeof staticGatesSchema>;
  harness: Partial<Record<ReleaseGateSurface, HarnessEvidence>>;
  build: z.infer<typeof buildSchema>;
  inspectArtifacts: z.infer<typeof inspectArtifactsSchema>;
}) {
  return args;
}

function collectVerifyFailures(
  surfaces: ReleaseGateSurface[],
  sdkFallback: z.infer<typeof sdkFallbackSchema>,
  staticGates: z.infer<typeof staticGatesSchema>,
  harness: Partial<Record<ReleaseGateSurface, HarnessEvidence>>,
  build: z.infer<typeof buildSchema>,
  inspection: z.infer<typeof inspectArtifactsSchema>,
) {
  const failures: Array<z.infer<typeof failureSchema>> = [];
  if (sdkFallback.status === "official-available" || sdkFallback.status === "fallback-missing") {
    failures.push({ scope: "sdk-fallback", message: sdkFallback.migrationInstructions ?? sdkFallback.summary });
  }
  for (const check of staticGates.checks) {
    if (!check.ok) failures.push({ scope: `static:${check.id}`, message: `command failed with exit ${check.exitCode}` });
  }
  for (const surface of surfaces) {
    const result = harness[surface];
    if (!result?.ok) failures.push({ scope: `harness:${surface}`, message: result?.summary ?? "harness did not run" });
  }
  if (!build.ok) failures.push({ scope: "build", message: `build command failed with exit ${build.exitCode}` });
  for (const finding of inspection.findings) failures.push({ scope: finding.scope, message: finding.message });
  return failures;
}

function renderReport(
  pluginName: string,
  verdict: z.infer<typeof verdictSchema>,
  sdkFallback: z.infer<typeof sdkFallbackSchema>,
  staticGates: z.infer<typeof staticGatesSchema>,
  harness: Partial<Record<ReleaseGateSurface, HarnessEvidence>>,
  build: z.infer<typeof buildSchema>,
): string {
  const lines = [
    `# ${pluginName} release-gate report`,
    "",
    `Verdict: **${verdict.verdict.toUpperCase()}**`,
    `Evidence SHA-256: \`${verdict.evidenceHash}\``,
    "",
    `- Static checks: ${staticGates.checks.filter((check) => check.ok).length}/${staticGates.checks.length} passed`,
    `- SDK fallback: ${sdkFallback.summary}`,
    `- Backend harness: ${harness.backend ? (harness.backend.ok ? "passed" : "failed") : "not applicable"}`,
    `- Frontend harness: ${harness.frontend ? (harness.frontend.ok ? "passed" : "failed") : "not applicable"}`,
    `- Build: ${build.ok ? "passed" : "failed"}`,
  ];
  if (verdict.blockingFailures.length > 0) {
    lines.push("", "## Blocking failures", ...verdict.blockingFailures.map((failure) => `- ${failure.scope}: ${failure.message}`));
  }
  if (verdict.waivedItems.length > 0) {
    lines.push("", "## Waivers", ...verdict.waivedItems.map((item) => `- ${item.scope}: ${item.reason} (${item.waiverId})`));
  }
  return lines.join("\n");
}

export async function inspectSdkFallback(
  pluginRoot: string,
  manifest: Record<string, unknown>,
  registryExecutable = "npm",
): Promise<z.infer<typeof sdkFallbackSchema>> {
  const devDependencies =
    manifest.devDependencies && typeof manifest.devDependencies === "object" && !Array.isArray(manifest.devDependencies)
      ? (manifest.devDependencies as Record<string, unknown>)
      : {};
  const dependencySpec = typeof devDependencies["@bb/plugin-sdk"] === "string" ? devDependencies["@bb/plugin-sdk"] : null;
  if (!dependencySpec?.startsWith("file:")) {
    return {
      summary: "no vendored SDK fallback",
      status: "not-applicable",
      dependencySpec,
      engineRange: null,
      officialVersion: null,
      migrationInstructions: null,
      outputTail: "",
    };
  }

  const engines = manifest.engines && typeof manifest.engines === "object" && !Array.isArray(manifest.engines)
    ? (manifest.engines as Record<string, unknown>)
    : {};
  const engineRange = typeof engines.bbPluginSdk === "string" ? engines.bbPluginSdk : null;
  const tarballPath = dependencySpec.slice("file:".length);
  const migration = engineRange
    ? `Official @bb/plugin-sdk is compatible with engines.bbPluginSdk ${engineRange}. Replace ${dependencySpec} with ${engineRange}, regenerate the lockfile, run tests against the registry package, then delete the vendored tarball and any @bb/plugin-sdk type-path shims.`
    : "A vendored @bb/plugin-sdk fallback requires engines.bbPluginSdk so compatibility with an official release can be checked.";
  if (!engineRange || !(await Bun.file(resolveInside(pluginRoot, tarballPath)).exists())) {
    return {
      summary: !engineRange ? "vendored SDK fallback has no compatibility range" : `vendored SDK tarball is missing: ${tarballPath}`,
      status: "fallback-missing",
      dependencySpec,
      engineRange,
      officialVersion: null,
      migrationInstructions: migration,
      outputTail: "",
    };
  }

  const check = await runCommand(
    { executable: registryExecutable, args: ["view", `@bb/plugin-sdk@${engineRange}`, "version", "--json"], timeoutMs: 30_000 },
    "npm",
    pluginRoot,
    "sdk-fallback-expiry",
  );
  if (check.ok) {
    let officialVersion: string | null = null;
    try {
      const parsed = JSON.parse(check.outputTail) as unknown;
      officialVersion = typeof parsed === "string" ? parsed : Array.isArray(parsed) && typeof parsed.at(-1) === "string" ? parsed.at(-1)! : null;
    } catch {
      officialVersion = check.outputTail.trim() || null;
    }
    return {
      summary: `compatible official SDK ${officialVersion ?? "published"} is available; remove the vendored fallback`,
      status: "official-available",
      dependencySpec,
      engineRange,
      officialVersion,
      migrationInstructions: migration,
      outputTail: check.outputTail,
    };
  }
  if (/\bE404\b|\b404\b|not found/iu.test(check.outputTail)) {
    return {
      summary: `official SDK is not published for ${engineRange}; vendored fallback remains required`,
      status: "fallback-required",
      dependencySpec,
      engineRange,
      officialVersion: null,
      migrationInstructions: null,
      outputTail: check.outputTail,
    };
  }
  return {
    summary: "official SDK publication check was indeterminate",
    status: "indeterminate",
    dependencySpec,
    engineRange,
    officialVersion: null,
    migrationInstructions: null,
    outputTail: check.outputTail,
  };
}

export function parseInstalledRevision(output: string): string | null {
  try {
    const start = output.indexOf("{");
    const end = output.lastIndexOf("}");
    const parsed = JSON.parse(output.slice(start, end + 1)) as { history?: Array<{ version?: unknown }> };
    const version = parsed.history?.[0]?.version;
    return typeof version === "string" && /^[a-f0-9]{40}$/u.test(version) ? version : null;
  } catch {
    return null;
  }
}

export function classifyManagedRollout(
  evidence: Pick<CommandEvidence, "ok" | "outputTail">,
  intendedSource: string,
  intendedRevision: string,
): { mode: Exclude<RolloutMode, "legacy">; installedRevision: string | null } {
  if (!evidence.ok) {
    if (/HTTP 404:\s*unknown plugin\b/iu.test(evidence.outputTail)) return { mode: "absent", installedRevision: null };
    throw new Error(`Cannot inspect installed plugin: ${evidence.outputTail}`);
  }
  try {
    const start = evidence.outputTail.indexOf("{");
    const end = evidence.outputTail.lastIndexOf("}");
    const parsed = JSON.parse(evidence.outputTail.slice(start, end + 1)) as {
      requested?: unknown;
      history?: Array<{ version?: unknown }>;
    };
    if (parsed.requested !== intendedSource) {
      throw new Error(`installed source ${String(parsed.requested ?? "unknown")} does not match ${intendedSource}`);
    }
    const installedRevision = parsed.history?.[0]?.version;
    if (typeof installedRevision !== "string" || !/^[a-f0-9]{40}$/u.test(installedRevision)) {
      throw new Error("installed source has no active 40-character revision");
    }
    return { mode: installedRevision === intendedRevision ? "current" : "updatable", installedRevision };
  } catch (error) {
    throw new Error(`Cannot classify installed plugin: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireBinding<T>(value: T | undefined): T {
  return value as T;
}

export default smithers((ctx) => {
  const pluginRoot = normalizeAbsolutePath(ctx.input?.pluginRoot ?? process.cwd());
  const policyPathInput = ctx.input?.policyPath ?? ".bb/release-gate.json";
  const mode = ctx.input?.mode ?? "verify";
  const loadPolicy = ctx.outputMaybe(outputs.loadPolicy, { nodeId: "load-policy" });
  const crossValidate = ctx.outputMaybe(outputs.crossValidate, { nodeId: "cross-validate" });
  const discoverEnv = ctx.outputMaybe(outputs.discoverEnv, { nodeId: "discover-env" });
  const sdkFallback = ctx.outputMaybe(outputs.sdkFallback, { nodeId: "sdk-fallback" });
  const staticGates = ctx.outputMaybe(outputs.staticGates, { nodeId: "static-gates" });
  const backendHarness = ctx.outputMaybe(outputs.harness, { nodeId: "harness-backend" });
  const frontendHarness = ctx.outputMaybe(outputs.harness, { nodeId: "harness-frontend" });
  const build = ctx.outputMaybe(outputs.build, { nodeId: "build" });
  const inspection = ctx.outputMaybe(outputs.inspectArtifacts, { nodeId: "inspect-artifacts" });
  const verdict = ctx.outputMaybe(outputs.verdict, { nodeId: "verdict" });
  const report = ctx.outputMaybe(outputs.report, { nodeId: "report" });
  const gateAssertion = ctx.outputMaybe(outputs.releaseGuard, { nodeId: "gate-assertion" });
  const acceptance = ctx.outputMaybe(outputs.acceptanceVerdict, { nodeId: "acceptance-verdict" });
  const acceptanceAssertion = ctx.outputMaybe(outputs.releaseGuard, { nodeId: "acceptance-assertion" });
  const releaseApproval = ctx.outputMaybe(outputs.releaseApproval, { nodeId: "release-approval" });
  const releaseGuard = ctx.outputMaybe(outputs.releaseGuard, { nodeId: "release-guard" });
  const releasePlan = ctx.outputMaybe(outputs.releasePlan, { nodeId: "release-plan" });
  const rolloutVerification = ctx.outputMaybe(outputs.rolloutVerification, { nodeId: "rollout-verification" });

  const policy = loadPolicy ? parseReleaseGatePolicy(parseJson(loadPolicy.policyJson)) : undefined;
  const packageManager = discoverEnv?.packageManager;
  const surfaces = crossValidate?.resolvedSurfaces ?? [];
  const harnessBySurface: Partial<Record<ReleaseGateSurface, HarnessEvidence>> = {
    ...(backendHarness ? { backend: backendHarness } : {}),
    ...(frontendHarness ? { frontend: frontendHarness } : {}),
  };
  const verifyReady = Boolean(
    crossValidate && sdkFallback && staticGates && build && inspection && surfaces.every((surface) => harnessBySurface[surface] !== undefined),
  );

  const liveResults = new Map<string, LiveEvidence>();
  for (const check of policy?.liveChecks ?? []) {
    const row = ctx.outputMaybe(outputs.liveCheck, { nodeId: `live-${check.id}` });
    if (row) liveResults.set(check.id, row);
  }
  const liveReady = policy !== undefined && policy.liveChecks.every((check) => liveResults.has(check.id));

  const configuredActions = policy ? RELEASE_ACTIONS.filter((action) => policy.releaseActions[action] !== undefined) : [];
  const selectedActions = releasePlan?.actions ?? [];
  const releaseResults = new Map<ReleaseAction, z.infer<typeof releaseActionSchema>>();
  for (const action of RELEASE_ACTIONS) {
    const row = ctx.outputMaybe(outputs.releaseAction, { nodeId: `release-${action}` });
    if (row) releaseResults.set(action, row);
  }
  const releaseActionsReady = selectedActions.every((action) => releaseResults.has(action));
  const releaseAuthorized = policy?.requireReleaseApproval === false || releaseApproval?.approved === true;

  const renderHarnessBranch = (surface: ReleaseGateSurface) => {
    const gatePolicy = policy as ReleaseGatePolicy;
    const manager = packageManager as PackageManager;
    return (
      <Branch
        if={surfaces.includes(surface)}
        then={
          <Task id={`harness-${surface}`} output={outputs.harness} dependsOn={["static-gates"]} retries={0}>
            {async () => {
              const command = gatePolicy.harness[surface];
              const sourceInspection = await inspectOfficialHarnessSources(pluginRoot, gatePolicy, surface);
              if (!command || !sourceInspection.verified) {
                return {
                  summary: !command
                    ? `No ${surface} official SDK harness command is configured`
                    : `${surface} harness source does not prove official SDK usage`,
                  surface,
                  sourcePaths: sourceInspection.sourcePaths,
                  verifiedSourcePaths: sourceInspection.verifiedSourcePaths,
                  targetedSourcePaths: sourceInspection.targetedSourcePaths,
                  ran: false,
                  ok: false,
                  exitCode: -1,
                  outputTail: sourceInspection.issues.join("\n"),
                };
              }
              const evidence = await runCommand(command, manager, pluginRoot, `harness-${surface}`);
              return {
                ...evidence,
                surface,
                sourcePaths: sourceInspection.sourcePaths,
                verifiedSourcePaths: sourceInspection.verifiedSourcePaths,
                targetedSourcePaths: sourceInspection.targetedSourcePaths,
                ran: true,
                summary: evidence.ok ? `${surface} harness passed` : `${surface} harness failed`,
              };
            }}
          </Task>
        }
        else={null}
      />
    );
  };

  return (
    <Workflow name="bb-plugin-release-gate">
      <UI entry="../ui/bb-plugin-release-gate.tsx" title="BB Plugin Release Gate" />
      <Sequence>
        <Task id="load-policy" output={outputs.loadPolicy} retries={0}>
          {async () => {
            const policyPath = resolveInside(pluginRoot, policyPathInput);
            const manifestPath = resolveInside(pluginRoot, "package.json");
            if (!(await Bun.file(manifestPath).exists())) throw new Error(`pluginRoot is not a BB plugin: ${pluginRoot}`);
            const parsedPolicy = parseReleaseGatePolicy(await readJsonFile(policyPath));
            const manifest = await readJsonFile(manifestPath);
            if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("package.json must contain an object");
            const packageJson = manifest as Record<string, unknown>;
            const autoSurfaces = resolveSurfaces({ ...parsedPolicy, surfaces: undefined }, packageJson);
            const declaredSurfaces = resolveSurfaces(parsedPolicy, packageJson);
            return {
              summary: `Loaded release policy for ${String(packageJson.name ?? pluginRoot)}`,
              pluginName: String(packageJson.name ?? pluginRoot),
              policyJson: JSON.stringify(parsedPolicy),
              manifestJson: JSON.stringify(packageJson),
              autoSurfaces,
              declaredSurfaces,
              waiversJson: JSON.stringify(parsedPolicy.waivers),
            };
          }}
        </Task>

        {loadPolicy && policy ? (
          <Task id="cross-validate" output={outputs.crossValidate} dependsOn={["load-policy"]} retries={0}>
            {() => crossValidatePolicy(policy, loadPolicy.autoSurfaces, loadPolicy.declaredSurfaces)}
          </Task>
        ) : null}

        {crossValidate && loadPolicy ? (
          <Task id="sdk-fallback" output={outputs.sdkFallback} dependsOn={["cross-validate"]} retries={0}>
            {() => inspectSdkFallback(pluginRoot, parseJson<Record<string, unknown>>(loadPolicy.manifestJson))}
          </Task>
        ) : null}

        {crossValidate && sdkFallback && policy ? (
          <Task id="discover-env" output={outputs.discoverEnv} dependsOn={["sdk-fallback"]} retries={0}>
            {async () => {
              if (!crossValidate.ok) throw new Error(`Policy/manifest contradiction: ${crossValidate.issues.join("; ")}`);
              const manifest = parseJson<Record<string, unknown>>(loadPolicy?.manifestJson ?? "{}");
              const detected = await detectPackageManager(pluginRoot, manifest, policy.packageManager);
              const resolved = {
                staticChecks: policy.staticChecks.map((command) => resolveCommand(command, detected)),
                harness: Object.fromEntries(Object.entries(policy.harness).map(([key, value]) => [key, resolveCommand(value, detected)])),
                build: resolveCommand(policy.build, detected),
                liveChecks: policy.liveChecks.map((check) => ({
                  ...check,
                  command: resolveCommand(check.command, detected),
                  rollback: check.rollback ? resolveCommand(check.rollback, detected) : undefined,
                  verifyRollback: check.verifyRollback ? resolveCommand(check.verifyRollback, detected) : undefined,
                })),
                releaseActions: Object.fromEntries(
                  Object.entries(policy.releaseActions).map(([key, value]) => [key, resolveCommand(value, detected)]),
                ),
              };
              return { summary: `Detected ${detected} and resolved policy commands`, packageManager: detected, resolvedCommandsJson: JSON.stringify(resolved) };
            }}
          </Task>
        ) : null}

        {discoverEnv && policy && packageManager ? (
          <Task id="static-gates" output={outputs.staticGates} dependsOn={["discover-env"]} retries={0}>
            {async () => {
              const checks = await Promise.all(
                policy.staticChecks.map((check) => runCommand(check, packageManager, pluginRoot, check.id)),
              );
              return { summary: `${checks.filter((check) => check.ok).length}/${checks.length} static checks passed`, checks, allPassed: checks.every((check) => check.ok) };
            }}
          </Task>
        ) : null}

        {discoverEnv && policy && packageManager ? (
          <Parallel maxConcurrency={2}>
            {renderHarnessBranch("backend")}
            {renderHarnessBranch("frontend")}
          </Parallel>
        ) : null}

        {discoverEnv && policy && packageManager ? (
          <Task
            id="build"
            output={outputs.build}
            dependsOn={surfaces.length > 0 ? surfaces.map((surface) => `harness-${surface}`) : ["static-gates"]}
            retries={0}
          >
            {async () => {
              const result = await runCommand(policy.build, packageManager, pluginRoot, "build");
              const artifacts = await artifactEvidence(pluginRoot, policy);
              return {
                summary: `Build ${result.ok ? "passed" : "failed"}; ${artifacts.filter((item) => item.ok).length}/${artifacts.length} artifacts conform`,
                ok: result.ok,
                exitCode: result.exitCode,
                outputTail: result.outputTail,
                artifacts,
              };
            }}
          </Task>
        ) : null}

        {build ? (
          <Task id="inspect-artifacts" output={outputs.inspectArtifacts} dependsOn={["build"]} retries={0}>
            {() => {
              const findings = build.artifacts.flatMap((artifact) =>
                artifact.issues.map((message) => ({ scope: `artifact:${artifact.path}`, severity: "error" as const, message })),
              );
              return { summary: findings.length === 0 ? "All configured artifacts conform" : `${findings.length} artifact failures`, ok: findings.length === 0, findings };
            }}
          </Task>
        ) : null}

        {verifyReady && policy && crossValidate && sdkFallback && staticGates && build && inspection ? (
          <Task id="verdict" output={outputs.verdict} dependsOn={["inspect-artifacts"]} retries={0}>
            {() => {
              const snapshot = verifyEvidenceSnapshot({ crossValidate, sdkFallback, staticGates, harness: harnessBySurface, build, inspectArtifacts: inspection });
              const failures = collectVerifyFailures(surfaces, sdkFallback, staticGates, harnessBySurface, build, inspection);
              const waivers = policy.waivers.filter((waiver) => isWaiverCurrent(waiver.expiresAt));
              const blockingFailures: typeof failures = [];
              const waivedItems: Array<z.infer<typeof waivedItemSchema>> = [];
              for (const failure of failures) {
                const waiver = waivers.find((candidate) => candidate.scope === failure.scope);
                if (waiver) waivedItems.push({ ...failure, waiverId: waiver.id, reason: waiver.reason });
                else blockingFailures.push(failure);
              }
              const finalVerdict = blockingFailures.length > 0 ? "fail" : waivedItems.length > 0 ? "waived" : "pass";
              return {
                summary: `${finalVerdict.toUpperCase()}: ${blockingFailures.length} blocking, ${waivedItems.length} waived`,
                verdict: finalVerdict,
                blockingFailures,
                waivedItems,
                evidenceHash: evidenceHash(snapshot),
                reportArtifact: `smithers://outputs/${ctx.runId}/verdict`,
              };
            }}
          </Task>
        ) : null}

        {verdict && sdkFallback && staticGates && build ? (
          <Task id="report" output={outputs.report} dependsOn={["verdict"]} retries={0}>
            {() => ({
              summary: `${verdict.verdict.toUpperCase()} release-gate report`,
              markdownReport: renderReport(loadPolicy?.pluginName ?? "BB plugin", verdict, sdkFallback, staticGates, harnessBySurface, build),
            })}
          </Task>
        ) : null}

        {report && verdict ? (
          <Task id="gate-assertion" output={outputs.releaseGuard} dependsOn={["report"]} retries={0}>
            {() => {
              if (verdict.verdict === "fail") {
                throw new Error(`Release gate failed: ${verdict.blockingFailures.map((failure) => `${failure.scope}: ${failure.message}`).join("; ")}`);
              }
              return { summary: "Release-gate verdict permits continuation", ok: true, boundHash: verdict.evidenceHash };
            }}
          </Task>
        ) : null}

        <Branch
          if={mode === "release" && gateAssertion !== undefined && verdict?.verdict !== "fail"}
          then={
            <Sequence>
              {policy ? (
                <Task id="release-plan" output={outputs.releasePlan} dependsOn={["gate-assertion"]} retries={0}>
                  {async () => {
                    if (!policy.rollout) throw new Error("Release mode requires rollout.pluginId");
                    const requiredActions = policy.rollout.source ? REQUIRED_MANAGED_ROLLOUT_ACTIONS : REQUIRED_ROLLOUT_ACTIONS;
                    const missing = requiredActions.filter((action) => policy.releaseActions[action] === undefined);
                    if (missing.length > 0) throw new Error(`Release mode requires configured rollout actions: ${missing.join(", ")}`);
                    const revision = await runCommand(
                      { executable: "git", args: ["rev-parse", "HEAD"], timeoutMs: 30_000 },
                      packageManager ?? "npm",
                      pluginRoot,
                      "release-revision",
                    );
                    const intendedRevision = revision.outputTail.trim();
                    if (!revision.ok || !/^[a-f0-9]{40}$/u.test(intendedRevision)) throw new Error(`Cannot resolve intended release revision: ${revision.outputTail}`);
                    let rolloutMode: RolloutMode = "legacy";
                    let actions = configuredActions;
                    if (policy.rollout.source) {
                      const sourceEvidence = await runCommand(
                        { executable: "bb", args: ["plugin", "source", policy.rollout.pluginId, "--json"], timeoutMs: 60_000 },
                        packageManager ?? "npm",
                        pluginRoot,
                        "release-source",
                      );
                      const classified = classifyManagedRollout(sourceEvidence, policy.rollout.source, intendedRevision);
                      rolloutMode = classified.mode;
                      const preparation = configuredActions.filter((action) => !["install", "update", "reload"].includes(action));
                      const mutation = rolloutMode === "absent" ? ["install" as const] : rolloutMode === "updatable" ? ["update" as const] : [];
                      actions = [...preparation, ...mutation, "reload"];
                    }
                    return {
                      summary: `Roll out ${policy.rollout.pluginId} at ${intendedRevision} (${rolloutMode})`,
                      pluginId: policy.rollout.pluginId,
                      intendedRevision,
                      rolloutMode,
                      actions,
                    };
                  }}
                </Task>
              ) : null}

              {policy && packageManager ? (
                <Parallel maxConcurrency={1}>
                  {policy.liveChecks.map((check) => (
                    <Task key={check.id} id={`live-${check.id}`} output={outputs.liveCheck} dependsOn={["release-plan"]} retries={0}>
                      {async () => {
                        const checkEvidence = await runCommand(check.command, packageManager, pluginRoot, `live-${check.id}`);
                        let rollbackExecuted = false;
                        let rollbackVerified = !check.mutating;
                        const rollbackOutput: string[] = [];
                        if (check.mutating && check.rollback) {
                          rollbackExecuted = true;
                          const rollback = await runCommand(check.rollback, packageManager, pluginRoot, `rollback-${check.id}`);
                          rollbackOutput.push(rollback.outputTail);
                          rollbackVerified = rollback.ok;
                          if (rollback.ok && check.verifyRollback) {
                            const verified = await runCommand(check.verifyRollback, packageManager, pluginRoot, `verify-rollback-${check.id}`);
                            rollbackOutput.push(verified.outputTail);
                            rollbackVerified = verified.ok;
                          }
                        }
                        return {
                          summary: `${check.id}: check ${checkEvidence.ok ? "passed" : "failed"}; rollback ${rollbackVerified ? "verified" : "failed"}`,
                          checkId: check.id,
                          mutating: check.mutating,
                          checkOk: checkEvidence.ok,
                          rollbackExecuted,
                          rollbackVerified,
                          outputTail: tail([checkEvidence.outputTail, ...rollbackOutput].filter(Boolean).join("\n")),
                        };
                      }}
                    </Task>
                  ))}
                </Parallel>
              ) : null}

              {policy && liveReady ? (
                <Task
                  id="acceptance-verdict"
                  output={outputs.acceptanceVerdict}
                  dependsOn={policy.liveChecks.length > 0 ? policy.liveChecks.map((check) => `live-${check.id}`) : ["release-plan"]}
                  retries={0}
                >
                  {() => {
                    const results = [...liveResults.values()];
                    const failures = results.flatMap((result) => {
                      const issues: Array<z.infer<typeof failureSchema>> = [];
                      if (!result.checkOk) issues.push({ scope: `live:${result.checkId}`, message: "live check failed" });
                      if (result.mutating && (!result.rollbackExecuted || !result.rollbackVerified)) {
                        issues.push({ scope: `rollback:${result.checkId}`, message: "rollback was not executed and verified" });
                      }
                      return issues;
                    });
                    return {
                      summary: failures.length === 0 ? "Live acceptance and all rollbacks passed" : `${failures.length} live acceptance failures`,
                      ok: failures.length === 0,
                      failures,
                      evidenceHash: evidenceHash(results),
                      artifact: `smithers://outputs/${ctx.runId}/acceptance-verdict`,
                    };
                  }}
                </Task>
              ) : null}

              {acceptance ? (
                <Task id="acceptance-assertion" output={outputs.releaseGuard} dependsOn={["acceptance-verdict"]} retries={0}>
                  {() => {
                    if (!acceptance.ok) {
                      throw new Error(`Live acceptance failed: ${acceptance.failures.map((failure) => `${failure.scope}: ${failure.message}`).join("; ")}`);
                    }
                    return { summary: "Live acceptance permits release", ok: true, boundHash: acceptance.evidenceHash };
                  }}
                </Task>
              ) : null}

              {acceptance && acceptanceAssertion?.ok && policy?.requireReleaseApproval ? (
                <Approval
                  id="release-approval"
                  output={outputs.releaseApproval}
                  dependsOn={["acceptance-assertion"]}
                  bind={requireBinding(ctx.prove(outputs.acceptanceVerdict, { nodeId: "acceptance-verdict" }))}
                  request={{
                    title: "Execute configured BB plugin release actions?",
                    summary: `${report?.markdownReport ?? ""}\n\nAcceptance SHA-256: ${acceptance.evidenceHash}\nActions: ${selectedActions.join(", ") || "none"}`,
                    metadata: { evidenceHash: acceptance.evidenceHash, actions: selectedActions },
                  }}
                  onDeny="fail"
                />
              ) : null}

              {acceptance && acceptanceAssertion?.ok && releaseAuthorized ? (
                <Sequence>
                  <Task
                    id="release-guard"
                    output={outputs.releaseGuard}
                    dependsOn={[policy?.requireReleaseApproval ? "release-approval" : "acceptance-assertion"]}
                    bind={[
                      requireBinding(ctx.prove(outputs.acceptanceVerdict, { nodeId: "acceptance-verdict" })),
                      ...(policy?.requireReleaseApproval
                        ? [requireBinding(ctx.prove(outputs.releaseApproval, { nodeId: "release-approval" }))]
                        : []),
                    ]}
                    retries={0}
                  >
                    {() => {
                      const actual = evidenceHash([...liveResults.values()]);
                      if (actual !== acceptance.evidenceHash) throw new Error("Acceptance evidence changed before release actions");
                      return { summary: "Release authorization is bound to current acceptance evidence", ok: true, boundHash: actual };
                    }}
                  </Task>

                  {releaseGuard
                    ? selectedActions.map((action, index) => {
                        const command = policy?.releaseActions[action];
                        const previous = selectedActions[index - 1];
                        return command && packageManager ? (
                          <Task
                            key={action}
                            id={`release-${action}`}
                            output={outputs.releaseAction}
                            dependsOn={[previous ? `release-${previous}` : "release-guard"]}
                            retries={0}
                          >
                            {async () => {
                              const result = await runCommand(command, packageManager, pluginRoot, `release-${action}`);
                              if (!result.ok) throw new Error(`${action} failed: ${result.outputTail}`);
                              return { summary: `${action} completed`, action, ok: true, exitCode: result.exitCode, outputTail: result.outputTail };
                            }}
                          </Task>
                        ) : null;
                      })
                    : null}

                  {releaseGuard && releaseActionsReady ? (
                    <Task
                      id="rollout-verification"
                      output={outputs.rolloutVerification}
                      dependsOn={[selectedActions.length > 0 ? `release-${selectedActions.at(-1)}` : "release-guard"]}
                      retries={0}
                    >
                      {async () => {
                        if (!releasePlan) throw new Error("Release plan evidence is missing");
                        const source = await runCommand(
                          { executable: "bb", args: ["plugin", "source", releasePlan.pluginId, "--json"], timeoutMs: 60_000 },
                          packageManager ?? "npm",
                          pluginRoot,
                          "rollout-verification",
                        );
                        const installedRevision = source.ok ? parseInstalledRevision(source.outputTail) : null;
                        const ok = source.ok && installedRevision === releasePlan.intendedRevision;
                        return {
                          summary: ok
                            ? `Installed ${releasePlan.pluginId} revision matches ${releasePlan.intendedRevision}`
                            : `Installed ${releasePlan.pluginId} revision ${installedRevision ?? "unknown"} does not match ${releasePlan.intendedRevision}`,
                          pluginId: releasePlan.pluginId,
                          intendedRevision: releasePlan.intendedRevision,
                          installedRevision,
                          ok,
                          outputTail: source.outputTail,
                        };
                      }}
                    </Task>
                  ) : null}

                  {rolloutVerification ? (
                    <Task id="rollout-assertion" output={outputs.rolloutAssertion} dependsOn={["rollout-verification"]} retries={0}>
                      {() => {
                        if (!rolloutVerification.ok) throw new Error(rolloutVerification.summary);
                        return { summary: rolloutVerification.summary, ok: true, boundHash: rolloutVerification.intendedRevision };
                      }}
                    </Task>
                  ) : null}

                  {rolloutVerification?.ok ? (
                    <Task id="release-report" output={outputs.releaseReport} dependsOn={["rollout-assertion"]} retries={0}>
                      {() => ({
                        summary: `Release completed via ${releasePlan?.rolloutMode ?? "legacy"} with ${selectedActions.length} actions; ${rolloutVerification.summary}`,
                        verdict: verdict?.verdict === "waived" ? "waived" : "pass",
                        artifact: `smithers://outputs/${ctx.runId}/release-report`,
                      })}
                    </Task>
                  ) : null}
                </Sequence>
              ) : null}
            </Sequence>
          }
          else={null}
        />
      </Sequence>
    </Workflow>
  );
});

export { releaseGatePolicySchema };
