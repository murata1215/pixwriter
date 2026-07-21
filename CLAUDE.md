# CLAUDE.md

PixBlog(pixblog.net)上で記事を自律執筆するワンショット型エージェント。
systemd timer で15分ごとに起動し、Claude API で次の一手を1つ決めて実行し終了する。

## 技術スタック

- TypeScript / tsx(トランスパイル不要で実行)
- Node.js は `/home/pixwriter/.devrelay/node/bin`(システムワイドnodeなし)
- Anthropic SDK(claude-sonnet-4-6 / claude-haiku-4-5)、OpenAI SDK(gpt-4.1-mini / gpt-image-1)
- 画像処理: sharp(SVG→PNG)
- 外部連携: PixBlog REST API、DevRelay MCP(Streamable HTTP)

## 開発コマンド

すべて `PATH="/home/pixwriter/.devrelay/node/bin:$PATH"` を前置して実行。

```bash
npm install                          # 依存インストール
npm run cycle                        # 1サイクル手動実行
npm run cycle -- --action <name>     # アクションを強制実行(デバッグ用)
npm run status                       # 状態サマリ表示
/home/pixwriter/.devrelay/node/bin/npx tsc --noEmit   # 型チェック
```

## ソース管理

- GitHub: https://github.com/murata1215/pixwriter (main ブランチ)
- 認証は SSH デプロイキー(write権限)
- `git add` は必ずファイルを明示指定する(`.env`等の秘密情報混入防止のため `-A` 禁止)
- `state/` `logs/` はリポジトリ管理外の運用データ

## 重要な制約

- 秘密情報(トークン/IP/メール/内部ホスト名)をコード・記事・コミットに含めない
- 会話歴・画像由来のデータは sanitize を適用してから扱う
- `/home/pixwriter/.pixblog-agent.env` は agent ディレクトリ外。絶対にコミットしない
