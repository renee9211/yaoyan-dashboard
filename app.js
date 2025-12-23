// app.js (Static-site friendly, imports ONLY from ./firebase.js)

import {
  db,
  watchAuth,
  loginWithGoogle,
  logout,
  getUserRole,
  ensureUserDoc
} from "./firebase.js";

import {
  collection, doc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

watchAuth(async (user) => {
  if (!user) return;

  // ✅ 這行是關鍵：確保 Firestore users/{uid} 一定存在
  await ensureUserDoc(user);

  // 你原本的 role 邏輯可以繼續放這裡
  const role = await getUserRole(user);
  console.log("role:", role);

  // ...你原本的 UI/render/載入資料等
});

// --------------------- Helpers ---------------------
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

function parseIntSafe(v) {
  if (v === "" || v === null || v === undefined) return 0;
  const n = Number(String(v).replace(/,/g, "").trim());
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.trunc(n)); // rules 要 int
}
function formatMoney(n) {
  if (n === "" || n === null || n === undefined) return "";
  const num = Number(String(n).replace(/,/g, "").trim());
  if (Number.isNaN(num)) return "";
  return num.toLocaleString("zh-TW");
}
function calcProfit(p) {
  return parseIntSafe(p.revenue) - parseIntSafe(p.cost);
}

// --------------------- DOM ---------------------
const dom = {
  todayLabel: () => $("#todayLabel"),
  topbarRight: () => $(".topbar-right"),

  tabButtons: () => $all(".tab-button"),
  tabPanels: () => $all(".tab-panel"),

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

  equipmentForm: () => $("#equipment-form"),
  equipmentId: () => $("#equipmentId"),
  equipmentName: () => $("#equipmentName"),
  equipmentQty: () => $("#equipmentQty"),
  equipmentNote: () => $("#equipmentNote"),
  equipmentTableBody: () => $("#equipmentTableBody"),

  calendarMonth: () => $("#calendarMonth"),
  calendarGrid: () => $("#calendarGrid"),

  reportMonth: () => $("#reportMonth"),
  exportCsv: () => $("#exportCsv"),
  reportTableBody: () => $("#reportTableBody"),
  reportTotalRevenue: () => $("#reportTotalRevenue"),
  reportTotalCost: () => $("#reportTotalCost"),
  reportTotalProfit: () => $("#reportTotalProfit"),

  overuseModal: () => $("#overuseModal"),
  overuseModalTitle: () => $("#overuseModalTitle"),
  overuseModalBody: () => $("#overuseModalBody"),
  overuseModalClose: () => $("#overuseModalClose")
};

// --------------------- Firestore collections ---------------------
const projectsCol = collection(db, "projects");
const equipmentCol = collection(db, "equipment"); // rules: /equipment

// --------------------- State ---------------------
let currentUser = null;
let currentRole = null;
let unsubProjects = null;
let unsubEquipments = null;

let state = { projects: [], equipments: [] };

// --------------------- Auth UI (Login/Logout) ---------------------
let authEls = { btn: null, rolePill: null, who: null };

function ensureAuthUI() {
  const host = dom.topbarRight();
  if (!host) return;

  // already created?
  if (authEls.btn && authEls.rolePill && authEls.who) return;

  // 保留原本 Admin tag 的位置，但我們會用動態顯示取代
  // 新增：角色 pill + email + login/logout btn
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

  // 把原本 topbar-right 的內容保留（todayLabel 等），放到下方
  // 先把原先 children 抓出來
  const existing = Array.from(host.childNodes);
  host.innerHTML = "";
  host.appendChild(wrap);

  // 再把原本的東西接回來
  existing.forEach(n => host.appendChild(n));

  authEls = { btn, rolePill, who };

  btn.addEventListener("click", async () => {
    try {
      if (currentUser) {
        await logout();
      } else {
        await loginWithGoogle();
      }
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
    authEls.who.textContent = "請先登入才可寫入（admin/editor）";
    authEls.btn.textContent = "Google 登入";
  } else {
    const email = currentUser.email || "(unknown)";
    authEls.rolePill.textContent = (currentRole || "viewer").toUpperCase();
    authEls.who.textContent = email;
    authEls.btn.textContent = "登出";
  }
}

// --------------------- Equip usage rows (10) ---------------------
function renderEquipUsageRows(project = null) {
  const body = dom.equipUsageBody();
  if (!body) return;

  body.innerHTML = "";
  const used = Array.isArray(project?.equipmentsUsed) ? project.equipmentsUsed : [];

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
    const qty = Math.max(0, Math.trunc(Number(qtyRaw) || 0));
    if (name) result.push({ name, qty });
  });

  return result;
}

