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
3. diff の行にインラインコメント（修正指示）を付ける。
   - コメントは必ず右（HEAD 側＝作業ファイル）に付く。行番号がズレない。
4. Submit（✓）で `.ponpoko-review/<worktree名>/review.md` に書き出す。
5. その md を `claude -p` に渡し、修正は Claude Code に任せる。

> 起動は `F5`（Extension Development Host）。常用するなら `vsce package` → `code --install-extension *.vsix`。

---

## 機能

### worktree 単位の差分ツリー
- トップ階層が worktree。配下にそのworktreeの差分ファイルがぶら下がる。
- 各 worktree に `current: <ブランチ> → target: <base>` を表示し、何と何を比較しているかが分かる。
- 比較はマージベース → 作業ツリー。コミット済みに加え、**未コミットの編集・削除・未追跡ファイル**も出る。

### リスト / ツリー表示の切替
- **list**: フラットにフルパス一覧。
- **tree**: フォルダ階層でまとめる。`src/handlers` のような一本道は畳んで表示。

### "Viewed" チェック（GitHub PR 相当）
- ファイルをチェックすると「表示済み」として淡色化。
- **チェックした時点から中身が変わると自動でチェックが外れる**。
- フォルダは配下が全てチェックされると自動でチェック。フォルダをチェックすれば配下を一括チェック。

### コメントマーカー
- コメントを付けたファイルには `💬件数` を表示。

### 出力
- worktree 単位で `.ponpoko-review/<worktree名>/review.md` に分割出力。
- 見出しは `path:line (base...HEAD)` 形式。
- ツリー上部の Submit/Clear は全体、各 worktree 行のアイコンはその worktree だけを Submit/Clear。

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

## web/components/StockList.tsx:15 (main...HEAD)
ローディング状態のハンドリングを追加。
```

---

## 安全まわり

- git はすべてシェルを介さず実行（`execFile`）。コマンドインジェクションを避ける。
- ブランチ/リビジョン指定は `-` 始まりや制御文字を弾くバリデーション付き。
- 未信頼ワークスペースでは動かない（`untrustedWorkspaces: false`）。

---

## 思想

- 拡張は配管だけ。コメント収集 → md 整形 → 書き出し。修正の知能は持たない。
- コメントの永続化はしない。md 書き出しを「セーブ」と割り切る（再起動で消えても気にしない）。
- worktree が一級概念。並行開発でもコメントも出力も混ざらない。

---

個人用ツールなので、表示名やアイコンで遊んでいるのは仕様。
