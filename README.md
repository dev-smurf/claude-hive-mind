# Claude Hive Mind

[![CI](https://github.com/dev-smurf/claude-hive-mind/actions/workflows/ci.yml/badge.svg)](https://github.com/dev-smurf/claude-hive-mind/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-1f6feb.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-3fb950.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-5.x-3178c6.svg)](https://www.typescriptlang.org)
[![MCP](https://img.shields.io/badge/protocol-MCP-f97316.svg)](https://modelcontextprotocol.io/)
[![Dashboard](https://img.shields.io/badge/dashboard-live-ec4899.svg)](#quick-start)

Real-time coordination for multiple AI coding assistants working on the same codebase.

Claude Hive Mind gives Claude Code, Codex, Cursor, Copilot, Windsurf, or any custom client a shared coordination layer so they can behave like a team instead of five isolated terminals stepping on each other.

## Why This Exists

Modern AI coding workflows break down as soon as more than one assistant touches the same repo:

- Agents duplicate analysis because nobody knows what another agent already read.
- Two sessions edit the same file and only discover the conflict at merge time.
- Architectural decisions drift because each assistant reasons in a vacuum.
- Humans coordinating several assistants become the bottleneck.

Most "multi-agent" tools solve `one human -> many subagents`.

Claude Hive Mind solves a different problem:

`many humans + many assistants + one shared codebase`.

## What You Get

- **Agent registry**
  Every active assistant joins the hive, sends heartbeats, and shows up in the live dashboard.
- **File ownership**
  Agents claim files in `exclusive` or `shared` mode before editing, so collisions are visible before they become merge conflicts.
- **Task queue**
  Shared tasks with priorities, dependencies, assignment, completion, cancellation, and handoff.
- **Knowledge store**
  Agents can publish reusable findings so the same file does not need to be re-read five times.
- **Decision log**
  Architectural choices become explicit, queryable, and reviewable across the hive.
- **Conflict detection**
  Lock contention and contradictory decisions are surfaced immediately.
- **Messages**
  Direct messages and broadcasts for lightweight coordination between agents.
- **Live dashboard**
  See who joined, what they claimed, what they said, and where work is moving.

## Quick Start

### 1. Start a hive

```bash
npx claude-hive-mind start
```

That one command:

- starts the coordination server
- opens a Cloudflare quick tunnel
- creates a reusable invite URL
- prints the dashboard URL and the join link

### 2. Join from another machine or session

```bash
npx claude-hive-mind join "chms://your-public-url.trycloudflare.com#ABCD-1234"
```

### 3. Connect the current assistant session

```bash
npx claude-hive-mind connect
```

Once connected, the assistant can use hive tools such as:

- `hive_status`
- `hive_claim_file`
- `hive_create_task`
- `hive_assign_task`
- `hive_send_message`
- `hive_share_knowledge`
- `hive_log_decision`

## Typical Workflow

### Host

```bash
npx claude-hive-mind start
```

Share the printed `chms://...#CODE` invite with teammates or other machines.

### Teammate / second machine

```bash
npx claude-hive-mind join "chms://host.trycloudflare.com#ABCD-1234"
```

### Assistant behavior inside the hive

1. Connect to the hive.
2. Check `hive_status`.
3. Claim a file before editing.
4. Create or assign a task.
5. Send a message if coordination is needed.
6. Publish knowledge or decisions when useful.
7. Release claims when done.

## Core Concepts

### Exclusive vs shared claims

- `exclusive`
  One agent owns the file for editing.
- `shared`
  Multiple agents can coordinate around the same file when read-heavy work is acceptable.

### Public vs private reads

By default, a hive can expose read access for easy local/LAN demos.

If you want stricter access:

```bash
CHM_READ_ACCESS=required npx claude-hive-mind serve
```

### Join flow

Invites mint scoped join tokens. Agents register with a join token, then receive a per-agent token for ongoing operations. That keeps long-lived access narrower than using one admin credential everywhere.

## Architecture

Claude Hive Mind exposes three surfaces:

- **MCP stdio server**
  The main path for assistant-native tooling.
- **HTTP API**
  For registration, claims, tasks, messages, knowledge, and decisions.
- **WebSocket stream**
  For live dashboard updates and activity propagation.

```text
Claude / Codex / Cursor / Copilot
                |
        MCP / REST / WS
                |
        Claude Hive Mind
        ----------------
        Agent Registry
        File Ownership
        Task Queue
        Knowledge Store
        Decision Log
        Conflict Detection
                |
         SQLite + Dashboard
```

## CLI

```bash
# One-shot public demo mode
npx claude-hive-mind start

# Explicit server mode
npx claude-hive-mind serve --port 7777

# Redeem an invite and save the hive locally
npx claude-hive-mind join "chms://host.trycloudflare.com#ABCD-1234"

# Connect this session to a saved hive
npx claude-hive-mind connect

# See saved hives
npx claude-hive-mind hives
```

## Development

```bash
npm install
npm run build
npm test
npm run lint
npm run typecheck
```

Useful local commands:

```bash
# Server only
npm run build && node dist/cli.js serve

# Public one-shot demo
npm run build && node dist/cli.js start
```

## Status

This project is already usable for real multi-session demos and coordination experiments, but the surface area is still evolving. Expect active iteration on onboarding, client ergonomics, and deeper assistant integrations.

## License

[MIT](LICENSE)
