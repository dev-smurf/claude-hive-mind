# Claude Hive Mind — Brainstorm Complet

## Le Probleme

Les AI coding assistants sont conçus pour un jeu single-player dans un monde multiplayer.

Chaque instance Claude Code, Cursor, Copilot fonctionne en isolation totale. Chacune croit être la seule intelligence sur le codebase. Chacune prend des décisions sans savoir ce qui s'est passé 30 secondes avant dans le terminal d'à côté.

**Résultat concret :** du code excellent produit en isolation ne compose PAS en un système excellent.

---

## Gap Analysis — Rien N'Existe

### Ce qu'on a analysé (50+ outils)

| Catégorie | Outils | Ce qu'ils font | Ce qu'ils ne font PAS |
|-----------|--------|---------------|----------------------|
| Multi-agent AI | Claude Agent Teams, Cursor Composer, Copilot /fleet | Un humain orchestre plusieurs agents | Plusieurs humains avec chacun leur AI |
| Orchestration | Ruflo (31K stars), CrewAI (50K), MetaGPT (67K), AutoGen (42K) | Frameworks multi-agents génériques | Aucune coordination codebase-aware en temps réel |
| Multi-instance | Claude Cognitive, Claude Orchestrator | Sync périodique (5 min), polling | Pas de temps réel, pas de conflict prevention |
| Session managers | Claude Squad, Superset (9K), OpenCode (95K) | Process management | Zero coordination sémantique |
| MCP servers | Multi-Agent Coordination MCP, Beads Village | File locking, task tracking | Pas d'awareness sémantique |
| Protocoles | MCP, A2A, ACP, AGENTS.md | Infrastructure de communication | Aucune sémantique de coordination coding-specific |

### Les 9 Gaps Que Personne Ne Comble

1. **Cross-developer real-time awareness** — aucun outil ne fait ça
2. **Tool-agnostic coordination** — pas de protocole universel Claude+Cursor+Copilot
3. **Semantic intent broadcasting** — les agents broadcast des file claims, jamais l'intention sémantique
4. **Shared discovery cache** — chaque AI relit tout le codebase indépendamment
5. **Architectural consistency enforcement** — AGENTS.md est statique, pas enforced
6. **Cross-tool conflict prediction** — conflits détectés au merge, pas avant le travail
7. **Multi-human, multi-agent topology** — aucun outil ne gère N humains × M agents
8. **Event-driven change streaming** — coordination actuelle = polling ou async mail
9. **Dependency impact analysis** — breaking changes découverts à la compilation, pas à l'édition

---

## Use Cases

### 1. Hackathon Teams (2-6 personnes)

**Sans coordination :**
- 2 AI créent `utils.ts` avec des exports conflictuels. Ni l'un ni l'autre ne sait que l'autre existe.
- Personne A scaffold auth avec JWT. Personne B scaffold auth avec session cookies. Les deux "réussissent" — le merge est un désastre.
- 3 instances ajoutent indépendamment `axios`, `node-fetch`, et `ky`. Trois HTTP clients.

**Coordination parfaite :**
- Avant qu'une AI écrive un fichier, toutes les autres savent ce qui est planifié.
- Décisions architecturales propagées en < 100ms. "On utilise JWT" = contrainte immédiate pour tous.
- Choix de dépendances visible et dédupliqué en temps réel.

### 2. Enterprise Teams (10+ devs, monorepo)

**Sans coordination :**
- Deux AI refactorent la même utility partagée dans des directions opposées. Les deux passent les tests locaux. Le merge casse 14 packages.
- Une AI modifie un schema GraphQL sans savoir que 3 autres écrivent des resolvers contre le schema actuel.
- Convention drift : Instance A suit les patterns établis, Instance B dérive vers un autre style.

**Coordination parfaite :**
- Dependency graph overlay en temps réel — avant de modifier un type partagé, tu vois "Ce type est consommé par les sessions actives de C, D, et F."
- Convention enforcement live. Quand Instance A établit un nouveau pattern (approuvé par son dev), toutes les autres l'adoptent.
- Shared test intelligence : une instance run la suite, toutes les autres ont les résultats immédiatement.

### 3. Solo Dev avec Agents Parallèles