// --------------------- Forms ---------------------
function resetProjectForm() {
  dom.projectId() && (dom.projectId().value = "");
  dom.projectName() && (dom.projectName().value = "");
  dom.projectClient() && (dom.projectClient().value = "");
  dom.projectLocation() && (dom.projectLocation().value = "");
  dom.projectStart() && (dom.projectStart().value = "");
  dom.projectEnd() && (dom.projectEnd().value = "");
  dom.projectStatus() && (dom.projectStatus().value = "planning");
  dom.projectRevenue() && (dom.projectRevenue().value = "");
  dom.projectQuote() && (dom.projectQuote().value = "");
  dom.projectCost() && (dom.projectCost().value = "");
  renderEquipUsageRows(null);
}

function fillProjectForm(p) {
  dom.projectId().value = p.id;
  dom.projectName().value = p.name ?? "";
  dom.projectClient().value = p.client ?? "";
  dom.projectLocation().value = p.location ?? "";
  dom.projectStart().value = p.startDate ?? "";
  dom.projectEnd().value = p.endDate ?? "";
  dom.projectStatus().value = p.status ?? "planning";
  dom.projectRevenue().value = parseIntSafe(p.revenue) || "";
  dom.projectQuote().value = parseIntSafe(p.quote) || "";
  dom.projectCost().value = parseIntSafe(p.cost) || "";
  renderEquipUsageRows(p);
}

function resetEquipmentForm() {
  dom.equipmentId() && (dom.equipmentId().value = "");
  dom.equipmentName() && (dom.equipmentName().value = "");
  dom.equipmentQty() && (dom.equipmentQty().value = "");
  dom.equipmentNote() && (dom.equipmentNote().value = "");
}

function fillEquipmentForm(e) {
  dom.equipmentId().value = e.id;
  dom.equipmentName().value = e.name ?? "";
  dom.equipmentQty().value = Number(e.qty ?? 0) || 0;
  dom.equipmentNote().value = e.note ?? "";
}

function canEdit() {
  return currentRole === "admin" || currentRole === "editor";
}
function isAdmin() {
  return currentRole === "admin";
}

// --------------------- CRUD ---------------------
async function upsertProjectFromForm() {
  if (!currentUser) return alert("請先登入再儲存（右上角 Google 登入）");
  if (!canEdit()) return alert("你目前是 viewer，沒有編輯權限（需要 admin 或 editor）");

  const id = dom.projectId().value.trim();

  const name = dom.projectName().value.trim();
  const client = dom.projectClient().value.trim();
  const location = dom.projectLocation().value.trim();

  const startDate = dom.projectStart().value;
  const endDate = dom.projectEnd().value;

  const status = dom.projectStatus().value;

  const revenue = parseIntSafe(dom.projectRevenue().value);
  const cost = parseIntSafe(dom.projectCost().value);
  const quote = parseIntSafe(dom.projectQuote().value);

  const equipmentsUsed = readEquipUsageRows();

  if (!name) return alert("請填寫專案名稱");
  if (!startDate || !endDate) return alert("請填寫專案期間");
  if (endDate < startDate) return alert("結束日期不能早於開始日期");

  const payload = {
    name,
    client,
    location,
    startDate,
    endDate,
    status,
    revenue,
    cost,
    quote,
    equipmentsUsed,
    updatedAt: serverTimestamp()
  };

  try {
    if (id) {
      await updateDoc(doc(db, "projects", id), payload);
    } else {
      await addDoc(projectsCol, { ...payload, createdAt: serverTimestamp() });
    }
    resetProjectForm();
  } catch (e) {
    console.error(e);
    alert("儲存失敗：權限不足或資料不符合 Firestore rules");
  }
}

