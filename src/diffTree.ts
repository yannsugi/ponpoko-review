import * as vscode from 'vscode';
import * as path from 'path';
import {
  DiffEntry,
  Worktree,
  defaultBaseBranch,
  diffNameStatus,
  refExists,
  viewHashes,
  worktreeList,
} from './git';
import { ViewedStore } from './viewed';
import { WorktreeBaseStore } from './worktreeBase';
import { IgnoreStore, makeIgnoreMatcher } from './ignore';

/** worktree のパスから表示用の名前（ベース名）を得る。 */
export function worktreeName(wt: Worktree): string {
  return path.basename(wt.path);
}

/**
 * status → コーディコン＋git色。画像(SVG)アイコンはスクロール描画が重いため、
 * 軽いフォントグリフ(ThemeIcon)を使う。VS Code が差分表示用に用意した
 * diff-* 系（git 拡張の SCM と同じ語彙）で「差分の状態」を正確に表す。
 */
const STATUS_CODICON: Record<string, { icon: string; color: string }> = {
  A: { icon: 'diff-added', color: 'gitDecoration.addedResourceForeground' },
  M: { icon: 'diff-modified', color: 'gitDecoration.modifiedResourceForeground' },
  D: { icon: 'diff-removed', color: 'gitDecoration.deletedResourceForeground' },
  R: { icon: 'diff-renamed', color: 'gitDecoration.renamedResourceForeground' },
  C: { icon: 'diff-added', color: 'gitDecoration.addedResourceForeground' },
  T: { icon: 'diff-modified', color: 'gitDecoration.modifiedResourceForeground' },
  U: { icon: 'warning', color: 'gitDecoration.conflictingResourceForeground' },
};

export type ViewMode = 'list' | 'tree';

export interface WorktreeNode {
  kind: 'worktree';
  worktree: Worktree;
}

export interface DirNode {
  kind: 'dir';
  worktree: Worktree;
  /** worktree ルートからの相対ディレクトリ（圧縮済みのこともある、例 "src/handlers"）。 */
  relDir: string;
  /** 表示ラベル（親ディレクトリより下の部分）。 */
  label: string;
}

export interface FileNode {
  kind: 'file';
  worktree: Worktree;
  entry: DiffEntry;
}

export interface CommentInfo {
  line: number; // 0-based 開始行
  endLine: number; // 0-based 終了行
  text: string;
  drifted?: boolean; // 保存位置から行がズレている可能性
}

export interface CommentNode {
  kind: 'comment';
  worktree: Worktree;
  uri: vscode.Uri;
  info: CommentInfo;
}

export interface MessageNode {
  kind: 'message';
  label: string;
}

export type DiffNode = WorktreeNode | DirNode | FileNode | CommentNode | MessageNode;

