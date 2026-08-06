// app.js (Static-site friendly, imports ONLY from ./firebase.js)
console.log("✅ app.js loaded");

import {
  db,
  watchAuth,
  loginWithGoogle,
  logout,
  getUserAccess,
  hasPermission,
  ensureUserDoc,
  handleRedirectResult
} from "./firebase.js";
import { logAction } from "./audit.js";

import {
  collection, doc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, serverTimestamp, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

/* =========================================================
   0) Helpers
========================================================= */
const $ = (sel, root = document) => root.querySelector(sel);
const $all = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function pad2(n) { return String(n).padStart(2, "0"); }
function toISODate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

function statusLabel(v) {
  const map = {
    planning: "規劃中",
    confirmed: "已成案",
    executing: "執行中",
    closed: "已結案",
    lost: "流標 / 未成案"
  };
  return map[v] || v || "";
}

const PROJECT_STATUSES = ["planning", "confirmed", "executing", "closed", "lost"];
const PROJECTS_PER_PAGE = 20;

function parseIntSafe(v) {
  if (v === "" || v === null || v === undefined) return 0;
  const n = Number(String(v).replace(/,/g, "").trim());
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

function formatMoney(n) {
  if (n === "" || n === null || n === undefined) return "";
  const num = Number(String(n).replace(/,/g, "").trim());
  if (Number.isNaN(num)) return "";
  return num.toLocaleString("zh-TW");
}

/* =========================================================
   1) Tax mode (含稅/未稅) + Revenue(未稅) 計算
========================================================= */
const TAX_RATE = 0.05;

function normalizeTaxMode(v) {
  return (v === "untaxed") ? "untaxed" : "taxed";
}

function toUntaxedFromTaxed(taxedInt) {
  const taxed = parseIntSafe(taxedInt);
  if (!taxed) return 0;
  return Math.round(taxed / (1 + TAX_RATE));
}

function getTaxModeFromProject(p) { return normalizeTaxMode(p?.quoteTaxMode); }
function getTaxModeFromForm() { return normalizeTaxMode(dom.projectQuoteTaxMode()?.value); }

function getRevenueUntaxed(p) {
  const quote = parseIntSafe(p?.quote);
  const mode = getTaxModeFromProject(p);
  if (quote > 0) return (mode === "taxed") ? toUntaxedFromTaxed(quote) : quote;
  return parseIntSafe(p?.revenue);
}

function getProjectTotalTaxed(p) {
  const quote = parseIntSafe(p?.quote);
  if (!quote) return 0;
  return getTaxModeFromProject(p) === "taxed" ? quote : Math.round(quote * (1 + TAX_RATE));
}

function getProjectPaymentSummary(projectId, projectTotalTaxed = 0) {
  const rows = state.payments.filter(payment => payment.projectId === projectId && !payment.voided);
  const scheduled = rows.reduce((sum, payment) => sum + parseIntSafe(payment.amount), 0);
  const invoiced = rows.filter(payment => payment.requestDate).reduce((sum, payment) => sum + parseIntSafe(payment.amount), 0);
  const received = rows.reduce((sum, payment) => sum + parseIntSafe(payment.receivedAmount), 0);
  return {
    scheduled,
    invoiced,
    received,
    // 專案總價未定時，仍計入已請款未收的已知款項（例如活動前訂金）。
    outstanding: projectTotalTaxed
      ? Math.max(0, projectTotalTaxed - received)
      : Math.max(0, invoiced - received)
  };
}

function calcProfit(p) {
  return getRevenueUntaxed(p) - getProjectExternalCost(p);
}

function getProjectExpenses(projectId) {
  return state.expenses.filter(expense => expense.projectId === projectId && !expense.voided);
}

function getExpenseUntaxed(expense) {
  if (parseIntSafe(expense?.costUntaxed)) return parseIntSafe(expense.costUntaxed);
  const amount = parseIntSafe(expense?.amount);
  return expense?.taxMode === "untaxed" ? amount : Math.round(amount / (1 + TAX_RATE));
}

function getProjectExternalCost(project) {
  const rows = getProjectExpenses(project.id);
  return rows.length ? rows.reduce((sum, expense) => sum + getExpenseUntaxed(expense), 0) : parseIntSafe(project.cost);
}

function equipmentDailyDepreciation(equipment) {
  const purchasePrice = parseIntSafe(equipment?.unitPurchasePrice);
  const residualValue = parseIntSafe(equipment?.residualValue);
  const years = Math.max(0, Number(equipment?.depreciationYears) || 0);
  const annualUsageDays = Math.max(0, Number(equipment?.annualUsageDays) || 0);
  if (!purchasePrice || !years || !annualUsageDays || residualValue >= purchasePrice) return null;
  return Math.round((purchasePrice - residualValue) / years / annualUsageDays);
}

function inclusiveProjectDays(project) {
  const start = new Date(`${project?.startDate || ""}T00:00:00`);
  const end = new Date(`${project?.endDate || ""}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 1;
  return Math.floor((end - start) / 86400000) + 1;
}

function projectEquipmentCostEstimate(project) {
  const used = (Array.isArray(project?.equipmentsUsed) ? project.equipmentsUsed : []).filter(item => item?.name && parseIntSafe(item.qty));
  const days = inclusiveProjectDays(project);
  let amount = 0;
  let configured = 0;
  used.forEach(item => {
    const equipment = state.equipments.find(entry => String(entry.name || "").trim() === String(item.name || "").trim());
    const daily = equipmentDailyDepreciation(equipment);
    if (daily === null) return;
    configured += 1;
    amount += daily * parseIntSafe(item.qty) * days;
  });
  return { amount, configured, total: used.length, days };
}

function syncRevenueFromQuoteToInput() {
  const quote = parseIntSafe(dom.projectQuote()?.value);
  const mode = getTaxModeFromForm();

  const untaxed = quote
    ? (mode === "taxed" ? toUntaxedFromTaxed(quote) : quote)
    : 0;

  if (dom.projectRevenue()) dom.projectRevenue().value = quote ? formatMoney(untaxed) : "";
}

function bindMoneyAutoFormat(inputEl) {
  if (!inputEl) return;
  inputEl.addEventListener("blur", () => {
    const n = parseIntSafe(inputEl.value);
    inputEl.value = n ? formatMoney(n) : "";
  });
}

/* =========================================================
   2) DOM
========================================================= */
const dom = {
  todayLabel: () => $("#todayLabel"),
  topbarRight: () =>
    document.querySelector(".topbar-right") ||
    document.querySelector(".topbar") ||
    document.body,

  tabButtons: () => $all(".tab-button"),
  tabPanels: () => $all(".tab-panel"),

  projectForm: () => $("#project-form"),
  projectReset: () => $("#projectReset"),
  projectOpenCreate: () => $("#projectOpenCreate"),
  projectDrawer: () => $("#projectDrawer"),
  projectDrawerTitle: () => $("#projectDrawerTitle"),
  projectDrawerClose: () => $("#projectDrawerClose"),

  projectId: () => $("#projectId"),
  projectName: () => $("#projectName"),
  projectClient: () => $("#projectClient"),
  projectLocation: () => $("#projectLocation"),
  projectStart: () => $("#projectStart"),
  projectEnd: () => $("#projectEnd"),
  projectStatus: () => $("#projectStatus"),

  projectQuote: () => $("#projectQuote"),
  projectQuoteTaxMode: () => $("#projectQuoteTaxMode"),
  projectRevenue: () => $("#projectRevenue"),
  projectCost: () => $("#projectCost"),
  projectNote: () => $("#projectNote"),

  equipUsageBody: () => $("#equipUsageBody"),
  addEquipUsage: () => $("#addEquipUsage"),
  equipUsageCount: () => $("#equipUsageCount"),
  projectSearch: () => $("#projectSearch"),
  projectDateRange: () => $("#projectDateRange"),
  projectStatusFilter: () => $("#projectStatusFilter"),
  projectStatusOptions: () => $("#projectStatusOptions"),
  projectStatusSummary: () => $("#projectStatusSummary"),
  projectFilterChips: () => $("#projectFilterChips"),
  projectClearFilters: () => $("#projectClearFilters"),
  projectSortBy: () => $("#projectSortBy"),
  projectTableBody: () => $("#projectTableBody"),
  projectResultCount: () => $("#projectResultCount"),
  projectPagination: () => $("#projectPagination"),

  equipmentForm: () => $("#equipment-form"),
  equipmentReset: () => $("#equipmentReset"),
  equipmentId: () => $("#equipmentId"),
  equipmentName: () => $("#equipmentName"),
  equipmentCategory: () => $("#equipmentCategory"),
  equipmentQty: () => $("#equipmentQty"),
  equipmentNote: () => $("#equipmentNote"),
  equipmentPurchasePrice: () => $("#equipmentPurchasePrice"),
  equipmentAcquisitionDate: () => $("#equipmentAcquisitionDate"),
  equipmentDepreciationYears: () => $("#equipmentDepreciationYears"),
  equipmentResidualValue: () => $("#equipmentResidualValue"),
  equipmentAnnualUsageDays: () => $("#equipmentAnnualUsageDays"),
  equipmentSearch: () => $("#equipmentSearch"),
  equipmentTableBody: () => $("#equipmentTableBody"),

  calendarMonth: () => $("#calendarMonth"),
  calendarGrid: () => $("#calendarGrid"),
  calendarHint: () => $("#calendarHint"),
  calendarLegend: () => $("#calendarLegend"),
  calendarViewButtons: () => $all("[data-calendar-view]"),

  reportMonth: () => $("#reportMonth"),
  exportCsv: () => $("#exportCsv"),
  reportTableBody: () => $("#reportTableBody"),
  reportTotalRevenue: () => $("#reportTotalRevenue"),
  reportTotalCost: () => $("#reportTotalCost"),
  reportTotalProfit: () => $("#reportTotalProfit"),
  reportTotalInvoiced: () => $("#reportTotalInvoiced"),
  reportTotalReceived: () => $("#reportTotalReceived"),
  reportTotalOutstanding: () => $("#reportTotalOutstanding"),

  // KPI (左大右小)
  kpiMonthRevenue: () => $("#kpiMonthRevenue"),
  kpiMonthProfit: () => $("#kpiMonthProfit"),
  kpiConfirmedQuote: () => $("#kpiConfirmedQuote"),
  kpiReceivedAmount: () => $("#kpiReceivedAmount"),
  kpiClosedRevenue: () => $("#kpiClosedRevenue"),
  kpiMonthProjects: () => $("#kpiMonthProjects"),

  overuseModal: () => $("#overuseModal"),
  overuseModalTitle: () => $("#overuseModalTitle"),
  overuseModalBody: () => $("#overuseModalBody"),
  overuseModalClose: () => $("#overuseModalClose")
};

/* =========================================================
   3) Firestore Collections
========================================================= */
const projectsCol = collection(db, "projects");
const equipmentCol = collection(db, "equipment");
const paymentsCol = collection(db, "payments");
const quotationsCol = collection(db, "quotations");
const expensesCol = collection(db, "expenses");

/* =========================================================
   4) State
========================================================= */
let currentUser = null;
let currentRole = null;
let currentAccess = null;
let unsubProjects = null;
let unsubEquipments = null;
let unsubPayments = null;
let unsubQuotations = null;
let unsubExpenses = null;
let state = { projects: [], equipments: [], payments: [], quotations: [], expenses: [] };
let selectedProjectStatuses = new Set();
let projectCurrentPage = 1;
let equipmentSort = { key: "name", direction: "asc" };
let projectFormDirty = false;
const openProjectIds = new Set();
const CALENDAR_VIEW_STORAGE_KEY = "yaoyan-calendar-view";
let calendarView = (() => {
  try {
    return localStorage.getItem(CALENDAR_VIEW_STORAGE_KEY) === "projects" ? "projects" : "equipment";
  } catch (_) {
    return "equipment";
  }
})();

/* =========================================================
   5) Auth UI
========================================================= */
let authEls = { btn: null, rolePill: null, who: null };

function ensureAuthUI() {
  let host = dom.topbarRight();

  if (!document.querySelector(".topbar-right")) {
    let floating = document.getElementById("auth-fallback");
    if (!floating) {
      floating = document.createElement("div");
      floating.id = "auth-fallback";
      floating.style.position = "fixed";
      floating.style.top = "12px";
      floating.style.right = "12px";
      floating.style.zIndex = "9999";
      document.body.appendChild(floating);
    }
    host = floating;
  }

  if (!host) return;
  if (authEls.btn && authEls.rolePill && authEls.who) return;

  const wrap = document.createElement("div");
  wrap.style.display = "inline-flex";
  wrap.style.flexDirection = "column";
  wrap.style.alignItems = "flex-end";
  wrap.style.gap = "6px";

  const row = document.createElement("div");
  row.style.display = "inline-flex";
  row.style.alignItems = "center";
  row.style.gap = "8px";
  row.style.justifyContent = "flex-end";

  const rolePill = document.createElement("span");
  rolePill.className = "tag";
  rolePill.textContent = "未登入";

  const btn = document.createElement("button");
  btn.className = "btn ghost small";
  btn.type = "button";
  btn.textContent = "Google 登入";

  const who = document.createElement("div");
  who.style.fontSize = "12px";
  who.style.color = "#6b7280";
  who.textContent = "";

  row.appendChild(rolePill);
  row.appendChild(btn);
  wrap.appendChild(row);
  wrap.appendChild(who);

  const existing = Array.from(host.childNodes);
  host.innerHTML = "";
  host.appendChild(wrap);
  existing.forEach(n => host.appendChild(n));

  authEls = { btn, rolePill, who };

  btn.addEventListener("click", async () => {
    try {
      if (currentUser) await logout();
      else await loginWithGoogle();
    } catch (e) {
      console.error(e);
      alert("登入/登出失敗，請看 Console");
    }
  });
}

function updateAuthUI() {
  ensureAuthUI();
  if (!authEls.btn) return;

  if (!currentUser) {
    authEls.rolePill.textContent = "未登入";
    authEls.who.textContent = "請先登入（admin/editor 才能新增）";
    authEls.btn.textContent = "Google 登入";
  } else {
    authEls.rolePill.textContent = (currentRole || "viewer").toUpperCase();
    authEls.who.textContent = currentUser.email || "(unknown)";
    authEls.btn.textContent = "登出";
  }

  const createBtn = dom.projectOpenCreate();
  if (createBtn) {
    createBtn.disabled = !canCreateProject();
    createBtn.title = canCreateProject() ? "新增專案" : "目前沒有新增專案權限";
  }
}

/* =========================================================
   6) Permissions
========================================================= */
function canCreateProject() { return hasPermission(currentAccess, "createProjects"); }
function canUpdateProject() { return hasPermission(currentAccess, "editProjects"); }
function canCreateEquipment() { return hasPermission(currentAccess, "createEquipment"); }
function canUpdateEquipment() { return hasPermission(currentAccess, "editEquipment"); }
function canManageCatalog() { return hasPermission(currentAccess, "manageCatalog"); }
function canDelete() { return currentRole === "admin"; }

/* =========================================================
   7) Segmented Toggle (報價模式) - UI sync
========================================================= */
function setupQuoteTaxModeSegmented() {
  const seg = document.querySelector('[data-seg="quoteTaxMode"]');
  const sel = dom.projectQuoteTaxMode();
  if (!seg || !sel) return;

  function renderSegState() {
    const v = sel.value || "taxed";
    seg.querySelectorAll("button[data-value]").forEach(b => {
      b.classList.toggle("active", b.dataset.value === v);
    });
  }

  renderSegState();

  seg.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-value]");
    if (!btn) return;
    sel.value = btn.dataset.value;
    renderSegState();
    syncRevenueFromQuoteToInput();
  });

  sel.addEventListener("change", () => {
    renderSegState();
    syncRevenueFromQuoteToInput();
  });

  setupQuoteTaxModeSegmented.render = renderSegState;
}

/* =========================================================
   8) Equipment dropdown helpers
========================================================= */
function getEquipmentNameList() {
  return (state.equipments || [])
    .map(e => String(e?.name || "").trim())
    .filter(Boolean);
}

function buildEquipNameSelect(selectedValue = "") {
  const sel = document.createElement("select");
  sel.className = "equip-name";

  const opt0 = document.createElement("option");
  opt0.value = "";
  opt0.textContent = "請選擇設備";
  sel.appendChild(opt0);

  const names = getEquipmentNameList();
  const hasSelected = selectedValue && names.includes(selectedValue);

  if (selectedValue && !hasSelected) {
    const optMissing = document.createElement("option");
    optMissing.value = selectedValue;
    optMissing.textContent = `${selectedValue}（已刪除）`;
    sel.appendChild(optMissing);
  }

  names.forEach(name => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  });

  sel.value = selectedValue || "";
  return sel;
}

function refreshEquipUsageDropdowns() {
  const body = dom.equipUsageBody();
  if (!body) return;

  const rows = $all(".equip-usage-row", body);
  rows.forEach(r => {
    const currentNameEl = r.querySelector(".equip-name");
    if (!currentNameEl) return;

    const currentValue = (currentNameEl.value || "").trim();
    const newSel = buildEquipNameSelect(currentValue);
    currentNameEl.replaceWith(newSel);
  });
}

/* =========================================================
   9) Equip usage rows (dynamic, max 10)
========================================================= */
function updateEquipUsageControls() {
  const count = $all(".equip-usage-row", dom.equipUsageBody()).length;
  if (dom.equipUsageCount()) dom.equipUsageCount().textContent = `${count} / 10`;
  if (dom.addEquipUsage()) dom.addEquipUsage().disabled = count >= 10;
}

function addEquipUsageRow(item = {}) {
  const body = dom.equipUsageBody();
  if (!body || $all(".equip-usage-row", body).length >= 10) return;

  const row = document.createElement("div");
  row.className = "equip-usage-row";

  const nameSel = buildEquipNameSelect(String(item?.name ?? "").trim());
  const qtyInput = document.createElement("input");
  qtyInput.className = "equip-qty";
  qtyInput.type = "number";
  qtyInput.min = "0";
  qtyInput.step = "1";
  qtyInput.placeholder = "數量";
  qtyInput.value = String(item?.qty ?? "");

  const removeBtn = document.createElement("button");
  removeBtn.className = "remove-equip-row";
  removeBtn.type = "button";
  removeBtn.dataset.act = "remove-equip-row";
  removeBtn.setAttribute("aria-label", "移除設備");
  removeBtn.textContent = "✕";

  row.appendChild(nameSel);
  row.appendChild(qtyInput);
  row.appendChild(removeBtn);
  body.appendChild(row);
  updateEquipUsageControls();
}

function renderEquipUsageRows(project = null) {
  const body = dom.equipUsageBody();
  if (!body) return;

  body.innerHTML = "";
  const used = Array.isArray(project?.equipmentsUsed) ? project.equipmentsUsed : [];
  (used.length ? used.slice(0, 10) : [{}]).forEach(addEquipUsageRow);
  updateEquipUsageControls();
}

function readEquipUsageRows() {
  const body = dom.equipUsageBody();
  if (!body) return [];

  const rows = $all(".equip-usage-row", body);
  const result = [];

  rows.forEach(r => {
    const name = (r.querySelector(".equip-name")?.value || "").trim();
    const qtyRaw = r.querySelector(".equip-qty")?.value ?? "";
    const qty = Math.max(0, Math.trunc(Number(qtyRaw) || 0));
    if (name) result.push({ name, qty });
  });

  return result;
}

/* =========================================================
   10) Forms
========================================================= */
function resetProjectForm() {
  dom.projectId() && (dom.projectId().value = "");
  dom.projectName() && (dom.projectName().value = "");
  dom.projectClient() && (dom.projectClient().value = "");
  dom.projectLocation() && (dom.projectLocation().value = "");
  dom.projectStart() && (dom.projectStart().value = "");
  dom.projectEnd() && (dom.projectEnd().value = "");
  dom.projectStatus() && (dom.projectStatus().value = "planning");

  dom.projectQuote() && (dom.projectQuote().value = "");
  dom.projectQuoteTaxMode() && (dom.projectQuoteTaxMode().value = "taxed");
  dom.projectCost() && (dom.projectCost().value = "");
  dom.projectRevenue() && (dom.projectRevenue().value = "");
  dom.projectNote() && (dom.projectNote().value = "");

  renderEquipUsageRows(null);

  syncRevenueFromQuoteToInput();
  setupQuoteTaxModeSegmented.render?.();
  projectFormDirty = false;
}

function fillProjectForm(p) {
  dom.projectId().value = p.id;
  dom.projectName().value = p.name ?? "";
  dom.projectClient().value = p.client ?? "";
  dom.projectLocation().value = p.location ?? "";
  dom.projectStart().value = p.startDate ?? "";
  dom.projectEnd().value = p.endDate ?? "";
  dom.projectStatus().value = p.status ?? "planning";

  dom.projectQuote().value = formatMoney(parseIntSafe(p.quote)) || "";
  dom.projectQuoteTaxMode().value = getTaxModeFromProject(p);
  dom.projectCost().value = formatMoney(parseIntSafe(p.cost)) || "";
  dom.projectNote().value = p.note ?? "";

  renderEquipUsageRows(p);

  syncRevenueFromQuoteToInput();
  setupQuoteTaxModeSegmented.render?.();
  projectFormDirty = false;
}

function openProjectDrawer(project = null, { duplicate = false } = {}) {
  if (!project && !canCreateProject()) return alert("你目前沒有新增專案權限");

  if (project) fillProjectForm(project);
  else resetProjectForm();

  if (duplicate) {
    dom.projectId().value = "";
    dom.projectName().value = `${project.name || "未命名專案"}（複製）`;
  }

  dom.projectDrawerTitle().textContent = project && !duplicate ? "編輯專案" : "新增專案";
  dom.projectDrawer().classList.remove("hidden");
  dom.projectDrawer().setAttribute("aria-hidden", "false");
  document.body.classList.add("drawer-open");
  projectFormDirty = false;
  setTimeout(() => dom.projectName()?.focus(), 80);
}

function closeProjectDrawer({ force = false } = {}) {
  if (!force && projectFormDirty && !confirm("表單尚未儲存，確定要關閉嗎？")) return false;
  dom.projectDrawer()?.classList.add("hidden");
  dom.projectDrawer()?.setAttribute("aria-hidden", "true");
  document.body.classList.remove("drawer-open");
  resetProjectForm();
  return true;
}

function resetEquipmentForm() {
  dom.equipmentId() && (dom.equipmentId().value = "");
  dom.equipmentName() && (dom.equipmentName().value = "");
  dom.equipmentCategory() && (dom.equipmentCategory().value = "");
  dom.equipmentQty() && (dom.equipmentQty().value = "");
  dom.equipmentNote() && (dom.equipmentNote().value = "");
  dom.equipmentPurchasePrice() && (dom.equipmentPurchasePrice().value = "");
  dom.equipmentAcquisitionDate() && (dom.equipmentAcquisitionDate().value = "");
  dom.equipmentDepreciationYears() && (dom.equipmentDepreciationYears().value = "6");
  dom.equipmentResidualValue() && (dom.equipmentResidualValue().value = "");
  dom.equipmentAnnualUsageDays() && (dom.equipmentAnnualUsageDays().value = "");
}

function fillEquipmentForm(e) {
  dom.equipmentId().value = e.id;
  dom.equipmentName().value = e.name ?? "";
  dom.equipmentCategory().value = e.category ?? "";
  dom.equipmentQty().value = Number(e.qty ?? 0) || 0;
  dom.equipmentNote().value = e.note ?? "";
  dom.equipmentPurchasePrice().value = formatMoney(parseIntSafe(e.unitPurchasePrice)) || "";
  dom.equipmentAcquisitionDate().value = e.acquisitionDate || "";
  dom.equipmentDepreciationYears().value = Number(e.depreciationYears) || 6;
  dom.equipmentResidualValue().value = formatMoney(parseIntSafe(e.residualValue)) || "";
  dom.equipmentAnnualUsageDays().value = Number(e.annualUsageDays) || "";
}

/* =========================================================
   10.5) Sync equipment rename -> projects.equipmentsUsed[].name
========================================================= */
async function syncEquipmentNameInProjects(oldName, newName) {
  oldName = String(oldName || "").trim();
  newName = String(newName || "").trim();
  if (!oldName || !newName || oldName === newName) return;

  // 讀取所有專案，找到 equipmentsUsed 內 name=oldName 的就改成 newName
  const snap = await getDocs(query(projectsCol));

  for (const docSnap of snap.docs) {
    const p = docSnap.data();
    const used = Array.isArray(p.equipmentsUsed) ? p.equipmentsUsed : [];
    if (!used.length) continue;

    let changed = false;
    const updated = used.map(item => {
      if (!item) return item;
      const nm = String(item.name || "").trim();
      if (nm === oldName) {
        changed = true;
        return { ...item, name: newName };
      }
      return item;
    });

    if (changed) {
      await updateDoc(doc(db, "projects", docSnap.id), {
        equipmentsUsed: updated,
        updatedAt: serverTimestamp()
      });
    }
  }
}

/* =========================================================
   11) CRUD
========================================================= */
async function upsertProjectFromForm() {
  if (!currentUser) return alert("請先登入再儲存（右上角 Google 登入）");

  const id = dom.projectId().value.trim();
  if (id) {
    if (!canUpdateProject()) return alert("你目前沒有編輯既有專案的權限");
  } else {
    if (!canCreateProject()) return alert("你目前沒有新增專案的權限");
  }

  const name = dom.projectName().value.trim();
  const client = dom.projectClient().value.trim();
  const location = dom.projectLocation().value.trim();
  const startDate = dom.projectStart().value;
  const endDate = dom.projectEnd().value;
  const status = dom.projectStatus().value;

  const quote = parseIntSafe(dom.projectQuote().value);
  const quoteTaxMode = getTaxModeFromForm();
  const revenue = quote ? (quoteTaxMode === "taxed" ? toUntaxedFromTaxed(quote) : quote) : 0;

  const cost = parseIntSafe(dom.projectCost().value);
  const equipmentsUsed = readEquipUsageRows();
  const note = dom.projectNote().value.trim();

  if (!name) return alert("請填寫專案名稱");
  if (!startDate || !endDate) return alert("請填寫專案期間");
  if (endDate < startDate) return alert("結束日期不能早於開始日期");

  const payload = {
    name, client, location,
    startDate, endDate, status,
    quote,
    quoteTaxMode,
    revenue,
    cost,
    equipmentsUsed,
    note,
    updatedAt: serverTimestamp()
  };

  try {
    if (id) {
      await updateDoc(doc(db, "projects", id), payload);
      await logAction({ action: "update", module: "projects", targetType: "project", targetId: id, targetName: name, summary: `更新專案｜${statusLabel(status)}` });
    } else {
      const ref = await addDoc(projectsCol, { ...payload, createdAt: serverTimestamp() });
      await logAction({ action: "create", module: "projects", targetType: "project", targetId: ref.id, targetName: name, summary: `新增專案｜${statusLabel(status)}` });
    }
    projectFormDirty = false;
    closeProjectDrawer({ force: true });
  } catch (e) {
    console.error(e);
    alert("儲存失敗：權限不足或資料不符合 Firestore rules");
  }
}

async function deleteProject(projectId) {
  if (!currentUser) return alert("請先登入");
  if (!canDelete()) return alert("只有 admin 可以刪除");
  if (!confirm("確定要刪除此專案？")) return;

  const project = state.projects.find(item => item.id === projectId);
  try {
    await deleteDoc(doc(db, "projects", projectId));
    await logAction({ action: "delete", module: "projects", targetType: "project", targetId: projectId, targetName: project?.name || "", summary: "永久刪除專案" });
  }
  catch (e) { console.error(e); alert("刪除失敗：請確認權限"); }
}

async function upsertEquipmentFromForm() {
  if (!currentUser) return alert("請先登入再儲存（右上角 Google 登入）");

  const id = dom.equipmentId().value.trim();
  if (id) {
    if (!canUpdateEquipment()) return alert("你目前沒有編輯既有設備的權限");
  } else {
    if (!canCreateEquipment()) return alert("你目前沒有新增設備的權限");
  }

  // ✅ 先抓舊名（改名同步用）
  const oldName = id ? (state.equipments.find(x => x.id === id)?.name || "") : "";

  const name = dom.equipmentName().value.trim();
  const category = dom.equipmentCategory().value.trim();
  const qty = Math.max(0, Math.trunc(Number(dom.equipmentQty().value) || 0));
  const note = dom.equipmentNote().value.trim();
  const unitPurchasePrice = parseIntSafe(dom.equipmentPurchasePrice().value);
  const acquisitionDate = dom.equipmentAcquisitionDate().value;
  const depreciationYears = Math.max(1, Math.trunc(Number(dom.equipmentDepreciationYears().value) || 6));
  const residualValue = parseIntSafe(dom.equipmentResidualValue().value);
  const annualUsageDays = Math.max(0, Math.trunc(Number(dom.equipmentAnnualUsageDays().value) || 0));

  if (!name) return alert("請填寫設備名稱");
  if (unitPurchasePrice && residualValue >= unitPurchasePrice) return alert("預估殘值必須小於購入價");
  if (id && oldName.trim() !== name.trim() && !canUpdateProject()) return alert("設備改名會同步更新所有專案，因此還需要『編輯專案』權限；你仍可修改數量、備註與資產資料。");

  const payload = { name, category, qty, note, unitPurchasePrice, acquisitionDate, depreciationYears, residualValue, annualUsageDays, updatedAt: serverTimestamp() };

  try {
    if (id) {
      await updateDoc(doc(db, "equipment", id), payload);

      // ✅ 如果是改名：同步更新所有專案 equipmentsUsed[].name
      const newName = name;
      if (String(oldName || "").trim() && String(newName || "").trim() && oldName.trim() !== newName.trim()) {
        await syncEquipmentNameInProjects(oldName, newName);
      }
      await logAction({ action: "update", module: "equipment", targetType: "equipment", targetId: id, targetName: name, summary: oldName && oldName !== name ? `設備更名：${oldName} → ${name}` : `${category || "未分類"}｜更新數量為 ${qty}` });
    } else {
      const ref = await addDoc(equipmentCol, { ...payload, createdAt: serverTimestamp() });
      await logAction({ action: "create", module: "equipment", targetType: "equipment", targetId: ref.id, targetName: name, summary: `新增設備｜${category || "未分類"}｜數量 ${qty}` });
    }

    resetEquipmentForm();
  } catch (e) {
    console.error(e);
    alert("儲存失敗：權限不足或資料不符合 Firestore rules");
  }
}

async function deleteEquipment(equipmentId) {
  if (!currentUser) return alert("請先登入");
  if (!canDelete()) return alert("只有 admin 可以刪除");
  if (!confirm("確定要刪除此設備？")) return;

  const equipment = state.equipments.find(item => item.id === equipmentId);
  try {
    await deleteDoc(doc(db, "equipment", equipmentId));
    await logAction({ action: "delete", module: "equipment", targetType: "equipment", targetId: equipmentId, targetName: equipment?.name || "", summary: "永久刪除設備" });
  }
  catch (e) { console.error(e); alert("刪除失敗：請確認權限"); }
}

/* =========================================================
   12) Renders - Projects / Equipments (Master-Detail)
========================================================= */
function statusToBadgeClass(statusKey) {
  if (statusKey === "closed") return "green";
  if (statusKey === "confirmed") return "orange";
  if (statusKey === "executing") return "blue";
  if (statusKey === "lost") return "red";
  return "neutral";
}

function renderEquipmentsUsedHtml(p) {
  const list = Array.isArray(p.equipmentsUsed) ? p.equipmentsUsed : [];
  const items = list
    .filter(x => x && String(x.name || "").trim())
    .map(x => `${escapeHtml(String(x.name).trim())} × <b>${escapeHtml(String(x.qty ?? 0))}</b>`);
  if (!items.length) return "—";
  return items.join("<br>");
}

function quotationStatusLabel(status) {
  return ({ draft: "草稿", sent: "已寄出", confirmed: "已確認", void: "已作廢" })[status] || status || "—";
}

function quotationStatusBadge(status) {
  return ({ draft: "neutral", sent: "blue", confirmed: "green", void: "red" })[status] || "neutral";
}

function paymentTypeLabel(type) {
  return ({ deposit: "訂金", balance: "尾款", full: "全額款", other: "其他" })[type] || "其他";
}

function paymentRecordStatus(payment) {
  if (payment.voided) return { key: "void", label: "已作廢", badge: "red" };
  const amount = parseIntSafe(payment.amount);
  const received = parseIntSafe(payment.receivedAmount);
  if (amount > 0 && received >= amount) return { key: "paid", label: "已收款", badge: "green" };
  if (payment.requestDate && payment.expectedPaymentDate && payment.expectedPaymentDate < toISODate(new Date())) {
    return { key: "overdue", label: "逾期未收", badge: "red" };
  }
  if (received > 0) return { key: "partial", label: "部分收款", badge: "blue" };
  if (payment.requestDate) return { key: "requested", label: "已請款待收", badge: "orange" };
  return { key: "pending", label: "待請款", badge: "neutral" };
}

function timestampValue(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function timestampDateText(value) {
  if (!value) return "—";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return toISODate(date);
}

function projectQuotations(projectId) {
  return state.quotations
    .filter(quotation => quotation.projectId === projectId)
    .sort((a, b) => {
      const numberCompare = String(b.number || "").localeCompare(String(a.number || ""), "zh-Hant", { numeric: true });
      if (numberCompare) return numberCompare;
      const versionCompare = Number(b.version || 1) - Number(a.version || 1);
      return versionCompare || timestampValue(b.updatedAt || b.createdAt) - timestampValue(a.updatedAt || a.createdAt);
    });
}

function projectCollectionStatus(project, paymentSummary) {
  const rows = state.payments.filter(payment => payment.projectId === project.id && !payment.voided);
  if (!rows.length) return { label: "尚未建立款項", badge: "neutral", sub: "可先收訂金或結案後一次請款" };
  if (paymentSummary.received >= getProjectTotalTaxed(project) && getProjectTotalTaxed(project) > 0) {
    return { label: "已收款", badge: "green", sub: `共 ${rows.length} 筆款項` };
  }
  if (rows.some(payment => paymentRecordStatus(payment).key === "overdue")) {
    return { label: "逾期未收", badge: "red", sub: `尚未收款 ${formatMoney(paymentSummary.outstanding)}` };
  }
  if (paymentSummary.received > 0) {
    return { label: "部分收款", badge: "blue", sub: `尚未收款 ${formatMoney(paymentSummary.outstanding)}` };
  }
  if (paymentSummary.invoiced > 0) {
    return { label: "已請款待收", badge: "orange", sub: `已請款 ${formatMoney(paymentSummary.invoiced)}` };
  }
  return { label: "待請款", badge: "neutral", sub: `已排定 ${formatMoney(paymentSummary.scheduled)}` };
}

function renderProjectQuotationsHtml(projectId) {
  const rows = projectQuotations(projectId);
  if (!rows.length) return `<div class="project-detail-empty">尚未建立或連結報價。</div>`;

  return `<div class="project-detail-table-scroll"><table class="project-detail-table quotation-history-table">
    <thead><tr><th>報價編號</th><th>版本</th><th>狀態</th><th class="num">專案價（含稅）</th><th>更新日</th></tr></thead>
    <tbody>${rows.map((quotation, index) => `<tr>
      <td><b>${escapeHtml(quotation.number || "—")}</b></td>
      <td>V${escapeHtml(quotation.version || 1)}${index === 0 ? '<span class="detail-latest-tag">最新</span>' : ""}</td>
      <td><span class="badge ${quotationStatusBadge(quotation.status)}">${escapeHtml(quotationStatusLabel(quotation.status))}</span></td>
      <td class="num">${escapeHtml(formatMoney(parseIntSafe(quotation.projectPriceTaxed)))}</td>
      <td>${escapeHtml(timestampDateText(quotation.updatedAt || quotation.createdAt))}</td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function renderProjectPaymentsHtml(projectId) {
  const rows = state.payments
    .filter(payment => payment.projectId === projectId)
    .sort((a, b) => String(a.requestDate || a.expectedPaymentDate || "").localeCompare(String(b.requestDate || b.expectedPaymentDate || "")) || timestampValue(a.createdAt) - timestampValue(b.createdAt));
  if (!rows.length) return `<div class="project-detail-empty">尚未建立款項。可依實際情況新增訂金、尾款或全額款。</div>`;

  return `<div class="project-detail-table-scroll"><table class="project-detail-table project-payment-history-table">
    <thead><tr><th>款項</th><th class="num">應收</th><th>請款／發票</th><th>預計收款</th><th class="num">已收／日期</th><th class="num">未收</th><th>狀態</th></tr></thead>
    <tbody>${rows.map(payment => {
      const status = paymentRecordStatus(payment);
      const remaining = Math.max(0, parseIntSafe(payment.amount) - parseIntSafe(payment.receivedAmount));
      return `<tr class="${payment.voided ? "project-payment-void" : ""}">
        <td><b>${escapeHtml(payment.label || paymentTypeLabel(payment.paymentType))}</b><div class="table-sub">${escapeHtml(paymentTypeLabel(payment.paymentType))}</div></td>
        <td class="num">${escapeHtml(formatMoney(parseIntSafe(payment.amount)))}</td>
        <td>${escapeHtml(payment.requestDate || "—")}<div class="table-sub">發票：${escapeHtml(payment.invoiceNumber || "—")}${payment.invoiceDate ? `｜${escapeHtml(payment.invoiceDate)}` : ""}</div></td>
        <td>${escapeHtml(payment.expectedPaymentDate || "—")}</td>
        <td class="num">${escapeHtml(formatMoney(parseIntSafe(payment.receivedAmount)))}<div class="table-sub">${escapeHtml(payment.receivedDate || "—")}</div></td>
        <td class="num">${escapeHtml(formatMoney(remaining))}</td>
        <td><span class="badge ${status.badge}">${escapeHtml(status.label)}</span></td>
      </tr>`;
    }).join("")}</tbody>
  </table></div>`;
}

function expenseCategoryLabel(value) {
  return ({ outsourcing_equipment: "外包設備", temporary_staff: "臨時人力", transport: "運輸", consumables: "耗材", venue: "場租／其他場地費", other: "其他" })[value] || "其他";
}

function renderProjectExpensesHtml(project) {
  const rows = getProjectExpenses(project.id).sort((a, b) => String(b.expenseDate || "").localeCompare(String(a.expenseDate || "")));
  if (!rows.length) {
    const legacy = parseIntSafe(project.cost);
    return `<div class="project-detail-empty">${legacy ? `目前沿用專案手動外部支出合計 ${escapeHtml(formatMoney(legacy))} 元；尚無逐筆明細。` : "尚未登記外部支出；設備折舊及固定費用也尚未納入。"}</div>`;
  }
  return `<div class="project-detail-table-scroll"><table class="project-detail-table project-expense-history-table">
    <thead><tr><th>日期</th><th>類別</th><th>廠商／收款方</th><th class="num">支出金額</th><th>稅別</th><th class="num">未稅成本</th><th>備註</th></tr></thead>
    <tbody>${rows.map(expense => `<tr><td>${escapeHtml(expense.expenseDate || "—")}</td><td>${escapeHtml(expenseCategoryLabel(expense.category))}</td><td>${escapeHtml(expense.vendor || "—")}</td><td class="num">${escapeHtml(formatMoney(expense.amount))}</td><td>${expense.taxMode === "untaxed" ? "未稅" : "含稅"}</td><td class="num"><b>${escapeHtml(formatMoney(getExpenseUntaxed(expense)))}</b></td><td>${escapeHtml(expense.note || "—")}</td></tr>`).join("")}</tbody>
  </table></div>`;
}

function toggleProjectDetails(projectId, forceOpen) {
  const body = dom.projectTableBody();
  if (!body) return;

  const row = body.querySelector(`tr.project-row[data-id="${CSS.escape(projectId)}"]`);
  const detail = body.querySelector(`tr.details-row[data-details-for="${CSS.escape(projectId)}"]`);
  if (!row || !detail) return;

  const isOpen = detail.style.display !== "none";
  const nextOpen = typeof forceOpen === "boolean" ? forceOpen : !isOpen;

  detail.style.display = nextOpen ? "" : "none";
  row.classList.toggle("is-open", nextOpen);
  if (nextOpen) openProjectIds.add(projectId);
  else openProjectIds.delete(projectId);

  if (nextOpen) row.scrollIntoView({ behavior: "smooth", block: "center" });
}

function getSelectedStatusLabels() {
  return PROJECT_STATUSES.filter(s => selectedProjectStatuses.has(s)).map(statusLabel);
}

function updateProjectFilterUi() {
  const labels = getSelectedStatusLabels();
  if (dom.projectStatusSummary()) {
    dom.projectStatusSummary().textContent = labels.length ? `已選 ${labels.length} 項` : "全部狀態";
  }

  if (dom.projectFilterChips()) {
    dom.projectFilterChips().innerHTML = PROJECT_STATUSES
      .filter(s => selectedProjectStatuses.has(s))
      .map(s => `<button type="button" data-remove-status="${escapeHtml(s)}">${escapeHtml(statusLabel(s))} <span>✕</span></button>`)
      .join("");
  }

  const counts = Object.fromEntries(PROJECT_STATUSES.map(s => [s, 0]));
  state.projects.forEach(p => { if (p.status in counts) counts[p.status] += 1; });
  $all("[data-count]", dom.projectStatusOptions()).forEach(el => {
    el.textContent = String(counts[el.dataset.count] || 0);
  });

  const hasFilters = Boolean(
    dom.projectSearch()?.value.trim() ||
    dom.projectDateRange()?.value !== "all" ||
    selectedProjectStatuses.size
  );
  dom.projectClearFilters()?.classList.toggle("hidden", !hasFilters);
}

function getProjectDateFilterRange() {
  const mode = dom.projectDateRange()?.value || "all";
  if (mode === "all") return null;

  const now = new Date();
  let start;
  let end;

  if (mode === "month") {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  } else if (mode === "next3") {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    end = new Date(now.getFullYear(), now.getMonth() + 3, now.getDate());
  } else {
    start = new Date(now.getFullYear(), 0, 1);
    end = new Date(now.getFullYear(), 11, 31);
  }

  return { start: toISODate(start), end: toISODate(end) };
}

function getFilteredSortedProjects() {
  const keyword = (dom.projectSearch()?.value || "").trim().toLocaleLowerCase("zh-Hant");
  const dateRange = getProjectDateFilterRange();

  const list = state.projects.filter(p => {
    if (keyword) {
      const haystack = [p.name, p.client, p.location].join(" ").toLocaleLowerCase("zh-Hant");
      if (!haystack.includes(keyword)) return false;
    }
    if (selectedProjectStatuses.size && !selectedProjectStatuses.has(p.status)) return false;
    if (dateRange) {
      if (!p.startDate || !p.endDate) return false;
      if (p.endDate < dateRange.start || p.startDate > dateRange.end) return false;
    }
    return true;
  });

  const sortBy = dom.projectSortBy()?.value ?? "updatedDesc";
  if (sortBy === "startAsc" || sortBy === "startDesc") {
    const direction = sortBy === "startAsc" ? 1 : -1;
    list.sort((a, b) => {
      if (!a.startDate && !b.startDate) return 0;
      if (!a.startDate) return 1;
      if (!b.startDate) return -1;
      return a.startDate.localeCompare(b.startDate) * direction;
    });
  }
  return list;
}

function renderProjectPagination(totalItems) {
  const host = dom.projectPagination();
  if (!host) return;
  const totalPages = Math.max(1, Math.ceil(totalItems / PROJECTS_PER_PAGE));
  projectCurrentPage = Math.min(Math.max(1, projectCurrentPage), totalPages);
  if (totalPages <= 1) {
    host.innerHTML = "";
    return;
  }

  const visiblePages = new Set([1, totalPages]);
  for (let page = projectCurrentPage - 2; page <= projectCurrentPage + 2; page += 1) {
    if (page >= 1 && page <= totalPages) visiblePages.add(page);
  }
  const pageButtons = [...visiblePages].sort((a, b) => a - b).map((page, index, pages) => {
    const gap = index > 0 && page - pages[index - 1] > 1 ? `<span class="pagination-ellipsis" aria-hidden="true">…</span>` : "";
    return `${gap}<button class="page-number ${page === projectCurrentPage ? "active" : ""}" type="button" data-page="${page}" ${page === projectCurrentPage ? 'aria-current="page"' : ""}>${page}</button>`;
  }).join("");
  const pageOptions = Array.from({ length: totalPages }, (_, index) => index + 1)
    .map(page => `<option value="${page}" ${page === projectCurrentPage ? "selected" : ""}>${page}</option>`).join("");

  host.innerHTML = `
    <button class="page-direction" type="button" data-page="${projectCurrentPage - 1}" ${projectCurrentPage === 1 ? "disabled" : ""}>上一頁</button>
    <div class="pagination-pages">${pageButtons}</div>
    <span class="pagination-summary">第 ${projectCurrentPage} / ${totalPages} 頁</span>
    <label class="pagination-jump"><span>跳至</span><select data-page-select aria-label="選擇專案頁數">${pageOptions}</select><span>頁</span></label>
    <button class="page-direction" type="button" data-page="${projectCurrentPage + 1}" ${projectCurrentPage === totalPages ? "disabled" : ""}>下一頁</button>
  `;
}

function renderProjectsTable() {
  const body = dom.projectTableBody();
  if (!body) return;

  updateProjectFilterUi();
  const list = getFilteredSortedProjects();
  const totalPages = Math.max(1, Math.ceil(list.length / PROJECTS_PER_PAGE));
  projectCurrentPage = Math.min(projectCurrentPage, totalPages);
  const startIndex = (projectCurrentPage - 1) * PROJECTS_PER_PAGE;
  const pageList = list.slice(startIndex, startIndex + PROJECTS_PER_PAGE);

  if (dom.projectResultCount()) {
    const range = list.length ? `（顯示 ${startIndex + 1}–${Math.min(startIndex + PROJECTS_PER_PAGE, list.length)}）` : "";
    dom.projectResultCount().textContent = `共 ${list.length} 個專案${range}`;
  }
  renderProjectPagination(list.length);
  body.innerHTML = "";

  if (!pageList.length) {
    body.innerHTML = `<tr><td colspan="5"><div class="empty-state">找不到符合條件的專案</div></td></tr>`;
    return;
  }

  pageList.forEach(p => {
    const period = `${p.startDate || ""} ~ ${p.endDate || ""}`;
    const revenueUntaxed = getRevenueUntaxed(p);
    const cost = getProjectExternalCost(p);
    const profit = revenueUntaxed - cost;
    const equipmentCostEstimate = projectEquipmentCostEstimate(p);
    const hasConfirmedPrice = parseIntSafe(p.quote) > 0;
    const projectTotalTaxed = getProjectTotalTaxed(p);
    const paymentSummary = getProjectPaymentSummary(p.id, projectTotalTaxed);
    const collectionStatus = projectCollectionStatus(p, paymentSummary);
    const relatedQuotations = projectQuotations(p.id);
    const latestQuotation = relatedQuotations[0] || null;
    const confirmedQuotation = relatedQuotations.find(quotation => quotation.status === "confirmed") || null;
    const quoteStatus = confirmedQuotation
      ? {
          label: "已確認",
          badge: "green",
          sub: `${confirmedQuotation.number || "報價"} V${confirmedQuotation.version || 1}${latestQuotation && latestQuotation.id !== confirmedQuotation.id ? `｜另有 ${quotationStatusLabel(latestQuotation.status)} V${latestQuotation.version || 1}` : ""}`
        }
      : latestQuotation
        ? { label: quotationStatusLabel(latestQuotation.status), badge: quotationStatusBadge(latestQuotation.status), sub: `${latestQuotation.number || "報價"} V${latestQuotation.version || 1}` }
        : { label: "尚未建立", badge: "neutral", sub: "尚無連結報價" };

    const badgeClass = statusToBadgeClass(p.status);
    const statusText = statusLabel(p.status);

    const trMain = document.createElement("tr");
    trMain.className = "project-row";
    trMain.dataset.id = p.id;

    trMain.innerHTML = `
      <td>
        <div class="project-title">
          <div class="name">${escapeHtml(p.name || "")}${p.note ? '<span class="note-dot" title="有備註">備註</span>' : ""}</div>
          <div class="client">${escapeHtml(p.client || "—")}</div>
        </div>
      </td>
      <td><div class="period">${escapeHtml(period)}</div><div class="table-sub">${escapeHtml(p.location || "—")}</div></td>
      <td><span class="badge ${badgeClass}">${escapeHtml(statusText)}</span></td>
      <td class="money">
        <div class="big ${hasConfirmedPrice ? "" : "pending-value"}">${hasConfirmedPrice ? escapeHtml(formatMoney(profit)) : "待確認"}</div>
        <div class="muted">營收 ${hasConfirmedPrice ? escapeHtml(formatMoney(revenueUntaxed)) : "待確認"}｜外部支出 ${escapeHtml(formatMoney(cost))}</div>
      </td>
      <td style="width:56px; text-align:right;">
        <button class="expand-btn" type="button" data-act="toggle" data-id="${escapeHtml(p.id)}" aria-label="展開">
          <span class="chev">⌄</span>
        </button>
      </td>
    `;

    const trDetail = document.createElement("tr");
    trDetail.className = "details-row";
    trDetail.dataset.detailsFor = p.id;
    trDetail.style.display = openProjectIds.has(p.id) ? "" : "none";
    trMain.classList.toggle("is-open", openProjectIds.has(p.id));

    trDetail.innerHTML = `
      <td colspan="5">
        <div class="details-panel">
          <div class="project-detail-heading">
            <div><span>完整專案狀態</span><h3>${escapeHtml(p.name || "未命名專案")}</h3></div>
            <span class="badge ${badgeClass}">${escapeHtml(statusText)}</span>
          </div>

          <div class="project-status-cards">
            <div class="project-status-card"><span>案況</span><b><span class="badge ${badgeClass}">${escapeHtml(statusText)}</span></b><small>${escapeHtml(p.startDate || "日期未填")}～${escapeHtml(p.endDate || "日期未填")}</small></div>
            <div class="project-status-card"><span>報價狀態</span><b><span class="badge ${quoteStatus.badge}">${escapeHtml(quoteStatus.label)}</span></b><small>${escapeHtml(quoteStatus.sub)}</small></div>
            <div class="project-status-card"><span>請款進度</span><b>${escapeHtml(formatMoney(paymentSummary.invoiced))}</b><small>${paymentSummary.scheduled ? `已排定 ${escapeHtml(formatMoney(paymentSummary.scheduled))}` : "尚未建立款項"}</small></div>
            <div class="project-status-card"><span>收款狀態</span><b><span class="badge ${collectionStatus.badge}">${escapeHtml(collectionStatus.label)}</span></b><small>${escapeHtml(collectionStatus.sub)}</small></div>
          </div>

          <section class="project-detail-section">
            <h4>基本資料</h4>
            <div class="details-grid">
              <div>
                <div class="kv"><div class="k">客戶</div><div class="v">${escapeHtml(p.client || "—")}</div></div>
                <div class="kv"><div class="k">活動日期</div><div class="v">${escapeHtml(p.startDate || "—")}～${escapeHtml(p.endDate || "—")}</div></div>
              </div>
              <div>
                <div class="kv"><div class="k">地點</div><div class="v">${escapeHtml(p.location || "—")}</div></div>
                <div class="kv"><div class="k">案況</div><div class="v">${escapeHtml(statusText)}</div></div>
              </div>
            </div>
          </section>

          <section class="project-detail-section">
            <h4>金額總覽</h4>
            <div class="project-finance-grid">
              <div><span>專案價（含稅）</span><b>${hasConfirmedPrice ? escapeHtml(formatMoney(projectTotalTaxed)) : '<em class="pending-value">待確認</em>'}</b></div>
              <div><span>營收（未稅）</span><b>${hasConfirmedPrice ? escapeHtml(formatMoney(revenueUntaxed)) : '<em class="pending-value">待確認</em>'}</b></div>
              <div><span>外部支出</span><b>${escapeHtml(formatMoney(cost))}</b></div>
              <div><span>案件毛利</span><b>${hasConfirmedPrice ? escapeHtml(formatMoney(profit)) : '<em class="pending-value">待確認</em>'}</b><small>未扣設備折舊及固定費用</small></div>
              <div><span>設備分攤估算</span><b>${equipmentCostEstimate.configured ? escapeHtml(formatMoney(equipmentCostEstimate.amount)) : '<em class="pending-value">尚未估算</em>'}</b><small>${equipmentCostEstimate.total ? `已設定 ${equipmentCostEstimate.configured}/${equipmentCostEstimate.total} 項｜${equipmentCostEstimate.days} 天；不列入案件毛利` : "專案未使用設備"}</small></div>
              <div><span>已請款</span><b>${escapeHtml(formatMoney(paymentSummary.invoiced))}</b></div>
              <div><span>已收款</span><b>${escapeHtml(formatMoney(paymentSummary.received))}</b></div>
              <div class="outstanding"><span>尚未收款</span><b>${escapeHtml(formatMoney(paymentSummary.outstanding))}</b></div>
            </div>
          </section>

          <section class="project-detail-section">
            <div class="project-detail-section-head"><h4>報價紀錄</h4><button class="btn-sm" type="button" data-quotation-project="${escapeHtml(p.id)}">建立／查看報價</button></div>
            ${renderProjectQuotationsHtml(p.id)}
          </section>

          <section class="project-detail-section">
            <div class="project-detail-section-head"><h4>請款、發票與收款</h4><button class="btn-sm" type="button" data-payment-project="${escapeHtml(p.id)}">管理款項</button></div>
            ${renderProjectPaymentsHtml(p.id)}
          </section>

          <section class="project-detail-section">
            <div class="project-detail-section-head"><h4>外部支出</h4><button class="btn-sm" type="button" data-finance-project="${escapeHtml(p.id)}">管理外部支出</button></div>
            ${renderProjectExpensesHtml(p)}
          </section>

          <section class="project-detail-section project-detail-last">
            <h4>執行資訊</h4>
            <div class="details-grid">
              <div><div class="kv"><div class="k">設備</div><div class="v">${renderEquipmentsUsedHtml(p)}</div></div></div>
              <div><div class="kv note-kv"><div class="k">備註</div><div class="v note-text">${escapeHtml(p.note || "—")}</div></div></div>
            </div>
          </section>

          <div class="details-actions">
            <button class="btn-sm primary" type="button" data-act="edit" data-id="${escapeHtml(p.id)}" ${canUpdateProject() ? "" : "disabled"}>編輯</button>
            <button class="btn-sm" type="button" data-act="duplicate" data-id="${escapeHtml(p.id)}" ${canCreateProject() ? "" : "disabled"}>複製專案</button>
            <button class="btn-sm" type="button" data-act="del" data-id="${escapeHtml(p.id)}" ${canDelete() ? "" : "disabled"}>刪除</button>
            <button class="btn-sm" type="button" data-act="collapse" data-id="${escapeHtml(p.id)}">收合</button>
          </div>
        </div>
      </td>
    `;

    body.appendChild(trMain);
    body.appendChild(trDetail);
  });
}

function renderEquipmentsTable() {
  const body = dom.equipmentTableBody();
  if (!body) return;

  body.innerHTML = "";
  const keyword = (dom.equipmentSearch()?.value || "").trim().toLocaleLowerCase("zh-Hant");
  const list = state.equipments
    .filter(e => !keyword || [e.category, e.name, e.note].join(" ").toLocaleLowerCase("zh-Hant").includes(keyword))
    .sort((a, b) => {
      let result;
      if (equipmentSort.key === "qty") result = (Number(a.qty) || 0) - (Number(b.qty) || 0);
      else if (equipmentSort.key === "category") result = String(a.category || "未分類").localeCompare(String(b.category || "未分類"), "zh-Hant", { numeric: true, sensitivity: "base" });
      else result = String(a.name || "").localeCompare(String(b.name || ""), "zh-Hant", { numeric: true, sensitivity: "base" });
      if (!result && equipmentSort.key !== "name") result = String(a.name || "").localeCompare(String(b.name || ""), "zh-Hant", { numeric: true, sensitivity: "base" });
      return equipmentSort.direction === "asc" ? result : -result;
    });

  $all("[data-equipment-sort]").forEach(btn => {
    const active = btn.dataset.equipmentSort === equipmentSort.key;
    btn.classList.toggle("active", active);
    const indicator = btn.querySelector("span");
    if (indicator) indicator.textContent = active ? (equipmentSort.direction === "asc" ? "↑" : "↓") : "";
  });

  if (!list.length) {
    body.innerHTML = `<tr><td colspan="7"><div class="empty-state">找不到符合條件的設備</div></td></tr>`;
    return;
  }

  list.forEach(e => {
    const dailyDepreciation = equipmentDailyDepreciation(e);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><span class="badge neutral">${escapeHtml(e.category || "未分類")}</span></td>
      <td>${escapeHtml(e.name)}</td>
      <td class="num">${escapeHtml(String(e.qty ?? 0))}</td>
      <td>${parseIntSafe(e.unitPurchasePrice) ? `購入價 ${escapeHtml(formatMoney(e.unitPurchasePrice))}<div class="table-sub">${escapeHtml(e.acquisitionDate || "購入日未填")}｜${escapeHtml(String(e.depreciationYears || 6))} 年｜殘值 ${escapeHtml(formatMoney(e.residualValue || 0))}</div>` : '<span class="pending-value">尚未設定</span>'}</td>
      <td class="num">${dailyDepreciation === null ? '<span class="pending-value">尚未估算</span>' : `<b>${escapeHtml(formatMoney(dailyDepreciation))}</b><div class="table-sub">預估 ${escapeHtml(String(e.annualUsageDays))} 天／年</div>`}</td>
      <td>${escapeHtml(e.note ?? "")}</td>
      <td>
        <div class="row-actions">
          <button class="btn ghost small" type="button" data-act="catalog-eq" data-id="${escapeHtml(e.id)}" ${canManageCatalog() ? "" : "disabled"}>建立報價項目</button>
          <button class="btn ghost small" type="button" data-act="edit-eq" data-id="${escapeHtml(e.id)}" ${canUpdateEquipment() ? "" : "disabled"}>編輯</button>
          <button class="btn ghost small" type="button" data-act="del-eq" data-id="${escapeHtml(e.id)}" ${canDelete() ? "" : "disabled"}>刪除</button>
        </div>
      </td>
    `;
    body.appendChild(tr);
  });
}

/* =========================================================
   13) Calendar overuse
========================================================= */
function isBetweenInclusive(dateISO, startISO, endISO) {
  return dateISO >= startISO && dateISO <= endISO;
}
function getProjectsForDate(dateISO) {
  const statusOrder = { executing: 0, confirmed: 1, planning: 2, closed: 3, lost: 4 };
  return state.projects
    .filter(p => {
      const start = p.startDate || "";
      const end = p.endDate || start;
      return start && isBetweenInclusive(dateISO, start, end);
    })
    .sort((a, b) => {
      const byStatus = (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9);
      if (byStatus) return byStatus;
      const byStart = String(a.startDate || "").localeCompare(String(b.startDate || ""));
      if (byStart) return byStart;
      return String(a.name || "").localeCompare(String(b.name || ""), "zh-Hant");
    });
}
function buildInventoryMap() {
  const map = new Map();
  state.equipments.forEach(e => {
    const name = String(e.name || "").trim();
    if (name) map.set(name, Number(e.qty) || 0);
  });
  return map;
}
function computeUsageForDate(dateISO) {
  const usage = new Map();
  const activeProjects = getProjectsForDate(dateISO);

  activeProjects.forEach(p => {
    (p.equipmentsUsed || []).forEach(item => {
      const ename = String(item.name || "").trim();
      const qty = Number(item.qty) || 0;
      if (!ename || qty <= 0) return;

      if (!usage.has(ename)) usage.set(ename, { required: 0, projects: [] });
      const u = usage.get(ename);
      u.required += qty;
      u.projects.push({ projectName: p.name || "(未命名)", qty, projectId: p.id });
    });
  });

  return { usage, activeProjects };
}

let monthOveruseCache = { month: "", byDate: new Map() };

function buildMonthOveruse(monthValue) {
  const inv = buildInventoryMap();
  const byDate = new Map();

  const [y, m] = monthValue.split("-").map(Number);
  if (!y || !m) return { byDate };

  const first = new Date(y, m - 1, 1);
  const last = new Date(y, m, 0);

  for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
    const dateISO = toISODate(d);
    const { usage } = computeUsageForDate(dateISO);

    const overList = [];
    for (const [equip, u] of usage.entries()) {
      const available = inv.has(equip) ? inv.get(equip) : 0;
      if (u.required > available) {
        overList.push({ equip, required: u.required, available, projects: u.projects });
      }
    }
    if (overList.length) byDate.set(dateISO, { over: overList });
  }

  return { byDate };
}

function setCalendarView(nextView) {
  calendarView = nextView === "projects" ? "projects" : "equipment";
  try { localStorage.setItem(CALENDAR_VIEW_STORAGE_KEY, calendarView); } catch (_) {}
  renderCalendar();
}

function renderCalendarLegend() {
  const legend = dom.calendarLegend();
  if (!legend) return;
  if (calendarView === "projects") {
    legend.innerHTML = `
      <span class="calendar-legend-item"><i class="calendar-legend-dot planning"></i>規劃中</span>
      <span class="calendar-legend-item"><i class="calendar-legend-dot confirmed"></i>已成案</span>
      <span class="calendar-legend-item"><i class="calendar-legend-dot executing"></i>執行中</span>
      <span class="calendar-legend-item"><i class="calendar-legend-dot closed"></i>已結案</span>
      <span class="calendar-legend-item"><i class="calendar-legend-dot lost"></i>流標／未成案</span>
    `;
  } else {
    legend.innerHTML = `
      <span class="calendar-legend-item"><i class="calendar-legend-dot scheduled"></i>設備已有排程</span>
      <span class="calendar-legend-item"><i class="calendar-legend-dot overbooked"></i>需求超過庫存</span>
    `;
  }
}

function renderCalendar() {
  const grid = dom.calendarGrid();
  const monthInput = dom.calendarMonth();
  if (!grid || !monthInput) return;

  const monthValue = monthInput.value;
  if (!monthValue) return;

  dom.calendarViewButtons().forEach(btn => {
    const isActive = btn.dataset.calendarView === calendarView;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-pressed", String(isActive));
  });
  grid.dataset.view = calendarView;
  if (dom.calendarHint()) {
    dom.calendarHint().textContent = calendarView === "projects"
      ? "查看每日專案、案況與客戶；跨日專案會在檔期內每天連續顯示。"
      : "查看每日設備需求、庫存與超用狀況；點「查看超用」可查看使用場次。";
  }
  renderCalendarLegend();

  monthOveruseCache.month = monthValue;
  monthOveruseCache.byDate = calendarView === "equipment"
    ? buildMonthOveruse(monthValue).byDate
    : new Map();

  const [y, m] = monthValue.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const last = new Date(y, m, 0);

  grid.innerHTML = "";
  const startDow = first.getDay();

  for (let i = 0; i < startDow; i++) {
    const pad = document.createElement("div");
    pad.className = "calendar-day muted";
    grid.appendChild(pad);
  }

  for (let day = 1; day <= last.getDate(); day++) {
    const d = new Date(y, m - 1, day);
    const dateISO = toISODate(d);

    const { usage, activeProjects } = computeUsageForDate(dateISO);
    const hasOver = calendarView === "equipment" && monthOveruseCache.byDate.has(dateISO);

    const cell = document.createElement("div");
    cell.className = "calendar-day" + (hasOver ? " overbooked" : "");
    cell.dataset.date = dateISO;

    let badge = "";
    let action = "";
    let entries = "";
    let more = "";

    if (calendarView === "projects") {
      badge = activeProjects.length
        ? `<span class="calendar-badge project-count">${escapeHtml(String(activeProjects.length))} 案</span>`
        : "";
      entries = activeProjects.slice(0, 6).map(p => {
        const projectEnd = p.endDate || p.startDate;
        const rangePoint = p.startDate === dateISO && projectEnd === dateISO
          ? "單日"
          : p.startDate === dateISO
            ? "開始"
            : projectEnd === dateISO ? "結束" : "進行中";
        const meta = [rangePoint, statusLabel(p.status), p.client || "未填客戶"].filter(Boolean).join("｜");
        const title = [p.name || "未命名專案", p.client, `${p.startDate || ""}～${projectEnd || ""}`, statusLabel(p.status)].filter(Boolean).join("｜");
        return `<div class="calendar-project status-${escapeHtml(p.status || "planning")}" title="${escapeHtml(title)}"><span class="calendar-project-name">${escapeHtml(p.name || "未命名專案")}</span><span class="calendar-project-meta">${escapeHtml(meta)}</span></div>`;
      }).join("");
      more = activeProjects.length > 6
        ? `<div class="calendar-more">另有 ${escapeHtml(String(activeProjects.length - 6))} 個專案</div>`
        : "";
      if (!activeProjects.length) entries = `<div class="calendar-empty">無專案檔期</div>`;
    } else {
      const inventory = buildInventoryMap();
      const equipmentRows = Array.from(usage.entries()).sort(([a], [b]) => a.localeCompare(b, "zh-Hant"));
      badge = hasOver
        ? `<span class="calendar-badge">超用</span>`
        : equipmentRows.length ? `<span class="calendar-badge ok">OK</span>` : "";
      action = hasOver
        ? `<button type="button" class="btn ghost small overuse-btn" data-date="${escapeHtml(dateISO)}">查看超用</button>`
        : "";
      entries = equipmentRows.slice(0, 6).map(([name, detail]) => {
        const available = inventory.has(name) ? inventory.get(name) : 0;
        const isOver = detail.required > available;
        const title = (detail.projects || []).map(p => `${p.projectName} × ${p.qty}`).join("、");
        return `<div class="calendar-equipment${isOver ? " over" : ""}" title="${escapeHtml(title)}"><b>${escapeHtml(name)}</b><span>${escapeHtml(String(detail.required))} / ${escapeHtml(String(available))}</span></div>`;
      }).join("");
      more = equipmentRows.length > 6
        ? `<div class="calendar-more">另有 ${escapeHtml(String(equipmentRows.length - 6))} 項設備</div>`
        : "";
      if (!equipmentRows.length) entries = `<div class="calendar-empty">無設備排程</div>`;
    }

    cell.innerHTML = `
      <div class="calendar-day-header">
        <span>${day}</span>
        <span style="display:flex; align-items:center; gap:6px;">
          ${badge}
          ${action}
        </span>
      </div>
      ${entries}
      ${more}
    `;
    grid.appendChild(cell);
  }
}

/* =========================================================
   14) Modal
========================================================= */
function closeOveruseModal() { dom.overuseModal()?.classList.add("hidden"); }

function openOveruseModal(dateISO) {
  const modal = dom.overuseModal();
  const title = dom.overuseModalTitle();
  const body = dom.overuseModalBody();
  if (!modal || !title || !body) return;

  const data = monthOveruseCache.byDate.get(dateISO);
  title.textContent = `設備超用明細｜${dateISO}`;

  if (!data || !data.over?.length) {
    body.innerHTML = `<p>此日期沒有設備超用。</p>`;
  } else {
    body.innerHTML = data.over.map(o => {
      const shortage = o.required - o.available;
      const projLines = (o.projects || []).map(p => `
        <li style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
          <span>${escapeHtml(p.projectName)}：<b>${escapeHtml(String(p.qty))}</b></span>
          <button type="button" class="btn ghost small jump-project-btn" data-project-id="${escapeHtml(p.projectId)}">前往調整</button>
        </li>
      `).join("");

      return `
        <div class="card" style="border:1px solid #e5e7eb; padding:12px; border-radius:12px;">
          <div style="font-weight:950; font-size:16px;">${escapeHtml(o.equip)}</div>
          <div style="color:#6b7280; font-size:13px; margin-top:4px;">
            需求：<b>${escapeHtml(String(o.required))}</b>　可用：<b>${escapeHtml(String(o.available))}</b>
            　<span style="color:#b91c1c; font-weight:950;">缺口：${escapeHtml(String(shortage))}</span>
          </div>
          <div style="margin-top:10px;">
            <div style="font-weight:900; margin-bottom:6px;">使用場次（專案 → 數量）</div>
            <ul style="margin:0; padding-left:18px; line-height:1.8;">
              ${projLines || "<li>（沒有明細）</li>"}
            </ul>
          </div>
        </div>
      `;
    }).join("");
  }

  modal.classList.remove("hidden");
}

/* =========================================================
   15) Report + CSV (欄位順序已調整)
========================================================= */
function getMonthRange(monthValue) {
  const [y, m] = monthValue.split("-").map(Number);
  if (!y || !m) return null;
  const start = `${y}-${pad2(m)}-01`;
  const endDate = new Date(y, m, 0);
  const end = toISODate(endDate);
  return { start, end };
}
function isProjectInMonth(p, monthValue) {
  const r = getMonthRange(monthValue);
  if (!r || !p.startDate || !p.endDate) return false;
  return !(p.endDate < r.start || p.startDate > r.end);
}

function renderReport() {
  const body = dom.reportTableBody();
  const monthInput = dom.reportMonth();
  if (!body || !monthInput) return;

  const mv = monthInput.value;
  if (!mv) return;

  const list = state.projects.filter(p => isProjectInMonth(p, mv));
  body.innerHTML = "";

  let totalR = 0, totalC = 0, totalP = 0;
  let totalInvoiced = 0, totalReceived = 0, totalOutstanding = 0;
  let closedRevenue = 0;

  list.forEach(p => {
    const revenueUntaxed = getRevenueUntaxed(p);
    const projectTotalTaxed = getProjectTotalTaxed(p);
    const paymentSummary = getProjectPaymentSummary(p.id, projectTotalTaxed);
    const cost = getProjectExternalCost(p);
    const profit = revenueUntaxed - cost;

    totalR += revenueUntaxed;
    totalC += cost;
    totalP += profit;

    if (p.status === "closed") closedRevenue += revenueUntaxed;
    totalInvoiced += paymentSummary.invoiced;
    totalReceived += paymentSummary.received;
    totalOutstanding += paymentSummary.outstanding;

    const period = `${p.startDate || ""} ~ ${p.endDate || ""}`;
    const quoteModeLabel = getTaxModeFromProject(p) === "taxed" ? "含稅" : "未稅";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.client || "")}</td>
      <td>${escapeHtml(p.location || "")}</td>
      <td>${escapeHtml(period)}</td>
      <td>${escapeHtml(statusLabel(p.status))}</td>
      <td class="num">${escapeHtml(formatMoney(p.quote || 0))}</td>
      <td>${escapeHtml(quoteModeLabel)}</td>
      <td class="num">${escapeHtml(formatMoney(paymentSummary.invoiced))}</td>
      <td class="num">${escapeHtml(formatMoney(paymentSummary.received))}</td>
      <td class="num">${projectTotalTaxed
        ? escapeHtml(formatMoney(paymentSummary.outstanding))
        : `${escapeHtml(formatMoney(paymentSummary.outstanding))}<div class="table-sub">總價待確認</div>`}</td>
      <td class="num">${escapeHtml(formatMoney(revenueUntaxed || 0))}</td>
      <td class="num">${escapeHtml(formatMoney(cost || 0))}</td>
      <td class="num">${escapeHtml(formatMoney(profit))}</td>
    `;
    body.appendChild(tr);
  });

  // 表格合計
  dom.reportTotalRevenue().textContent = formatMoney(totalR);
  dom.reportTotalCost().textContent = formatMoney(totalC);
  dom.reportTotalProfit().textContent = formatMoney(totalP);
  dom.reportTotalInvoiced() && (dom.reportTotalInvoiced().textContent = formatMoney(totalInvoiced));
  dom.reportTotalReceived() && (dom.reportTotalReceived().textContent = formatMoney(totalReceived));
  dom.reportTotalOutstanding() && (dom.reportTotalOutstanding().textContent = formatMoney(totalOutstanding));

  const monthRange = getMonthRange(mv);
  const monthlyInvoiced = state.payments
    .filter(payment => !payment.voided && payment.requestDate && payment.requestDate >= monthRange.start && payment.requestDate <= monthRange.end)
    .reduce((sum, payment) => sum + parseIntSafe(payment.amount), 0);
  const monthlyReceived = state.payments
    .filter(payment => !payment.voided && payment.receivedDate && payment.receivedDate >= monthRange.start && payment.receivedDate <= monthRange.end)
    .reduce((sum, payment) => sum + parseIntSafe(payment.receivedAmount), 0);

  // KPI（左大右小）
  dom.kpiMonthRevenue() && (dom.kpiMonthRevenue().textContent = formatMoney(totalR));
  dom.kpiMonthProfit() && (dom.kpiMonthProfit().textContent = formatMoney(totalP));
  dom.kpiConfirmedQuote() && (dom.kpiConfirmedQuote().textContent = formatMoney(monthlyInvoiced));
  dom.kpiReceivedAmount() && (dom.kpiReceivedAmount().textContent = formatMoney(monthlyReceived));
  dom.kpiClosedRevenue() && (dom.kpiClosedRevenue().textContent = formatMoney(closedRevenue));
  dom.kpiMonthProjects() && (dom.kpiMonthProjects().textContent = String(list.length));
}

function exportReportCsv() {
  const mv = dom.reportMonth()?.value;
  if (!mv) return alert("請先選擇月份");

  const list = state.projects.filter(p => isProjectInMonth(p, mv));

  // ✅ 欄位順序：期間/狀態 在前；報價/模式 靠近營收前
  const rows = [[
    "專案","客戶","地點",
    "期間","狀態",
    "報價金額","報價模式",
    "已請款(含稅)","已收款(含稅)","未收款(含稅)",
    "營收(未稅)","外部支出(未稅)","案件毛利(未扣設備折舊及固定費用)","備註"
  ]];

  list.forEach(p => {
    const revenueUntaxed = getRevenueUntaxed(p);
    const mode = getTaxModeFromProject(p) === "taxed" ? "含稅" : "未稅";
    const period = `${p.startDate || ""} ~ ${p.endDate || ""}`;
    const cost = getProjectExternalCost(p);
    const profit = revenueUntaxed - cost;
    const projectTotalTaxed = getProjectTotalTaxed(p);
    const paymentSummary = getProjectPaymentSummary(p.id, projectTotalTaxed);

    rows.push([
      p.name || "",
      p.client || "",
      p.location || "",
      period,
      statusLabel(p.status),
      String(parseIntSafe(p.quote)),
      mode,
      String(paymentSummary.invoiced),
      String(paymentSummary.received),
      projectTotalTaxed
        ? String(paymentSummary.outstanding)
        : `${paymentSummary.outstanding}（專案總價待確認）`,
      String(revenueUntaxed),
      String(cost),
      String(profit),
      p.note || ""
    ]);
  });

  const csv = "\uFEFF" + rows.map(r =>
    r.map(x => `"${String(x).replaceAll('"', '""')}"`).join(",")
  ).join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `月報表_${mv}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* =========================================================
   16) Tabs + Today
========================================================= */
function bindTabs() {
  dom.tabButtons().forEach(btn => {
    btn.addEventListener("click", () => {
      dom.tabButtons().forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      $all(".tab-group").forEach(group => group.classList.toggle("has-active", group.contains(btn)));

      const tab = btn.dataset.tab;
      dom.tabPanels().forEach(p => p.classList.remove("active"));
      $(`#tab-${tab}`)?.classList.add("active");

      if (tab === "calendar") renderCalendar();
      if (tab === "report") renderReport();
    });
  });
}

