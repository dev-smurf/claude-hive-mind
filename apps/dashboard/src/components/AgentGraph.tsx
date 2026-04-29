import { useEffect, useRef, useState } from 'react';
import type { Agent } from '../lib/types';

interface AgentGraphProps {
  readonly agents: readonly Agent[];
}

interface Node {
  id: string;
  agent: Agent;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Spawn / leave animation phase: 0..1. */
  alpha: number;
  alphaTarget: number;
  /** Per-bubble breath phase offset so they don't pulse in sync. */
  phase: number;
}

const REPULSION = 28_000;
const CENTER_PULL = 0.018;
const BROWNIAN = 0.18;
const DAMPING = 0.86;
const MAX_VEL = 80;

/**
 * Hivemind visualization.
 *
 * Each connected agent is a bubble that floats in a force field: nodes
 * repel each other, are gently pulled toward the center, and pick up
 * tiny brownian noise so the whole arrangement breathes. Fully-connected
 * graph drawn with curved Bézier paths instead of straight mesh lines.
 *
 * No login, no neon, no rigid geometry. The vibe is "the hive is alive".
 */
export function AgentGraph({ agents }: AgentGraphProps): React.JSX.Element {
  const [size, setSize] = useState({ width: 1200, height: 800 });
  const [nodes, setNodes] = useState<Node[]>([]);
  const sizeRef = useRef(size);
  const lastTimeRef = useRef<number>(0);

  // Track viewport size.
  useEffect(() => {
    const update = (): void => {
      const next = { width: window.innerWidth, height: window.innerHeight - 60 };
      sizeRef.current = next;
      setSize(next);
    };
    update();
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
    };
  }, []);

  // Reconcile nodes when the agents list changes. Existing nodes keep
  // their positions; new agents spawn near the center; gone agents
  // ramp their alpha to 0 then are removed on the next reconcile.
  useEffect(() => {
    setNodes((prev) => {
      const liveIds = new Set(agents.map((a) => a.id));
      const byId = new Map(prev.map((n) => [n.id, n] as const));
      const next: Node[] = [];

      for (const agent of agents) {
        const existing = byId.get(agent.id);
        if (existing) {
          next.push({ ...existing, agent, alphaTarget: 1 });
        } else {
          // Spawn near the center with random small offset.
          const cx = sizeRef.current.width / 2;
          const cy = sizeRef.current.height / 2;
          const angle = Math.random() * Math.PI * 2;
          const r = 20 + Math.random() * 40;
          next.push({
            id: agent.id,
            agent,
            x: cx + Math.cos(angle) * r,
            y: cy + Math.sin(angle) * r,
            vx: Math.cos(angle) * 30,
            vy: Math.sin(angle) * 30,
            alpha: 0,
            alphaTarget: 1,
            phase: Math.random() * Math.PI * 2,
          });
        }
      }
      // Keep gone-but-fading nodes around briefly so they animate out.
      for (const n of prev) {
        if (!liveIds.has(n.id) && n.alpha > 0.01) {
          next.push({ ...n, alphaTarget: 0 });
        }
      }
      return next;
    });
  }, [agents]);

  // Animation loop: force simulation + alpha lerp.
  useEffect(() => {
    let raf = 0;
    const tick = (now: number): void => {
      const last = lastTimeRef.current || now;
      const dtMs = Math.min(50, now - last); // clamp for tab-switch hops
      lastTimeRef.current = now;

      setNodes((prev) => simulate(prev, sizeRef.current, dtMs));

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <svg
      viewBox={`0 0 ${String(size.width)} ${String(size.height)}`}
      preserveAspectRatio="xMidYMid meet"
      width={size.width}
      height={size.height}
    >
      <defs>
        {/* Warm glow around each bubble */}
        <radialGradient id="bubble-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="rgba(255, 138, 76, 0.55)" />
          <stop offset="35%" stopColor="rgba(217, 119, 87, 0.22)" />
          <stop offset="100%" stopColor="rgba(217, 119, 87, 0)" />
        </radialGradient>

        {/* Inner core of the bubble — like a cell membrane */}
        <radialGradient id="bubble-core" cx="35%" cy="32%" r="70%">
          <stop offset="0%" stopColor="#f4b89c" stopOpacity="0.95" />
          <stop offset="55%" stopColor="#d97757" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#7a3a26" stopOpacity="0.92" />
        </radialGradient>

        {/* Thread gradient — fades from one end to the other */}
        <linearGradient id="thread" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="rgba(217, 119, 87, 0)" />
          <stop offset="50%" stopColor="rgba(217, 119, 87, 0.18)" />
          <stop offset="100%" stopColor="rgba(217, 119, 87, 0)" />
        </linearGradient>

        {/* Soft Gaussian glow filter applied to the bubbles */}
        <filter id="soft-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="8" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>

        {/* Strong glow filter for the active core */}
        <filter id="core-glow" x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Curved threads between every pair of nodes */}
      <g className="threads">
        {nodes.flatMap((a, i) =>
          nodes.slice(i + 1).map((b) => {
            const opacity = Math.min(a.alpha, b.alpha) * 0.55;
            if (opacity < 0.01) return null;
            const path = curvedPath(a.x, a.y, b.x, b.y);
            return (
              <path
                key={`${a.id}-${b.id}`}
                d={path}
                fill="none"
                stroke="url(#thread)"
                strokeWidth={1}
                strokeLinecap="round"
                opacity={opacity}
              />
            );
          }),
        )}
      </g>

      {/* Bubbles */}
      <g className="bubbles">
        {nodes.map((n) => (
          <Bubble key={n.id} node={n} />
        ))}
      </g>
    </svg>
  );
}