export class DiffTreeProvider implements vscode.TreeDataProvider<DiffNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<DiffNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private mode: ViewMode = 'list';
  private commentsOnly = false;
  private hideViewed = false;
  /** 「無視」する glob 文字列と、その判定関数（パターンから生成）。 */
  private ignorePattern = '';
  private ignoreMatcher: (relPath: string) => boolean = () => false;
  /** refresh ごとに worktree の差分一覧をキャッシュ（dir 展開のたびに git を叩かないため）。 */
  private readonly cache = new Map<string, DiffEntry[]>();
  /** worktree 一覧キャッシュ（softRefresh のたびに git worktree list を叩かない）。 */
  private worktreesCache?: Worktree[];
  /** worktreePath → 実在を確認した解決済み base（フォールバック後の実値）。 */
  private readonly baseCache = new Map<string, string>();
  /** フォールバック警告を出した worktree（毎回出さないため）。 */
  private readonly baseWarned = new Set<string>();

  constructor(
    private readonly repoRoot: string,
    private readonly viewed: ViewedStore,
    private readonly baseStore: WorktreeBaseStore,
    /** ファイル(fsPath)に付いているコメント一覧を返す。 */
    private readonly commentsOf: (fsPath: string) => CommentInfo[],
    /** ディレクトリ配下のコメント数（フォルダ/worktree 集計用）。 */
    private readonly commentCountUnder: (dirPath: string) => number,
    /** 拡張のルート uri（status 文字アイコンの解決用）。 */
    private readonly extensionUri: vscode.Uri,
    /** 「無視」glob の永続ストア。 */
    private readonly ignoreStore: IgnoreStore,
  ) {
    this.ignorePattern = ignoreStore.get();
    this.ignoreMatcher = makeIgnoreMatcher(this.ignorePattern);
  }

  /** status 文字アイコン(A/M/D/R…)の uri。viewed はグレーの -dim 版。 */
  private statusIcon(status: string, viewed: boolean): vscode.ThemeIcon {
    const deco = STATUS_CODICON[(status || 'M').toUpperCase()] ?? STATUS_CODICON.M;
    // viewed はグレーアウト。それ以外は git の差分色。
    return new vscode.ThemeIcon(
      deco.icon,
      new vscode.ThemeColor(viewed ? 'disabledForeground' : deco.color),
    );
  }

  /** 差分データから取り直す全更新（git diff 再実行）。保存・base変更時など。 */
  refresh(): void {
    this.cache.clear();
    this.baseCache.clear();
    this.baseWarned.clear();
    this.worktreesCache = undefined;
    this._onDidChangeTreeData.fire();
  }

  /**
   * キャッシュを保持したまま再描画のみ（git を叩かない）。
   * チェック(viewed)やコメント数など、差分データが変わらない更新用。ちらつき防止。
   */
  softRefresh(): void {
    this._onDidChangeTreeData.fire();
  }

  /**
   * 保存されたファイルが属する worktree のキャッシュだけ無効化する。
   * （全 worktree を再 git diff せず、該当 1 つだけ次回再取得）。
   * 自分の出力物(outputDir)やどの worktree にも属さないパスは無視。無効化したら true。
   */
  invalidate(fsPath: string): boolean {
    if (isUnderDir(this.outputRoot(), fsPath)) {
      return false; // 自分の出力物 → 無関係
    }
    // キャッシュ済み worktree のうち、保存パスを含む最長一致のものを探す。
    let owner: string | undefined;
    for (const wtPath of this.cache.keys()) {
      if (fsPath === wtPath || isUnderDir(wtPath, fsPath)) {
        if (!owner || wtPath.length > owner.length) {
          owner = wtPath;
        }
      }
    }
    if (owner) {
      this.cache.delete(owner);
      return true;
    }
    return false;
  }

  getCommentsOnly(): boolean {
    return this.commentsOnly;
  }

  /** コメントのあるファイルだけに絞り込む（list/tree と直交するフィルタ）。 */
  setCommentsOnly(on: boolean): void {
    if (this.commentsOnly !== on) {
      this.commentsOnly = on;
      this._onDidChangeTreeData.fire();
    }
  }

  getHideViewed(): boolean {
    return this.hideViewed;
  }

  /** 表示済み(viewed)のファイルをツリーから隠す（list/tree と直交するフィルタ）。 */
  setHideViewed(on: boolean): void {
    if (this.hideViewed !== on) {
      this.hideViewed = on;
      this._onDidChangeTreeData.fire();
    }
  }

  getIgnore(): string {
    return this.ignorePattern;
  }

  /** 「無視」する glob（カンマ/改行区切り）を設定。永続化＋再描画する。 */
  async setIgnore(pattern: string): Promise<void> {
    const next = pattern.trim();
    if (next === this.ignorePattern) {
      return;
    }
    this.ignorePattern = next;
    this.ignoreMatcher = makeIgnoreMatcher(next);
    await this.ignoreStore.set(next);
    this._onDidChangeTreeData.fire();
  }

  getMode(): ViewMode {
    return this.mode;
  }

  setMode(mode: ViewMode): void {
    if (this.mode !== mode) {
      this.mode = mode;
      this._onDidChangeTreeData.fire();
    }
  }

  /** レビューmdの出力先（絶対パス）。ツリーから除外する自分の成果物の場所。 */
  private outputRoot(): string {
    const setting = vscode.workspace
      .getConfiguration('ponpokoReview')
      .get<string>('outputDir', '.ponpoko-review');
    return path.isAbsolute(setting) ? setting : path.join(this.repoRoot, setting);
  }

  /** グローバル設定の比較基準ブランチ（既定: main）。 */
  getGlobalBase(): string {
    return vscode.workspace
      .getConfiguration('ponpokoReview')
      .get<string>('baseBranch', 'main');
  }

  /** 設定/個別上書きの生の base（実在チェック前）。 */
  private configuredBase(worktreePath?: string): string {
    if (worktreePath) {
      const override = this.baseStore.get(worktreePath);
      if (override) {
        return override;
      }
    }
    return this.getGlobalBase();
  }

  /**
   * 比較基準(base/target)ブランチを返す。
   * 解決済み（実在確認＋フォールバック後）があればそれ、無ければ設定値。
   */
  getBase(worktreePath?: string): string {
    if (worktreePath) {
      const resolved = this.baseCache.get(worktreePath);
      if (resolved) {
        return resolved;
      }
    }
    return this.configuredBase(worktreePath);
  }

  /**
   * 実在する base を解決する。設定値が無ければ既定ブランチを推定してフォールバック。
   * どれも無ければ null（呼び出し側でエラー表示）。
   */
  private async resolveBase(worktree: Worktree): Promise<string | null> {
    const cached = this.baseCache.get(worktree.path);
    if (cached) {
      return cached;
    }
    const want = this.configuredBase(worktree.path);
    if (await refExists(want, worktree.path)) {
      this.baseCache.set(worktree.path, want);
      return want;
    }
    const fallback = await defaultBaseBranch(worktree.path);
    if (fallback) {
      this.baseCache.set(worktree.path, fallback);
      if (!this.baseWarned.has(worktree.path)) {
        this.baseWarned.add(worktree.path);
        vscode.window.showWarningMessage(
          `ponpoko-review: 比較先 '${want}' が見つかりません。'${fallback}' で比較します（設定で変更可）。`,
        );
      }
      return fallback;
    }
    return null;
  }

  /** その worktree が個別 base を上書きしているか。 */
  hasBaseOverride(worktreePath: string): boolean {
    return this.baseStore.get(worktreePath) !== undefined;
  }

  /** 作業ファイル uri から FileNode を解決する（コメントジャンプ用）。差分に無ければ null。 */
  async resolveFileNode(uri: vscode.Uri): Promise<FileNode | null> {
    let worktrees: Worktree[];
    try {
      worktrees = await worktreeList(this.repoRoot);
    } catch {
      return null;
    }
    let owner: Worktree | undefined;
    for (const wt of worktrees) {
      const rel = path.relative(wt.path, uri.fsPath);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        if (!owner || wt.path.length > owner.path.length) {
          owner = wt;
        }
      }
    }
    if (!owner) {
      return null;
    }
    const entries =
      this.cache.get(owner.path) ?? (await this.entriesFor(owner)) ?? [];
    const rel = path.relative(owner.path, uri.fsPath).split(path.sep).join('/');
    const entry = entries.find((e) => e.path === rel);
    return entry ? { kind: 'file', worktree: owner, entry } : null;
  }

  /** キャッシュ済み差分から、relDir 配下の全ファイルを返す（チェック伝播用）。 */
  filesUnder(worktree: Worktree, relDir: string): DiffEntry[] {
    const entries = this.cache.get(worktree.path) ?? [];
    const prefix = relDir + '/';
    return entries.filter((e) => e.path.startsWith(prefix));
  }

  getTreeItem(node: DiffNode): vscode.TreeItem | Promise<vscode.TreeItem> {
    if (node.kind === 'worktree') {
      return this.worktreeItem(node);
    }
    if (node.kind === 'dir') {
      const item = new vscode.TreeItem(
        node.label,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.iconPath = vscode.ThemeIcon.Folder;
      item.contextValue = 'ponpoko.dir';
      // 配下ファイルが全て viewed ならフォルダも checked。
      const files = this.filesUnder(node.worktree, node.relDir);
      const allViewed =
        files.length > 0 &&
        files.every((e) => this.viewed.isViewed(node.worktree.path, e.path));
      item.checkboxState = allViewed
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked;
      return item;
    }
    if (node.kind === 'comment') {
      return this.commentItem(node);
    }
    if (node.kind === 'message') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('info');
      return item;
    }
    return this.fileItem(node);
  }

  private commentItem(node: CommentNode): vscode.TreeItem {
    const { info } = node;
    const ref =
      info.endLine > info.line ? `${info.line + 1}-${info.endLine + 1}` : `${info.line + 1}`;
    const first = info.text.split('\n')[0] || '(空コメント)';
    const item = new vscode.TreeItem(
      (info.drifted ? '⚠ ' : '') + first,
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = `:${ref}`;
    item.iconPath = new vscode.ThemeIcon(info.drifted ? 'warning' : 'comment');
    item.tooltip = new vscode.MarkdownString(
      (info.drifted ? '⚠ 行がずれている可能性があります\n\n' : '') + info.text,
    );
    item.contextValue = 'ponpoko.comment';
    item.command = {
      command: 'ponpokoReview.openComment',
      title: 'Open Comment',
      arguments: [{ uri: node.uri, line: info.line }],
    };
    return item;
  }

  private async worktreeItem(node: WorktreeNode): Promise<vscode.TreeItem> {
    const item = new vscode.TreeItem(
      worktreeName(node.worktree),
      vscode.TreeItemCollapsibleState.Expanded,
    );
    // current = このworktreeのブランチ(変更元=git head), target = マージ先(=base)。
    const target = this.getBase(node.worktree.path);
    const overridden = this.hasBaseOverride(node.worktree.path);
    const current = node.worktree.detached
      ? `(detached ${node.worktree.head.slice(0, 7)})`
      : node.worktree.branch ?? '(no branch)';
    // viewed 進捗「✓済/総数」。総数は無視glob適用後（レビュー対象）。hideViewed で
    // ファイルがツリーから消えても全体進捗が分かるように worktree 行だけに出す。
    let progress = '';
    const entries = (await this.entriesFor(node.worktree)) ?? [];
    const targets = this.ignorePattern
      ? entries.filter((e) => !this.ignoreMatcher(e.path))
      : entries;
    if (targets.length > 0) {
      const done = targets.filter((e) =>
        this.viewed.isViewed(node.worktree.path, e.path),
      ).length;
      progress = `  ✓${done}/${targets.length}`;
    }
    // ラベルは簡潔に「current → target」。詳細(意味)は tooltip。上書きは ★、コメントは 💬N。
    const cc = this.commentCountUnder(node.worktree.path);
    item.description =
      `${current} → ${target}` +
      (overridden ? ' ★' : '') +
      progress +
      (cc > 0 ? `  💬${cc}` : '');
    item.iconPath = new vscode.ThemeIcon('repo');
    item.tooltip = new vscode.MarkdownString(
      `**${worktreeName(node.worktree)}**\n\n` +
        `current: \`${current}\`  （変更元 / git head）\n\n` +
        `target: \`${target}\`  （マージ先 / base${overridden ? '・このworktree個別設定 ★' : '・グローバル設定'}）\n\n` +
        `${node.worktree.path}`,
    );
    item.contextValue = 'ponpoko.worktree';
    return item;
  }

  private fileItem(node: FileNode): vscode.TreeItem {
    const { entry } = node;
    const fsPath = path.join(node.worktree.path, entry.path);
    const comments = this.commentsOf(fsPath);
    // tree モードはベース名、list モードはフルパスを表示。
    const label = this.mode === 'tree' ? entry.path.split('/').pop()! : entry.path;
    // コメントがあれば展開してコメント子ノードを出す。
    const item = new vscode.TreeItem(
      label,
      comments.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    const isViewed = this.viewed.isViewed(node.worktree.path, entry.path);
    // status を表す文字アイコン(A/M/D/R…)。viewed はグレー。
    item.iconPath = this.statusIcon(entry.status, isViewed);
    // description はコメント💬とリネーム元のみ。
    const parts: string[] = [];
    if (comments.length > 0) {
      parts.push(`💬${comments.length}`);
    }
    if (entry.oldPath) {
      parts.push(`← ${entry.oldPath}`);
    }
    item.description = parts.join('  ');
    item.tooltip = new vscode.MarkdownString(
      `${entry.oldPath ? `${entry.oldPath} → ` : ''}${entry.path}\n\n` +
        `status: \`${entry.status}\`` +
        (comments.length > 0 ? ` ・ 💬 コメント ${comments.length} 件` : ''),
    );
    item.contextValue = 'ponpoko.file';
    item.checkboxState = isViewed
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    item.command = {
      command: 'ponpokoReview.openDiff',
      title: 'Open Diff',
      arguments: [node],
    };
    return item;
  }

  async getChildren(node?: DiffNode): Promise<DiffNode[]> {
    if (!node) {
      let worktrees: Worktree[];
      if (this.worktreesCache) {
        worktrees = this.worktreesCache;
      } else {
        try {
          worktrees = await worktreeList(this.repoRoot);
          this.worktreesCache = worktrees;
        } catch (err) {
          vscode.window.showErrorMessage(`ponpoko-review: worktree 列挙に失敗: ${describe(err)}`);
          return [];
        }
      }
      // worktree ラベルが解決済み base を表示できるよう、先に base を解決(実在確認＋フォールバック)。
      await Promise.all(worktrees.map((w) => this.resolveBase(w)));
      let nodes: DiffNode[] = worktrees.map((worktree) => ({ kind: 'worktree', worktree }));
      if (this.commentsOnly) {
        // コメントのある worktree だけ残す。
        nodes = nodes.filter(
          (n) => n.kind === 'worktree' && this.commentCountUnder(n.worktree.path) > 0,
        );
        if (nodes.length === 0) {
          return [{ kind: 'message', label: 'コメントはありません' }];
        }
      }
      return nodes;
    }

    if (node.kind === 'worktree') {
      const entries = await this.visibleEntries(node.worktree);
      if (entries === null) {
        return [];
      }
      const children: DiffNode[] =
        this.mode === 'list'
          ? [...entries]
              .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
              .map((entry) => ({ kind: 'file', worktree: node.worktree, entry }))
          : dirChildren(node.worktree, entries, '');
      if (children.length > 0) {
        return children;
      }
      // 空の理由を正確に（フィルタで消えたのか、元から差分なしか）。
      const raw = await this.entriesFor(node.worktree);
      const hadEntries = !!raw && raw.length > 0;
      const label = !hadEntries
        ? '差分なし'
        : this.commentsOnly
          ? 'コメントなし'
          : this.hideViewed
            ? 'すべて表示済み'
            : this.ignorePattern
              ? '無視パターンで全件非表示'
              : '差分なし';
      return [{ kind: 'message', label }];
    }

    if (node.kind === 'dir') {
      const entries = await this.visibleEntries(node.worktree);
      if (entries === null) {
        return [];
      }
      return dirChildren(node.worktree, entries, node.relDir);
    }

    if (node.kind === 'file') {
      // ファイルの子＝そのファイルのコメント。
      const fsPath = path.join(node.worktree.path, node.entry.path);
      const uri = vscode.Uri.file(fsPath);
      return this.commentsOf(fsPath).map((info) => ({
        kind: 'comment',
        worktree: node.worktree,
        uri,
        info,
      }));
    }

    return [];
  }

  /** 表示対象の差分一覧。hideViewed / commentsOnly フィルタを適用。 */
  private async visibleEntries(worktree: Worktree): Promise<DiffEntry[] | null> {
    const entries = await this.entriesFor(worktree);
    if (entries === null) {
      return null;
    }
    let v = entries;
    if (this.ignorePattern) {
      v = v.filter((e) => !this.ignoreMatcher(e.path));
    }
    if (this.hideViewed) {
      v = v.filter((e) => !this.viewed.isViewed(worktree.path, e.path));
    }
    if (this.commentsOnly) {
      v = v.filter((e) => this.commentsOf(path.join(worktree.path, e.path)).length > 0);
    }
    return v;
  }

  /** worktree の差分一覧を取得（キャッシュ）。失敗時は null。viewed の再検証もここで一度だけ。 */
  private async entriesFor(worktree: Worktree): Promise<DiffEntry[] | null> {
    const key = worktree.path;
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }
    const base = await this.resolveBase(worktree);
    if (base === null) {
      vscode.window.showErrorMessage(
        `ponpoko-review: ${worktreeName(worktree)}: 比較先ブランチが見つかりません。設定 'ponpokoReview.baseBranch' で指定してください。`,
      );
      return null;
    }
    try {
      const all = await diffNameStatus(base, worktree.path);
      // 自分の出力物（レビューmdの出力先）配下はレビュー対象にしない。
      const out = this.outputRoot();
      const entries = all.filter(
        (e) => !isUnderDir(out, path.join(worktree.path, e.path)),
      );
      this.cache.set(key, entries);
      // viewed のうち、チェック時点から中身が変わったものは自動で外す（バッチ）。
      await this.revalidateViewed(base, worktree, entries);
      return entries;
    } catch (err) {
      vscode.window.showErrorMessage(
        `ponpoko-review: diff 取得に失敗 (${worktreeName(worktree)}, base=${base}): ${describe(err)}`,
      );
      return null;
    }
  }

  /** viewed なファイルの現在ハッシュをバッチで取り直し、チェック時と違えば外す。 */
  private async revalidateViewed(base: string, worktree: Worktree, entries: DiffEntry[]): Promise<void> {
    const viewedPaths = entries
      .filter((e) => this.viewed.isViewed(worktree.path, e.path))
      .map((e) => e.path);
    if (viewedPaths.length === 0) {
      return;
    }
    try {
      const hashes = await viewHashes(base, viewedPaths, worktree.path);
      await Promise.all(
        viewedPaths.map(async (p) => {
          if (hashes.get(p) !== this.viewed.getHash(worktree.path, p)) {
            await this.viewed.unsetViewed(worktree.path, p);
          }
        }),
      );
    } catch {
      // ハッシュ取得失敗時は viewed を維持（誤って外さない）。
    }
  }
}

