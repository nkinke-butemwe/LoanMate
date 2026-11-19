const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const sqlite3 = require('sqlite3').verbose();
const packageJson = require('./package.json');

// Use a day-first locale so native date pickers show dd/mm/yyyy.
app.commandLine.appendSwitch('lang', 'en-GB');

let mainWindow;
let db;

function getSafeName(rawName) {
  return rawName.toLowerCase().replace(/[^a-z0-9]/g, '-');
}

function ensureProjectFolder() {
  const safeName = getSafeName(packageJson.name);
  const folderName = `${safeName}-db`;
  const folder = path.join(app.getPath('documents'), folderName);
  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, { recursive: true });
    console.log('📁 Created folder:', folder);
  }
  return folder;
}

function connectDatabase() {
  const folder = ensureProjectFolder();
  const safeName = getSafeName(packageJson.name);
  const dbPath = path.join(folder, `${safeName}.db`);
  db = new sqlite3.Database(dbPath);
  console.log('🗄️ Connected to:', dbPath);

  db.serialize(() => {
    // Enforce foreign keys (off by default in SQLite, per connection).
    db.run('PRAGMA foreign_keys = ON');

    db.run(`CREATE TABLE IF NOT EXISTS debtors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS loans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      debtor_id INTEGER NOT NULL,
      loan_date TEXT NOT NULL,
      due_date TEXT NOT NULL,
      loan_amount REAL NOT NULL,
      transfer_charges REAL DEFAULT 0,
      repayment_amount REAL NOT NULL,
      status TEXT DEFAULT 'active',
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (debtor_id) REFERENCES debtors(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS repayments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      loan_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      repayment_date TEXT NOT NULL,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (loan_id) REFERENCES loans(id)
    )`);

    // Saved chains for the Chain Calculator (v1.10.0). `chain` holds JSON:
    // { repaymentDate: 'yyyy-mm-dd', rows: [{ date, principal, charges }] }
    db.run(`CREATE TABLE IF NOT EXISTS chains (
      chainID INTEGER PRIMARY KEY AUTOINCREMENT,
      debtor TEXT NOT NULL,
      chain TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )`);

    // Migration: add parent_loan_id to support loan extensions (v1.1.0).
    // Wrapped so it silently no-ops on databases that already have the column.
    db.run(`ALTER TABLE loans ADD COLUMN parent_loan_id INTEGER REFERENCES loans(id)`, () => {});

    // Migration: add new_principal / new_charges to support accurate capital-deployed
    // accounting for loan extensions (v1.6.0). For a root (non-extension) loan the
    // full loan_amount/transfer_charges are "new" capital. For an extension, these
    // columns hold only the incremental amount actually disbursed on top of the
    // carried-forward balance, so analytics don't double-count the rolled-over debt.
    db.run(`ALTER TABLE loans ADD COLUMN new_principal REAL DEFAULT 0`, () => {});
    db.run(`ALTER TABLE loans ADD COLUMN new_charges REAL DEFAULT 0`, () => {});
  });

  // Daily safety copy of the database (after the schema is in place).
  db.serialize(() => { backupOnStartup(folder, safeName).catch(e => console.error('Backup failed:', e)); });
}

// ── BACKUPS ────────────────────────────────────────────────────
const MAX_BACKUPS = 10;

// Consistent snapshot of the live database into `destPath` (VACUUM INTO
// refuses to overwrite, so any existing file is removed first).
async function snapshotDatabase(destPath) {
  if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
  await dbRun(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
}

// One backup per day (the latest startup that day wins); keeps the newest MAX_BACKUPS.
async function backupOnStartup(folder, safeName) {
  const dir = path.join(folder, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  await snapshotDatabase(path.join(dir, `${safeName}-${localDateStr()}.db`));
  const old = fs.readdirSync(dir)
    .filter(f => /^.+-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort()
    .reverse()
    .slice(MAX_BACKUPS);
  for (const f of old) fs.unlinkSync(path.join(dir, f));
}

// ── DB HELPERS ─────────────────────────────────────────────────
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err); else resolve(rows);
    });
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err); else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err); else resolve(row);
    });
  });
}

