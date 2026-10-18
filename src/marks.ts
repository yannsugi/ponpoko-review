import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

export const MARKS_FILE = 'marks.txt';

/**
 * 📌 マーク（「今見る」ファイル）の永続化先は `<outputDir>/marks.txt`。
 * 外部セッションの AI エージェントがパスを追記するだけでツリーにマークが付く、という
 * ファイル契約（README 参照）。拡張は「読む・書く」だけで、通信手段は持たない。
 *
 * 形式: 1 行 1 パス。絶対パス推奨。相対はワークスペースルート基準。`#` 始まりと空行は無視。
 */

/** 1 行をパスに正規化する。コメント/空行なら undefined。 */
function lineToPath(line: string, repoRoot: string): string | undefined {
  const t = line.trim();
  if (t === '' || t.startsWith('#')) {
    return undefined;
  }
  return path.resolve(repoRoot, t);
}

/** marks.txt の内容 → 絶対パスの集合。 */
export function parseMarks(text: string, repoRoot: string): Set<string> {
  const set = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const p = lineToPath(line, repoRoot);
    if (p !== undefined) {
      set.add(p);
    }
  }
  return set;
}

/** 未登録のパスを末尾に追記した内容を返す（既存行・コメントは保持）。 */
export function addMarkLines(text: string, absPaths: string[], repoRoot: string): string {
  const have = parseMarks(text, repoRoot);
  const add = absPaths.filter((p) => !have.has(p));
  if (add.length === 0) {
    return text;
  }
  let out = text;
  if (out.length > 0 && !out.endsWith('\n')) {
    out += '\n';
  }
  return out + add.join('\n') + '\n';
}

/** 該当パスの行だけを除いた内容を返す（表記が絶対/相対どちらでも同一視。コメント行は保持）。 */
export function removeMarkLines(text: string, absPaths: string[], repoRoot: string): string {
  const drop = new Set(absPaths);
  const kept = text
    .split(/\r?\n/)
    .filter((line) => {
      const p = lineToPath(line, repoRoot);
      return p === undefined || !drop.has(p);
    });
  // 末尾の空行（split で生じる分）を整理して、残りがあれば末尾改行 1 つで終える。
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') {
    kept.pop();
  }
  return kept.length === 0 ? '' : kept.join('\n') + '\n';
}

function sha1(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex');
}

/**
 * marks.txt をメモリに読み込み、FileSystemWatcher で外部変更を検知して onDidChange を発火する。
 * VS Code 側のトグルも同じファイルへ書き戻す（一時ファイル → rename で原子的に置換）。
 * 自分の書き込みによる watcher 発火は内容ハッシュの一致で無視する。
 */
export class MarkStore implements vscode.Disposable {
  private marks = new Set<string>();
  private lastHash = sha1('');
  private watcher?: vscode.FileSystemWatcher;
  private filePath = '';
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  /** 書き込みを直列化する（連打で内容を取りこぼさないため）。 */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly repoRoot: string,
    /** 出力ディレクトリ（設定変更に追従できるよう関数で受ける）。 */
    private readonly resolveOutputRoot: () => string,
  ) {}

  /** marks.txt の絶対パス。 */
  getFilePath(): string {
    return path.join(this.resolveOutputRoot(), MARKS_FILE);
  }

  /** 起動時・出力先変更時に呼ぶ。読み込み＋ watcher を張り直す。 */
  async start(): Promise<void> {
    const next = this.getFilePath();
    if (next !== this.filePath) {
      this.filePath = next;
      this.watcher?.dispose();
      this.watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(path.dirname(next)), MARKS_FILE),
      );
      const onFs = () => void this.reload();
      this.watcher.onDidChange(onFs);
      this.watcher.onDidCreate(onFs);
      this.watcher.onDidDelete(onFs);
    }
    await this.reload();
  }

  /** ファイルから読み直す。内容が変わっていれば onDidChange。 */
  async reload(): Promise<void> {
    const text = await this.readText();
    const h = sha1(text);
    if (h === this.lastHash) {
      return;
    }
    this.lastHash = h;
    this.marks = parseMarks(text, this.repoRoot);
    this._onDidChange.fire();
  }

  isMarked(absPath: string): boolean {
    return this.marks.has(absPath);
  }

  /** マーク済み絶対パスの一覧（表示集計用）。 */
  all(): ReadonlySet<string> {
    return this.marks;
  }

  /** 複数パスをまとめてマーク / 解除し、ファイルへ書き戻す。 */
  async set(absPaths: string[], on: boolean): Promise<void> {
    if (absPaths.length === 0) {
      return;
    }
    await this.enqueue(async () => {
      const text = await this.readText();
      const next = on
        ? addMarkLines(text, absPaths, this.repoRoot)
        : removeMarkLines(text, absPaths, this.repoRoot);
      await this.writeText(next);
    });
  }

  /** 全マーク解除（ファイルを空にする）。 */
  async clear(): Promise<void> {
    await this.enqueue(() => this.writeText(''));
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async readText(): Promise<string> {
    try {
      return await fs.promises.readFile(this.filePath || this.getFilePath(), 'utf8');
    } catch {
      return ''; // 未作成 → 空
    }
  }

  private async writeText(text: string): Promise<void> {
    const file = this.filePath || this.getFilePath();
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(tmp, text, 'utf8');
    await fs.promises.rename(tmp, file);
    // 自分の書き込み分は先にメモリへ反映し、watcher 発火時のハッシュ一致で二重更新を避ける。
    this.lastHash = sha1(text);
    this.marks = parseMarks(text, this.repoRoot);
    this._onDidChange.fire();
  }

  dispose(): void {
    this.watcher?.dispose();
    this._onDidChange.dispose();
  }
}
