# CLAUDE.md

VS Code 拡張 `ponpoko-review` のリポジトリ。Claude Code 向けの作業メモ。

## これは何
ブランチ間 diff を worktree 単位のツリーで表示し、diff 行に PR レビュー風インラインコメント（＝修正指示）を溜め、
worktree 単位で Markdown(`review.md`)に書き出す**個人用**拡張。修正自体はやらない（出力 md を `claude -p` に渡す前提）。
拡張の責務は「配管」だけ＝コメント収集 → md 整形 → 書き出し。**修正ロジックは絶対に持たせない**。

## ビルド / 実行
- `npm install`
- `npm run compile`（`tsc -p ./` → `out/`）/ `npm run watch`
- デバッグ起動: VS Code で `F5`（Extension Development Host）。`.vscode/launch.json` 済み。
- テストは無し。動作確認は F5 と、純粋関数は `node -e` で `out/*.js` を叩いて確認する。
- パッケージ: `npx vsce package` → `code --install-extension *.vsix`。

## アーキテクチャ（依存順）
- `src/git.ts` — git CLI ラッパ。**必ず `execFile`（シェル非経由）**。
  - `diffNameStatus(base,cwd)`: 比較は `git diff --name-status -z <merge-base>`（コミット済み＋未コミット）＋ `git ls-files --others`（未追跡を A 扱い）。NUL(`-z`)区切りでパース。
  - `showFileAtBase` / `mergeBase` / `worktreeList`(porcelain) / `listBranches`。
  - `viewHash` / `viewHashes`(バッチ): ハッシュ＝`<base blob oid>:<作業ツリー blob oid>`。`ls-tree`＋`hash-object` を各1プロセスにまとめる。
  - `assertSafeRef`: base/revision を単独引数で渡す前に検証（空・`-`始まり・制御文字を拒否）。
- `src/diffTree.ts` — `TreeDataProvider`。トップ=worktree、配下に dir/file ノード。
  - `list`/`tree` 表示モード。tree は単一子フォルダを `compactDir` で畳む。
  - viewed チェックボックス。フォルダは配下全 viewed で checked（`manageCheckboxStateManually:true` で自前管理）。
  - worktree ごとの差分を `cache`（refresh 単位）。`refresh()`=cache破棄+git再取得、`softRefresh()`=再描画のみ（viewed/コメント変化用、ちらつき防止）。
  - ファイルアイコンは status 文字アイコン（`media/status/<a|m|d|r|c|t|u>.svg` を `iconPath` に。viewed は `-dim` グレー版）。
- `src/baseContentProvider.ts` — スキーム `ponpoko-review-base:` で `git show base:path` を供給。追加/欠落は空ドキュメント。
- `src/openDiff.ts` — `vscode.diff`。left=base仮想doc / **right=作業ツリーの実ファイル**。A は left 空、D は right 空、R は旧パス参照。
- `src/comments.ts` — Comments API。`CommentStore` がスレッド保持＋**workspaceState 永続化**（`restore`/`persist`）。`countFor`(💬件数)。
- `src/viewed.ts` — `ViewedStore`（workspaceState）。値＝チェック時の viewHash。
- `src/worktreeBase.ts` — worktree ごとの比較先(base)上書き（workspaceState）。
- `src/markdown.ts` — `writeReview`。`combined:true`=全worktreeを1ファイル `<outputRoot>/review.md`(上部Submit)、`false`=worktree毎 `<outputRoot>/<worktree名>/review.md`(worktree行Submit)。見出し `path:line (base...HEAD)`、複数行選択は `path:開始-終了`。
- `src/extension.ts` — activate / コマンド登録 / 結線。保存リフレッシュは 300ms デバウンス。

## 守るべき不変条件（罠）
1. **コメントは必ず right(=file スキームの作業ファイル uri)に付ける**。`commentingRangeProvider` が file スキームだけ許可して担保。left に付けると行番号が base 基準でズレる。
2. ツリーの一覧は `base...HEAD`「表記」だが実体は **merge-base → 作業ツリー**（未コミット・未追跡込み）。diff ビューの右=作業ファイルと一致させている。
3. name-status の D/A/R は base 側仮想doc供給時に分岐（空ドキュメント）しないと `git show` が失敗する。
4. git に渡す revision は `assertSafeRef` を通す。パスは `--` 区切り or `base:path` 一括にしてオプション誤認を避ける。

## 命名規約（厳守）
- package name: `ponpoko-review` / displayName・表示文字列: `ponpoko-review`
- **内部ID は変えない**: コマンド prefix `ponpokoReview`、view ID `ponpokoReview.diffTree`、設定セクション `ponpokoReview`、スキーム `ponpoko-review-base`。
- 出力: `<outputDir>/<worktree名>/review.md`（`outputDir` 既定 `.ponpoko-review`、`.gitignore` 済み）。

## 設定
- `ponpokoReview.baseBranch`（既定 `main`）= 既定の比較先。worktree 個別は `worktreeBase` で上書き（★表示）。
- `ponpokoReview.outputDir`（既定 `.ponpoko-review`）。相対=ルート基準・絶対可。

## セキュリティ
- `execFile` のみ（シェル注入なし）。`assertSafeRef` で引数注入対策。
- `package.json` の `capabilities.untrustedWorkspaces:false`（未信頼ワークスペースでは無効）。

## ブランチ運用
- 足場は `main`、機能実装は feature ブランチ（例 `feature/diff-tree`）。
  この feature ブランチ自体が `main...feature` の差分になり、**自作拡張で自分自身をレビューする**ドッグフーディング素材になる。

## コミット
- 日本語の簡潔な要約。末尾に `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。
