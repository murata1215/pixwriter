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

- **アイキャッチ**: OpenAI gpt-image-1 (low quality, ~$0.011/枚) で自動生成。
  記事の `featured_media_url`(アイキャッチ)に設定する。PixBlogが記事ページ上部・OGP・一覧サムネイルに自動表示するため、本文への画像埋め込みはしない(二重表示防止)
- **図解**: Claude が本文中にSVGを出力 → sharp でPNG変換 → アップロード
- 画像生成/変換が失敗しても記事投稿は止めない
- OPENAI_API_KEY未設定の場合、画像生成はスキップ

### SEO(検索スニペット / OGP / インデックス)

- **excerpt(meta description)**: review/rewrite が検索スニペット用の説明文(100-160字、定型句禁止)を生成し `excerpt` に設定。未設定時はPixBlogが本文先頭160字を自動生成
- **OGP画像 / サムネイル**: `featured_media_url` に設定したアイキャッチが `og:image`・一覧サムネイルに使われる
- **sitemap / canonical / JSON-LD / noindex無し**: PixBlog側で出力済み。Google Search Console 登録済み
- **IndexNow**: PixBlog側で公開/更新時に api.indexnow.org へ即時通知(Bing/Yandex等)
- 移行スクリプト `scripts/backfill-seo.ts`: 公開済み記事に excerpt を後付け生成
  (`npx tsx scripts/backfill-seo.ts` でdry-run、`--apply` で適用)

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

### 品質ゲート(「読ませる記事」)

- `state/quality.md` に「読ませる記事」の基準を定義(人間が直接編集可)。
  一次情報(実コード/エラー原文/実プロダクト名/実数値)を最低3つ、一般論フック・定型句・水増しを排除。
- write/showcase/series_write は quality.md を執筆プロンプトに注入して書く
- review は4軸(hook/firsthand/originality/concise、各1-5)で採点し、
  合計12点未満 or NG定型句検出で本文を1回自動で書き直す。スコアはmemoとarticles.jsonに記録

### PV評価基準

- 成功基準は **100PV以上**(`PV_SUCCESS_THRESHOLD`)。
- 100PV未満のPV差はノイズ(オーナー本人の確認アクセスが大半)として扱い、
  テーマの当たり外れ・撤退・注力の判断根拠にしない。
- 全記事が100PV未満の間、analyzeはPVでの戦略確定を凍結し、記事品質と流入経路を改善軸にする

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