function renderToday() {
  const el = dom.todayLabel();
  if (!el) return;
  const now = new Date();
  el.textContent = `${now.getFullYear()}/${pad2(now.getMonth() + 1)}/${pad2(now.getDate())}`;
}

/* =========================================================
   17) Realtime
========================================================= */
function detachListeners() {
  unsubProjects && unsubProjects();
  unsubEquipments && unsubEquipments();
  unsubPayments && unsubPayments();
  unsubQuotations && unsubQuotations();
  unsubExpenses && unsubExpenses();
  unsubProjects = null;
  unsubEquipments = null;
  unsubPayments = null;
  unsubQuotations = null;
  unsubExpenses = null;

  state.projects = [];
  state.equipments = [];
  state.payments = [];
  state.quotations = [];
  state.expenses = [];
  openProjectIds.clear();
  renderAll();
}

function attachRealtimeListeners() {
  unsubProjects = onSnapshot(
    query(projectsCol, orderBy("updatedAt", "desc")),
    (snap) => {
      state.projects = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderAll();
    },
    (err) => { console.error(err); alert("讀取專案失敗：請確認 Firestore 權限與登入狀態"); }
  );

  unsubEquipments = onSnapshot(
    query(equipmentCol, orderBy("updatedAt", "desc")),
    (snap) => {
      state.equipments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderAll();
    },
    (err) => { console.error(err); alert("讀取設備失敗：請確認 Firestore 權限與登入狀態"); }
  );

  unsubPayments = onSnapshot(
    query(paymentsCol, orderBy("updatedAt", "desc")),
    (snap) => {
      state.payments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderAll();
    },
    (err) => { console.error(err); alert("讀取請款／收款失敗：請先更新 Firestore Rules"); }
  );

  unsubQuotations = onSnapshot(
    query(quotationsCol, orderBy("updatedAt", "desc")),
    (snap) => {
      state.quotations = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderProjectsTable();
    },
    (err) => { console.error(err); alert("讀取報價狀態失敗：請確認 Firestore Rules 已包含 quotations 權限"); }
  );

  unsubExpenses = onSnapshot(
    query(expensesCol, orderBy("updatedAt", "desc")),
    (snap) => {
      state.expenses = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderProjectsTable();
      renderReport();
    },
    (err) => { console.error(err); alert("讀取外部支出失敗：請先更新第三階段 Firestore Rules"); }
  );
}