// Local (not UTC) calendar date as yyyy-mm-dd.
function localDateStr(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Money is stored as REAL, so round to 2 decimals before comparing amounts.
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Runs `fn` inside BEGIN/COMMIT, rolling back on any error. Transactions are
// queued so two IPC calls can never interleave inside the single connection.
let txQueue = Promise.resolve();
function withTransaction(fn) {
  const run = async () => {
    await dbRun('BEGIN');
    try {
      const result = await fn();
      await dbRun('COMMIT');
      return result;
    } catch (e) {
      try { await dbRun('ROLLBACK'); } catch (_) { /* already rolled back */ }
      throw e;
    }
  };
  const p = txQueue.then(run, run);
  txQueue = p.catch(() => {});
  return p;
}

// Shared loan SELECT fragment (reused for active and all loans)
const LOAN_SELECT = `
  SELECT l.*, d.name as debtor_name,
    COALESCE((SELECT SUM(r.amount) FROM repayments r WHERE r.loan_id=l.id),0) as total_repaid,
    l.repayment_amount - COALESCE((SELECT SUM(r.amount) FROM repayments r WHERE r.loan_id=l.id),0) as balance,
    (l.repayment_amount - l.loan_amount - l.transfer_charges) as interest,
    CASE WHEN l.due_date != '' AND l.due_date < date('now','localtime') AND l.status='active' THEN 1 ELSE 0 END as is_overdue
  FROM loans l
  JOIN debtors d ON d.id = l.debtor_id
`;

// ── IPC HANDLERS ───────────────────────────────────────────────

// DEBTORS
ipcMain.handle('get-debtors', async () => {
  return await dbAll(`
    SELECT d.*,
      COUNT(DISTINCT CASE WHEN l.parent_loan_id IS NULL OR COALESCE(l.new_principal,0) > 0 THEN l.id END) as loan_count,
      COALESCE(SUM(CASE WHEN l.status='active' THEN l.repayment_amount - COALESCE((SELECT SUM(r.amount) FROM repayments r WHERE r.loan_id=l.id),0) ELSE 0 END),0) as total_outstanding
    FROM debtors d
    LEFT JOIN loans l ON l.debtor_id = d.id
    GROUP BY d.id
    ORDER BY d.name
  `);
});

ipcMain.handle('add-debtor', async (_, data) => {
  const { name, phone, email, notes } = data;
  return await dbRun(
    'INSERT INTO debtors (name, phone, email, notes) VALUES (?,?,?,?)',
    [name, phone || null, email || null, notes || null]
  );
});

ipcMain.handle('update-debtor', async (_, data) => {
  const { id, name, phone, email, notes } = data;
  return await dbRun(
    'UPDATE debtors SET name=?, phone=?, email=?, notes=? WHERE id=?',
    [name, phone || null, email || null, notes || null, id]
  );
});

ipcMain.handle('delete-debtor', async (_, id) => {
  const row = await dbGet('SELECT COUNT(*) as n FROM loans WHERE debtor_id=?', [id]);
  if (row && row.n > 0) {
    throw new Error(`This debtor still has ${row.n} loan${row.n === 1 ? '' : 's'}. Delete those loans first.`);
  }
  return await dbRun('DELETE FROM debtors WHERE id=?', [id]);
});

// LOANS
ipcMain.handle('get-active-loans', async () => {
  return await dbAll(LOAN_SELECT + `WHERE l.status = 'active' ORDER BY l.due_date ASC`);
});

// NEW: All loans (active + closed) for Loan History page
ipcMain.handle('get-all-loans', async () => {
  return await dbAll(LOAN_SELECT + `ORDER BY l.loan_date DESC, l.id DESC`);
});

ipcMain.handle('get-loans-by-debtor', async (_, debtor_id) => {
  return await dbAll(`
    SELECT l.*,
      COALESCE((SELECT SUM(r.amount) FROM repayments r WHERE r.loan_id=l.id),0) as total_repaid,
      l.repayment_amount - COALESCE((SELECT SUM(r.amount) FROM repayments r WHERE r.loan_id=l.id),0) as balance,
      CASE WHEN l.due_date != '' AND l.due_date < date('now','localtime') AND l.status='active' THEN 1 ELSE 0 END as is_overdue
    FROM loans l
    WHERE l.debtor_id=?
    ORDER BY l.loan_date DESC
  `, [debtor_id]);
});

ipcMain.handle('add-loan', async (_, data) => {
  const { debtor_id, loan_date, due_date, loan_amount, transfer_charges, repayment_amount, notes } = data;
  // A root loan has no carried-forward balance, so its entire amount/charges are new capital.
  return await dbRun(
    'INSERT INTO loans (debtor_id, loan_date, due_date, loan_amount, transfer_charges, repayment_amount, notes, new_principal, new_charges) VALUES (?,?,?,?,?,?,?,?,?)',
    [debtor_id, loan_date, due_date || '', loan_amount, transfer_charges || 0, repayment_amount, notes || null, loan_amount, transfer_charges || 0]
  );
});

ipcMain.handle('close-loan', async (_, id) => {
  return await dbRun('UPDATE loans SET status=? WHERE id=?', ['closed', id]);
});

// Sets only a loan's due date (used by the early-payment flow, which moves the
// due date back to the day the debtor actually paid). The loan period is
// derived from loan_date -> due_date, so this also updates the period.
ipcMain.handle('set-loan-due-date', async (_, { id, due_date }) => {
  const loan = await dbGet('SELECT id FROM loans WHERE id=?', [id]);
  if (!loan) throw new Error('Loan not found');
  return await dbRun('UPDATE loans SET due_date=? WHERE id=?', [due_date || '', id]);
});

// Early settlement (v1.12.0): closes the loan at what was actually paid. The
// repayable amount becomes the total repaid (so nothing is left as a balance or
// shortfall), and the due date moves to the given date (the payment date).
ipcMain.handle('close-loan-early', async (_, { id, due_date }) => {
  const loan = await dbGet('SELECT id FROM loans WHERE id=?', [id]);
  if (!loan) throw new Error('Loan not found');
  const paid = await dbGet('SELECT COALESCE(SUM(amount),0) as total FROM repayments WHERE loan_id=?', [id]);
  return await dbRun(`UPDATE loans SET status='closed', repayment_amount=?, due_date=? WHERE id=?`, [paid.total, due_date || '', id]);
});

ipcMain.handle('delete-loan', async (_, id) => {
  return await withTransaction(async () => {
    const loan = await dbGet('SELECT id, parent_loan_id FROM loans WHERE id=?', [id]);
    if (!loan) throw new Error('Loan not found');
    const child = await dbGet('SELECT COUNT(*) as n FROM loans WHERE parent_loan_id=?', [id]);
    if (child && child.n > 0) {
      throw new Error('This loan has been extended. Delete its extension(s) first.');
    }
    await dbRun('DELETE FROM repayments WHERE loan_id=?', [id]);
    const result = await dbRun('DELETE FROM loans WHERE id=?', [id]);
    // Deleting an extension puts its parent back in play (it was only
    // 'extended' because of this loan).
    if (loan.parent_loan_id) {
      await dbRun(`UPDATE loans SET status='active' WHERE id=? AND status='extended'`, [loan.parent_loan_id]);
    }
    return result;
  });
});

// BAD DEBT
// Marking a loan as bad debt is a non-destructive status change (mirrors the
// 'extended' pattern): the loan's terms, notes and repayment history are left
// untouched, only its status flips to 'bad_debt' so it drops out of the
// active-loans list and active-loan totals.
ipcMain.handle('mark-bad-debt', async (_, id) => {
  const loan = await dbGet('SELECT status FROM loans WHERE id=?', [id]);
  if (!loan) throw new Error('Loan not found');
  if (loan.status !== 'active') throw new Error('Only active loans can be marked as bad debt');
  return await dbRun('UPDATE loans SET status=? WHERE id=?', ['bad_debt', id]);
});

// Reverses a bad-debt marking, restoring the loan to 'active' status so it
// reappears in Active Loans and active totals. Available from Loan History /
// Loan Detail for any loan currently marked bad_debt.
ipcMain.handle('undo-bad-debt', async (_, id) => {
  const loan = await dbGet('SELECT status FROM loans WHERE id=?', [id]);
  if (!loan) throw new Error('Loan not found');
  if (loan.status !== 'bad_debt') throw new Error('Loan is not marked as bad debt');
  return await dbRun('UPDATE loans SET status=? WHERE id=?', ['active', id]);
});

// LOAN EXTENSIONS
// Extending a loan creates a brand-new loan row (with its own terms —
// interest, principal, dates, etc.) linked back to the original via
// parent_loan_id, and marks the original loan as 'extended' so it no
// longer counts as active/open.
ipcMain.handle('extend-loan', async (_, data) => {
  const { original_loan_id, loan_date, due_date, loan_amount, transfer_charges, repayment_amount, notes, new_principal, new_charges } = data;

  const original = await dbGet('SELECT * FROM loans WHERE id=?', [original_loan_id]);
  if (!original) throw new Error('Original loan not found');

  // loan_amount/transfer_charges hold the FULL new loan's terms (carried-forward
  // balance + anything added). new_principal/new_charges hold ONLY the portion
  // that was actually newly disbursed at this extension (not the rolled-over
  // balance), so analytics can report accurate total capital deployed without
  // double-counting money that was never re-given to the debtor.
  return await withTransaction(async () => {
    const result = await dbRun(
      `INSERT INTO loans (debtor_id, loan_date, due_date, loan_amount, transfer_charges, repayment_amount, notes, parent_loan_id, new_principal, new_charges)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [original.debtor_id, loan_date, due_date || '', loan_amount, transfer_charges || 0, repayment_amount, notes || null, original_loan_id, new_principal || 0, new_charges || 0]
    );
    await dbRun('UPDATE loans SET status=? WHERE id=?', ['extended', original_loan_id]);
    return result;
  });
});

// Fetch the full chain of a loan: its root original loan plus every
// extension branching from it (supports multiple sequential extensions).
ipcMain.handle('get-loan-lineage', async (_, loanId) => {
  let current = await dbGet('SELECT id, parent_loan_id FROM loans WHERE id=?', [loanId]);
  if (!current) return [];
  let rootId = loanId;
  while (current && current.parent_loan_id) {
    rootId = current.parent_loan_id;
    current = await dbGet('SELECT id, parent_loan_id FROM loans WHERE id=?', [rootId]);
  }
  let ids = [rootId];
  let queue = [rootId];
  while (queue.length) {
    const pid = queue.shift();
    const children = await dbAll('SELECT id FROM loans WHERE parent_loan_id=?', [pid]);
    for (const c of children) { ids.push(c.id); queue.push(c.id); }
  }
  const placeholders = ids.map(() => '?').join(',');
  return await dbAll(LOAN_SELECT + `WHERE l.id IN (${placeholders}) ORDER BY l.loan_date ASC, l.id ASC`, ids);
});

// REPAYMENTS
ipcMain.handle('get-repayments-by-loan', async (_, loan_id) => {
  return await dbAll(
    'SELECT * FROM repayments WHERE loan_id=? ORDER BY repayment_date DESC',
    [loan_id]
  );
});

ipcMain.handle('add-repayment', async (_, data) => {
  const { loan_id, amount, repayment_date, notes } = data;
  return await withTransaction(async () => {
    const result = await dbRun(
      'INSERT INTO repayments (loan_id, amount, repayment_date, notes) VALUES (?,?,?,?)',
      [loan_id, amount, repayment_date, notes || null]
    );
    // Auto-close loan if fully repaid
    const loan = await dbGet('SELECT repayment_amount FROM loans WHERE id=?', [loan_id]);
    const paid = await dbGet('SELECT COALESCE(SUM(amount),0) as total FROM repayments WHERE loan_id=?', [loan_id]);
    if (loan && paid && round2(paid.total) >= round2(loan.repayment_amount)) {
      await dbRun('UPDATE loans SET status=? WHERE id=?', ['closed', loan_id]);
    }
    return result;
  });
});

ipcMain.handle('delete-repayment', async (_, id) => {
  await withTransaction(async () => {
    const rep = await dbGet('SELECT loan_id FROM repayments WHERE id=?', [id]);
    await dbRun('DELETE FROM repayments WHERE id=?', [id]);
    // Re-open the loan only if it was closed (never touch extended / bad_debt loans)
    if (rep) {
      const loan = await dbGet('SELECT repayment_amount, status FROM loans WHERE id=?', [rep.loan_id]);
      const paid = await dbGet('SELECT COALESCE(SUM(amount),0) as total FROM repayments WHERE loan_id=?', [rep.loan_id]);
      if (loan && paid && loan.status === 'closed' && round2(paid.total) < round2(loan.repayment_amount)) {
        await dbRun('UPDATE loans SET status=? WHERE id=?', ['active', rep.loan_id]);
      }
    }
  });
  return { success: true };
});

// ANALYTICS
//
// Two accounting concerns are handled here in JS (rather than pure SQL) because
// they both require per-loan logic that can't be expressed as a simple SUM:
//
// 1. Capital deployed ("Total Loaned"): an extension's loan_amount includes the
//    carried-forward balance of the loan(s) before it, which was never actually
//    re-handed to the debtor as new cash. Only a root loan's full amount, or an
//    extension's new_principal/new_charges (the incremental amount added at that
//    extension), represent genuinely new capital. Summing loan_amount across every
//    loan in a chain would double- (or triple-) count the same money.
// 2. Interest earned: interest shouldn't be reported as "earned" until the debtor
//    has actually repaid more than the principal + charges — it's recognized
//    incrementally as repayments come in, capped at the loan's total expected
//    interest, rather than showing the full expected figure immediately or only
//    once a loan is fully closed.
// 3. Extension chains (v1.6.2): a chain (root -> ext -> ext ...) is reported as
//    ONE loan. An extension only adds to the loan count when new principal was
//    handed over, and the chain's repayable is what was paid on earlier links
//    plus the final link's repayment_amount (which already includes the
//    carried-forward balance), so rolled-over debt isn't counted repeatedly.
ipcMain.handle('get-analytics', async () => {
  const loans = await dbAll(`
    SELECT l.*, d.name as debtor_name,
      COALESCE((SELECT SUM(r.amount) FROM repayments r WHERE r.loan_id=l.id),0) as total_repaid
    FROM loans l
    JOIN debtors d ON d.id = l.debtor_id
  `);
  const totalDebtorsRow = await dbGet('SELECT COUNT(*) as v FROM debtors');
  const todayStr = localDateStr();
  const allRepayments = await dbAll('SELECT id, loan_id, amount, repayment_date FROM repayments');
  const repsByLoan = new Map();
  for (const r of allRepayments) {
    if (!repsByLoan.has(r.loan_id)) repsByLoan.set(r.loan_id, []);
    repsByLoan.get(r.loan_id).push(r);
  }

  // Group loans into extension chains (root -> ext -> ext ...). Each chain is
  // reported as ONE loan; extensions only add to the loan count when new
  // principal was actually handed over.
  const byId = new Map(loans.map(l => [l.id, l]));
  const childOf = new Map();
  for (const l of loans) {
    if (l.parent_loan_id && byId.has(l.parent_loan_id)) childOf.set(l.parent_loan_id, l);
  }
  const roots = loans.filter(l => !l.parent_loan_id || !byId.has(l.parent_loan_id));

  let totalLoaned = 0, totalRepayable = 0, totalRepaid = 0;
  let activeLoans = 0, overdueLoans = 0, closedLoans = 0;
  let totalInterest = 0, interestCollected = 0, totalOutstanding = 0;
  const perDebtorMap = {};
  // Portfolio Growth events (v1.7.0): profit gains at repayment dates and
  // bad-debt write-offs at due dates.
  const portfolioEvents = [];

  for (const root of roots) {
    const chain = [root];
    const seen = new Set([root.id]);
    let next = childOf.get(root.id);
    while (next && !seen.has(next.id)) { chain.push(next); seen.add(next.id); next = childOf.get(next.id); }
    const terminal = chain[chain.length - 1];

    if (!perDebtorMap[root.debtor_id]) {
      perDebtorMap[root.debtor_id] = {
        name: root.debtor_name, loan_count: 0, total_loaned: 0, total_repayable: 0,
        total_interest: 0, total_repaid: 0, active_loans: 0, closed_loans: 0,
        outstanding: 0, recovered: 0
      };
    }
    const pd = perDebtorMap[root.debtor_id];

    let chainCapital = 0, chainRepaid = 0, priorRepaid = 0, chainPrincipal = 0, chainCharges = 0;

    chain.forEach((l, i) => {
      const isExt = !!l.parent_loan_id;
      const newPrincipal = isExt ? (l.new_principal || 0) : l.loan_amount;
      const newCharges = isExt ? (l.new_charges || 0) : (l.transfer_charges || 0);
      const newCapital = newPrincipal + newCharges;
      const countsAsLoan = !isExt || newPrincipal > 0;

      chainCapital += newCapital;
      chainPrincipal += newPrincipal;
      chainCharges += newCharges;
      chainRepaid += l.total_repaid;
      if (i < chain.length - 1) priorRepaid += l.total_repaid;
      // Recovery counts repayments only up to the amount due on each link, so
      // overpayments never inflate the recovery rate.
      pd.recovered += Math.min(l.total_repaid, l.repayment_amount);

      if (countsAsLoan) pd.loan_count++;

      if (l.status === 'active') {
        activeLoans++; pd.active_loans++;
        if (l.due_date && l.due_date < todayStr) overdueLoans++;
        const bal = l.repayment_amount - l.total_repaid;
        if (bal > 0) { totalOutstanding += bal; pd.outstanding += bal; }
      }
      if (l.status === 'closed') { closedLoans++; pd.closed_loans++; }
    });

    // The final link's repayment_amount already includes the balance carried
    // forward, so only add what was actually paid on the earlier links.
    const chainRepayable = priorRepaid + terminal.repayment_amount;
    const expectedInterest = chainRepayable - chainCapital;
    const recognizedInterest = Math.max(0, Math.min(expectedInterest, chainRepaid - chainCapital));

    totalLoaned += chainCapital;
    totalRepayable += chainRepayable;
    totalRepaid += chainRepaid;
    totalInterest += expectedInterest;
    interestCollected += recognizedInterest;

    pd.total_loaned += chainCapital;
    pd.total_repayable += chainRepayable;
    pd.total_repaid += chainRepaid;
    pd.total_interest += recognizedInterest;

    // ── Portfolio growth events ──
    // Repayments across the whole chain are replayed in date order. Nothing
    // counts as growth until cumulative repayments exceed the capital put in
    // (principal + charges); after that each payment adds profit, capped at the
    // chain's expected interest. Placed on the actual repayment date.
    const chainReps = [];
    chain.forEach(l => (repsByLoan.get(l.id) || []).forEach(r => chainReps.push({ ...r, due_date: l.due_date })));
    chainReps.sort((a, b) => a.repayment_date < b.repayment_date ? -1 : a.repayment_date > b.repayment_date ? 1 : a.id - b.id);
    let cumRepaid = 0, prevProfit = 0;
    for (const r of chainReps) {
      cumRepaid += r.amount;
      const profit = Math.max(0, Math.min(expectedInterest, cumRepaid - chainCapital));
      const delta = profit - prevProfit;
      if (delta > 0.005) {
        portfolioEvents.push({
          type: 'profit', date: r.repayment_date, due_date: r.due_date || '',
          delta, debtor: root.debtor_name, paid: r.amount, repaid_to_date: cumRepaid,
          principal: chainPrincipal, charges: chainCharges, capital: chainCapital,
          repayable: chainRepayable, chain_links: chain.length
        });
      }
      prevProfit = profit;
    }
    // Bad debt drops the graph by the unrecovered capital, on the due date.
    if (terminal.status === 'bad_debt') {
      const unrecovered = chainCapital - chainRepaid;
      if (unrecovered > 0.005) {
        const lastRep = chainReps.length ? chainReps[chainReps.length - 1].repayment_date : '';
        portfolioEvents.push({
          type: 'bad_debt', date: terminal.due_date || lastRep || terminal.loan_date, due_date: terminal.due_date || '',
          delta: -unrecovered, debtor: root.debtor_name, paid: 0, repaid_to_date: chainRepaid,
          principal: chainPrincipal, charges: chainCharges, capital: chainCapital,
          repayable: chainRepayable, chain_links: chain.length
        });
      }
    }
  }

  const perDebtor = Object.values(perDebtorMap).sort((a, b) => b.total_interest - a.total_interest);
  portfolioEvents.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Default period: due date of the earliest loan -> due date of the latest
  // paid-in loan, widened if needed so no event falls outside the default view.
  let defaultFrom = null, defaultTo = null;
  if (portfolioEvents.length) {
    const firstLoan = [...loans].sort((a, b) => a.loan_date < b.loan_date ? -1 : a.loan_date > b.loan_date ? 1 : a.id - b.id)[0];
    const dates = portfolioEvents.map(e => e.date);
    const lastPaidDue = portfolioEvents.filter(e => e.type === 'profit').map(e => e.due_date || e.date).sort().pop() || dates[dates.length - 1];
    defaultFrom = (firstLoan && (firstLoan.due_date || firstLoan.loan_date)) || dates[0];
    defaultTo = lastPaidDue;
    if (dates[0] < defaultFrom) defaultFrom = dates[0];
    if (dates[dates.length - 1] > defaultTo) defaultTo = dates[dates.length - 1];
  }

  return {
    totalLoaned, totalRepayable, totalRepaid,
    activeLoans, overdueLoans, closedLoans,
    totalDebtors: totalDebtorsRow.v,
    totalInterest, interestCollected, totalOutstanding,
    perDebtor,
    portfolio: { events: portfolioEvents, defaultFrom, defaultTo }
  };
});

// SAVED CHAINS
ipcMain.handle('get-chains', async () => {
  return await dbAll(`SELECT chainID, debtor, chain, created_at, updated_at FROM chains ORDER BY debtor COLLATE NOCASE, updated_at DESC, chainID DESC`);
});

ipcMain.handle('save-chain', async (_, data) => {
  const { chainID, debtor, chain } = data;
  if (!debtor || !String(debtor).trim()) throw new Error('Debtor is required');
  const json = typeof chain === 'string' ? chain : JSON.stringify(chain);
  if (chainID) {
    const r = await dbRun(`UPDATE chains SET debtor=?, chain=?, updated_at=datetime('now','localtime') WHERE chainID=?`, [String(debtor).trim(), json, chainID]);
    if (r.changes) return { chainID };
  }
  const r = await dbRun('INSERT INTO chains (debtor, chain) VALUES (?,?)', [String(debtor).trim(), json]);
  return { chainID: r.lastID };
});

ipcMain.handle('delete-chain', async (_, id) => {
  return await dbRun('DELETE FROM chains WHERE chainID=?', [id]);
});

// BACKUP EXPORT
// Saves a consistent copy of the database wherever the user chooses.
ipcMain.handle('export-backup', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(app.getPath('documents'), `loan-mate-backup-${localDateStr()}.db`),
    filters: [{ name: 'SQLite Database', extensions: ['db'] }]
  });
  if (canceled || !filePath) return { canceled: true };
  await snapshotDatabase(filePath);
  return { canceled: false, filePath };
});

// LOAN LEDGER EXPORT
// Shows a Save dialog, then writes either a PNG (data URL from the renderer's
// canvas) or an A4 PDF rendered from an HTML string in a hidden window.
ipcMain.handle('export-ledger', async (_, { type, name, html, dataUrl }) => {
  const isPdf = type === 'pdf';
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(app.getPath('documents'), name),
    filters: [isPdf ? { name: 'PDF Document', extensions: ['pdf'] } : { name: 'PNG Image', extensions: ['png'] }]
  });
  if (canceled || !filePath) return { canceled: true };
  if (isPdf) {
    // Load the ledger from a temp file (not a data: URL) so file:// font URLs resolve.
    const fontUrl = f => pathToFileURL(path.join(__dirname, 'fonts', f)).href;
    const fontCss = `
@font-face{font-family:"SF Pro Display";src:url("${fontUrl('SFPRODISPLAYREGULAR.OTF')}") format("opentype");font-weight:400}
@font-face{font-family:"SF Pro Display";src:url("${fontUrl('SFPRODISPLAYMEDIUM.OTF')}") format("opentype");font-weight:500}
@font-face{font-family:"SF Pro Display";src:url("${fontUrl('SFPRODISPLAYBOLD.OTF')}") format("opentype");font-weight:700}`;
    const fullHtml = html
      .replace('<style>', '<style>' + fontCss)
      .replace("font-family:'Segoe UI',Arial,sans-serif", "font-family:'SF Pro Display','Segoe UI',Arial,sans-serif");
    const tmp = path.join(os.tmpdir(), `loanmate-ledger-${Date.now()}.html`);
    fs.writeFileSync(tmp, fullHtml, 'utf8');
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    try {
      await win.loadFile(tmp);
      await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
      const buf = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true });
      fs.writeFileSync(filePath, buf);
    } finally {
      win.destroy();
      fs.unlink(tmp, () => {});
    }
  } else {
    fs.writeFileSync(filePath, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
  }
  return { canceled: false, filePath };
});

// ── WINDOW ─────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  connectDatabase();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