/** dir 直下の子（サブディレクトリ＋ファイル）を返す。単一子フォルダは圧縮する。 */
export function dirChildren(
  worktree: Worktree,
  entries: DiffEntry[],
  dir: string,
): DiffNode[] {
  const prefix = dir === '' ? '' : dir + '/';
  const subdirs = new Set<string>();
  const files: DiffEntry[] = [];
  for (const e of entries) {
    if (prefix && !e.path.startsWith(prefix)) {
      continue;
    }
    const rest = e.path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      files.push(e);
    } else {
      subdirs.add(prefix + rest.slice(0, slash));
    }
  }

  const dirNodes: DirNode[] = [...subdirs]
    .sort()
    .map((d) => {
      const full = compactDir(entries, d);
      return {
        kind: 'dir',
        worktree,
        relDir: full,
        label: full.slice(prefix.length),
      };
    });

  const fileNodes: FileNode[] = files
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((entry) => ({ kind: 'file', worktree, entry }));

  // フォルダ先、ファイル後（GitHub/Explorer 流）。
  return [...dirNodes, ...fileNodes];
}

/** ディレクトリ直下がサブフォルダ1つだけ（ファイル無し）なら下まで連結（src/handlers のように圧縮）。 */
export function compactDir(entries: DiffEntry[], dir: string): string {
  let cur = dir;
  for (;;) {
    const prefix = cur + '/';
    const subdirs = new Set<string>();
    let hasFile = false;
    for (const e of entries) {
      if (!e.path.startsWith(prefix)) {
        continue;
      }
      const rest = e.path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        hasFile = true;
      } else {
        subdirs.add(prefix + rest.slice(0, slash));
      }
    }
    if (!hasFile && subdirs.size === 1) {
      cur = [...subdirs][0];
    } else {
      return cur;
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** fsPath が dir 配下（dir 自身は除く）かどうか。 */
export function isUnderDir(dir: string, fsPath: string): boolean {
  const rel = path.relative(dir, fsPath);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
