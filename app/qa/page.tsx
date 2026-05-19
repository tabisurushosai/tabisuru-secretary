// app/qa/page.tsx
// qa-secretary-049: QA 秘書ダッシュボード /qa ページ (Server Component)。
//
// 仕様書 docs/spec_v1_0.md §15 UX 方針:
//   /qa は 4 セクション:
//     1) 直近 7 日サマリー (実行回数 / バグ件数 / コスト)
//     2) 未修正バグ一覧 (severity 降順)
//     3) target 別最終結果 (10 ターゲットの状態を表で)
//     4) 過去ラン履歴 (新しい順、クリックで詳細展開)
//   既存 app/page.tsx のダーク背景・badge スタイルを踏襲。
//   v1.0 ではスクショ実物は Vercel から見えない (パス文字列のみ表示、§15 末尾)。
//
// §3 アーキテクチャ:
//   Mac 側 (qa-secretary src/storage.ts) が qa:* に書き込み、Vercel 側はここから
//   読むだけ。Anthropic / Gmail は Vercel 側に設定しない (§13)。
//   キー設計 (route.ts 048 と一致):
//     qa:summary                … QASummary (直近 30 日サマリー、単一 JSON)
//     qa:bugs:active            … 未修正バグ sorted set (score=detected_at, member=bug_id)
//     qa:bugs:<bug_id>          … BugReport 本体 (JSON)
//     qa:runs:index             … ラン sorted set (score=started_at, member=run_id)
//     qa:runs:<run_id>          … QARun 本体 (JSON)
//
// §16 触ってよい範囲:
//   tabisuru-secretary 側は app/qa/ の新規作成のみ。既存 app/page.tsx /
//   lib/redis.ts / lib/types.ts / middleware.ts は変更禁止。
//   そのため型は本ファイル内に inline 宣言 (qa-secretary src/types.ts と
//   snake_case で 1:1。app/api/qa/route.ts 048 と同じ宣言)。
//   lib/redis.ts は read-only で getRedis() のみ流用 (UPSTASH_REDIS_REST_URL/TOKEN
//   は既存 Vercel 環境変数経由)。
import { getRedis } from '@/lib/redis';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type Severity = 'critical' | 'major' | 'minor' | 'info';
type BugStatus = 'open' | 'fixed' | 'wont-fix' | 'duplicate';
type RunStatus = 'completed' | 'aborted' | 'error';
type TargetKind =
  | 'chrome-ext'
  | 'html5-game'
  | 'nextjs-app'
  | 'vercel-dashboard';
type AnalysisConfidence = 'high' | 'medium' | 'low';

interface NetworkError {
  url: string;
  method: string;
  status_code: number;
  response_body?: string;
}

interface BugEvidence {
  console_errors: string[];
  network_errors: NetworkError[];
  screenshot_paths: string[];
  har_path?: string;
  trace_path?: string;
  reproduction_steps: string[];
}

interface SuggestedFix {
  file_path: string;
  diff?: string;
  description: string;
}

interface AIAnalysis {
  model: string;
  root_cause: string;
  suggested_fix: SuggestedFix[];
  confidence: AnalysisConfidence;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

interface BugReport {
  bug_id: string;
  run_id: string;
  target: string;
  scenario_name: string;
  severity: Severity;
  title: string;
  description: string;
  evidence: BugEvidence;
  ai_analysis: AIAnalysis;
  detected_at: number;
  status: BugStatus;
  duplicate_of?: string;
}

interface QARun {
  run_id: string;
  target: string;
  target_kind: TargetKind;
  target_url: string;
  started_at: number;
  finished_at: number;
  duration_ms: number;
  scenario_count: number;
  pass_count: number;
  fail_count: number;
  bugs: BugReport[];
  cost_estimate_usd: number;
  status: RunStatus;
  abort_reason?: string;
}

interface QASummaryByTargetEntry {
  runs: number;
  bugs: number;
  last_run: number;
}

interface QASummary {
  generated_at: number;
  total_runs_30d: number;
  bugs_open: number;
  bugs_critical: number;
  cost_usd_30d: number;
  by_target: { [target: string]: QASummaryByTargetEntry };
}

const SUMMARY_KEY = 'qa:summary' as const;
const BUGS_ACTIVE_KEY = 'qa:bugs:active' as const;
const BUGS_KEY_PREFIX = 'qa:bugs:' as const;
const RUNS_INDEX_KEY = 'qa:runs:index' as const;
const RUNS_KEY_PREFIX = 'qa:runs:' as const;

const BUGS_DISPLAY_LIMIT = 100;
const RUNS_DISPLAY_LIMIT = 30;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const SEVERITY_ORDER: { [key in Severity]: number } = {
  critical: 0,
  major: 1,
  minor: 2,
  info: 3,
};

function isQASummary(v: unknown): v is QASummary {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.generated_at === 'number' &&
    typeof o.total_runs_30d === 'number' &&
    typeof o.bugs_open === 'number' &&
    typeof o.bugs_critical === 'number' &&
    typeof o.cost_usd_30d === 'number' &&
    typeof o.by_target === 'object' &&
    o.by_target !== null
  );
}

