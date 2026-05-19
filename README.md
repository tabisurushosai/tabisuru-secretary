# tabisuru-secretary

旅する書斎 (yukikotaki) の秘書システム。Mac + Vercel + GitHub Actions + Upstash Redis + Cursor BGA。

## 構成

| レイヤ | 動く場所 | 役割 | 起動 |
|---|---|---|---|
| Mac 秘書 (`scripts/mac_secretary.sh`) | Mac LaunchAgent | プロセス監視・状態 push・物理アクション (butler push / chrome upload) | 5分毎 |
| GitHub Actions cron (`.github/workflows/secretary-cron.yml`) | GitHub VM | 異常検知・Gmail 通知・申請判定・auto-submit キュー投入 | 10分毎 |
| Cursor BGA (`BGA_PROMPT.md`) | Cursor クラウド VM | 重い判断・新機能実装・調査 PR | 手動 |
| Vercel ダッシュボード (Next.js) | Vercel hnd1 | 社長専用 UI・命令投入 | 常時 |
| Upstash Redis | Vercel Marketplace (Tokyo) | 全コンポーネントの状態共有メモリ | 常時 |

## ローカル開発

```sh
npm install
cp .env.example .env.local  # 値を埋める
npm run dev
```

## デプロイ

```sh
bash deploy_v1_0.sh   # 別 zip で配布
```

## 触らないこと

- 他 repo (rogue-night, emoji-soko, parent-news, toikake, youtube-safe, kosodate-bot, focus-timer, clipnest, markwell) のコード
- `~/.config/tabisuru/*.env` の中身 (Mac 上に Claude のスクリプトで配置済み)