function renderAll() {
  renderProjectsTable();
  renderEquipmentsTable();
  renderCalendar();
  renderReport();
  refreshEquipUsageDropdowns();
}

/* =========================================================
   18) Bind events
========================================================= */
function bindEvents() {
  if (dom.projectRevenue()) {
    dom.projectRevenue().setAttribute("readonly", "readonly");
    dom.projectRevenue().setAttribute("title", "營收（未稅）會依報價(含稅/未稅)自動換算");
  }

  bindMoneyAutoFormat(dom.projectQuote());
  bindMoneyAutoFormat(dom.projectCost());
  bindMoneyAutoFormat(dom.equipmentPurchasePrice());
  bindMoneyAutoFormat(dom.equipmentResidualValue());

  dom.projectQuote()?.addEventListener("input", syncRevenueFromQuoteToInput);
  dom.projectQuote()?.addEventListener("change", syncRevenueFromQuoteToInput);
  dom.projectQuoteTaxMode()?.addEventListener("change", syncRevenueFromQuoteToInput);

  dom.projectOpenCreate()?.addEventListener("click", () => openProjectDrawer());
  dom.projectDrawerClose()?.addEventListener("click", () => closeProjectDrawer());
  dom.projectDrawer()?.querySelector("[data-drawer-close]")?.addEventListener("click", () => closeProjectDrawer());
  dom.projectReset()?.addEventListener("click", () => {
    resetProjectForm();
    projectFormDirty = true;
    dom.projectName()?.focus();
  });
  dom.equipmentReset()?.addEventListener("click", () => resetEquipmentForm());

  dom.projectForm()?.addEventListener("submit", (e) => {
    e.preventDefault();
    upsertProjectFromForm();
  });
  dom.projectForm()?.addEventListener("input", () => { projectFormDirty = true; });
  dom.projectForm()?.addEventListener("change", () => { projectFormDirty = true; });

  dom.addEquipUsage()?.addEventListener("click", () => {
    addEquipUsageRow();
    projectFormDirty = true;
  });
  dom.equipUsageBody()?.addEventListener("click", (e) => {
    const btn = e.target.closest('[data-act="remove-equip-row"]');
    if (!btn) return;
    const rows = $all(".equip-usage-row", dom.equipUsageBody());
    if (rows.length === 1) {
      rows[0].querySelector(".equip-name").value = "";
      rows[0].querySelector(".equip-qty").value = "";
    } else {
      btn.closest(".equip-usage-row")?.remove();
    }
    updateEquipUsageControls();
    projectFormDirty = true;
  });

  const resetProjectPageAndRender = () => {
    projectCurrentPage = 1;
    renderProjectsTable();
  };
  dom.projectSearch()?.addEventListener("input", resetProjectPageAndRender);
  dom.projectDateRange()?.addEventListener("change", resetProjectPageAndRender);
  dom.projectSortBy()?.addEventListener("change", resetProjectPageAndRender);
  dom.projectStatusOptions()?.addEventListener("change", (e) => {
    const input = e.target.closest('input[type="checkbox"]');
    if (!input) return;
    if (input.checked) selectedProjectStatuses.add(input.value);
    else selectedProjectStatuses.delete(input.value);
    resetProjectPageAndRender();
  });
  dom.projectFilterChips()?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-remove-status]");
    if (!btn) return;
    selectedProjectStatuses.delete(btn.dataset.removeStatus);
    const checkbox = dom.projectStatusOptions()?.querySelector(`input[value="${CSS.escape(btn.dataset.removeStatus)}"]`);
    if (checkbox) checkbox.checked = false;
    resetProjectPageAndRender();
  });
  dom.projectClearFilters()?.addEventListener("click", () => {
    dom.projectSearch().value = "";
    dom.projectDateRange().value = "all";
    selectedProjectStatuses.clear();
    $all('input[type="checkbox"]', dom.projectStatusOptions()).forEach(input => { input.checked = false; });
    resetProjectPageAndRender();
  });
  dom.projectPagination()?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-page]");
    if (!btn || btn.disabled) return;
    projectCurrentPage = Number(btn.dataset.page) || 1;
    renderProjectsTable();
    document.querySelector("#tab-projects .project-toolbar")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  dom.projectPagination()?.addEventListener("change", (e) => {
    const select = e.target.closest("select[data-page-select]");
    if (!select) return;
    projectCurrentPage = Number(select.value) || 1;
    renderProjectsTable();
    document.querySelector("#tab-projects .project-toolbar")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  dom.projectTableBody()?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) {
      const row = e.target.closest("tr.project-row[data-id]");
      if (row) toggleProjectDetails(row.dataset.id);
      return;
    }

    const act = btn.dataset.act;
    const id = btn.dataset.id;
    if (!id) return;

    if (act === "toggle") return toggleProjectDetails(id);
    if (act === "collapse") return toggleProjectDetails(id, false);

    if (act === "edit") {
      const p = state.projects.find(x => x.id === id);
      if (p) openProjectDrawer(p);
      return;
    }
    if (act === "duplicate") {
      const p = state.projects.find(x => x.id === id);
      if (p) openProjectDrawer(p, { duplicate: true });
      return;
    }
    if (act === "del") return deleteProject(id);
  });

  dom.equipmentForm()?.addEventListener("submit", (e) => {
    e.preventDefault();
    upsertEquipmentFromForm();
  });

  dom.equipmentTableBody()?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    const id = btn.dataset.id;
    if (!id) return;

    if (act === "edit-eq") {
      const eq = state.equipments.find(x => x.id === id);
      if (eq) fillEquipmentForm(eq);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else if (act === "catalog-eq") {
      const eq = state.equipments.find(x => x.id === id);
      if (!eq || !canManageCatalog()) return;
      window.dispatchEvent(new CustomEvent("yaoyan:create-quote-item-from-equipment", { detail: { equipmentId: id } }));
    } else if (act === "del-eq") {
      deleteEquipment(id);
    }
  });
  dom.equipmentSearch()?.addEventListener("input", renderEquipmentsTable);
  $all("[data-equipment-sort]").forEach(btn => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.equipmentSort;
      if (equipmentSort.key === key) equipmentSort.direction = equipmentSort.direction === "asc" ? "desc" : "asc";
      else equipmentSort = { key, direction: key === "qty" ? "desc" : "asc" };
      renderEquipmentsTable();
    });
  });

  const cm = dom.calendarMonth();
  if (cm) {
    const now = new Date();
    cm.value = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
    cm.addEventListener("change", renderCalendar);
  }
  dom.calendarViewButtons().forEach(btn => {
    btn.addEventListener("click", () => setCalendarView(btn.dataset.calendarView));
  });

  const rm = dom.reportMonth();
  if (rm) {
    const now = new Date();
    rm.value = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
    rm.addEventListener("change", renderReport);
  }

  dom.exportCsv()?.addEventListener("click", (e) => {
    e.preventDefault();
    exportReportCsv();
  });

  dom.calendarGrid()?.addEventListener("click", (e) => {
    const btn = e.target.closest(".overuse-btn");
    if (!btn) return;
    openOveruseModal(btn.dataset.date);
  });

  dom.overuseModalClose()?.addEventListener("click", closeOveruseModal);
  dom.overuseModal()?.addEventListener("click", (e) => {
    if (e.target === dom.overuseModal()) closeOveruseModal();
  });

  dom.overuseModalBody()?.addEventListener("click", (e) => {
    const btn = e.target.closest(".jump-project-btn");
    if (!btn) return;

    const pid = btn.dataset.projectId;
    if (!pid) return;

    const p = state.projects.find(x => x.id === pid);
    if (!p) return;

    closeOveruseModal();
    document.querySelector(`button.tab-button[data-tab="projects"]`)?.click();
    openProjectDrawer(p);

    setTimeout(() => {
      dom.equipUsageBody()?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 60);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !dom.projectDrawer()?.classList.contains("hidden")) closeProjectDrawer();
  });
  window.addEventListener("beforeunload", (e) => {
    if (!projectFormDirty || dom.projectDrawer()?.classList.contains("hidden")) return;
    e.preventDefault();
    e.returnValue = "";
  });
}

/* =========================================================
   19) Init
========================================================= */
async function init() {
  renderToday();
  ensureAuthUI();
  bindTabs();
  renderEquipUsageRows(null);

  setupQuoteTaxModeSegmented();

  bindEvents();
  syncRevenueFromQuoteToInput();

  try { await handleRedirectResult?.(); } catch (_) {}

  watchAuth(async (user) => {
    currentUser = user;

    if (!user) {
      currentRole = null;
      currentAccess = null;
      updateAuthUI();
      detachListeners();
      return;
    }

    try { await ensureUserDoc(user); } catch (e) { console.error("❌ ensureUserDoc", e); }

    try {
      currentAccess = await getUserAccess(user);
      currentRole = currentAccess.role;
    }
    catch (e) {
      console.error(e);
      currentRole = "viewer";
      currentAccess = { role: "viewer", permissions: {} };
    }

    updateAuthUI();
    detachListeners();
    attachRealtimeListeners();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
