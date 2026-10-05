import { Component, lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ContentDrawer } from './components/ContentDrawer';
import { VideoDrawer } from './components/VideoDrawer';
import { Button, Callout, LoadingRows, Toasts } from './components/ui';
import { useSession } from './lib/session';
import { useUi } from './lib/ui-state';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';

const Posts = lazy(() => import('./pages/ContentDatabase'));
const VideoLibrary = lazy(() => import('./pages/VideoLibrary'));
const Graphics = lazy(() => import('./pages/Graphics'));
const SettingsHub = lazy(() => import('./pages/SettingsHub'));

/** Old addresses (bookmarks, OAuth returns) land on the matching simplified screen. */
function Moved({ to }: { to: string }) {
  const { search } = useLocation();
  const [path, extra] = to.split('?');
  const params = new URLSearchParams(search);
  new URLSearchParams(extra ?? '').forEach((v, k) => params.set(k, v));
  const q = params.toString();
  return <Navigate to={path + (q ? '?' + q : '')} replace />;
}
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24 }}>
          <Callout tone="danger" title="This view hit an unexpected error">
            {this.state.error.message}
            <div style={{ marginTop: 8 }}><Button size="sm" onClick={() => this.setState({ error: null })}>Try again</Button></div>
          </Callout>
        </div>
      );
    }
    return this.props.children;
  }
}

export function App() {
  const { user, loading } = useSession();
  const { drawer, closeDrawer } = useUi();
  if (loading) return <div style={{ padding: 40 }}><LoadingRows rows={4} /></div>;
  if (!user) return (<><Login /><Toasts /></>);
  return (
    <Layout>
      <ErrorBoundary>
        <Suspense fallback={<LoadingRows rows={8} />}>
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/posts" element={<Posts />} />
            <Route path="/graphics" element={<Graphics />} />
            <Route path="/videos" element={<VideoLibrary />} />
            <Route path="/settings" element={<SettingsHub />} />
            <Route path="/content" element={<Moved to="/posts" />} />
            <Route path="/calendar" element={<Moved to="/posts?view=calendar" />} />
            <Route path="/approvals" element={<Moved to="/posts?approval_status=pending" />} />
            <Route path="/queue" element={<Moved to="/posts?publish_status=queued" />} />
            <Route path="/connections" element={<Moved to="/settings" />} />
            <Route path="/activity" element={<Moved to="/settings?tab=log" />} />
            <Route path="/repurposing" element={<Moved to="/posts" />} />
            <Route path="/campaigns" element={<Moved to="/posts" />} />
            <Route path="/analytics" element={<Moved to="/" />} />
            <Route path="*" element={<Callout tone="warning" title="Page not found">Use the navigation to continue.</Callout>} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
      <ErrorBoundary>
        {drawer?.kind === 'content' && <ContentDrawer id={drawer.id} onClose={closeDrawer} />}
        {drawer?.kind === 'video' && <VideoDrawer id={drawer.id} onClose={closeDrawer} />}
      </ErrorBoundary>
      <Toasts />
    </Layout>
  );
}