**Sans coordination :**
- 4 Claude Code instances : frontend, backend API, DB migrations, tests. Le backend change la shape de la réponse API. Le frontend, lancé 30s avant, génère déjà des composants basés sur l'ancienne shape.
- Tu ne peux pas partir. Dès que tu arrêtes de sync manuellement le contexte entre terminaux, les instances produisent du code incompatible.

**Coordination parfaite :**
- Daemon local de coordination. Chaque file write, chaque décision architecturale, chaque nouveau type = broadcast à tous les peers en < 100ms.
- Context injection automatique : quand Instance 2 va générer du code API, elle reçoit un résumé de ce que Instance 3 vient de faire au DB layer.

### 4. Open Source Sprints

**Sans coordination :**
- 8 contributors, chacun avec AI, commencent simultanément. 3 refactorent indépendamment le même module.
- Le maintainer devient bottleneck — review/deconflict manuel de tout.

**Coordination parfaite :**
- Chaque AI déclare son issue assignée, son approche planifiée, et ses fichiers affectés. Tous les autres voient avant que le travail commence.
- Quand 2 AIs planifient de toucher le même module, alerte + suggestion de division du travail.

### 5. Pair Programming (2 humains, 2 AIs)

**Sans coordination :**
- "Split — toi le form, moi l'API." Les 2 AIs créent des request types différents. Le form submit des données que l'API n'attend pas.
- L'historique de conversation est splitté. Personne A a discuté une contrainte importante. L'AI de Personne B n'en sait rien.

**Coordination parfaite :**
- Shared type/interface registry — les 2 instances read/write.
- Décisions extraites automatiquement et propagées à l'autre session.

### 6. CI/CD Integration

**Sans coordination :**
- Un AI refactore un module pendant qu'un autre AI vient de trigger un deploy de la version courante.
- Un AI reviewer approuve un changement basé sur des tests qui passent, mais un autre agent a pushé un dependency update il y a 3 min — pas encore testé.

**Coordination parfaite :**
- Deploy state = signal first-class. Toutes les instances savent quand un deploy est en cours.
- Pre-deploy check qui agrège tout le travail non-commité de toutes les sessions actives.

### 7. Code Review (AI reviewer + AI writer)

**Sans coordination :**
- Le reviewer ne sait pas pourquoi le writer a fait certains choix. Flag "devrait utiliser Map" quand le writer a choisi Object pour la sérialisation JSON.

**Coordination parfaite :**
- Intent metadata attaché à chaque changement : le writer enregistre son raisonnement, le reviewer le lit avant de reviewer.
- Cross-PR awareness : le reviewer sait quels autres PRs existent et si ses suggestions conflicteraient.

### 8. Scenarios Additionnels

- **Multi-agent debugging** : 3 AI debug un issue. L'une ajoute de l'instrumentation qui invalide l'hypothèse de l'autre.
- **Migration projects** : JS → TS, REST → GraphQL. Instances font des choix incohérents sur les patterns.
- **Documentation** : Instances utilisent une terminologie incohérente, dupliquent les explications.
- **Incident response** : AI diagnose + AI fix + AI rollback + AI comms — sans coordination, fix et rollback vont dans des directions opposées.
- **Refactoring at scale** : Renommer "user" → "account" dans 10 packages. Sans coordination, packages à moitié renommés cassent le build.
- **Feature flags** : Instances créent des flags conflictuels ou dépendants sans le savoir.

---

## Features

### Primitives de Coordination Core

#### 1. Intent Broadcasting
Avant de travailler, une instance broadcast une intention structurée :
```json
{
  "instance_id": "abc-123",
  "action": "refactor",
  "scope": ["src/auth/middleware.ts", "src/auth/types.ts"],
  "description": "Replacing session-based auth with JWT",
  "estimated_duration": "5min",
  "dependencies_affected": ["src/api/*", "src/middleware/*"]
}
```
Chaque autre instance reçoit ça en < 100ms. Pas un lock — de l'awareness.

#### 2. File Activity Presence
Map temps réel de quels fichiers sont lus/écrits par quelles instances. Google Docs cursors, mais pour un codebase.

States par fichier :
- `idle` — aucune instance active
- `reading` — instance analyse ce fichier
- `planning` — instance prévoit modifier ce fichier
- `writing` — instance génère activement du contenu
- `reviewing` — instance review les changements

