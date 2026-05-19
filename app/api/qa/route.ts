// app/api/qa/route.ts
// qa-secretary-048: Upstash Redis qa:* namespace から QA 秘書の結果を読む JSON API。
//
// 仕様書 docs/spec_v1_0.md 準拠 (qa-secretary 側と同期):
//   §3 アーキテクチャ:
//     Vercel 側は Upstash から read-only。書き込みは Mac 側 (src/storage.ts) のみ。
//     キー設計:
//       qa:summary             … QASummary (直近 30 日サマリー、単一 JSON)
//       qa:bugs:active         … 未修正バグの sorted set (score=detected_at, member=bug_id)
//       qa:bugs:<bug_id>       … BugReport 本体 (JSON)
//       qa:runs:index          … ラン ID の sorted set (score=started_at, member=run_id)
//       qa:runs:<run_id>       … QARun 本体 (JSON)
//   §13 認証情報:
//     UPSTASH_REDIS_REST_URL/TOKEN は Vercel 環境変数 (既存)、lib/redis.ts 経由で読む。
//     Anthropic / Gmail のキーは Vercel 側に設定しない (Mac 側のみで叩く)。
//   §15 UX 方針:
//     /qa ページの 4 セクション分のデータを 1 レスポンスで返す
//     (summary / 未修正バグ / 過去ラン履歴。target 別最終結果は summary.by_target に集約済み)。
//   §16 触ってよい範囲:
//     tabisuru-secretary 側は app/api/qa/ の新規作成のみ。lib/redis.ts は read-only。
//
// 設計メモ:
//   - export const dynamic = 'force-dynamic'  Vercel エッジキャッシュを無効化 (常に最新)
//   - export const runtime = 'nodejs'         既存 app/api/state/route.ts と揃える
//   - 型は qa-secretary 側 src/types.ts と snake_case で 1:1。tabisuru-secretary の
//     既存 lib/types.ts は変更禁止 (§8) のため本ファイル内に inline 宣言する。
//   - zod を新規依存に足さない設計 (tabisuru-secretary は zod 未導入)。
//     軽量な runtime guard (isQASummary / isBugReport / isQARun) で形だけ確認し、
//     不正な個別 JSON は skip して残りを返す (qa-secretary src/storage.ts 同等の堅牢性)。
//   - ?limit_bugs / ?limit_runs クエリで件数調整可能。既定は §15 が想定する規模で十分。
import { NextRequest, NextResponse } from 'next/server';
import { getRedis } from '@/lib/redis';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SUMMARY_KEY = 'qa:summary' as const;
const BUGS_ACTIVE_KEY = 'qa:bugs:active' as const;
const BUGS_KEY_PREFIX = 'qa:bugs:' as const;
const RUNS_INDEX_KEY = 'qa:runs:index' as const;
const RUNS_KEY_PREFIX = 'qa:runs:' as const;

const DEFAULT_BUGS_LIMIT = 100;
const MAX_BUGS_LIMIT = 500;
const DEFAULT_RUNS_LIMIT = 30;
const MAX_RUNS_LIMIT = 200;

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

interface QAApiResponse {
  ok: true;
  ts: number;
  summary: QASummary | null;
  bugs: BugReport[];
  runs: QARun[];
}

interface QAApiErrorResponse {
  ok: false;
  error: string;
}

function parseLimit(
  raw: string | null,
  defaultValue: number,
  maxValue: number,
): number {
  if (raw === null) return defaultValue;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) return defaultValue;
  return Math.min(n, maxValue);
}

// 個別 JSON の最小限の形チェック (zod 非依存の軽量 guard)。
// 不正な 1 件は skip するが他のキーは返す堅牢性方針 (qa-secretary 側 storage.ts と同じ)。
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

export async function GET(
  req: NextRequest,
): Promise<NextResponse<QAApiResponse | QAApiErrorResponse>> {
  const url = new URL(req.url);
  const bugsLimit = parseLimit(
    url.searchParams.get('limit_bugs'),
    DEFAULT_BUGS_LIMIT,
    MAX_BUGS_LIMIT,
  );
  const runsLimit = parseLimit(
    url.searchParams.get('limit_runs'),
    DEFAULT_RUNS_LIMIT,
    MAX_RUNS_LIMIT,
  );

  try {
    const r = getRedis();

    // 1 段目: qa:summary / qa:bugs:active / qa:runs:index を並列取得。
    // zrange は新しい順 (score desc) で先頭 limit 件の member (bug_id / run_id) を返す。
    const [summaryRaw, bugIdsRaw, runIdsRaw] = await Promise.all([
      r.get<unknown>(SUMMARY_KEY),
      r.zrange<string[]>(BUGS_ACTIVE_KEY, 0, bugsLimit - 1, { rev: true }),
      r.zrange<string[]>(RUNS_INDEX_KEY, 0, runsLimit - 1, { rev: true }),
    ]);
    const bugIds: string[] = Array.isArray(bugIdsRaw) ? bugIdsRaw : [];
    const runIds: string[] = Array.isArray(runIdsRaw) ? runIdsRaw : [];

    // 2 段目: 個別 BugReport / QARun を mget で並列取得。
    // 空配列で mget を呼ぶと @upstash/redis が "missing arguments" でエラーになるためガード。
    const bugKeys: string[] = bugIds.map((id) => `${BUGS_KEY_PREFIX}${id}`);
    const runKeys: string[] = runIds.map((id) => `${RUNS_KEY_PREFIX}${id}`);
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
      // qa:bugs:active と status の整合 fallback: open 以外は除外。
      if (raw.status !== 'open') continue;
      bugs.push(raw);
    }

    const runs: QARun[] = [];
    for (const raw of runRaws) {
      if (raw === null || raw === undefined) continue;
      if (!isQARun(raw)) continue;
      runs.push(raw);
    }

    return NextResponse.json({
      ok: true,
      ts: Date.now(),
      summary,
      bugs,
      runs,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
