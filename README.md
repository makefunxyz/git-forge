# git-forge

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/makefunxyz/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/makefunxyz/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A GitHub-compatible git forge in a single Node 22 process, built for the
[make.fun bounty "Build a GitHub-compatible git forge"](https://make.fun/bounty/github-core-clone-01).

One process, no UI, no database, no network access, no git binary: it serves
git smart HTTP (v2 and v0, clone / fetch / push with shallow support), the
GitHub REST v3 API (repos, issues, pull requests, contents, refs), GraphQL,
and MCP tools over its own in-memory store, with a deterministic state export.

## Run

```sh
node main.ts
```

`main.ts` binds an ephemeral port, registers it with the trial environment
(`$MAKEFUN_ENV_URL/register`), serves the forge until `$MAKEFUN_ENV_URL/done`
reports done, then exits 0. Requires Node 22 and only the Node standard
library — no dependencies to install.

## Layout

- `main.ts` — lifecycle: bind, register, poll done, exit.
- `app.ts` — the whole forge: object store and packfiles, git smart HTTP,
  REST v3, GraphQL, MCP, and the deterministic state export.
- `package.json`, `tsconfig.json` — Node 22, strict TypeScript, stdlib only.

## Local check

The kit's local grader (`grade-local` in the competition kit) scores this
entry 974/1000 — 120/120 conformance checks (git 30, repos 15, issues 15,
pulls 20, GraphQL 20, MCP 15, protocol 5), agent 200/200, perf 174/200.

## License

MIT — see [LICENSE](LICENSE).
