import * as vscode from 'vscode';

/**
 * GitHub PR の "Viewed" 相当。ファイルごとに「表示済み」フラグと、
 * チェックした時点の差分ハッシュを workspaceState に永続化する。
 * 値の有無 = viewed、値 = チェック時の差分ハッシュ。
 */
export class ViewedStore {
  constructor(private readonly state: vscode.Memento) {}

  private key(worktreePath: string, file: string): string {
    return `ponpoko.viewed:${worktreePath}::${file}`;
  }

  isViewed(worktreePath: string, file: string): boolean {
    return this.state.get<string>(this.key(worktreePath, file)) !== undefined;
  }

  /** チェック時に保存した差分ハッシュ。未 viewed なら undefined。 */
  getHash(worktreePath: string, file: string): string | undefined {
    return this.state.get<string>(this.key(worktreePath, file));
  }

  /** viewed にする（現在の差分ハッシュを記録）。 */
  async setViewed(worktreePath: string, file: string, hash: string): Promise<void> {
    await this.state.update(this.key(worktreePath, file), hash);
  }

  /** viewed を外す。 */
  async unsetViewed(worktreePath: string, file: string): Promise<void> {
    await this.state.update(this.key(worktreePath, file), undefined);
  }
}

/** 1ファイル分の「操作前」の viewed 状態。hash が undefined なら操作前は未 viewed。 */
export interface ViewedSnapshot {
  worktreePath: string;
  file: string;
  hash: string | undefined;
}

/** 1回のチェックボックス操作（イベント単位。フォルダなら配下複数ファイル）の取り消し単位。 */
export interface ViewedUndoEntry {
  /** チェック方向（viewed にした）ファイル数。トースト表示の判断に使う。 */
  checkedCount: number;
  snapshots: ViewedSnapshot[];
}

/**
 * 直前の viewed 操作を戻すためのメモリ上スタック（セッション限り・上限あり）。
 * 誤操作の救済が目的なので永続化しない。
 */
export class ViewedUndoStack {
  private readonly entries: ViewedUndoEntry[] = [];

  constructor(private readonly limit = 5) {}

  push(entry: ViewedUndoEntry): void {
    if (entry.snapshots.length === 0) {
      return;
    }
    this.entries.push(entry);
    while (this.entries.length > this.limit) {
      this.entries.shift();
    }
  }

  /** 直近の操作を取り出す（無ければ undefined）。 */
  pop(): ViewedUndoEntry | undefined {
    return this.entries.pop();
  }

  /** 特定の操作（トーストに紐付いたもの）を取り出す。既に無ければ undefined。 */
  take(entry: ViewedUndoEntry): ViewedUndoEntry | undefined {
    const i = this.entries.indexOf(entry);
    if (i < 0) {
      return undefined;
    }
    this.entries.splice(i, 1);
    return entry;
  }

  size(): number {
    return this.entries.length;
  }
}
