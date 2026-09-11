import * as vscode from 'vscode';
import * as path from 'path';
import { listBranches, mergeBase, viewHash, viewHashes, worktreeList, Worktree } from './git';
import { DiffNode, DiffTreeProvider, WorktreeNode, worktreeName } from './diffTree';
import { BASE_SCHEME, BaseContentProvider, makeBaseUri } from './baseContentProvider';
import { openDiff } from './openDiff';
import { CommentStore, threadLineRange, threadText } from './comments';
import { writeReview } from './markdown';
import { ViewedSnapshot, ViewedStore, ViewedUndoEntry, ViewedUndoStack } from './viewed';
import { WorktreeBaseStore } from './worktreeBase';
import { IgnoreStore, validateIgnorePatterns } from './ignore';

export function activate(context: vscode.ExtensionContext): void {
  const repoRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!repoRoot) {
    vscode.window.showWarningMessage('ponpoko-review: ワークスペースが開かれていません。');
    return;
  }

  // 出力先（相対はワークスペースルート基準、絶対パスも可）。
  const resolveOutputRoot = (): string => {
    const setting = vscode.workspace
      .getConfiguration('ponpokoReview')
      .get<string>('outputDir', '.ponpoko-review');
    return path.isAbsolute(setting) ? setting : path.join(repoRoot, setting);
  };

  // コメント群を md に書き出す共通処理。
  const runSubmit = async (
    threads: vscode.CommentThread[],
    worktrees: Worktree[],
    emptyLabel: string,
    combined: boolean,
  ): Promise<void> => {
    // Resolve 済みは「対応済み」として出力から除外する。
    const resolved = threads.filter(
      (t) => t.state === vscode.CommentThreadState.Resolved,
    ).length;
    const active = threads.filter(
      (t) => t.state !== vscode.CommentThreadState.Resolved,
    );
    if (active.length === 0) {
      vscode.window.showWarningMessage(
        `ponpoko-review: ${emptyLabel}出力するコメントがありません` +
          (resolved > 0 ? `（Resolve済み ${resolved} 件は除外）` : '') +
          '。',
      );
      return;
    }
    try {
      const result = await writeReview({
        outputRoot: resolveOutputRoot(),
        resolveBase: (wtPath) => treeProvider.getBase(wtPath),
        threads: active,
        worktrees,
        combined,
      });
      // 書き出した md を自動で開いて表示する。
      if (result.files.length > 0) {
        const doc = await vscode.workspace.openTextDocument(result.files[0]);
        await vscode.window.showTextDocument(doc, { preview: false });
      }
      const where = result.files
        .map((f) => path.relative(repoRoot, f) || f)
        .join(', ');
      const head =
        `ponpoko-review: ${result.itemCount} 件を ${where} に書き出しました` +
        (resolved > 0 ? `（Resolve済み ${resolved} 件は除外）` : '');
      // 出力後の扱いは設定 afterSubmit に従う（既定 resolve）。
      const after = vscode.workspace
        .getConfiguration('ponpokoReview')
        .get<string>('afterSubmit', 'clear');
      let suffix = '';
      if (after === 'clear') {
        store.removeThreads(active);
        onCommentsChanged();
        suffix = '（出力分を削除）';
      } else if (after !== 'none') {
        store.resolveThreads(active);
        onCommentsChanged();
        suffix = '（出力分を Resolve）';
      }
      vscode.window.showInformationMessage(`${head}${suffix}。`);
    } catch (err) {
      vscode.window.showErrorMessage(
        `ponpoko-review: 書き出しに失敗: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  // base 側仮想ドキュメントのプロバイダ
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      BASE_SCHEME,
      new BaseContentProvider(),
    ),
  );

  // コメント保持（workspaceState にローカル永続化。再起動で復元）。
  const store = new CommentStore(context.workspaceState);
  context.subscriptions.push(store);

  // "Viewed" 永続化ストア
  const viewed = new ViewedStore(context.workspaceState);
  // worktree ごとの比較先(base)上書きストア
  const baseStore = new WorktreeBaseStore(context.workspaceState);
  // 「無視」glob ストア（ノイズ非表示）
  const ignoreStore = new IgnoreStore(context.workspaceState);

  // 差分ツリー
  const treeProvider = new DiffTreeProvider(
    repoRoot,
    viewed,
    baseStore,
    (fsPath) => store.listFor(fsPath),
    (dirPath) => store.countUnder(dirPath),
    context.extensionUri,
    ignoreStore,
  );

  // ステータスバー: 未提出コメント数。クリックでコメント一覧へ。
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusBar.command = 'ponpokoReview.gotoComment';
  context.subscriptions.push(statusBar);
  const updateStatusBar = () => {
    const n = store.activeCount(); // 出力対象（未解決）の件数
    if (n > 0) {
      statusBar.text = `$(comment) ${n}`;
      statusBar.tooltip = `ponpoko-review: 未提出のコメント ${n} 件`;
      statusBar.show();
    } else {
      statusBar.hide();
    }
  };
  updateStatusBar();
  // コメント増減のたびにツリー＋ステータスバーを更新する共通処理。
  const onCommentsChanged = () => {
    treeProvider.softRefresh();
    updateStatusBar();
  };

  // 復元したコメントの行ズレを、保存したアンカー行で追従させる（起動後に一度）。
  void store.reanchor().then(onCommentsChanged);

  // コメント位置へ移動（diff を開いて該当行を表示）。
  const revealComment = async (uri: vscode.Uri, line: number): Promise<void> => {
    const node = await treeProvider.resolveFileNode(uri);
    if (node) {
      await openDiff(treeProvider.getBase(node.worktree.path), node);
    } else {
      await vscode.window.showTextDocument(uri);
    }
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const pos = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  };
  const treeView = vscode.window.createTreeView('ponpokoReview.diffTree', {
    treeDataProvider: treeProvider,
    // フォルダ↔ファイルの伝播は viewed ストアを正として自前で管理する。
    manageCheckboxStateManually: true,
  });
  context.subscriptions.push(treeView);

  // 表示モード（list/tree）切替。メニューの when 句用に context key を同期。
  const syncViewMode = () =>
    vscode.commands.executeCommand('setContext', 'ponpokoReview.viewMode', treeProvider.getMode());
  const syncCommentsOnly = () =>
    vscode.commands.executeCommand(
      'setContext',
      'ponpokoReview.commentsOnly',
      treeProvider.getCommentsOnly(),
    );
  const syncHideViewed = () =>
    vscode.commands.executeCommand(
      'setContext',
      'ponpokoReview.hideViewed',
      treeProvider.getHideViewed(),
    );
  // 「無視」が有効か（ツールバーに解除ボタンを出す when 句用）。
  const syncIgnore = () =>
    vscode.commands.executeCommand(
      'setContext',
      'ponpokoReview.hasIgnore',
      treeProvider.getIgnore().length > 0,
    );
  syncViewMode();
  syncCommentsOnly();
  syncHideViewed();
  syncIgnore();
  context.subscriptions.push(
    // 無視 glob を編集（VS Code 検索の除外欄と同思想。カンマ/改行区切り）。
    vscode.commands.registerCommand('ponpokoReview.editIgnore', async () => {
      const value = await vscode.window.showInputBox({
        title: 'ponpoko-review: 無視するファイル（ノイズ非表示）',
        prompt:
          'glob をカンマ区切りで。スラッシュ無しは全階層のファイル名にマッチ（VS Code 検索の除外欄と同じ）。/.../ で囲むと正規表現（混在可）。空にすると解除。',
        placeHolder: '例: **/Cargo.toml, *.lock, /^dist\\//, /\\.(snap|lock)$/',
        value: treeProvider.getIgnore(),
        ignoreFocusOut: true,
        // 不正な正規表現は入力時に弾く（保存して落ちないように）。
        validateInput: (v) => validateIgnorePatterns(v),
      });
      if (value === undefined) {
        return; // Esc キャンセル
      }
      await treeProvider.setIgnore(value);
      syncIgnore();
    }),
    vscode.commands.registerCommand('ponpokoReview.clearIgnore', async () => {
      await treeProvider.setIgnore('');
      syncIgnore();
    }),
    vscode.commands.registerCommand('ponpokoReview.hideViewedOn', () => {
      treeProvider.setHideViewed(true);
      syncHideViewed();
    }),
    vscode.commands.registerCommand('ponpokoReview.hideViewedOff', () => {
      treeProvider.setHideViewed(false);
      syncHideViewed();
    }),
    vscode.commands.registerCommand('ponpokoReview.viewAsTree', () => {
      treeProvider.setMode('tree');
      syncViewMode();
    }),
    vscode.commands.registerCommand('ponpokoReview.viewAsList', () => {
      treeProvider.setMode('list');
      syncViewMode();
    }),
    // 順次切り替え: list → tree → list …
    vscode.commands.registerCommand('ponpokoReview.cycleViewMode', () => {
      treeProvider.setMode(treeProvider.getMode() === 'list' ? 'tree' : 'list');
      syncViewMode();
    }),
    vscode.commands.registerCommand('ponpokoReview.commentsFilterOn', () => {
      treeProvider.setCommentsOnly(true);
      syncCommentsOnly();
    }),
    vscode.commands.registerCommand('ponpokoReview.commentsFilterOff', () => {
      treeProvider.setCommentsOnly(false);
      syncCommentsOnly();
    }),
  );

  // 1ファイルを viewed にする（現在の差分ハッシュを記録）。
  const markViewed = async (worktree: { path: string }, filePath: string): Promise<void> => {
    const base = treeProvider.getBase(worktree.path);
    try {
      const hash = await viewHash(base, filePath, worktree.path);
      await viewed.setViewed(worktree.path, filePath, hash);
    } catch {
      // ハッシュ取得失敗時はマークしない。
    }
  };

  // 直前のチェック操作の取り消し（hideViewed 中の誤操作救済）。セッション限り・上限 5 件。
  const undoStack = new ViewedUndoStack(5);
  const undoEntry = async (entry: ViewedUndoEntry): Promise<void> => {
    // 保存していたハッシュをそのまま書き戻す（再ハッシュしないので git を叩かない）。
    await Promise.all(
      entry.snapshots.map((sn) =>
        sn.hash === undefined
          ? viewed.unsetViewed(sn.worktreePath, sn.file)
          : viewed.setViewed(sn.worktreePath, sn.file, sn.hash),
      ),
    );
    treeProvider.softRefresh();
    // どれだったか分かるように、戻したファイルをツリー上で見せる。
    const first = entry.snapshots[0];
    const node = treeProvider.fileNodeFor(first.worktreePath, first.file);
    if (node) {
      try {
        await treeView.reveal(node, { select: true, focus: false, expand: false });
      } catch {
        // フィルタ等で表示されていない場合は諦める。
      }
    }
    const n = entry.snapshots.length;
    vscode.window.showInformationMessage(
      `ponpoko-review: ${n === 1 ? first.file : `${n} 件`} の viewed 操作を元に戻しました。`,
    );
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('ponpokoReview.undoViewed', async () => {
      const entry = undoStack.pop();
      if (!entry) {
        vscode.window.showInformationMessage('ponpoko-review: 元に戻せる viewed 操作はありません。');
        return;
      }
      await undoEntry(entry);
    }),
  );

  // チェックボックス操作 → viewed の保存/解除。
  // フォルダをチェックすると配下ファイルを一括 viewed/解除（逆も getTreeItem 側で集計）。
  context.subscriptions.push(
    treeView.onDidChangeCheckboxState(async (e) => {
      // 適用前の状態をイベント単位でスナップショット（undo 用）。
      const snapshots: ViewedSnapshot[] = [];
      let checkedCount = 0;
      const snap = (wtPath: string, file: string) =>
        snapshots.push({ worktreePath: wtPath, file, hash: viewed.getHash(wtPath, file) });
      for (const [node, state] of e.items) {
        const checked = state === vscode.TreeItemCheckboxState.Checked;
        if (node.kind === 'file') {
          snap(node.worktree.path, node.entry.path);
          checkedCount += checked ? 1 : 0;
        } else if (node.kind === 'dir') {
          const files = treeProvider.filesUnder(node.worktree, node.relDir);
          files.forEach((f) => snap(node.worktree.path, f.path));
          checkedCount += checked ? files.length : 0;
        }
      }
      const entry: ViewedUndoEntry = { checkedCount, snapshots };
      undoStack.push(entry);

      for (const [node, state] of e.items) {
        const checked = state === vscode.TreeItemCheckboxState.Checked;
        if (node.kind === 'file') {
          if (checked) {
            await markViewed(node.worktree, node.entry.path);
          } else {
            await viewed.unsetViewed(node.worktree.path, node.entry.path);
          }
        } else if (node.kind === 'dir') {
          const files = treeProvider.filesUnder(node.worktree, node.relDir);
          if (checked) {
            // 配下ファイルのハッシュを一括算出してから viewed 登録（spawn を抑制）。
            const base = treeProvider.getBase(node.worktree.path);
            const hashes = await viewHashes(
              base,
              files.map((f) => f.path),
              node.worktree.path,
            );
            await Promise.all(
              files.map((f) =>
                viewed.setViewed(node.worktree.path, f.path, hashes.get(f.path) ?? 'none:missing'),
              ),
            );
          } else {
            await Promise.all(
              files.map((f) => viewed.unsetViewed(node.worktree.path, f.path)),
            );
          }
        }
      }
      treeProvider.softRefresh(); // viewed のみ変化 → git再取得せず再描画（ちらつき防止）

      // チェック方向だけトーストで「元に戻す」導線を出す（解除方向はファイルが消えないので不要）。
      // トーストはこの操作に紐付ける（後続の操作ではなく、この 1 件だけを戻す）。
      if (checkedCount > 0) {
        void vscode.window
          .showInformationMessage(`ponpoko-review: ${checkedCount} 件を viewed にしました`, '元に戻す')
          .then(async (choice) => {
            if (choice !== '元に戻す') {
              return;
            }
            const taken = undoStack.take(entry);
            if (taken) {
              await undoEntry(taken);
            }
          });
      }
    }),
  );

  // ファイル保存で差分が変わりうる → 該当 worktree だけ再取得（全worktree再diffを避ける）。
  // 連続保存はデバウンスし、保存パスを溜めてからまとめて無効化＋1回だけ再描画。
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const pendingSaves = new Set<string>();
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      pendingSaves.add(doc.uri.fsPath);
      if (saveTimer) {
        clearTimeout(saveTimer);
      }
      saveTimer = setTimeout(() => {
        let changed = false;
        for (const p of pendingSaves) {
          changed = treeProvider.invalidate(p) || changed;
        }
        pendingSaves.clear();
        if (changed) {
          treeProvider.softRefresh(); // 無効化した worktree だけ再取得、他はキャッシュ流用
        }
      }, 300);
    }),
    { dispose: () => saveTimer && clearTimeout(saveTimer) },
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ponpokoReview.refresh', () => {
      treeProvider.refresh();
    }),

    vscode.commands.registerCommand('ponpokoReview.openDiff', (node: DiffNode) => {
      if (node.kind !== 'file') {
        return;
      }
      return openDiff(treeProvider.getBase(node.worktree.path), node);
    }),

    // 右クリック: ファイルを開く（作業ツリーの実ファイル。既定クリックの diff は変えない）。
    // 削除(D)は右側の実ファイルが無いので base 側（merge-base）の仮想 doc を開く。
    vscode.commands.registerCommand('ponpokoReview.openFile', async (node: DiffNode) => {
      if (!node || node.kind !== 'file') {
        return;
      }
      const { worktree, entry } = node;
      let uri: vscode.Uri;
      if (entry.status === 'D') {
        const base = treeProvider.getBase(worktree.path);
        let ref = base;
        try {
          ref = await mergeBase(base, worktree.path);
        } catch {
          // merge-base が取れなければ base 先端。
        }
        uri = makeBaseUri(ref, worktree.path, entry.oldPath ?? entry.path);
      } else {
        uri = vscode.Uri.file(path.join(worktree.path, entry.path));
      }
      await vscode.window.showTextDocument(uri, { preview: false });
    }),

    // 右クリック: パスをコピー。相対は worktree ルート基準（ツリー表示と一致）。
    // D は作業ツリーに無いがパス文字列としてはそのまま返す。フォルダは relDir。
    vscode.commands.registerCommand('ponpokoReview.copyRelativePath', (node: DiffNode) => {
      const rel = nodeRelPath(node);
      if (rel !== undefined) {
        return vscode.env.clipboard.writeText(rel);
      }
    }),
    vscode.commands.registerCommand('ponpokoReview.copyFullPath', (node: DiffNode) => {
      const rel = nodeRelPath(node);
      if (rel !== undefined && (node.kind === 'file' || node.kind === 'dir')) {
        return vscode.env.clipboard.writeText(path.join(node.worktree.path, rel));
      }
    }),

    // コメントへクイックアクセス（QuickPick → diff を開いて該当行へ）。未解決のみ。
    vscode.commands.registerCommand('ponpokoReview.gotoComment', async () => {
      const threads = store
        .getThreads()
        .filter((t) => t.state !== vscode.CommentThreadState.Resolved);
      if (threads.length === 0) {
        vscode.window.showInformationMessage('ponpoko-review: コメントがありません。');
        return;
      }
      type Item = vscode.QuickPickItem & { uri: vscode.Uri; line: number };
      const items: Item[] = threads
        .map((t) => {
          const range = threadLineRange(t);
          const ref =
            range.end > range.start
              ? `${range.start + 1}-${range.end + 1}`
              : `${range.start + 1}`;
          return {
            label: `$(comment) ${vscode.workspace.asRelativePath(t.uri)}:${ref}`,
            description: threadText(t).split('\n')[0],
            uri: t.uri,
            line: range.start,
          };
        })
        .sort((a, b) => a.label.localeCompare(b.label));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'コメントへ移動',
        matchOnDescription: true,
      });
      if (!picked) {
        return;
      }
      await revealComment(picked.uri, picked.line);
    }),

    // ツリーのコメント子ノードクリック → 該当行へ。
    vscode.commands.registerCommand(
      'ponpokoReview.openComment',
      (arg: { uri: vscode.Uri; line: number }) => revealComment(arg.uri, arg.line),
    ),

    vscode.commands.registerCommand(
      'ponpokoReview.addComment',
      (reply: vscode.CommentReply) => {
        store.addComment(reply);
        onCommentsChanged();
      },
    ),

    // prefix 付きで追加（[ask]質問 / [nits]任意 / [must]必須 / [memo]メモ・AIへの補足）。
    // Comments API は入力欄へのテキスト挿入を許さないため、submit 亜種ボタンにする。
    // prefix はただの本文先頭テキスト（md 出力にそのまま乗る。構造化はしない）。
    ...(['ask', 'nits', 'must', 'memo'] as const).map((prefix) =>
      vscode.commands.registerCommand(
        `ponpokoReview.addComment.${prefix}`,
        (reply: vscode.CommentReply) => {
          store.addComment({ ...reply, text: `[${prefix}] ${reply.text}`.trim() });
          onCommentsChanged();
        },
      ),
    ),

    // 個別コメントの編集 / 保存 / キャンセル / 削除 / Resolve。
    vscode.commands.registerCommand('ponpokoReview.editComment', (c: vscode.Comment) =>
      store.editComment(c),
    ),
    vscode.commands.registerCommand('ponpokoReview.saveComment', (c: vscode.Comment) =>
      store.saveComment(c),
    ),
    vscode.commands.registerCommand('ponpokoReview.cancelComment', (c: vscode.Comment) =>
      store.cancelEdit(c),
    ),
    vscode.commands.registerCommand('ponpokoReview.deleteComment', (c: vscode.Comment) => {
      store.deleteComment(c);
      onCommentsChanged();
    }),
    vscode.commands.registerCommand(
      'ponpokoReview.toggleResolve',
      (thread: vscode.CommentThread) => {
        store.toggleResolve(thread);
        onCommentsChanged(); // 解決/未解決でツリー・件数を更新
      },
    ),

    vscode.commands.registerCommand('ponpokoReview.submit', async () => {
      const worktrees = await worktreeList(repoRoot);
      // 上部Submitは全worktreeを1ファイルにまとめて出力。
      await runSubmit(store.getThreads(), worktrees, '', true);
    }),

    vscode.commands.registerCommand('ponpokoReview.clear', async () => {
      const n = store.total();
      if (n === 0) {
        return;
      }
      const ok = await vscode.window.showWarningMessage(
        `コメント ${n} 件をすべて消去します。元に戻せません。`,
        { modal: true },
        '全消去',
      );
      if (ok !== '全消去') {
        return;
      }
      store.clear();
      onCommentsChanged();
    }),

    // worktree 単位: そのworktreeのコメントだけ書き出す。
    vscode.commands.registerCommand(
      'ponpokoReview.submitWorktree',
      async (node: WorktreeNode) => {
        if (!node || node.kind !== 'worktree') {
          return;
        }
        const wt = node.worktree;
        // worktree行のSubmitはそのworktreeだけを分割出力。
        await runSubmit(
          store.getThreadsUnder(wt.path),
          [wt],
          `${worktreeName(wt)} に `,
          false,
        );
      },
    ),

    // worktree 単位: そのworktreeのコメントだけクリア。
    vscode.commands.registerCommand(
      'ponpokoReview.clearWorktree',
      async (node: WorktreeNode) => {
        if (!node || node.kind !== 'worktree') {
          return;
        }
        const name = worktreeName(node.worktree);
        const count = store.getThreadsUnder(node.worktree.path).length;
        if (count === 0) {
          return;
        }
        const ok = await vscode.window.showWarningMessage(
          `${name} のコメント ${count} 件を消去します。元に戻せません。`,
          { modal: true },
          '消去',
        );
        if (ok !== '消去') {
          return;
        }
        store.clearUnder(node.worktree.path);
        onCommentsChanged();
      },
    ),

    // worktree 単位: 比較先(base/target)ブランチを個別設定/解除。
    vscode.commands.registerCommand(
      'ponpokoReview.setWorktreeBase',
      async (node: WorktreeNode) => {
        if (!node || node.kind !== 'worktree') {
          return;
        }
        const wt = node.worktree;
        let branches: string[] = [];
        try {
          branches = await listBranches(wt.path);
        } catch {
          // 取得失敗時はそのまま（候補なし）。
        }
        const GLOBAL = '$(globe) グローバル設定に従う（上書き解除）';
        const current = treeProvider.getBase(wt.path);
        const picked = await vscode.window.showQuickPick([GLOBAL, ...branches], {
          placeHolder: `${worktreeName(wt)} の比較先(target)を選択（現在: ${current}）`,
        });
        if (picked === undefined) {
          return;
        }
        if (picked === GLOBAL) {
          await baseStore.clear(wt.path);
        } else {
          await baseStore.set(wt.path, picked);
        }
        treeProvider.refresh();
      },
    ),

    vscode.commands.registerCommand('ponpokoReview.setBase', async () => {
      let branches: string[] = [];
      try {
        branches = await listBranches(repoRoot);
      } catch {
        // 取得失敗時は入力に委ねる。
      }
      const current = treeProvider.getBase();
      const picked = await vscode.window.showQuickPick(branches, {
        placeHolder: `比較基準ブランチを選択（現在: ${current}）`,
      });
      if (!picked) {
        return;
      }
      await vscode.workspace
        .getConfiguration('ponpokoReview')
        .update('baseBranch', picked, vscode.ConfigurationTarget.Workspace);
      treeProvider.refresh();
    }),

    // 出力先ディレクトリを設定（グローバル設定 ponpokoReview.outputDir）。
    vscode.commands.registerCommand('ponpokoReview.setOutputDir', async () => {
      const cfg = vscode.workspace.getConfiguration('ponpokoReview');
      const current = cfg.get<string>('outputDir', '.ponpoko-review');
      const value = await vscode.window.showInputBox({
        prompt: 'レビューmdの出力先ディレクトリ（相対=ワークスペースルート基準 / 絶対パス可）',
        value: current,
        valueSelection: [0, current.length],
      });
      if (value === undefined) {
        return;
      }
      await cfg.update('outputDir', value.trim(), vscode.ConfigurationTarget.Workspace);
      vscode.window.showInformationMessage(`ponpoko-review: 出力先を ${value.trim()} に設定しました。`);
    }),

    // 既存の review.md を開く（再 Submit せずに見たいとき用）。
    vscode.commands.registerCommand('ponpokoReview.openReview', async () => {
      const file = vscode.Uri.file(path.join(resolveOutputRoot(), 'review.md'));
      try {
        await vscode.workspace.fs.stat(file);
      } catch {
        vscode.window.showInformationMessage(
          'ponpoko-review: まだ review.md がありません。Submit で書き出してください。',
        );
        return;
      }
      const doc = await vscode.workspace.openTextDocument(file);
      await vscode.window.showTextDocument(doc, { preview: false });
    }),

    // 上部の設定メニュー（diffには出さないグローバル設定の入口）。
    vscode.commands.registerCommand('ponpokoReview.settings', async () => {
      const items: (vscode.QuickPickItem & { cmd: string })[] = [
        { label: '$(go-to-file) レビュー md (review.md) を開く', cmd: 'ponpokoReview.openReview' },
        { label: '$(folder) 出力先ディレクトリを設定', cmd: 'ponpokoReview.setOutputDir' },
        { label: '$(git-branch) 既定の比較先(base)を選択', cmd: 'ponpokoReview.setBase' },
      ];
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'ponpoko-review',
      });
      if (picked) {
        await vscode.commands.executeCommand(picked.cmd);
      }
    }),
  );
}

/** ファイル/フォルダ行の worktree ルート基準の相対パス。それ以外のノードは undefined。 */
function nodeRelPath(node: DiffNode | undefined): string | undefined {
  if (!node) {
    return undefined;
  }
  if (node.kind === 'file') {
    return node.entry.path;
  }
  if (node.kind === 'dir') {
    return node.relDir;
  }
  return undefined;
}

export function deactivate(): void {
  // subscriptions で破棄されるため特になし。
}
