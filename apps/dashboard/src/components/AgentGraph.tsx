import { useEffect, useRef, useState } from 'react';
import type { Agent } from '../lib/types';

// Official AI brand logos from @lobehub/icons-static-svg (MIT-licensed,
// purpose-built for showing AI tool/LLM marks in dashboards). Vite emits
// each as a versioned static asset; we reference them via <image href>.
import claudeIconUrl from '@lobehub/icons-static-svg/icons/claude-color.svg?url';
import codexIconUrl from '@lobehub/icons-static-svg/icons/codex.svg?url';
import cursorIconUrl from '@lobehub/icons-static-svg/icons/cursor.svg?url';
import copilotIconUrl from '@lobehub/icons-static-svg/icons/githubcopilot.svg?url';
import windsurfIconUrl from '@lobehub/icons-static-svg/icons/windsurf.svg?url';

/**
 * A communication event between agents, used to animate edges/rings on the
 * graph. `toId === null` means the event is a broadcast (decision logged,
 * knowledge shared) and ripples out from the sender.
 */
export interface CommPing {
  readonly id: string;
  readonly kind: 'message' | 'decision' | 'knowledge';
  readonly fromId: string;
  readonly toId: string | null;
  /** performance.now() at time of arrival. */
  readonly startTs: number;
}

export const PING_DURATION_MS = 1400;

/**
 * Live activity inferred from the agent's recent MCP-tool calls. Drives the
 * little thought-bubble that appears above each node.
 */
export type ActivityKind = 'talking' | 'thinking' | 'editing' | 'sharing';

export interface AgentActivity {
  readonly kind: ActivityKind;
  /** performance.now() when the activity was last refreshed. */
  readonly since: number;
}

export const ACTIVITY_DURATION_MS = 10_000;
const ACTIVITY_FADE_START_MS = 7_000;

const ACTIVITY_LABEL: Record<ActivityKind, string> = {
  talking: 'talking',
  thinking: 'thinking',
  editing: 'editing',
  sharing: 'sharing',
};

const ACTIVITY_COLOR: Record<ActivityKind, string> = {
  talking: 'var(--color-accent)',
  thinking: 'var(--color-st-busy)',
  editing: '#7c5cff',
  sharing: 'var(--color-st-active)',
};

interface AgentGraphProps {
  readonly agents: readonly Agent[];
  readonly selectedId: string | null;
  readonly onSelectAgent: (id: string | null) => void;
  readonly pings: readonly CommPing[];
  readonly activities: ReadonlyMap<string, AgentActivity>;
}

const CLICK_DRAG_THRESHOLD = 4; // pixels — below this, treat pointerup as a click

const PING_COLOR: Record<CommPing['kind'], string> = {
  message: 'var(--color-accent)',
  decision: 'var(--color-st-busy)',
  knowledge: 'var(--color-st-active)',
};

interface Node {
  id: string;
  agent: Agent;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const REPULSION = 65_000;
const CENTER_PULL = 0.04;
const DAMPING = 0.78;
const SETTLE_THRESHOLD = 0.12;
const NODE_RADIUS = 28;

const STATUS_COLOR: Record<string, string> = {
  active: 'var(--color-st-active)',
  busy: 'var(--color-st-busy)',
  idle: 'var(--color-st-idle)',
  disconnected: 'var(--color-st-disconnected)',
};

/**
 * Resolve the official brand-logo URL for a given tool slug. Falls back to
 * null for unknown tools — NodeView then renders the agent's initials.
 */
function toolIconUrl(tool: string): string | null {
  const t = tool.toLowerCase();
  if (t.includes('claude')) return claudeIconUrl;
  if (t === 'codex' || t.includes('openai') || t.includes('gpt')) return codexIconUrl;
  if (t.includes('cursor')) return cursorIconUrl;
  if (t.includes('copilot') || t.includes('github')) return copilotIconUrl;
  if (t.includes('windsurf')) return windsurfIconUrl;
  return null;
}

const ICON_SIZE = 26;

export function AgentGraph({
  agents,
  selectedId,
  onSelectAgent,
  pings,
  activities,
}: AgentGraphProps): React.JSX.Element {
  const [size, setSize] = useState({ width: 1200, height: 720 });
  const [nodes, setNodes] = useState<Node[]>([]);
  const sizeRef = useRef(size);
  const settlingRef = useRef(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);
  /** Pointer-down state, captured before we know if it'll become a drag. */
  const pressRef = useRef<{ id: string; startX: number; startY: number; pointerId: number } | null>(
    null,
  );
  const [draggingId, setDraggingId] = useState<string | null>(null);
  /** Bumped each animation frame while pings are in flight, to drive re-render. */
  const [, setPingFrame] = useState(0);

  useEffect(() => {
    const update = (): void => {
      const next = { width: window.innerWidth, height: window.innerHeight - 57 };
      sizeRef.current = next;
      setSize(next);
    };
    update();
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
    };
  }, []);

