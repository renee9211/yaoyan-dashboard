// Phase 2 payment module: project-linked billing, invoices and collections.
import { db, watchAuth, getUserRole, ensureUserDoc } from "./firebase.js";
import {
  collection, doc, setDoc, updateDoc, deleteDoc, onSnapshot,
  query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const TAX_RATE = 0.05;
const PAYMENTS_PER_PAGE = 20;
const TODAY = () => {
  const now = new Date();
  const pad = value => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

const collections = {
  projects: collection(db, "projects"),
  customers: collection(db, "customers"),
  payments: collection(db, "payments")
};

const state = {
  user: null,
  role: null,
  projects: [],
  customers: [],
  payments: [],
  unsubs: [],
  currentPage: 1
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

function money(value) {
  return integerValue(value).toLocaleString("zh-TW");
}

function formatMoneyInput(input) {
  if (!input) return;
  const value = integerValue(input.value);
  input.value = value ? money(value) : "";
}

function canEdit() {
  return state.role === "admin" || state.role === "editor";
}

function canDelete() {
  return state.role === "admin";
}

function projectStatusLabel(status) {
  return ({
    planning: "規劃中",
    confirmed: "已成案",
    executing: "執行中",
    closed: "已結案",
    lost: "流標／未成案"
  })[status] || status || "—";
}

function paymentTypeLabel(type) {
  return ({ deposit: "訂金", balance: "尾款", full: "全額款", other: "其他" })[type] || "其他";
}

function projectTotalTaxed(project) {
  const quote = integerValue(project?.quote);
  if (!quote) return 0;
  return project?.quoteTaxMode === "untaxed" ? Math.round(quote * (1 + TAX_RATE)) : quote;
}

function activePayments(projectId) {
  return state.payments.filter(payment => payment.projectId === projectId && !payment.voided);
}

function paymentStatus(payment) {
  if (payment.voided) return "void";
  const amount = integerValue(payment.amount);
  const received = integerValue(payment.receivedAmount);
  if (amount > 0 && received >= amount) return "paid";
  if (payment.requestDate && payment.expectedPaymentDate && payment.expectedPaymentDate < TODAY()) return "overdue";
  if (received > 0) return "partial";
  if (payment.requestDate) return "requested";
  return "pending";
}

function paymentStatusLabel(status) {
  return ({
    pending: "待請款",
    requested: "已請款待收",
    partial: "部分收款",
    paid: "已收款",
    overdue: "逾期未收",
    pricePending: "總價待確認",
    void: "已作廢"
  })[status] || status;
}

function paymentStatusBadge(status) {
  return ({
    pending: "neutral",
    requested: "orange",
    partial: "blue",
    paid: "green",
    overdue: "red",
    pricePending: "orange",
    void: "red"
  })[status] || "neutral";
}

function projectPaymentSummary(project) {
  const rows = activePayments(project.id);
  const total = projectTotalTaxed(project);
  const scheduled = rows.reduce((sum, payment) => sum + integerValue(payment.amount), 0);
  const invoiced = rows.filter(payment => payment.requestDate).reduce((sum, payment) => sum + integerValue(payment.amount), 0);
  const received = rows.reduce((sum, payment) => sum + integerValue(payment.receivedAmount), 0);
  const hasOverdue = rows.some(payment => paymentStatus(payment) === "overdue");
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
    // 總價未定時，至少仍要計入「已請款但尚未收到」的已知款項，
    // 否則活動前先開出的訂金會從未收款統計中消失。
    outstanding: total ? Math.max(0, total - received) : Math.max(0, invoiced - received),
    unscheduled: total ? Math.max(0, total - scheduled) : 0,
    status,
    isTracked: rows.length > 0
  };
}

function dateText(value) {
  return value || "—";
}

function timestampValue(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function switchTab(tab) {
  document.querySelector(`.tab-button[data-tab="${tab}"]`)?.click();
}

function openDrawer() {
  $("#paymentDrawer")?.classList.remove("hidden");
  $("#paymentDrawer")?.setAttribute("aria-hidden", "false");
  document.body.classList.add("drawer-open");
}

function closeDrawer() {
  $("#paymentDrawer")?.classList.add("hidden");
  $("#paymentDrawer")?.setAttribute("aria-hidden", "true");
  if (!$(".drawer:not(.hidden)")) document.body.classList.remove("drawer-open");
}

function customerForProject(project) {
  const client = String(project?.client || "").trim().toLocaleLowerCase("zh-Hant");
  if (!client) return null;
  return state.customers.find(customer => String(customer.name || "").trim().toLocaleLowerCase("zh-Hant") === client) || null;
}

function refreshProjectOptions(selectedId = "") {
  const select = $("#paymentProjectId");
  if (!select) return;
  const current = selectedId || select.value;
  const options = state.projects
    .filter(project => project.status !== "lost")
    .sort((a, b) => String(b.endDate || "").localeCompare(String(a.endDate || "")))
    .map(project => {
      const total = projectTotalTaxed(project);
      const suffix = total ? `｜含稅 ${money(total)}` : "｜總價待確認";
      return `<option value="${esc(project.id)}">${esc(project.name || "未命名專案")}｜${esc(project.client || "未填客戶")}${suffix}</option>`;
    }).join("");
  select.innerHTML = `<option value="">請選擇專案</option>${options}`;
  if (current && state.projects.some(project => project.id === current)) select.value = current;
}

function defaultLabel(type) {
  return ({ deposit: "訂金", balance: "尾款", full: "全額款", other: "其他款項" })[type] || "其他款項";
}

function updateProjectHints({ suggestAmount = false } = {}) {
  const project = state.projects.find(item => item.id === $("#paymentProjectId")?.value);
  const hint = $("#paymentProjectHint");
  const remainingHint = $("#paymentRemainingHint");
  if (!project) {
    if (hint) hint.textContent = "可選擇既有專案，包括活動前需先收訂金的案子。";
    if (remainingHint) remainingHint.textContent = "";
    return;
  }

  const editingId = $("#paymentId")?.value || "";
  const rows = activePayments(project.id).filter(payment => payment.id !== editingId);
  const total = projectTotalTaxed(project);
  const scheduled = rows.reduce((sum, payment) => sum + integerValue(payment.amount), 0);
  const remaining = total ? Math.max(0, total - scheduled) : 0;
  if (hint) hint.textContent = `${project.startDate || "日期未填"}～${project.endDate || "日期未填"}｜${projectStatusLabel(project.status)}${total ? `｜專案含稅價 ${money(total)}` : "｜總價待確認，仍可先登記訂金"}`;
  if (remainingHint) remainingHint.textContent = total ? `扣除其他已排定款項後，尚可排定 ${money(remaining)} 元。` : "專案總價尚未確認，本筆金額仍可先行登記。";

  const type = $("#paymentType")?.value;
  const amountInput = $("#paymentAmount");
  if (suggestAmount && amountInput && !integerValue(amountInput.value) && ["balance", "full"].includes(type) && remaining > 0) {
    amountInput.value = money(remaining);
  }
}

function paymentTermsBaseDate() {
  return $("#paymentInvoiceDate")?.value || $("#paymentRequestDate")?.value || "";
}

function addDays(date, days) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + days);
  const pad = value => String(value).padStart(2, "0");
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;
}

function suggestExpectedDate({ force = false } = {}) {
  const input = $("#paymentExpectedDate");
  if (!input || (input.value && !force)) return;
  const base = paymentTermsBaseDate();
  if (!base) return;
  const [year, month, day] = base.split("-").map(Number);
  if (!year || !month || !day) return;
  const terms = $("#paymentTerms")?.value || "";
  const daysMatch = terms.match(/(\d+)\s*天/);
  if (!daysMatch && !/月結|現金|即期/.test(terms)) return;
  const days = daysMatch ? Number(daysMatch[1]) : 0;
  let date = new Date(year, month - 1, day);
  if (/月結/.test(terms)) date = new Date(year, month, 0);
  input.value = addDays(date, days);
}

function applyProjectDefaults({ suggestAmount = true } = {}) {
  const project = state.projects.find(item => item.id === $("#paymentProjectId")?.value);
  if (!project) return updateProjectHints();
  const customer = customerForProject(project);
  const termsInput = $("#paymentTerms");
  if (termsInput && !termsInput.value && customer?.paymentTerms) termsInput.value = customer.paymentTerms;
  updateProjectHints({ suggestAmount });
  suggestExpectedDate();
}

function resetForm(payment = null, project = null) {
  refreshProjectOptions(payment?.projectId || project?.id || "");
  $("#paymentId").value = payment?.id || "";
  $("#paymentProjectId").value = payment?.projectId || project?.id || "";
  $("#paymentType").value = payment?.paymentType || "deposit";
  $("#paymentAmount").value = payment?.amount ? money(payment.amount) : "";
  $("#paymentLabel").value = payment?.label || defaultLabel(payment?.paymentType || "deposit");
  $("#paymentRequestDate").value = payment?.requestDate || "";
  $("#paymentInvoiceDate").value = payment?.invoiceDate || "";
  $("#paymentInvoiceNumber").value = payment?.invoiceNumber || "";
  $("#paymentExpectedDate").value = payment?.expectedPaymentDate || "";
  $("#paymentTerms").value = payment?.paymentTerms || "";
  $("#paymentReceivedAmount").value = payment?.receivedAmount ? money(payment.receivedAmount) : "";
  $("#paymentReceivedDate").value = payment?.receivedDate || "";
  $("#paymentNote").value = payment?.note || "";
  $("#paymentDrawerTitle").textContent = payment ? "編輯款項" : "新增款項";
  applyProjectDefaults({ suggestAmount: false });
}

function openPayment(payment = null, { project = null, receive = false } = {}) {
  if (!canEdit()) return alert("viewer 僅能查看請款與收款資料");
  resetForm(payment, project);
  if (receive && payment) {
    $("#paymentReceivedAmount").value = money(payment.amount);
    $("#paymentReceivedDate").value = TODAY();
  }
  openDrawer();
  setTimeout(() => $("#paymentProjectId")?.focus(), 50);
}

async function savePayment() {
  if (!canEdit() || !state.user) return alert("你目前沒有新增或編輯款項的權限");
  const id = $("#paymentId").value;
  const project = state.projects.find(item => item.id === $("#paymentProjectId").value);
  if (!project) return alert("請選擇要串接的專案");

  const amount = integerValue($("#paymentAmount").value);
  const receivedAmount = integerValue($("#paymentReceivedAmount").value);
  if (!amount) return alert("請填寫本筆應收金額");
  if (receivedAmount > amount) return alert("已收金額不能大於本筆應收金額");

  const receivedDate = $("#paymentReceivedDate").value || (receivedAmount ? TODAY() : "");
  if (!receivedAmount && receivedDate) return alert("已填寫收款日，請一併填寫已收金額");

  let requestDate = $("#paymentRequestDate").value;
  const invoiceDate = $("#paymentInvoiceDate").value;
  const invoiceNumber = $("#paymentInvoiceNumber").value.trim();
  if (!requestDate && (invoiceDate || invoiceNumber)) requestDate = invoiceDate || TODAY();

  const total = projectTotalTaxed(project);
  const otherScheduled = activePayments(project.id)
    .filter(payment => payment.id !== id)
    .reduce((sum, payment) => sum + integerValue(payment.amount), 0);
  if (total && otherScheduled + amount > total) {
    const over = otherScheduled + amount - total;
    if (!confirm(`本專案排定款項將超過專案含稅價 ${money(over)} 元。\n若為追加款或專案價尚未更新，可繼續儲存；是否繼續？`)) return;
  }

  const payload = {
    projectId: project.id,
    projectName: project.name || "",
    customerName: project.client || "",
    projectStartDate: project.startDate || "",
    projectEndDate: project.endDate || "",
    projectTotalTaxed: total,
    paymentType: $("#paymentType").value,
    label: $("#paymentLabel").value.trim() || defaultLabel($("#paymentType").value),
    amount,
    requestDate,
    invoiceDate,
    invoiceNumber,
    expectedPaymentDate: $("#paymentExpectedDate").value,
    paymentTerms: $("#paymentTerms").value.trim(),
    receivedAmount,
    receivedDate,
    note: $("#paymentNote").value.trim(),
    voided: false,
    updatedAt: serverTimestamp(),
    updatedBy: state.user.uid
  };

  try {
    if (id) {
      await updateDoc(doc(db, "payments", id), payload);
    } else {
      const ref = doc(collections.payments);
      await setDoc(ref, { ...payload, createdAt: serverTimestamp(), createdBy: state.user.uid });
    }
    closeDrawer();
  } catch (error) {
    console.error(error);
    alert("儲存款項失敗：請確認 Firestore Rules 已加入 payments 權限");
  }
}

function renderPaymentDetails(project, summary) {
  const rows = [...state.payments]
    .filter(payment => payment.projectId === project.id)
    .sort((a, b) => String(a.requestDate || a.expectedPaymentDate || "").localeCompare(String(b.requestDate || b.expectedPaymentDate || "")) || timestampValue(a.createdAt) - timestampValue(b.createdAt));
  if (!rows.length) {
    return `<div class="payment-empty-detail"><p>這個專案尚未建立款項。</p><button class="btn primary small" type="button" data-payment-add-project="${esc(project.id)}" ${canEdit() ? "" : "disabled"}>＋ 建立第一筆款項</button></div>`;
  }

  const body = rows.map(payment => {
    const status = paymentStatus(payment);
    const remaining = Math.max(0, integerValue(payment.amount) - integerValue(payment.receivedAmount));
    return `<tr class="${payment.voided ? "payment-void-row" : ""}">
      <td><b>${esc(payment.label || paymentTypeLabel(payment.paymentType))}</b><div class="table-sub">${esc(paymentTypeLabel(payment.paymentType))}</div></td>
      <td class="num">${money(payment.amount)}</td>
      <td>${dateText(payment.requestDate)}<div class="table-sub">發票：${esc(payment.invoiceNumber || "—")} ${payment.invoiceDate ? `｜${esc(payment.invoiceDate)}` : ""}</div></td>
      <td>${dateText(payment.expectedPaymentDate)}</td>
      <td class="num">${money(payment.receivedAmount)}<div class="table-sub">${dateText(payment.receivedDate)}</div></td>
      <td class="num">${money(remaining)}</td>
      <td><span class="badge ${paymentStatusBadge(status)}">${esc(paymentStatusLabel(status))}</span></td>
      <td><div class="row-actions">
        <button class="btn ghost small" type="button" data-payment-edit="${esc(payment.id)}" ${canEdit() && !payment.voided ? "" : "disabled"}>編輯</button>
        <button class="btn ghost small" type="button" data-payment-receive="${esc(payment.id)}" ${canEdit() && !payment.voided && status !== "paid" ? "" : "disabled"}>登記收款</button>
        <button class="btn ghost small" type="button" data-payment-void="${esc(payment.id)}" ${canEdit() && !payment.voided ? "" : "disabled"}>作廢</button>
        <button class="btn ghost small" type="button" data-payment-delete="${esc(payment.id)}" ${canDelete() ? "" : "disabled"}>刪除</button>
      </div></td>
    </tr>`;
  }).join("");

  return `<div class="payment-detail-head"><div><b>款項明細</b><span>已排定 ${money(summary.scheduled)}｜尚未排定 ${summary.total ? money(summary.unscheduled) : "總價待確認"}</span></div><button class="btn primary small" type="button" data-payment-add-project="${esc(project.id)}" ${canEdit() ? "" : "disabled"}>＋ 新增本專案款項</button></div>
    <div class="table-scroll"><table class="table payment-detail-table"><thead><tr><th>款項</th><th class="num">應收</th><th>請款／發票</th><th>預計收款</th><th class="num">已收</th><th class="num">未收</th><th>狀態</th><th>操作</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function filteredProjects() {
  const keyword = $("#paymentSearch")?.value.trim().toLocaleLowerCase("zh-Hant") || "";
  const statusFilter = $("#paymentStatusFilter")?.value || "all";
  const projectStatusFilter = $("#paymentProjectStatusFilter")?.value || "all";
  const statusRank = { overdue: 0, partial: 1, requested: 2, pending: 3, pricePending: 4, paid: 5 };

  return state.projects
    .filter(project => project.status !== "lost")
    .map(project => ({ project, summary: projectPaymentSummary(project) }))
    .filter(({ project, summary }) => {
      if (projectStatusFilter !== "all" && project.status !== projectStatusFilter) return false;
      if (statusFilter !== "all" && summary.status !== statusFilter) return false;
      if (!keyword) return true;
      const invoiceText = state.payments.filter(payment => payment.projectId === project.id).map(payment => payment.invoiceNumber || "").join(" ");
      return [project.name, project.client, project.location, invoiceText].join(" ").toLocaleLowerCase("zh-Hant").includes(keyword);
    })
    .sort((a, b) => (statusRank[a.summary.status] ?? 9) - (statusRank[b.summary.status] ?? 9) || String(b.project.endDate || "").localeCompare(String(a.project.endDate || "")));
}

function renderPagination(totalItems) {
  const host = $("#paymentPagination");
  if (!host) return;
  const totalPages = Math.max(1, Math.ceil(totalItems / PAYMENTS_PER_PAGE));
  state.currentPage = Math.min(Math.max(1, state.currentPage), totalPages);
  if (totalPages <= 1) return void (host.innerHTML = "");

  const visible = new Set([1, totalPages]);
  for (let page = state.currentPage - 2; page <= state.currentPage + 2; page += 1) if (page >= 1 && page <= totalPages) visible.add(page);
  const buttons = [...visible].sort((a, b) => a - b).map((page, index, pages) => {
    const gap = index && page - pages[index - 1] > 1 ? `<span class="pagination-ellipsis">…</span>` : "";
    return `${gap}<button class="page-number ${page === state.currentPage ? "active" : ""}" type="button" data-page="${page}" ${page === state.currentPage ? 'aria-current="page"' : ""}>${page}</button>`;
  }).join("");
  const options = Array.from({ length: totalPages }, (_, index) => index + 1).map(page => `<option value="${page}" ${page === state.currentPage ? "selected" : ""}>${page}</option>`).join("");
  host.innerHTML = `<button class="page-direction" type="button" data-page="${state.currentPage - 1}" ${state.currentPage === 1 ? "disabled" : ""}>上一頁</button><div class="pagination-pages">${buttons}</div><span class="pagination-summary">第 ${state.currentPage} / ${totalPages} 頁</span><label class="pagination-jump"><span>跳至</span><select data-page-select>${options}</select><span>頁</span></label><button class="page-direction" type="button" data-page="${state.currentPage + 1}" ${state.currentPage === totalPages ? "disabled" : ""}>下一頁</button>`;
}

function renderPayments() {
  const body = $("#paymentProjectTableBody");
  if (!body) return;
  const list = filteredProjects();
  const totalPages = Math.max(1, Math.ceil(list.length / PAYMENTS_PER_PAGE));
  state.currentPage = Math.min(state.currentPage, totalPages);
  const start = (state.currentPage - 1) * PAYMENTS_PER_PAGE;
  const pageList = list.slice(start, start + PAYMENTS_PER_PAGE);
  $("#paymentResultCount").textContent = `共 ${list.length} 個專案${list.length ? `（顯示 ${start + 1}–${Math.min(start + PAYMENTS_PER_PAGE, list.length)}）` : ""}`;
  renderPagination(list.length);

  body.innerHTML = pageList.length ? pageList.map(({ project, summary }) => {
    const outstandingText = summary.isTracked
      ? (summary.total
        ? money(summary.outstanding)
        : `${money(summary.outstanding)}<div class="table-sub">總價待確認</div>`)
      : "尚未登記";
    return `<tr class="payment-project-row" data-payment-toggle-project="${esc(project.id)}">
      <td><b>${esc(project.name || "未命名專案")}</b><div class="table-sub">${esc(project.client || "—")}</div></td>
      <td>${esc(project.startDate || "—")}～${esc(project.endDate || "—")}<div class="table-sub">${esc(projectStatusLabel(project.status))}</div></td>
      <td class="num">${summary.total ? money(summary.total) : '<span class="pending-value">待確認</span>'}</td>
      <td class="num">${money(summary.invoiced)}</td>
      <td class="num">${money(summary.received)}</td>
      <td class="num">${outstandingText}</td>
      <td><span class="badge ${paymentStatusBadge(summary.status)}">${esc(summary.isTracked ? paymentStatusLabel(summary.status) : "尚未建立款項")}</span></td>
      <td><div class="row-actions"><button class="btn ghost small" type="button" data-payment-add-project="${esc(project.id)}" ${canEdit() ? "" : "disabled"}>新增款項</button><button class="btn ghost small" type="button" data-payment-expand="${esc(project.id)}">查看明細</button></div></td>
    </tr><tr class="payment-project-detail" data-payment-detail-project="${esc(project.id)}" hidden><td colspan="8">${renderPaymentDetails(project, summary)}</td></tr>`;
  }).join("") : `<tr><td colspan="8"><div class="empty-state">找不到符合條件的專案</div></td></tr>`;

  const trackedProjectIds = new Set(state.payments.filter(payment => !payment.voided).map(payment => payment.projectId));
  const tracked = state.projects.filter(project => trackedProjectIds.has(project.id)).map(projectPaymentSummary);
  $("#paymentProjectTotal").textContent = money(tracked.reduce((sum, item) => sum + item.total, 0));
  $("#paymentInvoicedTotal").textContent = money(tracked.reduce((sum, item) => sum + item.invoiced, 0));
  $("#paymentReceivedTotal").textContent = money(tracked.reduce((sum, item) => sum + item.received, 0));
  $("#paymentOutstandingTotal").textContent = money(tracked.reduce((sum, item) => sum + item.outstanding, 0));
  $("#paymentOpenCreate").disabled = !canEdit();
}

function toggleProjectDetails(projectId) {
  const row = $(`[data-payment-detail-project="${CSS.escape(projectId)}"]`);
  if (!row) return;
  row.hidden = !row.hidden;
}

async function voidPayment(payment) {
  if (!canEdit() || !payment || payment.voided) return;
  if (!confirm(`確定作廢「${payment.label || paymentTypeLabel(payment.paymentType)}」？款項會保留供日後查核，但不再計入統計。`)) return;
  await updateDoc(doc(db, "payments", payment.id), { voided: true, voidedAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: state.user.uid });
}

function listen(name, collectionRef, target) {
  const unsubscribe = onSnapshot(query(collectionRef, orderBy("updatedAt", "desc")), snapshot => {
    state[target] = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    refreshProjectOptions();
    renderPayments();
  }, error => {
    console.error(`讀取 ${name} 失敗`, error);
    state[target] = [];
    renderPayments();
  });
  state.unsubs.push(unsubscribe);
}

function detach() {
  state.unsubs.forEach(unsubscribe => unsubscribe());
  state.unsubs = [];
  state.projects = [];
  state.customers = [];
  state.payments = [];
  renderPayments();
}

function attach() {
  listen("projects", collections.projects, "projects");
  listen("customers", collections.customers, "customers");
  listen("payments", collections.payments, "payments");
}

function bindEvents() {
  $("#paymentOpenCreate")?.addEventListener("click", () => openPayment());
  $("#paymentForm")?.addEventListener("submit", event => { event.preventDefault(); savePayment(); });
  $$('[data-payment-close],#paymentDrawerClose').forEach(button => button.addEventListener("click", closeDrawer));
  ["#paymentAmount", "#paymentReceivedAmount"].forEach(selector => $(selector)?.addEventListener("blur", event => formatMoneyInput(event.target)));
  $("#paymentProjectId")?.addEventListener("change", () => applyProjectDefaults({ suggestAmount: true }));
  $("#paymentType")?.addEventListener("change", () => {
    const label = $("#paymentLabel");
    if (label && (!label.value || ["訂金", "尾款", "全額款", "其他款項"].includes(label.value))) label.value = defaultLabel($("#paymentType").value);
    updateProjectHints({ suggestAmount: true });
  });
  ["#paymentRequestDate", "#paymentInvoiceDate", "#paymentTerms"].forEach(selector => $(selector)?.addEventListener("change", () => suggestExpectedDate({ force: true })));

  const resetPage = () => { state.currentPage = 1; renderPayments(); };
  $("#paymentSearch")?.addEventListener("input", resetPage);
  $("#paymentStatusFilter")?.addEventListener("change", resetPage);
  $("#paymentProjectStatusFilter")?.addEventListener("change", resetPage);
  $("#paymentPagination")?.addEventListener("click", event => {
    const button = event.target.closest("button[data-page]");
    if (!button || button.disabled) return;
    state.currentPage = Number(button.dataset.page) || 1;
    renderPayments();
    $("#tab-payments .payment-toolbar")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("#paymentPagination")?.addEventListener("change", event => {
    const select = event.target.closest("select[data-page-select]");
    if (!select) return;
    state.currentPage = Number(select.value) || 1;
    renderPayments();
  });

  $("#paymentProjectTableBody")?.addEventListener("click", async event => {
    const add = event.target.closest("[data-payment-add-project]");
    const expand = event.target.closest("[data-payment-expand]");
    const edit = event.target.closest("[data-payment-edit]");
    const receive = event.target.closest("[data-payment-receive]");
    const voidButton = event.target.closest("[data-payment-void]");
    const del = event.target.closest("[data-payment-delete]");
    if (add) return openPayment(null, { project: state.projects.find(project => project.id === add.dataset.paymentAddProject) });
    if (expand) return toggleProjectDetails(expand.dataset.paymentExpand);
    const id = edit?.dataset.paymentEdit || receive?.dataset.paymentReceive || voidButton?.dataset.paymentVoid || del?.dataset.paymentDelete;
    const payment = state.payments.find(item => item.id === id);
    if (edit && payment) return openPayment(payment);
    if (receive && payment) return openPayment(payment, { receive: true });
    if (voidButton && payment) return voidPayment(payment);
    if (del && payment && canDelete() && confirm("確定永久刪除這筆款項？若只是取消請款，建議使用『作廢』保留紀錄。")) return deleteDoc(doc(db, "payments", payment.id));
  });

  document.addEventListener("click", event => {
    const button = event.target.closest("[data-payment-project]");
    if (!button) return;
    const project = state.projects.find(item => item.id === button.dataset.paymentProject);
    if (!project) return;
    const related = activePayments(project.id);
    if (!related.length && canEdit()) return openPayment(null, { project });
    switchTab("payments");
    $("#paymentSearch").value = project.name || project.client || "";
    state.currentPage = 1;
    renderPayments();
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !$("#paymentDrawer")?.classList.contains("hidden")) closeDrawer();
  });
}

function init() {
  bindEvents();
  renderPayments();
  watchAuth(async user => {
    detach();
    state.user = user;
    state.role = null;
    if (!user) return renderPayments();
    try {
      await ensureUserDoc(user);
      state.role = await getUserRole(user);
    } catch (error) {
      console.error(error);
      state.role = "viewer";
    }
    attach();
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