#### 3. Decision Log (ADRs Machine-Readable)
Log append-only de décisions architecturales :
```json
{
  "category": "dependency",
  "decision": "Use axios for HTTP client",
  "rationale": "Team familiarity, interceptor support",
  "constraints": ["Do not use node-fetch", "Do not use ky"]
}
```
Chaque instance check ce log avant de faire des choix dans la même catégorie.

#### 4. Conflict Prediction Engine
Avant d'écrire, une instance soumet ses changements planifiés. Le moteur répond :
```json
{
  "risk": "high",
  "conflicts": [
    {
      "file": "src/auth/types.ts",
      "reason": "Instance xyz-789 modified this file 45s ago",
      "suggestion": "Read latest version before proceeding"
    }
  ]
}
```

#### 5. Shared Context Stream
Résumé rolling de ce qui s'est passé, injecté automatiquement :
```
[Claude Hive Mind — last 5 min]
- Instance A (frontend): Created UserProfileCard, uses /api/users/:id
- Instance B (backend): Modified /api/users/:id → returns { id, email, role, avatar_url }
- Instance C (tests): 247/250 passing, 3 failures in auth.test.ts
- Decision #047: Using axios for HTTP (approved by @gabriel)
- Warning: src/shared/types.ts modified by 2 instances in last 3 min
```
Synthétisé, token-efficient. ~300-500 tokens.

#### 6. Token-Efficient Shared Analysis Cache
Instance A lit et analyse un fichier de 2000 lignes. Le résultat (structure, exports, types, patterns) est caché. Instance B reçoit le summary au lieu de relire le fichier. Sauve des milliers de tokens.

#### 7. Role Assignment et Domain Ownership
```json
{
  "instance-A": { "domain": "frontend", "owns": ["src/components/**"] },
  "instance-B": { "domain": "backend", "owns": ["src/api/**"] },
  "instance-C": { "domain": "data", "owns": ["src/db/**", "prisma/**"] },
  "instance-D": { "domain": "tests", "owns": ["tests/**"] }
}
```
Cross-domain changes trigger des notifications automatiques.

#### 8. Dependency Graph Awareness
Quand Instance A modifie un module, chaque instance dont le travail en dépend reçoit une notification avec le changement spécifique. Pas "something changed" — "le type `UserPayload` dans `src/auth/types.ts` a maintenant un champ `role` de type `string`."

#### 9. Shared Test Intelligence
Quand une instance run des tests, les résultats sont partagés instantanément.

#### 10. Convention Registry
Registre machine-readable des conventions du codebase — pas juste du linting, des patterns architecturaux, des conventions de nommage, des expectations structurelles.

#### 11. Progress Dashboard
TUI/Web temps réel : chaque instance active, son rôle, son activité, fichiers modifiés, conflits, décisions, tests, timeline.

#### 12. Rollback Coordination
Breakage détecté → toutes les instances notifiées → changements isolés → instances dépendantes pause → fix → signal "clear" → resume.

#### 13. Semantic Merge Intelligence
Au-delà du textual merge : comprendre quand 2 changements sont sémantiquement incompatibles même s'ils touchent des lignes différentes.

#### 14. Session Handoff Protocol
Quand une session finit, document structuré de handoff : completed, in_progress, blocked_on, context_critical, next_steps. La prochaine session reprend exactement où la dernière s'est arrêtée.

#### 15. Capability Advertisement
Chaque instance advertise ce qu'elle a en contexte. Quand une autre a besoin d'expertise sur un module déjà chargé, elle demande un summary au lieu de tout relire.

#### 16. Heartbeat et Health Monitoring
Instance silencieuse → warn les instances dépendantes → mark fichiers comme potentiellement incomplets → suggest takeover.

#### 17. Change Replay
Instance qui rejoint tard peut replay un historique compressé — pas des raw diffs, des résumés sémantiques.

---

## Pourquoi C'est Mieux Que Tout Le Reste

### vs Git branches
Git résout la divergence textuelle après coup. Claude Hive Mind prévient la divergence sémantique avant qu'elle arrive. Git est le version control. Claude Hive Mind est la coordination.

