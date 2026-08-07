/** @jsxImportSource react */
import { useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayNodeOutput,
  useGatewayRunEvents,
  useGatewayRuns,
} from "smthrs/gateway-react";
import { ApprovalPanel, RunEventLog, RunTree, StatusPill, WorkflowUiShell } from "smthrs/gateway-ui";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  KpiStat,
  SectionHeader,
  SmithersUiStyles,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "smthrs/ui";

const WORKFLOW = "bb-plugin-release-gate";
const styles = [
  ".rg-layout{display:grid;grid-template-columns:minmax(0,1fr)260px;gap:16px}",
  ".rg-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px}",
  ".rg-stage-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}",
  ".rg-stage{display:flex;justify-content:space-between;align-items:center;padding:8px;border:1px solid var(--sui-border,var(--border));border-radius:8px}",
  ".rg-run-list{display:flex;flex-direction:column;gap:6px}",
  ".rg-run{justify-content:space-between;width:100%}",
  ".rg-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}",
  ".rg-muted{color:var(--sui-muted-foreground,var(--muted-foreground))}",
  ".rg-verdict{font-size:24px;font-weight:750;letter-spacing:.04em}",
  ".rg-evidence{white-space:pre-wrap;max-height:420px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}",
  ".rg-section{margin-top:16px}",
  "@media(max-width:900px){.rg-layout{grid-template-columns:1fr}.rg-stats{grid-template-columns:repeat(2,minmax(0,1fr))}}",
].join("\n");

type RunSummary = { runId: string; workflowKey?: string; status?: string; createdAtMs?: number };
type Row = Record<string, unknown>;

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rowOf(value: unknown): Row | null {
  if (!isRecord(value)) return null;
  return isRecord(value.row) ? value.row : value;
}

function arrayOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function boolOf(value: unknown): boolean {
  return value === true || value === 1 || value === "true" || value === "1";
}

function stringOf(value: unknown, fallback = "—"): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

function useNodeRow(runId: string | undefined, nodeId: string) {
  return rowOf(useGatewayNodeOutput({ runId, nodeId, iteration: 0 }).data);
}

function eventNodeIds(events: readonly unknown[], prefix: string): string[] {
  const ids = new Set<string>();
  const visit = (value: unknown, depth = 0) => {
    if (!isRecord(value) || depth > 4) return;
    const nodeId = typeof value.nodeId === "string" ? value.nodeId : undefined;
    if (nodeId?.startsWith(prefix)) ids.add(nodeId);
    visit(value.payload, depth + 1);
  };
  events.forEach((event) => visit(event));
  return [...ids].sort();
}

