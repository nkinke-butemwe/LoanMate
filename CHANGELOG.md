# Changelog

All notable changes to LoanMate will be documented in this file.

---

## [1.6.4] — Recovery Capped at Amount Due

### Changed
- **Per-debtor Recovery is now capped at the amount due**: repayments count towards recovery only up to each loan's repayable amount, so overpayments no longer inflate the percentage.
- **Removed the "+K credit" tag** from the Analytics Per-Debtor Breakdown's Outstanding column (introduced in 1.6.3). The column now simply shows the balance still owed on active loans. Overpayment credit is still shown on the Loan History and Loan Detail views.

### Notes
- `get-analytics` now returns `recovered` per debtor (replacing the short-lived `credit` field). The Repaid column still shows the actual amount paid.

---

## [1.6.3] — Overpayment Credit No Longer Reduces Amount Owed

### Fixed
- **Analytics "Outstanding / Credit" no longer nets overpayment credit against what is owed.** Previously it was `total repayable − total repaid`, so a K430 overpayment on a closed loan reduced the debtor's real K2,500 balance to K2,070. Outstanding now shows the actual balance still owed on active loans, and any overpayment credit is shown separately beneath it as a "+K credit" tag.

### Notes
- `get-analytics` now returns `outstanding` and `credit` per debtor; the Per-Debtor Breakdown table uses them. Totals elsewhere are unchanged.
- Bad-debt and extended loans don't count towards Outstanding (consistent with the Dashboard).

---

## [1.6.2] — Extension Chains Count as One Loan

### Fixed
- **Loan extensions no longer inflate the loan count.** An extension now only counts as a new loan if new principal was actually handed over (`new_principal > 0`). Pure due-date extensions or rollovers of the outstanding balance no longer add to the count.
  - Applies to the Debtors page **Total Loans** column and the Analytics per-debtor **Loans** column and Monthly Loan Activity loan counts.
- **Total Repayable, Outstanding/Credit and Recovery are no longer inflated by extensions.** Each extension's repayment amount already includes the balance carried forward, so summing every link counted the same debt several times. Analytics now treats each extension chain as one loan: repayable = amounts repaid on earlier links + the final link's repayment amount.
  - Example: a debtor with 4 real loans and 5 date/balance extensions previously showed 9 loans, K17,800 repayable and 36% recovery; he now shows 4 loans and correct repayable/recovery figures.
- Interest earned is now recognized per chain rather than per link, and attributed to the month the chain started.

### Notes
- Reporting-only change (`get-debtors` and `get-analytics` in `main.js`); no schema, IPC signature, `index.html` or `preload.js` changes. Loan History and the Loan Detail chain view still list every link as an audit trail.
- Extensions created before v1.6.0 have `new_principal = 0` and are treated as pure extensions. If cash was added on one of those, set `loans.new_principal` / `new_charges` on that row manually to have it counted as a new loan.

---

## [1.6.1] — Active Capital Out Reflects Partial Repayments

### Fixed
- **Dashboard "Active Capital Out" now decreases as repayments come in**, instead of staying at the full principal until a loan was completely settled. Previously it could exceed the Outstanding Balance after a partial payment, which was confusing.
  - Each active loan now contributes `max(0, principal − total repaid)` to Active Capital Out.
  - Repayments reduce capital out only until the principal is recovered; anything paid beyond that is interest and never pushes capital below zero or reduces it further.
  - Example: John borrows K9,000 to repay K10,800 → Outstanding K10,800, Active Capital Out K9,000. He pays K5,000 → Outstanding K5,800, Active Capital Out K4,000. He pays the remaining K5,800 → only the remaining K4,000 comes off capital (Active Capital Out K0), not the full K5,800.

### Changed
- The stat card's sub-label now reads "principal not yet recovered" (was "principal loaned").

### Notes
- Frontend-only change (`loadDashboard` in `index.html`); no schema, IPC, or stored-data changes. The Analytics page's Total Capital Deployed (all-time, from v1.6.0) is unaffected — this only changes the Dashboard's *active* capital figure.
- Repayments are treated as recovering principal first, then transfer charges/interest, consistent with how interest is recognized in v1.6.0.

---

