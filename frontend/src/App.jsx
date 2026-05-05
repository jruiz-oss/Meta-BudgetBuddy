import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import axios from 'axios';
import './App.css';

// Pages
import Login from './pages/Login';
import Register from './pages/Register';
import Home from './pages/Home';          // Unified campaigns view (new)
import Accounts from './pages/Accounts'; // Account cards (was Home)
import AccountDashboard from './pages/AccountDashboard';
import CampaignDetail from './pages/CampaignDetail';
import Settings from './pages/Settings';
import History from './pages/History';

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

  if (loading) return <div className="loading">Loading...</div>;

  return (
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
            <Route path="/account/:accountId/history"                          element={<History          user={user} onLogout={handleLogout} />} />
            <Route path="*"         element={<Navigate to="/" />} />
          </>
        )}
      </Routes>
    </Router>
  );
}

export default App;
