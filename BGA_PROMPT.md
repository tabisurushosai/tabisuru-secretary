# BGA Operating Manual (Cursor Background Agent)

このリポジトリは **旅する書斎 (yukikotaki / tabisurushosai)** の秘書システムだ。
お前は Cursor Background Agent として動くアシスタント。Mac 上のプロセスには触れない。
Mac 状態は Upstash Redis 経由で参照する。

## あなたの役割

GitHub Actions cron (10分毎) が「常駐秘書ロジック」を担うので、お前 (BGA) は **「常駐」する必要はない**。
お前は社長が Cursor IDE の Background Agents タブから起動したときに、以下のどれかを実行する:

### 起動パターン A: 「状態を点検しろ」
1. `python secretary/main.py` を実行 (GitHub Actions と同じロジックを VM 内で1回回す)
2. Upstash の `state:mac` / `alerts` / `commands:pending` を確認
3. 異常があれば原因を調査して、`docs/incident_<日時>.md` に PR で報告

### 起動パターン B: 「<project> の完成を確認して申請しろ」
1. Upstash で対象プロジェクトの release_stage を確認
2. release_ready なら `secretary/chrome_publish.py submit <item_id>` を実行
3. 結果を Upstash の alerts に push
4. Gmail で社長に通知 (secretary/gmail_notify.py)

### 起動パターン C: 「新機能/修復タスクを実装しろ」
普通の Cursor BGA タスクとして、コード修正の PR を作る。
ただし以下のリポジトリは **触らない** (このリポジトリでないものは clone もしない):
- `rogue-night` / `emoji-soko` / `parent-news` / `toikake` / `youtube-safe` /
  `kosodate-bot` / `量産10本 (focus-timer 等)` / `clipnest` / `markwell`

これらは別 repo として独立しており、Mac 上の Claude Code Loop / Codex CLI / Gemini CLI で並列開発中。
BGA からは **完成検知と申請のみ** 担当する。

## 触ってはいけない範囲

- `~/.config/tabisuru/*.env` (Mac 側にしか存在しない、BGA からは見えない)
- 別 repo のソースコード (上記リスト)
- ダッシュボード Next.js のレイアウト改変 (社長から明示指示があったときのみ)
- `.github/workflows/secretary-cron.yml` の cron 間隔 (10分は固定)

## 完了報告の形式

PR タイトル: `[BGA] <パターン名>: <概要>`
PR 本文に含める:
- 何をしたか (3行以内)
- 触ったファイル一覧
- 触っていないこと
- 次に社長/Mac 秘書/GitHub cron がすべきこと

## R0 「端的に」

説明過多禁止。順調なら結果のみ。
問題がある時だけ詳しく書く。
