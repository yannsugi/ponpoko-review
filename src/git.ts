import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as nodePath from 'path';

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

/**
 * git にブランチ/リビジョンを「単独引数」で渡す前の検証（defense-in-depth）。
 * execFile なのでシェル注入は無いが、`-` 始まりだとオプション誤認（例: --output）の
 * 余地があるため弾く。制御文字や空も拒否。
 */
function assertSafeRef(ref: string): void {
  // 空 / '-'始まり（--output 等のオプション誤認） / 制御文字・空白を拒否。
  // ハイフンを含むブランチ名(feature/diff-tree 等)は許可。
  if (!ref || ref.startsWith('-') || /[\u0000-\u0020\u007f]/.test(ref)) {
    throw new Error(`ponpoko-review: 不正なブランチ/リビジョン指定です: ${JSON.stringify(ref)}`);
  }
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
 * ブランチ分岐点（merge-base）から「現在の作業ツリー」までの差分を返す。
 * コミット済み＋未コミット（編集・削除）に加え、未追跡ファイル(??)も A として含める。
 * これにより diff ビュー（右＝作業ファイル）の見た目とツリーの一覧が一致する。
 */
export async function diffNameStatus(base: string, cwd: string): Promise<DiffEntry[]> {
  const mb = await mergeBase(base, cwd);
  // <merge-base> のみ指定 = その commit と作業ツリーの差分（staged/unstaged 両方を反映）。
  // -z で NUL 区切りにし、パスにタブ/改行が含まれても安全にパースする。
  const stdout = await runGit(['diff', '--name-status', '-z', mb], cwd);
  const entries = parseNameStatusZ(stdout);

  // 未追跡ファイル（git add 前の新規）を A として加える。.gitignore は尊重。
  const seen = new Set(entries.map((e) => e.path));
  const untracked = await runGit(
    ['ls-files', '--others', '--exclude-standard', '-z'],
    cwd,
  );
  for (const p of untracked.split('\0').filter((t) => t.length > 0)) {
    if (!seen.has(p)) {
      entries.push({ status: 'A', path: p });
    }
  }
  return entries;
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
  assertSafeRef(base);
  return runGit(['show', `${base}:${path}`], cwd);
}

/** `git merge-base <base> HEAD` の SHA を返す。 */
export async function mergeBase(base: string, cwd: string): Promise<string> {
  assertSafeRef(base);
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

/**
 * 表示中の差分（base ↔ 作業ツリー）の内容ハッシュを返す。
 * "Viewed" のチェック時点と中身が変わったかの判定に使う。
 * base 側 / 作業ツリー側のどちらが変わってもハッシュが変わる。
 */
export async function viewHash(base: string, path: string, cwd: string): Promise<string> {
  const m = await viewHashes(base, [path], cwd);
  return m.get(path) ?? 'none:missing';
}

/**
 * 複数ファイルの viewHash を一括算出（worktree あたり最大2プロセスに集約）。
 * ハッシュ = base側blob oid と 作業ツリーblob oid の連結。base側は git ls-tree、
 * 作業ツリー側は git hash-object をそれぞれ1回のバッチで取得し、
 * ファイル数に比例した spawn を避ける。
 */
export async function viewHashes(
  base: string,
  paths: string[],
  cwd: string,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (paths.length === 0) {
    return result;
  }
  assertSafeRef(base);

  // base 側 blob oid（対象パスのみ ls-tree、1プロセス）。
  const baseOid = new Map<string, string>();
  try {
    const out = await runGit(['ls-tree', '-r', '-z', base, '--', ...paths], cwd);
    for (const rec of out.split('\0')) {
      if (!rec) {
        continue;
      }
      const tab = rec.indexOf('\t');
      if (tab < 0) {
        continue;
      }
      const meta = rec.slice(0, tab).split(' ');
      baseOid.set(rec.slice(tab + 1), meta[2]);
    }
  } catch {
    // base 無効等 → none 扱い。
  }

  // 作業ツリー側 blob oid（存在するファイルだけ 1プロセスで hash-object）。
  const exists = await Promise.all(
    paths.map((p) =>
      fs.promises.stat(nodePath.join(cwd, p)).then(
        () => true,
        () => false,
      ),
    ),
  );
  const existing = paths.filter((_, i) => exists[i]);
  const workOid = new Map<string, string>();
  if (existing.length > 0) {
    try {
      const out = await runGit(['hash-object', '--', ...existing], cwd);
      const oids = out.split('\n').map((x) => x.trim());
      existing.forEach((pp, i) => {
        if (oids[i]) {
          workOid.set(pp, oids[i]);
        }
      });
    } catch {
      // 取得失敗 → missing 扱い。
    }
  }

  for (const pp of paths) {
    result.set(pp, `${baseOid.get(pp) ?? 'none'}:${workOid.get(pp) ?? 'missing'}`);
  }
  return result;
}

/**
 * 比較先候補のブランチ一覧。ローカル(refs/heads)に加え、
 * remote-tracking(refs/remotes, 例: origin/main)も含める。
 * remote を base にすると「ローカルが古くても、最後に fetch したリモートの状態」と比較できる。
 * origin/HEAD 等のシンボリック別名（末尾 /HEAD）は除外。
 */
export async function listBranches(cwd: string): Promise<string[]> {
  // %(symref) はシンボリック ref(origin/HEAD 等)のときだけ非空 → それを除外する。
  const stdout = await runGit(
    ['for-each-ref', '--format=%(refname:short)\t%(symref)', 'refs/heads', 'refs/remotes'],
    cwd,
  );
  const out: string[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) {
      continue;
    }
    const [name, symref] = line.split('\t');
    if (name && !symref) {
      out.push(name.trim());
    }
  }
  return out;
}

/** ref が存在し commit に解決できるか。 */
export async function refExists(ref: string, cwd: string): Promise<boolean> {
  try {
    assertSafeRef(ref);
    await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * リポジトリの既定ブランチを推定する。
 * origin/HEAD（リモート既定）→ main → master → origin/main → origin/master →
 * 最初のローカルブランチ、の順で実在するものを返す。見つからなければ undefined。
 */
export async function defaultBaseBranch(cwd: string): Promise<string | undefined> {
  // リモートの既定（clone 時に設定される origin/HEAD）
  try {
    const r = (await runGit(['rev-parse', '--abbrev-ref', 'origin/HEAD'], cwd)).trim();
    if (r && r !== 'origin/HEAD') {
      return r; // 例: origin/main
    }
  } catch {
    // origin/HEAD 未設定など
  }
  for (const c of ['main', 'master', 'origin/main', 'origin/master']) {
    if (await refExists(c, cwd)) {
      return c;
    }
  }
  // 最後の手段: 最初のローカルブランチ
  try {
    const b = (
      await runGit(['for-each-ref', '--count=1', '--format=%(refname:short)', 'refs/heads'], cwd)
    ).trim();
    if (b) {
      return b;
    }
  } catch {
    // ブランチ皆無
  }
  return undefined;
}

/** base 側にそのパスが存在するか（git show が成功するか）を判定する。 */
export async function existsAtBase(base: string, path: string, cwd: string): Promise<boolean> {
  try {
    assertSafeRef(base);
    await runGit(['cat-file', '-e', `${base}:${path}`], cwd);
    return true;
  } catch {
    return false;
  }
}
