# Team Project plugin

A Claude Code plugin for a shared team project: shared memory and decisions, work threads, a team chat answered by Claude, a file library, and a pane with all of it. It talks to a Team Project server; this repository holds only the plugin (published from the main repository, do not edit here).

## Install (Claude Desktop)

1. Connect the company VPN (the team server is `http://10.20.6.4:5080`).
2. Click **+** next to the prompt box → **Plugins** → **Add marketplace**, enter `warisorn888/team-project-plugin`, then **Add plugin** → `team-project`.
3. Set your token (ask the Team Project admin for one): run `/plugin configure team-project@team-project` and paste it into **API token**. **API base URL** is already the team server.
4. Open a session in a repository that the admin has bound to a project, then run `/team` to open the pane (`/team status` checks the link).

Terminal instead of Desktop:

```sh
claude plugin marketplace add warisorn888/team-project-plugin
claude plugin install team-project@team-project
```

Optional: `brew install gitleaks` to share thread transcripts and status cards (the plugin filters each turn for secrets with it first; without it, everything else still works).

## Update

Claude Code picks up new versions from the marketplace; in a session, `/plugin` → Marketplaces → update, then `/reload-plugins`.
