import { headers } from 'next/headers';
import { getRedis, K } from '@/lib/redis';
import { adaptSecretaryState } from '@/lib/secretary_state_adapter';
import type { MacState, Alert, ProjectStatus, Command } from '@/lib/types';
import { CommandPanel } from './CommandPanel';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

async function loadState() {
  try {
    const r = getRedis();
    let [mac, alerts, queue, pending] = await Promise.all([
      r.get<MacState>(K.macState),
      r.lrange<Alert>(K.alerts, 0, 19),
      r.lrange<string>(K.releaseQueue, 0, 19),
      r.lrange<Command>(K.commands, 0, 19),
    ]);

    // macState が null なら secretary:state を adapter 経由で読む (route.ts と同じ fallback)
    if (!mac) {
      const raw = await r.get<string | object>(K.secretaryState);
      if (raw) {
        const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
        mac = adaptSecretaryState(obj);
      }
    }

    return { mac, alerts: alerts ?? [], queue: queue ?? [], pending: pending ?? [], error: null as string | null };
  } catch (e) {
    return {
      mac: null,
      alerts: [],
      queue: [],
      pending: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// /api/qa レスポンスの summary 部分 (qa-secretary v1.1)。
interface QASummary {
  total_runs_30d: number;
  bugs_open: number;
  bugs_critical: number;
  cost_usd_30d: number;
}

// QA バグ検査サマリーを /api/qa から内部 fetch する。
// Server Component から自分自身の API を叩くため絶対 URL + Basic 認証ヘッダ転送が必要。
async function loadQAState() {
  try {
    const h = headers();
    const host = h.get('host');
    if (!host) {
      return { qa: null as QASummary | null, qaError: 'host header 不明' };
    }
    const proto = h.get('x-forwarded-proto') ?? 'https';
    const auth = h.get('authorization');
    const res = await fetch(`${proto}://${host}/api/qa`, {
      cache: 'no-store',
      headers: auth ? { authorization: auth } : undefined,
    });
    if (!res.ok) {
      return { qa: null as QASummary | null, qaError: `HTTP ${res.status}` };
    }
    const json = await res.json();
    if (!json?.ok) {
      return {
        qa: null as QASummary | null,
        qaError: json?.error ?? 'unknown error',
      };
    }
    return {
      qa: (json.summary ?? null) as QASummary | null,
      qaError: null as string | null,
    };
  } catch (e) {
    return {
      qa: null as QASummary | null,
      qaError: e instanceof Error ? e.message : String(e),
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

export default async function Dashboard() {
  const [{ mac, alerts, queue, pending, error }, qaState] = await Promise.all([
    loadState(),
    loadQAState(),
  ]);
  const criticalCount = alerts.filter((a) => a.severity === 'critical' && !a.resolved).length;
  const errorCount = alerts.filter((a) => a.severity === 'error' && !a.resolved).length;

  return (
    <main className="min-h-screen p-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <header className="flex items-center justify-between mb-6 pb-4 border-b border-line">
        <div>
          <h1 className="text-xl font-mono">
            旅する書斎 <span className="text-text-secondary">Secretary</span>
          </h1>
          <p className="text-xs text-text-muted font-mono mt-1">
            Mac LaunchAgent · GitHub Actions cron · Cursor BGA · Upstash Redis
          </p>
        </div>
        <div className="flex items-center gap-3">
          {criticalCount > 0 && (
            <span className="badge badge-red">
              CRITICAL {criticalCount}
            </span>
          )}
          {errorCount > 0 && (
            <span className="badge badge-yellow">
              ERROR {errorCount}
            </span>
          )}
          {!error && criticalCount === 0 && errorCount === 0 && (
            <span className="badge badge-green">OK</span>
          )}
          <span className="text-xs text-text-muted font-mono">
            mac: {ago(mac?.ts)}
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
        {/* プロセス稼働状況 */}
        <section className="col-span-12 lg:col-span-6 panel">
          <div className="panel-title flex justify-between">
            <span>PROCESSES</span>
            <span className="text-text-muted">{mac?.processes?.length ?? 0} active</span>
          </div>
          {!mac?.processes?.length ? (
            <p className="text-xs text-text-muted">No data. Mac 秘書が起動していない可能性。</p>
          ) : (
            <ul className="space-y-2">
              {mac.processes.map((p, i) => (
                <li key={i} className="flex items-center justify-between text-xs font-mono">
                  <span>
                    <span className="text-text-primary">{p.kind}</span>
                    {p.pid && <span className="text-text-muted ml-2">pid={p.pid}</span>}
                  </span>
                  <span className="flex items-center gap-2">
                    {p.cpu !== undefined && <span className="text-text-muted">{p.cpu}%</span>}
                    <span
                      className={
                        p.status === 'running'
                          ? 'badge badge-green'
                          : p.status === 'quota_exhausted'
                          ? 'badge badge-yellow'
                          : p.status === 'dead'
                          ? 'badge badge-red'
                          : 'badge'
                      }
                    >
                      {p.status}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* プロジェクト状態 */}
        <section className="col-span-12 lg:col-span-6 panel">
          <div className="panel-title flex justify-between">
            <span>PROJECTS</span>
            <span className="text-text-muted">{mac?.projects?.length ?? 0}</span>
          </div>
          {!mac?.projects?.length ? (
            <p className="text-xs text-text-muted">No data.</p>
          ) : (
            <ul className="space-y-2">
              {mac.projects.map((p: ProjectStatus, i) => (
                <li key={i} className="flex items-center justify-between text-xs font-mono">
                  <span>
                    <span className="text-text-primary">{p.project}</span>
                    <span className="text-text-muted ml-2">
                      TODO: {p.remaining_todos} · {ago(p.last_commit_at)}
                    </span>
                  </span>
                  <span
                    className={
                      p.release_stage === 'published'
                        ? 'badge badge-green'
                        : p.release_stage === 'review'
                        ? 'badge badge-blue'
                        : p.release_stage === 'submitting'
                        ? 'badge badge-purple'
                        : p.release_stage === 'release_ready'
                        ? 'badge badge-yellow'
                        : p.release_stage === 'failed' || p.release_stage === 'rejected'
                        ? 'badge badge-red'
                        : 'badge'
                    }
                  >
                    {p.release_stage}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* アラート */}
        <section className="col-span-12 lg:col-span-6 panel">
          <div className="panel-title">ALERTS (recent 20)</div>
          {!alerts.length ? (
            <p className="text-xs text-text-muted">No alerts. 🎉</p>
          ) : (
            <ul className="space-y-2">
              {alerts.map((a, i) => (
                <li key={i} className="text-xs font-mono">
                  <span
                    className={
                      a.severity === 'critical'
                        ? 'badge badge-red'
                        : a.severity === 'error'
                        ? 'badge badge-red'
                        : a.severity === 'warn'
                        ? 'badge badge-yellow'
                        : 'badge'
                    }
                  >
                    {a.severity}
                  </span>
                  <span className="ml-2 text-text-primary">{a.topic}</span>
                  <span className="ml-2 text-text-secondary">{a.message}</span>
                  <span className="ml-2 text-text-muted">{ago(a.ts)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 申請キュー */}
        <section className="col-span-12 lg:col-span-6 panel">
          <div className="panel-title">RELEASE QUEUE</div>
          {!queue.length ? (
            <p className="text-xs text-text-muted">Queue is empty.</p>
          ) : (
            <ul className="space-y-1">
              {queue.map((item, i) => {
                let parsed: unknown = item;
                try {
                  parsed = typeof item === 'string' ? JSON.parse(item) : item;
                } catch {
                  // keep string
                }
                return (
                  <li key={i} className="text-xs font-mono text-text-primary">
                    <span className="text-text-muted mr-2">[{i}]</span>
                    {JSON.stringify(parsed)}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* 命令パネル (操作ボタン) */}
        <section className="col-span-12 panel">
          <div className="panel-title">COMMANDS</div>
          <CommandPanel pending={pending} />
        </section>

        {/* QA バグ検査サマリー (qa-secretary v1.1 ページの統合表示) */}
        <section className="col-span-12 lg:col-span-6 panel">
          <div className="panel-title flex justify-between">
            <span>QA バグ検査 (qa-secretary)</span>
            {qaState.qa && qaState.qa.bugs_critical > 0 && (
              <span className="badge badge-red">重大 {qaState.qa.bugs_critical}</span>
            )}
          </div>
          {qaState.qaError ? (
            <p className="text-xs text-text-muted">
              QA データ取得失敗: {qaState.qaError}
            </p>
          ) : !qaState.qa ? (
            <p className="text-xs text-text-muted">
              No data. QA 秘書がまだ実行されていない可能性。
            </p>
          ) : (
            <ul className="space-y-2 text-xs font-mono">
              <li className="flex items-center justify-between">
                <span className="text-text-secondary">直近30日のラン数</span>
                <span className="text-text-primary">{qaState.qa.total_runs_30d}</span>
              </li>
              <li className="flex items-center justify-between">
                <span className="text-text-secondary">未修正バグ (open)</span>
                <span className="text-text-primary">{qaState.qa.bugs_open}</span>
              </li>
              <li className="flex items-center justify-between">
                <span className="text-text-secondary">重大バグ (critical)</span>
                <span
                  className={
                    qaState.qa.bugs_critical > 0
                      ? 'badge badge-red'
                      : 'badge badge-green'
                  }
                >
                  {qaState.qa.bugs_critical}
                </span>
              </li>
              <li className="flex items-center justify-between">
                <span className="text-text-secondary">コスト (30日)</span>
                <span className="text-text-primary">
                  ${qaState.qa.cost_usd_30d.toFixed(2)}
                </span>
              </li>
            </ul>
          )}
          <div className="mt-3">
            <a
              href="/qa"
              className="text-xs font-mono text-text-secondary underline"
            >
              詳細を見る →
            </a>
          </div>
        </section>
      </div>

      <footer className="mt-8 pt-4 border-t border-line text-xs text-text-muted font-mono flex justify-between">
        <span>tabisuru-secretary v1.0 · Vercel + Upstash Redis (hnd1) + Mac LaunchAgent</span>
        <span>auto-refresh: 30s</span>
      </footer>

      {/* 30秒で再読み込み */}
      <script
        dangerouslySetInnerHTML={{
          __html: 'setTimeout(()=>location.reload(),30000);',
        }}
      />
    </main>
  );
}
