// Mac 秘書 / GitHub cron / BGA / ダッシュボードで共有する型

export type ProcessKind =
  | 'claude_code_loop'
  | 'gemini_cli'
  | 'codex_cli'
  | 'cursor_bga'
  | 'mac_secretary'
  | 'github_cron';

export type ProcessStatus = 'running' | 'idle' | 'dead' | 'quota_exhausted';

export interface ProcessInfo {
  kind: ProcessKind;
  status: ProcessStatus;
  pid?: number;
  last_heartbeat: number; // unix ms
  detail?: string;
  cpu?: number; // %
  mem_mb?: number;
}

export type ProjectKind =
  | 'rogue-night'
  | 'emoji-soko'
  | 'parent-news'
  | 'toikake'
  | 'youtube-safe'
  | 'kosodate-bot'
  | 'clipnest'
  | 'markwell'
  | 'focus-timer'
  | 'other';

export type ReleaseStage =
  | 'developing'
  | 'release_ready'
  | 'submitting'
  | 'review'
  | 'published'
  | 'rejected'
  | 'failed';

export interface ProjectStatus {
  project: ProjectKind | string;
  remaining_todos: number;
  last_commit_at: number; // unix ms
  last_commit_msg?: string;
  release_ready: boolean;
  release_stage: ReleaseStage;
  store_url?: string;
  notes?: string;
}

export interface MacState {
  ts: number; // unix ms
  hostname: string;
  uptime_sec: number;
  load_avg: [number, number, number];
  disk_free_gb: number;
  processes: ProcessInfo[];
  projects: ProjectStatus[];
}

export interface Alert {
  id: string;
  ts: number;
  severity: 'info' | 'warn' | 'error' | 'critical';
  topic: string;
  message: string;
  resolved?: boolean;
}

export interface Command {
  id: string;
  ts: number;
  kind:
    | 'restart_loop'
    | 'rebuild_zip'
    | 'submit_one'
    | 'submit_all'
    | 'force_release'
    | 'rerun_butler'
    | 'pause_secretary'
    | 'resume_secretary';
  target?: string;
  initiator: 'dashboard' | 'bga' | 'auto';
  status: 'pending' | 'running' | 'done' | 'failed';
  result?: string;
}
