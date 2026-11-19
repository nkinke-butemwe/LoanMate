const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Debtors
  getDebtors: () => ipcRenderer.invoke('get-debtors'),
  addDebtor: (data) => ipcRenderer.invoke('add-debtor', data),
  updateDebtor: (data) => ipcRenderer.invoke('update-debtor', data),
  deleteDebtor: (id) => ipcRenderer.invoke('delete-debtor', id),

  // Loans
  getActiveLoans: () => ipcRenderer.invoke('get-active-loans'),
  getAllLoans: () => ipcRenderer.invoke('get-all-loans'),
  getLoansByDebtor: (id) => ipcRenderer.invoke('get-loans-by-debtor', id),
  addLoan: (data) => ipcRenderer.invoke('add-loan', data),
  closeLoan: (id) => ipcRenderer.invoke('close-loan', id),
  deleteLoan: (id) => ipcRenderer.invoke('delete-loan', id),
  closeLoanEarly: (id, due_date) => ipcRenderer.invoke('close-loan-early', { id, due_date }),
  setLoanDueDate: (id, due_date) => ipcRenderer.invoke('set-loan-due-date', { id, due_date }),

  // Loan Extensions
  extendLoan: (data) => ipcRenderer.invoke('extend-loan', data),
  getLoanLineage: (loanId) => ipcRenderer.invoke('get-loan-lineage', loanId),

  // Bad Debt
  markBadDebt: (id) => ipcRenderer.invoke('mark-bad-debt', id),
  undoBadDebt: (id) => ipcRenderer.invoke('undo-bad-debt', id),

  // Repayments
  getRepaymentsByLoan: (id) => ipcRenderer.invoke('get-repayments-by-loan', id),
  addRepayment: (data) => ipcRenderer.invoke('add-repayment', data),
  deleteRepayment: (id) => ipcRenderer.invoke('delete-repayment', id),

  // Analytics
  getAnalytics: () => ipcRenderer.invoke('get-analytics'),

  // Loan Ledger export (PNG / PDF)
  exportLedger: (data) => ipcRenderer.invoke('export-ledger', data),

  // Saved loan chains (Chain Calculator)
  getChains: () => ipcRenderer.invoke('get-chains'),
  saveChain: (data) => ipcRenderer.invoke('save-chain', data),
  deleteChain: (id) => ipcRenderer.invoke('delete-chain', id),

  // Backup
  exportBackup: () => ipcRenderer.invoke('export-backup'),

  // Versions
  versions: {
    node: () => process.versions.node,
    chrome: () => process.versions.chrome,
    electron: () => process.versions.electron
  }
});
