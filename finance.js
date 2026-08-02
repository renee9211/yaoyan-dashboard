// Phase 3: receivables, aging, external expenses, audit trail and granular permissions.
import {
  db, watchAuth, ensureUserDoc, getUserAccess, hasPermission,
  defaultPermissionsForRole, PERMISSION_KEYS
} from "./firebase.js";
import { logAction } from "./audit.js";
import {
  collection, doc, setDoc, updateDoc, deleteDoc, onSnapshot,
  query, orderBy, serverTimestamp, limit
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const TAX_RATE = 0.05;

const collections = {
  projects: collection(db, "projects"),
  payments: collection(db, "payments"),
  expenses: collection(db, "expenses"),
  users: collection(db, "users"),
  auditLogs: collection(db, "auditLogs")
};

const state = {
  user: null,
  access: null,
  projects: [],
  payments: [],
  expenses: [],
  users: [],
  auditLogs: [],
  unsubs: []
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

function projectTotalTaxed(project) {
  const quote = integerValue(project?.quote);
  if (!quote) return 0;
  return project?.quoteTaxMode === "untaxed" ? Math.round(quote * (1 + TAX_RATE)) : quote;
}

function projectRevenueUntaxed(project) {
  const quote = integerValue(project?.quote);
  if (quote) return project?.quoteTaxMode === "untaxed" ? quote : Math.round(quote / (1 + TAX_RATE));
  return integerValue(project?.revenue);
}

function expenseUntaxed(expense) {
  if (integerValue(expense?.costUntaxed)) return integerValue(expense.costUntaxed);
  const amount = integerValue(expense?.amount);
  return expense?.taxMode === "untaxed" ? amount : Math.round(amount / (1 + TAX_RATE));
}

function projectExpenses(projectId) {
  return state.expenses.filter(expense => expense.projectId === projectId && !expense.voided);
}

function projectExternalCost(project) {
  const rows = projectExpenses(project.id);
  return rows.length ? rows.reduce((sum, expense) => sum + expenseUntaxed(expense), 0) : integerValue(project.cost);
}

function projectFor(id) { return state.projects.find(project => project.id === id); }

function paymentRow(payment) {
  const project = projectFor(payment.projectId);
  const amount = integerValue(payment.amount);
  const received = integerValue(payment.receivedAmount);
  return {
    ...payment,
    project,
    projectName: payment.projectName || project?.name || "未命名專案",
    customerName: payment.customerName || project?.client || "未填客戶",
    amount,
    received,
    remaining: Math.max(0, amount - received)
  };
}

function filterContext() {
  return {
    keyword: $("#financeSearch")?.value.trim().toLocaleLowerCase("zh-Hant") || "",
    customer: $("#financeCustomerFilter")?.value || "all",
    month: $("#financeMonth")?.value || monthValue(),
    asOf: $("#financeAsOfDate")?.value || isoDate()
  };
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
  const list = rows.filter(row => row.expectedPaymentDate && row.expectedPaymentDate >= context.asOf && row.expectedPaymentDate <= end)
    .sort((a, b) => a.expectedPaymentDate.localeCompare(b.expectedPaymentDate));
  $("#financeNext30Total").textContent = money(list.reduce((sum, row) => sum + row.remaining, 0));
  $("#financeNext30Count").textContent = `${list.length} 筆即將到期`;
  $("#financeNext30Body").innerHTML = list.length ? list.map(row => `<tr>
    <td><b>${esc(row.expectedPaymentDate)}</b></td>
    <td><b>${esc(row.customerName)}</b><div class="table-sub">${esc(row.projectName)}</div></td>
    <td>${esc(row.label || "款項")}<div class="table-sub">發票：${esc(row.invoiceNumber || "—")}</div></td>
    <td class="num">${money(row.amount)}</td><td class="num">${money(row.received)}</td><td class="num"><b>${money(row.remaining)}</b></td>
  </tr>`).join("") : `<tr><td colspan="6"><div class="empty-state">未來 30 天沒有符合條件的預計收款。</div></td></tr>`;
}

function renderReceivables(rows, context) {
  const sorted = [...rows].sort((a, b) => String(a.expectedPaymentDate || "9999").localeCompare(String(b.expectedPaymentDate || "9999")));
  $("#financeReceivableTotal").textContent = money(sorted.reduce((sum, row) => sum + row.remaining, 0));
  $("#financeReceivableCount").textContent = `共 ${sorted.length} 筆`;
  const overdue = sorted.filter(row => (daysPastDue(row.expectedPaymentDate, context.asOf) || 0) > 0);
  $("#financeOverdueTotal").textContent = money(overdue.reduce((sum, row) => sum + row.remaining, 0));
  $("#financeOverdueCount").textContent = `${overdue.length} 筆逾期`;
  $("#financeReceivableBody").innerHTML = sorted.length ? sorted.map(row => `<tr>
    <td><b>${esc(row.customerName)}</b><div class="table-sub">${esc(row.projectName)}</div></td>
    <td>${esc(row.label || "款項")}</td>
    <td>${esc(row.requestDate || "—")}<div class="table-sub">發票：${esc(row.invoiceNumber || "—")} ${row.invoiceDate ? `｜${esc(row.invoiceDate)}` : ""}</div></td>
    <td>${esc(row.expectedPaymentDate || "—")}</td>
    <td class="num">${money(row.amount)}</td><td class="num">${money(row.received)}</td><td class="num"><b>${money(row.remaining)}</b></td>
    <td><span class="badge ${agingBadge(row, context.asOf)}">${esc(agingLabel(row, context.asOf))}</span></td>
  </tr>`).join("") : `<tr><td colspan="8"><div class="empty-state">目前沒有符合條件的已請款未收款項。</div></td></tr>`;
}

function projectInMonth(project, month) {
  const start = `${month}-01`;
  const [year, value] = month.split("-").map(Number);
  const end = isoDate(new Date(year, value, 0));
  return project.startDate <= end && project.endDate >= start;
}

function contextProjects(context) {
  return state.projects.filter(project => project.status !== "lost" && projectInMonth(project, context.month))
    .filter(project => context.customer === "all" || project.client === context.customer)
    .filter(project => !context.keyword || [project.name, project.client, project.location].join(" ").toLocaleLowerCase("zh-Hant").includes(context.keyword));
}

function renderProfitability(context) {
  const projects = contextProjects(context);
  const revenue = projects.reduce((sum, project) => sum + projectRevenueUntaxed(project), 0);
  const expenses = projects.reduce((sum, project) => sum + projectExternalCost(project), 0);
  $("#financeMonthRevenue").textContent = money(revenue);
  $("#financeMonthExpenses").textContent = money(expenses);
  $("#financeMonthContribution").textContent = (revenue - expenses).toLocaleString("zh-TW");
}

function expenseCategoryLabel(value) {
  return ({ outsourcing_equipment: "外包設備", temporary_staff: "臨時人力", transport: "運輸", consumables: "耗材", venue: "場租／其他場地費", other: "其他" })[value] || "其他";
}

function canManageExpenses() { return hasPermission(state.access, "manageExpenses"); }
function canDelete() { return state.access?.role === "admin"; }

function filteredExpenses(context) {
  return state.expenses.filter(expense => !expense.voided)
    .map(expense => {
      const project = projectFor(expense.projectId);
      return { ...expense, projectName: expense.projectName || project?.name || "未命名專案", customerName: expense.customerName || project?.client || "未填客戶" };
    })
    .filter(expense => !context.month || String(expense.expenseDate || "").startsWith(context.month))
    .filter(expense => matchesContext(expense, context))
    .sort((a, b) => String(b.expenseDate || "").localeCompare(String(a.expenseDate || "")));
}

function renderExpenses(context) {
  const list = filteredExpenses(context);
  $("#expenseResultCount").textContent = `共 ${list.length} 筆`;
  $("#expenseOpenCreate").disabled = !canManageExpenses();
  $("#expenseTableBody").innerHTML = list.length ? list.map(expense => `<tr>
    <td>${esc(expense.expenseDate || "—")}</td>
    <td><b>${esc(expense.projectName)}</b><div class="table-sub">${esc(expense.customerName)}</div></td>
    <td>${esc(expenseCategoryLabel(expense.category))}<div class="table-sub">${esc(expense.vendor || "—")}</div></td>
    <td class="num">${money(expense.amount)}</td><td>${expense.taxMode === "untaxed" ? "未稅" : "含稅"}</td><td class="num"><b>${money(expenseUntaxed(expense))}</b></td>
    <td>${esc(expense.note || "—")}</td>
    <td><div class="row-actions"><button class="btn ghost small" type="button" data-expense-edit="${esc(expense.id)}" ${canManageExpenses() ? "" : "disabled"}>編輯</button><button class="btn ghost small" type="button" data-expense-delete="${esc(expense.id)}" ${canDelete() ? "" : "disabled"}>刪除</button></div></td>
  </tr>`).join("") : `<tr><td colspan="8"><div class="empty-state">選定月份尚無逐筆外部支出；舊專案手動成本仍會保留在案件毛利計算。</div></td></tr>`;
}

function renderMonthReceived(context) {
  const rows = state.payments.filter(payment => !payment.voided && payment.receivedDate?.startsWith(context.month) && integerValue(payment.receivedAmount) > 0)
    .map(paymentRow).filter(row => matchesContext(row, context));
  $("#financeMonthReceived").textContent = money(rows.reduce((sum, row) => sum + row.received, 0));
  $("#financeMonthReceivedCount").textContent = `${rows.length} 筆入帳`;
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
  all.forEach(row => { if (row.requestDate) months.add(row.requestDate.slice(0, 7)); if (row.receivedDate) months.add(row.receivedDate.slice(0, 7)); });
  const monthRows = [...months].sort((a, b) => b.localeCompare(a)).slice(0, 12).map(month => {
    const invoiced = all.filter(row => row.requestDate?.startsWith(month)).reduce((sum, row) => sum + row.amount, 0);
    const received = all.filter(row => row.receivedDate?.startsWith(month)).reduce((sum, row) => sum + row.received, 0);
    const end = `${month}-31`;
    const outstanding = all.filter(row => row.requestDate <= end && (!row.receivedDate || row.receivedDate > end)).reduce((sum, row) => sum + row.remaining, 0);
    return { month, invoiced, received, outstanding };
  });
  $("#financeMonthStatsBody").innerHTML = monthRows.map(item => `<tr><td>${esc(item.month)}</td><td class="num">${money(item.invoiced)}</td><td class="num">${money(item.received)}</td><td class="num">${money(item.outstanding)}</td></tr>`).join("");
}

function renderFinance() {
  if (!$("#tab-finance")) return;
  refreshCustomerOptions();
  const context = filterContext();
  const receivables = activePaymentRows(context);
  renderReceivables(receivables, context);
  renderAging(receivables, context.asOf);
  renderNext30(receivables, context);
  renderMonthReceived(context);
  renderProfitability(context);
  renderExpenses(context);
  renderAnalysis(context);
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
  const untaxed = $("#expenseTaxMode")?.value === "untaxed" ? amount : Math.round(amount / (1 + TAX_RATE));
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
    costUntaxed: taxMode === "untaxed" ? amount : Math.round(amount / (1 + TAX_RATE)),
    note: $("#expenseNote").value.trim(), voided: false,
    updatedAt: serverTimestamp(), updatedBy: state.user.uid
  };
  try {
    let targetId = id;
    if (id) await updateDoc(doc(db, "expenses", id), payload);
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

const permissionLabels = {
  createProjects: "新增專案", editProjects: "編輯專案", manageQuotations: "報價",
  managePayments: "請款收款", manageExpenses: "外部支出", createEquipment: "新增設備",
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
    const permissions = normalizedUserPermissions(user);
    const self = user.id === state.user?.uid;
    return `<tr data-user-row="${esc(user.id)}">
      <td><b>${esc(user.displayName || "未填姓名")}</b><div class="table-sub">${esc(user.email || user.id)}</div>${self ? `<span class="detail-latest-tag">目前帳號</span>` : ""}</td>
      <td><select class="select compact-select user-role" ${self ? "disabled" : ""}><option value="viewer" ${role === "viewer" ? "selected" : ""}>viewer</option><option value="editor" ${role === "editor" ? "selected" : ""}>editor</option><option value="admin" ${role === "admin" ? "selected" : ""}>admin</option></select></td>
      ${PERMISSION_KEYS.map(key => `<td class="permission-cell"><input type="checkbox" data-permission="${esc(key)}" ${permissions[key] ? "checked" : ""} ${(role === "admin" || self) ? "disabled" : ""} aria-label="${esc(permissionLabels[key] || key)}" /></td>`).join("")}
      <td><button class="btn ghost small" type="button" data-save-user="${esc(user.id)}" ${self ? "disabled" : ""}>儲存</button></td>
    </tr>`;
  }).join("");
}

function moduleLabel(module) {
  return ({ projects: "專案", quotations: "報價", payments: "請款／收款", expenses: "外部支出", customers: "客戶", catalog: "常用品項", equipment: "設備", permissions: "權限" })[module] || module || "系統";
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
  const permissions = {};
  PERMISSION_KEYS.forEach(key => { permissions[key] = $(`[data-permission="${CSS.escape(key)}"]`, row)?.checked === true; });
  try {
    await updateDoc(doc(db, "users", userId), { role, permissions, updatedAt: serverTimestamp(), updatedBy: state.user.uid });
    await logAction({ action: "permission", module: "permissions", targetType: "user", targetId: userId, targetName: user.displayName || user.email || userId, summary: `角色：${role}｜已開放 ${Object.values(permissions).filter(Boolean).length} 項操作權限` });
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

function listen(collectionRef, target, options = {}) {
  const ref = options.limit ? query(collectionRef, orderBy(options.orderBy || "updatedAt", "desc"), limit(options.limit)) : query(collectionRef, orderBy(options.orderBy || "updatedAt", "desc"));
  const unsubscribe = onSnapshot(ref, snapshot => {
    state[target] = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    refreshExpenseProjects();
    renderFinance();
    renderSystemAccess();
  }, error => {
    console.error(`讀取 ${target} 失敗`, error);
    state[target] = [];
    renderFinance();
    renderSystemAccess();
  });
  state.unsubs.push(unsubscribe);
}

function detach() {
  state.unsubs.forEach(unsubscribe => unsubscribe());
  state.unsubs = [];
  state.projects = []; state.payments = []; state.expenses = []; state.users = []; state.auditLogs = [];
  renderFinance(); renderSystemAccess();
}

function attach() {
  listen(collections.projects, "projects");
  listen(collections.payments, "payments");
  listen(collections.expenses, "expenses");
  if (state.access?.role === "admin") listen(collections.users, "users");
  if (state.access?.role === "admin" || hasPermission(state.access, "viewAudit")) listen(collections.auditLogs, "auditLogs", { orderBy: "createdAt", limit: 500 });
}

function bindEvents() {
  ["#financeSearch"].forEach(selector => $(selector)?.addEventListener("input", renderFinance));
  ["#financeCustomerFilter", "#financeMonth", "#financeAsOfDate"].forEach(selector => $(selector)?.addEventListener("change", renderFinance));
  $("#financeExportCsv")?.addEventListener("click", exportReceivables);
  $("#expenseOpenCreate")?.addEventListener("click", () => openExpense());
  $("#expenseForm")?.addEventListener("submit", event => { event.preventDefault(); saveExpense(); });
  $$('[data-expense-close],#expenseDrawerClose').forEach(button => button.addEventListener("click", closeExpense));
  ["#expenseAmount", "#expenseTaxMode"].forEach(selector => $(selector)?.addEventListener("input", updateExpenseHint));
  $("#expenseAmount")?.addEventListener("blur", event => { event.target.value = event.target.value ? money(event.target.value) : ""; updateExpenseHint(); });
  $("#expenseTableBody")?.addEventListener("click", async event => {
    const edit = event.target.closest("[data-expense-edit]");
    const del = event.target.closest("[data-expense-delete]");
    const id = edit?.dataset.expenseEdit || del?.dataset.expenseDelete;
    const expense = state.expenses.find(item => item.id === id);
    if (edit && expense) return openExpense(expense);
    if (del && expense && canDelete() && confirm("確定永久刪除這筆外部支出？")) {
      await deleteDoc(doc(db, "expenses", expense.id));
      await logAction({ action: "delete", module: "expenses", targetType: "expense", targetId: expense.id, targetName: expense.projectName || "", summary: `${expenseCategoryLabel(expense.category)}｜${money(expense.amount)} 元` });
    }
  });
  document.addEventListener("click", event => {
    const button = event.target.closest("[data-finance-project]");
    if (!button) return;
    const project = projectFor(button.dataset.financeProject);
    if (!project) return;
    document.querySelector('.tab-button[data-tab="finance"]')?.click();
    if ($("#financeSearch")) $("#financeSearch").value = project.name || project.client || "";
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
      state.access = { role: "viewer", permissions: defaultPermissionsForRole("viewer") };
    }
    renderSystemAccess();
    attach();
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
