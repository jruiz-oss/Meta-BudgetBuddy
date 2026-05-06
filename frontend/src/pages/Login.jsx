import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import axios from 'axios';
import { Activity, Loader2, LogIn } from 'lucide-react';

function Login({ onLoginSuccess }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const response = await axios.post('/api/auth/login', { email, password });
      if (response.status === 200) {
        onLoginSuccess();
        navigate('/');
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bb-auth-shell">
      <div className="bb-auth-card">
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
          <span className="bb-brand-mark" style={{ width: 44, height: 44, borderRadius: 12 }} aria-hidden="true">
            <Activity size={22} strokeWidth={2.5} />
          </span>
        </div>
        <div className="bb-auth-title">BudgetBuddy</div>
        <div className="bb-auth-subtitle">Keep your Meta ads on pace, automatically.</div>

        {error && <div className="bb-alert bb-alert-error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="bb-form-group">
            <label htmlFor="email" className="bb-form-label">Email</label>
            <input
              id="email"
              type="email"
              className="bb-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </div>

          <div className="bb-form-group">
            <label htmlFor="password" className="bb-form-label">Password</label>
            <input
              id="password"
              type="password"
              className="bb-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          <button
            type="submit"
            className="bb-btn bb-btn-primary"
            style={{ width: '100%', justifyContent: 'center', padding: '11px', fontSize: '14px' }}
            disabled={loading}
          >
            {loading ? <Loader2 size={14} className="bb-i" /> : <LogIn size={14} aria-hidden="true" />}
            {loading ? 'Logging in…' : 'Log In'}
          </button>
        </form>

        <div className="bb-auth-footer">
          Don't have an account? <Link to="/register">Register</Link>
        </div>
      </div>
    </div>
  );
}

export default Login;
