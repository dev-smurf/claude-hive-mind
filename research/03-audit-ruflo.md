# Audit: Ruflo (claude-flow)
See agent output for full details. Key stats:
- 33K stars, 10,138 files, ~884K lines code + ~886K lines docs
- 50% docs/marketing, 50% code. 134 "skills" are just markdown prompts.
- Consensus voting = Math.random(). Compression = substring truncation (fake).
- HNSW vector index: legitimate, 1,209 lines pure TS (valuable)
- Hook handler: battle-tested with safety timeouts (valuable)
- Settings.json hook config: complete template for all hook types (valuable)
- Queen/Workers: SQLite polling loops, not distributed
- Heavy dep on author's own npm ecosystem (circular)
