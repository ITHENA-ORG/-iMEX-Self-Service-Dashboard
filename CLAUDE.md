# iMEX Self-Service Dashboards (Dashboard Builder) — project memory for Claude Code

**Start every new session by reading `HANDOFF-CLAUDE-CODE.md` (whole file), then `DECISIONS.md` (at least D-035).**

Current setup (D-035, 5 Oct 2026; supersedes the handoff's "deploy to local next to Reports" plan where they differ):
- **iserv-demov2.ithena.app (ThingsBoard 4.2.1) is READ ONLY.** Reads for copying are allowed; never write, change or
  delete anything there. Use only `scripts/mirror/clients.mjs` `sourceClient()` (refuses writes before sending).
- **Local ThingsBoard 4.3.1.5** (Docker, http://localhost:8080) holds a copy of the iMEX demo app ("Self Service
  Dashboard", customer Ithena Technology) in the **same tenant as Self-Service Reports**. Changes there are allowed;
  Reports' entities (POC customers, "POC iMEX", imex_rpt_* widgets, root rule chain) stay untouched; check with
  `node scripts/mirror/diff-local.mjs`.
- Builder deploy on local: `npm run build:widgets && node widgets/deploy/deploy-node.mjs --go` (options in the
  git-ignored `deploy.local.json`: Ithena Technology, store DashboardStore, config DBBLLM-CONFIG, skipAppDashboard).
- Node is at `C:\Program Files\nodejs` (prepend it to PATH in PowerShell).

Rules:
- Talk to Akshay directly and practically; no flattery or filler. Say so when an idea is flawed.
- Never print, log or commit credentials, JWTs or keys. `.env` (git-ignored) holds `TB_*` (local), `SRC_TB_*` (server),
  `LOCAL_USER_PASSWORD`; scripts read it, nobody prints it. `mirror-data/` (export, git-ignored) has secrets masked.
- The LLM key lives only on the tenant-owned config asset (`DBBLLM-CONFIG` on local; `dbb_llm_api_key`); never assign it
  to a customer; no debug mode on the chat relay nodes.
- Never run teardown; ask before setup/backfill/simulator. Back up before overwriting (`backups/<date>/`).
- `DBB_DEPLOY` overwrites `dbb_profile_keys` (deploy-node.mjs passes the stored one back unless given) and, without
  `skipAppDashboard`, replaces the whole app dashboard configuration: read before you write.
- Every change: tests (`npm test`, `npm run test:e2e`), `npm run build:widgets`, a `DECISIONS.md` entry (next: D-059), a
  `docs/CHANGELOG.md` row; commit, push only when asked.
