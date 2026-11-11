// Phase 1 quotation module: customers, quotation catalog, versioned quotations and A4 output.
import { db, watchAuth, getUserAccess, hasPermission, ensureUserDoc, defaultPermissionsForRole } from "./firebase.js";
import { logAction } from "./audit.js";
import { subscribeCollection, createRenderScheduler } from "./data-store.js";
import { bindUiControlMemory, forgetUiControls, restoreUiControls } from "./ui-state.js?v=phase3-v14-1";
import {
  latestConfirmedChangeOrders,
  quotationMonthFromNumber,
  signedQuotationAmount
} from "./relation-utils.js?v=phase3-v14";
import {
  collection, doc, setDoc, updateDoc, deleteDoc,
  serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const TAX_RATE = 0.05;
const QUOTATIONS_PER_PAGE = 20;
const CUSTOMERS_PER_PAGE = 25;
const QUOTE_ITEMS_PER_PAGE = 25;
const COMPANY_LOGO_URL = new URL("./assets/yaoyan-logo.png", import.meta.url).href;
const DEFAULT_TERMS = `1. 本報價單視同合約，經簽名或用印回傳即成立。
2. 初次合作請於報價單成立後14日內或活動開始前3日，支付頭款30%。
3. 本公司將於專案完成日後14日內開立發票請款，請於發票開立後30日內完成尾款支付。
4. 特效器材架設完成後，如非可歸責於本公司之原因而未使用，費用仍依原報價計算。
5. 未包含於報價單內項目，若須追加，將依實際追加項目進行報價與請款。`;

const COMPANY = {
  name: "曜炎創意娛樂有限公司 Yaoyan Effects Co., Ltd.",
  taxId: "60452137",
  contact: "曾允霖",
  email: "yaoyanfx@gmail.com",
  bank: "國泰世華商業銀行 (013)",
  accountName: "曜炎創意娛樂有限公司",
  account: "109-03-501780-3"
};

const collections = {
  customers: collection(db, "customers"),
  quotationItems: collection(db, "quotationItems"),
  quotations: collection(db, "quotations"),
  projects: collection(db, "projects"),
  equipment: collection(db, "equipment"),
  payments: collection(db, "payments"),
  receipts: collection(db, "receipts")
};

const state = {
  user: null,
  role: null,
  access: null,
  customers: [],
  quotationItems: [],
  quotations: [],
  projects: [],
  equipment: [],
  payments: [],
  receipts: [],
  unsubs: [],
  previewData: null,
  numberWasSuggested: false,
  quotationCurrentPage: 1,
  customerCurrentPage: 1,
  quoteItemCurrentPage: 1,
  quotationSelectedIds: new Set(),
  quotationProjectFilterId: "",
  quotationProjectPriceCustomized: false,
  quotationProjectPricePdfVisibilityCustomized: false,
  quotationFormDirty: false,
  quotationItemSort: { key: "category", direction: "asc" },
  quoteItemCreatedFromEquipment: false
};

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function uid() {
  return globalThis.crypto?.randomUUID?.() || `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function numberValue(value) {
  const n = Number(String(value ?? "").replaceAll(",", "").trim());
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

function signedNumberValue(value) {
  const n = Number(String(value ?? "").replaceAll(",", "").trim());
  return Number.isFinite(n) ? n : 0;
}

function integerValue(value) { return Math.round(numberValue(value)); }
function signedIntegerValue(value) { return Math.round(signedNumberValue(value)); }
function money(value) { return Math.round(numberValue(value)).toLocaleString("zh-TW"); }
function signedMoney(value, { plus = false } = {}) {
  const amount = signedIntegerValue(value);
  const prefix = amount < 0 ? "−" : plus && amount > 0 ? "+" : "";
  return `${prefix}${Math.abs(amount).toLocaleString("zh-TW")}`;
}
function percentage(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return String(Math.round(number * 100) / 100);
}
function dateText(value) { return value || "—"; }
function safeFilenamePart(value, fallback) {
  return String(value || fallback || "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim() || fallback || "未命名";
}
function quotationFilename(q) {
  const firstEventDate = Array.isArray(q.events)
    ? q.events.map(event => event?.eventDate).find(Boolean)
    : "";
  return [
    safeFilenamePart(q.number, "報價編號未填"),
    safeFilenamePart(q.customerName, "客戶未填"),
    `${safeFilenamePart(firstEventDate, "日期未填")}${safeFilenamePart(q.projectName, "活動名稱未填")}`
  ].join("_");
}
function timestampText(value) {
  if (!value) return "—";
  const d = typeof value.toDate === "function" ? value.toDate() : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-TW", { year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function timestampValue(value) {
  if (!value) return 0;
  const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);
  const result = date.getTime();
  return Number.isNaN(result) ? 0 : result;
}

function normalizedDateTokens(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  const tokens = [];
  const fullDatePattern = /(20\d{2})[\/.\-年]\s*(\d{1,2})[\/.\-月]\s*(\d{1,2})日?/g;
  let match;
  let inheritedYear = "";
  while ((match = fullDatePattern.exec(text))) {
    inheritedYear = match[1];
    tokens.push(`${match[1]}-${String(Number(match[2])).padStart(2, "0")}-${String(Number(match[3])).padStart(2, "0")}`);
  }
  const tokenYear = inheritedYear || String(new Date().getFullYear());
  const shortDatePattern = /(?:^|[^\d])(\d{1,2})[\/.\-月]\s*(\d{1,2})日?/g;
  while ((match = shortDatePattern.exec(text))) {
    const token = `${tokenYear}-${String(Number(match[1])).padStart(2, "0")}-${String(Number(match[2])).padStart(2, "0")}`;
    if (!tokens.includes(token)) tokens.push(token);
  }
  return tokens;
}

function canEdit() { return hasPermission(state.access, "manageQuotations"); }
function canManageCustomers() { return hasPermission(state.access, "manageCustomers"); }
function canManageCatalog() { return hasPermission(state.access, "manageCatalog"); }
function canCreateProject() { return hasPermission(state.access, "createProjects"); }
function canEditProject() { return hasPermission(state.access, "editProjects"); }
function canDelete() { return state.role === "admin"; }

function statusLabel(status) {
  return ({ draft: "草稿", sent: "已寄出", confirmed: "已確認", void: "作廢" })[status] || status || "草稿";
}

function statusBadge(status) {
  return ({ draft: "neutral", sent: "blue", confirmed: "green", void: "red" })[status] || "neutral";
}

function calcModeLabel(mode, rate = 50) {
  return ({
    auto50: "次日起 50%",
    daily: "每日原價",
    custom: `續日 ${numberValue(rate)}%`,
    manual: "人工小計",
    included: "免費／已含"
  })[mode] || "次日起 50%";
}

function calcRowSubtotal(row) {
  if (row.calcMode === "included") return 0;
  if (row.calcMode === "manual") return integerValue(row.manualSubtotal);
  const price = numberValue(row.unitPrice);
  const qty = numberValue(row.qty);
  const days = Math.max(1, numberValue(row.days) || 1);
  const rate = row.calcMode === "daily" ? 100 : row.calcMode === "custom" ? numberValue(row.continuationRate) : 50;
  return Math.round(price * qty * (1 + Math.max(0, days - 1) * rate / 100));
}

function calcOriginalRowSubtotal(row) {
  if (row?.calcMode === "included") return 0;
  const price = numberValue(row?.unitPrice);
  const qty = numberValue(row?.qty);
  const days = Math.max(1, numberValue(row?.days) || 1);
  return Math.round(price * qty * days);
}

function calcPdfRowSubtotal(row) {
  if (row?.calcMode === "included") return 0;
  return row?.applyPricingToPdf === true ? calcRowSubtotal(row) : calcOriginalRowSubtotal(row);
}

function calcDealSubtotal(row) {
  if (row?.calcMode === "included") return 0;
  if (row?.dealSubtotal === undefined || row?.dealSubtotal === null || String(row.dealSubtotal).trim() === "") return calcPdfRowSubtotal(row);
  return integerValue(row.dealSubtotal);
}

function isChangeOrder(value = $("#quotationKind")?.value) {
  return value === "change_order";
}

function rowAdjustmentFactor(row, quotationKind = $("#quotationKind")?.value) {
  return quotationKind === "change_order" && row?.adjustmentType === "reduction" ? -1 : 1;
}

function calcTotals(rows, projectPriceInput = "", useCustomProjectPrice = false, quotationKind = $("#quotationKind")?.value || "standard") {
  const additionRows = (rows || []).filter(row => rowAdjustmentFactor(row, quotationKind) > 0);
  const reductionRows = quotationKind === "change_order" ? (rows || []).filter(row => rowAdjustmentFactor(row, quotationKind) < 0) : [];
  const additionSubtotal = Math.round(additionRows.reduce((sum, row) => sum + calcPdfRowSubtotal(row), 0));
  const reductionSubtotal = Math.round(reductionRows.reduce((sum, row) => sum + calcPdfRowSubtotal(row), 0));
  const additionOriginalSubtotal = Math.round(additionRows.reduce((sum, row) => sum + calcOriginalRowSubtotal(row), 0));
  const reductionOriginalSubtotal = Math.round(reductionRows.reduce((sum, row) => sum + calcOriginalRowSubtotal(row), 0));
  const originalSubtotal = additionOriginalSubtotal - reductionOriginalSubtotal;
  const subtotal = additionSubtotal - reductionSubtotal;
  const tax = Math.round(subtotal * TAX_RATE);
  const originalTotal = subtotal + tax;
  const additionDealSubtotal = Math.round(additionRows.reduce((sum, row) => sum + calcDealSubtotal(row), 0));
  const reductionDealSubtotal = Math.round(reductionRows.reduce((sum, row) => sum + calcDealSubtotal(row), 0));
  const dealSubtotal = additionDealSubtotal - reductionDealSubtotal;
  const calculatedTax = Math.round(dealSubtotal * TAX_RATE);
  const calculatedProjectPriceTaxed = dealSubtotal + calculatedTax;
  const hasCustomPrice = useCustomProjectPrice && String(projectPriceInput ?? "").trim() !== "";
  const projectPriceTaxed = hasCustomPrice
    ? (quotationKind === "change_order" ? signedIntegerValue(projectPriceInput) : integerValue(projectPriceInput))
    : calculatedProjectPriceTaxed;
  const projectPriceUntaxed = hasCustomPrice ? (projectPriceTaxed ? Math.round(projectPriceTaxed / (1 + TAX_RATE)) : 0) : dealSubtotal;
  const projectTax = projectPriceTaxed - projectPriceUntaxed;
  return {
    quotationKind,
    subtotal,
    originalSubtotal,
    additionSubtotal,
    reductionSubtotal,
    additionOriginalSubtotal,
    reductionOriginalSubtotal,
    additionDealSubtotal,
    reductionDealSubtotal,
    tax,
    originalTotal,
    dealSubtotal,
    calculatedTax,
    calculatedProjectPriceTaxed,
    projectPriceTaxed,
    projectPriceUntaxed,
    projectTax,
    projectPriceMode: hasCustomPrice ? "manual" : "auto",
    discount: quotationKind === "change_order" ? 0 : Math.max(0, originalTotal - projectPriceTaxed),
    allocationDifference: projectPriceUntaxed - dealSubtotal,
    adjustmentTotalTaxed: quotationKind === "change_order" ? projectPriceTaxed : 0,
    adjustmentTotalUntaxed: quotationKind === "change_order" ? projectPriceUntaxed : 0
  };
}

function switchTab(tab) {
  document.querySelector(`.tab-button[data-tab="${tab}"]`)?.click();
}

function openDrawer(id) {
  const el = $(id);
  el?.classList.remove("hidden");
  el?.setAttribute("aria-hidden", "false");
  document.body.classList.add("drawer-open");
}

function closeDrawer(id) {
  const el = $(id);
  el?.classList.add("hidden");
  el?.setAttribute("aria-hidden", "true");
  if (!$(".drawer:not(.hidden)")) document.body.classList.remove("drawer-open");
}

function closeQuotationDrawer({ force = false } = {}) {
  const drawer = $("#quotationDrawer");
  if (!drawer || drawer.classList.contains("hidden")) return true;
  if (!force && state.quotationFormDirty && !confirm("這張報價有尚未儲存的修改，確定要關閉嗎？")) return false;
  closeAllocationModal();
  closeDrawer("#quotationDrawer");
  state.quotationFormDirty = false;
  return true;
}

function setMutationButtons() {
  const settings = [
    ["#quotationOpenCreate", canEdit(), "目前沒有管理報價的權限"],
    ["#customerOpenCreate", canManageCustomers(), "目前沒有管理客戶的權限"],
    ["#quoteItemOpenCreate", canManageCatalog(), "目前沒有管理常用報價項目的權限"]
  ];
  settings.forEach(([selector, allowed, message]) => {
    const button = $(selector);
    if (!button) return;
    button.disabled = !allowed;
    button.title = allowed ? "" : message;
  });
}

/* ------------------------- Customers ------------------------- */
function resetCustomerForm(customer = null) {
  $("#customerId").value = customer?.id || "";
  $("#customerName").value = customer?.name || "";
  $("#customerTaxId").value = customer?.taxId || "";
  $("#customerPaymentTerms").value = customer?.paymentTerms || "";
  $("#customerAddress").value = customer?.address || "";
  $("#customerInvoiceInfo").value = customer?.invoiceInfo || "";
  $("#customerContactName").value = customer?.contactName || "";
  $("#customerContactTitle").value = customer?.contactTitle || "";
  $("#customerPhone").value = customer?.phone || "";
  $("#customerEmail").value = customer?.email || "";
  $("#customerNote").value = customer?.note || "";
  $("#customerDrawerTitle").textContent = customer ? "編輯客戶" : "新增客戶";
}

function openCustomer(customer = null) {
  if (!canManageCustomers()) return alert("你目前沒有管理客戶資料的權限");
  resetCustomerForm(customer);
  openDrawer("#customerDrawer");
}

async function saveCustomer() {
  if (!canManageCustomers()) return alert("你目前沒有管理客戶資料的權限");
  const id = $("#customerId").value;
  const payload = {
    name: $("#customerName").value.trim(),
    taxId: $("#customerTaxId").value.trim(),
    paymentTerms: $("#customerPaymentTerms").value.trim(),
    address: $("#customerAddress").value.trim(),
    invoiceInfo: $("#customerInvoiceInfo").value.trim(),
    contactName: $("#customerContactName").value.trim(),
    contactTitle: $("#customerContactTitle").value.trim(),
    phone: $("#customerPhone").value.trim(),
    email: $("#customerEmail").value.trim(),
    note: $("#customerNote").value.trim(),
    updatedAt: serverTimestamp(),
    updatedBy: state.user?.uid || ""
  };
  if (!payload.name) return alert("請填寫客戶／公司名稱");
  const duplicate = state.customers.find(customer =>
    customer.id !== id && String(customer.name || "").trim().toLocaleLowerCase() === payload.name.toLocaleLowerCase()
  );
  if (duplicate) return alert("已有相同名稱的客戶，請直接編輯既有客戶資料，避免專案連結到不同筆客戶。");
  try {
    let targetId = id;
    if (id) await updateDoc(doc(db, "customers", id), payload);
    else {
      const ref = doc(collections.customers);
      targetId = ref.id;
      await setDoc(ref, { ...payload, createdAt: serverTimestamp(), createdBy: state.user?.uid || "" });
    }
    await logAction({ action: id ? "update" : "create", module: "customers", targetType: "customer", targetId, targetName: payload.name, summary: payload.contactName ? `主要窗口：${payload.contactName}` : "更新客戶資料" });
    closeDrawer("#customerDrawer");
  } catch (error) {
    console.error(error);
    alert("客戶儲存失敗，請確認 Firestore 規則已加入 customers 權限");
  }
}

function renderManagedPagination(hostSelector, totalItems, currentPage, pageSize, label) {
  const host = $(hostSelector);
  if (!host) return 1;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const page = Math.min(Math.max(1, currentPage || 1), totalPages);
  if (totalPages <= 1) {
    host.innerHTML = "";
    return page;
  }
  const visiblePages = new Set([1, totalPages]);
  for (let value = page - 2; value <= page + 2; value += 1) if (value >= 1 && value <= totalPages) visiblePages.add(value);
  const pageButtons = [...visiblePages].sort((a, b) => a - b).map((value, index, pages) => {
    const gap = index && value - pages[index - 1] > 1 ? `<span class="pagination-ellipsis" aria-hidden="true">…</span>` : "";
    return `${gap}<button class="page-number ${value === page ? "active" : ""}" type="button" data-page="${value}" ${value === page ? 'aria-current="page"' : ""}>${value}</button>`;
  }).join("");
  const options = Array.from({ length: totalPages }, (_, index) => index + 1)
    .map(value => `<option value="${value}" ${value === page ? "selected" : ""}>${value}</option>`).join("");
  host.innerHTML = `<button class="page-direction" type="button" data-page="${page - 1}" ${page === 1 ? "disabled" : ""}>上一頁</button><div class="pagination-pages">${pageButtons}</div><span class="pagination-summary">第 ${page} / ${totalPages} 頁</span><label class="pagination-jump"><span>跳至</span><select data-page-select aria-label="選擇${esc(label)}頁數">${options}</select><span>頁</span></label><button class="page-direction" type="button" data-page="${page + 1}" ${page === totalPages ? "disabled" : ""}>下一頁</button>`;
  return page;
}

function renderCustomers() {
  const body = $("#customerTableBody");
  if (!body) return;
  const keyword = $("#customerSearch")?.value.trim().toLocaleLowerCase("zh-Hant") || "";
  const list = state.customers.filter(customer => !keyword || [customer.name, customer.taxId, customer.contactName, customer.phone, customer.email]
    .join(" ").toLocaleLowerCase("zh-Hant").includes(keyword));
  state.customerCurrentPage = renderManagedPagination("#customerPagination", list.length, state.customerCurrentPage, CUSTOMERS_PER_PAGE, "客戶");
  const startIndex = (state.customerCurrentPage - 1) * CUSTOMERS_PER_PAGE;
  const pageList = list.slice(startIndex, startIndex + CUSTOMERS_PER_PAGE);
  if ($("#customerResultCount")) $("#customerResultCount").textContent = list.length ? `共 ${list.length} 筆（顯示 ${startIndex + 1}–${Math.min(startIndex + CUSTOMERS_PER_PAGE, list.length)}）` : "共 0 筆";
  body.innerHTML = pageList.length ? pageList.map(customer => `
    <tr>
      <td><b>${esc(customer.name)}</b>${customer.address ? `<div class="table-sub">${esc(customer.address)}</div>` : ""}</td>
      <td>${esc(customer.taxId || "—")}</td>
      <td>${esc(customer.contactName || "—")}<div class="table-sub">${esc(customer.contactTitle || "")}</div></td>
      <td>${esc(customer.paymentTerms || "—")}</td>
      <td>${esc(customer.phone || "—")}<div class="table-sub">${esc(customer.email || "")}</div></td>
      <td><div class="row-actions"><button class="btn ghost small" type="button" data-customer-edit="${esc(customer.id)}" ${canManageCustomers() ? "" : "disabled"}>編輯</button><button class="btn ghost small" type="button" data-customer-delete="${esc(customer.id)}" ${canDelete() ? "" : "disabled"}>刪除</button></div></td>
    </tr>`).join("") : `<tr><td colspan="6"><div class="empty-state">尚無客戶資料</div></td></tr>`;
  refreshCustomerOptions();
}

/* ------------------------- Quotation catalog ------------------------- */
function linkedEquipment(item) {
  return state.equipment.find(equipment => equipment.id === item?.equipmentId) || null;
}

function quoteItemEquipmentName(item) {
  return linkedEquipment(item)?.name || item?.equipmentName || "";
}

function quoteItemSortValue(item, key) {
  if (key === "unitPrice") return numberValue(item.unitPrice);
  if (key === "calcMode") return calcModeLabel(item.calcMode, item.continuationRate);
  if (key === "equipmentName") return quoteItemEquipmentName(item) || "未連結";
  return String(item?.[key] || (key === "category" ? "未分類" : ""));
}

function refreshEquipmentOptions() {
  const select = $("#quoteItemEquipmentId");
  if (!select) return;
  const current = select.value;
  const grouped = new Map();
  [...state.equipment]
    .sort((a, b) => String(a.category || "未分類").localeCompare(String(b.category || "未分類"), "zh-Hant", { numeric: true, sensitivity: "base" })
      || String(a.name || "").localeCompare(String(b.name || ""), "zh-Hant", { numeric: true, sensitivity: "base" }))
    .forEach(item => {
      const category = String(item.category || "未分類").trim() || "未分類";
      if (!grouped.has(category)) grouped.set(category, []);
      grouped.get(category).push(item);
    });
  const options = [...grouped.entries()].map(([category, items]) => `<optgroup label="${esc(category)}">${items.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join("")}</optgroup>`).join("");
  select.innerHTML = `<option value="">不連結</option>${options}`;
  select.value = [...select.options].some(option => option.value === current) ? current : "";
}

function resetQuoteItemForm(item = null) {
  state.quoteItemCreatedFromEquipment = Boolean(item?.__fromEquipment);
  $("#quoteItemId").value = item?.id || "";
  $("#quoteItemCategory").value = item?.category || "";
  $("#quoteItemName").value = item?.name || "";
  $("#quoteItemPrice").value = item?.unitPrice ? money(item.unitPrice) : "";
  $("#quoteItemUnit").value = item?.unit || "";
  $("#quoteItemCalcMode").value = item?.calcMode || "auto50";
  $("#quoteItemContinuationRate").value = item?.continuationRate ?? 50;
  $("#quoteItemNote").value = item?.note || "";
  refreshEquipmentOptions();
  $("#quoteItemEquipmentId").value = item?.equipmentId || "";
  $("#quoteItemDrawerTitle").textContent = item?.__fromEquipment ? "由設備建立項目" : item ? "編輯項目" : "新增項目";
}

function openQuoteItem(item = null) {
  if (!canManageCatalog()) return alert("你目前沒有管理常用報價項目的權限");
  resetQuoteItemForm(item);
  openDrawer("#quoteItemDrawer");
}

async function saveQuoteItem() {
  if (!canManageCatalog()) return alert("你目前沒有管理常用報價項目的權限");
  const id = $("#quoteItemId").value;
  const equipmentId = $("#quoteItemEquipmentId").value;
  const equipment = state.equipment.find(item => item.id === equipmentId);
  const payload = {
    category: $("#quoteItemCategory").value.trim(),
    name: $("#quoteItemName").value.trim(),
    unitPrice: integerValue($("#quoteItemPrice").value),
    unit: $("#quoteItemUnit").value.trim(),
    calcMode: $("#quoteItemCalcMode").value,
    continuationRate: numberValue($("#quoteItemContinuationRate").value),
    equipmentId,
    equipmentName: equipment?.name || "",
    equipmentCategory: equipment?.category || "",
    note: $("#quoteItemNote").value.trim(),
    updatedAt: serverTimestamp(),
    updatedBy: state.user?.uid || ""
  };
  if (!payload.name) return alert("請填寫項目名稱");
  try {
    let targetId = id;
    if (id) await updateDoc(doc(db, "quotationItems", id), payload);
    else {
      const ref = doc(collections.quotationItems);
      targetId = ref.id;
      await setDoc(ref, { ...payload, createdAt: serverTimestamp(), createdBy: state.user?.uid || "" });
    }
    await logAction({ action: id ? "update" : "create", module: "catalog", targetType: "quotationItem", targetId, targetName: payload.name, summary: `${payload.category || "未分類"}｜${money(payload.unitPrice)} 元／${payload.unit || "單位未填"}` });
    closeDrawer("#quoteItemDrawer");
    if (state.quoteItemCreatedFromEquipment) switchTab("quotation-items");
    state.quoteItemCreatedFromEquipment = false;
  } catch (error) {
    console.error(error);
    alert("品項儲存失敗，請確認 Firestore 規則已加入 quotationItems 權限");
  }
}

function renderQuoteItems() {
  const body = $("#quoteItemTableBody");
  if (!body) return;
  const keyword = $("#quoteItemSearch")?.value.trim().toLocaleLowerCase("zh-Hant") || "";
  const list = state.quotationItems
    .filter(item => !keyword || [item.category, item.name, item.unit, quoteItemEquipmentName(item)]
      .join(" ").toLocaleLowerCase("zh-Hant").includes(keyword))
    .sort((a, b) => {
      const key = state.quotationItemSort.key;
      const aValue = quoteItemSortValue(a, key);
      const bValue = quoteItemSortValue(b, key);
      const result = key === "unitPrice"
        ? aValue - bValue
        : String(aValue).localeCompare(String(bValue), "zh-Hant", { numeric: true, sensitivity: "base" });
      const tie = String(a.name || "").localeCompare(String(b.name || ""), "zh-Hant", { numeric: true, sensitivity: "base" });
      return (state.quotationItemSort.direction === "asc" ? result : -result) || tie;
    });
  $$('[data-quote-item-sort]').forEach(button => {
    const active = button.dataset.quoteItemSort === state.quotationItemSort.key;
    button.classList.toggle("active", active);
    const indicator = $("span", button);
    if (indicator) indicator.textContent = active ? (state.quotationItemSort.direction === "asc" ? "↑" : "↓") : "";
  });
  state.quoteItemCurrentPage = renderManagedPagination("#quoteItemPagination", list.length, state.quoteItemCurrentPage, QUOTE_ITEMS_PER_PAGE, "常用報價項目");
  const startIndex = (state.quoteItemCurrentPage - 1) * QUOTE_ITEMS_PER_PAGE;
  const pageList = list.slice(startIndex, startIndex + QUOTE_ITEMS_PER_PAGE);
  if ($("#quoteItemResultCount")) $("#quoteItemResultCount").textContent = list.length ? `共 ${list.length} 筆（顯示 ${startIndex + 1}–${Math.min(startIndex + QUOTE_ITEMS_PER_PAGE, list.length)}）` : "共 0 筆";
  body.innerHTML = pageList.length ? pageList.map(item => `
    <tr><td>${esc(item.category || "未分類")}</td><td><b>${esc(item.name)}</b>${item.note ? `<div class="table-sub">${esc(item.note)}</div>` : ""}</td><td class="num">${item.calcMode === "included" ? "—" : money(item.unitPrice)}</td><td>${esc(item.unit || "—")}</td><td>${esc(calcModeLabel(item.calcMode, item.continuationRate))}</td><td>${esc(quoteItemEquipmentName(item) || "—")}</td><td><div class="row-actions"><button class="btn ghost small" type="button" data-item-edit="${esc(item.id)}" ${canManageCatalog() ? "" : "disabled"}>編輯</button><button class="btn ghost small" type="button" data-item-delete="${esc(item.id)}" ${canDelete() ? "" : "disabled"}>刪除</button></div></td></tr>`).join("") : `<tr><td colspan="7"><div class="empty-state">尚無常用報價項目</div></td></tr>`;
  refreshCatalogPicker();
}

/* ------------------------- Quotation form ------------------------- */
function projectOptions(current = "") {
  return `<option value="">不連結專案</option>${state.projects.map(project => `<option value="${esc(project.id)}" ${project.id === current ? "selected" : ""}>${esc(project.name)}${project.client ? `｜${esc(project.client)}` : ""}</option>`).join("")}`;
}

function refreshProjectOptions() {
  const select = $("#quotationProjectId");
  if (!select) return;
  const current = select.value;
  select.innerHTML = projectOptions(current);
}

function refreshCustomerOptions() {
  const list = $("#quotationCustomerOptions");
  const idInput = $("#quotationCustomerId");
  const search = $("#quotationCustomerSearch");
  if (!list || !idInput || !search) return;
  list.innerHTML = state.customers.map(customer => `<option value="${esc(customerOptionLabel(customer))}"></option>`).join("");
  const current = state.customers.find(customer => customer.id === idInput.value);
  if (current && !search.matches(":focus")) search.value = customerOptionLabel(current);
}

function customerOptionLabel(customer) {
  return [customer?.name, customer?.contactName, customer?.phone, customer?.email].filter(Boolean).join("｜");
}

function selectedCustomerFromSearch() {
  const query = $("#quotationCustomerSearch")?.value.trim() || "";
  const normalized = query.toLocaleLowerCase("zh-Hant");
  return state.customers.find(customer => customerOptionLabel(customer).toLocaleLowerCase("zh-Hant") === normalized)
    || state.customers.find(customer => String(customer.name || "").toLocaleLowerCase("zh-Hant") === normalized)
    || null;
}

function applyCustomerSearchSelection() {
  const customer = selectedCustomerFromSearch();
  $("#quotationCustomerId").value = customer?.id || "";
  if (!customer) return;
  $("#quotationCustomerName").value = customer.name || "";
  $("#quotationContactName").value = customer.contactName || "";
  $("#quotationPhone").value = customer.phone || "";
  $("#quotationEmail").value = customer.email || "";
  $("#quotationTaxId").value = customer.taxId || "";
}

function refreshCatalogPicker() {
  const items = [...state.quotationItems].sort((a, b) => String(a.category || "未分類").localeCompare(String(b.category || "未分類"), "zh-Hant", { numeric: true, sensitivity: "base" }) || String(a.name || "").localeCompare(String(b.name || ""), "zh-Hant", { numeric: true, sensitivity: "base" }));
  const grouped = new Map();
  items.forEach(item => {
    const category = String(item.category || "未分類").trim() || "未分類";
    if (!grouped.has(category)) grouped.set(category, []);
    grouped.get(category).push(item);
  });
  const groups = [...grouped.entries()].map(([category, entries]) => `<optgroup label="${esc(category)}">${entries.map(item => {
    const equipmentName = quoteItemEquipmentName(item);
    return `<option value="${esc(item.id)}">${esc(item.name)}${equipmentName ? `｜設備：${esc(equipmentName)}` : ""}</option>`;
  }).join("")}</optgroup>`).join("");
  const pickers = [
    ["#quotationCatalogPicker", "從常用項目新增…"],
    ["#quotationAdditionCatalogPicker", "從常用項目追加…"],
    ["#quotationReductionCatalogPicker", "從常用項目減項…"]
  ];
  pickers.forEach(([selector, label]) => {
    const select = $(selector);
    if (select) select.innerHTML = `<option value="">${label}</option>${groups}`;
  });
}

function suggestedNumber(dateISO) {
  const normalized = normalizedDateTokens(dateISO)[0] || new Date().toISOString().slice(0, 10);
  const raw = normalized.replaceAll("-", "").slice(2);
  const prefix = `Y${raw}`;
  const used = state.quotations.map(q => q.number || "").filter(number => number.startsWith(prefix));
  const max = used.reduce((value, number) => Math.max(value, Number(number.slice(prefix.length, prefix.length + 2)) || 0), 0);
  return `${prefix}${String(max + 1).padStart(2, "0")}`;
}

function blankEvent(source = {}) {
  return { id: uid(), name: source.name || "場次 1", location: source.location || "", eventDate: source.eventDate || "", setupDate: source.setupDate || "" };
}

function addEventRow(event = {}) {
  const row = document.createElement("div");
  row.className = "quote-event-row";
  row.dataset.eventId = event.id || uid();
  row.innerHTML = `
    <label><span>場次名稱</span><input class="input event-name" value="${esc(event.name || `場次 ${$("#quotationEvents").children.length + 1}`)}" /></label>
    <label><span>地點</span><input class="input event-location" value="${esc(event.location || "")}" /></label>
    <label><span>活動日期</span><input class="input event-date" value="${esc(event.eventDate || "")}" placeholder="例如：2026/11/03 或 11/3–11/5" /></label>
    <label><span>進／撤場日期</span><input class="input event-setup" value="${esc(event.setupDate || "")}" placeholder="例如：2026/11/02–11/05" /></label>
    <button class="remove-equip-row remove-event" type="button" title="移除場次">✕</button>`;
  $("#quotationEvents").appendChild(row);
  refreshRowEventOptions();
}

function readEvents() {
  return $$(".quote-event-row", $("#quotationEvents")).map(row => ({
    id: row.dataset.eventId,
    name: $(".event-name", row).value.trim(),
    location: $(".event-location", row).value.trim(),
    eventDate: $(".event-date", row).value.trim(),
    setupDate: $(".event-setup", row).value.trim()
  }));
}

function eventOptionHtml(selected = "shared") {
  return `<option value="shared" ${selected === "shared" ? "selected" : ""}>共用</option>${readEvents().map(event => `<option value="${esc(event.id)}" ${selected === event.id ? "selected" : ""}>${esc(event.name || "未命名場次")}</option>`).join("")}`;
}

function refreshRowEventOptions() {
  $$(".row-event", $("#quotationForm")).forEach(select => {
    const current = select.value;
    select.innerHTML = eventOptionHtml(current);
    if (![...select.options].some(option => option.value === current)) select.value = "shared";
  });
}

function rowDataFromCatalog(item = {}, adjustmentType = "addition") {
  const equipment = linkedEquipment(item);
  return {
    id: uid(), eventId: "shared", adjustmentType, category: item.category || "", name: item.name || "",
    unitPrice: item.unitPrice || 0, qty: 1, unit: item.unit || "", days: 1,
    calcMode: item.calcMode || "auto50", continuationRate: item.continuationRate ?? 50,
    manualSubtotal: item.calcMode === "manual" ? 0 : "", note: item.note || "",
    applyPricingToPdf: typeof item.applyPricingToPdf === "boolean" ? item.applyPricingToPdf : Boolean(item.equipmentId || item.equipmentName),
    catalogItemId: item.id || "", equipmentId: item.equipmentId || "", equipmentName: equipment?.name || item.equipmentName || ""
  };
}

function quotationRowHost(adjustmentType = "addition") {
  if (!isChangeOrder()) return $("#quotationRows");
  return adjustmentType === "reduction" ? $("#quotationReductionRows") : $("#quotationAdditionRows");
}

function quotationLineRows() {
  return $$(".quotation-line", $("#quotationForm"));
}

function addQuotationRow(data = {}, adjustmentType = data.adjustmentType || "addition") {
  const row = document.createElement("tr");
  row.className = "quotation-line";
  row.dataset.rowId = data.id || uid();
  row.dataset.catalogItemId = data.catalogItemId || "";
  row.dataset.equipmentId = data.equipmentId || "";
  row.dataset.equipmentName = data.equipmentName || "";
  row.dataset.adjustmentType = adjustmentType === "reduction" ? "reduction" : "addition";
  const mode = data.calcMode || "auto50";
  const applyPricingToPdf = typeof data.applyPricingToPdf === "boolean" ? data.applyPricingToPdf : Boolean(data.equipmentId || data.equipmentName);
  const rowSnapshot = { ...data, calcMode: mode, applyPricingToPdf };
  const originalSubtotal = calcOriginalRowSubtotal(rowSnapshot);
  const pdfSubtotal = calcPdfRowSubtotal(rowSnapshot);
  const hasStoredDealSubtotal = data.dealSubtotal !== undefined && data.dealSubtotal !== null && String(data.dealSubtotal).trim() !== "";
  row.dataset.dealSubtotalMode = data.dealSubtotalMode || (hasStoredDealSubtotal ? "manual" : "auto");
  const dealSubtotal = hasStoredDealSubtotal ? integerValue(data.dealSubtotal) : pdfSubtotal;
  row.innerHTML = `
    <td><select class="select row-event">${eventOptionHtml(data.eventId || "shared")}</select></td>
    <td><div class="quote-row-title"><input class="input row-category" value="${esc(data.category || "")}" placeholder="類別" /><input class="input row-name" value="${esc(data.name || "")}" placeholder="項目名稱" /></div></td>
    <td><input class="input row-price" inputmode="numeric" value="${data.unitPrice ? esc(money(data.unitPrice)) : ""}" /></td>
    <td><input class="input row-qty" type="number" min="0" step="0.01" value="${esc(data.qty ?? 1)}" /></td>
    <td><input class="input row-unit" value="${esc(data.unit || "")}" /></td>
    <td><input class="input row-days" type="number" min="1" step="0.5" value="${esc(data.days ?? 1)}" /></td>
    <td><div class="quote-pricing-control"><select class="select row-mode"><option value="auto50" ${mode === "auto50" ? "selected" : ""}>次日起 50%</option><option value="daily" ${mode === "daily" ? "selected" : ""}>每日原價</option><option value="custom" ${mode === "custom" ? "selected" : ""}>自訂比例</option><option value="manual" ${mode === "manual" ? "selected" : ""}>人工小計</option><option value="included" ${mode === "included" ? "selected" : ""}>免費／已含</option></select><label class="quote-pdf-toggle"><input class="row-pdf-pricing" type="checkbox" ${applyPricingToPdf ? "checked" : ""} /><span>套用至 PDF</span></label></div></td>
    <td><input class="input row-rate" type="number" min="0" step="1" value="${esc(data.continuationRate ?? 50)}" /></td>
    <td><div class="quote-subtotal-cell"><input class="input row-subtotal" inputmode="numeric" value="${mode === "included" ? "—" : esc(money(mode === "manual" ? data.manualSubtotal : pdfSubtotal))}" /><small class="row-original-subtotal">${applyPricingToPdf && pdfSubtotal !== originalSubtotal ? `原價 ${esc(money(originalSubtotal))}` : ""}</small></div><input class="row-deal-subtotal" type="hidden" value="${mode === "included" ? "0" : esc(money(dealSubtotal))}" /></td>
    <td><input class="input row-note" value="${esc(data.note || "")}" /></td>
    <td><div class="quote-row-actions"><button class="quote-order-btn move-quote-row-up" type="button" title="上移" aria-label="上移報價項目">↑</button><button class="quote-order-btn move-quote-row-down" type="button" title="下移" aria-label="下移報價項目">↓</button><button class="remove-equip-row remove-quote-row" type="button" title="移除明細">✕</button></div></td>`;
  quotationRowHost(row.dataset.adjustmentType)?.appendChild(row);
  syncLineMode(row);
  recalcQuotation();
}

function syncLineMode(row) {
  const mode = $(".row-mode", row).value;
  const price = $(".row-price", row);
  const qty = $(".row-qty", row);
  const days = $(".row-days", row);
  const rate = $(".row-rate", row);
  const subtotal = $(".row-subtotal", row);
  const originalHint = $(".row-original-subtotal", row);
  const dealSubtotal = $(".row-deal-subtotal", row);
  const pdfToggle = $(".row-pdf-pricing", row);
  const manual = mode === "manual";
  const included = mode === "included";
  if (manual) pdfToggle.checked = true;
  if (included) pdfToggle.checked = false;
  price.disabled = included;
  qty.disabled = false;
  days.disabled = manual || included;
  rate.disabled = !["custom"].includes(mode);
  pdfToggle.disabled = manual || included;
  subtotal.readOnly = !manual;
  const current = readRow(row);
  const originalSubtotal = calcOriginalRowSubtotal(current);
  const pdfSubtotal = calcPdfRowSubtotal(current);
  if (included) subtotal.value = "—";
  else if (!manual) subtotal.value = money(pdfSubtotal);
  originalHint.textContent = !included && current.applyPricingToPdf && pdfSubtotal !== originalSubtotal ? `原價 ${money(originalSubtotal)}` : "";
  if (included) {
    dealSubtotal.value = "0";
    row.dataset.dealSubtotalMode = "auto";
  } else if (row.dataset.dealSubtotalMode !== "manual") {
    dealSubtotal.value = money(calcPdfRowSubtotal(readRow(row)));
  }
}

function readRow(row) {
  const mode = $(".row-mode", row).value;
  return {
    id: row.dataset.rowId,
    eventId: $(".row-event", row).value,
    category: $(".row-category", row).value.trim(),
    name: $(".row-name", row).value.trim(),
    unitPrice: integerValue($(".row-price", row).value),
    qty: numberValue($(".row-qty", row).value),
    unit: $(".row-unit", row).value.trim(),
    days: numberValue($(".row-days", row).value) || 1,
    calcMode: mode,
    continuationRate: numberValue($(".row-rate", row).value),
    manualSubtotal: mode === "manual" ? integerValue($(".row-subtotal", row).value) : 0,
    applyPricingToPdf: $(".row-pdf-pricing", row).checked,
    dealSubtotal: mode === "included" ? 0 : integerValue($(".row-deal-subtotal", row).value),
    dealSubtotalMode: row.dataset.dealSubtotalMode === "manual" ? "manual" : "auto",
    adjustmentType: row.dataset.adjustmentType === "reduction" ? "reduction" : "addition",
    note: $(".row-note", row).value.trim(),
    catalogItemId: row.dataset.catalogItemId || "",
    equipmentId: row.dataset.equipmentId || "",
    equipmentName: row.dataset.equipmentName || ""
  };
}

function readRows() { return quotationLineRows().map(readRow).filter(row => row.name || row.category); }

function recalcQuotation() {
  quotationLineRows().forEach(row => {
    const mode = $(".row-mode", row).value;
    const rowData = readRow(row);
    const originalSubtotal = calcOriginalRowSubtotal(rowData);
    const pdfSubtotal = calcPdfRowSubtotal(rowData);
    if (mode === "included") $(".row-subtotal", row).value = "—";
    else if (mode !== "manual") $(".row-subtotal", row).value = money(pdfSubtotal);
    $(".row-original-subtotal", row).textContent = mode !== "included" && rowData.applyPricingToPdf && pdfSubtotal !== originalSubtotal ? `原價 ${money(originalSubtotal)}` : "";
    if (mode === "included") $(".row-deal-subtotal", row).value = "0";
    else if (row.dataset.dealSubtotalMode !== "manual") $(".row-deal-subtotal", row).value = money(calcPdfRowSubtotal(readRow(row)));
  });
  const totals = calcTotals(readRows(), $("#quotationProjectPrice").value, state.quotationProjectPriceCustomized);
  if (!state.quotationProjectPriceCustomized) $("#quotationProjectPrice").value = isChangeOrder() ? signedMoney(totals.calculatedProjectPriceTaxed) : money(totals.calculatedProjectPriceTaxed);
  $("#quotationSubtotal").textContent = isChangeOrder() ? signedMoney(totals.subtotal, { plus: true }) : money(totals.subtotal);
  $("#quotationCalculatedPrice").textContent = isChangeOrder() ? signedMoney(totals.calculatedProjectPriceTaxed, { plus: true }) : money(totals.calculatedProjectPriceTaxed);
  if ($("#quotationAdditionSubtotal")) $("#quotationAdditionSubtotal").textContent = money(totals.additionSubtotal);
  if ($("#quotationReductionSubtotal")) $("#quotationReductionSubtotal").textContent = money(totals.reductionSubtotal);
  updateChangeOrderImpact(totals);
  syncProjectPricePdfVisibility(totals);
  updateAllocationStatus(totals);
  return totals;
}

function syncProjectPricePdfVisibility(totals) {
  const toggle = $("#quotationShowProjectPriceOnPdf");
  if (!toggle || state.quotationProjectPricePdfVisibilityCustomized) return;
  toggle.checked = Math.abs(integerValue(totals.projectPriceTaxed) - integerValue(totals.originalTotal)) > 1;
}

function allocationStatus(totals) {
  const difference = integerValue(Math.abs(totals.allocationDifference));
  if (difference <= 1) return { text: "分配完成", tone: "complete" };
  return totals.allocationDifference > 0
    ? { text: `尚有 ${money(difference)} 未分配`, tone: "pending" }
    : { text: `已超出 ${money(difference)}`, tone: "over" };
}

function setAllocationStatus(element, status) {
  if (!element) return;
  element.textContent = status.text;
  element.classList.remove("complete", "pending", "over");
  element.classList.add(status.tone);
}

function updateAllocationStatus(totals) {
  const status = allocationStatus(totals);
  setAllocationStatus($("#quotationAllocationStatus"), status);
  setAllocationStatus($("#quotationAllocationModalStatus"), status);
  if ($("#quotationAllocationTarget")) $("#quotationAllocationTarget").textContent = money(totals.projectPriceUntaxed);
  if ($("#quotationAllocationTotal")) $("#quotationAllocationTotal").textContent = money(totals.dealSubtotal);
}

function renderAllocationRows() {
  const body = $("#quotationAllocationRows");
  if (!body) return;
  const rows = quotationLineRows();
  body.innerHTML = rows.length ? rows.map(row => {
    const data = readRow(row);
    const included = data.calcMode === "included";
    const quoteSubtotal = calcPdfRowSubtotal(data);
    const internalSubtotal = calcDealSubtotal(data);
    const rate = quoteSubtotal ? (internalSubtotal / quoteSubtotal) * 100 : 0;
    return `<tr><td><b>${esc(data.name || "未命名項目")}</b>${isChangeOrder() ? `<span class="badge ${data.adjustmentType === "reduction" ? "red" : "green"}">${data.adjustmentType === "reduction" ? "減項" : "追加"}</span>` : ""}<div class="table-sub">${esc(data.category || "未分類")}</div></td><td class="num">${included ? "—" : money(quoteSubtotal)}</td><td><input class="input allocation-rate-input" type="number" min="0" step="0.01" data-allocation-rate-row="${esc(data.id)}" value="${included ? "—" : esc(percentage(rate))}" ${included || !quoteSubtotal ? "disabled" : ""} /></td><td><input class="input allocation-input" inputmode="numeric" data-allocation-row="${esc(data.id)}" value="${included ? "—" : esc(money(internalSubtotal))}" ${included ? "disabled" : ""} /></td></tr>`;
  }).join("") : `<tr><td colspan="4"><div class="empty-state">尚無報價項目</div></td></tr>`;
  updateAllocationStatus(calcTotals(readRows(), $("#quotationProjectPrice").value, state.quotationProjectPriceCustomized));
}

function openAllocationModal() {
  recalcQuotation();
  renderAllocationRows();
  $("#quotationAllocationModal")?.classList.remove("hidden");
}

function closeAllocationModal() {
  $("#quotationAllocationModal")?.classList.add("hidden");
}

function quotationRowById(id) {
  return quotationLineRows().find(row => row.dataset.rowId === id) || null;
}

function projectBaseAmounts(project) {
  const currentTaxed = integerValue(project?.quote);
  const storedNetTaxed = signedIntegerValue(project?.changeOrderNetTaxed);
  const baseTaxed = project?.baseQuoteTaxed !== undefined
    ? integerValue(project.baseQuoteTaxed)
    : Math.max(0, currentTaxed - storedNetTaxed);
  const baseUntaxed = project?.baseQuoteUntaxed !== undefined
    ? integerValue(project.baseQuoteUntaxed)
    : baseTaxed ? Math.round(baseTaxed / (1 + TAX_RATE)) : integerValue(project?.revenue);
  return { baseTaxed, baseUntaxed };
}

function projectContractSummary(project, { override = null, excludeSeriesId = "", excludeQuotationId = "" } = {}) {
  const base = projectBaseAmounts(project);
  const ordersBySeries = new Map();
  latestConfirmedChangeOrders(state.quotations.filter(quotation => quotation.id !== excludeQuotationId), project?.id).forEach(quotation => {
    const key = quotation.seriesId || quotation.id;
    if (key !== excludeSeriesId) ordersBySeries.set(key, quotation);
  });
  if (override?.status === "confirmed") {
    const key = override.seriesId || override.id;
    if (key !== excludeSeriesId) ordersBySeries.set(key, override);
  }
  const orders = [...ordersBySeries.values()];
  const additionTaxed = orders.reduce((sum, quotation) => sum + Math.max(0, signedQuotationAmount(quotation, "adjustmentTotalTaxed") || signedQuotationAmount(quotation, "projectPriceTaxed")), 0);
  const reductionTaxed = orders.reduce((sum, quotation) => sum + Math.max(0, -(signedQuotationAmount(quotation, "adjustmentTotalTaxed") || signedQuotationAmount(quotation, "projectPriceTaxed"))), 0);
  const netTaxed = additionTaxed - reductionTaxed;
  const netUntaxed = orders.reduce((sum, quotation) => sum + (signedQuotationAmount(quotation, "adjustmentTotalUntaxed") || signedQuotationAmount(quotation, "projectPriceUntaxed")), 0);
  return {
    ...base,
    orders,
    additionTaxed,
    reductionTaxed,
    netTaxed,
    netUntaxed,
    totalTaxed: Math.max(0, base.baseTaxed + netTaxed),
    totalUntaxed: Math.max(0, base.baseUntaxed + netUntaxed)
  };
}

function changeOrderImpact(totals = calcTotals(readRows(), $("#quotationProjectPrice")?.value, state.quotationProjectPriceCustomized)) {
  const project = state.projects.find(item => item.id === $("#quotationProjectId")?.value);
  if (!project) return { project: null, beforeTaxed: 0, adjustmentTaxed: totals.adjustmentTotalTaxed || 0, afterTaxed: totals.adjustmentTotalTaxed || 0 };
  const seriesId = $("#quotationSeriesId")?.value || "";
  const before = projectContractSummary(project, { excludeSeriesId: seriesId });
  return {
    project,
    beforeTaxed: before.totalTaxed,
    adjustmentTaxed: signedIntegerValue(totals.adjustmentTotalTaxed),
    afterTaxed: before.totalTaxed + signedIntegerValue(totals.adjustmentTotalTaxed)
  };
}

function updateChangeOrderImpact(totals) {
  const host = $("#quotationChangeOrderImpact");
  if (!host) return;
  host.classList.toggle("hidden", !isChangeOrder());
  if (!isChangeOrder()) return;
  const impact = changeOrderImpact(totals);
  $("#quotationPriceBefore").textContent = money(impact.beforeTaxed);
  $("#quotationPriceAfter").textContent = signedMoney(impact.afterTaxed);
  $("#quotationPriceAfter").classList.toggle("negative-value", impact.afterTaxed < 0);
}

function projectBillingCommitments(projectId) {
  const payments = state.payments.filter(payment => payment.projectId === projectId && !payment.voided);
  const paymentIds = new Set(payments.map(payment => payment.id));
  const invoiced = payments.filter(payment => payment.requestDate).reduce((sum, payment) => sum + integerValue(payment.amount), 0);
  const actualReceipts = state.receipts.filter(receipt => !receipt.voided && (receipt.projectId === projectId || paymentIds.has(receipt.paymentId)));
  const receiptsByPayment = new Map();
  actualReceipts.forEach(receipt => {
    if (!receipt.paymentId || !paymentIds.has(receipt.paymentId)) return;
    receiptsByPayment.set(receipt.paymentId, (receiptsByPayment.get(receipt.paymentId) || 0) + integerValue(receipt.amount));
  });
  const paymentReceived = payments.reduce((sum, payment) => sum + (
    receiptsByPayment.has(payment.id)
      ? receiptsByPayment.get(payment.id)
      : integerValue(payment.receivedAmount)
  ), 0);
  const directReceived = actualReceipts
    .filter(receipt => !receipt.paymentId || !paymentIds.has(receipt.paymentId))
    .reduce((sum, receipt) => sum + integerValue(receipt.amount), 0);
  const received = paymentReceived + directReceived;
  return { invoiced, received, minimumTotal: Math.max(invoiced, received) };
}

function syncQuotationKindUi() {
  const changeOrder = isChangeOrder();
  $("#quotationStandardLines")?.classList.toggle("hidden", changeOrder);
  $("#quotationChangeOrderLines")?.classList.toggle("hidden", !changeOrder);
  if ($("#quotationSubtotalLabel")) $("#quotationSubtotalLabel").textContent = changeOrder ? "本次未稅淨額" : "報價未稅合計";
  if ($("#quotationCalculatedPriceLabel")) $("#quotationCalculatedPriceLabel").textContent = changeOrder ? "本次含稅淨額" : "系統計算含稅價";
  if ($("#quotationProjectPriceLabel")) $("#quotationProjectPriceLabel").textContent = changeOrder ? "本次追加減（含稅）" : "專案價（含稅）";
  $("#quotationProjectPricePdfToggle")?.classList.toggle("hidden", changeOrder);
  if (changeOrder && $("#quotationShowProjectPriceOnPdf")) $("#quotationShowProjectPriceOnPdf").checked = true;
}

function resetQuotationForm(quotation = null, options = {}) {
  const project = options.project || null;
  const quotationKind = quotation?.quotationKind === "change_order" || options.changeOrder ? "change_order" : "standard";
  const isNewVersion = Boolean(options.newVersion);
  const version = quotation ? (isNewVersion ? maxVersion(quotation.seriesId || quotation.id) + 1 : Number(quotation.version || 1)) : 1;
  $("#quotationId").value = quotation && !isNewVersion ? quotation.id : "";
  $("#quotationSeriesId").value = quotation?.seriesId || "";
  $("#quotationVersion").value = version;
  $("#quotationVersionLabel").textContent = `V${version}`;
  $("#quotationDrawerTitle").textContent = quotation
    ? (isNewVersion ? `複製為 V${version}` : `編輯${quotationKind === "change_order" ? "追加減" : ""}報價 V${version}`)
    : quotationKind === "change_order" ? "新增追加減報價" : "新增報價";
  refreshProjectOptions();
  refreshCustomerOptions();
  refreshCatalogPicker();
  $("#quotationProjectId").value = project?.id || quotation?.projectId || "";
  $("#quotationKind").value = quotationKind;
  $("#quotationKind").disabled = Boolean(quotation);
  $("#quotationCustomerId").value = quotation?.customerId || "";
  const selectedCustomer = state.customers.find(customer => customer.id === (quotation?.customerId || ""));
  $("#quotationCustomerSearch").value = selectedCustomer ? customerOptionLabel(selectedCustomer) : "";
  const firstDate = quotationKind === "change_order"
    ? new Date().toISOString().slice(0, 10)
    : project?.startDate || quotation?.events?.[0]?.eventDate || new Date().toISOString().slice(0, 10);
  $("#quotationNumber").value = quotation?.number || suggestedNumber(firstDate);
  state.numberWasSuggested = !quotation;
  $("#quotationStatus").value = isNewVersion ? "draft" : quotation?.status || "draft";
  $("#quotationCustomerName").value = quotation?.customerName || project?.client || "";
  $("#quotationProjectName").value = quotation?.projectName || project?.name || "";
  $("#quotationContactName").value = quotation?.contactName || "";
  $("#quotationPhone").value = quotation?.phone || "";
  $("#quotationEmail").value = quotation?.email || "";
  $("#quotationTaxId").value = quotation?.taxId || "";
  $("#quotationTerms").value = quotation?.terms || DEFAULT_TERMS;
  $("#quotationNote").value = quotation?.note || "";
  state.quotationProjectPriceCustomized = Boolean(quotation) && quotation?.projectPriceMode !== "auto";
  state.quotationProjectPricePdfVisibilityCustomized = Boolean(quotation);
  $("#quotationShowProjectPriceOnPdf").checked = quotation
    ? (typeof quotation.showProjectPriceOnPdf === "boolean" ? quotation.showProjectPriceOnPdf : true)
    : false;
  $("#quotationHideEventColumnOnPdf").checked = quotation?.hideEventColumnOnPdf === true;
  $("#quotationProjectPrice").value = quotation?.projectPriceTaxed
    ? (quotationKind === "change_order" ? signedMoney(quotation.projectPriceTaxed) : money(quotation.projectPriceTaxed))
    : "";
  $("#quotationEvents").innerHTML = "";
  const events = quotation?.events?.length ? quotation.events : [blankEvent({ name: "場次 1", location: project?.location || "", eventDate: project?.startDate || "", setupDate: project?.startDate && project?.endDate ? `${project.startDate}–${project.endDate}` : "" })];
  events.forEach(addEventRow);
  $("#quotationRows").innerHTML = "";
  $("#quotationAdditionRows").innerHTML = "";
  $("#quotationReductionRows").innerHTML = "";
  syncQuotationKindUi();
  const rows = quotation?.rows?.length ? quotation.rows : [];
  rows.forEach(row => addQuotationRow(row, row.adjustmentType || "addition"));
  if (!rows.length) addQuotationRow(rowDataFromCatalog({}, "addition"), "addition");
  recalcQuotation();
  state.quotationFormDirty = false;
}

function maxVersion(seriesId) {
  return Math.max(0, ...state.quotations.filter(q => (q.seriesId || q.id) === seriesId).map(q => Number(q.version) || 1));
}

function maxActiveVersion(seriesId) {
  return Math.max(0, ...state.quotations
    .filter(q => (q.seriesId || q.id) === seriesId && q.status !== "void")
    .map(q => Number(q.version) || 1));
}

function openQuotation(quotation = null, options = {}) {
  if ((options.newVersion || !quotation) && !canEdit()) return alert("viewer 僅能預覽與下載報價單");
  if (quotation && !options.newVersion && ["confirmed", "void"].includes(quotation.status)) return previewQuotation(quotation);
  if (quotation && !options.newVersion && Number(quotation.version || 1) < maxActiveVersion(quotation.seriesId || quotation.id)) {
    return previewQuotation(quotation);
  }
  resetQuotationForm(quotation, options);
  openDrawer("#quotationDrawer");
}

function readQuotationForm() {
  const rows = readRows();
  const quotationKind = $("#quotationKind").value === "change_order" ? "change_order" : "standard";
  const totals = calcTotals(rows, $("#quotationProjectPrice").value, state.quotationProjectPriceCustomized, quotationKind);
  const impact = quotationKind === "change_order" ? changeOrderImpact(totals) : null;
  return {
    pricingModel: "layered_v3",
    quotationKind,
    seriesId: $("#quotationSeriesId").value,
    number: $("#quotationNumber").value.trim(),
    version: Number($("#quotationVersion").value) || 1,
    status: $("#quotationStatus").value,
    projectId: $("#quotationProjectId").value,
    customerId: $("#quotationCustomerId").value,
    customerName: $("#quotationCustomerName").value.trim(),
    projectName: $("#quotationProjectName").value.trim(),
    contactName: $("#quotationContactName").value.trim(),
    phone: $("#quotationPhone").value.trim(),
    email: $("#quotationEmail").value.trim(),
    taxId: $("#quotationTaxId").value.trim(),
    showProjectPriceOnPdf: $("#quotationShowProjectPriceOnPdf").checked,
    hideEventColumnOnPdf: $("#quotationHideEventColumnOnPdf").checked,
    events: readEvents(), rows, terms: $("#quotationTerms").value.trim(), note: $("#quotationNote").value.trim(),
    ...(impact ? { projectPriceBeforeTaxed: impact.beforeTaxed, projectPriceAfterTaxed: impact.afterTaxed } : {}),
    ...totals
  };
}

async function saveQuotation() {
  if (!canEdit()) return alert("需要 admin 或 editor 權限");
  const id = $("#quotationId").value;
  const payload = readQuotationForm();
  if (!payload.number) return alert("請填寫報價編號");
  if (!payload.customerName) return alert("請填寫客戶／公司名稱");
  if (!payload.projectName) return alert("請填寫專案名稱");
  if (!payload.rows.some(row => row.name)) return alert("請至少填寫一筆報價項目");
  const linkedProject = state.projects.find(project => project.id === payload.projectId);
  if (payload.quotationKind === "change_order" && !linkedProject) return alert("追加減報價必須連結既有專案");
  if (payload.quotationKind === "change_order" && !integerValue(linkedProject?.quote)) return alert("此專案尚未建立原始專案價，請先確認並同步一般報價後，再建立追加減報價");
  if (payload.quotationKind === "change_order" && !signedIntegerValue(payload.adjustmentTotalTaxed)) return alert("本次追加與減項互相抵銷為 0，請確認明細後再儲存");
  const duplicate = state.quotations.find(q => q.number === payload.number && Number(q.version || 1) === payload.version && q.id !== id);
  if (duplicate) return alert(`系統內已有 ${payload.number} / V${payload.version}，請修改編號或建立其他版本`);
  const existing = id ? state.quotations.find(q => q.id === id) : null;
  const isNewConfirmation = payload.status === "confirmed" && existing?.status !== "confirmed";
  if (payload.quotationKind === "change_order" && isNewConfirmation) {
    const billing = projectBillingCommitments(payload.projectId);
    if (payload.projectPriceAfterTaxed < billing.minimumTotal) {
      return alert(`無法確認這張追加減報價。\n\n調整後專案價：${money(payload.projectPriceAfterTaxed)}\n已請款／已收款最低需保留：${money(billing.minimumTotal)}\n\n請先處理發票折讓或收款沖銷，再確認減項。`);
    }
    const adjustmentText = signedMoney(payload.adjustmentTotalTaxed, { plus: true });
    if (!confirm(`確認這張追加減報價並更新專案金額？\n\n調整前專案價：${money(payload.projectPriceBeforeTaxed)}\n本次追加減：${adjustmentText}\n調整後專案價：${money(payload.projectPriceAfterTaxed)}\n\n確認後會自動更新專案與財務，既有請款及收款紀錄不會被改寫。`)) return;
  }
  try {
    let savedId = id;
    if (id) {
      if (existing && Number(existing.version || 1) < maxActiveVersion(existing.seriesId || existing.id)) return alert("舊版本已鎖定，請從目前有效的最新版複製為新版本");
      await updateDoc(doc(db, "quotations", id), {
        ...payload,
        ...(payload.status === "confirmed" && existing?.status !== "confirmed" ? { confirmedAt: serverTimestamp() } : {}),
        updatedAt: serverTimestamp(), updatedBy: state.user.uid
      });
    } else {
      const ref = doc(collections.quotations);
      savedId = ref.id;
      const seriesId = payload.seriesId || ref.id;
      await setDoc(ref, {
        ...payload,
        seriesId,
        ...(payload.status === "confirmed" ? { confirmedAt: serverTimestamp() } : {}),
        createdAt: serverTimestamp(), createdBy: state.user.uid, updatedAt: serverTimestamp(), updatedBy: state.user.uid
      });
    }
    await logAction({ action: id ? "update" : "create", module: "quotations", targetType: "quotation", targetId: savedId, targetName: `${payload.number} / V${payload.version}`, summary: `${payload.customerName}｜${payload.projectName}｜${payload.quotationKind === "change_order" ? `追加減 ${signedMoney(payload.adjustmentTotalTaxed, { plus: true })}` : `專案價 ${money(payload.projectPriceTaxed)}`} 元｜${statusLabel(payload.status)}` });
    state.quotationFormDirty = false;
    closeQuotationDrawer({ force: true });
    if (payload.status === "confirmed") {
      if (payload.quotationKind === "change_order") await applyChangeOrderToProject({ ...payload, id: savedId, seriesId: payload.seriesId || savedId }, savedId);
      else await syncConfirmedQuotationToProject(payload, savedId);
    }
  } catch (error) {
    console.error(error);
    alert("報價儲存失敗，請確認 Firestore 規則已加入 quotations 權限");
  }
}

async function syncConfirmedQuotationToProject(quotation, quotationId) {
  if (quotation.status !== "confirmed") return;
  if (quotation.projectId) {
    const shouldWrite = confirm(`報價已儲存為「已確認」。\n\n是否將專案價 ${money(quotation.projectPriceTaxed)} 元（含稅）回寫到連結專案？\n\n選擇「取消」只會儲存報價，不會修改原專案。`);
    if (shouldWrite) await writeBackProject(quotation, quotationId);
    return;
  }

  const shouldCreate = confirm(`報價已儲存為「已確認」，但尚未連結專案。\n\n是否現在以「${quotation.projectName}」建立專案，並帶入專案價 ${money(quotation.projectPriceTaxed)} 元（含稅）？\n\n選擇「取消」只會保留報價，之後仍可從報價列表建立。`);
  if (shouldCreate) await createProjectFromQuotation(quotation, quotationId);
}

async function applyChangeOrderToProject(quotation, quotationId, { silent = false } = {}) {
  if (quotation.quotationKind !== "change_order" || quotation.status !== "confirmed" || !quotation.projectId) return;
  if (!canEditProject()) return alert("追加減報價已確認，但你沒有編輯專案的權限，因此尚未更新專案總價。");
  const project = state.projects.find(item => item.id === quotation.projectId);
  if (!project) return alert("找不到追加減報價所連結的專案");
  const override = { ...quotation, id: quotationId, seriesId: quotation.seriesId || quotationId };
  const summary = projectContractSummary(project, { override });
  const billing = projectBillingCommitments(project.id);
  if (summary.totalTaxed < billing.minimumTotal) {
    return alert(`無法套用這張追加減報價。\n\n調整後專案價：${money(summary.totalTaxed)}\n已請款／已收款最低需保留：${money(billing.minimumTotal)}\n\n請先處理發票折讓或收款沖銷。`);
  }
  try {
    await updateDoc(doc(db, "projects", project.id), {
      baseQuoteTaxed: summary.baseTaxed,
      baseQuoteUntaxed: summary.baseUntaxed,
      changeOrderAdditionTaxed: summary.additionTaxed,
      changeOrderReductionTaxed: summary.reductionTaxed,
      changeOrderNetTaxed: summary.netTaxed,
      changeOrderNetUntaxed: summary.netUntaxed,
      changeOrderCount: summary.orders.length,
      quote: summary.totalTaxed,
      quoteTaxMode: "taxed",
      revenue: summary.totalUntaxed,
      lastChangeOrderId: quotationId,
      lastChangeOrderNumber: quotation.number || "",
      updatedAt: serverTimestamp(),
      updatedBy: state.user?.uid || ""
    });
    await logAction({ action: "sync", module: "quotations", targetType: "project", targetId: project.id, targetName: project.name || quotation.projectName || quotation.number, summary: `追加減 ${quotation.number}｜${signedMoney(quotation.adjustmentTotalTaxed || quotation.projectPriceTaxed, { plus: true })}｜專案總價更新為 ${money(summary.totalTaxed)} 元` });
    if (!silent) alert(`追加減已套用。\n\n目前專案總價：${money(summary.totalTaxed)} 元（含稅）`);
  } catch (error) {
    console.error(error);
    alert("追加減報價已儲存，但專案總價更新失敗；請稍後從報價列表按「重新計算專案價」。");
  }
}

async function voidChangeOrder(quotation) {
  if (!canEdit()) return alert("你目前沒有管理報價的權限");
  if (quotation.status !== "confirmed") {
    if (!confirm(`確定將追加減報價 ${quotation.number} / V${quotation.version || 1} 標記為作廢？`)) return;
    await updateDoc(doc(db, "quotations", quotation.id), { status: "void", updatedAt: serverTimestamp(), updatedBy: state.user.uid });
    await logAction({ action: "void", module: "quotations", targetType: "quotation", targetId: quotation.id, targetName: `${quotation.number} / V${quotation.version || 1}`, summary: `${quotation.customerName || ""}｜${quotation.projectName || ""}` });
    return;
  }
  const project = state.projects.find(item => item.id === quotation.projectId);
  if (!project) return alert("找不到這張追加減所連結的專案，無法安全作廢");
  const summary = projectContractSummary(project, { excludeQuotationId: quotation.id });
  const billing = projectBillingCommitments(project.id);
  if (summary.totalTaxed < billing.minimumTotal) {
    return alert(`作廢後專案價將變成 ${money(summary.totalTaxed)} 元，低於已請款／已收款 ${money(billing.minimumTotal)} 元。\n\n請先處理發票折讓或收款沖銷。`);
  }
  if (!confirm(`確定作廢這張已確認追加減？\n\n目前專案價：${money(integerValue(project.quote))}\n作廢後專案價：${money(summary.totalTaxed)}\n\n既有請款及收款紀錄不會被修改。`)) return;
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, "quotations", quotation.id), { status: "void", updatedAt: serverTimestamp(), updatedBy: state.user.uid });
    batch.update(doc(db, "projects", project.id), {
      changeOrderAdditionTaxed: summary.additionTaxed,
      changeOrderReductionTaxed: summary.reductionTaxed,
      changeOrderNetTaxed: summary.netTaxed,
      changeOrderNetUntaxed: summary.netUntaxed,
      changeOrderCount: summary.orders.length,
      quote: summary.totalTaxed,
      quoteTaxMode: "taxed",
      revenue: summary.totalUntaxed,
      updatedAt: serverTimestamp(),
      updatedBy: state.user.uid
    });
    await batch.commit();
    await logAction({ action: "void", module: "quotations", targetType: "changeOrder", targetId: quotation.id, targetName: `${quotation.number} / V${quotation.version || 1}`, summary: `作廢追加減｜專案總價調整為 ${money(summary.totalTaxed)} 元` });
    alert(`追加減已作廢，專案總價已更新為 ${money(summary.totalTaxed)} 元。`);
  } catch (error) {
    console.error(error);
    alert("追加減作廢失敗，本次沒有修改專案金額。");
  }
}

async function writeBackProject(quotation, quotationId) {
  if (!quotation.projectId || quotation.status !== "confirmed") return;
  if (!canEditProject()) return alert("你目前沒有編輯既有專案的權限；報價本身不受影響。");
  try {
    const project = state.projects.find(item => item.id === quotation.projectId);
    const changeOrders = latestConfirmedChangeOrders(state.quotations, quotation.projectId);
    const changeOrderAdditionTaxed = changeOrders.reduce((sum, item) => sum + Math.max(0, signedQuotationAmount(item, "adjustmentTotalTaxed") || signedQuotationAmount(item, "projectPriceTaxed")), 0);
    const changeOrderReductionTaxed = changeOrders.reduce((sum, item) => sum + Math.max(0, -(signedQuotationAmount(item, "adjustmentTotalTaxed") || signedQuotationAmount(item, "projectPriceTaxed"))), 0);
    const changeOrderNetTaxed = changeOrderAdditionTaxed - changeOrderReductionTaxed;
    const changeOrderNetUntaxed = changeOrders.reduce((sum, item) => sum + (signedQuotationAmount(item, "adjustmentTotalUntaxed") || signedQuotationAmount(item, "projectPriceUntaxed")), 0);
    const totalTaxed = integerValue(quotation.projectPriceTaxed) + changeOrderNetTaxed;
    const totalUntaxed = integerValue(quotation.projectPriceUntaxed) + changeOrderNetUntaxed;
    const billing = projectBillingCommitments(quotation.projectId);
    if (totalTaxed < billing.minimumTotal) return alert(`同步後專案價 ${money(totalTaxed)} 元低於已請款／已收款 ${money(billing.minimumTotal)} 元，請先處理折讓或收款沖銷。`);
    await updateDoc(doc(db, "projects", quotation.projectId), {
      baseQuoteTaxed: integerValue(quotation.projectPriceTaxed),
      baseQuoteUntaxed: integerValue(quotation.projectPriceUntaxed),
      changeOrderAdditionTaxed,
      changeOrderReductionTaxed,
      changeOrderNetTaxed,
      changeOrderNetUntaxed,
      changeOrderCount: changeOrders.length,
      quote: totalTaxed,
      quoteTaxMode: "taxed",
      revenue: totalUntaxed,
      confirmedQuotationId: quotationId,
      confirmedQuotationNumber: quotation.number,
      confirmedQuotationVersion: quotation.version,
      confirmedQuotationMonth: quotationMonthFromNumber(quotation.number),
      updatedAt: serverTimestamp()
    });
    await logAction({ action: "sync", module: "quotations", targetType: "project", targetId: quotation.projectId, targetName: quotation.projectName || quotation.number, summary: `由 ${quotation.number} / V${quotation.version || 1} 回寫專案價 ${money(quotation.projectPriceTaxed)} 元` });
    alert(`已更新原始專案價，並保留 ${changeOrders.length} 張已確認追加減；目前專案總價為 ${money(totalTaxed)} 元。`);
  } catch (error) {
    console.error(error);
    alert("報價已儲存，但專案回寫失敗；請確認你有專案編輯權限。");
  }
}

async function createProjectFromQuotation(quotation, quotationId) {
  if (!canCreateProject()) return alert("你目前沒有新增專案的權限；報價本身不受影響。");
  const events = Array.isArray(quotation.events) ? quotation.events : [];
  const eventDates = events.flatMap(event => normalizedDateTokens(event.eventDate)).sort();
  const locations = [...new Set(events.map(event => event.location?.trim()).filter(Boolean))];
  const projectRef = doc(collections.projects);
  const quotationRef = doc(db, "quotations", quotationId);
  const batch = writeBatch(db);
  batch.set(projectRef, {
    name: quotation.projectName,
    client: quotation.customerName || "",
    customerId: quotation.customerId || "",
    location: locations.join("／"),
    startDate: eventDates[0] || "",
    endDate: eventDates[eventDates.length - 1] || eventDates[0] || "",
    status: "planning",
    quote: integerValue(quotation.projectPriceTaxed),
    quoteTaxMode: "taxed",
    revenue: integerValue(quotation.projectPriceUntaxed),
    baseQuoteTaxed: integerValue(quotation.projectPriceTaxed),
    baseQuoteUntaxed: integerValue(quotation.projectPriceUntaxed),
    changeOrderAdditionTaxed: 0,
    changeOrderReductionTaxed: 0,
    changeOrderNetTaxed: 0,
    changeOrderNetUntaxed: 0,
    changeOrderCount: 0,
    cost: 0,
    equipmentsUsed: [],
    note: `由報價 ${quotation.number} / V${quotation.version || 1} 建立；專案狀態、外部支出與使用設備請再確認。`,
    confirmedQuotationId: quotationId,
    confirmedQuotationNumber: quotation.number,
    confirmedQuotationVersion: quotation.version || 1,
    confirmedQuotationMonth: quotationMonthFromNumber(quotation.number),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  batch.update(quotationRef, {
    projectId: projectRef.id,
    projectCreatedFromQuotation: true,
    updatedAt: serverTimestamp(),
    updatedBy: state.user?.uid || ""
  });

  try {
    await batch.commit();
    await logAction({ action: "create", module: "projects", targetType: "project", targetId: projectRef.id, targetName: quotation.projectName, summary: `由報價 ${quotation.number} / V${quotation.version || 1} 建立` });
    alert("已建立專案並完成連結。專案價與未稅營收已帶入；外部支出、設備與專案狀態請再確認。");
  } catch (error) {
    console.error(error);
    alert("報價已儲存，但建立專案失敗；請確認你有新增專案的權限。");
  }
}

function latestBySeries() {
  const map = new Map();
  state.quotations.forEach(q => {
    const key = q.seriesId || q.id;
    const current = map.get(key);
    if (!current || Number(q.version || 1) > Number(current.version || 1)) map.set(key, q);
  });
  return map;
}

function latestActiveBySeries() {
  const map = new Map();
  state.quotations.filter(q => q.status !== "void").forEach(q => {
    const key = q.seriesId || q.id;
    const current = map.get(key);
    if (!current || Number(q.version || 1) > Number(current.version || 1)) map.set(key, q);
  });
  return map;
}

function quotationEventDate(q) {
  const dates = (Array.isArray(q?.events) ? q.events : []).flatMap(event => normalizedDateTokens(event?.eventDate)).sort();
  if (dates[0]) return dates[0];
  const source = q?.quotationDate || q?.createdAt || q?.updatedAt;
  if (!source) return "";
  const date = typeof source.toDate === "function" ? source.toDate() : new Date(source);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function linkedProjectForQuotation(q) {
  return state.projects.find(project => project.id === q?.projectId) || null;
}

function quotationDisplayProjectName(q) {
  if (!q?.projectId) return "未連結專案";
  return linkedProjectForQuotation(q)?.name || "連結專案已不存在";
}

function compareQuotationVersions(a, b) {
  if (a.number === b.number) return Number(b.version || 1) - Number(a.version || 1);
  return String(b.number || "").localeCompare(String(a.number || ""), "zh-Hant", { numeric: true });
}

function sortQuotations(a, b, sortBy) {
  const eventA = quotationEventDate(a);
  const eventB = quotationEventDate(b);
  const nameA = quotationDisplayProjectName(a) === "未連結專案" ? (a.projectName || "") : quotationDisplayProjectName(a);
  const nameB = quotationDisplayProjectName(b) === "未連結專案" ? (b.projectName || "") : quotationDisplayProjectName(b);
  const statusOrder = { draft: 0, sent: 1, confirmed: 2, void: 3 };
  let result = 0;
  if (sortBy === "dateAsc" || sortBy === "dateDesc") {
    if (!eventA && eventB) return 1;
    if (eventA && !eventB) return -1;
    result = String(eventA).localeCompare(String(eventB));
    if (sortBy === "dateDesc") result = -result;
  } else if (sortBy === "nameAsc" || sortBy === "nameDesc") {
    result = String(nameA).localeCompare(String(nameB), "zh-Hant", { numeric: true, sensitivity: "base" });
    if (sortBy === "nameDesc") result = -result;
  } else if (sortBy === "statusAsc" || sortBy === "statusDesc") {
    result = (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99);
    if (sortBy === "statusDesc") result = -result;
  }
  return result || compareQuotationVersions(a, b) || timestampValue(b.updatedAt || b.createdAt) - timestampValue(a.updatedAt || a.createdAt);
}

function renderQuotationProjectScope() {
  const host = $("#quotationProjectScope");
  if (!host) return;
  const project = state.projects.find(item => item.id === state.quotationProjectFilterId);
  if (!project) {
    state.quotationProjectFilterId = "";
    host.classList.add("hidden");
    host.innerHTML = "";
    return;
  }
  host.classList.remove("hidden");
  host.innerHTML = `<span>目前只顯示連結專案：<b>${esc(project.name || "未命名專案")}</b></span><button type="button" data-clear-quotation-project>清除專案篩選 ×</button>`;
}

function renderQuotationPagination(totalItems) {
  const host = $("#quotationPagination");
  if (!host) return;
  const totalPages = Math.max(1, Math.ceil(totalItems / QUOTATIONS_PER_PAGE));
  state.quotationCurrentPage = Math.min(Math.max(1, state.quotationCurrentPage), totalPages);
  if (totalPages <= 1) {
    host.innerHTML = "";
    return;
  }

  const visiblePages = new Set([1, totalPages]);
  for (let page = state.quotationCurrentPage - 2; page <= state.quotationCurrentPage + 2; page += 1) {
    if (page >= 1 && page <= totalPages) visiblePages.add(page);
  }
  const pageButtons = [...visiblePages].sort((a, b) => a - b).map((page, index, pages) => {
    const gap = index > 0 && page - pages[index - 1] > 1 ? `<span class="pagination-ellipsis" aria-hidden="true">…</span>` : "";
    return `${gap}<button class="page-number ${page === state.quotationCurrentPage ? "active" : ""}" type="button" data-page="${page}" ${page === state.quotationCurrentPage ? 'aria-current="page"' : ""}>${page}</button>`;
  }).join("");
  const pageOptions = Array.from({ length: totalPages }, (_, index) => index + 1)
    .map(page => `<option value="${page}" ${page === state.quotationCurrentPage ? "selected" : ""}>${page}</option>`).join("");

  host.innerHTML = `
    <button class="page-direction" type="button" data-page="${state.quotationCurrentPage - 1}" ${state.quotationCurrentPage === 1 ? "disabled" : ""}>上一頁</button>
    <div class="pagination-pages">${pageButtons}</div>
    <span class="pagination-summary">第 ${state.quotationCurrentPage} / ${totalPages} 頁</span>
    <label class="pagination-jump"><span>跳至</span><select data-page-select aria-label="選擇報價頁數">${pageOptions}</select><span>頁</span></label>
    <button class="page-direction" type="button" data-page="${state.quotationCurrentPage + 1}" ${state.quotationCurrentPage === totalPages ? "disabled" : ""}>下一頁</button>`;
}

function renderQuotations() {
  const body = $("#quotationTableBody");
  if (!body) return;
  const keyword = $("#quotationSearch")?.value.trim().toLocaleLowerCase("zh-Hant") || "";
  const month = $("#quotationMonthFilter")?.value || "";
  const kind = $("#quotationKindFilter")?.value || "all";
  const status = $("#quotationStatusFilter")?.value || "all";
  const sortBy = $("#quotationSort")?.value || "dateAsc";
  const latest = latestBySeries();
  const activeLatest = latestActiveBySeries();
  const confirmedBySeries = new Map();
  state.quotations.filter(q => q.status === "confirmed").forEach(q => {
    const key = q.seriesId || q.id;
    const current = confirmedBySeries.get(key);
    if (!current || Number(q.version || 1) > Number(current.version || 1)) confirmedBySeries.set(key, q);
  });
  const filteredList = [...state.quotations].filter(q => {
    if (state.quotationProjectFilterId && q.projectId !== state.quotationProjectFilterId) return false;
    if (kind !== "all" && (q.quotationKind === "change_order" ? "change_order" : "standard") !== kind) return false;
    if (status !== "all" && q.status !== status) return false;
    if (month && !(Array.isArray(q.events) && q.events.some(event => normalizedDateTokens(event?.eventDate).some(date => date.startsWith(month)))) && !quotationEventDate(q).startsWith(month)) return false;
    const linkedName = quotationDisplayProjectName(q);
    return !keyword || [q.number, q.projectName, linkedName, q.customerName, q.contactName, q.phone, q.email]
      .join(" ").toLocaleLowerCase("zh-Hant").includes(keyword);
  }).sort((a, b) => sortQuotations(a, b, sortBy));
  const totalPages = Math.max(1, Math.ceil(filteredList.length / QUOTATIONS_PER_PAGE));
  state.quotationCurrentPage = Math.min(Math.max(1, state.quotationCurrentPage), totalPages);
  const startIndex = (state.quotationCurrentPage - 1) * QUOTATIONS_PER_PAGE;
  const list = filteredList.slice(startIndex, startIndex + QUOTATIONS_PER_PAGE);
  const existingIds = new Set(state.quotations.map(quotation => quotation.id));
  [...state.quotationSelectedIds].forEach(id => {
    const quotation = state.quotations.find(item => item.id === id);
    const isActiveLatest = quotation && activeLatest.get(quotation.seriesId || quotation.id)?.id === quotation.id;
    if (!existingIds.has(id) || !isActiveLatest || quotation?.status === "void") state.quotationSelectedIds.delete(id);
  });
  body.innerHTML = list.length ? list.map(q => {
    const isLatest = latest.get(q.seriesId || q.id)?.id === q.id;
    const isActiveLatest = activeLatest.get(q.seriesId || q.id)?.id === q.id;
    const selectable = canEdit() && isActiveLatest && q.status !== "void";
    return `<tr>
      <td class="batch-checkbox-cell"><input class="batch-checkbox quotation-select" type="checkbox" value="${esc(q.id)}" aria-label="選取報價 ${esc(q.number)} V${esc(q.version || 1)}" ${state.quotationSelectedIds.has(q.id) ? "checked" : ""} ${selectable ? "" : "disabled"} /></td>
      <td><button class="quote-link" type="button" data-quotation-preview="${esc(q.id)}">${esc(q.number)}</button><span class="badge ${q.quotationKind === "change_order" ? "blue" : "neutral"} quotation-kind-badge">${q.quotationKind === "change_order" ? "追加減" : "一般"}</span></td>
      <td><b>${esc(quotationDisplayProjectName(q))}</b><div class="table-sub">${esc(q.customerName || "—")}</div></td>
      <td><span class="badge ${isLatest ? "orange" : "neutral"}">V${esc(q.version || 1)}${isLatest ? " 最新" : ""}</span></td>
      <td class="num"><b>${q.quotationKind === "change_order" ? signedMoney(q.adjustmentTotalTaxed ?? q.projectPriceTaxed, { plus: true }) : money(q.projectPriceTaxed)}</b></td>
      <td><span class="badge ${statusBadge(q.status)}">${esc(statusLabel(q.status))}</span></td>
      <td><b>${esc(dateText(quotationEventDate(q)))}</b><div class="table-sub">更新 ${esc(timestampText(q.updatedAt || q.createdAt))}</div></td>
      <td><div class="row-actions quotation-row-actions">
        <button class="btn ghost small" type="button" data-quotation-preview="${esc(q.id)}">預覽</button>
        <details class="row-action-menu">
          <summary class="btn ghost small">更多</summary>
          <div class="row-action-menu-list">
            <button class="btn ghost small" type="button" data-quotation-edit="${esc(q.id)}" ${canEdit() && isActiveLatest && !["confirmed", "void"].includes(q.status) ? "" : "disabled"}>編輯</button>
            <button class="btn ghost small" type="button" data-quotation-version="${esc(q.id)}" ${canEdit() && isActiveLatest ? "" : "disabled"}>複製新版</button>
            ${q.status === "confirmed" ? `<button class="btn ghost small" type="button" data-quotation-sync="${esc(q.id)}" ${(canEdit() && (q.projectId ? canEditProject() : canCreateProject())) ? "" : "disabled"}>${q.quotationKind === "change_order" ? "重新計算專案價" : q.projectId ? "同步專案金額" : "建立專案"}</button>` : ""}
            <button class="btn ghost small" type="button" data-quotation-void="${esc(q.id)}" ${canEdit() && isActiveLatest && q.status !== "void" ? "" : "disabled"}>作廢</button>
            <button class="btn ghost small danger-text" type="button" data-quotation-delete="${esc(q.id)}" ${canDelete() ? "" : "disabled"}>刪除</button>
          </div>
        </details>
      </div></td>
    </tr>`;
  }).join("") : `<tr><td colspan="8"><div class="empty-state">尚無符合條件的報價</div></td></tr>`;
  updateQuotationBatchUi(list, activeLatest);
  renderQuotationPagination(filteredList.length);
  renderQuotationProjectScope();

  $("#quotationSeriesCount").textContent = String(latest.size);
  $("#quotationOpenCount").textContent = String([...activeLatest.values()].filter(q => q.status === "draft" || q.status === "sent").length);
  $("#quotationConfirmedTotal").textContent = signedMoney([...confirmedBySeries.values()].reduce((sum, q) => sum + (q.quotationKind === "change_order" ? signedIntegerValue(q.adjustmentTotalTaxed ?? q.projectPriceTaxed) : integerValue(q.projectPriceTaxed)), 0));
}

function updateQuotationBatchUi(pageList = [], latest = latestActiveBySeries()) {
  const allowed = canEdit();
  $("#quotationBatchBar")?.classList.toggle("hidden", !allowed);
  const selectedCount = state.quotationSelectedIds.size;
  if ($("#quotationBatchCount")) $("#quotationBatchCount").textContent = `已選 ${selectedCount} 筆`;
  if ($("#quotationBatchStatus")) $("#quotationBatchStatus").disabled = !allowed || !selectedCount;
  if ($("#quotationBatchApply")) $("#quotationBatchApply").disabled = !allowed || !selectedCount || !$("#quotationBatchStatus")?.value;
  if ($("#quotationBatchSyncProjects")) $("#quotationBatchSyncProjects").disabled = !allowed || !canEditProject() || !selectedCount;
  if ($("#quotationBatchClear")) $("#quotationBatchClear").disabled = !allowed || !selectedCount;
  const pageIds = pageList
    .filter(quotation => latest.get(quotation.seriesId || quotation.id)?.id === quotation.id && quotation.status !== "void")
    .map(quotation => quotation.id);
  const selectedOnPage = pageIds.filter(id => state.quotationSelectedIds.has(id)).length;
  const selectAll = $("#quotationSelectAll");
  if (selectAll) {
    selectAll.disabled = !allowed || !pageIds.length;
    selectAll.checked = Boolean(pageIds.length) && selectedOnPage === pageIds.length;
    selectAll.indeterminate = selectedOnPage > 0 && selectedOnPage < pageIds.length;
  }
}

function quotationBatchTransitionAllowed(currentStatus, nextStatus) {
  if (currentStatus === nextStatus) return true;
  if (currentStatus === "void") return false;
  if (currentStatus === "confirmed") return nextStatus === "void";
  return ["draft", "sent"].includes(currentStatus) && ["draft", "sent", "confirmed", "void"].includes(nextStatus);
}

async function applyQuotationBatchStatus() {
  if (!canEdit()) return alert("你目前沒有管理報價的權限");
  const nextStatus = $("#quotationBatchStatus")?.value || "";
  if (!["draft", "sent", "confirmed", "void"].includes(nextStatus)) return alert("請先選擇要套用的報價狀態");
  const latest = latestActiveBySeries();
  const selected = state.quotations.filter(quotation => state.quotationSelectedIds.has(quotation.id));
  const changeOrdersRequiringIndividualAction = selected.filter(quotation => quotation.quotationKind === "change_order"
    && (nextStatus === "confirmed" || quotation.status === "confirmed"));
  if (changeOrdersRequiringIndividualAction.length) {
    return alert("追加減報價的確認或作廢會改變專案總價，請逐筆開啟或作廢，讓系統先顯示調整前後金額並檢查已請款資料。");
  }
  const blocked = selected.filter(quotation => latest.get(quotation.seriesId || quotation.id)?.id !== quotation.id || !quotationBatchTransitionAllowed(quotation.status, nextStatus));
  if (blocked.length) {
    const details = blocked.slice(0, 8)
      .map(quotation => `• ${quotation.number || "未編號"} / V${quotation.version || 1}（${statusLabel(quotation.status)}）`)
      .join("\n");
    return alert(`以下報價為舊版本、已作廢，或不允許從目前狀態改為「${statusLabel(nextStatus)}」，因此本次沒有修改任何資料：\n\n${details}`);
  }
  const changed = selected.filter(quotation => quotation.status !== nextStatus);
  if (!changed.length) return alert("選取的報價目前已經是這個狀態");
  const syncNotice = nextStatus === "confirmed" ? "\n\n這次只會修改報價狀態，不會自動回寫或建立專案。" : "";
  if (!confirm(`確定將 ${changed.length} 筆報價改為「${statusLabel(nextStatus)}」？${syncNotice}`)) return;

  const applyButton = $("#quotationBatchApply");
  if (applyButton) applyButton.disabled = true;
  try {
    for (let offset = 0; offset < changed.length; offset += 400) {
      const batch = writeBatch(db);
      changed.slice(offset, offset + 400).forEach(quotation => {
        batch.update(doc(db, "quotations", quotation.id), {
          status: nextStatus,
          ...(nextStatus === "confirmed" && quotation.status !== "confirmed" ? { confirmedAt: serverTimestamp() } : {}),
          updatedAt: serverTimestamp(),
          updatedBy: state.user.uid
        });
      });
      await batch.commit();
    }
    await logAction({
      action: "batch_update",
      module: "quotations",
      targetType: "quotationBatch",
      targetId: "",
      targetName: `${changed.length} 筆報價`,
      summary: `批次修改狀態為「${statusLabel(nextStatus)}」｜${changed.map(quotation => `${quotation.number || "未編號"} V${quotation.version || 1}`).join("、")}`
    });
    state.quotationSelectedIds.clear();
    if ($("#quotationBatchStatus")) $("#quotationBatchStatus").value = "";
    renderQuotations();
    alert(`已完成 ${changed.length} 筆報價狀態更新。`);
  } catch (error) {
    console.error(error);
    alert("批次更新失敗：請確認報價管理權限與網路狀態");
    renderQuotations();
  }
}

async function syncQuotationBatchToProjects() {
  if (!canEdit() || !canEditProject()) return alert("你目前沒有同時管理報價與編輯專案的權限");
  const latest = latestActiveBySeries();
  const selected = state.quotations.filter(quotation => state.quotationSelectedIds.has(quotation.id));
  if (!selected.length) return alert("請先選擇要同步的報價");
  if (selected.length > 400) return alert("單次最多同步 400 筆報價，請分批操作");
  const blocked = selected.filter(quotation =>
    latest.get(quotation.seriesId || quotation.id)?.id !== quotation.id ||
    quotation.status !== "confirmed" ||
    !quotation.projectId ||
    !state.projects.some(project => project.id === quotation.projectId) ||
    quotation.quotationKind === "change_order"
  );
  const duplicateProjects = [...new Set(selected.map(quotation => quotation.projectId).filter((projectId, index, ids) => projectId && ids.indexOf(projectId) !== index))];
  if (blocked.length || duplicateProjects.length) {
    const blockedText = blocked.slice(0, 8).map(quotation => `• ${quotation.number || "未編號"} / V${quotation.version || 1}`).join("\n");
    const duplicateText = duplicateProjects.slice(0, 8).map(projectId => `• ${state.projects.find(project => project.id === projectId)?.name || projectId}（選到多張報價）`).join("\n");
    return alert(`批次同步必須全部為最新版、已確認、且已連結現有專案的報價；同一專案也只能選一張。本次沒有修改任何資料。${blockedText ? `\n\n不符合：\n${blockedText}` : ""}${duplicateText ? `\n\n重複專案：\n${duplicateText}` : ""}`);
  }
  const pricingByQuotation = new Map(selected.map(quotation => {
    const changeOrders = latestConfirmedChangeOrders(state.quotations, quotation.projectId);
    const additionTaxed = changeOrders.reduce((sum, item) => sum + Math.max(0, signedQuotationAmount(item, "adjustmentTotalTaxed") || signedQuotationAmount(item, "projectPriceTaxed")), 0);
    const reductionTaxed = changeOrders.reduce((sum, item) => sum + Math.max(0, -(signedQuotationAmount(item, "adjustmentTotalTaxed") || signedQuotationAmount(item, "projectPriceTaxed"))), 0);
    const netTaxed = additionTaxed - reductionTaxed;
    const netUntaxed = changeOrders.reduce((sum, item) => sum + (signedQuotationAmount(item, "adjustmentTotalUntaxed") || signedQuotationAmount(item, "projectPriceUntaxed")), 0);
    return [quotation.id, {
      changeOrders,
      additionTaxed,
      reductionTaxed,
      netTaxed,
      netUntaxed,
      totalTaxed: integerValue(quotation.projectPriceTaxed) + netTaxed,
      totalUntaxed: integerValue(quotation.projectPriceUntaxed) + netUntaxed
    }];
  }));
  const belowBillingFloor = selected.filter(quotation => {
    const pricing = pricingByQuotation.get(quotation.id);
    return pricing.totalTaxed < projectBillingCommitments(quotation.projectId).minimumTotal;
  });
  if (belowBillingFloor.length) {
    const details = belowBillingFloor.slice(0, 8).map(quotation => {
      const pricing = pricingByQuotation.get(quotation.id);
      return `• ${quotation.number || "未編號"}：同步後 ${money(pricing.totalTaxed)}，已請款／已收款 ${money(projectBillingCommitments(quotation.projectId).minimumTotal)}`;
    }).join("\n");
    return alert(`以下專案同步後的總價會低於已請款／已收款金額，本次沒有修改任何資料：\n\n${details}\n\n請先處理發票折讓或收款沖銷。`);
  }
  if (!confirm(`確定將 ${selected.length} 筆已確認報價的專案價同步到各自連結的專案？\n\n系統會保留各專案已確認的追加減，再重新計算目前專案總價；不會修改設備、外部支出或專案狀態。`)) return;
  const button = $("#quotationBatchSyncProjects");
  if (button) button.disabled = true;
  try {
    const batch = writeBatch(db);
    selected.forEach(quotation => {
      const pricing = pricingByQuotation.get(quotation.id);
      batch.update(doc(db, "projects", quotation.projectId), {
        baseQuoteTaxed: integerValue(quotation.projectPriceTaxed),
        baseQuoteUntaxed: integerValue(quotation.projectPriceUntaxed),
        changeOrderAdditionTaxed: pricing.additionTaxed,
        changeOrderReductionTaxed: pricing.reductionTaxed,
        changeOrderNetTaxed: pricing.netTaxed,
        changeOrderNetUntaxed: pricing.netUntaxed,
        changeOrderCount: pricing.changeOrders.length,
        quote: pricing.totalTaxed,
        quoteTaxMode: "taxed",
        revenue: pricing.totalUntaxed,
        confirmedQuotationId: quotation.id,
        confirmedQuotationNumber: quotation.number || "",
        confirmedQuotationVersion: Number(quotation.version || 1),
        confirmedQuotationMonth: quotationMonthFromNumber(quotation.number),
        updatedAt: serverTimestamp(),
        updatedBy: state.user.uid
      });
    });
    await batch.commit();
    await logAction({
      action: "batch_sync",
      module: "quotations",
      targetType: "projectBatch",
      targetId: "",
      targetName: `${selected.length} 個專案`,
      summary: `批次同步專案金額｜${selected.map(quotation => `${quotation.number || "未編號"} V${quotation.version || 1}`).join("、")}`
    });
    state.quotationSelectedIds.clear();
    renderQuotations();
    alert(`已完成 ${selected.length} 筆報價的專案金額同步。`);
  } catch (error) {
    console.error(error);
    alert("批次同步失敗：本次沒有完成同步，請確認專案編輯權限與網路狀態");
    renderQuotations();
  }
}

/* ------------------------- Preview and print ------------------------- */
function previewDataFromForm() {
  const data = readQuotationForm();
  return { ...data, id: $("#quotationId").value || "preview" };
}

function previewQuotation(quotation) {
  state.previewData = quotation;
  $("#quotationPreviewBody").innerHTML = buildA4(quotation);
  $("#quotationPreviewModal").classList.remove("hidden");
}

function quotationDateText(q) {
  const source = q.quotationDate || q.createdAt || new Date();
  const date = typeof source?.toDate === "function" ? source.toDate() : new Date(source);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

function buildA4(q) {
  const events = Array.isArray(q.events) ? q.events : [];
  const eventMap = new Map(events.map(event => [event.id, event.name]));
  const rows = Array.isArray(q.rows) ? q.rows : [];
  const changeOrder = q.quotationKind === "change_order";
  const usesPdfPricing = q.pricingModel === "layered_v3";
  const usesLayeredPricing = q.pricingModel === "layered_v2" || q.dealSubtotal !== undefined || rows.some(row => row?.dealSubtotal !== undefined);
  const showEventColumn = events.length > 1 && q.hideEventColumnOnPdf !== true;
  const renderLine = (row, index) => {
    const included = row.calcMode === "included";
    const eventCell = showEventColumn ? `<td>${esc(row.eventId === "shared" ? "共用" : eventMap.get(row.eventId) || "—")}</td>` : "";
    const visibleSubtotal = usesPdfPricing ? calcPdfRowSubtotal(row) : usesLayeredPricing ? calcOriginalRowSubtotal(row) : calcRowSubtotal(row);
    const signedSubtotal = changeOrder && row.adjustmentType === "reduction" ? -visibleSubtotal : visibleSubtotal;
    return `<tr><td>${index + 1}</td>${eventCell}<td>${esc(row.name)}</td><td class="num">${included ? "—" : money(row.unitPrice)}</td><td class="num">${esc(row.qty)}</td><td>${esc(row.unit || "—")}</td><td class="num">${included ? "—" : esc(row.days || 1)}</td><td class="num">${included ? "—" : changeOrder ? signedMoney(signedSubtotal, { plus: row.adjustmentType !== "reduction" }) : money(visibleSubtotal)}</td><td>${esc(row.note || "")}</td></tr>`;
  };
  let lineHtml = "";
  if (changeOrder) {
    const additions = rows.filter(row => row.adjustmentType !== "reduction");
    const reductions = rows.filter(row => row.adjustmentType === "reduction");
    const colspan = showEventColumn ? 9 : 8;
    if (additions.length) lineHtml += `<tr class="a4-change-group"><td colspan="${colspan}">追加項目 ADDITIONS</td></tr>${additions.map(renderLine).join("")}`;
    if (reductions.length) lineHtml += `<tr class="a4-change-group"><td colspan="${colspan}">減項項目 REDUCTIONS</td></tr>${reductions.map((row, index) => renderLine(row, additions.length + index)).join("")}`;
  } else {
    lineHtml = rows.map(renderLine).join("");
  }
  const showDates = events.map(event => event.eventDate).filter(Boolean).join("、") || "—";
  const setupDates = events.map(event => event.setupDate).filter(Boolean).join("、") || "—";
  const locations = [...new Set(events.map(event => event.location).filter(Boolean))].join("、") || "—";
  const pdfSubtotal = q.subtotal !== undefined
    ? (changeOrder ? signedIntegerValue(q.subtotal) : integerValue(q.subtotal))
    : Math.round(rows.reduce((sum, row) => sum + (usesPdfPricing ? calcPdfRowSubtotal(row) : usesLayeredPricing ? calcOriginalRowSubtotal(row) : calcRowSubtotal(row)), 0));
  const pdfTax = q.tax !== undefined ? (changeOrder ? signedIntegerValue(q.tax) : integerValue(q.tax)) : Math.round(pdfSubtotal * TAX_RATE);
  const pdfGrandTotal = q.originalTotal !== undefined ? (changeOrder ? signedIntegerValue(q.originalTotal) : integerValue(q.originalTotal)) : pdfSubtotal + pdfTax;
  const projectPriceTaxed = changeOrder ? signedIntegerValue(q.adjustmentTotalTaxed ?? q.projectPriceTaxed) : integerValue(q.projectPriceTaxed);
  const showProjectPriceOnPdf = q.showProjectPriceOnPdf !== false;
  const projectPriceRow = showProjectPriceOnPdf
    ? `<tr class="project-price"><th>專案價（含稅）</th><td class="num">$ ${money(projectPriceTaxed)}</td></tr>`
    : "";
  const additionSubtotal = q.additionSubtotal !== undefined ? integerValue(q.additionSubtotal) : Math.round(rows.filter(row => row.adjustmentType !== "reduction").reduce((sum, row) => sum + calcPdfRowSubtotal(row), 0));
  const reductionSubtotal = q.reductionSubtotal !== undefined ? integerValue(q.reductionSubtotal) : Math.round(rows.filter(row => row.adjustmentType === "reduction").reduce((sum, row) => sum + calcPdfRowSubtotal(row), 0));
  const priceBefore = integerValue(q.projectPriceBeforeTaxed);
  const priceAfter = q.projectPriceAfterTaxed !== undefined ? signedIntegerValue(q.projectPriceAfterTaxed) : priceBefore + projectPriceTaxed;
  const totalRows = changeOrder
    ? `<tr class="a4-change-summary"><th>追加合計<span>Additions</span></th><td class="num">$ ${money(additionSubtotal)}</td></tr><tr class="a4-change-summary reduction"><th>減項合計<span>Reductions</span></th><td class="num">− $ ${money(reductionSubtotal)}</td></tr><tr><th>營業稅 5%<span>Tax</span></th><td class="num">$ ${signedMoney(pdfTax, { plus: true })}</td></tr><tr class="project-price"><th>本次追加減（含稅）</th><td class="num">$ ${signedMoney(projectPriceTaxed, { plus: true })}</td></tr><tr><th>調整前專案價</th><td class="num">$ ${money(priceBefore)}</td></tr><tr class="project-price"><th>調整後專案價</th><td class="num">$ ${signedMoney(priceAfter)}</td></tr>`
    : `<tr><th>合計<span>Total</span></th><td class="num">$ ${money(pdfSubtotal)}</td></tr><tr><th>營業稅 5%<span>Tax</span></th><td class="num">$ ${money(pdfTax)}</td></tr><tr><th>總計<span>Grand Total</span></th><td class="num">$ ${money(pdfGrandTotal)}</td></tr>${projectPriceRow}`;
  return `<article class="quote-a4">
    <header class="a4-brand-header">
      <img class="a4-logo" src="${esc(COMPANY_LOGO_URL)}" alt="曜炎創意 YAoyan" />
      <div class="a4-title"><strong>${changeOrder ? "追 加 減 報 價 單" : "報 價 單"}</strong><span>${changeOrder ? "CHANGE ORDER QUOTATION" : "QUOTATION"}</span></div>
    </header>
    <table class="a4-info"><tbody>
      <tr><th>客戶名稱<span>Client</span></th><td>${esc(q.customerName)}</td><th>報價日期<span>Quotation Date</span></th><td>${esc(quotationDateText(q))}</td></tr>
      <tr><th>專案名稱<span>Project</span></th><td>${esc(q.projectName)}</td><th>報價編號<span>Quotation No.</span></th><td>${esc(q.number)} / V${esc(q.version || 1)}</td></tr>
      <tr><th>演出日期<span>Date</span></th><td>${esc(showDates)}</td><th>聯絡人<span>Contact Person</span></th><td>${esc(q.contactName || "—")}</td></tr>
      <tr><th>進撤場日期<span>Load-in/Out Dates</span></th><td>${esc(setupDates)}</td><th>聯絡電話<span>Phone</span></th><td>${esc(q.phone || "—")}</td></tr>
      <tr><th>專案地點<span>Location</span></th><td>${esc(locations)}</td><th>聯絡信箱<span>Email</span></th><td>${esc(q.email || "—")}</td></tr>
      <tr><th>客戶統編<span>Tax ID</span></th><td colspan="3">${esc(q.taxId || "—")}</td></tr>
    </tbody></table>
    <table class="a4-lines ${showEventColumn ? "" : "single-event"}"><thead><tr><th>編號<span>No.</span></th>${showEventColumn ? "<th>場次<span>Event</span></th>" : ""}<th>項目<span>Item</span></th><th>單價<span>Price</span></th><th>數量<span>Unit</span></th><th>單位</th><th>天數<span>Day</span></th><th>小計<span>Subtotal</span></th><th>備註<span>Note</span></th></tr></thead><tbody>${lineHtml || `<tr><td colspan="${showEventColumn ? 9 : 8}">尚無報價項目</td></tr>`}</tbody></table>
    <div class="a4-payment-grid">
      <div class="a4-terms-block"><div class="a4-section-title">合作與付款條件 Payment Terms</div><div class="a4-terms">${esc(q.terms || DEFAULT_TERMS)}</div>${q.note ? `<p class="a4-note"><b>備註：</b>${esc(q.note)}</p>` : ""}</div>
      <table class="a4-total"><tbody>${totalRows}</tbody></table>
    </div>
    <footer class="a4-company"><div class="a4-company-info"><b>${esc(COMPANY.name)}</b><div>公司統編 Tax ID：${esc(COMPANY.taxId)}</div><div>業務聯絡人 Contact：${esc(COMPANY.contact)}</div><div>聯絡信箱 Email：${esc(COMPANY.email)}</div><div>匯款資訊 Remittance Info：${esc(COMPANY.bank)}<br>${esc(COMPANY.accountName)}／${esc(COMPANY.account)}</div></div><div class="a4-sign"><span>確認無誤煩請簽名回傳：</span><i></i></div></footer>
  </article>`;
}

function printPreview() {
  if (!state.previewData) return;
  const html = buildA4(state.previewData);
  const filename = quotationFilename(state.previewData);
  const win = window.open("", "_blank");
  if (!win) return alert("瀏覽器阻擋了列印視窗，請允許此網站開啟彈出式視窗");
  win.opener = null;
  win.document.write(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>${esc(filename)}</title><link rel="stylesheet" href="${new URL("./styles.css", location.href).href}"><style>body{padding:0;background:#fff}.quote-a4{box-shadow:none;margin:0 auto}@page{size:A4;margin:0}</style></head><body class="quotation-print-window">${html}<script>window.onload=()=>{const logo=document.querySelector('.a4-logo');const print=()=>setTimeout(()=>window.print(),250);if(logo&&!logo.complete){logo.addEventListener('load',print,{once:true});logo.addEventListener('error',print,{once:true});}else{print();}}<\/script></body></html>`);
  win.document.close();
}

