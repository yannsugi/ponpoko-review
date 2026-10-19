# CLAUDE.md

VS Code 拡張 `ponpoko-review` のリポジトリ。Claude Code 向けの作業メモ。

## これは何
ブランチ間 diff を worktree 単位のツリーで表示し、diff 行に PR レビュー風インラインコメント（＝修正指示）を溜め、
worktree 単位で Markdown(`review.md`)に書き出す**個人用**拡張。修正自体はやらない（出力 md を `claude -p` に渡す前提）。
拡張の責務は「配管」だけ＝コメント収集 → md 整形 → 書き出し。**修正ロジックは絶対に持たせない**。

## ビルド / 実行
- `npm ci`（再現性。devDependencies は exact 固定・runtime依存は無し）/ 追加時は `npm install --save-exact`
- `npm run compile`（`tsc -p ./` → `out/`）/ `npm run watch`
- デバッグ起動: VS Code で `F5`（Extension Development Host）。`.vscode/launch.json` 済み。
- `npm test`（`node --test`、`test/*.test.js`）で純粋関数をテスト。`vscode` は `test/vscode-stub.cjs` で差し替え。VS Code API 依存部分は F5 ＋ `docs/SMOKE_TEST.md` で手確認。
- パッケージ: `npx vsce package` → `code --install-extension *.vsix`。

## アーキテクチャ（依存順）
- `src/git.ts` — git CLI ラッパ。**必ず `execFile`（シェル非経由）**。
  - `diffNameStatus(base,cwd)`: 比較は `git diff --name-status -z <merge-base>`（コミット済み＋未コミット）＋ `git ls-files --others`（未追跡を A 扱い）。NUL(`-z`)区切りでパース。
  - `showFileAtBase` / `mergeBase` / `worktreeList`(porcelain) / `listBranches`。
  - `viewHash` / `viewHashes`(バッチ): ハッシュ＝`<base blob oid>:<作業ツリー blob oid>`。`ls-tree`＋`hash-object` を各1プロセスにまとめる。
  - `assertSafeRef`: base/revision を単独引数で渡す前に検証（空・`-`始まり・制御文字を拒否）。
- `src/diffTree.ts` — `TreeDataProvider`。トップ=worktree、配下に dir/file ノード。
  - `list`/`tree` 表示モード。tree は単一子フォルダを `compactDir` で畳む。`commentsOnly` / `hideViewed` / `markedOnly` / `hideEmptyWorktrees` フィルタ（list/tree と直交、いずれもセッション限り）。`hideEmptyWorktrees` はルート分岐で全 worktree の `entriesFor` を先に解決し `isEmptyWorktree`（生の差分 0 件かつコメント無し。ignore 適用前・取得失敗 null は隠さない）で落とす。
  - ファイルの子＝コメント(CommentNode)。フォルダ/worktree に 💬 集計、差分なしは MessageNode。
  - 差分に無いがコメントの付いたファイルは `visibleEntries` → `commentedExtras` で `status:'none'` の `TreeEntry` として合流（コメントが付いたときだけ出る。viewed チェック無し、クリックは `openDiff` が実ファイルを開く）。`cache`/`filesUnder`/進捗は差分(DiffEntry)のみで数える。入れ子 worktree は `owningWorktreePath`（最長一致）で親に出さない。
  - viewed チェックボックス。フォルダは配下全 viewed で checked（`manageCheckboxStateManually:true` で自前管理）。
  - TreeItem に安定 `id`（`wt:`/`dir:`/`file:` 接頭辞）＋ `getParent` を実装しているので `treeView.reveal` が使える（undo 後の表示）。ノードは都度生成されるため id での同一視が必須。
  - worktree ごとの差分を `cache`（refresh 単位）。`refresh()`=cache破棄+git再取得、`softRefresh()`=再描画のみ（viewed/コメント変化用、ちらつき防止）。
  - ファイルアイコンは status の diff コーディコン（`STATUS_CODICON`: A=diff-added/M=diff-modified/D=diff-removed/R=diff-renamed＋git色。viewed は `disabledForeground` グレー）。画像SVGは行描画が重いので ThemeIcon に変更（旧 `media/status/*.svg` は削除済み。必要なら git 履歴 `faa90e4` から復帰）。
