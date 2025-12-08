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
  if (idx >= 0) {
    state.projects[idx] = payload;
  } else {
    state.projects.push(payload);
  }

  saveState();
  renderProjects();
  renderCalendar();
  renderReport();
  els.projectForm.reset();
  buildEquipUsageRows();
}

function renderProjects() {
  const filterStatus = els.projectFilterStatus.value;
  els.projectTableBody.innerHTML = "";

  state.projects
    .slice()
    .sort((a, b) => (a.startDate || "").localeCompare(b.startDate || ""))
    .forEach((p) => {
      if (filterStatus && p.status !== filterStatus) return;

      const tr = document.createElement("tr");
      const profit = calcProfit(p);

      tr.innerHTML = `
        <td>${p.name || "-"}</td>
        <td>${p.client || "-"}</td>
        <td>${p.startDate || "-"}<br/>～ ${p.endDate || "-"}</td>
        <td>${statusLabel(p.status)}</td>
        <td class="num">${formatMoney(p.revenue)}</td>
        <td class="num">${formatMoney(p.cost)}</td>
        <td class="num">${formatMoney(profit)}</td>
        <td>
          <div class="table-actions">
            <button class="btn ghost small" data-action="edit" data-id="${p.id}">編輯</button>
            <button class="btn danger small" data-action="delete" data-id="${p.id}">刪除</button>
          </div>
        </td>
      `;

      els.projectTableBody.appendChild(tr);
    });

  // 綁定操作按鈕
  els.projectTableBody.querySelectorAll("button").forEach((btn) => {
    const id = btn.dataset.id;
    const action = btn.dataset.action;
    btn.addEventListener("click", () => {
      const project = state.projects.find((p) => p.id === id);
      if (!project) return;

      if (action === "edit") {
        els.projectId.value = project.id;
        els.projectName.value = project.name || "";
        els.projectClient.value = project.client || "";
        els.projectStart.value = project.startDate || "";
        els.projectEnd.value = project.endDate || "";
        els.projectStatus.value = project.status || "planning";
        els.projectRevenue.value = project.revenue || "";
        els.projectCost.value = project.cost || "";
        fillEquipUsageToForm(project.equipmentsUsed || []);
      } else if (action === "delete") {
        if (confirm("確定要刪除這個專案嗎？")) {
          state.projects = state.projects.filter((p) => p.id !== id);
          saveState();
          renderProjects();
          renderCalendar();
          renderReport();
        }
      }
    });
  });
}

// ===== 設備：CRUD =====
function handleEquipmentSubmit(e) {
  e.preventDefault();
  const id = els.equipmentId.value || crypto.randomUUID();

  const payload = {
    id,
    name: els.equipmentName.value.trim(),
    qty: Number(els.equipmentQty.value) || 0,
    note: els.equipmentNote.value.trim()
  };

  if (!payload.name) {
    alert("請輸入設備名稱");
    return;
  }

  const idx = state.equipments.findIndex((x) => x.id === id);
  if (idx >= 0) {
    state.equipments[idx] = payload;
  } else {
    state.equipments.push(payload);
  }

  saveState();
  renderEquipments();
  renderCalendar(); // 設備容量變動 → 重新算超用
  els.equipmentForm.reset();
}

