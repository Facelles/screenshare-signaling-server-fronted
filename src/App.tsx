import { useState, useEffect } from 'react';
import Home from './pages/Home.js';
import Host from './pages/Host.js';
import Viewer from './pages/Viewer.js';

type Page = 'home' | 'host' | 'viewer';

interface RouteState {
  page: Page;
  token: string;
  roomId: string;
}

function parseRoute(): RouteState {
  const p = new URLSearchParams(window.location.search);
  const page = (p.get('page') ?? 'home') as Page;
  return {
    page: ['host', 'viewer'].includes(page) ? page : 'home',
    token: p.get('token') ?? '',
    roomId: p.get('room') ?? '',
  };
}

export function navigate(url: string): void {
  window.history.pushState({}, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export default function App() {
  const [route, setRoute] = useState<RouteState>(parseRoute);

  useEffect(() => {
    const onPop = () => setRoute(parseRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  if (route.page === 'host')   return <Host roomId={route.roomId} token={route.token} />;
  if (route.page === 'viewer') return <Viewer token={route.token} />;
  return <Home />;
}
