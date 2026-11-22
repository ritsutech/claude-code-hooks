# claude-code-hooks

Claude Code のフック集です。

| フック | 何をするか |
|---|---|
| [guard-main](#guard-main) | 指定したリポジトリの main へ、Claude が commit / push するのを止める。PR のマージも止める |

## guard-main

main にマージすると自動で公開・デプロイされるリポジトリで、Claude が main を直接触らないようにする PreToolUse フックです。
GitHub のブランチ保護を使えないとき（無料プランの Private リポジトリなど）の守りになります。

- 止めるもの: 守るブランチでの `git commit`、守るブランチへの `git push`（`--all` `--mirror` も）、`gh pr merge`、`gh api` での PR のマージ
- 「確認を出す（ask）」ではなく止めます。auto mode では確認が本人に届かず通ってしまうためです
- 操作先のリポジトリが読み取れないときだけ、確認を出します

### 必要なもの

- Windows PowerShell 5.1（Windows に最初から入っています）
- git、gh

### 設定

`.claude/settings.json` に書きます。パスは置いた場所に合わせてください。

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|PowerShell",
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe",
            "args": ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:/path/to/claude-code-hooks/guard-main/guard-main.ps1", "-Repo", "my-blog"]
          }
        ]
      }
    ]
  }
}
```

| 引数 | 意味 | 省略したとき |
|---|---|---|
| `-Repo` | 守るリポジトリ。remote の URL に含まれる文字で判定する。複数はカンマ区切り（`"my-blog,my-site"`） | すべてのリポジトリを守る |
| `-Branch` | 守るブランチ | `main` |

`gh pr merge` は `-Repo` に関係なく、どのリポジトリでも止めます。

### 確かめ方

設定したあと、Claude Code に `gh pr merge --help を実行して` と頼み、`guard-main: BLOCKED.` が出れば効いています。

## ライセンス

MIT