  useEffect(() => {
    setNodes((prev) => {
      const liveIds = new Set(agents.map((a) => a.id));
      const byId = new Map(prev.map((n) => [n.id, n] as const));
      const next: Node[] = [];

      for (let i = 0; i < agents.length; i++) {
        const agent = agents[i];
        if (!agent) continue;
        const existing = byId.get(agent.id);
        if (existing) {
          next.push({ ...existing, agent });
        } else {
          const cx = sizeRef.current.width / 2;
          const cy = sizeRef.current.height / 2;
          const angle = (i / Math.max(1, agents.length)) * Math.PI * 2;
          const r = Math.min(sizeRef.current.width, sizeRef.current.height) * 0.18;
          next.push({
            id: agent.id,
            agent,
            x: cx + Math.cos(angle) * r + (Math.random() - 0.5) * 30,
            y: cy + Math.sin(angle) * r + (Math.random() - 0.5) * 30,
            vx: 0,
            vy: 0,
          });
        }
      }
      return next.filter((n) => liveIds.has(n.id));
    });
    settlingRef.current = true;
  }, [agents]);

  useEffect(() => {
    settlingRef.current = true;
  }, [size.width, size.height]);

  useEffect(() => {
    let raf = 0;
    const tick = (): void => {
      raf = requestAnimationFrame(tick);
      if (!settlingRef.current) return;

      setNodes((prev) => {
        if (prev.length === 0) {
          settlingRef.current = false;
          return prev;
        }
        const next = simulate(prev, sizeRef.current, dragRef.current?.id ?? null);
        const energy = next.reduce((s, n) => s + n.vx * n.vx + n.vy * n.vy, 0);
        if (energy < SETTLE_THRESHOLD && dragRef.current === null) {
          settlingRef.current = false;
        }
        return next;
      });
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, []);

  // Separate animation loop for pings + thought-bubble fades. Runs only
  // while there's something live; bumps a tick state each frame so SVG
  // re-renders with fresh interpolation values.
  useEffect(() => {
    const animating = pings.length > 0 || activities.size > 0;
    if (!animating) return;
    let raf = 0;
    const tick = (): void => {
      setPingFrame((f) => (f + 1) % 1_000_000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [pings.length === 0, activities.size === 0]);

  const clientToSvg = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const sx = (clientX - rect.left) * (size.width / rect.width);
    const sy = (clientY - rect.top) * (size.height / rect.height);
    return { x: sx, y: sy };
  };

  const handleNodePointerDown = (e: React.PointerEvent<SVGGElement>, node: Node): void => {
    e.preventDefault();
    e.stopPropagation();
    pressRef.current = {
      id: node.id,
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
    };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<SVGGElement>): void => {
    const press = pressRef.current;

    // Promote a press into a drag once the pointer moves past the threshold.
    if (press !== null && dragRef.current === null) {
      const dx = e.clientX - press.startX;
      const dy = e.clientY - press.startY;
      if (dx * dx + dy * dy >= CLICK_DRAG_THRESHOLD * CLICK_DRAG_THRESHOLD) {
        const pt = clientToSvg(e.clientX, e.clientY);
        if (!pt) return;
        const node = nodes.find((n) => n.id === press.id);
        if (!node) return;
        dragRef.current = {
          id: press.id,
          dx: node.x - pt.x,
          dy: node.y - pt.y,
        };
        setDraggingId(press.id);
        settlingRef.current = true;
      }
    }

    const drag = dragRef.current;
    if (!drag) return;
    const pt = clientToSvg(e.clientX, e.clientY);
    if (!pt) return;
    const margin = NODE_RADIUS + 4;
    const tx = Math.max(margin, Math.min(size.width - margin, pt.x + drag.dx));
    const ty = Math.max(margin, Math.min(size.height - margin, pt.y + drag.dy));
    setNodes((prev) =>
      prev.map((n) => (n.id === drag.id ? { ...n, x: tx, y: ty, vx: 0, vy: 0 } : n)),
    );
    settlingRef.current = true;
  };

  const handlePointerUp = (e: React.PointerEvent<SVGGElement>): void => {
    const press = pressRef.current;
    const wasDrag = dragRef.current !== null;

    // Pure click — release happened without ever crossing the drag threshold.
    if (press !== null && !wasDrag) {
      onSelectAgent(press.id === selectedId ? null : press.id);
    }

    pressRef.current = null;
    dragRef.current = null;
    if (wasDrag) {
      setDraggingId(null);
      settlingRef.current = true;
    }
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      // Pointer was already released — fine.
    }
  };

  const handleSvgPointerDown = (e: React.PointerEvent<SVGSVGElement>): void => {
    // Click on the empty stage closes the selection.
    if (e.target === svgRef.current && selectedId !== null) {
      onSelectAgent(null);
    }
  };

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${String(size.width)} ${String(size.height)}`}
      preserveAspectRatio="xMidYMid meet"
      width={size.width}
      height={size.height}
      style={{ touchAction: 'none', userSelect: 'none' }}
      onPointerDown={handleSvgPointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <g className="threads">
        {nodes.flatMap((a, i) =>
          nodes.slice(i + 1).map((b) => (
            <line
              key={`${a.id}-${b.id}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke="var(--color-border-strong)"
              strokeWidth={1}
              strokeOpacity={0.6}
            />
          )),
        )}
      </g>

      <g className="pings" style={{ pointerEvents: 'none' }}>
        {pings.map((p) => {
          const from = nodes.find((n) => n.id === p.fromId);
          if (!from) return null;
          const t = Math.min(1, (performance.now() - p.startTs) / PING_DURATION_MS);
          const color = PING_COLOR[p.kind];

          if (p.toId === null) {
            // Broadcast — expanding ring from the sender that fades out.
            const r = NODE_RADIUS + 4 + t * 110;
            const opacity = (1 - t) * 0.55;
            return (
              <circle
                key={p.id}
                cx={from.x}
                cy={from.y}
                r={r}
                fill="none"
                stroke={color}
                strokeWidth={1.5}
                strokeOpacity={opacity}
              />
            );
          }

          const to = nodes.find((n) => n.id === p.toId);
          if (!to) return null;
          const dx = to.x - from.x;
          const dy = to.y - from.y;
          const len = Math.sqrt(dx * dx + dy * dy);
          if (len < 1) return null;
          const ux = dx / len;
          const uy = dy / len;
          // Travel from edge of sender to edge of receiver, not centre to centre.
          const startX = from.x + ux * NODE_RADIUS;
          const startY = from.y + uy * NODE_RADIUS;
          const endX = to.x - ux * NODE_RADIUS;
          const endY = to.y - uy * NODE_RADIUS;
          const px = startX + (endX - startX) * t;
          const py = startY + (endY - startY) * t;
          return (
            <g key={p.id}>
              <line
                x1={startX}
                y1={startY}
                x2={endX}
                y2={endY}
                stroke={color}
                strokeWidth={1.5}
                strokeOpacity={(1 - t) * 0.5}
              />
              <circle cx={px} cy={py} r={4} fill={color} opacity={1 - t * 0.4} />
            </g>
          );
        })}
      </g>

      <g className="nodes">
        {nodes.map((n) => (
          <NodeView
            key={n.id}
            node={n}
            isDragging={draggingId === n.id}
            isSelected={selectedId === n.id}
            activity={activities.get(n.id) ?? null}
            onPointerDown={handleNodePointerDown}
          />
        ))}
      </g>
    </svg>
  );
}

