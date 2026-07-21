# PixWriter - PixBlog Autonomous Blogging Agent

15分ごとにsystemd timerで起動するワンショット型の自律執筆エージェント。
毎サイクル、Claude APIで「次の一手」を1つ決定して実行し、状態を更新して終了する。

## セットアップ

### 1. 環境変数

`/home/pixwriter/.pixblog-agent.env` に以下を設定:

```
PIXBLOG_API_TOKEN=<your-token>
ANTHROPIC_API_KEY=<your-api-key>
DEVRELAY_MCP_TOKEN=<devrelay_pat_...>  # Optional: DevRelay開発ログからのネタ収集用
OPENAI_API_KEY=<sk-proj-...>           # Optional: アイキャッチ画像生成用
```

### 2. 依存パッケージのインストール

```bash
cd /home/pixwriter/agent
PATH="/home/pixwriter/.devrelay/node/bin:$PATH" npm install
```

### 3. 手動テスト実行

```bash
cd /home/pixwriter/agent
PATH="/home/pixwriter/.devrelay/node/bin:$PATH" npm run cycle
```

### 4. systemd タイマーの導入 (sudo必要)

```bash
sudo cp /home/pixwriter/agent/systemd/pixwriter.service /etc/systemd/system/
sudo cp /home/pixwriter/agent/systemd/pixwriter.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable pixwriter.timer
sudo systemctl start pixwriter.timer
```

確認:

```bash
systemctl status pixwriter.timer
systemctl list-timers | grep pixwriter
```

## 使い方

### 手動サイクル実行

```bash
cd /home/pixwriter/agent
PATH="/home/pixwriter/.devrelay/node/bin:$PATH" npm run cycle
```

### 特定アクションを強制実行 (デバッグ用)

```bash
cd /home/pixwriter/agent
PATH="/home/pixwriter/.devrelay/node/bin:$PATH" npm run cycle -- --action research_devrelay
```

### 状態確認

```bash
cd /home/pixwriter/agent
PATH="/home/pixwriter/.devrelay/node/bin:$PATH" npm run status
```

### ログ確認

```bash
# ファイルログ
tail -f /home/pixwriter/logs/cycle-$(date +%Y%m%d).log

# systemdジャーナル
journalctl -u pixwriter.service -f
```

## 運用

### HALT 解除

3連続エラーが発生するとエージェントは自動停止(HALTファイル作成)する。
原因を調査・修正した後、以下で再開:

```bash
rm /home/pixwriter/state/HALT
```

### mission.md の編集

エージェントの使命・制約を変更したい場合:

```bash
vim /home/pixwriter/state/mission.md
```

エージェントは毎サイクルこのファイルを読み込む(AI自身は編集しない)。

### 月間予算のリセット

月初に自動リセットされるが、手動でリセットする場合:

```bash
echo '{"month":"2026-07","inputTokens":0,"outputTokens":0,"estimatedCostUsd":0}' > /home/pixwriter/state/budget.json
```

### strategy.md の確認

AIが更新する戦略ドキュメント。内容を確認して人間がmission.mdで方向修正も可能:

```bash
cat /home/pixwriter/state/strategy.md
```

## アーキテクチャ

### サイクルの流れ

1. HALT/予算チェック
2. ロック取得 (二重実行防止)
3. state読込 + PixBlog API同期
4. Claude APIでアクション決定
5. アクション実行
6. state更新・journal記録
7. ロック解放・終了

### アクション一覧

| アクション | 説明 |
|-----------|------|
| research  | RSSフィードからネタ収集 |
| research_devrelay | DevRelay開発ログから実体験ベースのネタ収集 |
| research_trouble | 会話歴から「詰まり→解決」エピソードを発掘 (検索流入の主力) |
| showcase  | オーナーの公開GitHubリポジトリのプロダクト紹介記事を執筆 |
| outline   | アイデアから記事構成作成 |
| write     | 本文執筆・draft投稿 |
| review    | draft推敲・改善 |
| publish   | reviewed記事を公開 (1日3本) |
| rewrite   | 公開記事のSEO改善 |
| series_plan | 大型プロジェクトの連載企画を作成 (会話履歴サンプリング) |
| series_write | 連載の次の未執筆エピソードを執筆 (会話歴+画像素材) |
| analyze   | PV分析・戦略更新 |
| idle      | 何もしない |

### ガードレール

- 1日3本公開制限、3スロット制 (JST 8-10時/12-14時/19-21時に各1本)
- write -> review(+publish) の最低2サイクル保証
- 月間$20予算上限 (超過で自動停止)
- 画像生成 月間$10予算上限 (超過で画像生成のみスキップ、記事執筆は継続)
- 無料idle: 「やることがない」状況ではClaude APIを呼ばずに即終了(予算節約)
- 3連続エラーでHALT
- 10分タイムアウト

### 画像生成

- **アイキャッチ**: OpenAI gpt-image-1 (low quality, ~$0.011/枚) で自動生成。本文先頭に挿入
- **図解**: Claude が本文中にSVGを出力 → sharp でPNG変換 → アップロード
- 画像生成/変換が失敗しても記事投稿は止めない
- OPENAI_API_KEY未設定の場合、画像生成はスキップ

### マルチライター

記事ごとに異なる「ライター」プロファイル(モデル x 文体)をローテーション:

| ID | モデル | 文体 |
|----|--------|------|
| sonnet-kaisetsu | Claude Sonnet 4 | です・ます調、見出し多め、コード例中心 |
| sonnet-kosatsu | Claude Sonnet 4 | だ・である調、考察エッセイ型 |
| gpt-tutorial | GPT-4.1-mini | 手順チュートリアル型、ステップ構成 |
| haiku-quick | Claude Haiku 4.5 | 短めTips型(1000-1500字) |

- 直近の使用履歴から偏らないようローテーション
- draft+reviewed在庫が3本以上あるとwrite/showcaseを抑制(在庫ゲート)
- PixBlogのmemoフィールドにライター情報を非公開記録
- analyzeでライター別PVを分析し戦略調整

## ディレクトリ構成

```
/home/pixwriter/
  agent/          # コード
    src/           # TypeScriptソース
    systemd/       # systemdユニットファイル
  state/          # 状態ファイル (mission.md, strategy.md, ideas.json, etc.)
  logs/           # サイクルログ (30日保持)
```

## ソース管理

コードは GitHub リポジトリ [murata1215/pixwriter](https://github.com/murata1215/pixwriter) で管理する。

- バージョン管理対象は `agent/` 配下のコードのみ(`src/`, `systemd/`, `package.json`, `tsconfig.json`, `README.md`)
- `state/` と `logs/` は運用データのため管理対象外
- `.gitignore` で `node_modules/`, `.devrelay/`, `.devrelay-output/`, `*.log`, `*.env` を除外
- 認証は SSH デプロイキー(write権限付き)。追加操作なしで push 可能

```bash
cd /home/pixwriter/agent
git add <変更ファイルを明示指定>   # .env混入防止のため git add -A は使わない
git commit -m "..."
git push
```
