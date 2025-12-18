// app.js (Firestore cloud sync version)

import { db, ensureSignedIn } from "./firebase.js";
import {
  collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, serverTimestamp, getDocs
} from "firebase/firestore";

// =======================
// Helpers
// =======================
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
    confirmed: "已簽約 / 確認",
    executing: "執行中",
    closed: "已結案",
    lost: "流標 / 未成案"
  };
  return map[v] || v || "";
}

function parseMoney(v) {
  if (v === "" || v === null || v === undefined) return 0;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isNaN(n) ? 0 : n;
}
function formatMoney(n) {
  if (n === "" || n === null || n === undefined) return "";
  const num = Number(String(n).replace(/,/g, "").trim());
  if (Number.isNaN(num)) return "";
  return num.toLocaleString("zh-TW");
}

// =======================
// DOM
// =======================
const dom = {
  todayLabel: () => $("#todayLabel"),

  tabButtons: () => $all(".tab-button"),
  tabPanels: () => $all(".tab-panel"),

  // project
  projectForm: () => $("#project-form"),
  projectId: () => $("#projectId"),
  projectName: () => $("#projectName"),
  projectClient: () => $("#projectClient"),
  projectLocation: () => $("#projectLocation"),
  projectStart: () => $("#projectStart"),
  projectEnd: () => $("#projectEnd"),
  projectStatus: () => $("#projectStatus"),
  projectRevenue: () => $("#projectRevenue"),
  projectQuote: () => $("#projectQuote"),
  projectCost: () => $("#projectCost"),
  equipUsageBody: () => $("#equipUsageBody"),
  projectFilterStatus: () => $("#projectFilterStatus"),
  projectTableBody: () => $("#projectTableBody"),

  // equipment
  equipmentForm: () => $("#equipment-form"),
  equipmentId: () => $("#equipmentId"),
  equipmentName: () => $("#equipmentName"),
  equipmentQty: () => $("#equipmentQty"),
  equipmentNote: () => $("#equipmentNote"),
  equipmentTableBody: () => $("#equipmentTableBody"),

  // calendar
  calendarMonth: () => $("#calendarMonth"),
  calendarGrid: () => $("#calendarGrid"),

  // report
  reportMonth: () => $("#reportMonth"),
  exportCsv: () => $("#exportCsv"),
  reportTableBody: () => $("#reportTableBody"),
  reportTotalRevenue: () => $("#reportTotalRevenue"),
  reportTotalCost: () => $("#reportTotalCost"),
  reportTotalProfit: () => $("#reportTotalProfit"),

  // modal
  overuseModal: () => $("#overuseModal"),
  overuseModalTitle: () => $("#overuseModalTitle"),
  overuseModalBody: () => $("#overuseModalBody"),
  overuseModalClose: () => $("#overuseModalClose")
};

// =======================
// Cloud state (from Firestore)
// =======================
let state = {
  projects: [],
  equipments: []
};

// Firestore collections
const projectsCol = collection(db, "projects");
const equipmentsCol = collection(db, "equipments");

// =======================
// Normalize
// =======================
function normalizeProject(id, p) {
  return {
    id,
    name: p.name ?? "",
    client: p.client ?? "",
    location: p.location ?? "",
    start: p.start ?? "",
    end: p.end ?? "",
    status: p.status ?? "planning",
    revenue: parseMoney(p.revenue),
    quote: parseMoney(p.quote),
    cost: parseMoney(p.cost),
    equipmentsUsed: Array.isArray(p.equipmentsUsed)
      ? p.equipmentsUsed.map(x => ({ name: String(x.name ?? "").trim(), qty: Number(x.qty) || 0 }))
      : []
  };
}

function normalizeEquipment(id, e) {
  return {
    id,
    name: e.name ?? "",
    qty: Number(e.qty ?? 0) || 0,
    note: e.note ?? ""
  };
}

