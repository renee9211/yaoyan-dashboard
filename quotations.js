// Phase 1 quotation module: customers, quotation catalog, versioned quotations and A4 output.
import { db, watchAuth, getUserAccess, hasPermission, ensureUserDoc, defaultPermissionsForRole } from "./firebase.js";
import { logAction } from "./audit.js";
import {
  collection, doc, setDoc, updateDoc, deleteDoc, onSnapshot,
  query, orderBy, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const TAX_RATE = 0.05;
const QUOTATIONS_PER_PAGE = 20;
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
  equipment: collection(db, "equipment")
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
  unsubs: [],
  previewData: null,
  numberWasSuggested: false,
  quotationCurrentPage: 1,
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

function integerValue(value) { return Math.round(numberValue(value)); }
function money(value) { return Math.round(numberValue(value)).toLocaleString("zh-TW"); }
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

function calcTotals(rows, projectPriceInput = "") {
  const subtotal = Math.round((rows || []).reduce((sum, row) => sum + calcRowSubtotal(row), 0));
  const tax = Math.round(subtotal * TAX_RATE);
  const originalTotal = subtotal + tax;
  const projectPriceTaxed = String(projectPriceInput ?? "").trim() === "" ? originalTotal : integerValue(projectPriceInput);
  const projectPriceUntaxed = projectPriceTaxed ? Math.round(projectPriceTaxed / (1 + TAX_RATE)) : 0;
  return { subtotal, tax, originalTotal, projectPriceTaxed, projectPriceUntaxed, discount: Math.max(0, originalTotal - projectPriceTaxed) };
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

function renderCustomers() {
  const body = $("#customerTableBody");
  if (!body) return;
  const keyword = $("#customerSearch")?.value.trim().toLocaleLowerCase("zh-Hant") || "";
  const list = state.customers.filter(customer => !keyword || [customer.name, customer.taxId, customer.contactName, customer.phone, customer.email]
    .join(" ").toLocaleLowerCase("zh-Hant").includes(keyword));
  body.innerHTML = list.length ? list.map(customer => `
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
  body.innerHTML = list.length ? list.map(item => `
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
  const select = $("#quotationCustomerId");
  if (!select) return;
  const current = select.value;
  select.innerHTML = `<option value="">手動輸入／不連結</option>${state.customers.map(customer => `<option value="${esc(customer.id)}">${esc(customer.name)}</option>`).join("")}`;
  select.value = current;
}

function refreshCatalogPicker() {
  const select = $("#quotationCatalogPicker");
  if (!select) return;
  const items = [...state.quotationItems].sort((a, b) => String(a.category || "未分類").localeCompare(String(b.category || "未分類"), "zh-Hant", { numeric: true, sensitivity: "base" }) || String(a.name || "").localeCompare(String(b.name || ""), "zh-Hant", { numeric: true, sensitivity: "base" }));
  select.innerHTML = `<option value="">從常用項目新增…</option>${items.map(item => `<option value="${esc(item.id)}">${esc(item.category || "未分類")}｜${esc(item.name)}</option>`).join("")}`;
}

function suggestedNumber(dateISO) {
  const raw = (dateISO || new Date().toISOString().slice(0, 10)).replaceAll("-", "").slice(2);
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
    <label><span>活動日期</span><input class="input event-date" type="date" value="${esc(event.eventDate || "")}" /></label>
    <label><span>進／撤場日期</span><input class="input event-setup" value="${esc(event.setupDate || "")}" placeholder="例如：8/9–8/10" /></label>
    <button class="remove-equip-row remove-event" type="button" title="移除場次">✕</button>`;
  $("#quotationEvents").appendChild(row);
  refreshRowEventOptions();
}

function readEvents() {
  return $$(".quote-event-row", $("#quotationEvents")).map(row => ({
    id: row.dataset.eventId,
    name: $(".event-name", row).value.trim(),
    location: $(".event-location", row).value.trim(),
    eventDate: $(".event-date", row).value,
    setupDate: $(".event-setup", row).value.trim()
  }));
}

function eventOptionHtml(selected = "shared") {
  return `<option value="shared" ${selected === "shared" ? "selected" : ""}>共用</option>${readEvents().map(event => `<option value="${esc(event.id)}" ${selected === event.id ? "selected" : ""}>${esc(event.name || "未命名場次")}</option>`).join("")}`;
}

function refreshRowEventOptions() {
  $$(".row-event", $("#quotationRows")).forEach(select => {
    const current = select.value;
    select.innerHTML = eventOptionHtml(current);
    if (![...select.options].some(option => option.value === current)) select.value = "shared";
  });
}

function rowDataFromCatalog(item = {}) {
  const equipment = linkedEquipment(item);
  return {
    id: uid(), eventId: "shared", category: item.category || "", name: item.name || "",
    unitPrice: item.unitPrice || 0, qty: 1, unit: item.unit || "", days: 1,
    calcMode: item.calcMode || "auto50", continuationRate: item.continuationRate ?? 50,
    manualSubtotal: item.calcMode === "manual" ? 0 : "", note: item.note || "",
    catalogItemId: item.id || "", equipmentId: item.equipmentId || "", equipmentName: equipment?.name || item.equipmentName || ""
  };
}

function addQuotationRow(data = {}) {
  const row = document.createElement("tr");
  row.className = "quotation-line";
  row.dataset.rowId = data.id || uid();
  row.dataset.catalogItemId = data.catalogItemId || "";
  row.dataset.equipmentId = data.equipmentId || "";
  row.dataset.equipmentName = data.equipmentName || "";
  const mode = data.calcMode || "auto50";
  row.innerHTML = `
    <td><select class="select row-event">${eventOptionHtml(data.eventId || "shared")}</select></td>
    <td><div class="quote-row-title"><input class="input row-category" value="${esc(data.category || "")}" placeholder="類別" /><input class="input row-name" value="${esc(data.name || "")}" placeholder="項目名稱" /></div></td>
    <td><input class="input row-price" inputmode="numeric" value="${data.unitPrice ? esc(money(data.unitPrice)) : ""}" /></td>
    <td><input class="input row-qty" type="number" min="0" step="0.01" value="${esc(data.qty ?? 1)}" /></td>
    <td><input class="input row-unit" value="${esc(data.unit || "")}" /></td>
    <td><input class="input row-days" type="number" min="1" step="0.5" value="${esc(data.days ?? 1)}" /></td>
    <td><select class="select row-mode"><option value="auto50" ${mode === "auto50" ? "selected" : ""}>次日起 50%</option><option value="daily" ${mode === "daily" ? "selected" : ""}>每日原價</option><option value="custom" ${mode === "custom" ? "selected" : ""}>自訂比例</option><option value="manual" ${mode === "manual" ? "selected" : ""}>人工小計</option><option value="included" ${mode === "included" ? "selected" : ""}>免費／已含</option></select></td>
    <td><input class="input row-rate" type="number" min="0" step="1" value="${esc(data.continuationRate ?? 50)}" /></td>
    <td><input class="input row-subtotal" inputmode="numeric" value="${mode === "included" ? "—" : esc(money(mode === "manual" ? data.manualSubtotal : calcRowSubtotal({ ...data, calcMode: mode })))}" /></td>
    <td><input class="input row-note" value="${esc(data.note || "")}" /></td>
    <td><button class="remove-equip-row remove-quote-row" type="button" title="移除明細">✕</button></td>`;
  $("#quotationRows").appendChild(row);
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
  const manual = mode === "manual";
  const included = mode === "included";
  price.disabled = included;
  qty.disabled = false;
  days.disabled = manual || included;
  rate.disabled = !["custom"].includes(mode);
  subtotal.readOnly = !manual;
  subtotal.value = included ? "—" : manual ? subtotal.value.replaceAll("—", "") : money(calcRowSubtotal(readRow(row)));
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
    note: $(".row-note", row).value.trim(),
    catalogItemId: row.dataset.catalogItemId || "",
    equipmentId: row.dataset.equipmentId || "",
    equipmentName: row.dataset.equipmentName || ""
  };
}

function readRows() { return $$(".quotation-line", $("#quotationRows")).map(readRow).filter(row => row.name || row.category); }

function recalcQuotation() {
  $$(".quotation-line", $("#quotationRows")).forEach(row => {
    const mode = $(".row-mode", row).value;
    if (mode !== "manual" && mode !== "included") $(".row-subtotal", row).value = money(calcRowSubtotal(readRow(row)));
  });
  const totals = calcTotals(readRows(), $("#quotationProjectPrice").value);
  $("#quotationSubtotal").textContent = money(totals.subtotal);
  $("#quotationTax").textContent = money(totals.tax);
  $("#quotationOriginalTotal").textContent = money(totals.originalTotal);
  $("#quotationDiscount").textContent = money(totals.discount);
  $("#quotationUntaxedRevenue").textContent = money(totals.projectPriceUntaxed);
  return totals;
}

function resetQuotationForm(quotation = null, options = {}) {
  const project = options.project || null;
  const isNewVersion = Boolean(options.newVersion);
  const version = quotation ? (isNewVersion ? Number(quotation.version || 1) + 1 : Number(quotation.version || 1)) : 1;
  $("#quotationId").value = quotation && !isNewVersion ? quotation.id : "";
  $("#quotationSeriesId").value = quotation?.seriesId || "";
  $("#quotationVersion").value = version;
  $("#quotationVersionLabel").textContent = `V${version}`;
  $("#quotationDrawerTitle").textContent = quotation ? (isNewVersion ? `複製為 V${version}` : `編輯報價 V${version}`) : "新增報價";
  refreshProjectOptions();
  refreshCustomerOptions();
  refreshCatalogPicker();
  $("#quotationProjectId").value = project?.id || quotation?.projectId || "";
  $("#quotationCustomerId").value = quotation?.customerId || "";
  const firstDate = project?.startDate || quotation?.events?.[0]?.eventDate || new Date().toISOString().slice(0, 10);
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
  $("#quotationProjectPrice").value = quotation?.projectPriceTaxed ? money(quotation.projectPriceTaxed) : "";
  $("#quotationEvents").innerHTML = "";
  const events = quotation?.events?.length ? quotation.events : [blankEvent({ name: "場次 1", location: project?.location || "", eventDate: project?.startDate || "", setupDate: project?.startDate && project?.endDate ? `${project.startDate}–${project.endDate}` : "" })];
  events.forEach(addEventRow);
  $("#quotationRows").innerHTML = "";
  const rows = quotation?.rows?.length ? quotation.rows : [];
  rows.forEach(addQuotationRow);
  if (!rows.length) addQuotationRow(rowDataFromCatalog());
  recalcQuotation();
}

function maxVersion(seriesId) {
  return Math.max(0, ...state.quotations.filter(q => q.seriesId === seriesId).map(q => Number(q.version) || 1));
}

function openQuotation(quotation = null, options = {}) {
  if ((options.newVersion || !quotation) && !canEdit()) return alert("viewer 僅能預覽與下載報價單");
  if (quotation && !options.newVersion && ["confirmed", "void"].includes(quotation.status)) return previewQuotation(quotation);
  if (quotation && !options.newVersion && Number(quotation.version || 1) < maxVersion(quotation.seriesId)) {
    return previewQuotation(quotation);
  }
  resetQuotationForm(quotation, options);
  openDrawer("#quotationDrawer");
}

function readQuotationForm() {
  const rows = readRows();
  const totals = calcTotals(rows, $("#quotationProjectPrice").value);
  return {
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
    events: readEvents(), rows, terms: $("#quotationTerms").value.trim(), note: $("#quotationNote").value.trim(),
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
  const duplicate = state.quotations.find(q => q.number === payload.number && Number(q.version || 1) === payload.version && q.id !== id);
  if (duplicate) return alert(`系統內已有 ${payload.number} / V${payload.version}，請修改編號或建立其他版本`);
  try {
    let savedId = id;
    if (id) {
      const existing = state.quotations.find(q => q.id === id);
      if (existing && Number(existing.version || 1) < maxVersion(existing.seriesId)) return alert("舊版本已鎖定，請從最新版複製為新版本");
      await updateDoc(doc(db, "quotations", id), { ...payload, updatedAt: serverTimestamp(), updatedBy: state.user.uid });
    } else {
      const ref = doc(collections.quotations);
      savedId = ref.id;
      const seriesId = payload.seriesId || ref.id;
      await setDoc(ref, { ...payload, seriesId, createdAt: serverTimestamp(), createdBy: state.user.uid, updatedAt: serverTimestamp(), updatedBy: state.user.uid });
    }
    await logAction({ action: id ? "update" : "create", module: "quotations", targetType: "quotation", targetId: savedId, targetName: `${payload.number} / V${payload.version}`, summary: `${payload.customerName}｜${payload.projectName}｜專案價 ${money(payload.projectPriceTaxed)} 元｜${statusLabel(payload.status)}` });
    closeDrawer("#quotationDrawer");
    if (payload.status === "confirmed") await syncConfirmedQuotationToProject(payload, savedId);
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

async function writeBackProject(quotation, quotationId) {
  if (!quotation.projectId || quotation.status !== "confirmed") return;
  if (!canEditProject()) return alert("你目前沒有編輯既有專案的權限；報價本身不受影響。");
  try {
    await updateDoc(doc(db, "projects", quotation.projectId), {
      quote: quotation.projectPriceTaxed,
      quoteTaxMode: "taxed",
      revenue: quotation.projectPriceUntaxed,
      confirmedQuotationId: quotationId,
      confirmedQuotationNumber: quotation.number,
      confirmedQuotationVersion: quotation.version,
      updatedAt: serverTimestamp()
    });
    await logAction({ action: "sync", module: "quotations", targetType: "project", targetId: quotation.projectId, targetName: quotation.projectName || quotation.number, summary: `由 ${quotation.number} / V${quotation.version || 1} 回寫專案價 ${money(quotation.projectPriceTaxed)} 元` });
    alert("已將專案價回寫專案；外部支出、設備、狀態與其他舊資料都沒有變動。");
  } catch (error) {
    console.error(error);
    alert("報價已儲存，但專案回寫失敗；請確認你有專案編輯權限。");
  }
}

async function createProjectFromQuotation(quotation, quotationId) {
  if (!canCreateProject()) return alert("你目前沒有新增專案的權限；報價本身不受影響。");
  const events = Array.isArray(quotation.events) ? quotation.events : [];
  const eventDates = events.map(event => event.eventDate).filter(Boolean).sort();
  const locations = [...new Set(events.map(event => event.location?.trim()).filter(Boolean))];
  const projectRef = doc(collections.projects);
  const quotationRef = doc(db, "quotations", quotationId);
  const batch = writeBatch(db);
  batch.set(projectRef, {
    name: quotation.projectName,
    client: quotation.customerName || "",
    location: locations.join("／"),
    startDate: eventDates[0] || "",
    endDate: eventDates[eventDates.length - 1] || eventDates[0] || "",
    status: "planning",
    quote: integerValue(quotation.projectPriceTaxed),
    quoteTaxMode: "taxed",
    revenue: integerValue(quotation.projectPriceUntaxed),
    cost: 0,
    equipmentsUsed: [],
    note: `由報價 ${quotation.number} / V${quotation.version || 1} 建立；專案狀態、外部支出與使用設備請再確認。`,
    confirmedQuotationId: quotationId,
    confirmedQuotationNumber: quotation.number,
    confirmedQuotationVersion: quotation.version || 1,
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
  const status = $("#quotationStatusFilter")?.value || "all";
  const latest = latestBySeries();
  const confirmedBySeries = new Map();
  state.quotations.filter(q => q.status === "confirmed").forEach(q => {
    const key = q.seriesId || q.id;
    const current = confirmedBySeries.get(key);
    if (!current || Number(q.version || 1) > Number(current.version || 1)) confirmedBySeries.set(key, q);
  });
  const filteredList = [...state.quotations].filter(q => {
    if (status !== "all" && q.status !== status) return false;
    return !keyword || [q.number, q.projectName, q.customerName].join(" ").toLocaleLowerCase("zh-Hant").includes(keyword);
  }).sort((a, b) => {
    if (a.number === b.number) return Number(b.version || 1) - Number(a.version || 1);
    return String(b.number || "").localeCompare(String(a.number || ""), "zh-Hant", { numeric: true });
  });
  const totalPages = Math.max(1, Math.ceil(filteredList.length / QUOTATIONS_PER_PAGE));
  state.quotationCurrentPage = Math.min(Math.max(1, state.quotationCurrentPage), totalPages);
  const startIndex = (state.quotationCurrentPage - 1) * QUOTATIONS_PER_PAGE;
  const list = filteredList.slice(startIndex, startIndex + QUOTATIONS_PER_PAGE);
  body.innerHTML = list.length ? list.map(q => {
    const isLatest = latest.get(q.seriesId || q.id)?.id === q.id;
    return `<tr>
      <td><button class="quote-link" type="button" data-quotation-preview="${esc(q.id)}">${esc(q.number)}</button></td>
      <td><b>${esc(q.projectName)}</b><div class="table-sub">${esc(q.customerName || "—")}</div></td>
      <td><span class="badge ${isLatest ? "orange" : "neutral"}">V${esc(q.version || 1)}${isLatest ? " 最新" : ""}</span></td>
      <td class="num"><b>${money(q.projectPriceTaxed)}</b></td>
      <td><span class="badge ${statusBadge(q.status)}">${esc(statusLabel(q.status))}</span></td>
      <td>${esc(timestampText(q.updatedAt || q.createdAt))}</td>
      <td><div class="row-actions">
        <button class="btn ghost small" type="button" data-quotation-preview="${esc(q.id)}">預覽</button>
        <button class="btn ghost small" type="button" data-quotation-edit="${esc(q.id)}" ${canEdit() && isLatest && !["confirmed", "void"].includes(q.status) ? "" : "disabled"}>編輯</button>
        <button class="btn ghost small" type="button" data-quotation-version="${esc(q.id)}" ${canEdit() && isLatest ? "" : "disabled"}>複製新版</button>
        ${q.status === "confirmed" ? `<button class="btn ghost small" type="button" data-quotation-sync="${esc(q.id)}" ${(canEdit() && (q.projectId ? canEditProject() : canCreateProject())) ? "" : "disabled"}>${q.projectId ? "同步專案金額" : "建立專案"}</button>` : ""}
        <button class="btn ghost small" type="button" data-quotation-void="${esc(q.id)}" ${canEdit() && isLatest && q.status !== "void" ? "" : "disabled"}>作廢</button>
        <button class="btn ghost small" type="button" data-quotation-delete="${esc(q.id)}" ${canDelete() ? "" : "disabled"}>刪除</button>
      </div></td>
    </tr>`;
  }).join("") : `<tr><td colspan="7"><div class="empty-state">尚無符合條件的報價</div></td></tr>`;
  renderQuotationPagination(filteredList.length);

  $("#quotationSeriesCount").textContent = String(latest.size);
  $("#quotationOpenCount").textContent = String([...latest.values()].filter(q => q.status === "draft" || q.status === "sent").length);
  $("#quotationConfirmedTotal").textContent = money([...confirmedBySeries.values()].reduce((sum, q) => sum + numberValue(q.projectPriceTaxed), 0));
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
  const lineHtml = rows.map((row, index) => {
    const included = row.calcMode === "included";
    return `<tr><td>${index + 1}</td><td>${esc(row.eventId === "shared" ? "共用" : eventMap.get(row.eventId) || "—")}</td><td>${esc(row.name)}</td><td class="num">${included ? "—" : money(row.unitPrice)}</td><td class="num">${esc(row.qty)}</td><td>${esc(row.unit || "—")}</td><td class="num">${included ? "—" : esc(row.days || 1)}</td><td class="num">${included ? "—" : money(calcRowSubtotal(row))}</td><td>${esc(row.note || "")}</td></tr>`;
  }).join("");
  const showDates = events.map(event => event.eventDate).filter(Boolean).join("、") || "—";
  const setupDates = events.map(event => event.setupDate).filter(Boolean).join("、") || "—";
  const locations = [...new Set(events.map(event => event.location).filter(Boolean))].join("、") || "—";
  return `<article class="quote-a4">
    <header class="a4-brand-header">
      <img class="a4-logo" src="${esc(COMPANY_LOGO_URL)}" alt="曜炎創意 YAoyan" />
      <div class="a4-title"><strong>報 價 單</strong><span>QUOTATION</span></div>
    </header>
    <table class="a4-info"><tbody>
      <tr><th>客戶名稱<span>Client</span></th><td>${esc(q.customerName)}</td><th>報價日期<span>Quotation Date</span></th><td>${esc(quotationDateText(q))}</td></tr>
      <tr><th>專案名稱<span>Project</span></th><td>${esc(q.projectName)}</td><th>報價編號<span>Quotation No.</span></th><td>${esc(q.number)} / V${esc(q.version || 1)}</td></tr>
      <tr><th>演出日期<span>Date</span></th><td>${esc(showDates)}</td><th>聯絡人<span>Contact Person</span></th><td>${esc(q.contactName || "—")}</td></tr>
      <tr><th>進撤場日期<span>Load-in/Out Dates</span></th><td>${esc(setupDates)}</td><th>聯絡電話<span>Phone</span></th><td>${esc(q.phone || "—")}</td></tr>
      <tr><th>專案地點<span>Location</span></th><td>${esc(locations)}</td><th>聯絡信箱<span>Email</span></th><td>${esc(q.email || "—")}</td></tr>
      <tr><th>客戶統編<span>Tax ID</span></th><td colspan="3">${esc(q.taxId || "—")}</td></tr>
    </tbody></table>
    <table class="a4-lines"><thead><tr><th>編號<span>No.</span></th><th>場次<span>Event</span></th><th>項目<span>Item</span></th><th>單價<span>Price</span></th><th>數量<span>Unit</span></th><th>單位</th><th>天數<span>Day</span></th><th>小計<span>Subtotal</span></th><th>備註<span>Note</span></th></tr></thead><tbody>${lineHtml || `<tr><td colspan="9">尚無報價項目</td></tr>`}</tbody></table>
    <div class="a4-payment-grid">
      <div class="a4-terms-block"><div class="a4-section-title">合作與付款條件 Payment Terms</div><div class="a4-terms">${esc(q.terms || DEFAULT_TERMS)}</div>${q.note ? `<p class="a4-note"><b>備註：</b>${esc(q.note)}</p>` : ""}</div>
      <table class="a4-total"><tbody><tr><th>合計<span>Total</span></th><td class="num">$ ${money(q.subtotal)}</td></tr><tr><th>營業稅<span>5% VAT</span></th><td class="num">$ ${money(q.tax)}</td></tr><tr><th>總計<span>Grand Total</span></th><td class="num">$ ${money(q.originalTotal)}</td></tr><tr class="project-price"><th>專案價（含稅）</th><td class="num">$ ${money(q.projectPriceTaxed)}</td></tr></tbody></table>
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
function listen(name, collectionRef, target) {
  const unsubscribe = onSnapshot(query(collectionRef, orderBy("updatedAt", "desc")), snapshot => {
    state[target] = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    renderAllQuoteModules();
  }, error => {
    console.error(`讀取 ${name} 失敗`, error);
    state[target] = [];
    renderAllQuoteModules();
  });
  state.unsubs.push(unsubscribe);
}

function detach() {
  state.unsubs.forEach(unsubscribe => unsubscribe());
  state.unsubs = [];
  state.customers = [];
  state.quotationItems = [];
  state.quotations = [];
  state.projects = [];
  state.equipment = [];
  renderAllQuoteModules();
}

function attach() {
  listen("customers", collections.customers, "customers");
  listen("quotationItems", collections.quotationItems, "quotationItems");
  listen("quotations", collections.quotations, "quotations");
  listen("projects", collections.projects, "projects");
  listen("equipment", collections.equipment, "equipment");
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
  $("#customerSearch")?.addEventListener("input", renderCustomers);
  $("#customerTableBody")?.addEventListener("click", async event => {
    const edit = event.target.closest("[data-customer-edit]");
    const del = event.target.closest("[data-customer-delete]");
    if (edit) openCustomer(state.customers.find(item => item.id === edit.dataset.customerEdit));
    if (del && canDelete() && confirm("確定刪除此客戶？已建立的歷史報價仍會保留客戶快照。")) {
      const customer = state.customers.find(item => item.id === del.dataset.customerDelete);
      await deleteDoc(doc(db, "customers", del.dataset.customerDelete));
      await logAction({ action: "delete", module: "customers", targetType: "customer", targetId: del.dataset.customerDelete, targetName: customer?.name || "", summary: "永久刪除客戶資料" });
    }
  });

  $("#quoteItemOpenCreate")?.addEventListener("click", () => openQuoteItem());
  $("#quoteItemForm")?.addEventListener("submit", event => { event.preventDefault(); saveQuoteItem(); });
  $$('[data-quote-item-close],#quoteItemDrawerClose').forEach(button => button.addEventListener("click", () => closeDrawer("#quoteItemDrawer")));
  $("#quoteItemSearch")?.addEventListener("input", renderQuoteItems);
  $$('[data-quote-item-sort]').forEach(button => button.addEventListener("click", () => {
    const key = button.dataset.quoteItemSort;
    if (state.quotationItemSort.key === key) state.quotationItemSort.direction = state.quotationItemSort.direction === "asc" ? "desc" : "asc";
    else state.quotationItemSort = { key, direction: key === "unitPrice" ? "desc" : "asc" };
    renderQuoteItems();
  }));
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
  $$('[data-quotation-close],#quotationDrawerClose').forEach(button => button.addEventListener("click", () => closeDrawer("#quotationDrawer")));
  const resetQuotationPageAndRender = () => {
    state.quotationCurrentPage = 1;
    renderQuotations();
  };
  $("#quotationSearch")?.addEventListener("input", resetQuotationPageAndRender);
  $("#quotationStatusFilter")?.addEventListener("change", resetQuotationPageAndRender);
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
  $("#quotationProjectPrice")?.addEventListener("input", recalcQuotation);
  $("#quotationProjectPrice")?.addEventListener("blur", event => { event.target.value = event.target.value ? money(event.target.value) : ""; recalcQuotation(); });
  $("#quotationProjectId")?.addEventListener("change", event => {
    const project = state.projects.find(item => item.id === event.target.value);
    if (!project) return;
    $("#quotationProjectName").value = project.name || "";
    if (!$("#quotationCustomerName").value) $("#quotationCustomerName").value = project.client || "";
    if (state.numberWasSuggested) $("#quotationNumber").value = suggestedNumber(project.startDate);
    const first = $(".quote-event-row", $("#quotationEvents"));
    if (first) {
      $(".event-location", first).value = project.location || "";
      $(".event-date", first).value = project.startDate || "";
      $(".event-setup", first).value = project.startDate && project.endDate ? `${project.startDate}–${project.endDate}` : "";
    }
  });
  $("#quotationCustomerId")?.addEventListener("change", event => {
    const customer = state.customers.find(item => item.id === event.target.value);
    if (!customer) return;
    $("#quotationCustomerName").value = customer.name || "";
    $("#quotationContactName").value = customer.contactName || "";
    $("#quotationPhone").value = customer.phone || "";
    $("#quotationEmail").value = customer.email || "";
    $("#quotationTaxId").value = customer.taxId || "";
  });
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
    if (event.target.matches(".event-date") && state.numberWasSuggested && $$(".event-date", $("#quotationEvents")).indexOf(event.target) === 0) $("#quotationNumber").value = suggestedNumber(event.target.value);
  });
  $("#quotationAddRow")?.addEventListener("click", () => addQuotationRow(rowDataFromCatalog()));
  $("#quotationCatalogPicker")?.addEventListener("change", event => {
    const item = state.quotationItems.find(entry => entry.id === event.target.value);
    if (item) addQuotationRow(rowDataFromCatalog(item));
    event.target.value = "";
  });
  $("#quotationRows")?.addEventListener("click", event => {
    const remove = event.target.closest(".remove-quote-row");
    if (!remove) return;
    remove.closest(".quotation-line").remove();
    if (!$(".quotation-line", $("#quotationRows"))) addQuotationRow(rowDataFromCatalog());
    recalcQuotation();
  });
  $("#quotationRows")?.addEventListener("input", event => {
    const row = event.target.closest(".quotation-line");
    if (!row) return;
    if (event.target.matches(".row-mode")) syncLineMode(row);
    recalcQuotation();
  });
  $("#quotationRows")?.addEventListener("change", event => {
    const row = event.target.closest(".quotation-line");
    if (!row) return;
    if (event.target.matches(".row-mode")) syncLineMode(row);
    recalcQuotation();
  });
  $("#quotationPreviewCurrent")?.addEventListener("click", () => previewQuotation(previewDataFromForm()));
  $("#quotationTableBody")?.addEventListener("click", async event => {
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
    if (sync && quotation) await syncConfirmedQuotationToProject(quotation, quotation.id);
    if (voidButton && quotation && canEdit() && confirm(`確定將 ${quotation.number} / V${quotation.version || 1} 標記為作廢？報價仍會保留供日後回溯。`)) {
      await updateDoc(doc(db, "quotations", quotation.id), { status: "void", updatedAt: serverTimestamp(), updatedBy: state.user.uid });
      await logAction({ action: "void", module: "quotations", targetType: "quotation", targetId: quotation.id, targetName: `${quotation.number} / V${quotation.version || 1}`, summary: `${quotation.customerName || ""}｜${quotation.projectName || ""}` });
    }
    if (del && quotation && canDelete() && confirm(`確定刪除 ${quotation.number} / V${quotation.version || 1}？一般回溯建議使用「作廢」，不要刪除。`)) {
      await deleteDoc(doc(db, "quotations", quotation.id));
      await logAction({ action: "delete", module: "quotations", targetType: "quotation", targetId: quotation.id, targetName: `${quotation.number} / V${quotation.version || 1}`, summary: `${quotation.customerName || ""}｜${quotation.projectName || ""}` });
    }
  });

  document.addEventListener("click", event => {
    const projectButton = event.target.closest("[data-quotation-project]");
    if (!projectButton) return;
    const project = state.projects.find(item => item.id === projectButton.dataset.quotationProject);
    if (!project) return;
    const related = state.quotations.filter(q => q.projectId === project.id);
    if (related.length) {
      switchTab("quotations");
      $("#quotationSearch").value = project.name || project.client || "";
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
    $("#quotationPreviewModal")?.classList.add("hidden");
  });
}

function init() {
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
      state.access = { role: "viewer", permissions: defaultPermissionsForRole("viewer") };
    }
    setMutationButtons();
    attach();
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