### vs Agent Teams
- Agent Teams = single-machine, single-session. Claude Hive Mind = cross-machine, cross-developer.
- Agent Teams = orchestrator bottleneck (context window du lead). Claude Hive Mind = out-of-band, ne consomme pas le context window.
- Agent Teams = se dissolvent quand la session finit. Claude Hive Mind = persistant.
- Agent Teams = homogène (Claude Code only). Claude Hive Mind = hétérogène (Claude + Cursor + Copilot + CI).

### vs Discord/Slack
Discord = 85 secondes par coordination event (compose + read + paste + process). Claude Hive Mind = 100ms, automatisé, structuré. À 20 events/heure, Discord coûte 28 min de temps humain/heure. Claude Hive Mind coûte zéro.

### vs Shared CLAUDE.md
- CLAUDE.md est statique (lu une fois au start). Claude Hive Mind est live.
- CLAUDE.md est non-structuré (natural language). Claude Hive Mind est queryable.
- CLAUDE.md n'a pas d'activity awareness. Claude Hive Mind sait qui touche à quoi en ce moment.
- CLAUDE.md a du write contention. Claude Hive Mind est un service.

### La Proposition de Valeur Unique

**Claude Hive Mind est le système nerveux du développement multi-agent.**

Pas le version control (squelette). Pas le chat (voix). Pas le task board (cerveau). Le système nerveux : le réseau de signaux rapide, involontaire, always-on qui assure que chaque partie de l'organisme sait ce que chaque autre partie fait, en temps réel, sans effort conscient.

| Layer | Quand ça opère |
|-------|---------------|
| Git | Après coup (au commit/merge) |
| Chat | À vitesse humaine |
| Agent Teams | Dans une seule session |
| CLAUDE.md | Au démarrage de session |
| CI/CD | Au commit |
| **Claude Hive Mind** | **À chaque keystroke** |

---

## Knowledge Store (RAG-lite)

Chaque instance qui analyse un fichier, découvre un pattern, ou comprend un schema — cette connaissance est stockée dans le serveur. Les autres instances query au lieu de tout relire.

```
Instance A lit src/api/routes.ts (2000 lignes, ~4000 tokens)
  → Stocke le résumé dans le Hive Mind (~200 tokens)

Instance B a besoin de comprendre l'API
  → Query le Hive Mind au lieu de relire 2000 lignes
  → Reçoit 200 tokens de résumé
  → Sauve 3800 tokens + temps d'analyse
```

**Structure du knowledge store :**
- `files/*` — résumés de fichiers (exports, imports, patterns, types clés)
- `api/*` — schemas d'endpoints, request/response shapes
- `decisions/*` — décisions architecturales
- `conventions/*` — patterns du codebase
- `bugs/*` — problèmes connus et workarounds

Chaque entrée a un hash du fichier source. Fichier changé = entrée invalidée.

**Impact :** 4 instances × 1 heure = 50K-100K tokens gaspillés en lecture dupliquée. Le knowledge store coupe ça de 80%+.

---

## Dashboard Visuel (Web)

Le serveur serve un frontend web sur `http://localhost:7777`. Tu ouvres dans ton browser et tu vois tout en temps réel via WebSocket.

**Graph central** — Chaque instance = un node. Les edges = relations.
- Ligne pleine = travaillent sur les mêmes fichiers
- Ligne pointillée = dépendance entre fichiers
- Rouge pulsé = conflit actif
- Vert = coordination clean
- Node qui fade = instance déconnectée

```
    ┌─────────────┐
    │ Claude A     │
    │ (frontend)   │──────────┐
    │ UserProfile  │          │ shared: types.ts
    └──────┬──────┘          │
           │                  │
    depends on API     ┌──────▼──────┐
           │           │ Claude C     │
    ┌──────▼──────┐    │ (shared)     │
    │ Claude B     │    │ types.ts     │
    │ (backend)    │────┘
    │ /api/users   │
    └──────┬──────┘
           │
    tests depend     ┌─────────────┐
           └────────►│ Codex D      │
                     │ (tests)      │
                     │ user.test.ts │
                     └─────────────┘
```

**Activity feed** — Timeline scrollable temps réel de tout ce qui se passe.

**File heatmap** — Arborescence du projet colorée par activité (gris=idle, bleu=1 instance, jaune=2+, rouge=conflit).

**Stats** — Tokens sauvés, conflits évités, décisions prises, throughput par instance.

---