// =======================
// Equip usage rows (10)
// =======================
function renderEquipUsageRows(project = null) {
  const body = dom.equipUsageBody();
  if (!body) return;

  body.innerHTML = "";
  const used = project?.equipmentsUsed ?? [];

  for (let i = 0; i < 10; i++) {
    const row = document.createElement("div");
    row.className = "equip-usage-row";
    row.innerHTML = `
      <input class="equip-name" type="text" placeholder="設備名稱" value="${escapeHtml(used[i]?.name ?? "")}" />
      <input class="equip-qty" type="number" min="0" step="1" placeholder="數量" value="${escapeHtml(used[i]?.qty ?? "")}" />
    `;
    body.appendChild(row);
  }
}

function readEquipUsageRows() {
  const body = dom.equipUsageBody();
  if (!body) return [];

  const rows = $all(".equip-usage-row", body);
  const result = [];

  rows.forEach(r => {
    const name = r.querySelector(".equip-name")?.value?.trim() ?? "";
    const qtyRaw = r.querySelector(".equip-qty")?.value ?? "";
    const qty = Math.max(0, parseInt(String(qtyRaw).replace(/[^\d-]/g, ""), 10) || 0);
    if (name) result.push({ name, qty });
  });

  return result;
}

// =======================
// Forms
// =======================
function resetProjectForm() {
  dom.projectId().value = "";
  dom.projectName().value = "";
  dom.projectClient().value = "";
  dom.projectLocation().value = "";
  dom.projectStart().value = "";
  dom.projectEnd().value = "";
  dom.projectStatus().value = "planning";
  dom.projectRevenue().value = "";
  dom.projectQuote().value = "";
  dom.projectCost().value = "";
  renderEquipUsageRows(null);
}

function fillProjectForm(p) {
  dom.projectId().value = p.id;
  dom.projectName().value = p.name ?? "";
  dom.projectClient().value = p.client ?? "";
  dom.projectLocation().value = p.location ?? "";
  dom.projectStart().value = p.start ?? "";
  dom.projectEnd().value = p.end ?? "";
  dom.projectStatus().value = p.status ?? "planning";
  dom.projectRevenue().value = parseMoney(p.revenue) || "";
  dom.projectQuote().value = parseMoney(p.quote) || "";
  dom.projectCost().value = parseMoney(p.cost) || "";
  renderEquipUsageRows(p);
}

function resetEquipmentForm() {
  dom.equipmentId().value = "";
  dom.equipmentName().value = "";
  dom.equipmentQty().value = "";
  dom.equipmentNote().value = "";
}

function fillEquipmentForm(e) {
  dom.equipmentId().value = e.id;
  dom.equipmentName().value = e.name ?? "";
  dom.equipmentQty().value = e.qty ?? 0;
  dom.equipmentNote().value = e.note ?? "";
}

function calcProfit(p) {
  return parseMoney(p.revenue) - parseMoney(p.cost);
}

// =======================
// Firestore CRUD
// =======================
async function upsertProjectFromForm() {
  const id = dom.projectId().value.trim();

  const payload = {
    name: dom.projectName().value.trim(),
    client: dom.projectClient().value.trim(),
    location: dom.projectLocation().value.trim(),
    start: dom.projectStart().value,
    end: dom.projectEnd().value,
    status: dom.projectStatus().value,
    revenue: parseMoney(dom.projectRevenue().value),
    quote: parseMoney(dom.projectQuote().value),
    cost: parseMoney(dom.projectCost().value),
    equipmentsUsed: readEquipUsageRows(),
    updatedAt: serverTimestamp()
  };

  if (!payload.name) return alert("請填寫專案名稱");
  if (!payload.start || !payload.end) return alert("請填寫專案期間");
  if (payload.end < payload.start) return alert("結束日期不能早於開始日期");

  try {
    if (id) {
      await updateDoc(doc(db, "projects", id), payload);
    } else {
      await addDoc(projectsCol, { ...payload, createdAt: serverTimestamp() });
    }
    resetProjectForm();
  } catch (e) {
    console.error(e);
    alert("儲存專案失敗（請確認 Firestore / 權限設定）");
  }
}

async function deleteProject(id) {
  if (!confirm("確定要刪除此專案？")) return;
  try {
    await deleteDoc(doc(db, "projects", id));
  } catch (e) {
    console.error(e);
    alert("刪除專案失敗（請確認 Firestore / 權限設定）");
  }
}

