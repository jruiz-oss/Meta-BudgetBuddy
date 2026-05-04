import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import axios from 'axios';
import './App.css';

// Pages
import Login from './pages/Login';
import Register from './pages/Register';
import Home from './pages/Home';
import AccountDashboard from './pages/AccountDashboard';
import CampaignDetail from './pages/CampaignDetail';
import Settings from './pages/Settings';
import History from './pages/History';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    try {
      const response = await axios.get(`${API_URL}/auth/me`, { withCredentials: true });
      setUser(response.data.user);
    } catch (error) {
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await axios.post(`${API_URL}/auth/logout`, {}, { withCredentials: true });
      setUser(null);
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  if (loading) {
    return <div className="loading">Loading...</div>;
  }

  return (
    <Router>
      <Routes>
        {!user ? (
          <>
            <Route path="/login" element={<Login onLoginSuccess={checkAuth} />} />
            <Route path="/register" element={<Register onRegisterSuccess={checkAuth} />} />
            <Route path="*" element={<Navigate to="/login" />} />
          </>
        ) : (
          <>
            <Route path="/" element={<Home user={user} onLogout={handleLogout} />} />
            <Route path="/account/:accountId" element={<AccountDashboard user={user} onLogout={handleLogout} />} />
            <Route path="/campaign/:campaignId" element={<CampaignDetail user={user} onLogout={handleLogout} />} />
            <Route path="/account/:accountId/settings" element={<Settings user={user} onLogout={handleLogout} />} />
            <Route path="/account/:accountId/history" element={<History user={user} onLogout={handleLogout} />} />
            <Route path="*" element={<Navigate to="/" />} />
          </>
        )}
      </Routes>
    </Router>
  );
}

export default App;