- `src/paths.ts` — パス判定の純粋関数（依存なし・テスト有）。`isUnder(dir, p, {excludeSelf?})`（配下判定。既定は dir 自身を含む、diffTree の `isUnderDir` は excludeSelf 版の薄いラッパ）、`owningWorktree`/`owningWorktreePath`（最長一致の worktree、入れ子対応）、`resolveOutputRoot(repoRoot, setting)`＋設定読込版 `configuredOutputRoot`。markdown / comments / diffTree / extension はこれを使う（各所で再実装しない）。
- `src/baseContentProvider.ts` — スキーム `ponpoko-review-base:` で `git show base:path` を供給。追加/欠落は空ドキュメント。
- `src/openDiff.ts` — `vscode.diff`。left=**merge-base**仮想doc / **right=作業ツリーの実ファイル**。A は left 空、D は right 空、R は旧パス参照。base先端だと main 進行時に嘘の差分になるため merge-base を供給。
- `src/comments.ts` — Comments API。`CommentStore` がスレッド保持＋**workspaceState 永続化**（`restore`/`persist`）。`countFor`(💬件数)。コメント入力欄に prefix ボタン `[ask][nits][must][memo]`（`addComment.<prefix>` コマンド、submit 亜種。Comments API は入力欄へのテキスト挿入不可のため）。prefix は本文先頭のただのテキストで md 出力にそのまま乗る（構造化しない）。
  - **ファイル全体へのコメント** = `range` 無しスレッド（`SavedThread.line` 省略で永続化、`reanchor` 対象外）。`provideCommentingRanges` は `{ranges, enableFileComments:true}` を返す（VS Code 1.97+）。`addFileComment(uri,text)` はエクスプローラー/エディタタイトル/ツリー右クリックの入口用。`threadLineRange` は range 無しで `undefined`、`listFor` はファイルコメントを先頭に並べる。`filesWithComments(dir)` で差分外ファイルをツリーに合流させる。
