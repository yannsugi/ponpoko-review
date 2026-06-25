import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';

export interface DiffEntry {
  /** name-status の先頭1文字。R/C はパーセンテージを落とした 'R'/'C'。 */
  status: FileStatus;
  /** 現在のパス（リネーム時は新パス）。 */
  path: string;
  /** リネーム/コピー元のパス。 */
  oldPath?: string;
}

export interface Worktree {
  /** ワークツリーの絶対パス。 */
  path: string;
  /** チェックアウト中のブランチ名（refs/heads/ を除去）。detached の場合 undefined。 */
  branch?: string;
  /** HEAD のコミット SHA。 */
  head: string;
  /** detached HEAD かどうか。 */
  detached: boolean;
}

/** 任意の cwd で git を実行し stdout を返す。失敗時は例外を投げる。 */
async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/**
 * `git diff --name-status <base>...HEAD` をパースして返す（マージベース基準＝PR相当）。
 */
export async function diffNameStatus(base: string, cwd: string): Promise<DiffEntry[]> {
  // -z で NUL 区切りにし、パスにタブ/改行が含まれても安全にパースする。
  const stdout = await runGit(
    ['diff', '--name-status', '-z', `${base}...HEAD`],
    cwd,
  );
  return parseNameStatusZ(stdout);
}

/** name-status の NUL 区切り出力をパースする。 */
export function parseNameStatusZ(stdout: string): DiffEntry[] {
  const tokens = stdout.split('\0').filter((t) => t.length > 0);
  const entries: DiffEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const raw = tokens[i++];
    const status = raw[0] as FileStatus;
    if (status === 'R' || status === 'C') {
      // R/C は <status>\0<oldPath>\0<newPath>
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      entries.push({ status, path: newPath, oldPath });
    } else {
      const path = tokens[i++];
      entries.push({ status, path });
    }
  }
  return entries;
}

/**
 * `git show <base>:<path>` の中身を返す。
 * base 側に存在しないパス（追加ファイル等）の場合は例外になるので、呼び出し側で握る。
 */
export async function showFileAtBase(base: string, path: string, cwd: string): Promise<string> {
  return runGit(['show', `${base}:${path}`], cwd);
}

/** `git merge-base <base> HEAD` の SHA を返す。 */
export async function mergeBase(base: string, cwd: string): Promise<string> {
  const stdout = await runGit(['merge-base', base, 'HEAD'], cwd);
  return stdout.trim();
}

/** `git worktree list --porcelain` をパースして返す。 */
export async function worktreeList(cwd: string): Promise<Worktree[]> {
  const stdout = await runGit(['worktree', 'list', '--porcelain'], cwd);
  return parseWorktreePorcelain(stdout);
}

/** worktree list --porcelain の出力をパースする。 */
export function parseWorktreePorcelain(stdout: string): Worktree[] {
  const worktrees: Worktree[] = [];
  let current: Partial<Worktree> | null = null;

  const flush = () => {
    if (current && current.path) {
      worktrees.push({
        path: current.path,
        branch: current.branch,
        head: current.head ?? '',
        detached: current.detached ?? false,
      });
    }
    current = null;
  };

  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      current = { path: line.slice('worktree '.length).trim() };
    } else if (current) {
      if (line.startsWith('HEAD ')) {
        current.head = line.slice('HEAD '.length).trim();
      } else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length).trim();
        current.branch = ref.replace(/^refs\/heads\//, '');
      } else if (line.trim() === 'detached') {
        current.detached = true;
      }
    }
  }
  flush();
  return worktrees;
}

/** ローカルブランチ名の一覧を返す。 */
export async function listBranches(cwd: string): Promise<string[]> {
  const stdout = await runGit(
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
    cwd,
  );
  return stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** base 側にそのパスが存在するか（git show が成功するか）を判定する。 */
export async function existsAtBase(base: string, path: string, cwd: string): Promise<boolean> {
  try {
    await runGit(['cat-file', '-e', `${base}:${path}`], cwd);
    return true;
  } catch {
    return false;
  }
}
