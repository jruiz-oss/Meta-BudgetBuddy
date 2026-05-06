import React from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import {
  Home as HomeIcon,
  Building2,
  LayoutDashboard,
  History as HistoryIcon,
  Settings as SettingsIcon,
  Plus,
  Activity,
} from 'lucide-react';
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
      <div className="bb-sidebar-brand">
        <span className="bb-brand-mark" aria-hidden="true">
          <Activity size={16} strokeWidth={2.5} />
        </span>
        <span>BudgetBuddy</span>
      </div>

      {/* ACCOUNTS — scrollable list, fixed label */}
      <div className="bb-sidebar-section bb-sidebar-section-accounts">
        <div className="bb-sidebar-label">Accounts</div>
        <ul className="bb-sidebar-list">
          {accounts.map((acc) => (
            <li key={acc.id}>
              <button
                type="button"
                className={`bb-sidebar-item ${String(acc.id) === String(accountId) ? 'is-active' : ''}`}
                onClick={() => navigate(`/account/${acc.id}`)}
              >
                <Building2 size={15} aria-hidden="true" />
                <span>{acc.account_name}</span>
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              className="bb-sidebar-add"
              onClick={onAddAccount || (() => navigate('/accounts'))}
            >
              <Plus size={13} aria-hidden="true" style={{ marginRight: 4, verticalAlign: -2 }} />
              Add Account
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
              <HomeIcon size={15} aria-hidden="true" />
              <span>Home</span>
            </NavLink>
          </li>
          <li>
            <NavLink
              to="/accounts"
              className={({ isActive }) => `bb-sidebar-item${isActive ? ' is-active' : ''}`}
            >
              <Building2 size={15} aria-hidden="true" />
              <span>Accounts</span>
            </NavLink>
          </li>
          <li>
            {accountId ? (
              <NavLink
                to={`/account/${accountId}`}
                end
                className={({ isActive }) => `bb-sidebar-item${isActive ? ' is-active' : ''}`}
              >
                <LayoutDashboard size={15} aria-hidden="true" />
                <span>Dashboard</span>
              </NavLink>
            ) : (
              <span className="bb-sidebar-item bb-sidebar-item-dim" title="Select an account first">
                <LayoutDashboard size={15} aria-hidden="true" />
                <span>Dashboard</span>
              </span>
            )}
          </li>
          <li>
            {accountId ? (
              <NavLink
                to={`/account/${accountId}/history`}
                className={({ isActive }) => `bb-sidebar-item${isActive ? ' is-active' : ''}`}
              >
                <HistoryIcon size={15} aria-hidden="true" />
                <span>History</span>
              </NavLink>
            ) : (
              <span className="bb-sidebar-item bb-sidebar-item-dim" title="Select an account first">
                <HistoryIcon size={15} aria-hidden="true" />
                <span>History</span>
              </span>
            )}
          </li>
          <li>
            {accountId ? (
              <NavLink
                to={`/account/${accountId}/settings`}
                className={({ isActive }) => `bb-sidebar-item${isActive ? ' is-active' : ''}`}
              >
                <SettingsIcon size={15} aria-hidden="true" />
                <span>Settings</span>
              </NavLink>
            ) : (
              <span className="bb-sidebar-item bb-sidebar-item-dim" title="Select an account first">
                <SettingsIcon size={15} aria-hidden="true" />
                <span>Settings</span>
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
