// Phase 3: receivables, project expenses, company expenses, audit trail and granular permissions.
import {
  db, watchAuth, ensureUserDoc, getUserAccess, hasPermission,
  defaultPermissionsForRole, PERMISSION_KEYS
} from "./firebase.js";
import { logAction } from "./audit.js";
import { subscribeCollection, createRenderScheduler } from "./data-store.js";
import {
  taxedToUntaxed,
  expenseUntaxed as calculateExpenseUntaxed,
  isCapitalExpense as calculateIsCapitalExpense,
  createFinanceCalculator
} from "./finance-calculations.js";
import {
  collection, doc, setDoc, updateDoc, writeBatch,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const collections = {
  projects: collection(db, "projects"),
  payments: collection(db, "payments"),
  receipts: collection(db, "receipts"),
  expenses: collection(db, "expenses"),
  companyExpenses: collection(db, "companyExpenses"),
  equipment: collection(db, "equipment"),
  users: collection(db, "users"),
  auditLogs: collection(db, "auditLogs")
};

const state = {
  user: null,
  access: null,
  projects: [],
  payments: [],
  receipts: [],
  expenses: [],
  companyExpenses: [],
  equipment: [],
  users: [],
  auditLogs: [],
  unsubs: []
};

const FINANCE_PAGE_SIZE = 20;
const financePages = {
  payables: 1,
  expenses: 1,
  companyExpenses: 1,
  next30: 1,
  receivables: 1
};
const financePaginationConfig = {
  payables: { host: "#financePayablePagination", label: "應付帳款" },
  expenses: { host: "#expensePagination", label: "外部支出" },
  companyExpenses: { host: "#companyExpensePagination", label: "公司支出" },
  next30: { host: "#financeNext30Pagination", label: "預計收款" },
  receivables: { host: "#financeReceivablePagination", label: "應收帳款" }
};

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function integerValue(value) {
  const number = Number(String(value ?? "").replaceAll(",", "").trim());
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function money(value) { return integerValue(value).toLocaleString("zh-TW"); }
function pad(value) { return String(value).padStart(2, "0"); }
function isoDate(date = new Date()) { return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; }
function monthValue(date = new Date()) { return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`; }

function parseDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
}

function addDays(value, days) {
  const date = parseDate(value);
  if (!date) return "";
  date.setDate(date.getDate() + days);
  return isoDate(date);
}

function daysPastDue(dueDate, asOfDate) {
  const due = parseDate(dueDate);
  const asOf = parseDate(asOfDate);
  if (!due || !asOf) return null;
  return Math.floor((asOf - due) / 86400000);
}

function timestampValue(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function timestampText(value) {
  const time = timestampValue(value);
  if (!time) return "—";
  return new Intl.DateTimeFormat("zh-TW", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(time));
}

function expenseUntaxed(expense) {
  return calculateExpenseUntaxed(expense);
}

function companyExpenseUntaxed(expense) {
  return calculateExpenseUntaxed(expense);
}

function isCapitalExpense(expense) {
  return calculateIsCapitalExpense(expense);
}

function financeCalculator() {
  return createFinanceCalculator(state);
}

function projectFor(id) { return state.projects.find(project => project.id === id); }

function receivedForPayment(payment, throughDate = "") {
  return financeCalculator().receivedForPayment(payment, throughDate);
}

function allReceiptRows() {
  return financeCalculator().allReceiptRows();
}

function paymentRow(payment) {
  return financeCalculator().paymentRow(payment);
}

function filterContext() {
  return {
    keyword: $("#financeSearch")?.value.trim().toLocaleLowerCase("zh-Hant") || "",
    customer: $("#financeCustomerFilter")?.value || "all",
    month: $("#financeMonth")?.value || monthValue(),
    asOf: $("#financeAsOfDate")?.value || isoDate()
  };
}

function resetFinancePages(keys = Object.keys(financePages)) {
  keys.forEach(key => { if (key in financePages) financePages[key] = 1; });
}

function sortFinanceRows(rows, sortBy, { dateValue, amountValue, nameValue }) {
  const list = [...rows];
  list.sort((a, b) => {
    if (sortBy === "dateAsc" || sortBy === "dateDesc") {
      const dateA = String(dateValue(a) || "");
      const dateB = String(dateValue(b) || "");
      if (!dateA && !dateB) return 0;
      if (!dateA) return 1;
      if (!dateB) return -1;
      const result = dateA.localeCompare(dateB);
      return sortBy === "dateDesc" ? -result : result;
    }
    if (sortBy === "amountAsc" || sortBy === "amountDesc") {
      const result = integerValue(amountValue(a)) - integerValue(amountValue(b));
      return sortBy === "amountDesc" ? -result : result;
    }
    const result = String(nameValue(a) || "").localeCompare(String(nameValue(b) || ""), "zh-Hant", { numeric: true, sensitivity: "base" });
    return sortBy === "nameDesc" ? -result : result;
  });
  return list;
}

function financeResultText(totalItems, key) {
  if (!totalItems) return "共 0 筆";
  const page = financePages[key] || 1;
  const start = (page - 1) * FINANCE_PAGE_SIZE + 1;
  const end = Math.min(page * FINANCE_PAGE_SIZE, totalItems);
  return totalItems > FINANCE_PAGE_SIZE ? `共 ${totalItems} 筆（顯示 ${start}–${end}）` : `共 ${totalItems} 筆`;
}

function renderFinancePagination(key, totalItems) {
  const config = financePaginationConfig[key];
  const host = config ? $(config.host) : null;
  if (!host) return;
  const totalPages = Math.max(1, Math.ceil(totalItems / FINANCE_PAGE_SIZE));
  financePages[key] = Math.min(Math.max(1, financePages[key] || 1), totalPages);
  if (totalPages <= 1) {
    host.innerHTML = "";
    return;
  }
  const visiblePages = new Set([1, totalPages]);
  for (let page = financePages[key] - 2; page <= financePages[key] + 2; page += 1) {
    if (page >= 1 && page <= totalPages) visiblePages.add(page);
  }
  const pageButtons = [...visiblePages].sort((a, b) => a - b).map((page, index, pages) => {
    const gap = index > 0 && page - pages[index - 1] > 1 ? `<span class="pagination-ellipsis" aria-hidden="true">…</span>` : "";
    return `${gap}<button class="page-number ${page === financePages[key] ? "active" : ""}" type="button" data-page="${page}" ${page === financePages[key] ? 'aria-current="page"' : ""}>${page}</button>`;
  }).join("");
  const pageOptions = Array.from({ length: totalPages }, (_, index) => index + 1)
    .map(page => `<option value="${page}" ${page === financePages[key] ? "selected" : ""}>${page}</option>`).join("");
  host.innerHTML = `
    <button class="page-direction" type="button" data-page="${financePages[key] - 1}" ${financePages[key] === 1 ? "disabled" : ""}>上一頁</button>
    <div class="pagination-pages">${pageButtons}</div>
    <span class="pagination-summary">第 ${financePages[key]} / ${totalPages} 頁</span>
    <label class="pagination-jump"><span>跳至</span><select data-page-select aria-label="選擇${esc(config.label)}頁數">${pageOptions}</select><span>頁</span></label>
    <button class="page-direction" type="button" data-page="${financePages[key] + 1}" ${financePages[key] === totalPages ? "disabled" : ""}>下一頁</button>`;
}

function paginateFinanceRows(rows, key) {
  renderFinancePagination(key, rows.length);
  const start = (financePages[key] - 1) * FINANCE_PAGE_SIZE;
  return rows.slice(start, start + FINANCE_PAGE_SIZE);
}

function updateFinanceFilterUi(context) {
  const hasFilters = Boolean(context.keyword || context.customer !== "all" || context.month !== monthValue() || context.asOf !== isoDate());
  $("#financeClearFilters")?.classList.toggle("hidden", !hasFilters);
  const companyHasFilters = Boolean($("#companyExpenseSearch")?.value.trim() || ($("#companyExpenseCategoryFilter")?.value || "all") !== "all");
  $("#companyExpenseClearFilters")?.classList.toggle("hidden", !companyHasFilters);
}

function matchesContext(row, context, { includeKeyword = true } = {}) {
  if (context.customer !== "all" && row.customerName !== context.customer) return false;
  if (!includeKeyword || !context.keyword) return true;
  return [row.customerName, row.projectName, row.invoiceNumber, row.label, row.vendor, row.note]
    .join(" ").toLocaleLowerCase("zh-Hant").includes(context.keyword);
}

function activePaymentRows(context = filterContext()) {
  return state.payments
    .filter(payment => !payment.voided && payment.requestDate)
    .map(paymentRow)
    .filter(row => row.remaining > 0 && matchesContext(row, context));
}

function agingBucket(row, asOf) {
  if (!row.expectedPaymentDate) return "unknown";
  const days = daysPastDue(row.expectedPaymentDate, asOf);
  if (days === null) return "unknown";
  if (days <= 0) return "current";
  if (days <= 30) return "d30";
  if (days <= 60) return "d60";
  if (days <= 90) return "d90";
  return "d91";
}

function agingLabel(row, asOf) {
  const bucket = agingBucket(row, asOf);
  if (bucket === "unknown") return "未設定收款日";
  const days = daysPastDue(row.expectedPaymentDate, asOf);
  if (days <= 0) return days === 0 ? "今日到期" : `${Math.abs(days)} 天後到期`;
  return `逾期 ${days} 天`;
}

function agingBadge(row, asOf) {
  const bucket = agingBucket(row, asOf);
  if (bucket === "current") return "green";
  if (bucket === "unknown") return "neutral";
  return bucket === "d91" ? "red" : "orange";
}

function refreshCustomerOptions() {
  const select = $("#financeCustomerFilter");
  if (!select) return;
  const current = select.value || "all";
  const names = new Set();
  state.projects.forEach(project => project.client && names.add(project.client));
  state.payments.forEach(payment => payment.customerName && names.add(payment.customerName));
  state.expenses.forEach(expense => expense.customerName && names.add(expense.customerName));
  select.innerHTML = `<option value="all">全部客戶</option>${[...names].sort((a, b) => a.localeCompare(b, "zh-Hant")).map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join("")}`;
  select.value = names.has(current) ? current : "all";
}

function renderAging(rows, asOf) {
  const buckets = { current: [], d30: [], d60: [], d90: [], d91: [], unknown: [] };
  rows.forEach(row => buckets[agingBucket(row, asOf)].push(row));
  const targets = {
    current: ["#agingCurrent", "#agingCurrentCount"], d30: ["#aging30", "#aging30Count"],
    d60: ["#aging60", "#aging60Count"], d90: ["#aging90", "#aging90Count"],
    d91: ["#aging91", "#aging91Count"], unknown: ["#agingUnknown", "#agingUnknownCount"]
  };
  Object.entries(targets).forEach(([key, [amountId, countId]]) => {
    $(amountId).textContent = money(buckets[key].reduce((sum, row) => sum + row.remaining, 0));
    $(countId).textContent = `${buckets[key].length} 筆`;
  });
}

function renderNext30(rows, context) {
  const end = addDays(context.asOf, 30);
  const list = sortFinanceRows(
    rows.filter(row => row.expectedPaymentDate && row.expectedPaymentDate >= context.asOf && row.expectedPaymentDate <= end),
    $("#financeNext30Sort")?.value || "dateAsc",
    { dateValue: row => row.expectedPaymentDate, amountValue: row => row.remaining, nameValue: row => row.customerName || row.projectName }
  );
  $("#financeNext30Total").textContent = money(list.reduce((sum, row) => sum + row.remaining, 0));
  $("#financeNext30Count").textContent = `${list.length} 筆即將到期`;
  if ($("#financeNext30ResultCount")) $("#financeNext30ResultCount").textContent = financeResultText(list.length, "next30");
  const pageList = paginateFinanceRows(list, "next30");
  $("#financeNext30Body").innerHTML = pageList.length ? pageList.map(row => `<tr>
    <td><b>${esc(row.expectedPaymentDate)}</b></td>
    <td><b>${esc(row.customerName)}</b><div class="table-sub">${esc(row.projectName)}</div></td>
    <td>${esc(row.label || "款項")}<div class="table-sub">發票：${esc(row.invoiceNumber || "—")}</div></td>
    <td class="num">${money(row.amount)}</td><td class="num">${money(row.received)}</td><td class="num"><b>${money(row.remaining)}</b></td>
  </tr>`).join("") : `<tr><td colspan="6"><div class="empty-state">未來 30 天沒有符合條件的預計收款。</div></td></tr>`;
}

function renderReceivables(rows, context) {
  const sorted = sortFinanceRows(rows, $("#financeReceivableSort")?.value || "dateAsc", {
    dateValue: row => row.expectedPaymentDate,
    amountValue: row => row.remaining,
    nameValue: row => row.customerName || row.projectName
  });
  $("#financeReceivableTotal").textContent = money(sorted.reduce((sum, row) => sum + row.remaining, 0));
  $("#financeReceivableCount").textContent = financeResultText(sorted.length, "receivables");
  const overdue = sorted.filter(row => (daysPastDue(row.expectedPaymentDate, context.asOf) || 0) > 0);
  $("#financeOverdueTotal").textContent = money(overdue.reduce((sum, row) => sum + row.remaining, 0));
  $("#financeOverdueCount").textContent = `${overdue.length} 筆逾期`;
  const pageList = paginateFinanceRows(sorted, "receivables");
  $("#financeReceivableBody").innerHTML = pageList.length ? pageList.map(row => `<tr>
    <td><b>${esc(row.customerName)}</b><div class="table-sub">${esc(row.projectName)}</div></td>
    <td>${esc(row.label || "款項")}</td>
    <td>${esc(row.requestDate || "—")}<div class="table-sub">發票：${esc(row.invoiceNumber || "—")} ${row.invoiceDate ? `｜${esc(row.invoiceDate)}` : ""}</div></td>
    <td>${esc(row.expectedPaymentDate || "—")}</td>
    <td class="num">${money(row.amount)}</td><td class="num">${money(row.received)}</td><td class="num"><b>${money(row.remaining)}</b></td>
    <td><span class="badge ${agingBadge(row, context.asOf)}">${esc(agingLabel(row, context.asOf))}</span></td>
  </tr>`).join("") : `<tr><td colspan="8"><div class="empty-state">目前沒有符合條件的已請款未收款項。</div></td></tr>`;
}

function expenseCategoryLabel(value) {
  return ({ outsourcing_equipment: "外包設備", temporary_staff: "臨時人力", transport: "運輸", consumables: "耗材", venue: "場租／其他場地費", other: "其他" })[value] || "其他";
}

function companyExpenseCategoryLabel(value) {
  return ({
    rent: "房租／倉租",
    utilities: "水電／網路／電話",
    payroll: "薪資／勞務／獎金",
    insurance: "保險／勞健保",
    software: "軟體／訂閱",
    equipment_purchase: "設備購買",
    equipment_maintenance: "設備維修／保養",
    office: "辦公／行政",
    marketing: "行銷／業務",
    professional: "專業服務／稅務",
    other: "其他"
  })[value] || "其他";
}

function canManageExpenses() { return hasPermission(state.access, "manageExpenses"); }
function canManageCompanyExpenses() { return hasPermission(state.access, "manageCompanyExpenses"); }
function canDelete() { return state.access?.role === "admin"; }

function payableStatus(expense, asOf = isoDate()) {
  if (expense?.payableTracked !== true) return { key: "legacyPaid", label: "舊資料／視為已付", badge: "neutral" };
  if (expense.paidDate) return { key: "paid", label: `已付款 ${expense.paidDate}`, badge: "green" };
  if (expense.expectedPaymentDate && expense.expectedPaymentDate < asOf) return { key: "overdue", label: "逾期未付", badge: "red" };
  if (expense.expectedPaymentDate) return { key: "pending", label: `待付 ${expense.expectedPaymentDate}`, badge: "orange" };
  return { key: "pending", label: "待付款／未設到期日", badge: "orange" };
}

function payableRows(context) {
  const projectRows = state.expenses.filter(expense => !expense.voided).map(expense => {
    const project = projectFor(expense.projectId);
    return { ...expense, source: "專案支出", sourceName: expense.projectName || project?.name || "未命名專案", customerName: expense.customerName || project?.client || "", itemName: expenseCategoryLabel(expense.category) };
  });
  const companyRows = state.companyExpenses.filter(expense => !expense.voided).map(expense => ({ ...expense, source: "公司支出", sourceName: companyExpenseCategoryLabel(expense.category), customerName: "", itemName: expense.name || "未命名支出" }));
  return [...projectRows, ...companyRows]
    .filter(expense => expense.payableTracked === true && !expense.paidDate)
    .filter(expense => context.customer === "all" || expense.customerName === context.customer)
    .filter(expense => !context.keyword || [expense.vendor, expense.itemName, expense.sourceName, expense.customerName, expense.note].join(" ").toLocaleLowerCase("zh-Hant").includes(context.keyword));
}

function renderPayables(context) {
  const rows = sortFinanceRows(payableRows(context), $("#financePayableSort")?.value || "dateAsc", {
    dateValue: expense => expense.expectedPaymentDate,
    amountValue: expense => expense.amount,
    nameValue: expense => expense.vendor || expense.itemName
  });
  const overdue = rows.filter(expense => payableStatus(expense, context.asOf).key === "overdue");
  const end = addDays(context.asOf, 30);
  const next30 = rows.filter(expense => expense.expectedPaymentDate && expense.expectedPaymentDate >= context.asOf && expense.expectedPaymentDate <= end);
  $("#financePayableTotal").textContent = money(rows.reduce((sum, expense) => sum + integerValue(expense.amount), 0));
  $("#financePayableCount").textContent = `${rows.length} 筆`;
  $("#financePayableOverdue").textContent = money(overdue.reduce((sum, expense) => sum + integerValue(expense.amount), 0));
  $("#financePayableOverdueCount").textContent = `${overdue.length} 筆`;
  $("#financePayableNext30").textContent = money(next30.reduce((sum, expense) => sum + integerValue(expense.amount), 0));
  $("#financePayableNext30Count").textContent = `${next30.length} 筆`;
  if ($("#financePayableResultCount")) $("#financePayableResultCount").textContent = financeResultText(rows.length, "payables");
  const pageList = paginateFinanceRows(rows, "payables");
  $("#financePayableBody").innerHTML = pageList.length ? pageList.map(expense => {
    const status = payableStatus(expense, context.asOf);
    return `<tr><td>${esc(expense.expectedPaymentDate || "—")}</td><td><b>${esc(expense.vendor || "未填廠商")}</b><div class="table-sub">${esc(expense.itemName)}</div></td><td>${esc(expense.source)}<div class="table-sub">${esc(expense.sourceName)}</div></td><td class="num"><b>${money(expense.amount)}</b></td><td><span class="badge ${status.badge}">${esc(status.label)}</span></td></tr>`;
  }).join("") : `<tr><td colspan="5"><div class="empty-state">目前沒有待付的廠商款項。</div></td></tr>`;
}

function filteredExpenses(context) {
  return state.expenses.filter(expense => !expense.voided)
    .map(expense => {
      const project = projectFor(expense.projectId);
      return { ...expense, projectName: expense.projectName || project?.name || "未命名專案", customerName: expense.customerName || project?.client || "未填客戶" };
    })
    .filter(expense => !context.month || String(expense.expenseDate || "").startsWith(context.month))
    .filter(expense => matchesContext(expense, context));
}

function renderExpenses(context) {
  const list = sortFinanceRows(filteredExpenses(context), $("#expenseSort")?.value || "dateDesc", {
    dateValue: expense => expense.expenseDate,
    amountValue: expense => expense.amount,
    nameValue: expense => expense.projectName || expense.customerName
  });
  $("#expenseResultCount").textContent = financeResultText(list.length, "expenses");
  $("#expenseOpenCreate").disabled = !canManageExpenses();
  const pageList = paginateFinanceRows(list, "expenses");
  $("#expenseTableBody").innerHTML = pageList.length ? pageList.map(expense => { const status = payableStatus(expense, context.asOf); return `<tr>
    <td>${esc(expense.expenseDate || "—")}</td>
    <td><b>${esc(expense.projectName)}</b><div class="table-sub">${esc(expense.customerName)}</div></td>
    <td>${esc(expenseCategoryLabel(expense.category))}<div class="table-sub">${esc(expense.vendor || "—")}</div></td>
    <td class="num">${money(expense.amount)}</td><td>${expense.taxMode === "untaxed" ? "未稅" : "含稅"}</td><td class="num"><b>${money(expenseUntaxed(expense))}</b></td><td><span class="badge ${status.badge}">${esc(status.label)}</span></td>
    <td>${esc(expense.note || "—")}</td>
    <td><div class="row-actions"><button class="btn ghost small" type="button" data-expense-edit="${esc(expense.id)}" ${canManageExpenses() ? "" : "disabled"}>編輯</button><button class="btn ghost small" type="button" data-expense-void="${esc(expense.id)}" ${canManageExpenses() ? "" : "disabled"}>作廢</button></div></td>
  </tr>`; }).join("") : `<tr><td colspan="9"><div class="empty-state">選定月份尚無逐筆外部支出；舊專案手動成本仍會保留在案件毛利計算。</div></td></tr>`;
}

function filteredCompanyExpenses(context) {
  const keyword = $("#companyExpenseSearch")?.value.trim().toLocaleLowerCase("zh-Hant") || "";
  const category = $("#companyExpenseCategoryFilter")?.value || "all";
  const list = state.companyExpenses.filter(expense => !expense.voided && String(expense.expenseDate || "").startsWith(context.month))
    .filter(expense => category === "all" || expense.category === category)
    .filter(expense => !keyword || [expense.name, expense.vendor, expense.receiptNumber, expense.equipmentName, expense.note, companyExpenseCategoryLabel(expense.category)].join(" ").toLocaleLowerCase("zh-Hant").includes(keyword));
  return sortFinanceRows(list, $("#companyExpenseSort")?.value || "dateDesc", {
    dateValue: expense => expense.expenseDate,
    amountValue: expense => expense.amount,
    nameValue: expense => expense.name || expense.vendor
  });
}

function renderCompanyExpenses(context) {
  const list = filteredCompanyExpenses(context);
  if ($("#companyExpenseOpenCreate")) $("#companyExpenseOpenCreate").disabled = !canManageCompanyExpenses();
  if (!$("#companyExpenseTableBody")) return;
  if ($("#companyExpenseResultCount")) $("#companyExpenseResultCount").textContent = financeResultText(list.length, "companyExpenses");
  const pageList = paginateFinanceRows(list, "companyExpenses");
  $("#companyExpenseTableBody").innerHTML = pageList.length ? pageList.map(expense => { const status = payableStatus(expense, context.asOf); return `<tr>
    <td>${esc(expense.expenseDate || "—")}</td>
    <td><span class="badge ${isCapitalExpense(expense) ? "orange" : "neutral"}">${isCapitalExpense(expense) ? "資本支出" : "營運支出"}</span><div class="table-sub">${esc(companyExpenseCategoryLabel(expense.category))}</div></td>
    <td><b>${esc(expense.name || "未命名支出")}</b><div class="table-sub">${esc(expense.vendor || "—")}</div></td>
    <td class="num">${money(expense.amount)}</td><td>${expense.taxMode === "untaxed" ? "未稅" : "含稅"}</td><td class="num"><b>${money(companyExpenseUntaxed(expense))}</b></td><td><span class="badge ${status.badge}">${esc(status.label)}</span></td>
    <td>${esc(expense.receiptNumber || "—")}</td><td>${esc(expense.equipmentName || "—")}</td><td>${esc(expense.note || "—")}</td>
    <td><div class="row-actions"><button class="btn ghost small" type="button" data-company-expense-edit="${esc(expense.id)}" ${canManageCompanyExpenses() ? "" : "disabled"}>編輯</button><button class="btn ghost small" type="button" data-company-expense-void="${esc(expense.id)}" ${canManageCompanyExpenses() ? "" : "disabled"}>作廢</button></div></td>
  </tr>`; }).join("") : `<tr><td colspan="11"><div class="empty-state">選定月份尚無符合條件的公司支出。</div></td></tr>`;
}

function aggregateBy(rows, keyFn) {
  const map = new Map();
  rows.forEach(row => {
    const key = keyFn(row) || "未分類";
    const current = map.get(key) || { key, invoiced: 0, received: 0, outstanding: 0, overdue: 0 };
    current.invoiced += row.amount;
    current.received += row.received;
    current.outstanding += row.remaining;
    map.set(key, current);
  });
  return [...map.values()];
}

function renderAnalysis(context) {
  const all = state.payments.filter(payment => !payment.voided && payment.requestDate).map(paymentRow)
    .filter(row => matchesContext(row, context));
  const customers = aggregateBy(all, row => row.customerName).map(item => ({ ...item, overdue: all.filter(row => row.customerName === item.key && (daysPastDue(row.expectedPaymentDate, context.asOf) || 0) > 0).reduce((sum, row) => sum + row.remaining, 0) }))
    .sort((a, b) => b.outstanding - a.outstanding).slice(0, 12);
  $("#financeCustomerStatsBody").innerHTML = customers.length ? customers.map(item => `<tr><td>${esc(item.key)}</td><td class="num">${money(item.invoiced)}</td><td class="num">${money(item.received)}</td><td class="num">${money(item.outstanding)}</td><td class="num">${money(item.overdue)}</td></tr>`).join("") : `<tr><td colspan="5">尚無資料</td></tr>`;

  const projects = aggregateBy(all, row => row.projectName).sort((a, b) => b.outstanding - a.outstanding).slice(0, 12);
  $("#financeProjectStatsBody").innerHTML = projects.length ? projects.map(item => `<tr><td>${esc(item.key)}</td><td class="num">${money(item.invoiced)}</td><td class="num">${money(item.received)}</td><td class="num">${money(item.outstanding)}</td></tr>`).join("") : `<tr><td colspan="4">尚無資料</td></tr>`;

  const months = new Set([context.month]);
  all.forEach(row => { if (row.requestDate) months.add(row.requestDate.slice(0, 7)); });
  const scopedReceipts = allReceiptRows().filter(receipt => matchesContext(paymentRow(receipt.payment), context));
  scopedReceipts.forEach(receipt => { if (receipt.receivedDate) months.add(receipt.receivedDate.slice(0, 7)); });
  const monthRows = [...months].sort((a, b) => b.localeCompare(a)).slice(0, 12).map(month => {
    const invoiced = all.filter(row => row.requestDate?.startsWith(month)).reduce((sum, row) => sum + row.amount, 0);
    const received = scopedReceipts.filter(receipt => receipt.receivedDate?.startsWith(month)).reduce((sum, receipt) => sum + integerValue(receipt.amount), 0);
    const end = `${month}-31`;
    const outstanding = state.payments.filter(payment => !payment.voided && payment.requestDate && payment.requestDate <= end && matchesContext(paymentRow(payment), context))
      .reduce((sum, payment) => sum + Math.max(0, integerValue(payment.amount) - receivedForPayment(payment, end)), 0);
    return { month, invoiced, received, outstanding };
  });
  $("#financeMonthStatsBody").innerHTML = monthRows.map(item => `<tr><td>${esc(item.month)}</td><td class="num">${money(item.invoiced)}</td><td class="num">${money(item.received)}</td><td class="num">${money(item.outstanding)}</td></tr>`).join("");
}

function renderFinance() {
  if (!$("#tab-finance")) return;
  refreshCustomerOptions();
  const context = filterContext();
  updateFinanceFilterUi(context);
  const receivables = activePaymentRows(context);
  renderReceivables(receivables, context);
  renderAging(receivables, context.asOf);
  renderNext30(receivables, context);
  renderPayables(context);
  renderExpenses(context);
  renderCompanyExpenses(context);
  renderAnalysis({ keyword: "", customer: "all", month: $("#reportMonth")?.value || monthValue(), asOf: context.asOf });
}

function refreshExpenseProjects(selected = "") {
  const select = $("#expenseProjectId");
  if (!select) return;
  const current = selected || select.value;
  select.innerHTML = `<option value="">請選擇專案</option>${state.projects.filter(project => project.status !== "lost").sort((a, b) => String(b.startDate || "").localeCompare(String(a.startDate || ""))).map(project => `<option value="${esc(project.id)}">${esc(project.name)}${project.client ? `｜${esc(project.client)}` : ""}</option>`).join("")}`;
  select.value = current;
}

function updateExpenseHint() {
  const amount = integerValue($("#expenseAmount")?.value);
  const untaxed = $("#expenseTaxMode")?.value === "untaxed" ? amount : taxedToUntaxed(amount);
  $("#expenseUntaxedHint").textContent = `未稅成本：${money(untaxed)}`;
}

function openExpense(expense = null) {
  if (!canManageExpenses()) return alert("你目前沒有新增或編輯外部支出的權限");
  refreshExpenseProjects(expense?.projectId || "");
  $("#expenseId").value = expense?.id || "";
  $("#expenseProjectId").value = expense?.projectId || "";
  $("#expenseDate").value = expense?.expenseDate || isoDate();
  $("#expenseCategory").value = expense?.category || "outsourcing_equipment";
  $("#expenseVendor").value = expense?.vendor || "";
  $("#expenseAmount").value = expense?.amount ? money(expense.amount) : "";
  $("#expenseTaxMode").value = expense?.taxMode || "taxed";
  $("#expenseVendorBillDate").value = expense?.vendorBillDate || "";
  $("#expenseExpectedPaymentDate").value = expense?.expectedPaymentDate || "";
  $("#expensePaidDate").value = expense ? (expense.payableTracked === true ? (expense.paidDate || "") : (expense.expenseDate || "")) : "";
  $("#expensePaymentMethod").value = expense?.paymentMethod || "bank_transfer";
  $("#expenseNote").value = expense?.note || "";
  $("#expenseDrawerTitle").textContent = expense ? "編輯外部支出" : "新增外部支出";
  updateExpenseHint();
  $("#expenseDrawer").classList.remove("hidden");
  $("#expenseDrawer").setAttribute("aria-hidden", "false");
  document.body.classList.add("drawer-open");
}

function closeExpense() {
  $("#expenseDrawer")?.classList.add("hidden");
  $("#expenseDrawer")?.setAttribute("aria-hidden", "true");
  if (!$(".drawer:not(.hidden)")) document.body.classList.remove("drawer-open");
}

async function saveExpense() {
  if (!canManageExpenses() || !state.user) return alert("你目前沒有管理外部支出的權限");
  const id = $("#expenseId").value;
  const project = projectFor($("#expenseProjectId").value);
  if (!project) return alert("請選擇專案");
  const amount = integerValue($("#expenseAmount").value);
  if (!amount) return alert("請填寫支出金額");
  const taxMode = $("#expenseTaxMode").value === "untaxed" ? "untaxed" : "taxed";
  const payload = {
    projectId: project.id, projectName: project.name || "", customerName: project.client || "",
    expenseDate: $("#expenseDate").value, category: $("#expenseCategory").value,
    vendor: $("#expenseVendor").value.trim(), amount, taxMode,
    costUntaxed: taxMode === "untaxed" ? amount : taxedToUntaxed(amount),
    vendorBillDate: $("#expenseVendorBillDate").value,
    expectedPaymentDate: $("#expenseExpectedPaymentDate").value,
    paidDate: $("#expensePaidDate").value,
    paymentMethod: $("#expensePaymentMethod").value,
    payableTracked: true,
    note: $("#expenseNote").value.trim(), voided: false,
    updatedAt: serverTimestamp(), updatedBy: state.user.uid
  };
  const legacyCost = integerValue(project.cost);
  const activeExistingExpenses = state.expenses.filter(expense => expense.projectId === project.id && !expense.voided && expense.id !== id);
  const migrateLegacyCost = !id && legacyCost > 0 && activeExistingExpenses.length === 0;
  if (migrateLegacyCost) {
    const confirmed = confirm(`此專案目前有舊版「手動外部支出」${money(legacyCost)} 元。\n\n按「確定」後，系統會先建立一筆「期初外部支出」，再新增本次支出，避免舊成本從報表消失。\n\n若手動金額已包含本次支出，請按「取消」，先回專案調整手動合計再新增。`);
    if (!confirmed) return;
  }
  try {
    let targetId = id;
    if (id) await updateDoc(doc(db, "expenses", id), payload);
    else if (migrateLegacyCost) {
      const batch = writeBatch(db);
      const ref = doc(collections.expenses);
      const legacyRef = doc(collections.expenses);
      targetId = ref.id;
      batch.set(legacyRef, {
        projectId: project.id,
        projectName: project.name || "",
        customerName: project.client || "",
        expenseDate: payload.expenseDate || project.startDate || isoDate(),
        category: "other",
        vendor: "",
        amount: legacyCost,
        taxMode: "untaxed",
        costUntaxed: legacyCost,
        vendorBillDate: "",
        expectedPaymentDate: "",
        paidDate: "",
        paymentMethod: "other",
        payableTracked: false,
        note: "由舊版專案手動外部支出自動轉入；視為既有已發生成本。",
        legacyManualCost: true,
        voided: false,
        createdAt: serverTimestamp(),
        createdBy: state.user.uid,
        updatedAt: serverTimestamp(),
        updatedBy: state.user.uid
      });
      batch.set(ref, { ...payload, createdAt: serverTimestamp(), createdBy: state.user.uid });
      await batch.commit();
      await logAction({ action: "sync", module: "expenses", targetType: "expense", targetId: legacyRef.id, targetName: project.name, summary: `舊版手動成本轉為期初外部支出｜${money(legacyCost)} 元` });
    }
    else {
      const ref = doc(collections.expenses);
      targetId = ref.id;
      await setDoc(ref, { ...payload, createdAt: serverTimestamp(), createdBy: state.user.uid });
    }
    await logAction({ action: id ? "update" : "create", module: "expenses", targetType: "expense", targetId, targetName: project.name, summary: `${expenseCategoryLabel(payload.category)}｜${money(payload.amount)} 元${payload.vendor ? `｜${payload.vendor}` : ""}` });
    closeExpense();
  } catch (error) {
    console.error(error);
    alert("外部支出儲存失敗：請確認第三階段 Firestore Rules 已發布");
  }
}

function refreshCompanyExpenseEquipment(selected = "") {
  const select = $("#companyExpenseEquipmentId");
  if (!select) return;
  const current = selected || select.value;
  const groups = new Map();
  state.equipment.forEach(item => {
    const category = String(item.category || "未分類").trim() || "未分類";
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(item);
  });
  select.innerHTML = `<option value="">不連結設備</option>` + [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "zh-Hant"))
    .map(([category, items]) => `<optgroup label="${esc(category)}">${items.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "zh-Hant")).map(item => `<option value="${esc(item.id)}">${esc(item.name || "未命名設備")}</option>`).join("")}</optgroup>`)
    .join("");
  select.value = current;
}

function updateCompanyExpenseCategoryUI() {
  const isEquipmentPurchase = $("#companyExpenseCategory")?.value === "equipment_purchase";
  $("#companyExpenseEquipmentField")?.classList.toggle("hidden", !isEquipmentPurchase);
  if (!isEquipmentPurchase && $("#companyExpenseEquipmentId")) $("#companyExpenseEquipmentId").value = "";
}

function updateCompanyExpenseHint() {
  const amount = integerValue($("#companyExpenseAmount")?.value);
  const untaxed = $("#companyExpenseTaxMode")?.value === "untaxed" ? amount : taxedToUntaxed(amount);
  if ($("#companyExpenseUntaxedHint")) $("#companyExpenseUntaxedHint").textContent = `未稅金額：${money(untaxed)}`;
}

function openCompanyExpense(expense = null) {
  if (!canManageCompanyExpenses()) return alert("你目前沒有新增或編輯公司支出的權限");
  refreshCompanyExpenseEquipment(expense?.equipmentId || "");
  $("#companyExpenseId").value = expense?.id || "";
  $("#companyExpenseDate").value = expense?.expenseDate || isoDate();
  $("#companyExpenseCategory").value = expense?.category || "rent";
  $("#companyExpenseName").value = expense?.name || "";
  $("#companyExpenseVendor").value = expense?.vendor || "";
  $("#companyExpenseReceipt").value = expense?.receiptNumber || "";
  $("#companyExpenseAmount").value = expense?.amount ? money(expense.amount) : "";
  $("#companyExpenseTaxMode").value = expense?.taxMode || "taxed";
  $("#companyExpenseVendorBillDate").value = expense?.vendorBillDate || "";
  $("#companyExpenseExpectedPaymentDate").value = expense?.expectedPaymentDate || "";
  $("#companyExpensePaidDate").value = expense ? (expense.payableTracked === true ? (expense.paidDate || "") : (expense.expenseDate || "")) : "";
  $("#companyExpensePaymentMethod").value = expense?.paymentMethod || "bank_transfer";
  $("#companyExpenseEquipmentId").value = expense?.equipmentId || "";
  $("#companyExpenseNote").value = expense?.note || "";
  $("#companyExpenseDrawerTitle").textContent = expense ? "編輯公司支出" : "新增公司支出";
  updateCompanyExpenseCategoryUI();
  updateCompanyExpenseHint();
  $("#companyExpenseDrawer").classList.remove("hidden");
  $("#companyExpenseDrawer").setAttribute("aria-hidden", "false");
  document.body.classList.add("drawer-open");
}

function closeCompanyExpense() {
  $("#companyExpenseDrawer")?.classList.add("hidden");
  $("#companyExpenseDrawer")?.setAttribute("aria-hidden", "true");
  if (!$(`.drawer:not(.hidden)`)) document.body.classList.remove("drawer-open");
}

async function saveCompanyExpense() {
  if (!canManageCompanyExpenses() || !state.user) return alert("你目前沒有管理公司支出的權限");
  const id = $("#companyExpenseId").value;
  const category = $("#companyExpenseCategory").value;
  const name = $("#companyExpenseName").value.trim();
  const amount = integerValue($("#companyExpenseAmount").value);
  if (!$("#companyExpenseDate").value) return alert("請填寫支出日期");
  if (!name) return alert("請填寫支出項目");
  if (!amount) return alert("請填寫支出金額");
  const taxMode = $("#companyExpenseTaxMode").value === "untaxed" ? "untaxed" : "taxed";
  const equipment = category === "equipment_purchase" ? state.equipment.find(item => item.id === $("#companyExpenseEquipmentId").value) : null;
  const payload = {
    expenseDate: $("#companyExpenseDate").value,
    category,
    expenseType: category === "equipment_purchase" ? "capital" : "operating",
    name,
    vendor: $("#companyExpenseVendor").value.trim(),
    receiptNumber: $("#companyExpenseReceipt").value.trim(),
    amount,
    taxMode,
    costUntaxed: taxMode === "untaxed" ? amount : taxedToUntaxed(amount),
    equipmentId: equipment?.id || "",
    equipmentName: equipment?.name || "",
    vendorBillDate: $("#companyExpenseVendorBillDate").value,
    expectedPaymentDate: $("#companyExpenseExpectedPaymentDate").value,
    paidDate: $("#companyExpensePaidDate").value,
    paymentMethod: $("#companyExpensePaymentMethod").value,
    payableTracked: true,
    note: $("#companyExpenseNote").value.trim(),
    voided: false,
    updatedAt: serverTimestamp(),
    updatedBy: state.user.uid
  };
  try {
    let targetId = id;
    if (id) await updateDoc(doc(db, "companyExpenses", id), payload);
    else {
      const ref = doc(collections.companyExpenses);
      targetId = ref.id;
      await setDoc(ref, { ...payload, createdAt: serverTimestamp(), createdBy: state.user.uid });
    }
    await logAction({ action: id ? "update" : "create", module: "companyExpenses", targetType: "companyExpense", targetId, targetName: name, summary: `${companyExpenseCategoryLabel(category)}｜${money(amount)} 元${payload.vendor ? `｜${payload.vendor}` : ""}` });
    closeCompanyExpense();
  } catch (error) {
    console.error(error);
    alert("公司支出儲存失敗：請確認新版 Firestore Rules 已發布");
  }
}

const permissionLabels = {
  createProjects: "新增專案", editProjects: "編輯專案", manageQuotations: "報價",
  managePayments: "請款收款", manageExpenses: "專案外部支出", manageCompanyExpenses: "公司支出", createEquipment: "新增設備",
  editEquipment: "編輯設備", manageCustomers: "客戶", manageCatalog: "常用品項", viewAudit: "操作紀錄"
};

function normalizedUserPermissions(user) {
  return { ...defaultPermissionsForRole(user.role || "viewer"), ...(user.permissions || {}) };
}

function renderPermissions() {
  const section = $("#userPermissionSection");
  const isAdmin = state.access?.role === "admin";
  section?.classList.toggle("hidden", !isAdmin);
  if (!isAdmin || !$("#userPermissionBody")) return;
  $("#userPermissionBody").innerHTML = state.users.map(user => {
    const role = user.role || "viewer";
    const approved = user.approved === true || (!("approved" in user) && ["admin", "editor"].includes(role));
    const permissions = normalizedUserPermissions(user);
    const self = user.id === state.user?.uid;
    return `<tr data-user-row="${esc(user.id)}">
      <td><b>${esc(user.displayName || "未填姓名")}</b><div class="table-sub">${esc(user.email || user.id)}</div>${self ? `<span class="detail-latest-tag">目前帳號</span>` : ""}</td>
      <td><label class="approval-toggle"><input class="user-approved" type="checkbox" ${approved ? "checked" : ""} ${self ? "disabled" : ""} /><span class="badge ${approved ? "green" : "orange"}">${approved ? "已核准" : "待核准"}</span></label></td>
      <td><select class="select compact-select user-role" ${self ? "disabled" : ""}><option value="viewer" ${role === "viewer" ? "selected" : ""}>viewer</option><option value="editor" ${role === "editor" ? "selected" : ""}>editor</option><option value="admin" ${role === "admin" ? "selected" : ""}>admin</option></select></td>
      ${PERMISSION_KEYS.map(key => `<td class="permission-cell"><input type="checkbox" data-permission="${esc(key)}" ${permissions[key] ? "checked" : ""} ${(role === "admin" || self) ? "disabled" : ""} aria-label="${esc(permissionLabels[key] || key)}" /></td>`).join("")}
      <td><button class="btn ghost small" type="button" data-save-user="${esc(user.id)}" ${self ? "disabled" : ""}>儲存</button></td>
    </tr>`;
  }).join("");
}

function moduleLabel(module) {
  return ({ projects: "專案", quotations: "報價", payments: "請款／收款", expenses: "專案外部支出", companyExpenses: "公司支出", customers: "客戶", catalog: "常用品項", equipment: "設備", permissions: "權限" })[module] || module || "系統";
}

function actionLabel(action) {
  return ({ create: "新增", update: "修改", delete: "刪除", void: "作廢", sync: "同步", receive: "收款", permission: "權限變更" })[action] || action || "修改";
}

function renderAudit() {
  const allowed = state.access?.role === "admin" || hasPermission(state.access, "viewAudit");
  $("#auditLogSection")?.classList.toggle("hidden", !allowed);
  $("#systemNoAccess")?.classList.toggle("hidden", allowed || state.access?.role === "admin");
  if (!allowed || !$("#auditLogBody")) return;
  const keyword = $("#auditSearch")?.value.trim().toLocaleLowerCase("zh-Hant") || "";
  const module = $("#auditModuleFilter")?.value || "all";
  const list = state.auditLogs.filter(log => module === "all" || log.module === module)
    .filter(log => !keyword || [log.actorName, log.actorEmail, log.targetName, log.summary, log.module, log.action].join(" ").toLocaleLowerCase("zh-Hant").includes(keyword));
  $("#auditLogBody").innerHTML = list.length ? list.map(log => `<tr>
    <td>${esc(timestampText(log.createdAt))}</td><td><b>${esc(log.actorName || "—")}</b><div class="table-sub">${esc(log.actorEmail || "")}</div></td>
    <td>${esc(moduleLabel(log.module))}</td><td><span class="badge neutral">${esc(actionLabel(log.action))}</span></td>
    <td>${esc(log.targetName || log.targetId || "—")}</td><td>${esc(log.summary || "—")}</td>
  </tr>`).join("") : `<tr><td colspan="6"><div class="empty-state">第三階段上線後的操作才會開始出現在這裡。</div></td></tr>`;
}

function renderSystemAccess() {
  const allowed = state.access?.role === "admin" || hasPermission(state.access, "viewAudit");
  $$(".system-tab-button").forEach(button => button.classList.toggle("hidden", !allowed));
  renderPermissions();
  renderAudit();
}

async function saveUserPermissions(userId) {
  if (state.access?.role !== "admin" || userId === state.user?.uid) return;
  const row = $(`[data-user-row="${CSS.escape(userId)}"]`);
  const user = state.users.find(item => item.id === userId);
  if (!row || !user) return;
  const role = $(".user-role", row).value;
  const approved = $(".user-approved", row)?.checked === true;
  const permissions = {};
  PERMISSION_KEYS.forEach(key => { permissions[key] = $(`[data-permission="${CSS.escape(key)}"]`, row)?.checked === true; });
  try {
    await updateDoc(doc(db, "users", userId), { role, approved, permissions, updatedAt: serverTimestamp(), updatedBy: state.user.uid });
    await logAction({ action: "permission", module: "permissions", targetType: "user", targetId: userId, targetName: user.displayName || user.email || userId, summary: `${approved ? "已核准" : "已停用"}｜角色：${role}｜已開放 ${Object.values(permissions).filter(Boolean).length} 項操作權限` });
    alert("權限已儲存；對方重新整理網站後會套用新權限。");
  } catch (error) {
    console.error(error);
    alert("權限儲存失敗：請確認第三階段 Firestore Rules 已發布");
  }
}

function exportReceivables() {
  const context = filterContext();
  const rows = activePaymentRows(context);
  const csv = [
    ["客戶", "專案", "款項", "請款日", "發票號碼", "預計收款日", "應收", "已收", "未收", "帳齡"],
    ...rows.map(row => [row.customerName, row.projectName, row.label || "", row.requestDate || "", row.invoiceNumber || "", row.expectedPaymentDate || "", row.amount, row.received, row.remaining, agingLabel(row, context.asOf)])
  ].map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = `應收帳款_${context.asOf}.csv`;
  document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}

function exportCompanyExpenses() {
  const context = filterContext();
  const rows = filteredCompanyExpenses(context);
  const csv = [
    ["成本日期", "性質", "類別", "支出項目", "廠商／收款方", "支出金額", "稅別", "未稅金額", "廠商請款日", "預計付款日", "實際付款日", "付款方式", "付款狀態", "發票／憑證", "連結設備", "備註"],
    ...rows.map(expense => [expense.expenseDate || "", isCapitalExpense(expense) ? "資本支出" : "營運支出", companyExpenseCategoryLabel(expense.category), expense.name || "", expense.vendor || "", expense.amount || 0, expense.taxMode === "untaxed" ? "未稅" : "含稅", companyExpenseUntaxed(expense), expense.vendorBillDate || "", expense.expectedPaymentDate || "", expense.paidDate || "", expense.paymentMethod || "", payableStatus(expense, context.asOf).label, expense.receiptNumber || "", expense.equipmentName || "", expense.note || ""])
  ].map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = `公司支出_${context.month}.csv`;
  document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}

const scheduleFinanceRender = createRenderScheduler(() => {
  refreshExpenseProjects();
  refreshCompanyExpenseEquipment();
  renderFinance();
  renderSystemAccess();
});

function listen(name, target, options = {}) {
  const unsubscribe = subscribeCollection(name, rows => {
    state[target] = rows;
    scheduleFinanceRender();
  }, { ...options, onError: error => console.error(`讀取 ${target} 失敗`, error) });
  state.unsubs.push(unsubscribe);
}

function detach() {
  state.unsubs.forEach(unsubscribe => unsubscribe());
  state.unsubs = [];
  state.projects = []; state.payments = []; state.receipts = []; state.expenses = []; state.companyExpenses = []; state.equipment = []; state.users = []; state.auditLogs = [];
  resetFinancePages();
  renderFinance(); renderSystemAccess();
}

function attach() {
  listen("projects", "projects");
  listen("payments", "payments");
  listen("receipts", "receipts");
  listen("expenses", "expenses");
  listen("companyExpenses", "companyExpenses");
  listen("equipment", "equipment");
  if (state.access?.role === "admin") listen("users", "users");
  if (state.access?.role === "admin" || hasPermission(state.access, "viewAudit")) listen("auditLogs", "auditLogs", { orderBy: "createdAt", limit: 500 });
}

function bindEvents() {
  const resetAllFinancePagesAndRender = () => { resetFinancePages(); renderFinance(); };
  $("#financeSearch")?.addEventListener("input", resetAllFinancePagesAndRender);
  ["#financeCustomerFilter", "#financeMonth", "#financeAsOfDate"].forEach(selector => $(selector)?.addEventListener("change", resetAllFinancePagesAndRender));
  $("#financeClearFilters")?.addEventListener("click", () => {
    if ($("#financeSearch")) $("#financeSearch").value = "";
    if ($("#financeCustomerFilter")) $("#financeCustomerFilter").value = "all";
    if ($("#financeMonth")) $("#financeMonth").value = monthValue();
    if ($("#financeAsOfDate")) $("#financeAsOfDate").value = isoDate();
    resetAllFinancePagesAndRender();
  });
  const financeSortKeys = {
    "#financePayableSort": "payables",
    "#expenseSort": "expenses",
    "#financeNext30Sort": "next30",
    "#financeReceivableSort": "receivables"
  };
  Object.entries(financeSortKeys).forEach(([selector, key]) => $(selector)?.addEventListener("change", () => {
    resetFinancePages([key]);
    renderFinance();
  }));
  Object.entries(financePaginationConfig).forEach(([key, config]) => {
    const host = $(config.host);
    host?.addEventListener("click", event => {
      const button = event.target.closest("button[data-page]");
      if (!button || button.disabled) return;
      financePages[key] = Number(button.dataset.page) || 1;
      renderFinance();
      host.closest(".finance-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    host?.addEventListener("change", event => {
      const select = event.target.closest("select[data-page-select]");
      if (!select) return;
      financePages[key] = Number(select.value) || 1;
      renderFinance();
      host.closest(".finance-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  $("#reportMonth")?.addEventListener("change", renderFinance);
  $("#financeExportCsv")?.addEventListener("click", exportReceivables);
  $("#companyExpenseExportCsv")?.addEventListener("click", exportCompanyExpenses);
  $("#expenseOpenCreate")?.addEventListener("click", () => openExpense());
  $("#expenseForm")?.addEventListener("submit", event => { event.preventDefault(); saveExpense(); });
  $$('[data-expense-close],#expenseDrawerClose').forEach(button => button.addEventListener("click", closeExpense));
  ["#expenseAmount", "#expenseTaxMode"].forEach(selector => $(selector)?.addEventListener("input", updateExpenseHint));
  $("#expenseAmount")?.addEventListener("blur", event => { event.target.value = event.target.value ? money(event.target.value) : ""; updateExpenseHint(); });
  $("#companyExpenseOpenCreate")?.addEventListener("click", () => openCompanyExpense());
  $("#companyExpenseForm")?.addEventListener("submit", event => { event.preventDefault(); saveCompanyExpense(); });
  $$('[data-company-expense-close],#companyExpenseDrawerClose').forEach(button => button.addEventListener("click", closeCompanyExpense));
  $("#companyExpenseCategory")?.addEventListener("change", updateCompanyExpenseCategoryUI);
  ["#companyExpenseAmount", "#companyExpenseTaxMode"].forEach(selector => $(selector)?.addEventListener("input", updateCompanyExpenseHint));
  $("#companyExpenseAmount")?.addEventListener("blur", event => { event.target.value = event.target.value ? money(event.target.value) : ""; updateCompanyExpenseHint(); });
  $("#companyExpenseEquipmentId")?.addEventListener("change", event => {
    const equipment = state.equipment.find(item => item.id === event.target.value);
    if (equipment && !$("#companyExpenseName")?.value.trim()) $("#companyExpenseName").value = equipment.name || "";
  });
  const resetCompanyExpensePageAndRender = () => { resetFinancePages(["companyExpenses"]); renderFinance(); };
  $("#companyExpenseSearch")?.addEventListener("input", resetCompanyExpensePageAndRender);
  $("#companyExpenseCategoryFilter")?.addEventListener("change", resetCompanyExpensePageAndRender);
  $("#companyExpenseSort")?.addEventListener("change", resetCompanyExpensePageAndRender);
  $("#companyExpenseClearFilters")?.addEventListener("click", () => {
    if ($("#companyExpenseSearch")) $("#companyExpenseSearch").value = "";
    if ($("#companyExpenseCategoryFilter")) $("#companyExpenseCategoryFilter").value = "all";
    resetCompanyExpensePageAndRender();
  });
  $("#expenseTableBody")?.addEventListener("click", async event => {
    const edit = event.target.closest("[data-expense-edit]");
    const voidButton = event.target.closest("[data-expense-void]");
    const id = edit?.dataset.expenseEdit || voidButton?.dataset.expenseVoid;
    const expense = state.expenses.find(item => item.id === id);
    if (edit && expense) return openExpense(expense);
    if (voidButton && expense && canManageExpenses() && confirm("確定作廢這筆外部支出？紀錄會保留供查核，但不再計入成本與應付。")) {
      await updateDoc(doc(db, "expenses", expense.id), { voided: true, voidedAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: state.user.uid });
      await logAction({ action: "void", module: "expenses", targetType: "expense", targetId: expense.id, targetName: expense.projectName || "", summary: `${expenseCategoryLabel(expense.category)}｜${money(expense.amount)} 元` });
    }
  });
  $("#companyExpenseTableBody")?.addEventListener("click", async event => {
    const edit = event.target.closest("[data-company-expense-edit]");
    const voidButton = event.target.closest("[data-company-expense-void]");
    const id = edit?.dataset.companyExpenseEdit || voidButton?.dataset.companyExpenseVoid;
    const expense = state.companyExpenses.find(item => item.id === id);
    if (edit && expense) return openCompanyExpense(expense);
    if (voidButton && expense && canManageCompanyExpenses() && confirm("確定作廢這筆公司支出？紀錄會保留供查核，但不再計入支出與應付。")) {
      await updateDoc(doc(db, "companyExpenses", expense.id), { voided: true, voidedAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: state.user.uid });
      await logAction({ action: "void", module: "companyExpenses", targetType: "companyExpense", targetId: expense.id, targetName: expense.name || "", summary: `${companyExpenseCategoryLabel(expense.category)}｜${money(expense.amount)} 元` });
    }
  });
  document.addEventListener("click", event => {
    const button = event.target.closest("[data-finance-project]");
    if (!button) return;
    const project = projectFor(button.dataset.financeProject);
    if (!project) return;
    document.querySelector('.tab-button[data-tab="finance"]')?.click();
    if ($("#financeSearch")) $("#financeSearch").value = project.name || project.client || "";
    resetFinancePages();
    renderFinance();
  });
  $("#userPermissionBody")?.addEventListener("change", event => {
    const role = event.target.closest(".user-role");
    if (!role) return;
    const row = role.closest("[data-user-row]");
    const defaults = defaultPermissionsForRole(role.value);
    PERMISSION_KEYS.forEach(key => {
      const input = $(`[data-permission="${CSS.escape(key)}"]`, row);
      if (input) { input.checked = defaults[key]; input.disabled = role.value === "admin"; }
    });
  });
  $("#userPermissionBody")?.addEventListener("click", event => {
    const button = event.target.closest("[data-save-user]");
    if (button) saveUserPermissions(button.dataset.saveUser);
  });
  $("#auditSearch")?.addEventListener("input", renderAudit);
  $("#auditModuleFilter")?.addEventListener("change", renderAudit);
}

function init() {
  const now = new Date();
  if ($("#financeMonth")) $("#financeMonth").value = monthValue(now);
  if ($("#financeAsOfDate")) $("#financeAsOfDate").value = isoDate(now);
  bindEvents();
  renderFinance();
  renderSystemAccess();
  watchAuth(async user => {
    detach();
    state.user = user;
    state.access = null;
    if (!user) return;
    try {
      await ensureUserDoc(user);
      state.access = await getUserAccess(user);
    } catch (error) {
      console.error(error);
      state.access = { role: "viewer", approved: false, permissions: defaultPermissionsForRole("viewer") };
    }
    renderSystemAccess();
    if (state.access.approved) attach();
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