## Comment Les Gens Se Connectent (Simplicité Maximale)

### Le principe : zéro config, un seul command

Le serveur est **embarqué dans le package npm**. Pas de Docker, pas de Redis, pas de config serveur. SQLite = un fichier. Le serveur = un process Node.js.

### Scénario 1 : Solo (tout local)

```bash
npx claude-hive-mind start
```

C'est tout. Le serveur tourne sur `localhost:7777`. Tu ouvres autant de Claude Code que tu veux sur ta machine, ils se connectent automatiquement via MCP. Zero config réseau.

### Scénario 2 : Avec des amis (réseau)

**Une seule personne fait ça :**
```bash
npx claude-hive-mind start --host 0.0.0.0
```

Ça affiche :
```
Claude Hive Mind running on port 7777
Share this with your team:

  npx claude-hive-mind join <ton-ip>:7777

Session token: chm_abc123def456
```

**Chaque ami fait ça :**
```bash
npx claude-hive-mind join 192.168.1.42:7777
```

Ça fait 3 choses automatiquement :
1. Configure le MCP server dans Claude Code settings
2. Installe les hooks PreToolUse/PostToolUse
3. Connecte au serveur et enregistre l'instance

**Pas de port forwarding si Tailscale/VPN.** Si tu es sur Tailscale, ton ami fait juste `npx claude-hive-mind join 100.124.84.120:7777`. Done.

### Scénario 3 : Avec des amis, sans VPN (Internet public)

Pour pas dealer avec le port forwarding, le NAT traversal, etc. :

**Option A : Tunnel gratuit (ngrok/cloudflared)**
```bash
npx claude-hive-mind start --tunnel
```

Ça auto-crée un tunnel et affiche :
```
Public URL: https://abc123.hive.run
Share this: npx claude-hive-mind join abc123.hive.run
```

Tes amis join avec l'URL publique. Zéro port forwarding.

**Option B : Hosted (futur V2)**
```bash
npx claude-hive-mind create-room
```

Le serveur tourne dans le cloud. Tout le monde join avec un room code. Comme un Google Meet pour du code.

### Ce qui se passe sous le capot

Quand tu fais `npx claude-hive-mind join <address>` :

1. **Télécharge le package** si pas déjà installé
2. **Authentifie** avec le session token (auto-prompt ou passé en arg)
3. **Détecte Claude Code** — trouve le settings.json
4. **Ajoute le MCP server** dans la config Claude Code :
   ```json
   {
     "mcpServers": {
       "hive-mind": {
         "type": "sse",
         "url": "http://<address>/mcp"
       }
     }
   }
   ```
5. **Installe les hooks** dans `.claude/settings.json` du projet :
   ```json
   {
     "hooks": {
       "PostToolUse": [{
         "matcher": "Write|Edit",
         "command": "chm report-edit \"$FILE_PATH\""
       }],
       "PreToolUse": [{
         "matcher": "Write|Edit",
         "command": "chm check \"$FILE_PATH\""
       }]
     }
   }
   ```
6. **Enregistre l'instance** — heartbeat, nom, rôle
7. **Affiche** : "Connected to Hive Mind (3 other instances active)"

**La prochaine fois que tu lances Claude Code** dans ce projet, les hooks et le MCP server sont déjà configurés. Reconnexion automatique.

### Pour les non-Claude-Code (Codex, Cursor, etc.)

```bash
npx claude-hive-mind join <address> --tool codex
```

Pas de MCP ni hooks (ces outils ne les supportent pas). À la place :
- Installe un **file watcher daemon** qui monitore les changements fichiers et les rapporte au serveur
- Le dashboard web montre quand même l'activité de cette instance
- L'intégration est moins profonde (advisory, pas de conflict blocking) mais l'awareness est là

### Résumé de la simplicité

| Action | Commande | Temps |
|--------|----------|-------|
| Lancer le serveur | `npx claude-hive-mind start` | 2 sec |
| Rejoindre (LAN/Tailscale) | `npx claude-hive-mind join <ip>:7777` | 3 sec |
| Rejoindre (Internet) | `npx claude-hive-mind join <url>` | 3 sec |
| Voir le dashboard | Ouvrir `http://localhost:7777` | 0 sec |
| Tout cleaner | `npx claude-hive-mind stop` | 1 sec |