/* ------------------------- Realtime ------------------------- */
const scheduleQuoteRender = createRenderScheduler(renderAllQuoteModules);

function listen(name, target) {
  const unsubscribe = subscribeCollection(name, rows => {
    state[target] = rows;
    scheduleQuoteRender();
  }, { onError: error => console.error(`讀取 ${name} 失敗`, error) });
  state.unsubs.push(unsubscribe);
}

function detach() {
  state.unsubs.forEach(unsubscribe => unsubscribe());
  state.unsubs = [];
  state.customers = [];
  state.quotationItems = [];
  state.quotations = [];
  state.quotationSelectedIds.clear();
  state.customerCurrentPage = 1;
  state.quoteItemCurrentPage = 1;
  state.quotationCurrentPage = 1;
  state.projects = [];
  state.equipment = [];
  state.payments = [];
  state.receipts = [];
  renderAllQuoteModules();
}

function attach() {
  listen("customers", "customers");
  listen("quotationItems", "quotationItems");
  listen("quotations", "quotations");
  listen("projects", "projects");
  listen("equipment", "equipment");
  listen("payments", "payments");
  listen("receipts", "receipts");
}

function renderAllQuoteModules() {
  setMutationButtons();
  renderCustomers();
  renderQuoteItems();
  renderQuotations();
  refreshProjectOptions();
  refreshEquipmentOptions();
}

