import { Redis } from '@upstash/redis';

let _client: Redis | null = null;

export function getRedis(): Redis {
  if (_client) return _client;

  // Vercel Marketplace 経由の Upstash Redis は KV_REST_API_* と UPSTASH_REDIS_REST_* の両方が注入される。
  // UPSTASH_REDIS_REST_URL/TOKEN を優先、フォールバックで KV_REST_API_URL/TOKEN。
  const url =
    process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    throw new Error(
      'Upstash Redis credentials not found. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL and KV_REST_API_TOKEN).'
    );
  }

  _client = new Redis({ url, token });
  return _client;
}

// キー設計 (Mac 秘書 / GitHub Actions cron / Cursor BGA が共通で読み書きする)
export const K = {
  // 各種ハートビート
  heartbeat: (who: string) => `hb:${who}`, // who = mac_secretary / github_cron / bga / kosodate / etc
  // 全プロセス状態 (Mac 秘書が 5分毎に push)
  macState: 'state:mac',
  // 各プロジェクトのリリース可否
  projectStatus: (project: string) => `project:${project}:status`,
  // 申請キュー
  releaseQueue: 'queue:release',
  // アラート (赤バッジ・社長要対応)
  alerts: 'alerts',
  // 社長からの命令 (ダッシュボードボタン → ここに push → Mac 秘書 / GitHub cron が拾う)
  commands: 'commands:pending',
  commandsDone: 'commands:done',
  // 各種カウンター
  counter: (name: string) => `counter:${name}`,
} as const;