**Zero Docker. Zero Redis. Zero config fichier manuel. Zero port forwarding (avec tunnel). Un npm package, deux commandes, c'est live.**

---

## Architecture Technique Recommandée

### Hybrid: MCP + Hooks + SQLite + REST + WebSocket

```
┌──────────────────────────────────────────────────┐
│              Claude Hive Mind Server                 │
│                                                  │
│  ┌─────────┐  ┌─────────┐  ┌──────────────────┐ │
│  │ MCP     │  │ REST    │  │ WebSocket        │ │
│  │ (SSE)   │  │ API     │  │ (push)           │ │
│  └────┬────┘  └────┬────┘  └────────┬─────────┘ │
│       └─────────┬──┘───────────────┘             │
│          ┌──────▼──────┐                         │
│          │ Coordination│                         │
│          │ Engine      │                         │
│          └──────┬──────┘                         │
│          ┌──────▼──────┐                         │
│          │ SQLite      │                         │
│          └─────────────┘                         │
└──────────────────────────────────────────────────┘
     ▲ MCP          ▲ REST hooks      ▲ WebSocket
     │              │                 │
  Claude Code    Claude Code       VS Code
  (MCP client)   (Hooks)          Extension
```

### Pourquoi ce combo

| Layer | Rôle | Pourquoi nécessaire |
|-------|------|---------------------|
| MCP server | Tools explicites de coordination | L'AI peut query l'état, déclarer des intents. Naturel pour LLMs. |
| Claude Code hooks | Tracking automatique + conflict gates | Chaque file write est tracké sans que l'AI ait besoin de se rappeler. |
| SQLite | State persistant | Survit aux crashes. Queryable. Zero dépendances externes. |
| REST API | Accès universel | Cursor, CLI, CI/CD — tout peut interagir via HTTP. |
| WebSocket | Push temps réel | Pour IDE extensions. Pas critique pour MVP. |

### Context Window Budget
- Tool definitions: ~800 tokens (4 tools compacts)
- Auto context injection: ~100 tokens (1 ligne de status)
- State query response: ~300-500 tokens (on demand)
- **Total overhead: ~1-2% d'un context window 128K.**

---

## Roadmap

### MVP (un weekend)
- Server Node.js : MCP (SSE) + REST
- SQLite single-file
- 4 MCP tools : `register`, `status`, `claim`, `release`
- 2 hooks Claude Code : PostToolUse (report edits), Stop (disconnect)
- Conflict detection : overlap simple
- CLI : `chm start`, `chm status`, `chm stop`
- Setup : `npx cloudhivemind init`

### V1 (6-8 semaines)
- Intent declarations + overlap detection
- Decision log + knowledge base + test state
- Dependency graph (manuel + auto-inferred imports)
- PreToolUse hooks (conflict blocking opt-in)
- VS Code extension
- Git hooks safety net
- Cross-machine (token auth + TLS)
- Dashboard TUI
- Offline journal + reconciliation

### V2+ (vision)
- AI-powered conflict resolution
- AST-based dependency graph (TS, Python, Go, Rust, Java)
- Predictive conflict detection
- Workload balancing suggestions
- GitHub/GitLab/Jira/Linear integration
- Web dashboard
- Plugin system
- Federation cross-team
- Claude Hive Mind as a service (hosted)

---

## Le Scaling

| Instances | Faisable? | Notes |
|-----------|-----------|-------|
| 2 | Trivial | Sweet spot pour pair programming |
| 5 | Oui | Sweet spot pour hackathons |
| 10 | Oui (avec optimisations) | Sweet spot pour enterprise teams |
| 20 | Possible | State filtering nécessaire |
| 50+ | Non recommandé | Over-engineered pour V1 |

---

## Multiplier Effect

| Instances | Sans Coordination | Avec Claude Hive Mind |
|-----------|------------------|---------------------|
| 1 | 2-3x | 2-3x |
| 2 | 3-4x (conflict overhead) | 5-6x |
| 4 | 4-5x (severe conflicts) | 10-12x |
| 8 | 4-6x (diminishing) | 18-24x |

Le gap s'élargit superlinéairement. À 8 instances, une équipe non-coordonnée est parfois PLUS LENTE que 4 instances. Une équipe coordonnée scale presque linéairement.
