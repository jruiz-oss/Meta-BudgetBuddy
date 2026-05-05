import React from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import './Sidebar.css';

/**
 * Consistent sidebar — same structure on every page.
 *
 * Props:
 *   user           — { email }
 *   accounts       — list of { id, account_name }
 *   onAddAccount   — opens the Add Account modal (only passed from Home)
 */
function Sidebar({ user, accounts = [], onAddAccount }) {
  const navigate  = useNavigate();
  const { accountId } = useParams();

  return (
    <aside className="bb-sidebar">
      <div className="bb-sidebar-brand">BudgetBuddy</div>

      {/* ACCOUNTS — always visible */}
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
          <li>
            <button
              type="button"
              className="bb-sidebar-add"
              onClick={onAddAccount || (() => navigate('/'))}
            >
              + Add Account
            </button>
          </li>
        </ul>
      </div>

      {/* NAVIGATION — always the same 4 links */}
      <div className="bb-sidebar-section">
        <div className="bb-sidebar-label">Navigation</div>
        <ul className="bb-sidebar-list">
          <li>
            <NavLink
              to="/"
              end
              className={({ isActive }) => `bb-sidebar-item${isActive ? ' is-active' : ''}`}
            >
              Home
            </NavLink>
          </li>
          <li>
            {accountId ? (
              <NavLink
                to={`/account/${accountId}`}
                end
                className={({ isActive }) => `bb-sidebar-item${isActive ? ' is-active' : ''}`}
              >
                Dashboard
              </NavLink>
            ) : (
              <span className="bb-sidebar-item bb-sidebar-item-dim" title="Select an account first">
                Dashboard
              </span>
            )}
          </li>
          <li>
            {accountId ? (
              <NavLink
                to={`/account/${accountId}/history`}
                className={({ isActive }) => `bb-sidebar-item${isActive ? ' is-active' : ''}`}
              >
                History
              </NavLink>
            ) : (
              <span className="bb-sidebar-item bb-sidebar-item-dim" title="Select an account first">
                History
              </span>
            )}
          </li>
          <li>
            {accountId ? (
              <NavLink
                to={`/account/${accountId}/settings`}
                className={({ isActive }) => `bb-sidebar-item${isActive ? ' is-active' : ''}`}
              >
                Settings
              </NavLink>
            ) : (
              <span className="bb-sidebar-item bb-sidebar-item-dim" title="Select an account first">
                Settings
              </span>
            )}
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