function Bubble({ node }: { node: Node }): React.JSX.Element {
  const { x, y, agent, alpha, phase } = node;
  // Slow breath: subtle scale variation per bubble.
  const breath = 1 + Math.sin(phase + Date.now() / 1400) * 0.04;
  const initials =
    agent.displayName
      .split(/\s+/)
      .map((s) => s[0]?.toUpperCase() ?? '')
      .slice(0, 2)
      .join('') || '?';

  return (
    <g transform={`translate(${String(x)} ${String(y)}) scale(${String(breath)})`} opacity={alpha}>
      {/* Outer atmospheric glow */}
      <circle r={78} fill="url(#bubble-glow)" />

      {/* Mid layer — soft halo */}
      <circle r={52} fill="rgba(217, 119, 87, 0.1)" filter="url(#soft-glow)" />

      {/* The cell itself */}
      <circle r={34} fill="url(#bubble-core)" filter="url(#core-glow)" />

      {/* Subtle inner highlight ring for a glassy feel */}
      <circle r={34} fill="none" stroke="rgba(255, 220, 200, 0.15)" strokeWidth={1} />

      {/* Initials inside */}
      <text
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={14}
        fontWeight={500}
        letterSpacing="0.06em"
        fill="rgba(20, 10, 5, 0.85)"
        fontFamily="Inter, sans-serif"
      >
        {initials}
      </text>

      {/* Display name floating below */}
      <text
        y={62}
        textAnchor="middle"
        fontSize={12}
        fontWeight={500}
        letterSpacing="0.16em"
        fill="rgba(232, 228, 221, 0.85)"
        fontFamily="Inter, sans-serif"
        style={{ textTransform: 'uppercase' }}
      >
        {agent.displayName}
      </text>

      {/* Branch hint — discreet, monospace */}
      {agent.currentBranch !== null && agent.currentBranch !== undefined && (
        <text
          y={80}
          textAnchor="middle"
          fontSize={10}
          fill="rgba(217, 119, 87, 0.55)"
          fontFamily="JetBrains Mono, ui-monospace, monospace"
          letterSpacing="0.04em"
        >
          {agent.currentBranch}
        </text>
      )}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Force simulation
// ---------------------------------------------------------------------------

function simulate(
  prev: readonly Node[],
  size: { width: number; height: number },
  dtMs: number,
): Node[] {
  const dt = dtMs / 16; // normalize against ~60fps
  const cx = size.width / 2;
  const cy = size.height / 2;

  // Working copy
  const next: Node[] = prev.map((n) => ({ ...n }));

  // Pairwise repulsion
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
    // Pull toward center (with a small dead zone so things don't pile up)
    n.vx += (cx - n.x) * CENTER_PULL;
    n.vy += (cy - n.y) * CENTER_PULL;

    // Brownian noise for life
    n.vx += (Math.random() - 0.5) * BROWNIAN;
    n.vy += (Math.random() - 0.5) * BROWNIAN;

    // Clamp velocity
    const v = Math.hypot(n.vx, n.vy);
    if (v > MAX_VEL) {
      n.vx = (n.vx / v) * MAX_VEL;
      n.vy = (n.vy / v) * MAX_VEL;
    }

    // Integrate
    n.x += n.vx * dt;
    n.y += n.vy * dt;

    // Damping
    n.vx *= DAMPING;
    n.vy *= DAMPING;

    // Soft container — keep bubbles inside the visible area with some margin
    const margin = 100;
    if (n.x < margin) n.vx += (margin - n.x) * 0.05;
    if (n.x > size.width - margin) n.vx += (size.width - margin - n.x) * 0.05;
    if (n.y < margin) n.vy += (margin - n.y) * 0.05;
    if (n.y > size.height - margin) n.vy += (size.height - margin - n.y) * 0.05;

    // Alpha lerp (spawn / leave fade)
    const alphaSpeed = 0.08;
    n.alpha += (n.alphaTarget - n.alpha) * alphaSpeed;
  }

  // Drop nodes that finished fading out
  return next.filter((n) => n.alphaTarget > 0 || n.alpha > 0.02);
}

/**
 * Smooth quadratic Bézier between two points, with a control point pulled
 * perpendicular to the midpoint so the connection feels organic / vine-like.
 */
function curvedPath(x1: number, y1: number, x2: number, y2: number): string {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  // Perpendicular vector
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.hypot(dx, dy);
  if (dist === 0) return `M ${String(x1)} ${String(y1)}`;
  const px = -dy / dist;
  const py = dx / dist;
  // Curvature scales with distance so close nodes have gentle curves and
  // far nodes get more pronounced arcs.
  const curve = Math.min(80, dist * 0.18);
  const cx = mx + px * curve;
  const cy = my + py * curve;
  return `M ${String(x1)} ${String(y1)} Q ${String(cx)} ${String(cy)} ${String(x2)} ${String(y2)}`;
}