function renderEquipments() {
  els.equipmentTableBody.innerHTML = "";
  state.equipments
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"))
    .forEach((eq) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${eq.name}</td>
        <td class="num">${eq.qty}</td>
        <td>${eq.note || ""}</td>
        <td>
          <div class="table-actions">
            <button class="btn ghost small" data-action="edit" data-id="${eq.id}">編輯</button>
            <button class="btn danger small" data-action="delete" data-id="${eq.id}">刪除</button>
          </div>
        </td>
      `;
      els.equipmentTableBody.appendChild(tr);
    });

  els.equipmentTableBody.querySelectorAll("button").forEach((btn) => {
    const id = btn.dataset.id;
    const action = btn.dataset.action;
    btn.addEventListener("click", () => {
      const eq = state.equipments.find((x) => x.id === id);
      if (!eq) return;

      if (action === "edit") {
        els.equipmentId.value = eq.id;
        els.equipmentName.value = eq.name;
        els.equipmentQty.value = eq.qty;
        els.equipmentNote.value = eq.note || "";
      } else if (action === "delete") {
        if (confirm("確定要刪除這個設備嗎？")) {
          state.equipments = state.equipments.filter((x) => x.id !== id);
          saveState();
          renderEquipments();
          renderCalendar();
        }
      }
    });
  });
}

// ===== 行事曆 & 設備超用計算 =====
function buildEquipmentMap() {
  const map = {};
  state.equipments.forEach((eq) => {
    map[eq.name] = eq.qty;
  });
  return map;
}

function computeDailyUsage(year, month) {
  const equipmentTotals = buildEquipmentMap();
  const result = {}; // dateStr -> { usage: {name: qty}, overbooked: bool }
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(
      day
    ).padStart(2, "0")}`;
    result[dateStr] = { usage: {}, overbooked: false };
  }

  state.projects.forEach((p) => {
    if (!p.startDate || !p.endDate) return;
    const usages = Array.isArray(p.equipmentsUsed) ? p.equipmentsUsed : [];

    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(
        day
      ).padStart(2, "0")}`;
      if (!isDateInRange(dateStr, p.startDate, p.endDate)) continue;

      usages.forEach((u) => {
        const name = u.name;
        const qty = Number(u.qty) || 0;
        if (!name || qty <= 0) return;

        if (!result[dateStr].usage[name]) result[dateStr].usage[name] = 0;
        result[dateStr].usage[name] += qty;

        if (
          equipmentTotals[name] != null &&
          result[dateStr].usage[name] > equipmentTotals[name]
        ) {
          result[dateStr].overbooked = true;
        }
      });
    }
  });

  return result;
}

function renderCalendar() {
  let monthValue = els.calendarMonth.value;
  const today = new Date();
  if (!monthValue) {
    // default: 本月
    const defaultMonth = `${today.getFullYear()}-${String(
      today.getMonth() + 1
    ).padStart(2, "0")}`;
    els.calendarMonth.value = defaultMonth;
    monthValue = defaultMonth;
  }
  const [yearStr, monthStr] = monthValue.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr) - 1; // JS month 0-based
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const dailyUsage = computeDailyUsage(year, month);

  els.calendarGrid.innerHTML = "";

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(
      day
    ).padStart(2, "0")}`;
    const info = dailyUsage[dateStr];
    const div = document.createElement("div");
    div.className = "calendar-day";
    if (info && info.overbooked) {
      div.classList.add("overbooked");
    }

    // 當日有哪些專案
    const projectsToday = state.projects.filter((p) =>
      isDateInRange(dateStr, p.startDate, p.endDate)
    );

    div.innerHTML = `
      <div class="calendar-day-header">
        <span>${day}</span>
        ${
          info && info.overbooked
            ? '<span class="calendar-badge">超用警示</span>'
            : ""
        }
      </div>
      <div class="calendar-day-body"></div>
    `;

    const body = div.querySelector(".calendar-day-body");
    projectsToday.forEach((p) => {
      const span = document.createElement("div");
      span.className = `calendar-project status-${p.status || "planning"}`;
      span.textContent = p.name;
      body.appendChild(span);
    });

    els.calendarGrid.appendChild(div);
  }
}

