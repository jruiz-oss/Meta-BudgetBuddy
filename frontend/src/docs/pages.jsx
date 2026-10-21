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
              Automatically each night, when you open the app (only if nothing has paced since 8:00 AM your local time), or manually with
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
            <li>The current month has its own tab on the sheet, named like <code>October 2026</code>.</li>
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
            <p>
              Campaigns that share one budget (a split on a single sheet row) sit together under a header showing the sheet row
              name, the combined budget, and the combined MTD spend. See the CBO vs ABO page. Only campaigns whose names start with
              <code>Commit</code> are shown. The Account dashboard page lists everything else that gets hidden.
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
              <li><strong>Spend only</strong> shows instead of Apply on a 0% budget group member. Its spend counts toward the group and it never gets pushed to Meta.</li>
            </ul>
            <Callout tone="warn" title="Apply is blocked for unmatched rows">
              If a campaign has no matching row on the Google Sheet, Apply is disabled. The budget is not sheet-sourced, so
              the recommendation can't be trusted. The row shows a <strong>No sheet match</strong> chip. On the account dashboard, click it to open Sheet match, which explains why. Fix the name match and re-sync. See Troubleshooting.
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
      {
        id: 'ads-manager',
        title: 'Ads Manager link',
        body: (
          <p>
            The <strong>Ads Manager</strong> link in each account header opens that ad account in Meta, set to month to date through
            yesterday and filtered to campaigns with <code>Commit</code> in the name. That is the same window pacing uses, so the
            totals line up. Ads Manager's own default includes today, which is why its numbers usually read higher.
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
              ['Refresh from sheet', 'Re-reads budgets, allocations and notes from the sheet for this account only. No Meta calls and no pacing run.'],
              ['Sheet match', 'Read only list of every row on the current sheet tab, what it matched, and why the rest did not.'],
              ['Run pacing', 'Recalculates this account. First adds any new campaigns it finds in Meta and pulls budgets from the sheet, then writes spend back to the sheet after.'],
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
            <p>Not every campaign in the ad account shows up. Home and the dashboard hide:</p>
            <ul>
              <li>Anything whose name doesn't start with <code>Commit</code> (any case). It is treated as someone else's campaign and isn't counted anywhere, not even as hidden.</li>
              <li>Campaigns whose flight has ended, no matter what they spent.</li>
              <li>Campaigns with no spend this month: two or more pacing runs this month all at $0, or never paced and imported over a week ago.</li>
            </ul>
            <p>
              Hidden ones are counted next to the campaign count. Click <strong>Show anyway</strong> to see them and
              <strong> Hide ended</strong> to put them away again.
            </p>
          </>
        ),
      },
      {
        id: 'sheet-tools',
        title: 'Refresh from sheet and Sheet match',
        body: (
          <>
            <p>
              <strong>Refresh from sheet</strong> re-reads budgets, allocations and notes for this account only. It makes no Meta
              calls and doesn't run pacing, so it can't hit rate limits or touch other accounts.
            </p>
            <p>
              <strong>Sheet match</strong> lists every row on the current tab and what it resolved to. For rows that didn't match,
              it gives a plain reason and the three closest campaign names with scores. The <strong>No sheet match</strong> chip in
              the recommendations table opens the same view, and it has a Refresh from sheet button too.
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
              100, the allocations are set from it automatically on sync. See the note formats below. Every name has to match an ad set or nothing is changed.
            </Callout>
          </>
        ),
      },
      {
        id: 'groups',
        title: 'Budget groups (one sheet row, several campaigns)',
        body: (
          <>
            <p>
              When one sheet row covers more than one CBO campaign and its notes split the budget, those campaigns form a
              <strong> budget group</strong>. Pacing runs against the group, not each campaign alone:
            </p>
            <p className="dx-formula">Group recommended daily = (group budget &minus; combined spend) &divide; days remaining</p>
            <p>
              Each member gets that number times its allocation %. If one campaign overspends, the others' recommendations shrink to
              make up for it.
            </p>
            <ul>
              <li>Home lists members together under a header with the sheet row name, combined budget, and combined MTD spend. Biggest allocation first.</li>
              <li>A member at <strong>0%</strong> is spend only. Its spend counts toward the group, it gets no share of what is left, and it can't be applied.</li>
              <li>A member whose flight has ended still has its spend counted, so the live ones aren't over-funded.</li>
            </ul>
          </>
        ),
      },
      {
        id: 'note-formats',
        title: 'Note formats the sheet sync understands',
        body: (
          <>
            <p>Put the split in column F. Chunks are separated by <code>/</code> or a new line.</p>
            <DocTable
              head={['Format', 'Example']}
              rows={[
                ['Name - 40%', 'Pays to Play - 40% / Sports Bar - 60%'],
                ['70% to Name', '70% to Weddings / 30% to Wedding Brochure'],
                ['Name: 40%', 'TCM: 40%'],
                ['Shared %, several names', 'FSP, BW, GG: 20%'],
                ['Promo flight dates, one per line', 'Clock: 6/5 - 6/20 5pm'],
              ]}
            />
            <ul>
              <li>Percentages must add up to 100 (within 1.5).</li>
              <li>Names are fuzzy matched to campaigns, or to ad sets for ABO. If any name doesn't match, or two hit the same one, the whole split is skipped and nothing changes.</li>
              <li>Promo flight lines split the budget evenly across the promos that are live today. Promos that haven't started or have ended get nothing.</li>
              <li>The key word in the sheet row name (like Core) narrows which campaigns the split can match.</li>
              <li>Anything else in the cell, like flight reminders or parentheticals, is ignored.</li>
            </ul>
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
            <li><strong>Limited</strong> only paces inside its start and end dates. With no dates set it shows as pending and isn't paced.</li>
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
              original percentages are kept so nothing is zeroed out. The ended campaign is hidden from Home and the dashboard, but its spend still counts toward the group total.
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
                ['D', 'Optional account scope: an account name or Meta ad account ID. When filled, only that account uses the row. Blank, numbers and formula errors are ignored.'],
                ['F', 'Notes. Shown in the app and parsed for budget splits and ABO allocations (see CBO vs ABO).'],
                ['G', 'Last paced date. Written by the app.'],
              ]}
            />
            <ul>
              <li>One tab per month, named like <code>October 2026</code>. The app reads the current month.</li>
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
              landed on. Anything marked No match needs a name fix on one side. The account dashboard's <strong>Sheet match</strong> button
              shows the same thing plus a plain reason and the three closest campaign names.
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
            <li>Also on account creation, on the refresh icon on an account card, and on the account dashboard's <strong>Refresh from sheet</strong> button (budgets only, no Meta calls).</li>
            <li>Spend written back is current month only. A campaign that hasn't paced this month leaves column C blank instead of showing an old month's total.</li>
            <li>For a budget group, column C gets the combined spend of every campaign in the row.</li>
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
              The <strong>History</strong> page in the sidebar is the budget adjustment log for every account, with a filter per
              account. The <strong>This account</strong> link under it opens that account's activity: every pacing run (manual or
              automatic, with a filter) and every budget adjustment pushed to Meta.
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
        title: 'Pacing Parameters tab',
        body: (
          <ul>
            <li>
              <strong>Campaign name filter</strong>: only import and sync campaigns whose names contain this text. Case insensitive.
              Handy when a client runs their own ads in the same ad account.
            </li>
            <li>
              <strong>Daily digest</strong>: after each automated run, emails a summary of campaigns that need adjusting to the
              teammate who linked the account. Needs SMTP set up on the server.
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
            Set a sheet URL for this account only (leave it blank to use the global sheet), then use <strong>Save URL</strong> and
            <strong> Preview Matches</strong>. <strong>Sync Budgets</strong> and <strong>Write Spend</strong> run each half of the
            sync by hand if you want to check a change without running pacing.
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
              For ABO, the campaign level number is split across ad sets by allocation %. For a budget group, the budget and spend
              are the combined numbers for the whole group, then split by each campaign's %. See CBO vs ABO.
            </p>
            <p>
              Spend counts through yesterday. Days remaining counts today through the end of the month.
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
              <li><strong>Spend only</strong>: a 0% budget group member. No recommendation and nothing to apply.</li>
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
            Every day at 06:00 UTC (11 PM Arizona time) the server adds any new campaigns it finds in Meta, pulls budgets from the
            sheet, paces every account, writes spend back, and logs an automatic run. It never applies budget changes.
          </p>
        ),
      },
      {
        id: 'on-open',
        title: 'Run when you open the app',
        body: (
          <p>
            After you log in, the app paces every account once, showing a progress panel. If it already ran since 8:00 AM your local time,
            it skips, so refreshing the page doesn't start it again. Use <strong>Run in background</strong> on the panel to keep working while it finishes.
          </p>
        ),
      },
      {
        id: 'digest',
        title: 'Daily digest email',
        body: (
          <p>
            Turn it on per account in Settings. After each automated run, the teammate who linked the account gets a summary of what
            needs adjusting. No email will send until SMTP is configured on the backend.
          </p>
        ),
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  {
    slug: 'chief',
    group: 'Using the app',
    title: 'Chief (quick questions)',
    lead: 'A small read-only chat for quick fact checks. It looks things up and never changes anything.',
    keywords: 'chief chat assistant ask question clicks flight spend today read only dog history saved chats new chat',
    sections: [
      {
        id: 'what-it-does',
        title: 'What it does',
        body: (
          <>
            <p>
              Tap the dog button at the bottom right of Home, an account page or a campaign page. Ask things like when a
              flight ends, how much of the budget is used, how many clicks a campaign got on a date, or what it has spent so far today.
            </p>
            <p>
              Chief does not give advice or recommendations, and it can't change budgets, flights or anything else.
              Answers are one to four sentences.
            </p>
          </>
        ),
      },
      {
        id: 'saved-chats',
        title: 'Saved chats',
        body: (
          <>
            <p>
              Closing Chief doesn't clear anything. Open it again and you're back in the same chat, even after a refresh.
              Tap the <strong>+</strong> in the header to start a fresh chat. The old one stays saved.
            </p>
            <p>
              Tap the clock icon to see every saved chat, open one to keep going, or delete it (tap the trash icon twice).
              A new chat is only saved once you send your first message.
            </p>
            <Callout tone="info" title="Saved in this browser only">
              Chats live in your browser, not on the server. They don't follow you to another browser or device, and clearing
              site data removes them. Chief keeps the latest 30 chats.
            </Callout>
          </>
        ),
      },
      {
        id: 'where-numbers-come-from',
        title: 'Where the numbers come from',
        body: (
          <>
            <DocTable
              head={['Question', 'Source']}
              rows={[
                ['Budget, flight dates, % used', 'BudgetBuddy data, spend through the last pacing run'],
                ['Clicks, conversions, a specific day', 'Live from Meta for that account'],
                ['Spend right now', 'Live from Meta, with an "as of" time in the account time zone'],
              ]}
            />
            <p>
              All math is done in code. Chief only phrases the result. If it can't find a campaign it says so and lists the
              closest names instead of guessing. If Meta fails to answer, it tells you that rather than showing zeros.
            </p>
          </>
        ),
      },
      {
        id: 'caveats',
        title: 'Good to know',
        body: (
          <>
            <Callout tone="warn" title="Meta data runs behind">
              Today's numbers can lag by a few hours, and conversions can shift for days after the fact. Chief says so when it matters.
            </Callout>
            <p>
              <strong>Conversions</strong> add up Meta's standard events: lead, purchase, complete registration, schedule,
              submit application, contact, subscribe and start trial. Custom pixel events aren't counted.
            </p>
            <p>Live lookups cover one account at a time and up to 31 days.</p>
          </>
        ),
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  {
    slug: 'phone',
    group: 'Using the app',
    title: 'Using it on your phone',
    lead: 'Same pages, same columns, laid out for a small screen.',
    keywords: 'mobile phone iphone ios android tab bar bottom scroll responsive',
    sections: [
      {
        id: 'layout',
        title: 'What changes',
        body: (
          <>
            <p>
              On a phone the left menu becomes a tab bar at the bottom (Home, Accounts, History, Docs). Page headers stack with the
              title first and the buttons wrapping underneath. Search and filters stack, and filter pills scroll sideways.
            </p>
            <p>
              Nothing is hidden. Tables keep every column and scroll sideways inside the table, with the name column pinned on the left.
              The page itself never scrolls sideways.
            </p>
          </>
        ),
      },
      {
        id: 'login',
        title: 'Login on iPhone',
        body: (
          <p>
            The app talks to the backend through the same site address, so Safari treats the login as first party. If Safari ever shows
            an accounts error, log out and back in once, then tell Jorge.
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
              <p>Either there is no matching row on the Google Sheet (the row shows No sheet match), or it is a 0% group member marked
              Spend only, which is never applied. For a match problem, click the No sheet match chip on the account dashboard or use
              <strong> Sheet match</strong> to see why. Rename the campaign on the sheet or in Meta so the names line up, then run
              pacing again.</p>
            </Issue>
            <Issue symptom="My manual budget or allocation edit got overwritten">
              <p>Expected. The sheet wins on every run for any campaign with a matching row. Change the number on the sheet.</p>
            </Issue>
            <Issue symptom="Budget looks wrong after importing a new campaign">
              <p>Imports start with a rough placeholder (daily budget times 30). The next sheet sync replaces it with the real
              monthly budget from column B. If there is no matching sheet row, it stays as the placeholder.</p>
            </Issue>
            <Issue symptom="A campaign is missing from Home or the dashboard">
              <p>Its name has to start with <code>Commit</code>, its flight can't be ended, and it can't have sat at $0 all month.
              On the dashboard, click <strong>Show anyway</strong> to see the hidden ones.</p>
            </Issue>
            <Issue symptom="Sheet column C is blank for a campaign">
              <p>It hasn't paced this month. Only current month spend is written back, so retired campaigns leave C empty instead of
              showing an old total. If it is live, run pacing.</p>
            </Issue>
            <Issue symptom="My numbers don't match Ads Manager">
              <p>Pacing counts spend through yesterday and Ads Manager includes today by default. The Ads Manager link on Home opens it
              with the same window.</p>
            </Issue>
            <Issue symptom="Nearly every row says Increase or Decrease">
              <p>Normal. There is no tolerance band. See How pacing is calculated.</p>
            </Issue>
            <Issue symptom="An ABO campaign shows as $100/mo with no ad sets and never gets data">
              <p>This is an orphan. The import defaulted it to $100 and its ad sets were later archived, so nothing is tracked. Click
              <strong> Diagnostic</strong> on the account dashboard. The toast tells you how many orphans were found and the JSON lists
              each one. To clean up, Remove them from the dashboard. Orphans with no spend also get hidden once they are over a week old.</p>
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
              month has a tab named like <code>October 2026</code>. A missing tab is the most common cause at the start of a month.</p>
            </Issue>
            <Issue symptom="Wrong allocations on an ABO campaign">
              <p>Allocations only auto-set when the notes cell uses one of the formats on the CBO vs ABO page and sums to 100. Every name
              must match an ad set, and no two can hit the same one. Otherwise the parser skips it and leaves allocations alone. Use
              Sheet match on the account dashboard to see why a row was skipped, or edit them by clicking the allocation % in the app.</p>
            </Issue>
            <Issue symptom="Two campaigns share one sheet row">
              <p>Use a split note on that row (<code>50% to A / 50% to B</code>). They become a budget group. If one campaign's flight ends, the other picks up its share.</p>
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
              <p>The backend sleeps when idle and takes a moment to wake. Requests time out after 60 seconds. Wait a
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
              <p>SMTP isn't configured on the backend, or the toggle is off for that account. The email goes to the teammate who linked
              the account, so check their inbox. Check Settings first, then the server's SMTP variables.</p>
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