async function upsertEquipmentFromForm() {
  const id = dom.equipmentId().value.trim();

  const payload = {
    name: dom.equipmentName().value.trim(),
    qty: Math.max(0, parseInt(String(dom.equipmentQty().value).replace(/[^\d-]/g, ""), 10) || 0),
    note: dom.equipmentNote().value.trim(),
    updatedAt: serverTimestamp()
  };

  if (!payload.name) return alert("請填寫設備名稱");

  try {
    if (id) {
      await updateDoc(doc(db, "equipments", id), payload);
    } else {
      await addDoc(equipmentsCol, { ...payload, createdAt: serverTimestamp() });
    }
    resetEquipmentForm();
  } catch (e) {
    console.error(e);
    alert("儲存設備失敗（請確認 Firestore / 權限設定）");
  }
}

async function deleteEquipment(id) {
  if (!confirm("確定要刪除此設備？")) return;
  try {
    await deleteDoc(doc(db, "equipments", id));
  } catch (e) {
    console.error(e);
    alert("刪除設備失敗（請確認 Firestore / 權限設定）");
  }
}

// =======================
// Render tables
// =======================
function renderProjectsTable() {
  const body = dom.projectTableBody();
  if (!body) return;

  const filter = dom.projectFilterStatus()?.value ?? "";
  const list = filter ? state.projects.filter(p => p.status === filter) : state.projects;

  body.innerHTML = "";

  list.forEach(p => {
    const tr = document.createElement("tr");
    const period = `${p.start || ""} ~ ${p.end || ""}`;
    tr.innerHTML = `
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.client)}</td>
      <td>${escapeHtml(p.location || "")}</td>
      <td>${escapeHtml(period)}</td>
      <td>${escapeHtml(statusLabel(p.status))}</td>
      <td class="num">${escapeHtml(formatMoney(p.quote || 0))}</td>
      <td class="num">${escapeHtml(formatMoney(p.revenue || 0))}</td>
      <td class="num">${escapeHtml(formatMoney(p.cost || 0))}</td>
      <td class="num">${escapeHtml(formatMoney(calcProfit(p)))}</td>
      <td>
        <button class="btn ghost small" type="button" data-act="edit" data-id="${escapeHtml(p.id)}">編輯</button>
        <button class="btn ghost small" type="button" data-act="del" data-id="${escapeHtml(p.id)}">刪除</button>
      </td>
    `;
    body.appendChild(tr);
  });
}

