import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import axios from 'axios';
import { Loader2, UserPlus } from 'lucide-react';

function Register({ onRegisterSuccess }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  // Shared-workspace gate (session 13). The backend validates this against the
  // INVITE_CODE env var on Railway. Required for new agency teammates to sign up.
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    setLoading(true);
    try {
      const response = await axios.post('/api/auth/register', {
        email,
        password,
        invite_code: inviteCode,
      });
      if (response.status === 201) {
        onRegisterSuccess();
        navigate('/');
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bb-auth-shell">
      <div className="bb-auth-card">
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
          <img src="/logo.svg" alt="BudgetBuddy" style={{ width: 200, height: 'auto' }} />
        </div>
        <div className="bb-auth-subtitle">Create your account</div>

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

          <div className="bb-form-group">
            <label htmlFor="confirmPassword" className="bb-form-label">Confirm Password</label>
            <input
              id="confirmPassword"
              type="password"
              className="bb-input"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
            />
          </div>

          <div className="bb-form-group">
            <label htmlFor="inviteCode" className="bb-form-label">Invite code</label>
            <input
              id="inviteCode"
              type="text"
              className="bb-input"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              autoComplete="off"
              spellCheck="false"
              placeholder="Ask a teammate for the current code"
            />
            <div className="bb-form-help">
              Required for the agency workspace. Get the current code from someone on the team.
            </div>
          </div>

          <button
            type="submit"
            className="bb-btn bb-btn-primary"
            style={{ width: '100%', justifyContent: 'center', padding: '11px', fontSize: '14px' }}
            disabled={loading}
          >
            {loading ? <Loader2 size={14} className="bb-spin" /> : <UserPlus size={14} aria-hidden="true" />}
            {loading ? 'Creating account…' : 'Register'}
          </button>
        </form>

        <div className="bb-auth-footer">
          Already have an account? <Link to="/login">Log in</Link>
        </div>
      </div>
    </div>
  );
}

export default Register;