- `src/viewed.ts` — `ViewedStore`（workspaceState）。値＝チェック時の viewHash。`ViewedUndoStack`＝直前のチェック操作の取り消し（メモリ上・上限5・イベント単位のスナップショット。undo は保存ハッシュを書き戻すだけで git を叩かない。差分変更による自動解除は積まない）。
- `src/worktreeBase.ts` — worktree ごとの比較先(base)上書き（workspaceState）。
- `src/ignore.ts` — 「無視」パターンストア（workspaceState）＋ `makeIgnoreMatcher`(zero-dep glob→RegExp)。VS Code 検索の除外欄と同記法（スラッシュ無し=全階層ファイル名、`**`/`*`/`?`）。`/.../` 囲みは正規表現（glob と混在可、`splitIgnorePatterns` が `/.../` 内のカンマを保護、`validateIgnorePatterns` で入力時検証）。`visibleEntries` で適用（ツリー表示のみ。コメント/出力には不干渉）。
- `src/marks.ts` — 📌 マーク。実体は `<outputDir>/marks.txt`（1行1パス・絶対推奨・相対はワークスペースルート基準・`#`コメント・空行無視）。**外部エージェントが追記するだけで効くファイル契約**（README に明記）。`MarkStore` が起動時読込＋`FileSystemWatcher`、トグルは tmp→rename の原子的置換で該当行の追記/削除のみ（コメント行保持）。自己書き込みは内容 sha1 一致で無視。`parseMarks`/`addMarkLines`/`removeMarkLines` は純粋関数（テスト有）。**viewed とは独立**（ハッシュ検証・自動解除と連動しない）。`markedOnly` フィルタは他フィルタと直交、コメント/出力に不干渉。contextValue は `ponpoko.file` / `ponpoko.file.marked`（dir も同様）で inline トグルを切替。
- `src/markdown.ts` — `writeReview`。`combined:true`=全worktreeを1ファイル `<outputRoot>/review.md`(上部Submit)、`false`=worktree毎 `<outputRoot>/<worktree名>/review.md`(worktree行Submit)。見出し `path:line (base...HEAD)`、複数行選択は `path:開始-終了`、ファイル全体は `path` のみ（行番号・フェンス無し、同一ファイル内で先頭）。対象行のコードを ```言語 フェンスで添付。Resolve済みは出力から除外。書き出しは `review.md`(最新・固定パス、openReview/claude -p 用)＋`review-<timestamp>.md`(履歴)の二本立て。履歴は溜まる一方（掃除は将来の課題）。
- `src/extension.ts` — activate / コマンド登録 / 結線。保存リフレッシュは 300ms デバウンス。ファイル/フォルダ行の右クリック（`view/item/context` 非 inline）: `openFile`（D は base 側仮想doc）/ `copyRelativePath`（worktree ルート基準）/ `copyFullPath`。`resourceUri` は付けない（付けると status コーディコンがファイル種別アイコンに置き換わる）。

## 守るべき不変条件（罠）
1. **コメントは必ず right(=file スキームの作業ファイル uri)に付ける**。`commentingRangeProvider` が file スキームだけ許可して担保。left に付けると行番号が base 基準でズレる。
2. ツリーの一覧は `base...HEAD`「表記」だが実体は **merge-base → 作業ツリー**（未コミット・未追跡込み）。diff ビューの右=作業ファイルと一致させている。
3. name-status の D/A/R は base 側仮想doc供給時に分岐（空ドキュメント）しないと `git show` が失敗する。
4. git に渡す revision は `assertSafeRef` を通す。パスは `--` 区切り or `base:path` 一括にしてオプション誤認を避ける。

## 命名規約（厳守）
- package name: `ponpoko-review` / displayName・表示文字列: `ponpoko-review`
- **内部ID は変えない**: コマンド prefix `ponpokoReview`、view ID `ponpokoReview.diffTree`、設定セクション `ponpokoReview`、スキーム `ponpoko-review-base`。
- 出力: `<outputDir>/<worktree名>/review.md`、マーク: `<outputDir>/marks.txt`（`outputDir` 既定 `.ponpoko-review`、`.gitignore` 済み）。

## 設定
- `ponpokoReview.baseBranch`（既定 `main`）= 既定の比較先。worktree 個別は `worktreeBase` で上書き（★表示）。
- `ponpokoReview.outputDir`（既定 `.ponpoko-review`）。相対=ルート基準・絶対可。
- `ponpokoReview.afterSubmit`（`clear`/`resolve`/`none`、既定 `clear`）= Submit 後に出力済みコメントを削除 / Resolve / 何もしない。
- multi-root ワークスペースは非対応（`workspaceFolders[0]` 固定。worktree 探索・outputDir の基準はそのフォルダ）。

## セキュリティ
- `execFile` のみ（シェル注入なし）。`assertSafeRef` で引数注入対策。
- `package.json` の `capabilities.untrustedWorkspaces:false`（未信頼ワークスペースでは無効）。
- runtime の `dependencies` ゼロ（攻撃面はビルド時のみ）。devDependencies は exact 固定＋lock 同梱で `npm ci` 再現。`@types/vscode` は engines 最小(1.97.0)に一致させ、新しすぎる API の誤用を型で検出。

## ブランチ運用
- 足場は `main`、機能実装は feature ブランチ（例 `feature/diff-tree`）。
  この feature ブランチ自体が `main...feature` の差分になり、**自作拡張で自分自身をレビューする**ドッグフーディング素材になる。

## コミット
- 日本語の簡潔な要約。末尾に `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。