interface NodeViewProps {
  readonly node: Node;
  readonly isDragging: boolean;
  readonly isSelected: boolean;
  readonly activity: AgentActivity | null;
  readonly onPointerDown: (e: React.PointerEvent<SVGGElement>, node: Node) => void;
}

function NodeView({
  node,
  isDragging,
  isSelected,
  activity,
  onPointerDown,
}: NodeViewProps): React.JSX.Element {
  const { x, y, agent } = node;
  const iconUrl = toolIconUrl(agent.tool);
  const initials =
    agent.displayName
      .split(/\s+/)
      .map((s) => s[0]?.toUpperCase() ?? '')
      .slice(0, 2)
      .join('') || '?';
  const statusColor = STATUS_COLOR[agent.status] ?? STATUS_COLOR.disconnected;
  const elevated = isDragging || isSelected;

  return (
    <g
      transform={`translate(${String(x)} ${String(y)})`}
      onPointerDown={(e) => onPointerDown(e, node)}
      style={{
        cursor: isDragging ? 'grabbing' : 'grab',
        transition: isDragging ? 'none' : 'transform 80ms linear',
      }}
    >
      <circle r={NODE_RADIUS + 6} fill="transparent" />

      {isSelected && (
        <circle
          r={NODE_RADIUS + 4}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth={2}
          strokeOpacity={0.85}
        />
      )}

      <circle
        r={NODE_RADIUS}
        fill="var(--color-surface)"
        stroke={isSelected ? 'var(--color-accent)' : 'var(--color-border-strong)'}
        strokeWidth={elevated ? 1.5 : 1}
        style={{
          filter: elevated ? 'drop-shadow(0 4px 10px rgba(0,0,0,0.12))' : undefined,
          transition: 'stroke-width 120ms ease, filter 120ms ease, stroke 120ms ease',
        }}
      />

      {iconUrl !== null ? (
        <image
          href={iconUrl}
          x={-ICON_SIZE / 2}
          y={-ICON_SIZE / 2}
          width={ICON_SIZE}
          height={ICON_SIZE}
          preserveAspectRatio="xMidYMid meet"
          style={{ pointerEvents: 'none' }}
        />
      ) : (
        <text
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={12}
          fontWeight={500}
          letterSpacing="0.02em"
          fill="var(--color-text)"
          style={{ pointerEvents: 'none' }}
        >
          {initials}
        </text>
      )}

      <circle
        cx={NODE_RADIUS - 4}
        cy={-NODE_RADIUS + 4}
        r={4}
        fill={statusColor}
        stroke="var(--color-surface)"
        strokeWidth={1.5}
        style={{ pointerEvents: 'none' }}
      />

      <text
        y={NODE_RADIUS + 18}
        textAnchor="middle"
        fontSize={12}
        fontWeight={500}
        fill="var(--color-text)"
        style={{ pointerEvents: 'none' }}
      >
        {agent.displayName}
      </text>

      {agent.currentBranch !== null && agent.currentBranch !== undefined && (
        <text
          y={NODE_RADIUS + 33}
          textAnchor="middle"
          fontSize={11}
          fill="var(--color-muted)"
          fontFamily="JetBrains Mono, ui-monospace, monospace"
          style={{ pointerEvents: 'none' }}
        >
          {agent.currentBranch}
        </text>
      )}

      {activity !== null && <ThoughtBubble activity={activity} />}
    </g>
  );
}