## [1.6.0] — Accurate Capital-Deployed & Earned-Interest Accounting

### Fixed
- **Extended loans no longer double-count capital deployed.** Previously, Analytics summed `loan_amount` across every loan in a chain, so a loan that was extended without adding any new money looked like it had been loaned out twice (e.g. a K2,000 loan extended with no new cash showed as K4,000 loaned). Now only the amount actually newly disbursed counts:
  - If a K2,000 loan is extended with no additional cash, total capital deployed still shows K2,000.
  - If a K2,000 loan is extended and K400 is added, total capital deployed shows K2,400 — not K2,000 + K2,400.
  - This affects the Analytics **Total Capital Deployed** stat, the **Amount Loaned by Debtor** chart / per-debtor **Total Loaned** column, and the **Monthly Loan Activity** chart's "Loaned" series.
- **Interest Earned no longer counts before it's actually paid.** Interest by debtor (Analytics bar chart, per-debtor breakdown table, and the Total Interest Earned stat) previously showed the full *expected* interest on every loan regardless of repayment progress. It's now recognized incrementally: interest only starts counting once a debtor's total repayments exceed the loan's principal + transfer charges, and is capped at the loan's total expected interest. A loan with no repayments yet shows K0 interest earned, even though it's expected to earn interest eventually.

