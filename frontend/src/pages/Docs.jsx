import React, { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Navigate, useParams, useLocation } from 'react-router-dom';
import { Home as HomeIcon, Search, Menu, X, ChevronLeft, ChevronRight } from 'lucide-react';
import { GROUPS, PAGES, findPage } from '../docs/pages';
import './Docs.css';

// Standalone docs area. Intentionally does NOT use the app Sidebar or .bb-app shell:
// it has its own top bar (with a Home button), left nav, content, and "On this page".
export default function Docs() {
  const { slug } = useParams();
  const location = useLocation();
  const [query, setQuery] = useState('');
  const [navOpen, setNavOpen] = useState(false);
  const [activeId, setActiveId] = useState('');

  const page = findPage(slug);

  // Nav search: title, group, keywords, and section titles.
  const visiblePages = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return PAGES;
    return PAGES.filter((p) => {
      const hay = [p.title, p.group, p.lead, p.keywords || '', ...p.sections.map((s) => s.title)]
        .join(' ')
        .toLowerCase();
      return q.split(/\s+/).every((w) => hay.includes(w));
    });
  }, [query]);

  // Scroll to top on page change, close mobile nav, set page title.
  useEffect(() => {
    window.scrollTo(0, 0);
    setNavOpen(false);
    setActiveId(page?.sections[0]?.id || '');
    if (page) document.title = `${page.title} | BudgetBuddy Docs`;
    return () => { document.title = 'BudgetBuddy'; };
  }, [slug]); // eslint-disable-line react-hooks/exhaustive-deps

  // Honor #hash links on load / nav.
  useEffect(() => {
    if (!location.hash) return;
    const el = document.getElementById(location.hash.slice(1));
    if (el) el.scrollIntoView();
  }, [location.hash, slug]);

  // Scroll spy for the "On this page" list.
  useEffect(() => {
    if (!page) return undefined;
    const onScroll = () => {
      let current = page.sections[0]?.id || '';
      for (const s of page.sections) {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top <= 110) current = s.id;
      }
      setActiveId(current);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [page]);

  if (!slug) return <Navigate to="/docs/overview" replace />;
  if (!page) return <Navigate to="/docs/overview" replace />;

  const idx = PAGES.findIndex((p) => p.slug === page.slug);
  const prev = PAGES[idx - 1];
  const next = PAGES[idx + 1];

  const jump = (id) => (e) => {
    e.preventDefault();
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActiveId(id);
    }
  };

  return (
    <div className="dx-root">
      <header className="dx-topbar">
        <button
          className="dx-menu-btn"
          onClick={() => setNavOpen((o) => !o)}
          aria-label={navOpen ? 'Close menu' : 'Open menu'}
        >
          {navOpen ? <X size={18} /> : <Menu size={18} />}
        </button>
        <Link to="/docs/overview" className="dx-brand" aria-label="BudgetBuddy Docs">
          <img src="/logo-full.svg" alt="BudgetBuddy" className="dx-logo" />
          <span className="dx-brand-tag">Docs</span>
        </Link>
        <div className="dx-top-spacer" />
        <Link to="/" className="bb-btn dx-home-btn">
          <HomeIcon size={14} aria-hidden="true" /> Home
        </Link>
      </header>

      <div className="dx-shell">
        <nav className={'dx-nav' + (navOpen ? ' is-open' : '')} aria-label="Docs navigation">
          <div className="dx-search">
            <Search size={13} aria-hidden="true" />
            <input
              type="text"
              placeholder="Search docs"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search docs"
            />
            {query && (
              <button className="dx-search-clear" onClick={() => setQuery('')} aria-label="Clear search">
                <X size={12} />
              </button>
            )}
          </div>

          {GROUPS.map((g) => {
            const items = visiblePages.filter((p) => p.group === g);
            if (!items.length) return null;
            return (
              <div key={g} className="dx-nav-group">
                <div className="dx-nav-label">{g}</div>
                {items.map((p) => (
                  <NavLink
                    key={p.slug}
                    to={`/docs/${p.slug}`}
                    className={({ isActive }) => 'dx-nav-item' + (isActive ? ' is-active' : '')}
                  >
                    {p.title}
                  </NavLink>
                ))}
              </div>
            );
          })}
          {visiblePages.length === 0 && <div className="dx-nav-empty">No pages match "{query}"</div>}
        </nav>

        <main className="dx-main">
          <article className="dx-article">
            <div className="dx-crumb">{page.group}</div>
            <h1 className="dx-h1">{page.title}</h1>
            <p className="dx-lead">{page.lead}</p>

            {page.sections.map((s) => (
              <section key={s.id} className="dx-section">
                <h2 id={s.id} className="dx-h2">{s.title}</h2>
                {s.body}
              </section>
            ))}

            <div className="dx-pager">
              {prev ? (
                <Link to={`/docs/${prev.slug}`} className="dx-pager-link">
                  <span className="dx-pager-dir"><ChevronLeft size={13} /> Previous</span>
                  <span className="dx-pager-title">{prev.title}</span>
                </Link>
              ) : <span />}
              {next ? (
                <Link to={`/docs/${next.slug}`} className="dx-pager-link is-next">
                  <span className="dx-pager-dir">Next <ChevronRight size={13} /></span>
                  <span className="dx-pager-title">{next.title}</span>
                </Link>
              ) : <span />}
            </div>
          </article>
        </main>

        <aside className="dx-toc" aria-label="On this page">
          <div className="dx-toc-label">On this page</div>
          {page.sections.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              onClick={jump(s.id)}
              className={'dx-toc-item' + (activeId === s.id ? ' is-active' : '')}
            >
              {s.title}
            </a>
          ))}
        </aside>
      </div>
    </div>
  );
}
