// ===== 狀態儲存 =====
const STORAGE_KEY = "yaoyan-dashboard-state";

let state = {
  projects: [],
  equipments: []
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) state = JSON.parse(raw);
  } catch (e) {
    console.error("Load state error", e);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ===== 工具函式 =====
function formatMoney(n) {
  if (!n && n !== 0) return "";
  const num = Number(n);
  if (Number.isNaN(num)) return "";
  return num.toLocaleString("zh-TW", { maximumFractionDigits: 0 });
}

function calcProfit(p) {
  const r = Number(p.revenue) || 0;
  const c = Number(p.cost) || 0;
  return r - c;
}

function statusLabel(status) {
  switch (status) {
    case "planning":
      return "規劃中";
    case "confirmed":
      return "已簽約 / 確認";
    case "executing":
      return "執行中";
    case "closed":
      return "已結案";
    case "lost":
      return "流標 / 未成案";
    default:
      return status || "-";
  }
}

// date string YYYY-MM-DD compare
function isDateInRange(date, start, end) {
  return (!start || date >= start) && (!end || date <= end);
}

// ===== DOM 抓取 =====
let els = {};

function cacheDom() {
  els.tabButtons = document.querySelectorAll(".tab-button");
  els.tabPanels = document.querySelectorAll(".tab-panel");

  // project
  els.projectForm = document.getElementById("project-form");
  els.projectId = document.getElementById("projectId");
  els.projectName = document.getElementById("projectName");
  els.projectClient = document.getElementById("projectClient");
  els.projectStart = document.getElementById("projectStart");
  els.projectEnd = document.getElementById("projectEnd");
  els.projectStatus = document.getElementById("projectStatus");
  els.projectRevenue = document.getElementById("projectRevenue");
  els.projectCost = document.getElementById("projectCost");
  els.projectTableBody = document.getElementById("projectTableBody");
  els.projectFilterStatus = document.getElementById("projectFilterStatus");
  els.projectReset = document.getElementById("projectReset");
  els.equipUsageBody = document.getElementById("equipUsageBody");

  // equipment
  els.equipmentForm = document.getElementById("equipment-form");
  els.equipmentId = document.getElementById("equipmentId");
  els.equipmentName = document.getElementById("equipmentName");
  els.equipmentQty = document.getElementById("equipmentQty");
  els.equipmentNote = document.getElementById("equipmentNote");
  els.equipmentTableBody = document.getElementById("equipmentTableBody");
  els.equipmentReset = document.getElementById("equipmentReset");

  // calendar
  els.calendarMonth = document.getElementById("calendarMonth");
  els.calendarGrid = document.getElementById("calendarGrid");

  // report
  els.reportMonth = document.getElementById("reportMonth");
  els.reportTableBody = document.getElementById("reportTableBody");
  els.reportTotalRevenue = document.getElementById("reportTotalRevenue");
  els.reportTotalCost = document.getElementById("reportTotalCost");
  els.reportTotalProfit = document.getElementById("reportTotalProfit");
  els.exportCsv = document.getElementById("exportCsv");

  // misc
  els.todayLabel = document.getElementById("todayLabel");
}

// ===== 分頁切換 =====
function initTabs() {
  els.tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      els.tabButtons.forEach((b) => b.classList.remove("active"));
      els.tabPanels.forEach((p) => p.classList.remove("active"));

      btn.classList.add("active");
      document.getElementById(`tab-${tab}`).classList.add("active");
    });
  });
}

// ===== 專案：設備使用列 10 行 =====
function buildEquipUsageRows() {
  els.equipUsageBody.innerHTML = "";
  for (let i = 0; i < 10; i++) {
    const row = document.createElement("div");
    row.className = "equip-usage-row";
    row.innerHTML = `
      <input type="text" class="equip-usage-name" placeholder="設備名稱" />
      <input type="number" class="equip-usage-qty" min="0" step="1" placeholder="數量" />
    `;
    els.equipUsageBody.appendChild(row);
  }
}

function getEquipUsageFromForm() {
  const names = els.equipUsageBody.querySelectorAll(".equip-usage-name");
  const qtys = els.equipUsageBody.querySelectorAll(".equip-usage-qty");
  const result = [];

  names.forEach((input, idx) => {
    const name = input.value.trim();
    const qty = Number(qtys[idx].value);
    if (name && !Number.isNaN(qty) && qty > 0) {
      result.push({ name, qty });
    }
  });

  return result;
}

function fillEquipUsageToForm(usages) {
  buildEquipUsageRows();
  if (!Array.isArray(usages)) return;
  const rows = els.equipUsageBody.querySelectorAll(".equip-usage-row");
  usages.slice(0, rows.length).forEach((u, idx) => {
    const nameInput = rows[idx].querySelector(".equip-usage-name");
    const qtyInput = rows[idx].querySelector(".equip-usage-qty");
    nameInput.value = u.name || "";
    qtyInput.value = u.qty || "";
  });
}

// ===== 專案：CRUD =====
function handleProjectSubmit(e) {
  e.preventDefault();
  const id = els.projectId.value || crypto.randomUUID();
  const payload = {
    id,
    name: els.projectName.value.trim(),
    client: els.projectClient.value.trim(),
    startDate: els.projectStart.value || null,
    endDate: els.projectEnd.value || null,
    status: els.projectStatus.value,
    revenue: Number(els.projectRevenue.value) || 0,
    cost: Number(els.projectCost.value) || 0,
    equipmentsUsed: getEquipUsageFromForm()
  };

  if (!payload.name) {
    alert("請輸入專案名稱");
    return;
  }
  if (!payload.startDate || !payload.endDate) {
    alert("請填寫專案期間");
    return;
  }

  const idx = state.projects.findIndex((p) => p.id === id);
  if (

