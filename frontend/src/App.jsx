import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import axios from 'axios';
// App.css was a legacy design system (.btn / .card / .table / etc.) — none of
// those classes are referenced anywhere; everything ships through index.css's
// bb-* system. Only the .loading style was still in use, inlined below.

// Toast provider
import { ToastProvider } from './components/Toast';

// Pages
import Login from './pages/Login';
import Register from './pages/Register';
import Home from './pages/Home';          // Unified campaigns view (new)
import Accounts from './pages/Accounts'; // Account cards (was Home)
import AccountDashboard from './pages/AccountDashboard';
import CampaignDetail from './pages/CampaignDetail';
import Settings from './pages/Settings';
import History from './pages/History';
import GlobalHistory from './pages/GlobalHistory';

// Default timeout — Railway cold starts can take ~15s, but anything past 60s is dead.
// Without this, hung requests sit forever and look like the app is "loading" with no spinner state ever resolving.
axios.defaults.timeout = 60_000;

// Fire a warmup ping before anything else so the Railway dyno wakes up while
// React is still mounting. Cuts perceived first-paint latency on cold starts.
// Fire-and-forget — failures are fine (they just mean we'll retry on the real call).
try { axios.get('/api/health').catch(() => {}); } catch {}

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { checkAuth(); }, []);

  const checkAuth = async () => {
    try {
      const response = await axios.get('/api/auth/me');
      setUser(response.data.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    try { await axios.post('/api/auth/logout'); } catch {}
    setUser(null);
  };

  if (loading) return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', color: '#666' }}>
      Loading...
    </div>
  );

  return (
    <ToastProvider>
      <Router>
        <Routes>
          {!user ? (
            <>
              <Route path="/login"    element={<Login    onLoginSuccess={checkAuth} />} />
              <Route path="/register" element={<Register onRegisterSuccess={checkAuth} />} />
              <Route path="*"         element={<Navigate to="/login" />} />
            </>
          ) : (
            <>
              <Route path="/"         element={<Home     user={user} onLogout={handleLogout} />} />
              <Route path="/accounts" element={<Accounts user={user} onLogout={handleLogout} />} />
              <Route path="/account/:accountId"                                  element={<AccountDashboard user={user} onLogout={handleLogout} />} />
              <Route path="/account/:accountId/campaign/:campaignId"             element={<CampaignDetail   user={user} onLogout={handleLogout} />} />
              <Route path="/account/:accountId/settings"                         element={<Settings         user={user} onLogout={handleLogout} />} />
              <Route path="/history"                                              element={<GlobalHistory    user={user} onLogout={handleLogout} />} />
              <Route path="/account/:accountId/history"                          element={<History          user={user} onLogout={handleLogout} />} />
              <Route path="*"         element={<Navigate to="/" />} />
            </>
          )}
        </Routes>
      </Router>
    </ToastProvider>
  );
}

export default App;
