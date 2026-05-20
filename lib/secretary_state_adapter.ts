// Mac 秘書 secretary_v1_0.sh が push する secretary:state (snake_case JSON) を
// 既存の MacState 型 (camelCase) に変換する adapter。
//
// 背景: ダッシュボードは K.macState ('state:mac') を read しているが、Mac 秘書は
// secretary:state キーに別形式 (snake_case) で push しているためミスマッチで情報空になる。
// この adapter で secretary:state を MacState 互換に変換し、route.ts の fallback で使う。

import type {
  Alert,
  MacState,
  ProcessInfo,
  ProcessKind,
  ProjectStatus,
  ReleaseStage,
} from './types';

// secretary:state の生 JSON 形 (Mac 秘書 secretary_v1_0.sh が書き込む)。
export interface SecretaryStateProject {
  name: string;
  exists: boolean;
  todo_remaining: number;
  todo_done: number;
  last_commit_ago_min: number;
  has_release_zip: boolean;
  chrome_submitted: boolean;
  itch_submitted: boolean;
  ready_for_chrome_submit: boolean;
}

export interface SecretaryState {
  updated_at: string;
  projects: SecretaryStateProject[];
  processes: Record<string, number>;
  alerts: string[];
  automation: Record<string, string>;
}

// alert 文字列 → 安定した短い id (djb2)。同じ文字列は常に同じ id になる。
function hashId(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

// secretary:state の最小限の形チェック (zod 非依存の軽量 guard)。
function isSecretaryState(v: unknown): v is SecretaryState {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.updated_at === 'string' &&
    Array.isArray(o.projects) &&
    typeof o.processes === 'object' &&
    o.processes !== null
  );
}

// projects[].chrome_submitted / has_release_zip / todo_remaining から release_stage を決める。
function toReleaseStage(p: SecretaryStateProject): ReleaseStage {
  if (p.chrome_submitted) return 'review';
  if (p.has_release_zip) return 'release_ready';
  if (p.todo_remaining === 0) return 'ready';
  return 'in_progress';
}

// secretary:state の生 JSON を MacState に変換する。形が不正なら null。
export function adaptSecretaryState(raw: unknown): MacState | null {
  if (!isSecretaryState(raw)) return null;

  // updated_at は Mac 秘書がタイムゾーン表記なしの JST naive 文字列
  // (例 "2026-05-19T23:48:01.476031") で書き込む。Vercel (UTC) で new Date()
  // すると UTC として解釈され約 9 時間ずれるため、明示的に +09:00 を付ける。
  const iso =
    raw.updated_at && !/[Z+]/.test(raw.updated_at)
      ? raw.updated_at + '+09:00'
      : raw.updated_at;
  const parsed = iso ? Date.parse(iso) : NaN;
  const ts = Number.isNaN(parsed) ? Date.now() : parsed;
  const now = Date.now();

  const projects: ProjectStatus[] = raw.projects.map((p) => {
    const stage = toReleaseStage(p);
    return {
      project: p.name,
      remaining_todos: p.todo_remaining,
      // last_commit_ago_min (分) → 絶対時刻 (unix ms)
      last_commit_at: now - p.last_commit_ago_min * 60 * 1000,
      release_ready: stage === 'release_ready' || stage === 'review',
      release_stage: stage,
    };
  });

  // { claude_code_loop: 0, ... } → [{ kind, status }] の配列形式へ。
  const processes: ProcessInfo[] = Object.entries(raw.processes ?? {}).map(
    ([kind, count]) => ({
      kind: kind as ProcessKind,
      status: typeof count === 'number' && count > 0 ? 'running' : 'dead',
      last_heartbeat: ts,
    }),
  );

  // string[] → Alert[] へ。secretary:state の alert は重要度未分類なので warn 扱い。
  const alerts: Alert[] = (raw.alerts ?? []).map((message) => ({
    id: hashId(message),
    ts: now,
    severity: 'warn' as const,
    topic: 'secretary',
    message,
    resolved: false,
  }));

  return {
    ts,
    // secretary:state にホスト情報は無いため既定値で埋める。
    hostname: 'mac',
    uptime_sec: 0,
    load_avg: [0, 0, 0],
    disk_free_gb: 0,
    processes,
    projects,
    alerts,
    automation: raw.automation ?? {},
  };
}