function renderEquipmentsTable() {
  const body = dom.equipmentTableBody();
  if (!body) return;

  body.innerHTML = "";
  state.equipments.forEach(e => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(e.name)}</td>
      <td class="num">${escapeHtml(String(e.qty ?? 0))}</td>
      <td>${escapeHtml(e.note ?? "")}</td>
      <td>
        <button class="btn ghost small" type="button" data-act="edit-eq" data-id="${escapeHtml(e.id)}">編輯</button>
        <button class="btn ghost small" type="button" data-act="del-eq" data-id="${escapeHtml(e.id)}">刪除</button>
      </td>
    `;
    body.appendChild(tr);
  });
}

// =======================
// Calendar (show projects + overuse)
// =======================
function isBetweenInclusive(dateISO, startISO, endISO) {
  return dateISO >= startISO && dateISO <= endISO;
}

function buildInventoryMap() {
  const map = new Map();
  state.equipments.forEach(e => {
    const name = String(e.name || "").trim();
    if (!name) return;
    map.set(name, Number(e.qty) || 0);
  });
  return map;
}

function computeUsageForDate(dateISO) {
  const usage = new Map(); // equip -> { required, projects: [{projectName, qty, projectId}] }
  const activeProjects = state.projects.filter(p => p.start && p.end && isBetweenInclusive(dateISO, p.start, p.end));

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

function renderCalendar() {
  const grid = dom.calendarGrid();
  const monthInput = dom.calendarMonth();
  if (!grid || !monthInput) return;

  const monthValue = monthInput.value;
  if (!monthValue) return;

  monthOveruseCache.month = monthValue;
  monthOveruseCache.byDate = buildMonthOveruse(monthValue).byDate;

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

    const { activeProjects } = computeUsageForDate(dateISO);
    const hasOver = monthOveruseCache.byDate.has(dateISO);

    const cell = document.createElement("div");
    cell.className = "calendar-day" + (hasOver ? " overbooked" : "");
    cell.dataset.date = dateISO;

    const badge = hasOver
      ? `<span class="calendar-badge">超用</span>`
      : `<span class="calendar-badge ok">OK</span>`;

    const overBtn = hasOver
      ? `<button type="button" class="btn ghost small overuse-btn" data-date="${escapeHtml(dateISO)}">查看超用</button>`
      : "";

    const chips = (activeProjects || [])
      .slice(0, 6)
      .map(p => {
        const status = p.status || "planning";
        return `<div class="calendar-project status-${escapeHtml(status)}" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>`;
      })
      .join("");

    const more = (activeProjects?.length || 0) > 6
      ? `<div class="calendar-project" title="更多">+${activeProjects.length - 6} more</div>`
      : "";

    cell.innerHTML = `
      <div class="calendar-day-header">
        <span>${day}</span>
        <span style="display:flex; align-items:center; gap:6px;">
          ${badge}
          ${overBtn}
        </span>
      </div>
      ${chips}
      ${more}
    `;

    grid.appendChild(cell);
  }
}

// =======================
// Modal
// =======================
function closeOveruseModal() {
  dom.overuseModal()?.classList.add("hidden");
}

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
          <button type="button" class="btn ghost small jump-project-btn" data-project-id="${escapeHtml(p.projectId)}">
            前往調整
          </button>
        </li>
      `).join("");

      return `
        <div class="card" style="border:1px solid #e5e7eb; padding:12px; border-radius:12px;">
          <div style="display:flex; justify-content:space-between; align-items:flex-end; gap:10px;">
            <div>
              <div style="font-weight:800; font-size:16px;">${escapeHtml(o.equip)}</div>
              <div style="color:#6b7280; font-size:13px; margin-top:4px;">
                需求：<b>${escapeHtml(String(o.required))}</b>　可用：<b>${escapeHtml(String(o.available))}</b>
               　<span style="color:#b91c1c; font-weight:800;">缺口：${escapeHtml(String(shortage))}</span>
              </div>
            </div>
          </div>
          <div style="margin-top:10px;">
            <div style="font-weight:700; margin-bottom:6px;">使用場次（專案 → 數量）</div>
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

// =======================
// Report + CSV
// =======================
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
  if (!r || !p.start || !p.end) return false;
  return !(p.end < r.start || p.start > r.end);
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

  list.forEach(p => {
    const profit = calcProfit(p);
    totalR += parseMoney(p.revenue);
    totalC += parseMoney(p.cost);
    totalP += profit;

    const period = `${p.start || ""} ~ ${p.end || ""}`;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.client)}</td>
      <td>${escapeHtml(p.location || "")}</td>
      <td class="num">${escapeHtml(formatMoney(p.quote || 0))}</td>
      <td>${escapeHtml(period)}</td>
      <td>${escapeHtml(statusLabel(p.status))}</td>
      <td class="num">${escapeHtml(formatMoney(p.revenue || 0))}</td>
      <td class="num">${escapeHtml(formatMoney(p.cost || 0))}</td>
      <td class="num">${escapeHtml(formatMoney(profit))}</td>
    `;
    body.appendChild(tr);
  });

  dom.reportTotalRevenue().textContent = formatMoney(totalR);
  dom.reportTotalCost().textContent = formatMoney(totalC);
  dom.reportTotalProfit().textContent = formatMoney(totalP);
}

