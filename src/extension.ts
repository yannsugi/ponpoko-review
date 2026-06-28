import * as vscode from 'vscode';
import * as path from 'path';
import { listBranches, viewHash, viewHashes, worktreeList, Worktree } from './git';
import { DiffNode, DiffTreeProvider, WorktreeNode, worktreeName } from './diffTree';
import { BASE_SCHEME, BaseContentProvider } from './baseContentProvider';
import { openDiff } from './openDiff';
import { CommentStore, threadLineRange, threadText } from './comments';
import { writeReview } from './markdown';
import { ViewedStore } from './viewed';
import { WorktreeBaseStore } from './worktreeBase';

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
      // 出力した分を Resolve してループを閉じられるよう、ボタンを添える。
      const choice = await vscode.window.showInformationMessage(
        `ponpoko-review: ${result.itemCount} 件を ${where} に書き出しました` +
          (resolved > 0 ? `（Resolve済み ${resolved} 件は除外）` : '') +
          '。',
        '出力分を Resolve',
      );
      if (choice === '出力分を Resolve') {
        store.resolveThreads(active);
        onCommentsChanged();
      }
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

  // 差分ツリー
  const treeProvider = new DiffTreeProvider(
    repoRoot,
    viewed,
    baseStore,
    (fsPath) => store.listFor(fsPath),
    (dirPath) => store.countUnder(dirPath),
    context.extensionUri,
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
  syncViewMode();
  syncCommentsOnly();
  context.subscriptions.push(
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

  // チェックボックス操作 → viewed の保存/解除。
  // フォルダをチェックすると配下ファイルを一括 viewed/解除（逆も getTreeItem 側で集計）。
  context.subscriptions.push(
    treeView.onDidChangeCheckboxState(async (e) => {
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
    }),
  );

  // ファイル保存で差分が変わりうる → 再検証のためツリーを更新（連続保存はデバウンス）。
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => {
      if (saveTimer) {
        clearTimeout(saveTimer);
      }
      saveTimer = setTimeout(() => treeProvider.refresh(), 300);
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

    // 上部の設定メニュー（diffには出さないグローバル設定の入口）。
    vscode.commands.registerCommand('ponpokoReview.settings', async () => {
      const items: (vscode.QuickPickItem & { cmd: string })[] = [
        { label: '$(folder) 出力先ディレクトリを設定', cmd: 'ponpokoReview.setOutputDir' },
        { label: '$(git-branch) 既定の比較先(base)を選択', cmd: 'ponpokoReview.setBase' },
      ];
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'ponpoko-review 設定',
      });
      if (picked) {
        await vscode.commands.executeCommand(picked.cmd);
      }
    }),
  );
}

export function deactivate(): void {
  // subscriptions で破棄されるため特になし。
}