function stateFor(row: Row | null): string {
  return row ? "finished" : "waiting";
}

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [selectedNode, setSelectedNode] = useState("verdict");
  const runsQuery = useGatewayRuns({ filter: { limit: 30 } });
  const runs = useMemo(
    () => ((runsQuery.data ?? []) as RunSummary[]).filter((run) => !run.workflowKey || run.workflowKey === WORKFLOW),
    [runsQuery.data],
  );
  const runId = selectedRunId ?? runIdFromUrl() ?? runs[0]?.runId;
  const run = runs.find((candidate) => candidate.runId === runId);
  const stream = useGatewayRunEvents(runId, { afterSeq: undefined, maxEvents: 4000 });

  const policy = useNodeRow(runId, "load-policy");
  const environment = useNodeRow(runId, "discover-env");
  const staticGates = useNodeRow(runId, "static-gates");
  const backend = useNodeRow(runId, "harness-backend");
  const frontend = useNodeRow(runId, "harness-frontend");
  const build = useNodeRow(runId, "build");
  const inspection = useNodeRow(runId, "inspect-artifacts");
  const verdict = useNodeRow(runId, "verdict");
  const report = useNodeRow(runId, "report");
  const acceptance = useNodeRow(runId, "acceptance-verdict");
  const releaseReport = useNodeRow(runId, "release-report");
  const selectedOutput = rowOf(useGatewayNodeOutput({ runId, nodeId: selectedNode, iteration: 0 }).data);

  const staticChecks = arrayOf(staticGates?.checks).filter(isRecord);
  const artifacts = arrayOf(build?.artifacts).filter(isRecord);
  const waivers = arrayOf(policy?.waiversJson).filter(isRecord);
  const blocking = arrayOf(verdict?.blockingFailures).filter(isRecord);
  const waived = arrayOf(verdict?.waivedItems).filter(isRecord);
  const liveNodes = eventNodeIds(stream.events ?? [], "live-");
  const releaseNodes = eventNodeIds(stream.events ?? [], "release-");
  const effectiveVerdict = stringOf(releaseReport?.verdict ?? verdict?.verdict, "pending").toUpperCase();
  const stages = [
    ["Policy", policy],
    ["Environment", environment],
    ["Static", staticGates],
    ["Backend harness", backend],
    ["Frontend harness", frontend],
    ["Build", build],
    ["Artifact review", inspection],
    ["Verdict", verdict],
    ["Live acceptance", acceptance],
    ["Release", releaseReport],
  ] as const;

  return (
    <WorkflowUiShell
      title="BB Plugin Release Gate"
      testId="bb-plugin-release-gate-ui"
      meta={
        <>
          <span className="rg-mono">{runId ? runId.slice(0, 8) : "No run"}</span>
          <StatusPill status={run?.status ?? "idle"} />
        </>
      }
    >
      <SmithersUiStyles extra={styles} />
      <div className="rg-layout">
        <main>
          {!runId ? (
            <EmptyState title="No release-gate runs" description="Launch the workflow to inspect policy and evidence." />
          ) : (
            <>
              <div className="rg-stats">
                <KpiStat label="Verdict" value={effectiveVerdict} />
                <KpiStat label="Package manager" value={stringOf(environment?.packageManager)} />
                <KpiStat label="Static checks" value={`${staticChecks.filter((check) => boolOf(check.ok)).length}/${staticChecks.length}`} />
                <KpiStat label="Waivers" value={waivers.length} />
              </div>

              <Card>
                <CardHeader>
                  <CardTitle>Final verdict</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="rg-verdict">{effectiveVerdict}</div>
                  <p>{stringOf(releaseReport?.summary ?? verdict?.summary, "Evidence is still being collected.")}</p>
                  <div className="rg-mono rg-muted">Evidence SHA-256: {stringOf(verdict?.evidenceHash)}</div>
                  {blocking.map((failure, index) => (
                    <p key={`blocking-${index}`}><Badge>BLOCKING</Badge> {stringOf(failure.scope)} — {stringOf(failure.message)}</p>
                  ))}
                  {waived.map((item, index) => (
                    <p key={`waived-${index}`}><Badge>WAIVED</Badge> {stringOf(item.scope)} — {stringOf(item.reason)}</p>
                  ))}
                </CardContent>
              </Card>

              <div className="rg-section">
                <SectionHeader title="Stage timeline" />
                <div className="rg-stage-grid">
                  {stages.map(([label, row]) => (
                    <div className="rg-stage" key={label}>
                      <span>{label}</span>
                      <StatusPill status={stateFor(row)} />
                    </div>
                  ))}
                </div>
              </div>

              <Tabs defaultValue="coverage" className="rg-section">
                <TabsList>
                  <TabsTrigger value="coverage">Coverage</TabsTrigger>
                  <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
                  <TabsTrigger value="approvals">Approvals</TabsTrigger>
                  <TabsTrigger value="evidence">Evidence</TabsTrigger>
                  <TabsTrigger value="tree">Tree</TabsTrigger>
                  <TabsTrigger value="events">Events</TabsTrigger>
                </TabsList>

                <TabsContent value="coverage">
                  <Card>
                    <CardHeader><CardTitle>Official SDK harness matrix</CardTitle></CardHeader>
                    <CardContent>
                      <Table>
                        <TableHeader><TableRow><TableHead>Surface</TableHead><TableHead>Ran</TableHead><TableHead>Result</TableHead><TableHead>Evidence</TableHead></TableRow></TableHeader>
                        <TableBody>
                          {(["backend", "frontend"] as const).map((surface) => {
                            const row = surface === "backend" ? backend : frontend;
                            const waiver = waived.find((item) => item.scope === `harness:${surface}`);
                            return (
                              <TableRow key={surface}>
                                <TableCell>{surface}</TableCell>
                                <TableCell>{boolOf(row?.ran) ? "yes" : "no"}</TableCell>
                                <TableCell>{waiver ? <Badge>WAIVED</Badge> : boolOf(row?.ok) ? <Badge>PASS</Badge> : <Badge>FAIL / N-A</Badge>}</TableCell>
                                <TableCell>{stringOf(waiver?.reason ?? row?.summary)}</TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </CardContent>
                  </Card>
                  <Card className="rg-section">
                    <CardHeader><CardTitle>Static gates</CardTitle></CardHeader>
                    <CardContent>
                      <Table>
                        <TableHeader><TableRow><TableHead>Check</TableHead><TableHead>Command</TableHead><TableHead>Exit</TableHead><TableHead>Result</TableHead></TableRow></TableHeader>
                        <TableBody>
                          {staticChecks.map((check) => (
                            <TableRow key={stringOf(check.id)}>
                              <TableCell>{stringOf(check.id)}</TableCell>
                              <TableCell className="rg-mono">{Array.isArray(check.command) ? check.command.join(" ") : "—"}</TableCell>
                              <TableCell>{String(check.exitCode ?? "—")}</TableCell>
                              <TableCell><Badge>{boolOf(check.ok) ? "PASS" : "FAIL"}</Badge></TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </CardContent>
                  </Card>
                </TabsContent>

                <TabsContent value="artifacts">
                  <Card>
                    <CardHeader><CardTitle>Artifact inspection</CardTitle></CardHeader>
                    <CardContent>
                      <p>{stringOf(inspection?.summary)}</p>
                      <Table>
                        <TableHeader><TableRow><TableHead>Path</TableHead><TableHead>Bytes</TableHead><TableHead>SHA-256</TableHead><TableHead>Result</TableHead></TableRow></TableHeader>
                        <TableBody>
                          {artifacts.map((artifact) => (
                            <TableRow key={stringOf(artifact.path)}>
                              <TableCell className="rg-mono">{stringOf(artifact.path)}</TableCell>
                              <TableCell>{String(artifact.size ?? "—")}</TableCell>
                              <TableCell className="rg-mono">{stringOf(artifact.sha256)}</TableCell>
                              <TableCell><Badge>{boolOf(artifact.ok) ? "PASS" : "FAIL"}</Badge></TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </CardContent>
                  </Card>
                </TabsContent>

                <TabsContent value="approvals">
                  <Card>
                    <CardHeader><CardTitle>Evidence-bound release approval</CardTitle></CardHeader>
                    <CardContent>
                      <p className="rg-muted">When required by policy, one final approval binds release actions to the current live-acceptance evidence hash.</p>
                      <ApprovalPanel filter={{ workflow: WORKFLOW, runId }} />
                      {report ? <div className="rg-evidence">{stringOf(report.markdownReport)}</div> : null}
                    </CardContent>
                  </Card>
                </TabsContent>

                <TabsContent value="evidence">
                  <Card>
                    <CardHeader><CardTitle>Node evidence</CardTitle></CardHeader>
                    <CardContent>
                      <div className="rg-stage-grid">
                        {["load-policy", "cross-validate", "static-gates", "harness-backend", "harness-frontend", "build", "inspect-artifacts", "verdict", "report", "acceptance-verdict", "release-approval", ...liveNodes, ...releaseNodes].map((nodeId) => (
                          <Button key={nodeId} variant={selectedNode === nodeId ? "default" : "outline"} onClick={() => setSelectedNode(nodeId)}>{nodeId}</Button>
                        ))}
                      </div>
                      <pre className="rg-evidence">{selectedOutput ? JSON.stringify(selectedOutput, null, 2) : "No output for this node yet."}</pre>
                    </CardContent>
                  </Card>
                </TabsContent>

                <TabsContent value="tree"><RunTree runId={runId} /></TabsContent>
                <TabsContent value="events"><RunEventLog runId={runId} /></TabsContent>
              </Tabs>
            </>
          )}
        </main>

        <aside>
          <SectionHeader title="Recent runs" />
          <div className="rg-run-list">
            {runs.map((candidate) => (
              <Button key={candidate.runId} className="rg-run" variant={candidate.runId === runId ? "default" : "outline"} onClick={() => setSelectedRunId(candidate.runId)}>
                <span className="rg-mono">{candidate.runId.slice(0, 8)}</span>
                <StatusPill status={candidate.status ?? "unknown"} />
              </Button>
            ))}
          </div>
        </aside>
      </div>
    </WorkflowUiShell>
  );
}

createGatewayReactRoot(<App />);
