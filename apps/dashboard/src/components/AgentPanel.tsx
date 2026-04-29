import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import type { Agent, AgentMessage, AgentMetadata, FileClaim, Task } from '../lib/types';

interface AgentPanelProps {
  readonly agent: Agent;
  readonly agents: readonly Agent[];
  readonly onClose: () => void;
}

interface PanelData {
  files: readonly FileClaim[];
  tasks: readonly Task[];
  metadata: AgentMetadata;
  messages: readonly AgentMessage[];
}

const POLL_INTERVAL_MS = 4000;
const MESSAGE_LIMIT = 30;

export function AgentPanel({ agent, agents, onClose }: AgentPanelProps): React.JSX.Element {
  const [data, setData] = useState<PanelData>({
    files: [],
    tasks: [],
    metadata: {},
    messages: [],
  });

  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agents) map.set(a.id, a.displayName);
    return map;
  }, [agents]);

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      try {
        const [files, allTasks, metadata, allMessages] = await Promise.all([
          api.get<readonly FileClaim[]>(`/api/files/agent/${agent.id}`),
          api.get<readonly Task[]>('/api/tasks'),
          api.get<AgentMetadata>(`/api/agents/${agent.id}/metadata`).catch(() => ({})),
          api
            .get<readonly AgentMessage[]>(`/api/messages?limit=${String(MESSAGE_LIMIT * 4)}`)
            .catch((): readonly AgentMessage[] => []),
        ]);
        if (cancelled) return;
        const tasks = allTasks.filter(
          (t) =>
            t.assignedTo === agent.id &&
            t.status !== 'completed' &&
            t.status !== 'cancelled',
        );
        // Keep only messages this agent sent or received (incl. broadcasts they sent).
        const messages = allMessages
          .filter(
            (m) => m.fromAgentId === agent.id || m.toAgentId === agent.id,
          )
          .slice(0, MESSAGE_LIMIT);
        setData({ files, tasks, metadata, messages });
      } catch {
        // Swallow — the panel keeps showing the last good data.
      }
    };

    void load();
    const id = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [agent.id]);

  // Esc closes the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const runStatus = data.metadata['run-status'];
  const gitStatus = data.metadata['git-status'];

  return (
    <aside
      className="absolute inset-y-0 right-0 z-10 flex w-[360px] flex-col border-l border-border bg-surface shadow-[-8px_0_24px_-12px_rgba(0,0,0,0.12)]"
      aria-label={`Details for ${agent.displayName}`}
    >
      <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold tracking-tight text-text">
            {agent.displayName}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[12px] text-muted">
            <StatusDot status={agent.status} />
            <span className="capitalize">{agent.status}</span>
            <span className="text-dim">·</span>
            <span className="font-mono">{agent.tool}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close panel"
          className="-mr-1 rounded p-1.5 text-muted transition-colors hover:bg-bg-grid hover:text-text"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path
              d="M3 3l8 8M11 3l-8 8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        <Section title="Workspace">
          <KV label="Branch" value={agent.currentBranch ?? '—'} mono />
          {agent.workspacePath !== undefined && (
            <KV label="Path" value={agent.workspacePath} mono />
          )}
          {agent.repoUrl !== null && agent.repoUrl !== undefined && (
            <KV label="Repo" value={agent.repoUrl} mono />
          )}
        </Section>

        <Section title="Connection">
          {agent.connectedAt !== undefined && (
            <KV label="Joined" value={formatRelative(agent.connectedAt)} />
          )}
          {agent.lastHeartbeat !== undefined && (
            <KV label="Last beat" value={formatRelative(agent.lastHeartbeat)} />
          )}
        </Section>

        <Section title={`Conversations (${String(data.messages.length)})`}>
          {data.messages.length === 0 ? (
            <Empty>No messages yet.</Empty>
          ) : (
            <ul className="space-y-1.5">
              {data.messages.map((m) => {
                const sentBySelf = m.fromAgentId === agent.id;
                const otherId = sentBySelf ? m.toAgentId : m.fromAgentId;
                const otherName =
                  otherId === null
                    ? 'everyone'
                    : (nameById.get(otherId) ?? otherId.slice(0, 8));
                return (
                  <li
                    key={m.id}
                    className="rounded-md border border-border bg-bg-grid/40 px-2.5 py-1.5"
                  >
                    <div className="mb-0.5 flex items-center gap-1.5 text-[11px] text-muted">
                      <span
                        className={`rounded px-1.5 py-0.5 ${
                          sentBySelf
                            ? 'bg-accent-soft text-accent'
                            : 'bg-bg-grid text-text'
                        }`}
                      >
                        {sentBySelf ? 'sent' : 'received'}
                      </span>
                      <span className="truncate">
                        {sentBySelf ? '→ ' : '← '}
                        <span className="font-medium text-text">{otherName}</span>
                      </span>
                      <span className="ml-auto shrink-0 text-dim">
                        {formatRelative(m.createdAt)}
                      </span>
                    </div>
                    <div className="text-[12.5px] leading-5 text-text">{m.content}</div>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Section title={`Active claims (${String(data.files.length)})`}>
          {data.files.length === 0 ? (
            <Empty>No files claimed.</Empty>
          ) : (
            <ul className="space-y-1.5">
              {data.files.map((f) => (
                <li
                  key={f.filePath}
                  className="rounded-md border border-border bg-bg-grid/40 px-2.5 py-1.5"
                >
                  <div className="truncate font-mono text-[12px] text-text">{f.filePath}</div>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted">
                    <span
                      className={
                        f.mode === 'exclusive'
                          ? 'rounded bg-st-busy/15 px-1.5 py-0.5 text-st-busy'
                          : 'rounded bg-accent-soft px-1.5 py-0.5 text-accent'
                      }
                    >
                      {f.mode}
                    </span>
                    {f.branch !== null && f.branch !== undefined && (
                      <span className="font-mono">{f.branch}</span>
                    )}
                    <span>· {formatRelative(f.claimedAt)}</span>
                  </div>
                  {f.reason !== null && f.reason !== undefined && f.reason.length > 0 && (
                    <div className="mt-1 text-[12px] leading-5 text-muted">{f.reason}</div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={`Tasks (${String(data.tasks.length)})`}>
          {data.tasks.length === 0 ? (
            <Empty>No active tasks.</Empty>
          ) : (
            <ul className="space-y-1.5">
              {data.tasks.map((t) => (
                <li
                  key={t.id}
                  className="rounded-md border border-border bg-bg-grid/40 px-2.5 py-1.5"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
                      {t.status.replace('_', ' ')}
                    </span>
                    <span className="text-[11px] text-dim">· {t.priority}</span>
                  </div>
                  <div className="mt-0.5 truncate text-[13px] text-text">{t.title}</div>
                  {t.description !== undefined && t.description.length > 0 && (
                    <div className="mt-1 line-clamp-2 text-[12px] leading-5 text-muted">
                      {t.description}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>

        {(runStatus !== undefined || gitStatus !== undefined) && (
          <Section title="Latest signals">
            {runStatus !== undefined && (
              <KV label="Run" value={runStatus.value} subtle={formatRelative(runStatus.updatedAt)} />
            )}
            {gitStatus !== undefined && (
              <KV label="Git" value={gitStatus.value} subtle={formatRelative(gitStatus.updatedAt)} />
            )}
          </Section>
        )}
      </div>

      <footer className="border-t border-border px-5 py-2.5 text-[11px] text-dim">
        Polling every {String(POLL_INTERVAL_MS / 1000)}s · no LLM calls
      </footer>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="border-b border-border px-5 py-3.5 last:border-b-0">
      <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-dim">
        {title}
      </h3>
      {children}
    </section>
  );
}

function KV({
  label,
  value,
  mono,
  subtle,
}: {
  label: string;
  value: string;
  mono?: boolean;
  subtle?: string;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5 text-[12.5px]">
      <span className="shrink-0 text-muted">{label}</span>
      <span className={`min-w-0 truncate text-right text-text${mono === true ? ' font-mono text-[12px]' : ''}`}>
        {value}
        {subtle !== undefined && <span className="ml-1.5 text-dim">· {subtle}</span>}
      </span>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="text-[12.5px] italic text-dim">{children}</div>;
}

function StatusDot({ status }: { status: Agent['status'] }): React.JSX.Element {
  const color =
    status === 'active'
      ? 'bg-st-active'
      : status === 'busy'
        ? 'bg-st-busy'
        : status === 'idle'
          ? 'bg-st-idle'
          : 'bg-st-disconnected';
  return <span className={`size-1.5 rounded-full ${color}`} aria-hidden />;
}

function formatRelative(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${String(diffSec)}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${String(diffMin)}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${String(diffHr)}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${String(diffDay)}d ago`;
}