/**
 * Small pill above a node showing the agent's current activity ("thinking",
 * "editing", etc.). Inferred from recent MCP-tool calls — no LLM polling.
 * Two stacked dots between the pill and the bubble give it a thought-bubble
 * silhouette without going cartoonish.
 */
function ThoughtBubble({ activity }: { activity: AgentActivity }): React.JSX.Element | null {
  const age = performance.now() - activity.since;
  if (age >= ACTIVITY_DURATION_MS) return null;

  const opacity =
    age < ACTIVITY_FADE_START_MS
      ? 1
      : 1 - (age - ACTIVITY_FADE_START_MS) / (ACTIVITY_DURATION_MS - ACTIVITY_FADE_START_MS);

  // Tiny in-out scale on the very first frames so the bubble doesn't pop.
  const enter = Math.min(1, age / 180);
  const scale = 0.85 + 0.15 * enter;

  const label = ACTIVITY_LABEL[activity.kind];
  const color = ACTIVITY_COLOR[activity.kind];
  const charWidth = 6.4;
  const padX = 9;
  const width = Math.max(56, Math.round(label.length * charWidth + padX * 2));
  const height = 20;
  const yOffset = -(NODE_RADIUS + 28);

  return (
    <g
      transform={`translate(0 ${String(yOffset)}) scale(${String(scale)})`}
      style={{ pointerEvents: 'none', opacity, transition: 'opacity 200ms ease' }}
    >
      {/* Two trailing dots — the classic thought-bubble tail */}
      <circle cx={-9} cy={NODE_RADIUS - 4} r={2.2} fill="var(--color-surface)" stroke={color} strokeWidth={1} />
      <circle cx={-4} cy={NODE_RADIUS - 14} r={3} fill="var(--color-surface)" stroke={color} strokeWidth={1} />

      <rect
        x={-width / 2}
        y={-height / 2}
        width={width}
        height={height}
        rx={height / 2}
        fill="var(--color-surface)"
        stroke={color}
        strokeWidth={1.25}
      />
      <circle cx={-width / 2 + padX + 1} cy={0} r={2.5} fill={color} />
      <text
        x={-width / 2 + padX + 8}
        y={0.5}
        dominantBaseline="central"
        fontSize={11}
        fontWeight={500}
        fill="var(--color-text)"
      >
        {label}
      </text>
    </g>
  );
}

