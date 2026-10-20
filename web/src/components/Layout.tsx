import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { api } from '../api/client';
import { keys, useMutate, useNotifications } from '../api/hooks';
import { useAuth } from '../auth/AuthContext';
import { useToast } from './Toasts';
import { Empty, fmtDate, Loading, Modal } from './ui';
import { Notices } from './Notices';

export function RequireAuth() {
  const { session, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <div className="auth-page"><Loading rows={2} /></div>;
  if (!session) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  return <Outlet />;
}

/** Subscribes to the SSE stream (with a short-lived ticket, because EventSource cannot send headers) and turns events into toasts. */
function useNotificationStream() {
  const qc = useQueryClient();
  const toast = useToast();
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const connect = async () => {
      try {
        const { ticket } = await api.post<{ ticket: string }>('/api/events/ticket');
        if (stopped) return;
        source = new EventSource(`/api/events/stream?ticket=${encodeURIComponent(ticket)}`);
        source.addEventListener('notification', (e) => {
          const n = JSON.parse((e as MessageEvent<string>).data) as { title: string; body: string };
          toast.push(`${n.title}: ${n.body}`, 'ok');
          void qc.invalidateQueries({ queryKey: keys.notifications });
          void qc.invalidateQueries({ queryKey: keys.funnels });
          void qc.invalidateQueries({ queryKey: ['leads'] });
          void qc.invalidateQueries({ queryKey: ['orders'] });
        });
        source.onerror = () => {
          source?.close();
          if (!stopped) timer = setTimeout(() => void connect(), 5000); // tickets are single-use and short-lived: fetch a new one
        };
      } catch {
        if (!stopped) timer = setTimeout(() => void connect(), 10_000);
      }
    };
    void connect();
    return () => {
      stopped = true;
      source?.close();
      if (timer) clearTimeout(timer);
    };
  }, [qc, toast]);
}

function NotificationsDrawer({ onClose }: { onClose: () => void }) {
  const q = useNotifications();
  const readAll = useMutate(() => api.post('/api/notifications/read-all'), [keys.notifications]);
  return (
    <Modal side title="Notifications" onClose={onClose}>
      <div className="row between" style={{ marginBottom: 12 }}>
        <span className="muted small">{q.data?.unread ?? 0} unread</span>
        <button type="button" className="btn sm" disabled={!q.data?.unread} onClick={() => readAll.mutate(undefined)}>Mark all read</button>
      </div>
      {q.isLoading ? <Loading rows={2} /> : null}
      {q.data && q.data.data.length === 0 ? <Empty title="Nothing yet">New leads and sales will show up here.</Empty> : null}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} className="stack">
        {q.data?.data.map((n) => (
          <li key={n.id} className="card" style={{ opacity: n.readAt ? 0.7 : 1 }}>
            <strong>{n.title}</strong>
            <div>{n.body}</div>
            <div className="muted small">{fmtDate(n.createdAt)}</div>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

export function Layout() {
  const { session, logout, can } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const notes = useNotifications();
  useNotificationStream();
  const links: [string, string][] = [['/funnels', 'My Funnels'], ['/templates', 'Templates'], ['/domains', 'Domains'], ['/webhooks', 'Webhooks'], ['/trash', 'Trash'], ['/settings', 'Settings'], ['/audit', 'Audit log'], ['/admin', 'Admin']];
  return (
    <div className="shell">
      <aside className="sidebar">
        <NavLink to="/funnels" className="brand" aria-label="Funnels home">
          <svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#2563eb" /><path d="M7 8h18l-7 8.5V24l-4-2.5v-5z" fill="#fff" /></svg>
          Funnels
        </NavLink>
        <nav className="nav" aria-label="Main">
          {links
            .filter(([to]) => (to === '/webhooks' ? can('webhooks:manage') : to === '/audit' ? can('audit:read') : to === '/admin' ? !!session?.platformAdmin : true))
            .map(([to, label]) => (
              <NavLink key={to} to={to}>{label}</NavLink>
            ))}
        </nav>
        <div className="spacer" />
        <div className="small muted" style={{ padding: '0 10px' }}>{session?.workspace.name}</div>
      </aside>
      <div className="main">
        <header className="topbar">
          <span className="grow" />
          <button type="button" className="btn ghost" onClick={() => setOpen(true)} aria-label={`Notifications, ${notes.data?.unread ?? 0} unread`}>
            🔔{notes.data?.unread ? <span className="badge primary">{notes.data.unread}</span> : null}
          </button>
          <span className="small">{session?.user.name} <span className="badge">{session?.user.roleName}</span></span>
          <button type="button" className="btn sm" onClick={() => { logout(); nav('/login'); }}>Sign out</button>
        </header>
        <main className="content" id="main">
          <Notices />
          {session?.workspace.suspended ? null : <Outlet />}
        </main>
      </div>
      {open ? <NotificationsDrawer onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