// ===== 報表：每月營收 / 淨利 =====
function renderReport() {
  let monthValue = els.reportMonth.value;
  const today = new Date();
  if (!monthValue) {
    const defaultMonth = `${today.getFullYear()}-${String(
      today.getMonth() + 1
    ).padStart(2, "0")}`;
    els.reportMonth.value = defaultMonth;
    monthValue = defaultMonth;
  }

  const [yearStr, monthStr] = monthValue.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr) - 1;

  // 定義：有「任一天」落在本月就算這個月的專案
  const firstDay = `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const lastDay = `${year}-${String(month + 1).padStart(
    2,
    "0"
  )}-${String(new Date(year, month + 1, 0).getDate()).padStart(2, "0")}`;

  const filtered = state.projects.filter((p) => {
    if (!p.startDate || !p.endDate) return false;
    return !(
      p.endDate < firstDay || // 完全在本月前
      p.startDate > lastDay // 完全在本月後
    );
  });

  els.reportTableBody.innerHTML = "";
  let totalRevenue = 0;
  let totalCost = 0;
  let totalProfit = 0;

  filtered.forEach((p) => {
    const profit = calcProfit(p);
    totalRevenue += Number(p.revenue) || 0;
    totalCost += Number(p.cost) || 0;
    totalProfit += profit;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${p.name || "-"}</td>
      <td>${p.client || "-"}</td>
      <td>${p.startDate || "-"}<br/>～ ${p.endDate || "-"}</td>
      <td>${statusLabel(p.status)}</td>
      <td class="num">${formatMoney(p.revenue)}</td>
      <td class="num">${formatMoney(p.cost)}</td>
      <td class="num">${formatMoney(profit)}</td>
    `;
    els.reportTableBody.appendChild(tr);
  });

  els.reportTotalRevenue.textContent = formatMoney(totalRevenue);
  els.reportTotalCost.textContent = formatMoney(totalCost);
  els.reportTotalProfit.textContent = formatMoney(totalProfit);
}

function exportCsv() {
  let monthValue = els.reportMonth.value;
  if (!monthValue) {
    alert("請先選擇月份");
    return;
  }
  const [yearStr, monthStr] = monthValue.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr) - 1;

  const firstDay = `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const lastDay = `${year}-${String(month + 1).padStart(
    2,
    "0"
  )}-${String(new Date(year, month + 1, 0).getDate()).padStart(2, "0")}`;

  const filtered = state.projects.filter((p) => {
    if (!p.startDate || !p.endDate) return false;
    return !(
      p.endDate < firstDay || // 完全在本月前
      p.startDate > lastDay // 完全在本月後
    );
  });

  const rows = [
    [
      "專案名稱",
      "客戶名稱",
      "開始日期",
      "結束日期",
      "狀態",
      "營收",
      "成本",
      "淨利"
    ]
  ];

  filtered.forEach((p) => {
    rows.push([
      p.name || "",
      p.client || "",
      p.startDate || "",
      p.endDate || "",
      statusLabel(p.status),
      String(p.revenue || 0),
      String(p.cost || 0),
      String(calcProfit(p) || 0)
    ]);
  });

  const csvContent = rows
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\r\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `yaoyan-monthly-report-${monthValue}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ===== 綁定事件 & 初始化 =====
function bindEvents() {
  initTabs();
  buildEquipUsageRows();

  els.projectForm.addEventListener("submit", handleProjectSubmit);
  els.projectFilterStatus.addEventListener("change", renderProjects);
  els.projectReset.addEventListener("click", () => {
    els.projectId.value = "";
    buildEquipUsageRows();
  });

  els.equipmentForm.addEventListener("submit", handleEquipmentSubmit);
  els.equipmentReset.addEventListener("click", () => {
    els.equipmentId.value = "";
  });

  els.calendarMonth.addEventListener("change", () => {
    renderCalendar();
  });

  els.reportMonth.addEventListener("change", () => {
    renderReport();
  });

  els.exportCsv.addEventListener("click", (e) => {
    e.preventDefault();
    exportCsv();
  });
}

function renderTodayLabel() {
  if (!els.todayLabel) return;
  const now = new Date();
  const d = now.toLocaleDateString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  els.todayLabel.textContent = `今天：${d}`;
}

function init() {
  loadState();
  cacheDom();
  bindEvents();
  renderProjects();
  renderEquipments();
  renderCalendar();
  renderReport();
  renderTodayLabel();
}

document.addEventListener("DOMContentLoaded", init);
