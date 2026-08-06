// Phase 2 payment module: project-linked billing, invoices and collections.
import { db, watchAuth, getUserAccess, hasPermission, ensureUserDoc, defaultPermissionsForRole } from "./firebase.js";
import { logAction } from "./audit.js";
import {
  collection, doc, setDoc, updateDoc, deleteDoc, onSnapshot,
  query, orderBy, serverTimestamp, writeBatch
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
  payments: collection(db, "payments"),
  receipts: collection(db, "receipts")
};

const state = {
  user: null,
  role: null,
  access: null,
  projects: [],
  customers: [],
  payments: [],
  receipts: [],
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
  return hasPermission(state.access, "managePayments");
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

function actualReceipts(paymentId) {
  return state.receipts.filter(receipt => receipt.paymentId === paymentId && !receipt.voided);
}

function receiptRows(payment) {
  const rows = actualReceipts(payment.id);
  if (rows.length) return rows;
  const legacyAmount = integerValue(payment.receivedAmount);
  return legacyAmount ? [{
    id: `legacy:${payment.id}`,
    paymentId: payment.id,
    amount: legacyAmount,
    receivedDate: payment.receivedDate || "",
    method: "",
    reference: "",
    note: "舊版收款紀錄",
    legacy: true
  }] : [];
}

function receivedForPayment(payment) {
  return receiptRows(payment).reduce((sum, receipt) => sum + integerValue(receipt.amount), 0);
}

function paymentStatus(payment) {
  if (payment.voided) return "void";
  const amount = integerValue(payment.amount);
  const received = receivedForPayment(payment);
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
  const received = rows.reduce((sum, payment) => sum + receivedForPayment(payment), 0);
  const receivable = rows
    .filter(payment => payment.requestDate)
    .reduce((sum, payment) => sum + Math.max(0, integerValue(payment.amount) - receivedForPayment(payment)), 0);
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
    unbilled: total ? Math.max(0, total - invoiced) : 0,
    receivable,
    totalOutstanding: total ? Math.max(0, total - received) : receivable,
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

function openReceiptDrawer() {
  $("#receiptDrawer")?.classList.remove("hidden");
  $("#receiptDrawer")?.setAttribute("aria-hidden", "false");
  document.body.classList.add("drawer-open");
}

function closeReceiptDrawer() {
  $("#receiptDrawer")?.classList.add("hidden");
  $("#receiptDrawer")?.setAttribute("aria-hidden", "true");
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
  $("#paymentNote").value = payment?.note || "";
  $("#paymentDrawerTitle").textContent = payment ? "編輯款項" : "新增款項";
  applyProjectDefaults({ suggestAmount: false });
}

function openPayment(payment = null, { project = null, receive = false } = {}) {
  if (!canEdit()) return alert("viewer 僅能查看請款與收款資料");
  if (receive && payment) return openReceipt(payment);
  resetForm(payment, project);
  openDrawer();
  setTimeout(() => $("#paymentProjectId")?.focus(), 50);
}

async function savePayment() {
  if (!canEdit() || !state.user) return alert("你目前沒有新增或編輯款項的權限");
  const id = $("#paymentId").value;
  const project = state.projects.find(item => item.id === $("#paymentProjectId").value);
  if (!project) return alert("請選擇要串接的專案");

  const amount = integerValue($("#paymentAmount").value);
  if (!amount) return alert("請填寫本筆應收金額");
  const currentPayment = id ? state.payments.find(payment => payment.id === id) : null;
  const alreadyReceived = currentPayment ? receivedForPayment(currentPayment) : 0;
  if (amount < alreadyReceived) return alert(`本筆已有 ${money(alreadyReceived)} 元收款紀錄，請款金額不能低於已收金額`);

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
    // 舊版欄位保留以相容既有資料；新版實際收款改存 receipts。
    receivedAmount: integerValue(currentPayment?.receivedAmount),
    receivedDate: currentPayment?.receivedDate || "",
    note: $("#paymentNote").value.trim(),
    voided: false,
    updatedAt: serverTimestamp(),
    updatedBy: state.user.uid
  };

  try {
    let targetId = id;
    if (id) {
      await updateDoc(doc(db, "payments", id), payload);
    } else {
      const ref = doc(collections.payments);
      targetId = ref.id;
      await setDoc(ref, { ...payload, createdAt: serverTimestamp(), createdBy: state.user.uid });
    }
    await logAction({
      action: id ? "update" : "create",
      module: "payments", targetType: "payment", targetId,
      targetName: `${project.client || ""}｜${project.name || ""}`,
      summary: `${payload.label}｜請款金額 ${money(payload.amount)}`
    });
    closeDrawer();
  } catch (error) {
    console.error(error);
    alert("儲存款項失敗：請確認 Firestore Rules 已加入 payments 權限");
  }
}

function paymentRemaining(payment, { excludingReceiptId = "" } = {}) {
  const received = receiptRows(payment)
    .filter(receipt => receipt.id !== excludingReceiptId)
    .reduce((sum, receipt) => sum + integerValue(receipt.amount), 0);
  return Math.max(0, integerValue(payment.amount) - received);
}

function paymentForReceipt(receipt) {
  return state.payments.find(payment => payment.id === receipt?.paymentId);
}

function resetReceiptForm(payment, receipt = null) {
  const remaining = paymentRemaining(payment, { excludingReceiptId: receipt?.id || "" });
  $("#receiptId").value = receipt?.legacy ? "" : (receipt?.id || "");
  $("#receiptPaymentId").value = payment.id;
  $("#receiptBillingLabel").textContent = `${payment.customerName || "未填客戶"}｜${payment.projectName || "未命名專案"}｜${payment.label || paymentTypeLabel(payment.paymentType)}`;
  $("#receiptAmount").value = receipt?.amount ? money(receipt.amount) : (remaining ? money(remaining) : "");
  $("#receiptDate").value = receipt?.receivedDate || TODAY();
  $("#receiptMethod").value = receipt?.method || "bank_transfer";
  $("#receiptReference").value = receipt?.reference || "";
  $("#receiptNote").value = receipt?.legacy ? "" : (receipt?.note || "");
  $("#receiptRemainingHint").textContent = `本筆請款尚可登記 ${money(remaining)} 元；每次入帳請分開建立。`;
  $("#receiptDrawerTitle").textContent = receipt && !receipt.legacy ? "編輯收款紀錄" : "登記收款";
}

function openReceipt(payment, receipt = null) {
  if (!canEdit()) return alert("你目前沒有登記收款的權限");
  if (!payment?.requestDate) return alert("請先填寫請款日，再登記實際收款");
  if (payment.voided) return alert("已作廢的請款不能登記收款");
  resetReceiptForm(payment, receipt);
  openReceiptDrawer();
  setTimeout(() => $("#receiptAmount")?.focus(), 50);
}

function legacyReceiptPayload(payment) {
  return {
    paymentId: payment.id,
    projectId: payment.projectId || "",
    projectName: payment.projectName || "",
    customerName: payment.customerName || "",
    billingLabel: payment.label || paymentTypeLabel(payment.paymentType),
    amount: integerValue(payment.receivedAmount),
    receivedDate: payment.receivedDate || payment.requestDate || TODAY(),
    method: "legacy",
    reference: "",
    note: "由舊版單筆收款欄位自動轉入",
    voided: false,
    createdAt: serverTimestamp(),
    createdBy: state.user.uid,
    updatedAt: serverTimestamp(),
    updatedBy: state.user.uid
  };
}

async function saveReceipt() {
  if (!canEdit() || !state.user) return alert("你目前沒有登記收款的權限");
  const id = $("#receiptId").value;
  const payment = state.payments.find(item => item.id === $("#receiptPaymentId").value);
  if (!payment || payment.voided) return alert("找不到可用的請款紀錄");
  if (!payment.requestDate) return alert("請先填寫請款日，再登記實際收款");
  const amount = integerValue($("#receiptAmount").value);
  const receivedDate = $("#receiptDate").value;
  if (!amount) return alert("請填寫本次實際收款金額");
  if (!receivedDate) return alert("請填寫實際收款日");
  const remaining = paymentRemaining(payment, { excludingReceiptId: id });
  if (amount > remaining) return alert(`本次收款不能超過尚未收取的 ${money(remaining)} 元`);

  const payload = {
    paymentId: payment.id,
    projectId: payment.projectId || "",
    projectName: payment.projectName || "",
    customerName: payment.customerName || "",
    billingLabel: payment.label || paymentTypeLabel(payment.paymentType),
    amount,
    receivedDate,
    method: $("#receiptMethod").value,
    reference: $("#receiptReference").value.trim(),
    note: $("#receiptNote").value.trim(),
    voided: false,
    updatedAt: serverTimestamp(),
    updatedBy: state.user.uid
  };

  try {
    const batch = writeBatch(db);
    if (!actualReceipts(payment.id).length && integerValue(payment.receivedAmount) > 0) {
      batch.set(doc(db, "receipts", `${payment.id}__legacy`), legacyReceiptPayload(payment));
      batch.update(doc(db, "payments", payment.id), { receivedAmount: 0, receivedDate: "", updatedAt: serverTimestamp(), updatedBy: state.user.uid });
    }
    let targetId = id;
    if (id) batch.update(doc(db, "receipts", id), payload);
    else {
      const ref = doc(collections.receipts);
      targetId = ref.id;
      batch.set(ref, { ...payload, createdAt: serverTimestamp(), createdBy: state.user.uid });
    }
    await batch.commit();
    await logAction({
      action: "receive", module: "payments", targetType: "receipt", targetId,
      targetName: `${payment.customerName || ""}｜${payment.projectName || ""}`,
      summary: `${payload.billingLabel}｜${payload.receivedDate} 入帳 ${money(payload.amount)}`
    });
    closeReceiptDrawer();
  } catch (error) {
    console.error(error);
    alert("儲存收款紀錄失敗：請確認新版 Firestore Rules 已發布");
  }
}

function receiptMethodLabel(method) {
  return ({ bank_transfer: "銀行轉帳", cash: "現金", check: "支票", card: "刷卡", other: "其他", legacy: "舊版轉入" })[method] || "—";
}

function renderReceiptHistory(payment) {
  const rows = [...receiptRows(payment)].sort((a, b) => String(a.receivedDate || "").localeCompare(String(b.receivedDate || "")));
  if (!rows.length) return `<div class="table-sub">尚無入帳紀錄</div>`;
  return `<div class="receipt-history">${rows.map(receipt => `<div class="receipt-history-row">
    <span><b>${esc(receipt.receivedDate || "日期未填")}</b>｜${money(receipt.amount)}｜${esc(receiptMethodLabel(receipt.method))}${receipt.reference ? `｜${esc(receipt.reference)}` : ""}</span>
    <span class="receipt-history-actions">${receipt.legacy ? '<span class="table-sub">舊版紀錄</span>' : `<button class="link-button" type="button" data-receipt-edit="${esc(receipt.id)}" ${canEdit() ? "" : "disabled"}>編輯</button><button class="link-button danger" type="button" data-receipt-void="${esc(receipt.id)}" ${canEdit() ? "" : "disabled"}>作廢</button>`}</span>
  </div>`).join("")}</div>`;
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
    const received = receivedForPayment(payment);
    const remaining = Math.max(0, integerValue(payment.amount) - received);
    return `<tr class="${payment.voided ? "payment-void-row" : ""}">
      <td><b>${esc(payment.label || paymentTypeLabel(payment.paymentType))}</b><div class="table-sub">${esc(paymentTypeLabel(payment.paymentType))}</div></td>
      <td class="num">${money(payment.amount)}</td>
      <td>${dateText(payment.requestDate)}<div class="table-sub">發票：${esc(payment.invoiceNumber || "—")} ${payment.invoiceDate ? `｜${esc(payment.invoiceDate)}` : ""}</div></td>
      <td>${dateText(payment.expectedPaymentDate)}</td>
      <td>${renderReceiptHistory(payment)}<div class="table-sub">累計 ${money(received)}</div></td>
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
    <div class="table-scroll"><table class="table payment-detail-table"><thead><tr><th>款項</th><th class="num">請款金額</th><th>請款／發票</th><th>預計收款</th><th>實際收款紀錄</th><th class="num">應收餘額</th><th>狀態</th><th>操作</th></tr></thead><tbody>${body}</tbody></table></div>`;
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
    const totalOutstandingText = summary.total
      ? money(summary.totalOutstanding)
      : (summary.isTracked ? `${money(summary.totalOutstanding)}<div class="table-sub">總價待確認</div>` : "尚未登記");
    return `<tr class="payment-project-row" data-payment-toggle-project="${esc(project.id)}">
      <td><b>${esc(project.name || "未命名專案")}</b><div class="table-sub">${esc(project.client || "—")}</div></td>
      <td>${esc(project.startDate || "—")}～${esc(project.endDate || "—")}<div class="table-sub">${esc(projectStatusLabel(project.status))}</div></td>
      <td class="num">${summary.total ? money(summary.total) : '<span class="pending-value">待確認</span>'}</td>
      <td class="num">${money(summary.invoiced)}</td>
      <td class="num">${summary.total ? money(summary.unbilled) : "—"}</td>
      <td class="num"><b>${money(summary.receivable)}</b></td>
      <td class="num">${money(summary.received)}</td>
      <td class="num">${totalOutstandingText}</td>
      <td><span class="badge ${paymentStatusBadge(summary.status)}">${esc(summary.isTracked ? paymentStatusLabel(summary.status) : "尚未建立款項")}</span></td>
      <td><div class="row-actions"><button class="btn ghost small" type="button" data-payment-add-project="${esc(project.id)}" ${canEdit() ? "" : "disabled"}>新增款項</button><button class="btn ghost small" type="button" data-payment-expand="${esc(project.id)}">查看明細</button></div></td>
    </tr><tr class="payment-project-detail" data-payment-detail-project="${esc(project.id)}" hidden><td colspan="10">${renderPaymentDetails(project, summary)}</td></tr>`;
  }).join("") : `<tr><td colspan="10"><div class="empty-state">找不到符合條件的專案</div></td></tr>`;

  const tracked = state.projects.filter(project => project.status !== "lost").map(projectPaymentSummary);
  $("#paymentProjectTotal").textContent = money(tracked.reduce((sum, item) => sum + item.total, 0));
  $("#paymentInvoicedTotal").textContent = money(tracked.reduce((sum, item) => sum + item.invoiced, 0));
  $("#paymentReceivedTotal").textContent = money(tracked.reduce((sum, item) => sum + item.received, 0));
  $("#paymentUnbilledTotal").textContent = money(tracked.reduce((sum, item) => sum + item.unbilled, 0));
  $("#paymentReceivableTotal").textContent = money(tracked.reduce((sum, item) => sum + item.receivable, 0));
  $("#paymentOutstandingTotal").textContent = money(tracked.reduce((sum, item) => sum + item.totalOutstanding, 0));
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
  await logAction({ action: "void", module: "payments", targetType: "payment", targetId: payment.id, targetName: `${payment.customerName || ""}｜${payment.projectName || ""}`, summary: `${payment.label || paymentTypeLabel(payment.paymentType)}｜${money(payment.amount)} 元` });
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
  state.receipts = [];
  renderPayments();
}