function exportReportCsv() {
  const mv = dom.reportMonth()?.value;
  if (!mv) return alert("請先選擇月份");

  const list = state.projects.filter(p => isProjectInMonth(p, mv));
  const rows = [
    ["專案", "客戶", "地點", "報價", "開始", "結束", "狀態", "營收", "成本", "淨利"]
  ];

  list.forEach(p => {
    rows.push([
      p.name || "",
      p.client || "",
      p.location || "",
      String(parseMoney(p.quote)),
      p.start || "",
      p.end || "",
      statusLabel(p.status),
      String(parseMoney(p.revenue)),
      String(parseMoney(p.cost)),
      String(calcProfit(p))
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

// =======================
// Tabs + Today
// =======================
function bindTabs() {
  dom.tabButtons().forEach(btn => {
    btn.addEventListener("click", () => {
      dom.tabButtons().forEach(b => b.classList.remove("active"));
      btn.classList.add("active");

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

// =======================
// Firestore listeners (realtime sync)
// =======================
function attachRealtimeListeners() {
  // 專案：用 updatedAt 排序，沒有 updatedAt 的也能顯示
  const pq = query(projectsCol, orderBy("updatedAt", "desc"));
  onSnapshot(pq, (snap) => {
    state.projects = snap.docs.map(d => normalizeProject(d.id, d.data()));
    renderAll();
  }, (err) => {
    console.error(err);
    alert("讀取專案失敗（請確認 Firestore / 權限設定）");
  });

  const eq = query(equipmentsCol, orderBy("updatedAt", "desc"));
  onSnapshot(eq, (snap) => {
    state.equipments = snap.docs.map(d => normalizeEquipment(d.id, d.data()));
    renderAll();
  }, (err) => {
    console.error(err);
    alert("讀取設備失敗（請確認 Firestore / 權限設定）");
  });
}

// =======================
// Render All
// =======================
function renderAll() {
  renderProjectsTable();
  renderEquipmentsTable();
  renderCalendar();
  renderReport();
}

// =======================
// Bind Events
// =======================
function bindEvents() {
  // projects
  dom.projectForm()?.addEventListener("submit", (e) => {
    e.preventDefault();
    upsertProjectFromForm();
  });

  dom.projectForm()?.addEventListener("reset", () => {
    setTimeout(() => {
      dom.projectId().value = "";
      renderEquipUsageRows(null);
    }, 0);
  });

  dom.projectFilterStatus()?.addEventListener("change", renderProjectsTable);

  dom.projectTableBody()?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    const id = btn.dataset.id;
    if (!id) return;

    if (act === "edit") {
      const p = state.projects.find(x => x.id === id);
      if (!p) return;
      fillProjectForm(p);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else if (act === "del") {
      deleteProject(id);
    }
  });

  // equipments
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
      if (!eq) return;
      fillEquipmentForm(eq);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else if (act === "del-eq") {
      deleteEquipment(id);
    }
  });

  // calendar month init + change
  const cm = dom.calendarMonth();
  if (cm) {
    const now = new Date();
    cm.value = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
    cm.addEventListener("change", renderCalendar);
  }

  // report month init + change
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

  // calendar "查看超用"
  dom.calendarGrid()?.addEventListener("click", (e) => {
    const btn = e.target.closest(".overuse-btn");
    if (!btn) return;
    const dateISO = btn.dataset.date;
    if (!dateISO) return;
    openOveruseModal(dateISO);
  });

  // modal close
  dom.overuseModalClose()?.addEventListener("click", closeOveruseModal);
  dom.overuseModal()?.addEventListener("click", (e) => {
    if (e.target === dom.overuseModal()) closeOveruseModal();
  });

  // modal "前往調整"
  dom.overuseModalBody()?.addEventListener("click", (e) => {
    const btn = e.target.closest(".jump-project-btn");
    if (!btn) return;

    const pid = btn.dataset.projectId;
    if (!pid) return;

    const p = state.projects.find(x => x.id === pid);
    if (!p) return;

    closeOveruseModal();

    document.querySelector(`button.tab-button[data-tab="projects"]`)?.click();
    fillProjectForm(p);

    setTimeout(() => {
      dom.equipUsageBody()?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  });
}

// =======================
// Init
// =======================
async function init() {
  renderToday();
  bindTabs();
  renderEquipUsageRows(null);
  bindEvents();

  try {
    await ensureSignedIn();
    attachRealtimeListeners();
  } catch (e) {
    console.error(e);
    alert("Firebase 登入失敗（請確認 Authentication 已啟用匿名登入）");
  }
}

document.addEventListener("DOMContentLoaded", init);