/* ------------------------- Events ------------------------- */
function bindEvents() {
  $("#customerOpenCreate")?.addEventListener("click", () => openCustomer());
  $("#customerForm")?.addEventListener("submit", event => { event.preventDefault(); saveCustomer(); });
  $$('[data-customer-close],#customerDrawerClose').forEach(button => button.addEventListener("click", () => closeDrawer("#customerDrawer")));
  $("#customerSearch")?.addEventListener("input", () => { state.customerCurrentPage = 1; renderCustomers(); });
  $("#customerPagination")?.addEventListener("click", event => {
    const button = event.target.closest("button[data-page]");
    if (!button || button.disabled) return;
    state.customerCurrentPage = Number(button.dataset.page) || 1;
    renderCustomers();
  });
  $("#customerPagination")?.addEventListener("change", event => {
    const select = event.target.closest("select[data-page-select]");
    if (!select) return;
    state.customerCurrentPage = Number(select.value) || 1;
    renderCustomers();
  });
  $("#customerTableBody")?.addEventListener("click", async event => {
    const edit = event.target.closest("[data-customer-edit]");
    const del = event.target.closest("[data-customer-delete]");
    if (edit) openCustomer(state.customers.find(item => item.id === edit.dataset.customerEdit));
    if (del && canDelete() && confirm("確定刪除此客戶？已建立的歷史報價仍會保留客戶快照。")) {
      const customer = state.customers.find(item => item.id === del.dataset.customerDelete);
      const linkedProjects = state.projects.filter(project => project.customerId === customer?.id);
      const linkedQuotations = state.quotations.filter(quotation => quotation.customerId === customer?.id && quotation.status !== "void");
      if (linkedProjects.length || linkedQuotations.length) {
        return alert(`此客戶仍有關聯資料，不能永久刪除：\n\n• 專案 ${linkedProjects.length} 筆\n• 未作廢報價 ${linkedQuotations.length} 筆\n\n請保留客戶主檔，以免專案、報價與付款條件失去連結。`);
      }
      await deleteDoc(doc(db, "customers", del.dataset.customerDelete));
      await logAction({ action: "delete", module: "customers", targetType: "customer", targetId: del.dataset.customerDelete, targetName: customer?.name || "", summary: "永久刪除客戶資料" });
    }
  });

  $("#quoteItemOpenCreate")?.addEventListener("click", () => openQuoteItem());
  $("#quoteItemForm")?.addEventListener("submit", event => { event.preventDefault(); saveQuoteItem(); });
  $$('[data-quote-item-close],#quoteItemDrawerClose').forEach(button => button.addEventListener("click", () => closeDrawer("#quoteItemDrawer")));
  $("#quoteItemSearch")?.addEventListener("input", () => { state.quoteItemCurrentPage = 1; renderQuoteItems(); });
  $$('[data-quote-item-sort]').forEach(button => button.addEventListener("click", () => {
    const key = button.dataset.quoteItemSort;
    if (state.quotationItemSort.key === key) state.quotationItemSort.direction = state.quotationItemSort.direction === "asc" ? "desc" : "asc";
    else state.quotationItemSort = { key, direction: key === "unitPrice" ? "desc" : "asc" };
    state.quoteItemCurrentPage = 1;
    renderQuoteItems();
  }));
  $("#quoteItemPagination")?.addEventListener("click", event => {
    const button = event.target.closest("button[data-page]");
    if (!button || button.disabled) return;
    state.quoteItemCurrentPage = Number(button.dataset.page) || 1;
    renderQuoteItems();
  });
  $("#quoteItemPagination")?.addEventListener("change", event => {
    const select = event.target.closest("select[data-page-select]");
    if (!select) return;
    state.quoteItemCurrentPage = Number(select.value) || 1;
    renderQuoteItems();
  });
  $("#quoteItemEquipmentId")?.addEventListener("change", event => {
    const equipment = state.equipment.find(item => item.id === event.target.value);
    if (!equipment) return;
    $("#quoteItemCategory").value = equipment.category || "";
    $("#quoteItemName").value = equipment.name || "";
    if (!$("#quoteItemUnit").value.trim()) $("#quoteItemUnit").value = "台";
  });
  $("#quoteItemPrice")?.addEventListener("blur", event => { event.target.value = event.target.value ? money(event.target.value) : ""; });
  $("#quoteItemTableBody")?.addEventListener("click", async event => {
    const edit = event.target.closest("[data-item-edit]");
    const del = event.target.closest("[data-item-delete]");
    if (edit) openQuoteItem(state.quotationItems.find(item => item.id === edit.dataset.itemEdit));
    if (del && canDelete() && confirm("確定刪除此常用項目？歷史報價內容不會被刪除。")) {
      const item = state.quotationItems.find(entry => entry.id === del.dataset.itemDelete);
      await deleteDoc(doc(db, "quotationItems", del.dataset.itemDelete));
      await logAction({ action: "delete", module: "catalog", targetType: "quotationItem", targetId: del.dataset.itemDelete, targetName: item?.name || "", summary: "永久刪除常用報價項目" });
    }
  });

  $("#quotationOpenCreate")?.addEventListener("click", () => openQuotation());
  $("#quotationForm")?.addEventListener("submit", event => { event.preventDefault(); saveQuotation(); });
  $$('[data-quotation-close],#quotationDrawerClose').forEach(button => button.addEventListener("click", () => closeQuotationDrawer()));
  const resetQuotationPageAndRender = () => {
    state.quotationCurrentPage = 1;
    renderQuotations();
  };
  $("#quotationSearch")?.addEventListener("input", resetQuotationPageAndRender);
  $("#quotationMonthFilter")?.addEventListener("change", resetQuotationPageAndRender);
  $("#quotationKindFilter")?.addEventListener("change", resetQuotationPageAndRender);
  $("#quotationStatusFilter")?.addEventListener("change", resetQuotationPageAndRender);
  $("#quotationSort")?.addEventListener("change", resetQuotationPageAndRender);
  $("#quotationClearFilters")?.addEventListener("click", () => {
    $("#quotationSearch").value = "";
    $("#quotationMonthFilter").value = "";
    $("#quotationKindFilter").value = "all";
    $("#quotationStatusFilter").value = "all";
    forgetUiControls(["quotationSearch", "quotationMonthFilter", "quotationKindFilter", "quotationStatusFilter"]);
    resetQuotationPageAndRender();
  });
  $("#quotationSelectAll")?.addEventListener("change", event => {
    $$(".quotation-select", $("#quotationTableBody")).forEach(input => {
      if (input.disabled) return;
      input.checked = event.target.checked;
      if (event.target.checked) state.quotationSelectedIds.add(input.value);
      else state.quotationSelectedIds.delete(input.value);
    });
    renderQuotations();
  });
  $("#quotationBatchStatus")?.addEventListener("change", renderQuotations);
  $("#quotationBatchApply")?.addEventListener("click", applyQuotationBatchStatus);
  $("#quotationBatchSyncProjects")?.addEventListener("click", syncQuotationBatchToProjects);
  $("#quotationBatchClear")?.addEventListener("click", () => {
    state.quotationSelectedIds.clear();
    if ($("#quotationBatchStatus")) $("#quotationBatchStatus").value = "";
    renderQuotations();
  });
  $("#quotationPagination")?.addEventListener("click", event => {
    const button = event.target.closest("button[data-page]");
    if (!button || button.disabled) return;
    state.quotationCurrentPage = Number(button.dataset.page) || 1;
    renderQuotations();
    document.querySelector("#tab-quotations .quote-toolbar")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("#quotationPagination")?.addEventListener("change", event => {
    const select = event.target.closest("select[data-page-select]");
    if (!select) return;
    state.quotationCurrentPage = Number(select.value) || 1;
    renderQuotations();
    document.querySelector("#tab-quotations .quote-toolbar")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("#quotationNumber")?.addEventListener("input", () => { state.numberWasSuggested = false; });
  $("#quotationKind")?.addEventListener("change", event => {
    const hasContent = readRows().some(row => row.name || row.category || row.unitPrice);
    if (hasContent && !confirm("切換報價類型會清除目前的報價明細，是否繼續？")) {
      event.target.value = event.target.value === "change_order" ? "standard" : "change_order";
      return;
    }
    $("#quotationRows").innerHTML = "";
    $("#quotationAdditionRows").innerHTML = "";
    $("#quotationReductionRows").innerHTML = "";
    state.quotationProjectPriceCustomized = false;
    syncQuotationKindUi();
    addQuotationRow(rowDataFromCatalog({}, "addition"), "addition");
    recalcQuotation();
  });
  $("#quotationProjectPrice")?.addEventListener("input", event => {
    state.quotationProjectPriceCustomized = Boolean(event.target.value.trim());
    recalcQuotation();
  });
  $("#quotationProjectPrice")?.addEventListener("blur", event => { event.target.value = event.target.value ? money(event.target.value) : ""; recalcQuotation(); });
  $("#quotationShowProjectPriceOnPdf")?.addEventListener("change", () => {
    state.quotationProjectPricePdfVisibilityCustomized = true;
  });
  $("#quotationUseCalculatedPrice")?.addEventListener("click", () => {
    state.quotationProjectPriceCustomized = false;
    recalcQuotation();
  });
  $("#quotationProjectId")?.addEventListener("change", event => {
    const project = state.projects.find(item => item.id === event.target.value);
    if (!project) {
      recalcQuotation();
      return;
    }
    $("#quotationProjectName").value = project.name || "";
    if (!$("#quotationCustomerId").value && project.customerId) {
      const customer = state.customers.find(item => item.id === project.customerId);
      if (customer) {
        $("#quotationCustomerId").value = customer.id;
        $("#quotationCustomerSearch").value = customerOptionLabel(customer);
        $("#quotationCustomerName").value = customer.name || "";
        $("#quotationContactName").value = customer.contactName || "";
        $("#quotationPhone").value = customer.phone || "";
        $("#quotationEmail").value = customer.email || "";
        $("#quotationTaxId").value = customer.taxId || "";
      }
    } else if (!$("#quotationCustomerName").value) {
      $("#quotationCustomerName").value = project.client || "";
    }
    if (state.numberWasSuggested) $("#quotationNumber").value = suggestedNumber(isChangeOrder() ? new Date().toISOString().slice(0, 10) : project.startDate);
    const first = $(".quote-event-row", $("#quotationEvents"));
    if (first) {
      $(".event-location", first).value = project.location || "";
      $(".event-date", first).value = project.startDate || "";
      $(".event-setup", first).value = project.startDate && project.endDate ? `${project.startDate}–${project.endDate}` : "";
    }
    recalcQuotation();
  });
  $("#quotationCustomerSearch")?.addEventListener("input", applyCustomerSearchSelection);
  $("#quotationCustomerSearch")?.addEventListener("change", applyCustomerSearchSelection);
  $("#quotationAddEvent")?.addEventListener("click", () => addEventRow());
  $("#quotationEvents")?.addEventListener("click", event => {
    const remove = event.target.closest(".remove-event");
    if (!remove) return;
    const rows = $$(".quote-event-row", $("#quotationEvents"));
    if (rows.length <= 1) return alert("至少保留一個場次");
    remove.closest(".quote-event-row").remove();
    refreshRowEventOptions();
  });
  $("#quotationEvents")?.addEventListener("input", event => {
    if (event.target.matches(".event-name")) refreshRowEventOptions();
    if (event.target.matches(".event-date") && state.numberWasSuggested && !isChangeOrder() && $$(".event-date", $("#quotationEvents")).indexOf(event.target) === 0) $("#quotationNumber").value = suggestedNumber(event.target.value);
  });
  $("#quotationAddRow")?.addEventListener("click", () => addQuotationRow(rowDataFromCatalog()));
  $("#quotationAddAdditionRow")?.addEventListener("click", () => addQuotationRow(rowDataFromCatalog({}, "addition"), "addition"));
  $("#quotationAddReductionRow")?.addEventListener("click", () => addQuotationRow(rowDataFromCatalog({}, "reduction"), "reduction"));
  $("#quotationCatalogPicker")?.addEventListener("change", event => {
    const item = state.quotationItems.find(entry => entry.id === event.target.value);
    if (item) addQuotationRow(rowDataFromCatalog(item));
    event.target.value = "";
  });
  $("#quotationAdditionCatalogPicker")?.addEventListener("change", event => {
    const item = state.quotationItems.find(entry => entry.id === event.target.value);
    if (item) addQuotationRow(rowDataFromCatalog(item, "addition"), "addition");
    event.target.value = "";
  });
  $("#quotationReductionCatalogPicker")?.addEventListener("change", event => {
    const item = state.quotationItems.find(entry => entry.id === event.target.value);
    if (item) addQuotationRow(rowDataFromCatalog(item, "reduction"), "reduction");
    event.target.value = "";
  });
  $("#quotationForm")?.addEventListener("click", event => {
    const remove = event.target.closest(".remove-quote-row");
    const moveUp = event.target.closest(".move-quote-row-up");
    const moveDown = event.target.closest(".move-quote-row-down");
    const row = event.target.closest(".quotation-line");
    if (!row) return;
    if (moveUp && row.previousElementSibling) row.parentElement.insertBefore(row, row.previousElementSibling);
    else if (moveDown && row.nextElementSibling) row.parentElement.insertBefore(row.nextElementSibling, row);
    else if (remove) {
      row.remove();
      if (!quotationLineRows().length) addQuotationRow(rowDataFromCatalog({}, "addition"), "addition");
    } else return;
    recalcQuotation();
  });
  $("#quotationForm")?.addEventListener("input", event => {
    state.quotationFormDirty = true;
    const row = event.target.closest(".quotation-line");
    if (!row) return;
    if (event.target.matches(".row-mode")) syncLineMode(row);
    recalcQuotation();
  });
  $("#quotationForm")?.addEventListener("change", event => {
    state.quotationFormDirty = true;
    const row = event.target.closest(".quotation-line");
    if (!row) return;
    if (event.target.matches(".row-mode,.row-pdf-pricing")) syncLineMode(row);
    recalcQuotation();
  });
  $("#quotationOpenAllocation")?.addEventListener("click", openAllocationModal);
  $("#quotationAllocationClose")?.addEventListener("click", closeAllocationModal);
  $("#quotationAllocationDone")?.addEventListener("click", closeAllocationModal);
  $("#quotationAllocationModal")?.addEventListener("click", event => {
    if (event.target === $("#quotationAllocationModal")) closeAllocationModal();
  });
  $("#quotationAllocationRows")?.addEventListener("input", event => {
    const input = event.target.closest(".allocation-input,.allocation-rate-input");
    if (!input) return;
    const rowId = input.dataset.allocationRow || input.dataset.allocationRateRow;
    const row = quotationRowById(rowId);
    if (!row) return;
    const internalInput = $(".row-deal-subtotal", row);
    const modalRow = input.closest("tr");
    const amountInput = $(".allocation-input", modalRow);
    const rateInput = $(".allocation-rate-input", modalRow);
    const quoteSubtotal = calcPdfRowSubtotal(readRow(row));
    if (input.matches(".allocation-rate-input")) {
      row.dataset.dealSubtotalMode = input.value.trim() ? "manual" : "auto";
      const calculated = input.value.trim() ? Math.round(quoteSubtotal * numberValue(input.value) / 100) : quoteSubtotal;
      internalInput.value = money(calculated);
      amountInput.value = money(calculated);
    } else {
      row.dataset.dealSubtotalMode = input.value.trim() ? "manual" : "auto";
      internalInput.value = input.value;
      const amount = input.value.trim() ? integerValue(input.value) : quoteSubtotal;
      if (!input.value.trim()) input.value = money(amount);
      if (rateInput && quoteSubtotal) rateInput.value = percentage(amount / quoteSubtotal * 100);
    }
    const totals = recalcQuotation();
    updateAllocationStatus(totals);
  });
  $("#quotationAllocationRows")?.addEventListener("blur", event => {
    const input = event.target.closest(".allocation-input,.allocation-rate-input");
    if (!input) return;
    input.value = input.matches(".allocation-input") ? money(input.value) : (input.value.trim() ? percentage(input.value) : "100");
  }, true);
  $("#quotationAllocationReset")?.addEventListener("click", () => {
    quotationLineRows().forEach(row => { row.dataset.dealSubtotalMode = "auto"; });
    recalcQuotation();
    renderAllocationRows();
  });
  $("#quotationPreviewCurrent")?.addEventListener("click", () => previewQuotation(previewDataFromForm()));
  $("#quotationTableBody")?.addEventListener("click", async event => {
    if (event.target.closest(".quotation-select")) return;
    const preview = event.target.closest("[data-quotation-preview]");
    const edit = event.target.closest("[data-quotation-edit]");
    const version = event.target.closest("[data-quotation-version]");
    const sync = event.target.closest("[data-quotation-sync]");
    const voidButton = event.target.closest("[data-quotation-void]");
    const del = event.target.closest("[data-quotation-delete]");
    const id = preview?.dataset.quotationPreview || edit?.dataset.quotationEdit || version?.dataset.quotationVersion || sync?.dataset.quotationSync || voidButton?.dataset.quotationVoid || del?.dataset.quotationDelete;
    const quotation = state.quotations.find(item => item.id === id);
    if (preview && quotation) previewQuotation(quotation);
    if (edit && quotation) openQuotation(quotation);
    if (version && quotation) openQuotation(quotation, { newVersion: true });
    if (sync && quotation) {
      if (quotation.quotationKind === "change_order") await applyChangeOrderToProject(quotation, quotation.id);
      else await syncConfirmedQuotationToProject(quotation, quotation.id);
    }
    if (voidButton && quotation && canEdit()) {
      if (quotation.quotationKind === "change_order") await voidChangeOrder(quotation);
      else if (confirm(`確定將 ${quotation.number} / V${quotation.version || 1} 標記為作廢？報價仍會保留供日後回溯。`)) {
        await updateDoc(doc(db, "quotations", quotation.id), { status: "void", updatedAt: serverTimestamp(), updatedBy: state.user.uid });
        await logAction({ action: "void", module: "quotations", targetType: "quotation", targetId: quotation.id, targetName: `${quotation.number} / V${quotation.version || 1}`, summary: `${quotation.customerName || ""}｜${quotation.projectName || ""}` });
      }
    }
    if (del && quotation && canDelete()) {
      const linkedProject = state.projects.find(project => project.confirmedQuotationId === quotation.id);
      if (linkedProject || quotation.status === "confirmed") {
        return alert(`此報價已確認${linkedProject ? `並回寫至專案「${linkedProject.name || ""}」` : ""}，不能永久刪除。請使用「作廢」保留版本與歷史。`);
      }
      if (!confirm(`確定刪除尚未確認的 ${quotation.number} / V${quotation.version || 1}？一般回溯建議使用「作廢」。`)) return;
      await deleteDoc(doc(db, "quotations", quotation.id));
      await logAction({ action: "delete", module: "quotations", targetType: "quotation", targetId: quotation.id, targetName: `${quotation.number} / V${quotation.version || 1}`, summary: `${quotation.customerName || ""}｜${quotation.projectName || ""}` });
    }
  });
  $("#quotationTableBody")?.addEventListener("change", event => {
    const input = event.target.closest(".quotation-select");
    if (!input) return;
    if (input.checked) state.quotationSelectedIds.add(input.value);
    else state.quotationSelectedIds.delete(input.value);
    renderQuotations();
  });

  document.addEventListener("click", event => {
    if (!event.target.closest(".row-action-menu")) $$(".row-action-menu[open]").forEach(menu => menu.removeAttribute("open"));
    const clearProjectFilter = event.target.closest("[data-clear-quotation-project]");
    if (clearProjectFilter) {
      state.quotationProjectFilterId = "";
      state.quotationCurrentPage = 1;
      renderQuotations();
      return;
    }
    const projectButton = event.target.closest("[data-quotation-project]");
    const changeOrderButton = event.target.closest("[data-change-order-project]");
    if (!projectButton && !changeOrderButton) return;
    const projectId = changeOrderButton?.dataset.changeOrderProject || projectButton?.dataset.quotationProject;
    const project = state.projects.find(item => item.id === projectId);
    if (!project) return;
    if (changeOrderButton) {
      if (!canEdit()) return alert("你目前沒有新增追加減報價的權限");
      if (!integerValue(project.quote)) return alert("此專案尚未建立原始專案價，請先確認並同步一般報價");
      openQuotation(null, { project, changeOrder: true });
      return;
    }
    const related = state.quotations.filter(q => q.projectId === project.id);
    if (related.length) {
      switchTab("quotations");
      state.quotationProjectFilterId = project.id;
      $("#quotationSearch").value = "";
      state.quotationCurrentPage = 1;
      renderQuotations();
    } else if (canEdit()) {
      openQuotation(null, { project });
    } else {
      alert("此專案尚無報價；viewer 無法新增。");
    }
  });

  window.addEventListener("yaoyan:create-quote-item-from-equipment", event => {
    if (!canManageCatalog()) return alert("你目前沒有管理常用報價項目的權限");
    const equipment = state.equipment.find(item => item.id === event.detail?.equipmentId);
    if (!equipment) return alert("找不到這筆設備資料，請稍後重試");
    openQuoteItem({
      __fromEquipment: true,
      equipmentId: equipment.id,
      category: equipment.category || "",
      name: equipment.name || "",
      unit: "台",
      calcMode: "auto50",
      continuationRate: 50
    });
  });

  $("#quotationPreviewClose")?.addEventListener("click", () => $("#quotationPreviewModal").classList.add("hidden"));
  $("#quotationPreviewModal")?.addEventListener("click", event => { if (event.target === $("#quotationPreviewModal")) $("#quotationPreviewModal").classList.add("hidden"); });
  $("#quotationPrint")?.addEventListener("click", printPreview);
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    closeAllocationModal();
    $("#quotationPreviewModal")?.classList.add("hidden");
    closeQuotationDrawer();
  });
  window.addEventListener("beforeunload", event => {
    if (!state.quotationFormDirty || $("#quotationDrawer")?.classList.contains("hidden")) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

function init() {
  restoreUiControls(["quotationSearch", "quotationMonthFilter", "quotationKindFilter", "quotationStatusFilter", "quotationSort", "customerSearch", "quoteItemSearch"]);
  bindUiControlMemory(["quotationSearch", "quotationMonthFilter", "quotationKindFilter", "quotationStatusFilter", "quotationSort", "customerSearch", "quoteItemSearch"]);
  bindEvents();
  renderAllQuoteModules();
  watchAuth(async user => {
    detach();
    state.user = user;
    state.role = null;
    state.access = null;
    if (!user) return renderAllQuoteModules();
    try {
      await ensureUserDoc(user);
      state.access = await getUserAccess(user);
      state.role = state.access.role;
    } catch (error) {
      console.error(error);
      state.role = "viewer";
      state.access = { role: "viewer", approved: false, permissions: defaultPermissionsForRole("viewer") };
    }
    setMutationButtons();
    if (state.access.approved) attach();
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