async function deleteProject(projectId) {
  if (!currentUser) return alert("請先登入");
  if (!isAdmin()) return alert("只有 admin 可以刪除");
  if (!confirm("確定要刪除此專案？")) return;

  try {
    await deleteDoc(doc(db, "projects", projectId));
  } catch (e) {
    console.error(e);
    alert("刪除失敗：請確認權限");
  }
}

async function upsertEquipmentFromForm() {
  if (!currentUser) return alert("請先登入再儲存（右上角 Google 登入）");
  if (!canEdit()) return alert("你目前是 viewer，沒有編輯權限（需要 admin 或 editor）");

  const id = dom.equipmentId().value.trim();
  const name = dom.equipmentName().value.trim();
  const qty = Math.max(0, Math.trunc(Number(dom.equipmentQty().value) || 0));
  const note = dom.equipmentNote().value.trim();

  if (!name) return alert("請填寫設備名稱");

  const payload = { name, qty, note, updatedAt: serverTimestamp() };

  try {
    if (id) {
      await updateDoc(doc(db, "equipment", id), payload);
    } else {
      await addDoc(equipmentCol, { ...payload, createdAt: serverTimestamp() });
    }
    resetEquipmentForm();
  } catch (e) {
    console.error(e);
    alert("儲存失敗：權限不足或資料不符合 Firestore rules");
  }
}

async function deleteEquipment(equipmentId) {
  if (!currentUser) return alert("請先登入");
  if (!isAdmin()) return alert("只有 admin 可以刪除");
  if (!confirm("確定要刪除此設備？")) return;

  try {
    await deleteDoc(doc(db, "equipment", equipmentId));
  } catch (e) {
    console.error(e);
    alert("刪除失敗：請確認權限");
  }
}

