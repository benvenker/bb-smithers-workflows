import { describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { addPack } from "@smthrs/cli/packs";
import { discoverWorkflows, resolveWorkflow } from "@smthrs/cli/workflows";
import type { TaskDescriptor } from "smthrs";
import { renderWorkflow } from "smthrs/testing";
import workflow, {
  inspectSdkFallback,
  parseInstalledRevision,
  releaseGatePolicySchema,
  releaseGateSchemas,
} from "../pack/workflows/bb-plugin-release-gate";
import {
  inspectOfficialHarnessSources,
  parseReleaseGatePolicy,
  resolveSurfaces,
} from "../pack/lib/bb-plugin-release-gate/policy";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = resolve(here, "fixtures");
const packRoot = resolve(here, "../pack");

type OutputSnapshot = Record<string, unknown[]>;

function row(nodeId: string, payload: Record<string, unknown>) {
  return { nodeId, iteration: 0, ...payload };
}

function fixture(name: string) {
  const root = resolve(fixturesRoot, name);
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as Record<string, unknown>;
  const policy = parseReleaseGatePolicy(
    JSON.parse(readFileSync(resolve(root, ".bb/release-gate.json"), "utf8")) as unknown,
  );
  const autoSurfaces = resolveSurfaces({ ...policy, surfaces: undefined }, manifest);
  const declaredSurfaces = resolveSurfaces(policy, manifest);
  const load = {
    summary: `Loaded ${String(manifest.name)}`,
    pluginName: String(manifest.name),
    policyJson: JSON.stringify(policy),
    manifestJson: JSON.stringify(manifest),
    autoSurfaces,
    declaredSurfaces,
    waiversJson: JSON.stringify(policy.waivers),
  };
  return { root, manifest, policy, declaredSurfaces, load };
}

function stageOutputs(name: string): OutputSnapshot {
  const data = fixture(name);
  const harnessRows = data.declaredSurfaces.map((surface) =>
    row(`harness-${surface}`, {
      summary: `${surface} harness passed`,
      surface,
      sourcePaths: [`${surface}.test.ts`],
      verifiedSourcePaths: [`${surface}.test.ts`],
      ran: true,
      ok: true,
      exitCode: 0,
      outputTail: "ok",
    }),
  );
  return {
    loadPolicy: [row("load-policy", data.load)],
    crossValidate: [
      row("cross-validate", {
        summary: "policy and manifest agree",
        ok: true,
        issues: [],
        resolvedSurfaces: data.declaredSurfaces,
        resolvedWaiverIds: data.policy.waivers.map((waiver) => waiver.id),
      }),
    ],
    sdkFallback: [
      row("sdk-fallback", {
        summary: "no vendored SDK fallback",
        status: "not-applicable",
        dependencySpec: null,
        engineRange: null,
        officialVersion: null,
        migrationInstructions: null,
        outputTail: "",
      }),
    ],
    discoverEnv: [
      row("discover-env", {
        summary: "commands resolved",
        packageManager: name.startsWith("bun-") ? "bun" : "npm",
        resolvedCommandsJson: "{}",
      }),
    ],
    staticGates: [row("static-gates", { summary: "passed", checks: [], allPassed: true })],
    harness: harnessRows,
    build: [row("build", { summary: "build passed", ok: true, exitCode: 0, outputTail: "ok", artifacts: [] })],
    inspectArtifacts: [row("inspect-artifacts", { summary: "artifacts pass", ok: true, findings: [] })],
    verdict: [
      row("verdict", {
        summary: "PASS",
        verdict: "pass",
        blockingFailures: [],
        waivedItems: [],
        evidenceHash: "a".repeat(64),
        reportArtifact: "smithers://outputs/test/verdict",
      }),
    ],
    report: [row("report", { summary: "verify report", markdownReport: `# PASS\n\nEvidence hash: ${"a".repeat(64)}` })],
    releaseGuard: [row("gate-assertion", { summary: "permitted", ok: true, boundHash: "a".repeat(64) })],
  };
}

function releaseOutputs(name: string, requireApproval = true): OutputSnapshot {
  const snapshot = stageOutputs(name);
  const loadRow = snapshot.loadPolicy[0] as Record<string, unknown>;
  const policy = JSON.parse(String(loadRow.policyJson)) as Record<string, unknown>;
  loadRow.policyJson = JSON.stringify({ ...policy, requireReleaseApproval: requireApproval });
  return {
    ...snapshot,
    liveCheck: [
      row("live-mutating-smoke", {
        summary: "passed and rolled back",
        checkId: "mutating-smoke",
        mutating: true,
        checkOk: true,
        rollbackExecuted: true,
        rollbackVerified: true,
        outputTail: "ok",
      }),
    ],
    acceptanceVerdict: [
      row("acceptance-verdict", {
        summary: "accepted",
        ok: true,
        failures: [],
        evidenceHash: "b".repeat(64),
        artifact: "smithers://outputs/test/acceptance-verdict",
      }),
    ],
    ...(requireApproval
      ? {
          releaseApproval: [
            row("release-approval", {
              approved: true,
              note: "approved fixture",
              decidedBy: "test",
              decidedAt: "2026-08-07T00:00:00.000Z",
            }),
          ],
        }
      : {}),
    releaseGuard: [
      row("gate-assertion", { summary: "permitted", ok: true, boundHash: "a".repeat(64) }),
      row("release-guard", { summary: "current", ok: true, boundHash: "b".repeat(64) }),
    ],
    releasePlan: [
      row("release-plan", {
        summary: "roll out fixture",
        pluginId: "fixture-plugin",
        intendedRevision: "d".repeat(40),
        actions: ["commit", "push", "publish", "install", "reload"],
      }),
    ],
    releaseAction: ["commit", "push", "publish", "install", "reload"].map((action) =>
      row(`release-${action}`, { summary: `${action} passed`, action, ok: true, exitCode: 0, outputTail: "ok" }),
    ),
    rolloutVerification: [
      row("rollout-verification", {
        summary: "installed revision matches",
        pluginId: "fixture-plugin",
        intendedRevision: "d".repeat(40),
        installedRevision: "d".repeat(40),
        ok: true,
        outputTail: "{}",
      }),
    ],
    rolloutAssertion: [row("rollout-assertion", { summary: "matched", ok: true, boundHash: "d".repeat(40) })],
    releaseReport: [
      row("release-report", { summary: "release passed", verdict: "pass", artifact: "smithers://outputs/test/release-report" }),
    ],
  };
}

function taskMap(graph: { tasks: readonly TaskDescriptor[] }) {
  return new Map(graph.tasks.map((task) => [task.nodeId, task]));
}

async function render(name: string, mode: "verify" | "release", outputs: OutputSnapshot) {
  const data = fixture(name);
  return renderWorkflow(workflow, {
    input: { pluginRoot: data.root, policyPath: ".bb/release-gate.json", mode },
    outputs,
    baseRootDir: resolve(here, ".."),
    workflowPath: resolve(here, "../pack/workflows/bb-plugin-release-gate.tsx"),
  });
}

async function runInstalledGate(name: string, mode: "verify" | "release", mutatePolicy?: (policy: Record<string, unknown>) => void) {
  const pluginRoot = mkdtempSync(join(resolve(here, ".."), ".tmp-gate-process-"));
  try {
    cpSync(resolve(fixturesRoot, name), pluginRoot, { recursive: true });
    if (mutatePolicy) {
      const policyPath = join(pluginRoot, ".bb", "release-gate.json");
      const policy = JSON.parse(readFileSync(policyPath, "utf8")) as Record<string, unknown>;
      mutatePolicy(policy);
      writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
    }
    mkdirSync(join(pluginRoot, ".smithers"), { recursive: true });
    await addPack(`file:${packRoot}`, { from: pluginRoot, yes: true });
    const cli = resolve(here, "../node_modules/.bin/smithers");
    const child = Bun.spawn(
      [
        cli,
        "workflow",
        "run",
        "bb-smithers-workflows:bb-plugin-release-gate",
        "--run-id",
        `gate-process-${crypto.randomUUID()}`,
        "--input",
        JSON.stringify({ pluginRoot, mode }),
        "--no-post-failure",
        "--no-monitor",
        "--no-report",
      ],
      { cwd: pluginRoot, env: { ...process.env, SMITHERS_POST_FAILURE: "0", SMITHERS_NO_REPORT: "1" }, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, output: `${stdout}\n${stderr}` };
  } finally {
    rmSync(pluginRoot, { recursive: true, force: true });
  }
}

describe("bb-plugin-release-gate policy", () => {
  test("all fixtures conform to the strict schema", () => {
    for (const name of ["npm-backend-only", "bun-frontend-only", "both-surfaces-no-harness"]) {
      expect(releaseGatePolicySchema.safeParse(fixture(name).policy).success).toBe(true);
    }
  });

  test("verify commands reject release mutations and harnesses require source evidence", () => {
    const policy = fixture("npm-backend-only").policy;
    expect(
      releaseGatePolicySchema.safeParse({
        ...policy,
        staticChecks: [{ id: "bad-publish", executable: "npm", args: ["publish"], timeoutMs: 1000 }],
      }).success,
    ).toBe(false);
    expect(releaseGatePolicySchema.safeParse({ ...policy, harnessSources: { backend: [], frontend: [] } }).success).toBe(false);
  });

  test("official harness evidence requires exact SDK testing imports", async () => {
    const backend = fixture("npm-backend-only");
    const frontend = fixture("bun-frontend-only");
    const missing = fixture("both-surfaces-no-harness");
    expect(await inspectOfficialHarnessSources(backend.root, backend.policy, "backend")).toMatchObject({
      verified: true,
      verifiedSourcePaths: ["server.test.ts"],
      issues: [],
    });
    expect(await inspectOfficialHarnessSources(frontend.root, frontend.policy, "frontend")).toMatchObject({
      verified: true,
      verifiedSourcePaths: ["app.test.tsx"],
      issues: [],
    });
    expect(await inspectOfficialHarnessSources(missing.root, missing.policy, "backend")).toMatchObject({
      verified: false,
      verifiedSourcePaths: [],
    });
  });

  test("vendored SDK fallback expires when a compatible official package appears", async () => {
    const root = mkdtempSync(join(resolve(here, ".."), ".tmp-sdk-fallback-"));
    try {
      mkdirSync(join(root, "vendor"), { recursive: true });
      writeFileSync(join(root, "vendor", "sdk.tgz"), "fixture");
      const registry = join(root, "registry-check");
      writeFileSync(registry, "#!/bin/sh\nprintf '\"0.4.2\"\\n'\n");
      chmodSync(registry, 0o755);
      const result = await inspectSdkFallback(
        root,
        { engines: { bbPluginSdk: "^0.4.1" }, devDependencies: { "@bb/plugin-sdk": "file:vendor/sdk.tgz" } },
        registry,
      );
      expect(result).toMatchObject({ status: "official-available", officialVersion: "0.4.2" });
      expect(result.migrationInstructions).toContain("Replace file:vendor/sdk.tgz with ^0.4.1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("installed revision parsing requires the active full SHA", () => {
    expect(parseInstalledRevision(JSON.stringify({ history: [{ version: "e".repeat(40) }] }))).toBe("e".repeat(40));
    expect(parseInstalledRevision(JSON.stringify({ history: [{ version: "main" }] }))).toBeNull();
  });
});

describe("bb-plugin-release-gate graph", () => {
  test("Gateway UI discovery can render the workflow before inputs are populated", async () => {
    const graph = await renderWorkflow(workflow, {
      input: {} as never,
      outputs: {},
      baseRootDir: resolve(here, ".."),
      workflowPath: resolve(here, "../pack/workflows/bb-plugin-release-gate.tsx"),
    });
    expect(taskMap(graph).has("load-policy")).toBe(true);
  });

  test("verify mode contains deterministic gates and structurally omits all live, approval, and release nodes", async () => {
    const graph = await render("npm-backend-only", "verify", stageOutputs("npm-backend-only"));
    const tasks = taskMap(graph);
    const ids = [...tasks.keys()];
    expect(ids).toEqual(
      expect.arrayContaining([
        "load-policy",
        "cross-validate",
        "sdk-fallback",
        "discover-env",
        "static-gates",
        "harness-backend",
        "build",
        "inspect-artifacts",
        "verdict",
        "report",
        "gate-assertion",
      ]),
    );
    expect(ids).not.toContain("harness-frontend");
    expect(ids.filter((id) => /^(live-|release-)/.test(id))).toEqual([]);
    expect(graph.tasks.filter((task) => task.needsApproval)).toEqual([]);
    expect(tasks.get("load-policy")?.outputSchema).toBe(releaseGateSchemas.loadPolicy);
    expect(tasks.get("harness-backend")?.outputSchema).toBe(releaseGateSchemas.harness);
    expect(tasks.get("verdict")?.outputSchema).toBe(releaseGateSchemas.verdict);
    expect(tasks.get("report")?.outputSchema).toBe(releaseGateSchemas.report);
    expect(tasks.get("cross-validate")?.agent).toBeUndefined();
    expect(tasks.get("inspect-artifacts")?.agent).toBeUndefined();
    expect(tasks.get("report")?.agent).toBeUndefined();
    expect(tasks.get("build")?.dependsOn).toContain("harness-backend");
    expect(tasks.get("report")?.dependsOn).toContain("verdict");
    expect(tasks.get("gate-assertion")?.dependsOn).toContain("report");
  });

  test("applicable backend, frontend, and dual-surface branches render from the real module", async () => {
    const backend = taskMap(await render("npm-backend-only", "verify", stageOutputs("npm-backend-only")));
    const frontend = taskMap(await render("bun-frontend-only", "verify", stageOutputs("bun-frontend-only")));
    const both = taskMap(await render("both-surfaces-no-harness", "verify", stageOutputs("both-surfaces-no-harness")));
    expect(backend.has("harness-backend")).toBe(true);
    expect(backend.has("harness-frontend")).toBe(false);
    expect(frontend.has("harness-backend")).toBe(false);
    expect(frontend.has("harness-frontend")).toBe(true);
    expect(both.has("harness-backend")).toBe(true);
    expect(both.has("harness-frontend")).toBe(true);
  });

  test("release mode renders reversible live checks, one final approval, and sequential release actions", async () => {
    const graph = await render("npm-backend-only", "release", releaseOutputs("npm-backend-only"));
    const tasks = taskMap(graph);
    expect([...tasks.keys()]).toEqual(
      expect.arrayContaining([
        "live-mutating-smoke",
        "acceptance-verdict",
        "release-approval",
        "release-guard",
        "release-plan",
        "release-commit",
        "release-push",
        "release-publish",
        "release-install",
        "release-reload",
        "rollout-verification",
        "rollout-assertion",
        "release-report",
      ]),
    );
    const approvals = graph.tasks.filter((task) => task.needsApproval);
    expect(approvals.map((task) => task.nodeId)).toEqual(["release-approval"]);
    expect(approvals[0]?.proofBindingRequired).toBe(true);
    expect(tasks.get("release-plan")?.dependsOn).toContain("gate-assertion");
    expect(tasks.get("live-mutating-smoke")?.dependsOn).toContain("release-plan");
    expect(tasks.get("release-approval")?.dependsOn).toContain("acceptance-verdict");
    expect(tasks.get("release-guard")?.dependsOn).toContain("release-approval");
    expect(tasks.get("release-push")?.dependsOn).toContain("release-commit");
    expect(tasks.get("rollout-verification")?.dependsOn).toContain("release-reload");
    expect(tasks.get("release-report")?.dependsOn).toContain("rollout-assertion");
  });

  test("policy can intentionally omit the final approval without changing release ordering", async () => {
    const graph = await render("npm-backend-only", "release", releaseOutputs("npm-backend-only", false));
    const tasks = taskMap(graph);
    expect(graph.tasks.filter((task) => task.needsApproval)).toEqual([]);
    expect(tasks.has("release-approval")).toBe(false);
    expect(tasks.get("release-guard")?.dependsOn).toContain("acceptance-verdict");
    expect(tasks.get("release-commit")?.dependsOn).toContain("release-guard");
  });

  test("a failed verify verdict prevents every release-mode side effect", async () => {
    const outputs = releaseOutputs("npm-backend-only");
    outputs.verdict = [
      row("verdict", {
        summary: "FAIL",
        verdict: "fail",
        blockingFailures: [{ scope: "build", message: "failed" }],
        waivedItems: [],
        evidenceHash: "c".repeat(64),
        reportArtifact: "smithers://outputs/test/verdict",
      }),
    ];
    outputs.releaseGuard = [];
    const graph = await render("npm-backend-only", "release", outputs);
    expect([...taskMap(graph).keys()].filter((id) => /^(live-|release-)/.test(id))).toEqual([]);
  });
});

describe("native pack installation", () => {
  test("a clean local install discovers the qualified workflow and convention UI", async () => {
    const consumerRoot = mkdtempSync(join(tmpdir(), "bb-smithers-workflows-test-"));
    try {
      mkdirSync(join(consumerRoot, ".smithers"), { recursive: true });
      const installed = await addPack(`file:${packRoot}`, { from: consumerRoot, yes: true });
      expect(installed.name).toBe("bb-smithers-workflows");
      expect(installed.manifest.capabilities.writes).toBe("repo");
      expect(existsSync(join(consumerRoot, ".smithers", "packs.lock.toon"))).toBe(true);
      expect(existsSync(join(installed.path, "ui", "bb-plugin-release-gate.tsx"))).toBe(true);
      expect(existsSync(join(installed.path, "lib", "bb-plugin-release-gate", "ci-verify.sh"))).toBe(true);
      expect(discoverWorkflows(consumerRoot).some((entry) => entry.id === "bb-plugin-release-gate")).toBe(true);
      expect(resolveWorkflow("bb-smithers-workflows:bb-plugin-release-gate", consumerRoot).entryFile).toBe(
        join(installed.path, "workflows", "bb-plugin-release-gate.tsx"),
      );
    } finally {
      rmSync(consumerRoot, { recursive: true, force: true });
    }
  });

  test("the installed workflow exits zero on pass and nonzero after a reported failing verdict", async () => {
    const passed = await runInstalledGate("npm-backend-only", "verify");
    expect(passed.exitCode).toBe(0);

    const failed = await runInstalledGate("npm-backend-only", "verify", (policy) => {
      policy.staticChecks = [{ id: "planted-failure", executable: "node", args: ["-e", "process.exit(9)"] }];
    });
    expect(failed.exitCode).not.toBe(0);
    expect(failed.output).toContain("Release gate failed");
  }, 60_000);

  test("release mode exits nonzero when real rollout configuration is absent", async () => {
    const result = await runInstalledGate("bun-frontend-only", "release");
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("Release mode requires rollout.pluginId");
  }, 60_000);
});
