import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate, Outlet, RouterProvider, type RouteObject } from 'react-router';
import { ApiError } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { Layout, RequireAuth } from './components/Layout';
import { ToastProvider } from './components/Toasts';
import { Loading } from './components/ui';
import { AcceptInvitePage, ForgotPasswordPage, LoginPage, RegisterPage, ResetPasswordPage } from './pages/AuthPages';
import { FunnelsPage } from './pages/FunnelsPage';

// Heavy screens are lazy so the first paint (login, funnel list) stays small; the builder pulls in the renderer and schema only when opened.
const BuilderPage = lazy(() => import('./pages/BuilderPage').then((m) => ({ default: m.BuilderPage })));
const FunnelDetailPage = lazy(() => import('./pages/FunnelDetailPage').then((m) => ({ default: m.FunnelDetailPage })));
const NewFunnelPage = lazy(() => import('./pages/NewFunnelPage').then((m) => ({ default: m.NewFunnelPage })));
const TemplatesPage = lazy(() => import('./pages/TemplatesPage').then((m) => ({ default: m.TemplatesPage })));
const DomainsPage = lazy(() => import('./pages/DomainsPage').then((m) => ({ default: m.DomainsPage })));
const WebhooksPage = lazy(() => import('./pages/WebhooksPage').then((m) => ({ default: m.WebhooksPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const AuditPage = lazy(() => import('./pages/AuditPage').then((m) => ({ default: m.AuditPage })));
const TrashPage = lazy(() => import('./pages/TrashPage').then((m) => ({ default: m.TrashPage })));

const lazyEl = (el: React.ReactNode) => <Suspense fallback={<Loading />}>{el}</Suspense>;

export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },
  { path: '/forgot-password', element: <ForgotPasswordPage /> },
  { path: '/reset-password', element: <ResetPasswordPage /> },
  { path: '/accept-invite', element: <AcceptInvitePage /> },
  {
    element: <RequireAuth />,
    children: [
      { path: '/funnels/:id/builder/:stepId', element: lazyEl(<BuilderPage />) },
      {
        element: <Layout />,
        children: [
          { path: '/', element: <Navigate to="/funnels" replace /> },
          { path: '/funnels', element: <FunnelsPage /> },
          { path: '/funnels/new', element: lazyEl(<NewFunnelPage />) },
          { path: '/funnels/:id/:tab?', element: lazyEl(<FunnelDetailPage />) },
          { path: '/templates', element: lazyEl(<TemplatesPage />) },
          { path: '/domains', element: lazyEl(<DomainsPage />) },
          { path: '/webhooks', element: lazyEl(<WebhooksPage />) },
          { path: '/trash', element: lazyEl(<TrashPage />) },
          { path: '/settings', element: lazyEl(<SettingsPage />) },
          { path: '/audit', element: lazyEl(<AuditPage />) },
          { path: '*', element: <div className="empty"><h3>Page not found</h3></div> },
        ],
      },
    ],
  },
];

export const makeQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, retry: (n, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && n < 2, refetchOnWindowFocus: false } } });

export function Providers({ client, children }: { client: QueryClient; children: React.ReactNode }) {
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <AuthProvider>{children}</AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

function Root() {
  return <Outlet />;
}

export function App() {
  const router = createBrowserRouter([{ element: <Root />, children: routes }]);
  return <RouterProvider router={router} />;
}