function simulate(
  prev: readonly Node[],
  size: { width: number; height: number },
  pinnedId: string | null,
): Node[] {
  const cx = size.width / 2;
  const cy = size.height / 2;
  const next: Node[] = prev.map((n) => ({ ...n }));

  // Pairwise repulsion — applied to all nodes (the pinned node still pushes others away)
  for (let i = 0; i < next.length; i++) {
    for (let j = i + 1; j < next.length; j++) {
      const a = next[i];
      const b = next[j];
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist2 = dx * dx + dy * dy + 1;
      const dist = Math.sqrt(dist2);
      const force = REPULSION / dist2;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx -= fx;
      a.vy -= fy;
      b.vx += fx;
      b.vy += fy;
    }
  }

  for (const n of next) {
    if (n.id === pinnedId) {
      // Held by the user — don't move it, don't accumulate velocity.
      n.vx = 0;
      n.vy = 0;
      continue;
    }

    n.vx += (cx - n.x) * CENTER_PULL;
    n.vy += (cy - n.y) * CENTER_PULL;

    n.x += n.vx * 0.016;
    n.y += n.vy * 0.016;

    n.vx *= DAMPING;
    n.vy *= DAMPING;

    const margin = 80;
    if (n.x < margin) n.vx += (margin - n.x) * 0.1;
    if (n.x > size.width - margin) n.vx += (size.width - margin - n.x) * 0.1;
    if (n.y < margin) n.vy += (margin - n.y) * 0.1;
    if (n.y > size.height - margin) n.vy += (size.height - margin - n.y) * 0.1;
  }

  return next;
}
