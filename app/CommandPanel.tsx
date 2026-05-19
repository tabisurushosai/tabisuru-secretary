'use client';

import { useState } from 'react';
import type { Command } from '@/lib/types';

const COMMANDS: { kind: Command['kind']; label: string; target?: string; danger?: boolean }[] = [
  { kind: 'restart_loop', label: '🔄 Claude Code Loop 全再起動' },
  { kind: 'rebuild_zip', label: '📦 全プロジェクト ZIP 再生成' },
  { kind: 'submit_all', label: '🚀 完成プロジェクトを一括 CWS 申請' },
  { kind: 'rerun_butler', label: '🦋 rogue-night butler push' },
  { kind: 'pause_secretary', label: '⏸ 秘書を一時停止', danger: true },
  { kind: 'resume_secretary', label: '▶️ 秘書を再開' },
];

export function CommandPanel({ pending }: { pending: Command[] }) {
  const [sending, setSending] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);

  async function sendCommand(kind: Command['kind'], target?: string) {
    setSending(kind);
    setLastResult(null);
    try {
      const res = await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, target }),
      });
      const json = await res.json();
      if (res.ok) {
        setLastResult(`✅ ${kind} queued: ${json.id}`);
        // 反映のため少し待ってリロード
        setTimeout(() => location.reload(), 800);
      } else {
        setLastResult(`❌ ${json.error || res.statusText}`);
      }
    } catch (e) {
      setLastResult(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSending(null);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-3">
        {COMMANDS.map((c) => (
          <button
            key={c.kind}
            onClick={() => sendCommand(c.kind, c.target)}
            disabled={sending !== null}
            className={c.danger ? 'btn btn-danger' : 'btn'}
          >
            {sending === c.kind ? '...' : c.label}
          </button>
        ))}
      </div>
      {lastResult && (
        <p className="text-xs font-mono text-text-secondary mb-2">{lastResult}</p>
      )}
      <div className="border-t border-line pt-2">
        <div className="text-xs uppercase tracking-wider text-text-muted font-mono mb-1">
          Pending ({pending.length})
        </div>
        {pending.length === 0 ? (
          <p className="text-xs text-text-muted">none</p>
        ) : (
          <ul className="space-y-1">
            {pending.map((p, i) => (
              <li key={i} className="text-xs font-mono">
                <span className="badge badge-yellow">{p.status}</span>
                <span className="ml-2">{p.kind}</span>
                {p.target && <span className="ml-2 text-text-muted">({p.target})</span>}
                <span className="ml-2 text-text-muted">
                  by {p.initiator}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
