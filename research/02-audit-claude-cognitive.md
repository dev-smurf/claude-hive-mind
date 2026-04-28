# Audit: claude-cognitive
See agent output for full details. Key stats:
- ~3,500 lines Python, ~10,500 lines docs (75% docs, 25% code)
- Zero external deps (stdlib only), zero tests
- Attention decay algorithm: valuable (4-phase: decay→activate→co-activate→pinned)
- HOT/WARM/COLD tiered injection with budget management: valuable
- Pool system: JSONL append-only, file-based, 5-min polling (not real-time)
- v2.0 DAG architecture: design only, zero implementation
- Multi-instance: no real discovery, no heartbeat, no conflict detection
