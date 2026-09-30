import React from 'react';
import { Link } from 'react-router-dom';
import { Callout, Steps, Step, DocTable, Issue } from './parts';

/*
 * Docs content. One entry per page:
 *   slug     url segment (/docs/:slug)
 *   group    left nav group
 *   title    nav + page title
 *   lead     one line under the title
 *   keywords extra words the nav search matches on
 *   sections [{ id, title, body }]  each section becomes an "On this page" link
 *
 * Keep the copy in sync with the app: if a button label or behavior changes,
 * update it here. Writing style: short, casual, no em or en dashes.
 */

export const GROUPS = ['Getting started', 'Using the app', 'How it works', 'Help'];

export const PAGES = [
  /* ------------------------------------------------------------------ */
  {
    slug: 'overview',
    group: 'Getting started',
    title: 'What is BudgetBuddy',
    lead: 'A pacing tool for Meta ad budgets. It tells you what each campaign\'s daily budget should be so the month lands on target.',
    keywords: 'intro about introduction pacing meta facebook',
    sections: [
      {
        id: 'what-it-does',
        title: 'What it does',
        body: (
          <>
            <p>
              BudgetBuddy pulls spend from Meta, compares it to each campaign's monthly budget, and works out the
              daily budget that would hit the monthly number if you held it for the rest of the month. You review the
              recommendations and push the ones you want to Meta with one click.
            </p>
            <p>
              Monthly budgets and ABO ad set splits come from your <strong>Social Budget Pacing</strong> Google Sheet, so
              the app and the sheet always agree.
            </p>
          </>
        ),
      },
      {
        id: 'the-loop',
        title: 'The basic loop',
        body: (
          <Steps>
            <Step title="Pacing runs">
              Automatically each night, once per browser session when you open the app, or manually with
              <strong> Run pacing</strong>. Nothing is changed in Meta at this point.
            </Step>
            <Step title="You review">
              Home and each account dashboard show current daily budget, recommended daily budget, and a status
              (Increase, Decrease, or On pace).
            </Step>
            <Step title="You apply">
              Click <strong>Apply</strong> on a row, or <strong>Apply all</strong> for an account. Only then does the new
              daily budget go to Meta.
            </Step>
          </Steps>
        ),
      },
      {
        id: 'important',
        title: 'Good to know up front',
        body: (
          <>
            <Callout tone="info" title="Budgets are never pushed automatically">
              The nightly run only calculates and logs. Every change to Meta is a click from a person.
            </Callout>
            <Callout tone="warn" title="The sheet is the source of truth">
              If a campaign has a matching row on the sheet, the next pacing run overwrites its monthly budget (and ABO
              allocation) with whatever the sheet says. Edit the sheet, not the app.
            </Callout>
          </>
        ),
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  {
    slug: 'quick-start',
    group: 'Getting started',
    title: 'Quick start',
    lead: 'From a fresh login to your first applied budget change.',
    keywords: 'setup onboarding first time register invite token add account import',
    sections: [
      {
        id: 'steps',
        title: 'Setup steps',
        body: (
          <Steps>
            <Step title="Create your login">
              On the register page, add your email, a password, and the <strong>invite code</strong> a teammate gives you.
              Without the right code, signup is blocked.
            </Step>
            <Step title="Set the global Meta token">
              Go to <Link to="/accounts">Accounts</Link> and click <strong>Set token</strong> in the Global Meta Token bar.
              Paste the system user token (starts with <code>EAAb</code>). It is shared with the whole team, so if a
              teammate already set it you can skip this.
            </Step>
            <Step title="Set the global Google Sheet">
              In the Global Google Sheet bar, click <strong>Set sheet</strong> and paste the Social Budget Pacing sheet URL.
              An account can override this later in its own Settings.
            </Step>
            <Step title="Add an ad account">
              Click <strong>Add Account</strong>, enter a name and the Meta Ad Account ID. Leave Token Override blank unless
              that account uses a different token. BudgetBuddy imports its campaigns and pulls budgets from the sheet.
            </Step>
            <Step title="Check the campaign list">
              Open the account dashboard. If something is missing, use <strong>Import from Meta</strong>. If there are extras
              you don't want, hit <strong>Remove</strong> on the row.
            </Step>
            <Step title="Run pacing and apply">
              Click <strong>Run pacing</strong>, review the recommendations, then <strong>Apply</strong> the rows you agree with.
            </Step>
          </Steps>
        ),
      },
      {
        id: 'checklist',
        title: 'Sanity checklist',
        body: (
          <ul>
            <li>The campaign names in the app roughly match the names in column A of the sheet.</li>
            <li>The service account email is an <strong>Editor</strong> on the sheet.</li>
            <li>The current month has its own tab on the sheet, named like <code>September 2026</code>.</li>
            <li>ABO campaigns have ad sets tracked and allocations that add up to 100%.</li>
          </ul>
        ),
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  {
    slug: 'home',
    group: 'Using the app',
    title: 'Home page',
    lead: 'Every tracked campaign across every account, in one view.',
    keywords: 'all campaigns apply all skip run pacing search table notes',
    sections: [
      {
        id: 'layout',
        title: 'What you are looking at',
        body: (
          <>
            <p>
              Home groups campaigns by ad account. Each account is a collapsible section with its campaigns underneath.
              ABO campaigns show their ad sets indented below the campaign row.
            </p>
            <DocTable
              head={['Column', 'Meaning']}
              rows={[
                ['Mode', 'CBO or ABO. See the CBO vs ABO page.'],
                ['Budget', 'Monthly budget (from the sheet).'],
                ['MTD Spend', 'Month to date spend pulled from Meta.'],
                ['Pace', 'Actual spend divided by expected spend so far. Above 1.0 is ahead of pace, below is behind.'],
                ['Current Daily', 'The daily budget that is live in Meta right now.'],
                ['Rec. Daily', 'The daily budget that keeps the month on target.'],
                ['Status', 'Increase, Decrease, or On pace.'],
                ['Notes', 'Column F from the sheet. Click the expand icon to read the full note.'],
                ['Action', 'Apply and Skip.'],
              ]}
            />
          </>
        ),
      },
      {
        id: 'run',
        title: 'Run pacing',
        body: (
          <p>
            The blue <strong>Run pacing</strong> button at the top runs every account in order and shows progress as it goes.
            It only calculates. It does not touch Meta.
          </p>
        ),
      },
      {
        id: 'apply',
        title: 'Apply, Apply all, and Skip',
        body: (
          <>
            <ul>
              <li><strong>Apply</strong> on a row pushes that one campaign (or ad set) to Meta.</li>
              <li><strong>Apply all</strong> in an account header pushes every actionable row in that account after a confirm step.</li>
              <li><strong>Skip</strong> hides a row from the actionable count so you can mark it handled. Use the undo link to bring it back.</li>
            </ul>
            <Callout tone="warn" title="Apply is blocked for unmatched rows">
              If a campaign has no matching row on the Google Sheet, Apply is disabled. The budget is not sheet-sourced, so
              the recommendation can't be trusted. Fix the name match and re-sync. See Troubleshooting.
            </Callout>
          </>
        ),
      },
      {
        id: 'alerts',
        title: 'Alerts on an account',
        body: (
          <p>
            A strip appears inside an account when nothing is running: every flight has ended, or there is no pacing data at
            all yet. Note it also shows when some flights are pending (not started), so read the flight badges before
            assuming something is broken.
          </p>
        ),
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  {
    slug: 'accounts',
    group: 'Using the app',
    title: 'Accounts',
    lead: 'Add ad accounts and manage the shared token and sheet.',
    keywords: 'add account token global override sheet resync',
    sections: [
      {
        id: 'global',
        title: 'Global token and sheet',
        body: (
          <>
            <p>
              The bars at the top of the Accounts page hold the <strong>Global Meta Token</strong> and the
              <strong> Global Google Sheet</strong>. Both are shared across the whole workspace.
            </p>
            <Callout tone="warn" title="Changing the token changes it for everyone">
              The Meta token is workspace-wide. If any teammate updates or clears it, everyone sees the change on their next
              page load. Tell the team before you rotate it.
            </Callout>
          </>
        ),
      },
      {
        id: 'add',
        title: 'Adding an account',
        body: (
          <p>
            Click <strong>Add Account</strong>. You need an account name and the numeric Meta Ad Account ID. Token Override is
            optional and only needed if that account can't be reached with the global token. After saving, campaigns are
            imported automatically and budgets are pulled from the sheet.
          </p>
        ),
      },
      {
        id: 'cards',
        title: 'Account cards',
        body: (
          <p>
            Each card shows campaign count, monthly total, and how many are on pace, plus a status pill (on pace,
            underspending, overspending). Buttons on the card open the dashboard or settings. The refresh icon re-syncs
            campaigns from Meta and re-pulls budgets from the sheet.
          </p>
        ),
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  {
    slug: 'account-dashboard',
    group: 'Using the app',
    title: 'Account dashboard',
    lead: 'The working view for one ad account.',
    keywords: 'import from meta diagnostic remove campaign hidden run pacing apply all',
    sections: [
      {
        id: 'actions',
        title: 'Header actions',
        body: (
          <DocTable
            head={['Button', 'What it does']}
            rows={[
              ['Import from Meta', 'Lists campaigns in the ad account so you can choose which ones to track. Respects the campaign name filter in Settings.'],
              ['Diagnostic', 'Downloads a JSON health snapshot of the account. Read only, does not call Meta.'],
              ['Run pacing', 'Recalculates this account. Also pulls budgets from the sheet first and writes spend back to it after.'],
              ['History', 'Audit log for this account.'],
              ['Settings', 'Account settings, flights, and sheet config.'],
            ]}
          />
        ),
      },
      {
        id: 'tracked',
        title: 'Tracked campaigns',
        body: (
          <>
            <p>
              Each row shows budget mode (CBO or ABO), flight status, spend, pace, and the recommendation with Apply and Skip.
              Use <strong>+ Add campaign</strong> to track another one, or <strong>Remove</strong> to stop pacing it.
            </p>
            <p>
              Campaigns with no spend this month are hidden by default. There is a toggle next to the campaign count to
              show them.
            </p>
          </>
        ),
      },
      {
        id: 'flight-badge',
        title: 'Flight badges',
        body: (
          <>
            <p>The badge in the Flight column is clickable and opens a quick editor, so you don't need to go to Settings.</p>
            <DocTable
              head={['Badge', 'Meaning']}
              rows={[
                ['always on', 'Paces all month.'],
                ['active', 'Inside its flight window.'],
                ['pending', 'Flight has not started yet.'],
                ['ended', 'Flight is over.'],
              ]}
            />
          </>
        ),
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  {
    slug: 'budget-modes',
    group: 'Using the app',
    title: 'CBO vs ABO',
    lead: 'How the two Meta budget types are handled.',
    keywords: 'cbo abo ad set allocation percent split campaign budget optimization',
    sections: [
      {
        id: 'cbo',
        title: 'CBO (campaign level)',
        body: (
          <p>
            One budget on the campaign. Pacing runs once per campaign and Apply updates the campaign's daily budget. If Meta
            says the campaign isn't actually CBO, BudgetBuddy falls back to splitting across active ad sets in proportion to their
            current budgets.
          </p>
        ),
      },
      {
        id: 'abo',
        title: 'ABO (ad set level)',
        body: (
          <>
            <p>
              Budgets live on ad sets. Each tracked ad set has an <strong>allocation %</strong>. The campaign's recommended daily
              is calculated once, then split by those percentages. Apply updates each ad set.
            </p>
            <p>
              Click an allocation % on a row to edit it, or use <strong>Split evenly</strong> in the editor. The total must be 100.
            </p>
            <Callout tone="info" title="Allocations can come from the sheet">
              If the notes cell (column F) for a campaign reads like <code>Ad Set A - 40% / Ad Set B - 60%</code> and adds up to
              100, the allocations are set from it automatically on sync. Notes about dates or flights are ignored on purpose.
            </Callout>
          </>
        ),
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  {
    slug: 'flights',
    group: 'Using the app',
    title: 'Campaign flights',
    lead: 'Always on vs limited flight windows.',
    keywords: 'flight start end date always on limited ended pending',
    sections: [
      {
        id: 'types',
        title: 'Flight types',
        body: (
          <ul>
            <li><strong>Always on</strong> runs and paces all month.</li>
            <li><strong>Limited</strong> only paces inside its start and end dates.</li>
          </ul>
        ),
      },
      {
        id: 'edit',
        title: 'Where to edit',
        body: (
          <p>
            Click the flight badge on the account dashboard for a quick edit, or use <strong>Settings &gt; Campaign Flights</strong> to
            edit all campaigns in one table and save together.
          </p>
        ),
      },
      {
        id: 'split',
        title: 'Flights and sheet splits',
        body: (
          <>
            <p>
              When a sheet note splits one budget across CBO campaigns (for example 50% to A and 50% to B) and one campaign's flight
              has ended, its share is redistributed to the campaigns still running. If every campaign in the split has ended, the
              original percentages are kept so nothing is zeroed out.
            </p>
            <Callout tone="warn" title="Known limitation">
              Switching a campaign back to Always on doesn't clear its old start and end dates in the database. They are ignored
              for always on campaigns, but they linger.
            </Callout>
          </>
        ),
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  {
    slug: 'google-sheets',
    group: 'Using the app',
    title: 'Google Sheets sync',
    lead: 'How the Social Budget Pacing sheet feeds the app and gets spend written back.',
    keywords: 'sheet google service account editor tab columns match notes preview sync write spend',
    sections: [
      {
        id: 'layout',
        title: 'Sheet layout the app expects',
        body: (
          <>
            <DocTable
              head={['Column', 'Used for']}
              rows={[
                ['A', 'Campaign name (used for matching)'],
                ['B', 'Monthly budget. Read into the app.'],
                ['C', 'Month to date spend. Written by the app.'],
                ['F', 'Notes. Shown in the app and parsed for ABO allocations.'],
                ['G', 'Last paced date. Written by the app.'],
              ]}
            />
            <ul>
              <li>One tab per month, named like <code>September 2026</code>. The app reads the current month.</li>
              <li>Only the Meta section is read or written. It stops when it hits a LinkedIn or TikTok header.</li>
            </ul>
          </>
        ),
      },
      {
        id: 'access',
        title: 'Access',
        body: (
          <p>
            The app connects with a Google service account, not your personal login. Share the sheet with the service account's
            email and give it <strong>Editor</strong> access. Without that, both reading and writing will fail.
          </p>
        ),
      },
      {
        id: 'matching',
        title: 'How rows match campaigns',
        body: (
          <>
            <p>
              The app tries an exact name match first, then case insensitive, then partial matches in both directions, then a fuzzy
              match that ignores filler words (the, ads, fb, ig, campaign) and handles simple plurals. Rows scoped with an account
              prefix like <code>Commit - Foo</code> are routed to the right account.
            </p>
            <p>
              Use <strong>Settings &gt; Google Sheets &gt; Preview Matches</strong> to see exactly which sheet row each campaign
              landed on. Anything marked No match needs a name fix on one side.
            </p>
          </>
        ),
      },
      {
        id: 'when',
        title: 'When syncing happens',
        body: (
          <ul>
            <li>Before every pacing run (manual or nightly), budgets and allocations are pulled from the sheet.</li>
            <li>After pacing, MTD spend and the paced date are written back.</li>
            <li>Also on account creation and on the refresh icon on an account card.</li>
          </ul>
        ),
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  {
    slug: 'history',
    group: 'Using the app',
    title: 'History',
    lead: 'Audit trail of pacing runs and budget changes.',
    keywords: 'audit log adjustments runs auto manual',
    sections: [
      {
        id: 'what',
        title: 'What is logged',
        body: (
          <>
            <p>
              Every pacing run is logged (manual or automatic), and so is every budget adjustment pushed to Meta. Use the global
              <strong> History</strong> page in the sidebar for all accounts, or the <strong>This account</strong> link under it
              for one account.
            </p>
            <p>When a teammate asks why a budget changed, this is the first place to look.</p>
          </>
        ),
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  {
    slug: 'settings',
    group: 'Using the app',
    title: 'Settings',
    lead: 'Per account options.',
    keywords: 'campaign name filter digest email token override flights sheets',
    sections: [
      {
        id: 'pacing',
        title: 'Pacing tab',
        body: (
          <ul>
            <li>
              <strong>Campaign name filter</strong>: only import and sync campaigns whose names contain this text. Case insensitive.
              Handy when a client runs their own ads in the same ad account.
            </li>
            <li>
              <strong>Daily digest</strong>: emails you after each automated run with campaigns that need adjusting. Needs SMTP set up
              on the server.
            </li>
            <li>
              <strong>Meta token override</strong>: only for accounts that need a different token than the global one. Save with an
              empty field to clear it and go back to global.
            </li>
          </ul>
        ),
      },
      {
        id: 'flights',
        title: 'Campaign Flights tab',
        body: <p>Bulk edit flight type and dates for every campaign, then save once.</p>,
      },
      {
        id: 'sheets',
        title: 'Google Sheets tab',
        body: (
          <p>
            Set a sheet URL for this account only (overrides the global sheet), preview matches, and run the sync buttons manually
            if you want to check a change without running pacing.
          </p>
        ),
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  {
    slug: 'pacing-math',
    group: 'How it works',
    title: 'How pacing is calculated',
    lead: 'The exact formula, so you can check it by hand.',
    keywords: 'formula math recommended daily budget days remaining pace ratio status on pace increase decrease',
    sections: [
      {
        id: 'formula',
        title: 'The formula',
        body: (
          <>
            <p className="dx-formula">Recommended daily = (monthly budget &minus; MTD spend) &divide; days remaining</p>
            <p>
              This matches the math on the Social Budget Pacing sheet. There is no tolerance band, no per-run change cap, and no
              minimum floor inside the app. The only floor is Meta's own minimum daily budget.
            </p>
            <p>
              For ABO, the campaign level number is split across ad sets by allocation %.
            </p>
          </>
        ),
      },
      {
        id: 'example',
        title: 'Worked example',
        body: (
          <DocTable
            head={['Input', 'Value']}
            rows={[
              ['Monthly budget', '$504.11'],
              ['MTD spend', '$113.29'],
              ['Days remaining', '24'],
              ['Campaign recommended daily', '($504.11 - $113.29) / 24 = $16.28'],
              ['Ad set at 40%', '$6.51'],
              ['Ad set at 60%', '$9.77'],
            ]}
          />
        ),
      },
      {
        id: 'status',
        title: 'Statuses',
        body: (
          <>
            <ul>
              <li><strong>Increase</strong>: recommended is higher than the current daily budget.</li>
              <li><strong>Decrease</strong>: recommended is lower than the current daily budget.</li>
              <li><strong>On pace</strong>: within one cent of current.</li>
            </ul>
            <Callout tone="info" title="Why almost everything says Increase or Decrease">
              The recommendation is recalculated fresh every run, so tiny cent level differences show up as actionable. That is on
              purpose. You decide whether a small change is worth pushing.
            </Callout>
            <p>
              The <strong>Pace</strong> number (actual spend divided by expected spend) is for reference. It does not drive the
              recommendation.
            </p>
          </>
        ),
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  {
    slug: 'automation',
    group: 'How it works',
    title: 'Automatic runs and emails',
    lead: 'What runs without you clicking anything.',
    keywords: 'nightly cron scheduler auto pace login digest email 06:00 utc cooldown',
    sections: [
      {
        id: 'nightly',
        title: 'Nightly run',
        body: (
          <p>
            Every day at 06:00 UTC (11 PM Arizona time) the server paces every account, pulls budgets from the sheet, writes spend
            back, and logs an automatic run. It never applies budget changes.
          </p>
        ),
      },
      {
        id: 'on-open',
        title: 'Run when you open the app',
        body: (
          <p>
            After you log in, the app paces every account once, showing a progress panel. There is a 4 hour cooldown so refreshing
            the page doesn't start it again. Use <strong>Run in background</strong> on the panel to keep working while it finishes.
          </p>
        ),
      },
      {
        id: 'digest',
        title: 'Daily digest email',
        body: (
          <p>
            Turn it on per account in Settings. After each automated run you get a summary of what needs adjusting. No email will
            send until SMTP is configured on the backend.
          </p>
        ),
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  {
    slug: 'troubleshooting',
    group: 'Help',
    title: 'Troubleshooting',
    lead: 'Symptoms, likely causes, and fixes.',
    keywords: 'error problem fix broken stuck slow token expired no data apply disabled sheet not matching orphan diagnostic invite code 403',
    sections: [
      {
        id: 'data',
        title: 'Data and recommendations',
        body: (
          <>
            <Issue symptom="A campaign says 'No pacing data yet'">
              <p>It hasn't been paced since it was added. Run pacing for the account. If it still shows nothing and it's an ABO
              campaign, check that it has active ad sets tracked. See the orphan ABO issue below.</p>
            </Issue>
            <Issue symptom="Apply is greyed out on a row">
              <p>There is no matching row on the Google Sheet. Open <strong>Settings &gt; Google Sheets &gt; Preview Matches</strong> and
              find the campaign. Rename it on the sheet or in Meta so the names line up, then run pacing again.</p>
            </Issue>
            <Issue symptom="My manual budget or allocation edit got overwritten">
              <p>Expected. The sheet wins on every run for any campaign with a matching row. Change the number on the sheet.</p>
            </Issue>
            <Issue symptom="Budget looks wrong after importing a new campaign">
              <p>Imports start with a rough placeholder (daily budget times 30). The next sheet sync replaces it with the real
              monthly budget from column B. If there is no matching sheet row, it stays as the placeholder.</p>
            </Issue>
            <Issue symptom="Nearly every row says Increase or Decrease">
              <p>Normal. There is no tolerance band. See How pacing is calculated.</p>
            </Issue>
            <Issue symptom="An ABO campaign shows as $100/mo with no ad sets and never gets data">
              <p>This is an orphan. The import defaulted it to $100 and its ad sets were later archived, so nothing is tracked. Click
              <strong> Diagnostic</strong> on the account dashboard. The toast tells you how many orphans were found and the JSON lists
              each one. To clean up, Remove them from the dashboard or ask for the cleanup migration. Orphans with no spend also get hidden
              once they are over a week old.</p>
            </Issue>
          </>
        ),
      },
      {
        id: 'meta',
        title: 'Meta connection',
        body: (
          <>
            <Issue symptom="Sync, import, or Apply fails with a token or permission error">
              <p>The token expired, was revoked, or doesn't have access to that ad account. Update the global token on the Accounts
              page. If only one account fails, it needs its own Token Override in Settings.</p>
            </Issue>
            <Issue symptom="Import from Meta shows too many campaigns">
              <p>Set a <strong>Campaign name filter</strong> in Settings (for example <code>commit:2026</code>) so only matching campaigns
              are listed.</p>
            </Issue>
            <Issue symptom="Apply didn't change anything">
              <p>The toast will say the item was already on pace or unchanged. Meta also enforces its own minimum daily budget, so a
              very low recommendation gets floored there.</p>
            </Issue>
          </>
        ),
      },
      {
        id: 'sheets',
        title: 'Google Sheets',
        body: (
          <>
            <Issue symptom="Sheet sync fails or 'Sheet not updated'">
              <p>Check, in order: the sheet URL is saved, the service account email is an <strong>Editor</strong>, and the current
              month has a tab named like <code>September 2026</code>. A missing tab is the most common cause at the start of a month.</p>
            </Issue>
            <Issue symptom="Wrong allocations on an ABO campaign">
              <p>Allocations only auto-set when the notes cell follows <code>Name - 40% / Name - 60%</code> and sums to 100. Every name
              must match an ad set, and no two can hit the same one. Otherwise the parser skips it and leaves allocations alone. Edit
              them by clicking the allocation % in the app.</p>
            </Issue>
            <Issue symptom="Two campaigns share one sheet row">
              <p>Use a split note on that row (<code>50% to A / 50% to B</code>). If one campaign's flight ends, the other picks up its share.</p>
            </Issue>
          </>
        ),
      },
      {
        id: 'app',
        title: 'The app itself',
        body: (
          <>
            <Issue symptom="First load is slow, or a spinner hangs">
              <p>The backend sleeps when idle and takes up to about 15 seconds to wake. Requests time out after 60 seconds. Wait a
              moment and refresh once. A heavy account can take a minute during the open-app auto run, which is why you can send it to
              the background.</p>
            </Issue>
            <Issue symptom="Registration says 'Invalid invite code'">
              <p>Ask a teammate for the current code. It's case sensitive and is set on the server.</p>
            </Issue>
            <Issue symptom="I can see accounts I didn't add">
              <p>By design. The workspace is shared, so everyone sees every linked account.</p>
            </Issue>
            <Issue symptom="'All flights have ended' alert but the account is fine">
              <p>The alert also fires when flights are pending. Open the flight badges to check. If everything is truly ended, update the
              dates.</p>
            </Issue>
            <Issue symptom="Daily digest never arrives">
              <p>SMTP isn't configured on the backend, or the toggle is off for that account. Check Settings first, then the server's
              SMTP variables.</p>
            </Issue>
          </>
        ),
      },
      {
        id: 'still-stuck',
        title: 'Still stuck',
        body: (
          <Callout tone="info" title="Grab these before asking for help">
            <p>The account name, the campaign name, what you expected vs. what you saw, and the JSON from the Diagnostic button. That
            covers most cases.</p>
          </Callout>
        ),
      },
    ],
  },
];

export function findPage(slug) {
  return PAGES.find((p) => p.slug === slug);
}
