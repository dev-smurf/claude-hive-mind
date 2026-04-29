import { useEffect, useState } from 'react';
import type { Agent } from '../lib/types';

interface AgentGraphProps {
  readonly agents: readonly Agent[];
}

const STATUS_COLOR: Record<string, string> = {
  active: '#4ade80',
  busy: '#fbbf24',
  idle: '#60a5fa',
  disconnected: '#6b7280',
};

const TOOL_LABEL: Record<string, string> = {
  'claude-code': 'CC',
  cursor: 'CR',
  copilot: 'CP',
  codex: 'CX',
  windsurf: 'WS',
  other: '··',
};

/**
 * Big-screen visualization: agents are bubbles arranged in a soft circle
 * around the center. Bubbles connect to every other bubble (mesh) with
 * faint lines, evoking the "hive" structure. Newly joined agents fade in;
 * leaving agents fade out before they're removed.
 *
 * Layout is computed deterministically from the current agent set, so
 * positions are stable across re-renders.
 */
export function AgentGraph({ agents }: AgentGraphProps): React.JSX.Element {
  const [size, setSize] = useState({ width: 1200, height: 800 });

  useEffect(() => {
    const onResize = (): void => {
      setSize({
        width: window.innerWidth,
        height: window.innerHeight - 56, // header height
      });
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, []);

  const cx = size.width / 2;
  const cy = size.height / 2;
  const radius = Math.min(size.width, size.height) * 0.32;

  // Stable position per agent: even spacing on a circle. With 1 agent, place
  // it at the center. The angle is offset slightly so the first bubble sits
  // at the top.
  const positions = agents.map((_agent, i) => {
    if (agents.length === 1) return { x: cx, y: cy };
    const angle = (i / agents.length) * Math.PI * 2 - Math.PI / 2;
    return {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
    };
  });

  return (
    <svg
      viewBox={`0 0 ${size.width} ${size.height}`}
      preserveAspectRatio="xMidYMid meet"
      width={size.width}
      height={size.height}
    >
      <defs>
        <radialGradient id="bubble-active" cx="35%" cy="35%" r="65%">
          <stop offset="0%" stopColor="rgba(74, 222, 128, 0.35)" />
          <stop offset="60%" stopColor="rgba(74, 222, 128, 0.12)" />
          <stop offset="100%" stopColor="rgba(74, 222, 128, 0.04)" />
        </radialGradient>
        <radialGradient id="bubble-busy" cx="35%" cy="35%" r="65%">
          <stop offset="0%" stopColor="rgba(251, 191, 36, 0.35)" />
          <stop offset="60%" stopColor="rgba(251, 191, 36, 0.12)" />
          <stop offset="100%" stopColor="rgba(251, 191, 36, 0.04)" />
        </radialGradient>
        <radialGradient id="bubble-idle" cx="35%" cy="35%" r="65%">
          <stop offset="0%" stopColor="rgba(96, 165, 250, 0.35)" />
          <stop offset="60%" stopColor="rgba(96, 165, 250, 0.12)" />
          <stop offset="100%" stopColor="rgba(96, 165, 250, 0.04)" />
        </radialGradient>
        <radialGradient id="bubble-disconnected" cx="35%" cy="35%" r="65%">
          <stop offset="0%" stopColor="rgba(107, 114, 128, 0.25)" />
          <stop offset="60%" stopColor="rgba(107, 114, 128, 0.08)" />
          <stop offset="100%" stopColor="rgba(107, 114, 128, 0.02)" />
        </radialGradient>

        <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="6" result="coloredBlur" />
          <feMerge>
            <feMergeNode in="coloredBlur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Mesh lines between every pair of agents */}
      <g className="graph-edges">
        {agents.flatMap((_a, i) =>
          agents.slice(i + 1).map((_b, j) => {
            const a = positions[i];
            const b = positions[i + 1 + j];
            if (!a || !b) return null;
            return (
              <line
                key={`edge-${String(i)}-${String(i + 1 + j)}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="rgba(255, 255, 255, 0.04)"
                strokeWidth={1}
              />
            );
          }),
        )}
      </g>

      {/* Agent bubbles */}
      <g className="graph-nodes">
        {agents.map((agent, i) => {
          const pos = positions[i];
          if (!pos) return null;
          const color = STATUS_COLOR[agent.status] ?? STATUS_COLOR.disconnected!;
          const gradient = `bubble-${agent.status}`;
          const initials =
            agent.displayName
              .split(/\s+/)
              .map((s) => s[0]?.toUpperCase() ?? '')
              .slice(0, 2)
              .join('') || '?';

          return (
            <g
              key={agent.id}
              transform={`translate(${String(pos.x)} ${String(pos.y)})`}
              className="bubble"
            >
              {/* Outer glow circle */}
              <circle r={64} fill={`url(#${gradient})`} filter="url(#glow)" />
              {/* Inner solid disk */}
              <circle r={36} fill="#161b28" stroke={color} strokeWidth={1.5} />
              {/* Initials */}
              <text
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={14}
                fontWeight={600}
                fill="#e6e9ef"
                fontFamily="Inter, sans-serif"
              >
                {initials}
              </text>
              {/* Tool tag */}
              <text
                y={52}
                textAnchor="middle"
                fontSize={10}
                fill={color}
                fontFamily="Inter, sans-serif"
                letterSpacing="0.05em"
              >
                {TOOL_LABEL[agent.tool] ?? '··'}
              </text>
              {/* Display name */}
              <text
                y={75}
                textAnchor="middle"
                fontSize={13}
                fontWeight={500}
                fill="#e6e9ef"
                fontFamily="Inter, sans-serif"
              >
                {agent.displayName}
              </text>
              {/* Branch hint if known */}
              {agent.currentBranch !== null && (
                <text
                  y={92}
                  textAnchor="middle"
                  fontSize={11}
                  fill="#5a6072"
                  fontFamily="JetBrains Mono, Menlo, monospace"
                >
                  {agent.currentBranch}
                </text>
              )}
            </g>
          );
        })}
      </g>

      <style>{`
        .bubble {
          opacity: 0;
          animation: bubble-in 280ms ease-out forwards;
          transition: transform 320ms cubic-bezier(0.4, 0, 0.2, 1);
        }
        @keyframes bubble-in {
          from { opacity: 0; transform-box: fill-box; }
          to { opacity: 1; }
        }
      `}</style>
    </svg>
  );
}
