# 🦝 ponpoko-review

ブランチ間の差分をツリー表示し、気になる行に PR レビュー風のインラインコメント（＝修正指示）を溜め、
**worktree 単位で Markdown に書き出す**個人用 VS Code 拡張。

修正そのものはやらない。出力した md を `claude -p` に渡して直しは丸投げする設計で、
拡張の責務は「配管」だけ（コメント収集 → md 整形 → 書き出し）。

---

## これは何

GitHub の PR レビュー体験（インラインコメントを溜めて Submit）を、**PR にする前のローカル状態**に持ち込む拡張。
**worktree が一級概念**で、並行 worktree 開発でもツリーも出力も worktree ごとに分かれる。

```
🦝 ponpoko-review（アクティビティバー）
└─ ponpoko-review        current: feature/diff-tree → target: main
   ├─ 📁 src
   │   ├─ A  extension.ts      💬2
   │   └─ M  git.ts
   └─ A  README.md
```

---

## 使い方

1. アクティビティバーの 🦝 を開くと、worktree ごとに差分ツリーが出る。
2. ファイルをクリック → `base` 側 vs 作業ツリーの diff が開く。
3. diff の行（複数行選択も可）にインラインコメント（修正指示）を付ける。
   - コメントは必ず右（HEAD 側＝作業ファイル）に付く。行番号がズレない。
   - 後から ✎編集 / 🗑削除 / Resolve できる。
4. Submit（✓）で `review.md` に書き出し、**自動でそのファイルが開く**。
5. その md を `claude -p` に渡し、修正は Claude Code に任せる。

## インストール

```sh
npm install
npm run compile
npx vsce package                              # → ponpoko-review-x.y.z.vsix
code --install-extension ponpoko-review-*.vsix
```

開発中は `F5`（Extension Development Host）で起動。

---

## 機能

### worktree 単位の差分ツリー
- トップ階層が worktree。配下にそのworktreeの差分ファイルがぶら下がる。
- 各 worktree に `current: <ブランチ> → target: <base>` を表示し、何と何を比較しているかが分かる。
- 比較はマージベース → 作業ツリー。コミット済みに加え、**未コミットの編集・削除・未追跡ファイル**も出る。

- ファイルの状態は色付きの文字アイコン（`A`/`M`/`D`/`R`）で表示。

### リスト / ツリー表示の切替
- ツールバーのボタン1つで **list ⇄ tree を順次切り替え**。
- **list**: フラットにフルパス一覧。
- **tree**: フォルダ階層でまとめる。`src/handlers` のような一本道は畳んで表示。

### "Viewed" チェック（GitHub PR 相当）
- ファイルをチェックすると「表示済み」として淡色化。
- **チェックした時点から中身が変わると自動でチェックが外れる**。
- フォルダは配下が全てチェックされると自動でチェック。フォルダをチェックすれば配下を一括チェック。

### コメント
- コメントを付けたファイルに `💬件数`、フォルダ/worktree には配下合計の `💬N` を表示。
- ファイルを展開すると**コメント本文が子ノード**で並び、クリックで該当行へジャンプ。
- 個別に **✎編集 / 🗑削除 / Resolve** が可能。
- ツールバーで切り替え:
  - **コメントマーク**: ファイル配下のコメント子ノードの展開 ON/OFF（💬 自体は常時表示）。
  - **絞り込み($(filter))**: コメントのあるファイルだけに絞る。
- **クイックアクセス**: ステータスバーの未提出コメント数をクリック、またはコマンド「コメントへ移動」で、全コメントを一覧 → 選んでジャンプ。

### 出力
- **上部の Submit**: 全 worktree を**1ファイルにまとめて** `.ponpoko-review/review.md` に出力。
- **各 worktree 行の Submit**: その worktree だけを `.ponpoko-review/<worktree名>/review.md` に出力。
- 見出しは `path:line (base...HEAD)` 形式（複数行選択は `path:開始-終了`）。
- Clear も同様に、上部は全体、worktree 行はその worktree だけ。

### worktree ごとの比較先
- worktree 行の 🌿 アイコンから、その worktree だけ別ブランチと比較できる。
- 個別設定中は `★` が付く。「グローバルに従う」で解除。

---

## 設定（ツリー上部の歯車から）

| 設定キー | 既定 | 説明 |
|---|---|---|
| `ponpokoReview.baseBranch` | `main` | 既定の比較先（target）ブランチ |
| `ponpokoReview.outputDir` | `.ponpoko-review` | レビュー md の出力先（相対はルート基準・絶対パス可） |

歯車から「出力先ディレクトリ」「既定の比較先」をその場で設定できる。
比較先まわりは上部に出さず、worktree ごとの設定に寄せている。

---

## 出力される review.md の例

```markdown
# Review Instructions (feature-diff-tree)

## src/handlers/user_handler.rs:42 (main...HEAD)
Service層を経由するように。Handlerから直接Repositoryを叩かないこと。

## web/components/StockList.tsx:15-23 (main...HEAD)
このブロックのローディング状態のハンドリングを追加。
```

（`:15-23` のように複数行選択のコメントは範囲で出る）

---

## 安全まわり

- git はすべてシェルを介さず実行（`execFile`）。コマンドインジェクションを避ける。
- ブランチ/リビジョン指定は `-` 始まりや制御文字を弾くバリデーション付き。
- 未信頼ワークスペースでは動かない（`untrustedWorkspaces: false`）。

---

## 開発 / テスト

- `npm run compile` … TypeScript ビルド（`out/`）。
- `npm test` … 純粋関数のユニットテスト（`node:test`。git パース / ツリー構築 / 見出し整形など）。
- `npx vsce package` … vsix 化。
- 実機の通し確認は [docs/SMOKE_TEST.md](docs/SMOKE_TEST.md) のチェックリストで。

---

## 思想

- 拡張は配管だけ。コメント収集 → md 整形 → 書き出し。修正の知能は持たない。
- コメント・Viewed・worktree別比較先は workspaceState にローカル永続化され、再起動しても残る。
- worktree が一級概念。並行開発でもコメントも出力も混ざらない。