function isBugReport(v: unknown): v is BugReport {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.bug_id === 'string' &&
    typeof o.run_id === 'string' &&
    typeof o.target === 'string' &&
    typeof o.scenario_name === 'string' &&
    typeof o.severity === 'string' &&
    typeof o.title === 'string' &&
    typeof o.status === 'string' &&
    typeof o.detected_at === 'number'
  );
}

function isQARun(v: unknown): v is QARun {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.run_id === 'string' &&
    typeof o.target === 'string' &&
    typeof o.target_kind === 'string' &&
    typeof o.started_at === 'number' &&
    typeof o.finished_at === 'number' &&
    typeof o.status === 'string' &&
    Array.isArray(o.bugs)
  );
}

interface DashboardData {
  summary: QASummary | null;
  bugs: BugReport[];
  runs: QARun[];
  // 直近 7 日サマリーは qa:runs:index を score (started_at) で 7 日分 zrange して
  // 別個に集計する (qa:summary は 30 日固定なので 7 日値を持たない、§3 / §15)。
  recent7d: {
    run_count: number;
    bug_count: number;
    cost_usd: number;
    fail_count: number;
  };
  error: string | null;
}

async function loadQaDashboard(): Promise<DashboardData> {
  try {
    const r = getRedis();
    const now = Date.now();
    const sevenDaysAgo = now - SEVEN_DAYS_MS;

    // 1 段目: summary / bug index / runs index (新しい順 30 件) / runs index (直近 7 日) を並列取得。
    // 7 日窓は byScore で zrange (Upstash REST SDK の zrange は { byScore: true } で score 範囲指定)。
    const [
      summaryRaw,
      bugIdsRaw,
      recentRunIdsRaw,
      sevenDayRunIdsRaw,
    ] = await Promise.all([
      r.get<unknown>(SUMMARY_KEY),
      r.zrange<string[]>(BUGS_ACTIVE_KEY, 0, BUGS_DISPLAY_LIMIT - 1, {
        rev: true,
      }),
      r.zrange<string[]>(RUNS_INDEX_KEY, 0, RUNS_DISPLAY_LIMIT - 1, {
        rev: true,
      }),
      r.zrange<string[]>(RUNS_INDEX_KEY, sevenDaysAgo, now, {
        byScore: true,
      }),
    ]);
    const bugIds: string[] = Array.isArray(bugIdsRaw) ? bugIdsRaw : [];
    const recentRunIds: string[] = Array.isArray(recentRunIdsRaw)
      ? recentRunIdsRaw
      : [];
    const sevenDayRunIds: string[] = Array.isArray(sevenDayRunIdsRaw)
      ? sevenDayRunIdsRaw
      : [];

    // 表示用 30 件と 7 日窓を結合して dedupe (両方に含まれる run は 1 回しか mget しない)。
    const allRunIdSet = new Set<string>();
    for (const id of recentRunIds) allRunIdSet.add(id);
    for (const id of sevenDayRunIds) allRunIdSet.add(id);
    const allRunIds: string[] = Array.from(allRunIdSet);

    const bugKeys: string[] = bugIds.map((id) => `${BUGS_KEY_PREFIX}${id}`);
    const runKeys: string[] = allRunIds.map((id) => `${RUNS_KEY_PREFIX}${id}`);

    // 2 段目: BugReport / QARun を mget で並列取得。空配列 mget はガード (route.ts 048 と同形)。
    const [bugRaws, runRaws] = await Promise.all([
      bugKeys.length > 0
        ? r.mget<unknown[]>(...bugKeys)
        : Promise.resolve([] as unknown[]),
      runKeys.length > 0
        ? r.mget<unknown[]>(...runKeys)
        : Promise.resolve([] as unknown[]),
    ]);

    const summary: QASummary | null = isQASummary(summaryRaw)
      ? summaryRaw
      : null;

    const bugs: BugReport[] = [];
    for (const raw of bugRaws) {
      if (raw === null || raw === undefined) continue;
      if (!isBugReport(raw)) continue;
      // qa:bugs:active と status の整合 fallback (route.ts 048 と同形)。
      if (raw.status !== 'open') continue;
      bugs.push(raw);
    }
    bugs.sort((a, b) => {
      const o = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      if (o !== 0) return o;
      return b.detected_at - a.detected_at;
    });

    // run_id → QARun の map を 1 回作って表示用 / 7 日集計用で別々に取り出す。
    const runMap = new Map<string, QARun>();
    for (const raw of runRaws) {
      if (raw === null || raw === undefined) continue;
      if (!isQARun(raw)) continue;
      runMap.set(raw.run_id, raw);
    }

    const runs: QARun[] = [];
    for (const id of recentRunIds) {
      const run = runMap.get(id);
      if (run !== undefined) runs.push(run);
    }
    runs.sort((a, b) => b.started_at - a.started_at);

    let runCount7d = 0;
    let bugCount7d = 0;
    let failCount7d = 0;
    let costUsd7d = 0;
    for (const id of sevenDayRunIds) {
      const run = runMap.get(id);
      if (run === undefined) continue;
      runCount7d += 1;
      bugCount7d += run.bugs.length;
      failCount7d += run.fail_count;
      costUsd7d += run.cost_estimate_usd;
    }

    return {
      summary,
      bugs,
      runs,
      recent7d: {
        run_count: runCount7d,
        bug_count: bugCount7d,
        cost_usd: costUsd7d,
        fail_count: failCount7d,
      },
      error: null,
    };
  } catch (e) {
    return {
      summary: null,
      bugs: [],
      runs: [],
      recent7d: { run_count: 0, bug_count: 0, cost_usd: 0, fail_count: 0 },
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function ago(ts?: number): string {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fmtUsd(v: number): string {
  return `$${v.toFixed(2)}`;
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m${rs}s`;
}

function severityBadgeClass(s: Severity): string {
  switch (s) {
    case 'critical':
    case 'major':
      return 'badge badge-red';
    case 'minor':
      return 'badge badge-yellow';
    case 'info':
    default:
      return 'badge';
  }
}

function runStatusBadgeClass(s: RunStatus): string {
  switch (s) {
    case 'completed':
      return 'badge badge-green';
    case 'aborted':
      return 'badge badge-yellow';
    case 'error':
    default:
      return 'badge badge-red';
  }
}

function shortRunId(runId: string): string {
  if (runId.length <= 10) return runId;
  return `${runId.slice(0, 6)}…${runId.slice(-4)}`;
}

export default async function QaDashboard() {
  const { summary, bugs, runs, recent7d, error } = await loadQaDashboard();
  const criticalOpen = bugs.filter((b) => b.severity === 'critical').length;
  const majorOpen = bugs.filter((b) => b.severity === 'major').length;
  const byTargetEntries: Array<[string, QASummaryByTargetEntry]> = summary
    ? Object.entries(summary.by_target).sort((a, b) => b[1].last_run - a[1].last_run)
    : [];

  return (
    <main className="min-h-screen p-6 max-w-[1400px] mx-auto">
      <header className="flex items-center justify-between mb-6 pb-4 border-b border-line">
        <div>
          <h1 className="text-xl font-mono">
            旅する書斎 <span className="text-text-secondary">QA</span>
          </h1>
          <p className="text-xs text-text-muted font-mono mt-1">
            qa-secretary v1.0 · daily 03:00 JST · Playwright + Claude Sonnet 4.6 ·
            Upstash Redis (read-only here)
          </p>
        </div>
        <div className="flex items-center gap-3">
          {criticalOpen > 0 && (
            <span className="badge badge-red">
              CRITICAL {criticalOpen}
            </span>
          )}
          {majorOpen > 0 && (
            <span className="badge badge-red">MAJOR {majorOpen}</span>
          )}
          {!error && criticalOpen === 0 && majorOpen === 0 && (
            <span className="badge badge-green">OK</span>
          )}
          <span className="text-xs text-text-muted font-mono">
            summary: {ago(summary?.generated_at)}
          </span>
        </div>
      </header>

      {error && (
        <div className="panel border-accent-red/40 mb-6">
          <div className="panel-title text-accent-red">REDIS ERROR</div>
          <pre className="text-xs font-mono text-accent-red whitespace-pre-wrap">
            {error}
          </pre>
        </div>
      )}

      <div className="grid grid-cols-12 gap-4">
        {/* §15 (1) 直近 7 日サマリー */}
        <section className="col-span-12 panel">
          <div className="panel-title flex justify-between">
            <span>SUMMARY (last 7 days)</span>
            <span className="text-text-muted">
              {summary
                ? `30d window: ${summary.total_runs_30d} runs · ${fmtUsd(summary.cost_usd_30d)}`
                : 'no summary cached yet'}
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-2">
            <div className="bg-bg-card rounded p-3">
              <div className="text-xs text-text-muted font-mono">RUNS 7d</div>
              <div className="text-2xl font-mono text-text-primary mt-1">
                {recent7d.run_count}
              </div>
            </div>
            <div className="bg-bg-card rounded p-3">
              <div className="text-xs text-text-muted font-mono">BUGS 7d</div>
              <div className="text-2xl font-mono text-text-primary mt-1">
                {recent7d.bug_count}
              </div>
              <div className="text-xs text-text-muted font-mono mt-1">
                fail {recent7d.fail_count}
              </div>
            </div>
            <div className="bg-bg-card rounded p-3">
              <div className="text-xs text-text-muted font-mono">COST 7d</div>
              <div className="text-2xl font-mono text-text-primary mt-1">
                {fmtUsd(recent7d.cost_usd)}
              </div>
              <div className="text-xs text-text-muted font-mono mt-1">
                limit $50 / 30d
              </div>
            </div>
            <div className="bg-bg-card rounded p-3">
              <div className="text-xs text-text-muted font-mono">BUGS open</div>
              <div className="text-2xl font-mono text-text-primary mt-1">
                {summary?.bugs_open ?? bugs.length}
              </div>
              <div className="text-xs text-text-muted font-mono mt-1">
                critical {summary?.bugs_critical ?? criticalOpen}
              </div>
            </div>
          </div>
        </section>

        {/* §15 (2) 未修正バグ一覧 (severity 降順) */}
        <section className="col-span-12 panel">
          <div className="panel-title flex justify-between">
            <span>OPEN BUGS</span>
            <span className="text-text-muted">{bugs.length}</span>
          </div>
          {bugs.length === 0 ? (
            <p className="text-xs text-text-muted font-mono">
              No open bugs. 🎉 (qa:bugs:active が空)
            </p>
          ) : (
            <ul className="space-y-2">
              {bugs.map((b) => (
                <li
                  key={b.bug_id}
                  className="border border-line rounded bg-bg-card"
                >
                  <details>
                    <summary className="cursor-pointer p-3 text-xs font-mono">
                      <span className={severityBadgeClass(b.severity)}>
                        {b.severity}
                      </span>
                      <span className="ml-2 text-text-primary">{b.target}</span>
                      <span className="ml-2 text-text-secondary">
                        {b.scenario_name}
                      </span>
                      <span className="ml-2 text-text-primary">{b.title}</span>
                      <span className="ml-2 text-text-muted">
                        {ago(b.detected_at)}
                      </span>
                    </summary>
                    <div className="px-3 pb-3 text-xs font-mono space-y-3">
                      <div className="text-text-muted">
                        bug_id: {b.bug_id} · run_id: {shortRunId(b.run_id)}
                        {b.duplicate_of && (
                          <span className="ml-2">
                            duplicate_of: {b.duplicate_of}
                          </span>
                        )}
                      </div>

                      {b.description && (
                        <div>
                          <div className="text-text-secondary mb-1">
                            description
                          </div>
                          <pre className="whitespace-pre-wrap text-text-primary">
                            {b.description}
                          </pre>
                        </div>
                      )}

                      {b.evidence.console_errors.length > 0 && (
                        <div>
                          <div className="text-text-secondary mb-1">
                            console_errors ({b.evidence.console_errors.length})
                          </div>
                          <pre className="whitespace-pre-wrap text-accent-red max-h-48 overflow-auto">
                            {b.evidence.console_errors.join('\n')}
                          </pre>
                        </div>
                      )}

                      {b.evidence.network_errors.length > 0 && (
                        <div>
                          <div className="text-text-secondary mb-1">
                            network_errors ({b.evidence.network_errors.length})
                          </div>
                          <ul className="space-y-1">
                            {b.evidence.network_errors.map((ne, i) => (
                              <li key={i} className="text-text-primary">
                                <span className="text-accent-red">
                                  [{ne.status_code}]
                                </span>{' '}
                                {ne.method} {ne.url}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {b.evidence.reproduction_steps.length > 0 && (
                        <div>
                          <div className="text-text-secondary mb-1">
                            reproduction_steps
                          </div>
                          <ol className="list-decimal list-inside space-y-0.5 text-text-primary">
                            {b.evidence.reproduction_steps.map((step, i) => (
                              <li key={i}>{step}</li>
                            ))}
                          </ol>
                        </div>
                      )}

                      {b.evidence.screenshot_paths.length > 0 && (
                        <div>
                          <div className="text-text-secondary mb-1">
                            screenshots (Mac 側 artifact パス、Vercel から実物は見えない)
                          </div>
                          <ul className="space-y-0.5">
                            {b.evidence.screenshot_paths.map((p, i) => (
                              <li key={i} className="text-text-muted">
                                {p}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      <div className="border-t border-line pt-2">
                        <div className="text-text-secondary mb-1">
                          ai_analysis ({b.ai_analysis.model} · confidence{' '}
                          {b.ai_analysis.confidence} ·{' '}
                          {fmtUsd(b.ai_analysis.cost_usd)})
                        </div>
                        <pre className="whitespace-pre-wrap text-text-primary">
                          {b.ai_analysis.root_cause}
                        </pre>
                      </div>

                      {b.ai_analysis.suggested_fix.length > 0 && (
                        <div>
                          <div className="text-text-secondary mb-1">
                            suggested_fix ({b.ai_analysis.suggested_fix.length})
                          </div>
                          <ul className="space-y-2">
                            {b.ai_analysis.suggested_fix.map((fix, i) => (
                              <li
                                key={i}
                                className="border border-line rounded p-2"
                              >
                                <div className="text-text-primary mb-1">
                                  {fix.file_path}
                                </div>
                                <div className="text-text-muted mb-1">
                                  {fix.description}
                                </div>
                                {fix.diff && (
                                  <pre className="whitespace-pre-wrap text-text-primary bg-bg-panel rounded p-2 max-h-64 overflow-auto">
                                    {fix.diff}
                                  </pre>
                                )}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* §15 (3) target 別最終結果 */}
        <section className="col-span-12 panel">
          <div className="panel-title flex justify-between">
            <span>TARGETS</span>
            <span className="text-text-muted">
              {byTargetEntries.length} target
              {byTargetEntries.length === 1 ? '' : 's'}
            </span>
          </div>
          {byTargetEntries.length === 0 ? (
            <p className="text-xs text-text-muted font-mono">
              No target summary yet. (qa:summary が未生成 / Mac 側の最初の run
              待ち)
            </p>
          ) : (
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="text-text-muted text-left border-b border-line">
                  <th className="py-1 pr-3">target</th>
                  <th className="py-1 pr-3">runs (30d)</th>
                  <th className="py-1 pr-3">bugs (30d)</th>
                  <th className="py-1 pr-3">last run</th>
                </tr>
              </thead>
              <tbody>
                {byTargetEntries.map(([name, entry]) => (
                  <tr key={name} className="border-b border-line/50">
                    <td className="py-1 pr-3 text-text-primary">{name}</td>
                    <td className="py-1 pr-3 text-text-primary">
                      {entry.runs}
                    </td>
                    <td className="py-1 pr-3">
                      <span
                        className={
                          entry.bugs === 0
                            ? 'badge badge-green'
                            : 'badge badge-yellow'
                        }
                      >
                        {entry.bugs}
                      </span>
                    </td>
                    <td className="py-1 pr-3 text-text-muted">
                      {ago(entry.last_run)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* §15 (4) 過去ラン履歴 (新しい順、クリックで詳細展開) */}
        <section className="col-span-12 panel">
          <div className="panel-title flex justify-between">
            <span>RUNS (recent {RUNS_DISPLAY_LIMIT})</span>
            <span className="text-text-muted">{runs.length}</span>
          </div>
          {runs.length === 0 ? (
            <p className="text-xs text-text-muted font-mono">
              No runs yet. (qa:runs:index が空)
            </p>
          ) : (
            <ul className="space-y-2">
              {runs.map((run) => (
                <li
                  key={run.run_id}
                  className="border border-line rounded bg-bg-card"
                >
                  <details>
                    <summary className="cursor-pointer p-3 text-xs font-mono">
                      <span className={runStatusBadgeClass(run.status)}>
                        {run.status}
                      </span>
                      <span className="ml-2 text-text-primary">
                        {run.target}
                      </span>
                      <span className="ml-2 text-text-secondary">
                        {run.target_kind}
                      </span>
                      <span className="ml-2 text-text-muted">
                        {run.pass_count}/{run.scenario_count} pass
                      </span>
                      {run.fail_count > 0 && (
                        <span className="ml-2 text-accent-red">
                          {run.fail_count} fail
                        </span>
                      )}
                      {run.bugs.length > 0 && (
                        <span className="ml-2 text-accent-yellow">
                          {run.bugs.length} bug
                          {run.bugs.length === 1 ? '' : 's'}
                        </span>
                      )}
                      <span className="ml-2 text-text-muted">
                        {fmtDuration(run.duration_ms)} · {fmtUsd(run.cost_estimate_usd)}
                      </span>
                      <span className="ml-2 text-text-muted">
                        {ago(run.started_at)}
                      </span>
                    </summary>
                    <div className="px-3 pb-3 text-xs font-mono space-y-2">
                      <div className="text-text-muted">
                        run_id: {run.run_id}
                      </div>
                      <div className="text-text-muted">
                        url: {run.target_url || '—'}
                      </div>
                      {run.abort_reason && (
                        <div className="text-accent-yellow">
                          abort_reason: {run.abort_reason}
                        </div>
                      )}
                      {run.bugs.length > 0 ? (
                        <div>
                          <div className="text-text-secondary mb-1">
                            bugs detected in this run
                          </div>
                          <ul className="space-y-1">
                            {run.bugs.map((b) => (
                              <li key={b.bug_id}>
                                <span className={severityBadgeClass(b.severity)}>
                                  {b.severity}
                                </span>
                                <span className="ml-2 text-text-secondary">
                                  {b.scenario_name}
                                </span>
                                <span className="ml-2 text-text-primary">
                                  {b.title}
                                </span>
                                <span className="ml-2 text-text-muted">
                                  ({b.status})
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : (
                        <p className="text-text-muted">No bugs in this run.</p>
                      )}
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <footer className="mt-8 pt-4 border-t border-line text-xs text-text-muted font-mono flex justify-between">
        <span>
          qa-secretary v1.0 · Mac LaunchAgent (03:00 JST) + Upstash Redis (read-only)
        </span>
        <span>auto-refresh: 60s</span>
      </footer>

      <script
        dangerouslySetInnerHTML={{
          __html: 'setTimeout(()=>location.reload(),60000);',
        }}
      />
    </main>
  );
}