### Changed
- **Extend Loan modal reworked**: Principal and Transfer Charges are no longer single free-text totals to retype. Each now shows the carried-forward amount (read-only) plus an "Add amount…" field with a **+ Add** button — click Add and it accumulates onto the running total, same for charges, so you only ever type the *new* money being handed over rather than recalculating the full balance yourself.
- `loans` table gains new nullable `new_principal REAL DEFAULT 0` and `new_charges REAL DEFAULT 0` columns (added via a non-destructive `ALTER TABLE` migration, safe to run against existing databases). For a root (non-extension) loan these always equal the loan's full `loan_amount`/`transfer_charges`. For an extension, they hold only the incremental amount added via the new "+ Add" flow — the carried-forward portion is excluded so it isn't counted as new capital.
- `get-analytics` was reworked from pure SQL aggregation to per-loan JS aggregation, since correctly distinguishing "new capital" and "recognized interest" per loan (accounting for whether it's a root loan or extension, and how much has been repaid) isn't expressible as a simple `SUM()`.

### Notes
- These changes are accounting/reporting fixes only — they don't alter any stored loan terms, balances, or repayment history, and don't change how overdue/bad-debt/overpayment logic works elsewhere in the app.
- Existing extensions created before this update have `new_principal`/`new_charges` of `0` (the migration default), so their full carried-forward amount won't retroactively appear as new capital — only extensions created going forward will track the added-amount split correctly. If you need historical figures corrected, the values can be set manually against `loans.new_principal` / `loans.new_charges` for those rows.

---

## [1.5.0] — Optional Due Date

### Added
- **Due Date is now optional** on the Add Loan modal and the Extend Loan modal (labeled "(optional)"). A loan can be created or extended with no due date set, for open-ended arrangements with no fixed repayment deadline.
  - Loans with no due date display **"No due date"** wherever a due date would normally appear: Active Loans, Loan History, the Dashboard, the Debtor Detail view, the Loan Detail modal, and the Loan Chain / Lineage table.
  - Loans with no due date are **never flagged as overdue** — they're excluded from the overdue count/badge, the Dashboard's Overdue Loans panel, the History page's Overdue filter, and the Analytics "Outstanding" overdue stat.
  - Repayments on a loan with no due date are never flagged as late (the "⚠ Xd late" badge from v1.2.0 requires a due date to compare against).
  - Sorting by **Due Date** (Active Loans, Loan History, Dashboard) now sends loans with no due date to the end of the list, regardless of sort direction, instead of breaking the sort.

### Changed
- `due_date` is stored as an empty string (`''`) rather than `NULL` when left blank, so the existing `NOT NULL` column constraint doesn't require a schema migration. All `is_overdue` SQL checks (`get-active-loans`, `get-all-loans`, `get-loans-by-debtor`, and the Analytics `overdueLoans` count) now explicitly guard against blank due dates so an empty string never sorts/compares as "in the past."

### Notes
- Loan Date remains required on both the Add Loan and Extend Loan modals — only Due Date can be left blank.
- The standalone Loan Calculator (v1.3.0) is unaffected; both its dates remain required since it needs a loan period to compute interest.

---

## [1.4.0] — Bad Debt Marking

### Added
- **Mark as Bad Debt**: any *active* loan can now be flagged as bad debt (written off) via a new "💀" action available on the Active Loans table, the Loan History table, and the Loan Detail modal.
  - Marking a loan sets its status to `bad_debt` — a non-destructive change (same pattern as loan extensions): terms, notes, and repayment history are left untouched. The loan disappears from Active Loans and is excluded from active-loan totals, active balances, and outstanding-balance analytics, since it's treated as written off.
  - The Loan Detail modal shows a dedicated warning box for bad-debt loans, calling out the written-off balance.
- **Undo Bad Debt**: bad-debt loans can be restored to `active` status at any time via a new "↩️ Undo Bad Debt" action, available from the Loan History table and the Loan Detail modal — so a mistaken or later-recovered write-off is easy to reverse. Undoing simply flips the status back to `active`; balances and history are unaffected throughout.
- **New "Bad Debt" filter tab and stat card** on the Loan History page, showing the count of bad-debt loans and the total balance written off.
- **New `badge-baddebt` status badge** ("💀 Bad Debt") shown on loan rows, loan detail, and debtor detail views wherever a loan's status is displayed.
- **New IPC/backend APIs**: `mark-bad-debt` (sets status to `bad_debt`, only valid from `active`) and `undo-bad-debt` (restores status to `active`, only valid from `bad_debt`).
- **New preload bridge methods**: `window.api.markBadDebt(id)` and `window.api.undoBadDebt(id)`.

### Notes
- Only loans currently `active` can be marked as bad debt (closed, extended, or already-bad-debt loans don't show the action). Only loans currently marked `bad_debt` can be undone.
- No schema migration is required — `bad_debt` is simply a new value for the existing `status` text column.

---

## [1.3.0] — Loan Calculator

### Added
- **New "Loan Calculator" page** (sidebar → Tools → 🧮 Loan Calculator): estimates a suggested repayment amount for a *proposed* loan before it's created — no loan is saved, this is a standalone what-if tool.
  - **Inputs**: Loan Date (defaults to today, like the other loan forms), a Suggested Due Date, the amount to be given to the debtor, and a **Cross Network** checkbox.
  - **Interest**: accrues daily on the principal at a fixed **1.428571429% per day**, based on the number of days between the loan date and the due date.
  - **Mobile money charges**: calculated from standard tiered fee tables (brackets: 0–150, 150–300, 300–500, 500–1000, 1000–3000, 3000–5000, 5000–10000):
    1. A **withdrawal charge** is looked up based on the principal amount.
    2. A **sending charge** is then looked up based on the principal **plus** the withdrawal charge.
    3. When **Cross Network** is checked, the sending charge uses the higher cross-network fee table instead of the standard network-to-network table; the withdrawal charge table is unaffected.
  - **Suggested Repayment Amount** = (principal + accrued interest + withdrawal charge + sending charge), **rounded down to the nearest K5**.
  - Live breakdown shown for every step (days on loan, withdrawal charge, sending charge, total charges, principal + interest, and the final suggested repayment), updating as any input changes — mirroring the live calc preview already used on the Add Loan modal.
  - Implemented entirely as a frontend calculation (`tierLookup` / `updateCalcResult` / `initCalculator` in `index.html`); no database schema, IPC, or preload changes were required.

### Notes
- This is a planning tool only — figures shown here are not persisted and don't affect any existing loan, debtor, or analytics data. Once you're happy with the numbers, create the actual loan from the Active Loans or Debtors page as usual.

---

## [1.2.0] — Late Repayment Indicator

### Added
- **Late repayment flag**: in the Loan Detail modal's Repayment History table, any repayment recorded **more than 3 days after** the loan's due date is now flagged with a "⚠ Xd late" badge showing exactly how many days after the due date it was paid.
  - Repayments made on time, or within a 3-day grace period after the due date, are left unmarked — only genuinely late payments are flagged, to avoid noise from normal payment-processing delays.
  - Implemented as a lightweight frontend calculation (`daysLate` / `lateBadge` helpers in `index.html`) comparing each repayment's `repayment_date` against the parent loan's `due_date`; no schema or backend changes were required.

### Notes
- This is a read-only, display-only indicator — it does not affect loan status, balances, or any stored data.

---

## [1.0.0] — Baseline (prior to this change)

Initial state of the application before the loan extension feature was added.

### Features
- **Electron desktop app** (`main.js`, `index.html`, `preload.js`) backed by a local SQLite database stored in the user's Documents folder.
- **Debtor management**: add, edit, delete debtors with name, phone, email, and notes; view each debtor's outstanding balance and loan count.
- **Loan management**: create loans with loan date, due date, principal amount, transfer charges, and repayment amount; automatic interest/profit calculation (repayment − principal − charges).
- **Active Loans page**: searchable/sortable table of all currently active loans with balance, due date, and repayment progress.
- **Repayments**: record repayments against a loan; loans auto-close when fully repaid, and auto-reopen if a repayment is deleted and the balance becomes outstanding again.
- **Overpayment detection**: loans paid beyond their repayment amount are flagged as "Overpaid" with the excess shown as a credit.
- **Loan History page**: view all loans (active + closed) with filters (All / Closed / Overdue / Overpaid) and search/sort.
- **Debtor detail view**: full loan history for a single debtor.
- **Analytics & Reports page**: total capital deployed, interest earned, collection rate, outstanding balance, per-debtor interest/loaned bar charts, monthly loan activity chart, and a full per-debtor breakdown table.
- **Toast notifications** and **custom confirm dialogs** (native `confirm()`/`prompt()` are unavailable in Electron renderer, so styled equivalents are used).
- Dark green-themed UI shell (based on the BarOS V4 template pattern) with cards, stat grids, badges, modals, and progress bars.

---

## [1.1.0] — Loan Extensions

### Added
- **Loan extension feature**: an active loan can now be "extended" into a brand-new loan with its own terms (new principal — typically the outstanding balance plus additional funds advanced, new transfer charges, new interest built into the repayment amount, new loan/due dates, and notes).
  - Extending a loan creates a new `loans` row linked to the original via a new `parent_loan_id` column, and marks the original loan's status as `extended` (so it no longer appears as active/open, and is excluded from active-loan totals).
  - New "🔁 Extend Loan" action is available from the Active Loans table, the Loan Detail modal, and Loan History rows for currently-active loans.
  - New **Extend Loan modal** pre-fills the outstanding balance as a starting principal and shows a live interest/profit calculation preview, mirroring the existing "Add Loan" experience.
- **Loan Chain / Lineage view**: the Loan Detail modal now shows the full chain of a loan — its original terms plus every extension that followed — so the complete history (principal, interest, dates, repayments, and status of each link) is visible in one place, whether you open the original loan or any of its extensions.
- **"Extended" status** throughout the UI:
  - New `badge-blue` "Extended" status badge on loan rows, loan detail, and debtor detail views.
  - New "Extension" tag on any loan row that is itself the result of an extension (has a `parent_loan_id`).
  - New **Extended** filter tab on the Loan History page, plus an "Extended Loans" stat card.
- **New IPC/backend APIs**: `extend-loan` (creates the extension and closes out the original) and `get-loan-lineage` (walks the extension chain in both directions to return the full linked set of loans, oldest first).
- **New preload bridge methods**: `window.api.extendLoan(data)` and `window.api.getLoanLineage(loanId)`.

### Changed
- `loans` table gains a new nullable `parent_loan_id INTEGER` column (added via a non-destructive `ALTER TABLE` migration that runs automatically on startup and is safe to run against existing databases).
- Shared loan row renderer (`renderLoanRow`) and debtor detail rendering now recognize the `extended` status value.

### Notes
- Extending a loan does **not** delete or alter the original loan's historical repayment records — they remain attached to the original loan for full auditability. Only its `status` changes to `extended`.
- Extensions can themselves be extended again; the lineage view supports multi-generation chains (original → extension → extension → …).
