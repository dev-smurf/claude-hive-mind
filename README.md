# Claude Hive Mind

[![CI](https://github.com/dev-smurf/claude-hive-mind/actions/workflows/ci.yml/badge.svg)](https://github.com/dev-smurf/claude-hive-mind/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org)

Real-time coordination layer for multiple AI coding assistant instances.

## The Problem

When multiple developers use AI coding assistants (Claude Code, Cursor, Copilot, Codex) on the same codebase, each instance operates in complete isolation. They duplicate work, create merge conflicts, make contradictory architectural decisions, and waste tokens re-reading files that another instance already analyzed.

**No existing tool solves this.** We audited 50+ tools across 6 categories. Every one coordinates "one human, multiple agents." None handle "multiple humans, each with their own AI, needing real-time cross-tool awareness."

## What Claude Hive Mind Does

Claude Hive Mind connects all AI instances working on a codebase into a shared coordination layer:

- **Agent Registry** — Every instance registers and sends heartbeats. Everyone knows who's active.
- **File Ownership** — Claim files before editing. Conflicts detected before they happen, not at merge time.
- **Task Queue** — Shared task board with dependencies. No duplicated work.
- **Knowledge Store** — Share analysis results across instances. Read a file once, everyone benefits.
- **Decision Log** — Architectural decisions recorded and enforced. No decision drift.
- **Conflict Detection** — Real-time alerts when two instances might interfere with each other.
- **Dashboard** — Visual overview of all activity, ownership, and conflicts.

## Quick Start

```bash
# Start the coordination server
npx claude-hive-mind start

# On another machine, join the hive
npx claude-hive-mind join <server-ip>
```

## Architecture

Claude Hive Mind runs as an MCP server that AI assistants connect to via the Model Context Protocol. It also exposes a REST API and WebSocket endpoint for tool-agnostic integration.

```
┌────────────-─┐  ┌─────────────┐  ┌─────────────┐
│ Claude Code  │  │   Cursor    │  │   Copilot   │
│  Instance A  │  │  Instance B │  │  Instance C │
└──────┬───────┘  └──────┬──────┘  └──────┬──────┘
       │ MCP             │ REST           │ REST
       └────────┬────────┴────────┬───────┘
                │                 │
         ┌──────▼─────────────────▼──────┐
         │      Claude Hive Mind         │
         │   ┌─────────────────────┐     │
         │   │  Coordination Core  │     │
         │   │  ─────────────────  │     │
         │   │  Agent Registry     │     │
         │   │  File Ownership     │     │
         │   │  Task Queue         │     │
         │   │  Knowledge Store    │     │
         │   │  Decision Log       │     │
         │   │  Conflict Detector  │     │
         │   └─────────────────────┘     │
         │   ┌──────────┐ ┌───────────┐  │
         │   │  SQLite  │ │ Dashboard │  │
         │   └──────────┘ └───────────┘  │
         └───────────────────────────────┘
```

## Development

```bash
# Install dependencies
npm install

# Run in development mode (hot reload)
npm run dev

# Build
npm run build

# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Lint
npm run lint

# Type check
npm run typecheck

# Format
npm run format
```

## License

[MIT](LICENSE)
