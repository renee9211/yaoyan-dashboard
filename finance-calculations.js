// Phase 3 v8: single source of truth for all financial calculations.
export const TAX_RATE = 0.05;

export function amountValue(value) {
  const number = Number(String(value ?? "").replaceAll(",", "").trim());
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

export function normalizeTaxMode(value) {
  return value === "untaxed" ? "untaxed" : "taxed";
}

export function taxedToUntaxed(value) {
  const amount = amountValue(value);
  return amount ? Math.round(amount / (1 + TAX_RATE)) : 0;
}

export function untaxedToTaxed(value) {
  const amount = amountValue(value);
  return amount ? Math.round(amount * (1 + TAX_RATE)) : 0;
}

export function projectTotalTaxed(project) {
  const quote = amountValue(project?.quote);
  if (!quote) return 0;
  return normalizeTaxMode(project?.quoteTaxMode) === "untaxed" ? untaxedToTaxed(quote) : quote;
}

export function projectRevenueUntaxed(project) {
  const quote = amountValue(project?.quote);
  if (quote) return normalizeTaxMode(project?.quoteTaxMode) === "untaxed" ? quote : taxedToUntaxed(quote);
  return amountValue(project?.revenue);
}

export function expenseUntaxed(expense) {
  const stored = amountValue(expense?.costUntaxed);
  if (stored) return stored;
  const amount = amountValue(expense?.amount);
  return normalizeTaxMode(expense?.taxMode) === "untaxed" ? amount : taxedToUntaxed(amount);
}

export function isCapitalExpense(expense) {
  return expense?.category === "equipment_purchase" || expense?.expenseType === "capital";
}

export function monthRange(month) {
  const match = String(month || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (!year || monthNumber < 1 || monthNumber > 12) return null;
  const end = new Date(year, monthNumber, 0);
  const pad = value => String(value).padStart(2, "0");
  return {
    start: `${year}-${pad(monthNumber)}-01`,
    end: `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`
  };
}

export function projectInMonth(project, month) {
  const range = monthRange(month);
  if (!range || !project?.startDate || !project?.endDate) return false;
  return project.endDate >= range.start && project.startDate <= range.end;
}

let cachedInput = null;
let cachedCalculator = null;

export function createFinanceCalculator(input = {}) {
  const normalized = {
    projects: input.projects || [],
    payments: input.payments || [],
    receipts: input.receipts || [],
    expenses: input.expenses || [],
    companyExpenses: input.companyExpenses || []
  };
  if (cachedInput && Object.keys(normalized).every(key => cachedInput[key] === normalized[key])) return cachedCalculator;

  const projectById = new Map(normalized.projects.map(project => [project.id, project]));
  const paymentsByProject = new Map();
  const receiptsByPayment = new Map();
  const expensesByProject = new Map();

  normalized.payments.forEach(payment => {
    if (payment.voided) return;
    const rows = paymentsByProject.get(payment.projectId) || [];
    rows.push(payment);
    paymentsByProject.set(payment.projectId, rows);
  });
  normalized.receipts.forEach(receipt => {
    if (receipt.voided) return;
    const rows = receiptsByPayment.get(receipt.paymentId) || [];
    rows.push(receipt);
    receiptsByPayment.set(receipt.paymentId, rows);
  });
  normalized.expenses.forEach(expense => {
    if (expense.voided) return;
    const rows = expensesByProject.get(expense.projectId) || [];
    rows.push(expense);
    expensesByProject.set(expense.projectId, rows);
  });

  function actualReceipts(paymentId) {
    return receiptsByPayment.get(paymentId) || [];
  }

  function receiptRows(payment) {
    const rows = actualReceipts(payment?.id);
    if (rows.length) return rows;
    const legacyAmount = amountValue(payment?.receivedAmount);
    return legacyAmount ? [{
      id: `legacy:${payment.id}`,
      paymentId: payment.id,
      amount: legacyAmount,
      receivedDate: payment.receivedDate || "",
      method: payment.receivedMethod || "",
      reference: "",
      note: "舊版收款紀錄",
      legacy: true
    }] : [];
  }

  function receivedForPayment(payment, throughDate = "") {
    return receiptRows(payment)
      .filter(receipt => !throughDate || (receipt.receivedDate && receipt.receivedDate <= throughDate))
      .reduce((sum, receipt) => sum + amountValue(receipt.amount), 0);
  }

  function paymentStatus(payment, today = "") {
    if (payment?.voided) return "void";
    const amount = amountValue(payment?.amount);
    const received = receivedForPayment(payment);
    if (amount > 0 && received >= amount) return "paid";
    if (payment?.requestDate && payment?.expectedPaymentDate && today && payment.expectedPaymentDate < today) return "overdue";
    if (received > 0) return "partial";
    if (payment?.requestDate) return "requested";
    return "pending";
  }

  function projectPaymentSummary(project, { today = "" } = {}) {
    const rows = paymentsByProject.get(project?.id) || [];
    const total = projectTotalTaxed(project);
    const scheduled = rows.reduce((sum, payment) => sum + amountValue(payment.amount), 0);
    const invoiced = rows.filter(payment => payment.requestDate).reduce((sum, payment) => sum + amountValue(payment.amount), 0);
    const received = rows.reduce((sum, payment) => sum + receivedForPayment(payment), 0);
    const receivable = rows.filter(payment => payment.requestDate)
      .reduce((sum, payment) => sum + Math.max(0, amountValue(payment.amount) - receivedForPayment(payment)), 0);
    const hasOverdue = rows.some(payment => paymentStatus(payment, today) === "overdue");
    let status = "pending";
    if (!total) status = "pricePending";
    else if (rows.length && received >= total) status = "paid";
    else if (hasOverdue) status = "overdue";
    else if (received > 0) status = "partial";
    else if (invoiced > 0) status = "requested";
    return {
      rows,
      total,
      scheduled,
      invoiced,
      received,
      unbilled: total ? Math.max(0, total - invoiced) : 0,
      receivable,
      totalOutstanding: total ? Math.max(0, total - received) : receivable,
      unscheduled: total ? Math.max(0, total - scheduled) : 0,
      status,
      isTracked: rows.length > 0
    };
  }

  function projectExpenses(projectOrId) {
    const projectId = typeof projectOrId === "object" ? projectOrId?.id : projectOrId;
    return expensesByProject.get(projectId) || [];
  }

  function projectExternalCost(project) {
    const rows = projectExpenses(project);
    return rows.length ? rows.reduce((sum, expense) => sum + expenseUntaxed(expense), 0) : amountValue(project?.cost);
  }

  function projectProfit(project) {
    return projectRevenueUntaxed(project) - projectExternalCost(project);
  }

  function paymentRow(payment, throughDate = "") {
    const project = projectById.get(payment?.projectId);
    const amount = amountValue(payment?.amount);
    const received = receivedForPayment(payment, throughDate);
    return {
      ...payment,
      project,
      projectName: payment?.projectName || project?.name || "未命名專案",
      customerName: payment?.customerName || project?.client || "未填客戶",
      amount,
      received,
      remaining: Math.max(0, amount - received)
    };
  }

  function allReceiptRows() {
    return normalized.payments.filter(payment => !payment.voided)
      .flatMap(payment => receiptRows(payment).map(receipt => ({ ...receipt, payment })));
  }

  function monthlySummary(month) {
    const range = monthRange(month);
    const projects = normalized.projects.filter(project => project.status !== "lost" && projectInMonth(project, month));
    const revenue = projects.reduce((sum, project) => sum + projectRevenueUntaxed(project), 0);
    const externalCost = projects.reduce((sum, project) => sum + projectExternalCost(project), 0);
    const profit = revenue - externalCost;
    const closedRevenue = projects.filter(project => project.status === "closed")
      .reduce((sum, project) => sum + projectRevenueUntaxed(project), 0);
    const invoiced = range ? normalized.payments
      .filter(payment => !payment.voided && payment.requestDate >= range.start && payment.requestDate <= range.end)
      .reduce((sum, payment) => sum + amountValue(payment.amount), 0) : 0;
    const received = range ? allReceiptRows()
      .filter(receipt => receipt.receivedDate >= range.start && receipt.receivedDate <= range.end)
      .reduce((sum, receipt) => sum + amountValue(receipt.amount), 0) : 0;
    const companyRows = range ? normalized.companyExpenses
      .filter(expense => !expense.voided && expense.expenseDate >= range.start && expense.expenseDate <= range.end) : [];
    const companyOperatingExpense = companyRows.filter(expense => !isCapitalExpense(expense))
      .reduce((sum, expense) => sum + expenseUntaxed(expense), 0);
    const companyCapitalExpense = companyRows.filter(isCapitalExpense)
      .reduce((sum, expense) => sum + expenseUntaxed(expense), 0);
    return {
      month,
      range,
      projects,
      revenue,
      externalCost,
      profit,
      closedRevenue,
      invoiced,
      received,
      companyOperatingExpense,
      companyCapitalExpense,
      companyTotalExpense: companyOperatingExpense + companyCapitalExpense,
      operatingBalance: profit - companyOperatingExpense
    };
  }

  cachedInput = normalized;
  cachedCalculator = {
    projectById,
    actualReceipts,
    receiptRows,
    receivedForPayment,
    paymentStatus,
    projectPaymentSummary,
    projectExpenses,
    projectExternalCost,
    projectProfit,
    paymentRow,
    allReceiptRows,
    monthlySummary
  };
  return cachedCalculator;
}
