import * as vscode from 'vscode';

const KEY = 'ponpokoReview.ignoreGlobs';

/**
 * 「無視（ノイズ非表示）」する glob 文字列を workspaceState に保持する。
 * VS Code 検索の「除外するファイル」欄と同じ思想で、カンマ/改行区切りの glob を1本の文字列で持つ。
 * ローカル・非コミット・空にすれば即解除という意味で「一時的」。
 */
export class IgnoreStore {
  constructor(private readonly state: vscode.Memento) {}

  get(): string {
    return this.state.get<string>(KEY, '');
  }

  async set(value: string): Promise<void> {
    await this.state.update(KEY, value.trim());
  }
}

/**
 * glob 文字列（カンマ/改行区切り）→ 相対パス判定関数。空なら常に false。
 * VS Code 検索の除外欄に倣う:
 *  - `/` を含まないパターンは全階層のファイル名にマッチ（例: `*.lock`, `Cargo.toml`）
 *  - `**` は任意階層（0個含む）、`*` は `/` 以外の任意、`?` は1文字
 * 判定対象は worktree 基準の相対パス（区切りは `/`）。
 */
export function makeIgnoreMatcher(patterns: string): (relPath: string) => boolean {
  const globs = patterns
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (globs.length === 0) {
    return () => false;
  }
  const regexes = globs.map(globToRegExp);
  return (relPath: string) => {
    const p = relPath.replace(/\\/g, '/');
    return regexes.some((re) => re.test(p));
  };
}

/** 1つの glob を、相対パス全体にアンカーした RegExp へ変換する。 */
function globToRegExp(glob: string): RegExp {
  let g = glob.trim();
  if (g.startsWith('./')) {
    g = g.slice(2);
  }
  // スラッシュを含まない＝ファイル名指定 → 全階層にマッチさせる。
  if (!g.includes('/')) {
    g = '**/' + g;
  }
  let re = '^';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          re += '(?:.*/)?'; // **/ … 任意階層（先頭でも root 直下にマッチ）
        } else {
          re += '.*'; // ** … 残り全部
        }
      } else {
        re += '[^/]*'; // * … / を跨がない
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c; // 正規表現メタ文字をエスケープ
    } else {
      re += c;
    }
  }
  return new RegExp(re + '$');
}
