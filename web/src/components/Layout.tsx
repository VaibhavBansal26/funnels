import { useQueryClient } from '@tanstack/react-query';
import { Bell, Globe, LayoutGrid, LayoutTemplate, LogOut, Menu, Monitor, Moon, ScrollText, Settings, Shield, Sun, Trash2, Webhook, Zap, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { api } from '../api/client';
import { keys, useMutate, useNotifications } from '../api/hooks';
import { useAuth } from '../auth/AuthContext';
import { Badge, Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Tooltip, TooltipProvider } from '../ui';
import { useTheme } from '../ui/theme';
import { Notices } from './Notices';
import { useToast } from './Toasts';
import { Empty, fmtDate, Loading, Modal } from './ui';

export function RequireAuth() {
  const { session, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <div className="auth-page"><div className="w-full max-w-sm"><Loading rows={2} /></div></div>;
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
      <div className="row between mb-3">
        <span className="small muted">{q.data?.unread ?? 0} unread</span>
        <Button size="sm" disabled={!q.data?.unread} onClick={() => readAll.mutate(undefined)}>Mark all read</Button>
      </div>
      {q.isLoading ? <Loading rows={2} /> : null}
      {q.data && q.data.data.length === 0 ? <Empty title="Nothing yet">New leads and sales will show up here.</Empty> : null}
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {q.data?.data.map((n) => (
          <li key={n.id} className={`card ${n.readAt ? 'opacity-70' : ''}`}>
            <strong>{n.title}</strong>
            <div>{n.body}</div>
            <div className="small muted">{fmtDate(n.createdAt)}</div>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

const NAV: { to: string; label: string; icon: LucideIcon; gate?: 'webhooks' | 'audit' | 'admin' }[] = [
  { to: '/funnels', label: 'My Funnels', icon: LayoutGrid },
  { to: '/templates', label: 'Templates', icon: LayoutTemplate },
  { to: '/domains', label: 'Domains', icon: Globe },
  { to: '/webhooks', label: 'Webhooks', icon: Webhook, gate: 'webhooks' },
  { to: '/trash', label: 'Trash', icon: Trash2 },
  { to: '/settings', label: 'Settings', icon: Settings },
  { to: '/audit', label: 'Audit log', icon: ScrollText, gate: 'audit' },
  { to: '/admin', label: 'Admin', icon: Shield, gate: 'admin' },
];

function Brand() {
  return (
    <NavLink to="/funnels" className="flex items-center gap-2.5 px-2.5 pt-1 pb-4 text-lg font-bold tracking-tight text-fg no-underline" aria-label="Funnels home">
      <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-fg shadow-sm"><Zap className="size-4" aria-hidden="true" /></span>
      Funnels
    </NavLink>
  );
}

function ThemeMenu() {
  const [theme, setTheme] = useTheme();
  const Icon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;
  return (
    <DropdownMenu>
      <Tooltip label="Theme"><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`Theme: ${theme}`}><Icon /></Button></DropdownMenuTrigger></Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => setTheme('system')}><Monitor /> System</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setTheme('light')}><Sun /> Light</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setTheme('dark')}><Moon /> Dark</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Layout() {
  const { session, logout, can } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const notes = useNotifications();
  useNotificationStream();
  useEffect(() => setMenu(false), [loc.pathname]);
  const links = NAV.filter((l) => (l.gate === 'webhooks' ? can('webhooks:manage') : l.gate === 'audit' ? can('audit:read') : l.gate === 'admin' ? !!session?.platformAdmin : true));
  const NavList = (
    <nav className="flex flex-col gap-0.5" aria-label="Main">
      {links.map((l) => (
        <NavLink key={l.to} to={l.to} className="nav-link">
          <l.icon className="size-4 shrink-0" aria-hidden="true" />
          {l.label}
        </NavLink>
      ))}
    </nav>
  );
  return (
    <TooltipProvider>
      <div className="grid min-h-full grid-cols-1 lg:grid-cols-[15rem_1fr]">
        <aside className="sticky top-0 hidden h-dvh flex-col gap-1 border-r border-border bg-surface px-3 py-4 lg:flex">
          <Brand />
          {NavList}
          <div className="flex-1" />
          <div className="truncate px-2.5 text-xs text-muted" title={session?.workspace.name}>{session?.workspace.name}</div>
        </aside>
        <div className="flex min-w-0 flex-col">
          <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-border bg-surface/90 px-4 py-2 backdrop-blur sm:px-6">
            <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation" onClick={() => setMenu(true)}><Menu /></Button>
            <span className="text-base font-bold tracking-tight lg:hidden">Funnels</span>
            <span className="flex-1" />
            <ThemeMenu />
            <Tooltip label="Notifications">
              <Button variant="ghost" size="icon" className="relative" onClick={() => setOpen(true)} aria-label={`Notifications, ${notes.data?.unread ?? 0} unread`}>
                <Bell />
                {notes.data?.unread ? <Badge tone="primary" className="absolute -top-1 -right-1 min-w-4 justify-center px-1 py-0 text-[0.65rem]">{notes.data.unread}</Badge> : null}
              </Button>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="gap-2 px-2" aria-label="Account menu">
                  <span className="grid size-7 place-items-center rounded-full bg-primary-soft text-xs font-bold text-primary">{(session?.user.name ?? '?').slice(0, 1).toUpperCase()}</span>
                  <span className="hidden max-w-32 truncate sm:inline">{session?.user.name}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>{session?.user.roleName}</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => nav('/settings')}><Settings /> Settings</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => { logout(); nav('/login'); }}><LogOut /> Sign out</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </header>
          <main className="mx-auto w-full max-w-[1280px] px-4 py-6 sm:px-6" id="main">
            <Notices />
            {session?.workspace.suspended ? null : <Outlet />}
          </main>
        </div>
        {menu ? (
          <Modal side title="Navigation" onClose={() => setMenu(false)}>
            <Brand />
            {NavList}
          </Modal>
        ) : null}
        {open ? <NotificationsDrawer onClose={() => setOpen(false)} /> : null}
      </div>
    </TooltipProvider>
  );
}
