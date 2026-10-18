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
 * パターン文字列（カンマ/改行区切り）を個々のパターンに分割する。
 * `/.../` で囲まれた正規表現の中のカンマは区切りとして扱わない
 * （分割前に `/.../` を保護する）。空要素は捨てる。
 */
export function splitIgnorePatterns(patterns: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inRegex = false;
  const flush = () => {
    const t = buf.trim();
    if (t.length > 0) {
      out.push(t);
    }
    buf = '';
  };
  for (const c of patterns) {
    if (!inRegex && (c === ',' || c === '\n')) {
      flush();
      continue;
    }
    if (c === '/') {
      if (!inRegex && buf.trim() === '') {
        inRegex = true; // 要素の先頭 `/` → 正規表現開始
      } else if (inRegex) {
        inRegex = false; // 閉じ `/`（以降は区切りが効く。`/a/b/` は glob として後段で判定）
      }
    }
    buf += c;
  }
  flush();
  return out;
}

/** `/.../` 囲みなら中身を返す。囲みでなければ undefined（`/` 単独や `/dir/x` は glob）。 */
function regexBody(pattern: string): string | undefined {
  if (pattern.length >= 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
    return pattern.slice(1, -1);
  }
  return undefined;
}

/** 1つのパターンを RegExp に変換する。正規表現が不正なら undefined。 */
function patternToRegExp(pattern: string): RegExp | undefined {
  const body = regexBody(pattern);
  if (body === undefined) {
    return globToRegExp(pattern);
  }
  try {
    return new RegExp(body);
  } catch {
    return undefined;
  }
}

/**
 * 入力検証（InputBox の validateInput 用）。不正な正規表現があればメッセージ、無ければ undefined。
 */
export function validateIgnorePatterns(patterns: string): string | undefined {
  for (const p of splitIgnorePatterns(patterns)) {
    const body = regexBody(p);
    if (body === undefined) {
      continue;
    }
    try {
      new RegExp(body);
    } catch (err) {
      return `不正な正規表現 ${p}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return undefined;
}

/**
 * パターン文字列（カンマ/改行区切り）→ 相対パス判定関数。空なら常に false。
 * 各パターンは `/.../` で囲めば正規表現、それ以外は glob（混在可）。
 * 正規表現は相対パス全体に対して `test`（アンカー無しは部分一致）。不正な正規表現は無視する。
 * glob は VS Code 検索の除外欄に倣う:
 *  - `/` を含まないパターンは全階層のファイル名にマッチ（例: `*.lock`, `Cargo.toml`）
 *  - `**` は任意階層（0個含む）、`*` は `/` 以外の任意、`?` は1文字
 * 判定対象は worktree 基準の相対パス（区切りは `/`）。
 */
export function makeIgnoreMatcher(patterns: string): (relPath: string) => boolean {
  const regexes = splitIgnorePatterns(patterns)
    .map(patternToRegExp)
    .filter((re): re is RegExp => re !== undefined);
  if (regexes.length === 0) {
    return () => false;
  }
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