// --------------------- Renders ---------------------
function renderProjectsTable() {
  const body = dom.projectTableBody();
  if (!body) return;

  const filter = dom.projectFilterStatus()?.value ?? "";
  const list = filter ? state.projects.filter(p => p.status === filter) : state.projects;

  body.innerHTML = "";
  list.forEach(p => {
    const period = `${p.startDate || ""} ~ ${p.endDate || ""}`;
    const profit = calcProfit(p);

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.client || "")}</td>
      <td>${escapeHtml(p.location || "")}</td>
      <td>${escapeHtml(period)}</td>
      <td>${escapeHtml(statusLabel(p.status))}</td>
      <td class="num">${escapeHtml(formatMoney(p.quote || 0))}</td>
      <td class="num">${escapeHtml(formatMoney(p.revenue || 0))}</td>
      <td class="num">${escapeHtml(formatMoney(p.cost || 0))}</td>
      <td class="num">${escapeHtml(formatMoney(profit))}</td>
      <td>
        <button class="btn ghost small" type="button" data-act="edit" data-id="${escapeHtml(p.id)}">編輯</button>
        <button class="btn ghost small" type="button" data-act="del" data-id="${escapeHtml(p.id)}" ${isAdmin() ? "" : "disabled"}>刪除</button>
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
        <button class="btn ghost small" type="button" data-act="del-eq" data-id="${escapeHtml(e.id)}" ${isAdmin() ? "" : "disabled"}>刪除</button>
      </td>
    `;
    body.appendChild(tr);
  });
}

// --------------------- Calendar overuse ---------------------
function isBetweenInclusive(dateISO, startISO, endISO) {
  return dateISO >= startISO && dateISO <= endISO;
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
  const activeProjects = state.projects.filter(p =>
    p.startDate && p.endDate && isBetweenInclusive(dateISO, p.startDate, p.endDate)
  );

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
      .map(p => `<div class="calendar-project status-${escapeHtml(p.status || "planning")}" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>`)
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

// --------------------- Modal ---------------------
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
          <button type="button" class="btn ghost small jump-project-btn" data-project-id="${escapeHtml(p.projectId)}">前往調整</button>
        </li>
      `).join("");

      return `
        <div class="card" style="border:1px solid #e5e7eb; padding:12px; border-radius:12px;">
          <div style="font-weight:800; font-size:16px;">${escapeHtml(o.equip)}</div>
          <div style="color:#6b7280; font-size:13px; margin-top:4px;">
            需求：<b>${escapeHtml(String(o.required))}</b>　可用：<b>${escapeHtml(String(o.available))}</b>
           　<span style="color:#b91c1c; font-weight:800;">缺口：${escapeHtml(String(shortage))}</span>
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

// --------------------- Report + CSV ---------------------
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
  list.forEach(p => {
    const profit = calcProfit(p);
    totalR += parseIntSafe(p.revenue);
    totalC += parseIntSafe(p.cost);
    totalP += profit;

    const period = `${p.startDate || ""} ~ ${p.endDate || ""}`;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.client || "")}</td>
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
  const rows = [["專案","客戶","地點","報價","開始","結束","狀態","營收","成本","淨利"]];

  list.forEach(p => {
    rows.push([
      p.name || "",
      p.client || "",
      p.location || "",
      String(parseIntSafe(p.quote)),
      p.startDate || "",
      p.endDate || "",
      statusLabel(p.status),
      String(parseIntSafe(p.revenue)),
      String(parseIntSafe(p.cost)),
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

// --------------------- Tabs + Today ---------------------
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

// --------------------- Realtime ---------------------
function detachListeners() {
  unsubProjects && unsubProjects();
  unsubEquipments && unsubEquipments();
  unsubProjects = null;
  unsubEquipments = null;

  state.projects = [];
  state.equipments = [];
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
}
function renderAll() {
  renderProjectsTable();
  renderEquipmentsTable();
  renderCalendar();
  renderReport();
}

// --------------------- Bind events ---------------------
function bindEvents() {
  // --- Projects ---
  dom.projectForm()?.addEventListener("submit", (e) => {
    e.preventDefault();
    upsertProjectFromForm();
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
      if (p) fillProjectForm(p);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else if (act === "del") {
      deleteProject(id);
    }
  });

  // --- Equipments ---
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
    } else if (act === "del-eq") {
      deleteEquipment(id);
    }
  });

  // --- Calendar month ---
  const cm = dom.calendarMonth();
  if (cm) {
    const now = new Date();
    cm.value = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
    cm.addEventListener("change", renderCalendar);
  }

  // --- Report month ---
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

  // --- Calendar: open modal ---
  dom.calendarGrid()?.addEventListener("click", (e) => {
    const btn = e.target.closest(".overuse-btn");
    if (!btn) return;
    openOveruseModal(btn.dataset.date);
  });

  // --- Modal: close ---
  dom.overuseModalClose()?.addEventListener("click", closeOveruseModal);
  dom.overuseModal()?.addEventListener("click", (e) => {
    if (e.target === dom.overuseModal()) closeOveruseModal();
  });

  // ✅✅✅ Modal: Jump to project edit (你現在缺的就是這段)
  dom.overuseModalBody()?.addEventListener("click", (e) => {
    const btn = e.target.closest(".jump-project-btn");
    if (!btn) return;

    const pid = btn.dataset.projectId;
    if (!pid) return;

    const p = state.projects.find(x => x.id === pid);
    if (!p) return;

    // 1) 關閉 modal
    closeOveruseModal();

    // 2) 切回「專案管理」tab
    document.querySelector(`button.tab-button[data-tab="projects"]`)?.click();

    // 3) 帶入專案到表單
    fillProjectForm(p);

    // 4) 捲到「本案使用設備」區塊方便你直接改
    setTimeout(() => {
      dom.equipUsageBody()?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 60);
  });
}

// --------------------- Init ---------------------
function init() {
  renderToday();
  ensureAuthUI();
  bindTabs();
  renderEquipUsageRows(null);
  bindEvents();

  watchAuth(async (user) => {
    currentUser = user;

    if (!user) {
      currentRole = null;
      updateAuthUI();
      detachListeners();
      return;
    }

    try {
      currentRole = await getUserRole(user);
    } catch (e) {
      console.error(e);
      currentRole = "viewer";
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
