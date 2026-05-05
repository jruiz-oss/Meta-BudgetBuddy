import React from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import './Sidebar.css';

/**
 * Shared sidebar matching the BudgetBuddy mockups.
 *
 * Props:
 *   user             — { email }
 *   accounts         — list of { id, account_name } (optional; renders ACCOUNTS section if present)
 *   onAddAccount     — handler for "+ Add Account" (optional)
 *   variant          — 'home' (no accounts list) | 'account' (accounts list visible)
 */
function Sidebar({ user, accounts = [], onAddAccount, variant = 'account' }) {
  const navigate = useNavigate();
  const { accountId } = useParams();
  const showAccounts = variant === 'account';

  return (
    <aside className="bb-sidebar">
      <div className="bb-sidebar-brand">BudgetBuddy</div>

      {showAccounts && (
        <div className="bb-sidebar-section">
          <div className="bb-sidebar-label">Accounts</div>
          <ul className="bb-sidebar-list">
            {accounts.map((acc) => (
              <li key={acc.id}>
                <button
                  type="button"
                  className={`bb-sidebar-item ${String(acc.id) === String(accountId) ? 'is-active' : ''}`}
                  onClick={() => navigate(`/account/${acc.id}`)}
                >
                  {acc.account_name}
                </button>
              </li>
            ))}
            {onAddAccount && (
              <li>
                <button
                  type="button"
                  className="bb-sidebar-add"
                  onClick={onAddAccount}
                >
                  + Add Account
                </button>
              </li>
            )}
          </ul>
        </div>
      )}

      <div className="bb-sidebar-section">
        <div className="bb-sidebar-label">Navigation</div>
        <ul className="bb-sidebar-list">
          <li>
            <NavLink to="/" end className={({ isActive }) => `bb-sidebar-item ${isActive ? 'is-active' : ''}`}>
              Home
            </NavLink>
          </li>
          {showAccounts && accountId && (
            <li>
              <NavLink to={`/account/${accountId}`} end className={({ isActive }) => `bb-sidebar-item ${isActive ? 'is-active' : ''}`}>
                Dashboard
              </NavLink>
            </li>
          )}
          <li>
            <NavLink to={accountId ? `/account/${accountId}/history` : '/history'} className={({ isActive }) => `bb-sidebar-item ${isActive ? 'is-active' : ''}`}>
              History
            </NavLink>
          </li>
          <li>
            <NavLink to={accountId ? `/account/${accountId}/settings` : '/settings'} className={({ isActive }) => `bb-sidebar-item ${isActive ? 'is-active' : ''}`}>
              Settings
            </NavLink>
          </li>
        </ul>
      </div>

      <div className="bb-sidebar-user">
        <div className="bb-sidebar-label">User</div>
        <div className="bb-sidebar-user-email">{user?.email || '—'}</div>
      </div>
    </aside>
  );
}

export default Sidebar;
