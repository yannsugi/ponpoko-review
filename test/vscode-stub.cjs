// 'vscode' モジュールを require できないテスト環境向けの最小スタブ。
// out/*.js は 'vscode' を import するが、純粋関数のテストでは実体は不要なので、
// require('vscode') を空に近いオブジェクトに差し替える。
const Module = require('module');

if (!Module.__ponpokoVscodeStub) {
  Module.__ponpokoVscodeStub = true;
  const stub = {
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
    CommentMode: { Editing: 0, Preview: 1 },
    CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
    CommentThreadState: { Unresolved: 0, Resolved: 1 },
    ThemeIcon: class ThemeIcon {
      constructor(id, color) {
        this.id = id;
        this.color = color;
      }
    },
    ThemeColor: class ThemeColor {
      constructor(id) {
        this.id = id;
      }
    },
    MarkdownString: class MarkdownString {
      constructor(value) {
        this.value = value;
      }
    },
    EventEmitter: class EventEmitter {
      constructor() {
        this.event = () => ({ dispose() {} });
      }
      fire() {}
      dispose() {}
    },
    Uri: {
      file: (p) => ({ scheme: 'file', fsPath: p, path: p }),
      joinPath: (base, ...parts) => ({ fsPath: [base.fsPath, ...parts].join('/') }),
    },
  };
  ThemeIconStatics(stub.ThemeIcon);
  const orig = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
      return stub;
    }
    return orig.apply(this, arguments);
  };
}

function ThemeIconStatics(ThemeIcon) {
  ThemeIcon.Folder = new ThemeIcon('folder');
  ThemeIcon.File = new ThemeIcon('file');
}

module.exports = {};
