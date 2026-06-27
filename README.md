# 🦝 ponpoko-review

> ブランチ間の差分を木の上から見下ろして、気になる行に化けコメントをペタペタ貼り、
> まとめて Markdown に化かして出す——そんな個人用レビュー拡張だぽん。

葉っぱ（コメント）を集めて `review.md` に変化（へんげ）させるところまでが仕事。
**実際の修正はやらない**ぽん。出てきた md を `claude -p` に丸投げして直してもらう運用だぽん。
拡張はあくまで「配管」。修正の知能は持たせない（Claude Code の劣化版になるからね）。

---

## 🌰 これは何をするタヌキ？

GitHub の PR レビュー体験（インラインコメントを溜めて Submit）を、
**PR にする前のローカル状態**に持ち込むのが狙いだぽん。
しかも **worktree が一級市民**。並行 worktree 開発でも、ツリーも出力も worktree ごとに分かれるぽん。

```
🦝 ponpoko-review（アクティビティバー）
└─ ponpoko-review        current: feature/diff-tree → target: main
   ├─ 📁 src
   │   ├─ A  extension.ts      💬2
   │   └─ M  git.ts
   └─ A  README.md
```

---

## 🍃 使い方（葉っぱを集める流れ）

1. アクティビティバーの 🦝 を開くと、worktree ごとに差分ツリーが化けて出るぽん。
2. ファイルをクリック → `base` 側 vs 作業ツリーの **diff** が開くぽん。
3. diff の行に **インラインコメント**（＝修正指示）をペタッと貼るぽん。
   - コメントは必ず **右（HEAD側＝作業ファイル）** に付く。行番号がズレない化け方だぽん。
4. **Submit**（✓）で `.ponpoko-review/<worktree名>/review.md` に化けて出るぽん。
5. その md を `claude -p` 的に渡して、直しは Claude Code に丸投げだぽん。

> 起動: `F5`（Extension Development Host）。常用するなら `vsce package` → `code --install-extension *.vsix` で住み着かせるぽん。

---

## 🦝 できること（化けの種いろいろ）

### 🌲 worktree 単位の差分ツリー
- トップ階層が **worktree**。配下にそのworktreeの差分ファイルがぶら下がるぽん。
- 各 worktree に **`current: <ブランチ> → target: <base>`** を表示。何と何を比べてるか一目だぽん。
- 比較は **マージベース → 作業ツリー**。コミット済みだけでなく、**未コミットの編集・削除・未追跡ファイル**まで出るぽん。

### 🗂️ リスト / ツリー表示の切替
- **list**: フラットにフルパス一覧。
- **tree**: フォルダ階層でまとめる。`src/handlers` みたいな一本道は畳んで表示するぽん。

### ✅ "Viewed" チェック（GitHub PR と同じやつ）
- ファイルを **チェック＝表示済み**。淡くなって視界からそっと消えるぽん。
- **チェックした時点から中身が変わると自動でチェックが外れる**（化けがバレる仕組み）。
- フォルダは **配下が全部チェックされると自動でチェック**。フォルダをチェックすれば配下も一括チェックだぽん。

### 💬 コメントマーカー
- コメントを貼ったファイルには **`💬件数`** が付く。「今どこに化けコメ貼ったか」が一目だぽん。

### 📤 出力（葉っぱ → 小判）
- **worktree 単位**で `.ponpoko-review/<worktree名>/review.md` に分割出力。
- 見出しは `path:line (base...HEAD)` 形式。
- ツリー上部の Submit/Clear は全体、**各 worktree 行のアイコン**はその worktree だけを Submit/Clear できるぽん。

### 🎯 worktree ごとの比較先
- worktree 行の 🌿 アイコンから、**その worktree だけ別ブランチと比較**できるぽん。
- 個別設定中は **★** が付く。「グローバルに従う」で解除だぽん。

---

## ⚙️ 設定（ツリー上部の歯車から）

| 設定キー | 既定 | 説明 |
|---|---|---|
| `ponpokoReview.baseBranch` | `main` | 既定の比較先（target）ブランチ |
| `ponpokoReview.outputDir` | `.ponpoko-review` | レビュー md の出力先（相対はルート基準・絶対パス可） |

歯車アイコンから「出力先ディレクトリ」「既定の比較先」をその場で設定できるぽん。
比較先まわりは上部に出さず、**worktree ごとの設定**に寄せてあるぽん。

---

## 📝 出力される review.md の例

```markdown
# Review Instructions (feature-diff-tree)

## src/handlers/user_handler.rs:42 (main...HEAD)
Service層を経由するように。Handlerから直接Repositoryを叩かないこと。

## web/components/StockList.tsx:15 (main...HEAD)
ローディング状態のハンドリングを追加。
```

---

## 🛡️ 安全まわり

- git はすべて **シェルを介さず** 実行（`execFile`）。コマンドインジェクションはしないぽん。
- ブランチ/リビジョン指定は **`-` 始まりや制御文字を弾く**バリデーション付き。
- **未信頼ワークスペースでは動かない**（`untrustedWorkspaces: false`）。知らない repo で勝手に git を走らせないぽん。

---

## 🦝 思想（化かしの掟）

- 拡張は **配管だけ**。コメント収集 → md整形 → 書き出し。修正の知能は持たない。
- コメントの永続化はしない。**md 書き出しを「セーブ」**と割り切るぽん（再起動で消えても気にしない）。
- worktree が一級概念。並行開発でもコメントも出力も混ざらないぽん。

---

ぽんぽこ🍃 個人用ツールなので、表示名で遊んでいるのは仕様だぽん。