function attach() {
  listen("projects", collections.projects, "projects");
  listen("customers", collections.customers, "customers");
  listen("payments", collections.payments, "payments");
  listen("receipts", collections.receipts, "receipts");
}

function bindEvents() {
  $("#paymentOpenCreate")?.addEventListener("click", () => openPayment());
  $("#paymentForm")?.addEventListener("submit", event => { event.preventDefault(); savePayment(); });
  $$('[data-payment-close],#paymentDrawerClose').forEach(button => button.addEventListener("click", closeDrawer));
  $("#paymentAmount")?.addEventListener("blur", event => formatMoneyInput(event.target));
  $("#receiptForm")?.addEventListener("submit", event => { event.preventDefault(); saveReceipt(); });
  $$('[data-receipt-close],#receiptDrawerClose').forEach(button => button.addEventListener("click", closeReceiptDrawer));
  $("#receiptAmount")?.addEventListener("blur", event => formatMoneyInput(event.target));
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
    const receiptEdit = event.target.closest("[data-receipt-edit]");
    const receiptVoid = event.target.closest("[data-receipt-void]");
    if (receiptEdit) {
      const receipt = state.receipts.find(item => item.id === receiptEdit.dataset.receiptEdit);
      const payment = paymentForReceipt(receipt);
      if (receipt && payment) return openReceipt(payment, receipt);
    }
    if (receiptVoid) {
      const receipt = state.receipts.find(item => item.id === receiptVoid.dataset.receiptVoid);
      const payment = paymentForReceipt(receipt);
      if (receipt && payment && canEdit() && confirm(`確定作廢 ${receipt.receivedDate || ""} 的收款紀錄 ${money(receipt.amount)} 元？紀錄會保留，但不再計入已收款。`)) {
        await updateDoc(doc(db, "receipts", receipt.id), { voided: true, voidedAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: state.user.uid });
        await logAction({ action: "void", module: "payments", targetType: "receipt", targetId: receipt.id, targetName: `${payment.customerName || ""}｜${payment.projectName || ""}`, summary: `${receipt.receivedDate || ""}｜${money(receipt.amount)} 元` });
      }
      return;
    }
    if (add) return openPayment(null, { project: state.projects.find(project => project.id === add.dataset.paymentAddProject) });
    if (expand) return toggleProjectDetails(expand.dataset.paymentExpand);
    const id = edit?.dataset.paymentEdit || receive?.dataset.paymentReceive || voidButton?.dataset.paymentVoid || del?.dataset.paymentDelete;
    const payment = state.payments.find(item => item.id === id);
    if (edit && payment) return openPayment(payment);
    if (receive && payment) return openPayment(payment, { receive: true });
    if (voidButton && payment) return voidPayment(payment);
    if (del && payment && canDelete()) {
      const relatedReceipts = state.receipts.filter(receipt => receipt.paymentId === payment.id);
      if (relatedReceipts.length || integerValue(payment.receivedAmount) > 0) {
        return alert(`此款項已有 ${relatedReceipts.length || 1} 筆收款紀錄，不能永久刪除。請使用「作廢」保留完整歷史。`);
      }
      if (!confirm("確定永久刪除這筆完全沒有收款紀錄的款項？若只是取消請款，建議使用『作廢』。")) return;
      await deleteDoc(doc(db, "payments", payment.id));
      await logAction({ action: "delete", module: "payments", targetType: "payment", targetId: payment.id, targetName: `${payment.customerName || ""}｜${payment.projectName || ""}`, summary: `${payment.label || paymentTypeLabel(payment.paymentType)}｜${money(payment.amount)} 元` });
      return;
    }
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
    if (event.key === "Escape" && !$("#receiptDrawer")?.classList.contains("hidden")) closeReceiptDrawer();
  });
}

function init() {
  bindEvents();
  renderPayments();
  watchAuth(async user => {
    detach();
    state.user = user;
    state.role = null;
    state.access = null;
    if (!user) return renderPayments();
    try {
      await ensureUserDoc(user);
      state.access = await getUserAccess(user);
      state.role = state.access.role;
    } catch (error) {
      console.error(error);
      state.role = "viewer";
      state.access = { role: "viewer", approved: false, permissions: defaultPermissionsForRole("viewer") };
    }
    if (state.access.approved) attach();
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
