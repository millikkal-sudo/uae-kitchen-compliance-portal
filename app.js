// ── Constants ─────────────────────────────────────────────────────────────────
const CLIENT_ID = "942236854237-ecukbhhhmkdm2564vf27e830o9daq69f.apps.googleusercontent.com";
const SCOPES = "https://www.googleapis.com/auth/drive.appdata";
const DRIVE_FILE_NAME = "uae-kitchen-compliance-data.json";
const AUTHORIZED_DOMAIN = "calo.app";

const CERTIFICATES = {
  bfs: { label: "BFS", fullName: "Basic Food Safety",        validYears: 2 },
  ohc: { label: "OHC", fullName: "Occupational Health Card", validYears: 1 },
};

const defaultSettings = { alertsEmail: "compliance.manager@calo.app", reminderDays: 30 };

// ── State ─────────────────────────────────────────────────────────────────────
let state   = { employees: [], settings: { ...defaultSettings } };
let session = null;
let driveFileId = null;
let saveTimer   = null;
let activeBulkCertType = "bfs"; // unified bulk toggle

// ── DOM refs ──────────────────────────────────────────────────────────────────
const loginView  = document.getElementById("loginView");
const appShell   = document.getElementById("appShell");
const toast      = document.getElementById("toast");
const views      = document.querySelectorAll(".view");
const tabs       = document.querySelectorAll(".nav-tab");
const syncStatus = document.getElementById("syncStatus");
const syncLabel  = document.getElementById("syncLabel");

const employeeForm          = document.getElementById("employeeForm");
const certificateForm       = document.getElementById("certificateForm");
const alertSettingsForm     = document.getElementById("alertSettingsForm");
const bulkUploadForm        = document.getElementById("bulkUploadForm");
const employeeSearch        = document.getElementById("employeeSearch");
const employeeDeptFilter    = document.getElementById("employeeDepartmentFilter");
const employeeStatusFilter  = document.getElementById("employeeStatusFilter");

// ── Google Sign-In ────────────────────────────────────────────────────────────
function initGoogleSignIn() {
  if (!window.google) { setTimeout(initGoogleSignIn, 200); return; }
  google.accounts.id.initialize({ client_id: CLIENT_ID, callback: handleGoogleCredential, auto_select: true });
  google.accounts.id.renderButton(document.getElementById("googleSignInButton"), { theme: "outline", size: "large", width: 280 });
  google.accounts.id.prompt();
}

let _pendingPayload = null;
let _tokenClient   = null;

function handleGoogleCredential(response) {
  const payload = parseJwt(response.credential);
  if (!(payload.email || "").endsWith("@" + AUTHORIZED_DOMAIN)) {
    document.getElementById("loginError").classList.remove("hidden"); return;
  }
  document.getElementById("loginError").classList.add("hidden");
  _pendingPayload = payload;

  _tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: async (tok) => {
      document.getElementById("loginLoading").classList.add("hidden");
      document.getElementById("driveConsentBtn").classList.add("hidden");
      if (tok.error || !tok.access_token) {
        // Show the manual button so user can click it directly
        document.getElementById("driveConsentBtn").classList.remove("hidden");
        return;
      }
      await completeSignIn(payload, tok.access_token);
    },
    error_callback: (err) => {
      console.error("Token error:", err);
      document.getElementById("loginLoading").classList.add("hidden");
      document.getElementById("driveConsentBtn").classList.remove("hidden");
    },
  });

  // Try silent first
  document.getElementById("loginLoading").classList.remove("hidden");
  _tokenClient.requestAccessToken({ prompt: "" });
}

document.getElementById("driveConsentBtn").addEventListener("click", () => {
  if (!_tokenClient) return;
  document.getElementById("loginLoading").classList.remove("hidden");
  document.getElementById("driveConsentBtn").classList.add("hidden");
  // User gesture → popup won't be blocked
  _tokenClient.requestAccessToken({ prompt: "consent" });
});

async function completeSignIn(payload, accessToken) {
  session = { email: payload.email, name: payload.name || payload.email, accessToken };
  setSyncState("syncing");
  const driveTimeout = new Promise(res => setTimeout(() => { setSyncState("error"); res(); }, 10000));
  await Promise.race([loadFromDrive(), driveTimeout]);
  render();
  showToast(`Welcome, ${session.name.split(" ")[0]}!`);
}

function parseJwt(token) {
  try { return JSON.parse(atob(token.split(".")[1].replace(/-/g,"+").replace(/_/g,"/"))); } catch { return {}; }
}

// ── Drive API ─────────────────────────────────────────────────────────────────
async function driveReq(method, url, body, ct) {
  const h = { Authorization: `Bearer ${session.accessToken}` };
  if (ct) h["Content-Type"] = ct;
  const res = await fetch(url, { method, headers: h, body });
  if (res.status === 401) { signOut(); throw new Error("Token expired"); }
  return res;
}

async function loadFromDrive() {
  try {
    // Step 1: list files
    const listRes = await driveReq("GET",
      `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name%3D%27${DRIVE_FILE_NAME}%27&fields=files(id)`
    );
    if (!listRes.ok) {
      const err = await listRes.json().catch(()=>({}));
      console.error("Drive list error:", listRes.status, err);
      setSyncState("error");
      showToast(`Drive error ${listRes.status} — working offline.`);
      return;
    }
    const list = await listRes.json();

    if (list.files?.length) {
      // Step 2a: read existing file
      driveFileId = list.files[0].id;
      const fileRes = await driveReq("GET",
        `https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`
      );
      if (fileRes.ok) {
        const raw = await fileRes.json().catch(()=>({}));
        state = { employees: (raw.employees||[]).map(normalizeEmployee), settings: normalizeSettings(raw.settings||{}) };
      }
    } else {
      // Step 2b: create new file
      driveFileId = await createDriveFile();
    }
    setSyncState("idle");
  } catch (e) {
    console.error("loadFromDrive exception:", e);
    setSyncState("error");
    showToast("Could not connect to Drive — working offline.");
  }
}

async function createDriveFile() {
  const meta = { name: DRIVE_FILE_NAME, parents: ["appDataFolder"] };
  const content = JSON.stringify({ employees: [], settings: defaultSettings });
  const b = "ckb_" + Math.random().toString(36).slice(2);
  const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${b}--`;
  const r = await driveReq("POST","https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",body,`multipart/related; boundary=${b}`);
  return (await r.json()).id;
}

async function saveToDrive() {
  if (!session?.accessToken || !driveFileId) return;
  setSyncState("syncing");
  try {
    await driveReq("PATCH",`https://www.googleapis.com/upload/drive/v3/files/${driveFileId}?uploadType=media`,JSON.stringify(state),"application/json");
    setSyncState("idle");
  } catch(e) { console.error(e); setSyncState("error"); showToast("Drive save failed."); }
}

function persist() {
  clearTimeout(saveTimer);
  setSyncState("syncing");
  saveTimer = setTimeout(saveToDrive, 800);
}

function setSyncState(s) {
  syncStatus.className = "sync-status sync-" + s;
  syncLabel.textContent = s === "syncing" ? "Saving…" : s === "error" ? "Save failed" : "Synced to Drive";
}

// ── Sign out ──────────────────────────────────────────────────────────────────
function signOut() {
  if (window.google) google.accounts.id.disableAutoSelect();
  session = null; driveFileId = null;
  state = { employees: [], settings: { ...defaultSettings } };
  render();
}
document.getElementById("signOutButton").addEventListener("click", signOut);

// ── Bulk employee upload toggle ───────────────────────────────────────────────
document.getElementById("showBulkUpload").addEventListener("click", () => {
  const sec = document.getElementById("bulkEmpSection");
  const btn = document.getElementById("showBulkUpload");
  const isHidden = sec.classList.toggle("hidden");
  btn.textContent = isHidden ? "⬆ Bulk Upload Employees" : "✕ Close";
});

// ── Tab navigation ────────────────────────────────────────────────────────────
tabs.forEach(tab => tab.addEventListener("click", () => {
  tabs.forEach(t => t.classList.toggle("active", t === tab));
  views.forEach(v => v.classList.toggle("active-view", v.id === tab.dataset.view));
}));

// ── Employee form (name + ID + dept + optional BFS/OHC issue dates) ───────────
employeeForm.addEventListener("submit", e => {
  e.preventDefault();
  const d = formData(e.currentTarget);
  const existing = state.employees.find(x => x.id === d.editingId);
  const dupId = state.employees.find(x => x.employeeId.toLowerCase() === d.employeeId.trim().toLowerCase() && x.id !== d.editingId);
  if (dupId) { showToast("Employee ID already in use."); return; }
  const certs = existing?.certificates || createEmptyCertificates();
  const bfsDate = parseDate(d.bfsIssueDate);
  const ohcDate = parseDate(d.ohcIssueDate);
  if (bfsDate) {
    certs.bfs = { ...(certs.bfs||{}), issueDate: bfsDate, expiryDate: calcExpiry(bfsDate, CERTIFICATES.bfs.validYears), updatedAt: new Date().toISOString() };
  }
  if (ohcDate) {
    certs.ohc = { ...(certs.ohc||{}), issueDate: ohcDate, expiryDate: calcExpiry(ohcDate, CERTIFICATES.ohc.validYears), updatedAt: new Date().toISOString() };
  }
  const emp = {
    id: existing?.id || crypto.randomUUID(),
    name: d.name.trim(),
    employeeId: d.employeeId.trim(),
    department: d.department.trim(),
    certificates: certs,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.employees = existing
    ? state.employees.map(x => x.id === existing.id ? emp : x)
    : [emp, ...state.employees];
  persist(); resetEmployeeForm(); render();
  showToast(existing ? "Employee updated." : "Employee added.");
});

document.getElementById("cancelEmployeeEdit").addEventListener("click", resetEmployeeForm);

function resetEmployeeForm() {
  employeeForm.reset();
  employeeForm.elements.editingId.value = "";
  document.getElementById("employeeFormTitle").textContent = "Add Employee";
  document.getElementById("employeeSubmitButton").textContent = "Add Employee";
  document.getElementById("cancelEmployeeEdit").classList.add("hidden");
}

// ── Certificate form (edit individual cert) ───────────────────────────────────
certificateForm.addEventListener("submit", async e => {
  e.preventDefault();
  const d = formData(e.currentTarget);
  const emp = state.employees.find(x => x.id === d.employeeId);
  if (!emp) return;
  const type = d.type;
  const file = e.currentTarget.elements.file.files[0];
  const prev = emp.certificates[type] || {};
  const uploaded = file ? await readCertFile(file) : prev.file || null;
  emp.certificates[type] = {
    issueDate: d.issueDate,
    expiryDate: d.expiryDate || calcExpiry(d.issueDate, CERTIFICATES[type].validYears),
    file: uploaded,
    updatedAt: new Date().toISOString(),
  };
  emp.updatedAt = new Date().toISOString();
  persist(); hideCertEdit(); render();
  showToast(`${CERTIFICATES[type].label} saved for ${emp.name}.`);
});

certificateForm.elements.issueDate.addEventListener("change", e => {
  const type = certificateForm.elements.type.value;
  if (e.target.value && type) certificateForm.elements.expiryDate.value = calcExpiry(e.target.value, CERTIFICATES[type].validYears);
});

document.getElementById("cancelCertEdit").addEventListener("click", hideCertEdit);

function showCertEdit(empId, type) {
  const emp = state.employees.find(x => x.id === empId);
  if (!emp) return;
  const panel = document.getElementById("certEditPanel");
  document.getElementById("certEditTitle").textContent = `Edit ${CERTIFICATES[type].label} – ${emp.name}`;
  certificateForm.elements.employeeId.value = empId;
  certificateForm.elements.type.value = type;
  certificateForm.elements.issueDate.value  = emp.certificates[type]?.issueDate  || "";
  certificateForm.elements.expiryDate.value = emp.certificates[type]?.expiryDate || "";
  panel.classList.remove("hidden");
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function hideCertEdit() {
  document.getElementById("certEditPanel").classList.add("hidden");
  certificateForm.reset();
}

// ── Alert settings ────────────────────────────────────────────────────────────
alertSettingsForm.addEventListener("submit", e => {
  e.preventDefault();
  const d = formData(e.currentTarget);
  state.settings = { alertsEmail: d.alertsEmail.trim().toLowerCase(), reminderDays: Number(d.reminderDays) };
  persist(); render(); sendEmailAlert();
});

// ── Bulk employee CSV ─────────────────────────────────────────────────────────
bulkUploadForm.addEventListener("submit", async e => {
  e.preventDefault();
  const file = e.currentTarget.elements.csvFile.files[0];
  if (!file) return;
  const result = importFromCsv(await file.text());
  persist(); e.currentTarget.reset(); render();
  showToast(`CSV done: ${result.added} added, ${result.updated} updated, ${result.skipped} skipped.`);
});

// ── Unified bulk certificate upload ──────────────────────────────────────────
(function initBulkCert() {
  const typeBtns   = document.querySelectorAll(".type-btn");
  const input      = document.getElementById("bulkCertInput");
  const previewEl  = document.getElementById("bulkCertPreview");
  const actionsEl  = document.getElementById("bulkCertActions");
  const confirmBtn = document.getElementById("bulkCertConfirm");
  const clearBtn   = document.getElementById("bulkCertClear");
  let rows = [];

  typeBtns.forEach(btn => btn.addEventListener("click", () => {
    typeBtns.forEach(b => b.classList.toggle("active", b === btn));
    activeBulkCertType = btn.dataset.cert;
    // re-preview with new type if files already chosen
    if (input.files?.length) { rows = buildPreview(input.files); renderPreview(rows, previewEl); actionsEl.classList.remove("hidden"); }
  }));

  input.addEventListener("change", () => {
    if (!input.files?.length) { previewEl.classList.add("hidden"); actionsEl.classList.add("hidden"); return; }
    rows = buildPreview(input.files);
    renderPreview(rows, previewEl);
    actionsEl.classList.remove("hidden");
  });

  confirmBtn.addEventListener("click", async () => {
    const count = await applyBulkFiles(rows, activeBulkCertType);
    persist(); render();
    showToast(`${count} ${CERTIFICATES[activeBulkCertType].label} file(s) attached.`);
    input.value = ""; previewEl.classList.add("hidden"); actionsEl.classList.add("hidden"); rows = [];
  });

  clearBtn.addEventListener("click", () => {
    input.value = ""; previewEl.classList.add("hidden"); actionsEl.classList.add("hidden"); rows = [];
  });
})();

function buildPreview(files) {
  return Array.from(files).map(f => ({ file: f, match: matchFile(f.name) }));
}

function matchFile(fileName) {
  const base = fileName.replace(/\.[^.]+$/, "").trim().toLowerCase();
  const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const baseNorm = normalize(base);
  const firstName = e => e.name.trim().split(/\s+/)[0].toLowerCase();
  const lastName  = e => e.name.trim().split(/\s+/).slice(-1)[0].toLowerCase();
  // 1. Exact employee ID match
  let emp = state.employees.find(e => e.employeeId.trim().toLowerCase() === base);
  // 2. Exact full name match (case-insensitive)
  if (!emp) emp = state.employees.find(e => e.name.trim().toLowerCase() === base);
  // 3. Normalized full name match (ignores spaces, hyphens, punctuation)
  if (!emp) emp = state.employees.find(e => normalize(e.name) === baseNorm);
  // 4. First name only match (e.g. "Umesh.pdf")
  if (!emp) emp = state.employees.find(e => firstName(e) === base);
  // 5. Last name only match (e.g. "Rahman.pdf")
  if (!emp) emp = state.employees.find(e => lastName(e) === base);
  // 6. File name contains employee ID (e.g. "CK-1024_bfs.pdf")
  if (!emp) emp = state.employees.find(e => base.includes(e.employeeId.trim().toLowerCase()));
  // 7. File name contains first name (e.g. "umesh_cert.pdf")
  if (!emp) emp = state.employees.find(e => baseNorm.includes(normalize(firstName(e))) && normalize(firstName(e)).length > 2);
  // 8. File name contains normalized full name
  if (!emp) emp = state.employees.find(e => baseNorm.includes(normalize(e.name)));
  return emp ? { employee: emp } : null;
}

function renderPreview(rows, el) {
  const matched = rows.filter(r => r.match).length;
  let html = `<p class="bulk-summary">${matched} of ${rows.length} file(s) matched · Type: <strong>${CERTIFICATES[activeBulkCertType].label}</strong></p>`;
  html += `<div class="table-wrap"><table><thead><tr><th>File</th><th>Matched Employee</th></tr></thead><tbody>`;
  rows.forEach(r => {
    html += `<tr><td>${escHtml(r.file.name)}</td><td>${r.match ? `<span class="status-valid">${escHtml(r.match.employee.name)}</span>` : `<span class="status-expired">No match</span>`}</td></tr>`;
  });
  html += `</tbody></table></div>`;
  el.innerHTML = html; el.classList.remove("hidden");
}

async function applyBulkFiles(rows, type) {
  let count = 0;
  for (const r of rows) {
    if (!r.match) continue;
    const emp = state.employees.find(e => e.id === r.match.employee.id);
    if (!emp) continue;
    emp.certificates[type] = { ...(emp.certificates[type]||{}), file: await readCertFile(r.file), updatedAt: new Date().toISOString() };
    emp.updatedAt = new Date().toISOString();
    count++;
  }
  return count;
}

// ── Filters ───────────────────────────────────────────────────────────────────
employeeSearch.addEventListener("input",       renderStaffRows);
employeeDeptFilter.addEventListener("change",  renderStaffRows);
employeeStatusFilter.addEventListener("change",renderStaffRows);
document.getElementById("seedDemo").addEventListener("click", seedDemoData);
document.getElementById("exportExcel").addEventListener("click", exportExcel);
document.getElementById("exportExcelTop").addEventListener("click", exportExcel);
document.getElementById("prepareAllAlerts").addEventListener("click", sendEmailAlert);
document.getElementById("downloadEmployeeTemplate").addEventListener("click", downloadTemplate);

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  const ok = Boolean(session?.email);
  loginView.classList.toggle("hidden", ok);
  appShell.classList.toggle("hidden", !ok);
  document.getElementById("signedInEmail").textContent = session?.email || "—";
  if (!ok) return;
  renderDeptFilterOptions();
  renderDashboard();
  renderStaffRows();
  renderAlertSettings();
  renderAlertQueue();
}

function renderDeptFilterOptions() {
  const cur = employeeDeptFilter.value || "all";
  const depts = [...new Set(state.employees.map(e => e.department).filter(Boolean))].sort((a,b) => a.localeCompare(b));
  employeeDeptFilter.innerHTML = ['<option value="all">All departments</option>', ...depts.map(d => `<option value="${escHtml(d)}">${escHtml(d)}</option>`)].join("");
  employeeDeptFilter.value = depts.includes(cur) ? cur : "all";
}

function renderDashboard() {
  const sums = getCertSummaries();
  const by = countBy(sums, "status");
  const urgent = sums.filter(s => s.status === "Expired" || s.status === "Expiring in 30 Days").sort((a,b) => a.daysLeft - b.daysLeft);
  const uc = (by.Expired||0) + (by["Expiring in 30 Days"]||0);
  document.getElementById("employeeMetric").textContent = state.employees.length;
  document.getElementById("validMetric").textContent    = by.Valid || 0;
  document.getElementById("ninetyMetric").textContent   = by["Expiring in 90 Days"] || 0;
  document.getElementById("urgentMetric").textContent   = uc;
  document.getElementById("attentionCount").textContent = `${urgent.length} items`;
  const pill = document.getElementById("overallStatus");
  pill.textContent = uc ? "Action Needed" : "Compliant";
  pill.classList.toggle("risk", Boolean(uc));

  setRows("attentionRows", urgent.slice(0,8).map(s => `<tr>
    <td>${escHtml(s.emp.name)}<br><small>${escHtml(s.emp.employeeId)}</small></td>
    <td>${escHtml(s.cert.label)}</td>
    <td>${fmtDate(s.expiryDate)}</td>
    <td>${badge(s.status)}</td>
    <td><a class="table-link" href="${mailto(s)}">Email Alert</a></td>
  </tr>`), 5, "No urgent renewals.");

  // dept risk
  const grouped = sums.reduce((g, s) => {
    const d = s.emp.department || "Unassigned";
    g[d] ||= { d, total:0, urgent:0, warn:0 };
    g[d].total++;
    if (s.status === "Expired" || s.status === "Expiring in 30 Days") g[d].urgent++;
    if (s.status === "Expiring in 90 Days") g[d].warn++;
    return g;
  }, {});
  document.getElementById("departmentRiskList").innerHTML = Object.values(grouped).sort((a,b)=>b.urgent-a.urgent).map(x =>
    `<div class="risk-item"><strong>${escHtml(x.d)}</strong><span>${x.urgent} urgent · ${x.warn} due soon · ${x.total} total</span></div>`
  ).join("") || '<div class="empty-state">No records yet.</div>';
}

function renderStaffRows() {
  const q    = employeeSearch.value.trim().toLowerCase();
  const dept = employeeDeptFilter.value;
  const stat = employeeStatusFilter.value;

  const emps = state.employees.filter(e => {
    const searchable = [e.name, e.employeeId, e.department].join(" ").toLowerCase();
    const sums = Object.keys(CERTIFICATES).map(t => getCertSummary(e,t));
    const matchQ    = searchable.includes(q);
    const matchDept = dept === "all" || e.department === dept;
    const matchStat = stat === "all" || sums.some(s => {
      if (stat === "Expiring") return s.status === "Expiring in 30 Days" || s.status === "Expiring in 90 Days";
      return s.status === stat;
    });
    return matchQ && matchDept && matchStat;
  });

  setRows("staffRows", emps.map(e => {
    const bfs = getCertSummary(e, "bfs");
    const ohc = getCertSummary(e, "ohc");
    return `<tr>
      <td><strong>${escHtml(e.name)}</strong></td>
      <td>${escHtml(e.employeeId)}</td>
      <td>${escHtml(e.department)}</td>
      <td>${badge(bfs.status)}</td>
      <td>${fmtDate(bfs.issueDate)}</td>
      <td>${fmtDate(bfs.expiryDate)}</td>
      <td>${fileLink(bfs.record.file)} <button class="text-btn" type="button" data-action="edit-cert" data-eid="${e.id}" data-type="bfs">Edit</button></td>
      <td>${badge(ohc.status)}</td>
      <td>${fmtDate(ohc.issueDate)}</td>
      <td>${fmtDate(ohc.expiryDate)}</td>
      <td>${fileLink(ohc.record.file)} <button class="text-btn" type="button" data-action="edit-cert" data-eid="${e.id}" data-type="ohc">Edit</button></td>
      <td class="row-actions">
        <button class="text-btn" type="button" data-action="edit-emp" data-id="${e.id}">Edit</button>
        <button class="text-btn danger" type="button" data-action="del-emp" data-id="${e.id}">Remove</button>
      </td>
    </tr>`;
  }), 10, "No employees match this filter.");
  wireActions();
}

function renderAlertSettings() {
  alertSettingsForm.elements.alertsEmail.value  = state.settings.alertsEmail;
  alertSettingsForm.elements.reminderDays.value = String(state.settings.reminderDays);
}

function renderAlertQueue() {
  const items = getAlertItems();
  document.getElementById("alertQueue").innerHTML = items.length
    ? items.map(s => `<div class="alert-item">
        <div>
          <strong>${escHtml(s.emp.name)} · ${escHtml(s.cert.label)} ${escHtml(s.status.toLowerCase())}</strong>
          <span>${escHtml(s.emp.department)} · expires ${fmtDate(s.expiryDate)} · ${fmtDays(s.daysLeft)}</span>
        </div>
        <div class="alert-actions"><a class="primary-btn" href="${mailto(s)}">Prepare Alert</a></div>
      </div>`).join("")
    : '<div class="empty-state">No alerts due.</div>';
}

// ── Certificate logic ─────────────────────────────────────────────────────────
function getCertSummaries() {
  return state.employees.flatMap(e => Object.keys(CERTIFICATES).map(t => getCertSummary(e,t)));
}
function getCertSummary(emp, type) {
  const cert   = CERTIFICATES[type];
  const record = emp.certificates[type] || {};
  const issueDate  = record.issueDate  || "";
  const expiryDate = record.expiryDate || (issueDate ? calcExpiry(issueDate, cert.validYears) : "");
  const daysLeft   = expiryDate ? daysUntil(expiryDate) : Infinity;
  return { emp, type, cert, record, issueDate, expiryDate, daysLeft, status: certStatus(expiryDate) };
}
function certStatus(exp) {
  if (!exp) return "Missing";
  const d = daysUntil(exp);
  if (d < 0)  return "Expired";
  if (d <= 30) return "Expiring in 30 Days";
  if (d <= 90) return "Expiring in 90 Days";
  return "Valid";
}
function daysUntil(ds) {
  const t = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.ceil((t(new Date(`${ds}T00:00:00`)) - t(new Date())) / 86400000);
}
function calcExpiry(issue, years) {
  const d = new Date(`${issue}T00:00:00`);
  d.setFullYear(d.getFullYear() + years);
  return d.toISOString().slice(0,10);
}

// ── Alert helpers ─────────────────────────────────────────────────────────────
function getAlertItems() {
  return getCertSummaries()
    .filter(s => s.status !== "Missing" && (s.daysLeft < 0 || s.daysLeft <= state.settings.reminderDays))
    .sort((a,b) => a.daysLeft - b.daysLeft);
}
function sendEmailAlert() {
  const items = getAlertItems();
  if (!items.length) { showToast("No alerts due."); return; }
  const subj = encodeURIComponent(`UAE Kitchen certificate alerts – ${items.length} items`);
  const body = encodeURIComponent([
    "Hello Compliance Team,", "",
    `${items.length} certificate renewal(s) need attention (within ${state.settings.reminderDays} days or overdue):`, "",
    items.map(s => `- ${s.emp.name} (${s.emp.employeeId}) · ${s.cert.label}: ${s.status} · Expires: ${fmtDate(s.expiryDate)}`).join("\n"),
    "", "UAE Kitchen – Compliance Portal",
  ].join("\n"));
  window.location.href = `mailto:${encodeURIComponent(state.settings.alertsEmail)}?subject=${subj}&body=${body}`;
  showToast("Opening mail client…");
}
function mailto(s) {
  const subj = encodeURIComponent(`${s.cert.label} certificate ${s.status.toLowerCase()} – ${s.emp.name}`);
  const body = encodeURIComponent([`${s.emp.name}'s ${s.cert.fullName} is ${s.status.toLowerCase()}.`,`Employee ID: ${s.emp.employeeId}`,`Department: ${s.emp.department}`,`Expiry: ${fmtDate(s.expiryDate)}`,`${fmtDays(s.daysLeft)}`,"","UAE Kitchen – Compliance Portal"].join("\n"));
  return `mailto:${encodeURIComponent(state.settings.alertsEmail)}?subject=${subj}&body=${body}`;
}

// ── Employee actions ──────────────────────────────────────────────────────────
function editEmployee(id) {
  const e = state.employees.find(x => x.id === id);
  if (!e) return;
  employeeForm.elements.editingId.value  = e.id;
  employeeForm.elements.name.value       = e.name;
  employeeForm.elements.employeeId.value = e.employeeId;
  employeeForm.elements.department.value = e.department;
  employeeForm.elements.bfsIssueDate.value = e.certificates?.bfs?.issueDate || "";
  employeeForm.elements.ohcIssueDate.value = e.certificates?.ohc?.issueDate || "";
  document.getElementById("employeeFormTitle").textContent     = `Editing: ${e.name}`;
  document.getElementById("employeeSubmitButton").textContent  = "Save Changes";
  document.getElementById("cancelEmployeeEdit").classList.remove("hidden");
  showView("staff");
  employeeForm.elements.name.focus();
  employeeForm.scrollIntoView({ behavior: "smooth", block: "start" });
}
function deleteEmployee(id) {
  const e = state.employees.find(x => x.id === id);
  if (!e || !confirm(`Remove ${e.name}?`)) return;
  state.employees = state.employees.filter(x => x.id !== id);
  persist(); render(); showToast("Employee removed.");
}
function clearCertificate(empId, type) {
  const e = state.employees.find(x => x.id === empId);
  if (!e || !confirm(`Clear ${CERTIFICATES[type].label} for ${e.name}?`)) return;
  e.certificates[type] = {}; e.updatedAt = new Date().toISOString();
  persist(); render(); showToast("Certificate cleared.");
}

function wireActions() {
  document.querySelectorAll("[data-action]").forEach(btn => {
    if (btn._wired) return; btn._wired = true;
    btn.addEventListener("click", () => {
      const a = btn.dataset.action;
      if (a === "edit-emp")  editEmployee(btn.dataset.id);
      if (a === "del-emp")   deleteEmployee(btn.dataset.id);
      if (a === "edit-cert") showCertEdit(btn.dataset.eid, btn.dataset.type);
    });
  });
}

function showView(id) {
  tabs.forEach(t => t.classList.toggle("active", t.dataset.view === id));
  views.forEach(v => v.classList.toggle("active-view", v.id === id));
}

// ── CSV import ────────────────────────────────────────────────────────────────
function importFromCsv(text) {
  const rows = parseCsv(text).filter(r => r.some(c => c.trim()));
  if (rows.length < 2) return { added:0, updated:0, skipped:0 };
  const hdrs = rows[0].map(h => h.toLowerCase().replace(/[^a-z0-9]/g,""));
  // Pad every data row to header length so trailing empty columns aren't undefined
  rows.slice(1).forEach(r => { while (r.length < hdrs.length) r.push(""); });
  let added=0, updated=0, skipped=0;
  rows.slice(1).forEach(row => {
    const rec = hdrs.reduce((o,h,i) => { o[h]=(row[i]||"").trim(); return o; }, {});
    if (!rec.employeeid || !rec.name || !rec.department) { skipped++; return; }
    const existing = state.employees.find(e => e.employeeId.toLowerCase() === rec.employeeid.toLowerCase());
    const certs = existing?.certificates || createEmptyCertificates();
    // Try multiple possible normalized header variations for BFS and OHC dates
    const bfsVal = rec.bfsissuedate || rec.bfsdate || rec.bfs || findRecKey(rec, "bfs");
    const ohcVal = rec.ohcissuedate || rec.ohcdate || rec.ohc || findRecKey(rec, "ohc");
    const bfsDate = parseDate(bfsVal);
    const ohcDate = parseDate(ohcVal);
    if (bfsDate) certs.bfs = { issueDate: bfsDate, expiryDate: calcExpiry(bfsDate, 2), file: certs.bfs?.file||null, updatedAt: new Date().toISOString() };
    if (ohcDate) certs.ohc = { issueDate: ohcDate, expiryDate: calcExpiry(ohcDate, 1), file: certs.ohc?.file||null, updatedAt: new Date().toISOString() };
    const emp = { id: existing?.id||crypto.randomUUID(), name: rec.name, employeeId: rec.employeeid, department: rec.department, certificates: certs, createdAt: existing?.createdAt||new Date().toISOString(), updatedAt: new Date().toISOString() };
    if (existing) { state.employees = state.employees.map(x => x.id===existing.id?emp:x); updated++; }
    else { state.employees.unshift(emp); added++; }
  });
  return { added, updated, skipped };
}

// Find a key in rec that contains the given prefix (for flexible CSV header matching)
function findRecKey(rec, prefix) {
  const key = Object.keys(rec).find(k => k.startsWith(prefix) && (k.includes("issue") || k.includes("date")));
  return key ? rec[key] : "";
}

function downloadTemplate() {
  const rows = [
    ["employeeId","name","department","bfsIssueDate","ohcIssueDate"],
    ["CK-1001","Sample Employee","Kitchen","2026-01-15","2026-03-01"],
  ];
  downloadFile(`uae-kitchen-template-${today()}.csv`, rows.map(r=>r.map(csvEsc).join(",")).join("\n"), "text/csv;charset=utf-8");
}

// ── Excel export ──────────────────────────────────────────────────────────────
function exportExcel() {
  const hdrs = ["Employee ID","Name","Department","BFS Status","BFS Expiry","BFS File","OHC Status","OHC Expiry","OHC File"];
  const rows = state.employees.map(e => {
    const bfs = getCertSummary(e,"bfs"), ohc = getCertSummary(e,"ohc");
    return [e.employeeId,e.name,e.department,bfs.status,bfs.expiryDate,bfs.record.file?.name||"",ohc.status,ohc.expiryDate,ohc.record.file?.name||""];
  });
  const tbl = `<table><thead><tr>${hdrs.map(h=>`<th>${escHtml(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${escHtml(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  downloadFile(`uae-kitchen-export-${today()}.xls`,`<!doctype html><html><head><meta charset="UTF-8"></head><body>${tbl}</body></html>`,"application/vnd.ms-excel;charset=utf-8");
  showToast("Excel export ready.");
}

// ── Demo data ─────────────────────────────────────────────────────────────────
function seedDemoData() {
  const di = days => { const d=new Date(); d.setDate(d.getDate()+days); return d.toISOString().slice(0,10); };
  const mk = (type, offset, fn) => {
    const exp = di(offset);
    const iss = (() => { const d=new Date(`${exp}T00:00:00`); d.setFullYear(d.getFullYear()-CERTIFICATES[type].validYears); return d.toISOString().slice(0,10); })();
    return { issueDate:iss, expiryDate:exp, file:{name:fn,type:"application/pdf",size:0,dataUrl:"data:application/pdf;base64,",uploadedAt:new Date().toISOString()}, updatedAt:new Date().toISOString() };
  };
  state.employees = [
    { id:crypto.randomUUID(), name:"Aisha Rahman",   employeeId:"CK-1001", department:"Kitchen",  certificates:{bfs:mk("bfs",140,"CK-1001-bfs.pdf"), ohc:mk("ohc",24,"CK-1001-ohc.pdf")},  createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() },
    { id:crypto.randomUUID(), name:"Khalid Mansoor", employeeId:"CK-1002", department:"Dispatch", certificates:{bfs:mk("bfs",-12,"CK-1002-bfs.pdf"), ohc:mk("ohc",82,"CK-1002-ohc.pdf")},  createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() },
    { id:crypto.randomUUID(), name:"Maria Santos",   employeeId:"CK-1003", department:"Kitchen",  certificates:{bfs:mk("bfs",410,"CK-1003-bfs.pdf"), ohc:mk("ohc",9,"CK-1003-ohc.pdf")},   createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() },
    { id:crypto.randomUUID(), name:"Omar Faris",     employeeId:"CK-1004", department:"Kitchen",  certificates:{bfs:mk("bfs",67,"CK-1004-bfs.pdf"),  ohc:{}},                                createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() },
  ];
  persist(); render(); showToast("Sample data loaded.");
}

// ── Normalise helpers ─────────────────────────────────────────────────────────
function normalizeEmployee(e) { return { ...e, certificates: { ...createEmptyCertificates(), ...(e.certificates||{}) } }; }
function normalizeSettings(s) { return { ...defaultSettings, ...s, reminderDays: Number(s.reminderDays||defaultSettings.reminderDays) }; }
function createEmptyCertificates() { return { bfs:{}, ohc:{} }; }
function formData(form) { return Object.fromEntries(new FormData(form).entries()); }

// ── DOM / render utilities ────────────────────────────────────────────────────
function setRows(id, rows, cols, empty) {
  document.getElementById(id).innerHTML = rows.length ? rows.join("") : `<tr><td colspan="${cols}" class="empty-state">${empty}</td></tr>`;
}
function countBy(arr, key) { return arr.reduce((c,i)=>{ c[i[key]]=(c[i[key]]||0)+1; return c; },{}); }
function badge(status) {
  const cls = status==="Valid"?"good":status==="Expiring in 90 Days"?"watch":status==="Expiring in 30 Days"?"warn":status==="Missing"?"neutral":"bad";
  return `<span class="badge ${cls}">${escHtml(status)}</span>`;
}
function fmtDate(v) {
  if (!v) return "—";
  return new Intl.DateTimeFormat(undefined,{year:"numeric",month:"short",day:"numeric"}).format(new Date(`${v}T00:00:00`));
}
function fmtDays(d) {
  if (!isFinite(d)) return "not recorded";
  if (d < 0) return `${Math.abs(d)} days overdue`;
  if (d === 0) return "expires today";
  return `${d} days remaining`;
}
function fileLink(f) {
  if (!f?.dataUrl) return '<span class="muted">—</span>';
  return `<a class="table-link" href="${f.dataUrl}" download="${escHtml(f.name)}">${escHtml(f.name)}</a>`;
}
function escHtml(v) {
  return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
}
async function readCertFile(file) {
  if (!file) return null;
  if (file.type !== "application/pdf" && !file.type.startsWith("image/")) { showToast("Upload a PDF or image."); throw new Error("bad type"); }
  return { name:file.name, type:file.type, size:file.size, dataUrl: await toDataUrl(file), uploadedAt: new Date().toISOString() };
}
function toDataUrl(file) {
  return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=()=>rej(r.error); r.readAsDataURL(file); });
}
function downloadFile(name, content, type) {
  const a = Object.assign(document.createElement("a"),{href:URL.createObjectURL(new Blob([content],{type})),download:name});
  a.click(); URL.revokeObjectURL(a.href);
}
function parseCsv(text) {
  const rows=[]; let row=[],cell="",inQ=false;
  for(let i=0;i<text.length;i++){const c=text[i],n=text[i+1];
    if(c==='"'&&inQ&&n==='"'){cell+='"';i++;}else if(c==='"'){inQ=!inQ;}
    else if(c===","&&!inQ){row.push(cell);cell="";}
    else if((c==="\n"||c==="\r")&&!inQ){if(c==="\r"&&n==="\n")i++;row.push(cell);rows.push(row);row=[];cell="";}
    else{cell+=c;}}
  row.push(cell);rows.push(row);return rows;
}
function csvEsc(v) { const s=String(v??""); return /[,"\n\r]/.test(s)?`"${s.replaceAll('"','""')}"`  :s; }
function isValidDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(v)&&!isNaN(new Date(`${v}T00:00:00`)); }

// Accepts: YYYY-MM-DD, DD/MM/YYYY, MM/DD/YYYY, DD/MM/YY, DD-MM-YY,
//          named months with 2 or 4-digit year (16-Jun-26), Excel serials
// Returns "YYYY-MM-DD" or null
function parseDate(v) {
  if (!v || !String(v).trim()) return null;
  const s = String(v).trim();

  // Already ISO YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00`);
    return isNaN(d) ? null : s;
  }

  // Excel serial number (e.g. 46189)
  if (/^\d{4,5}$/.test(s)) {
    const serial = parseInt(s, 10);
    if (serial > 1000 && serial < 100000) {
      const d = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
      if (!isNaN(d)) return d.toISOString().slice(0, 10);
    }
    return null;
  }

  // Expand 2-digit year: 00-29 → 2000s, 30-99 → 1900s
  const expandYear = yy => { const n = parseInt(yy, 10); return String(n <= 29 ? 2000 + n : 1900 + n); };

  // Named month with 2 OR 4 digit year: "16-Jun-26", "16-Jun-2026", "01-May-26", "May 1, 2026"
  const namedDMY = s.match(/^(\d{1,2})[\s\-\/]([A-Za-z]{3,9})[\s\-\/,]*(\d{2,4})$/);
  if (namedDMY) {
    const [, dd, mon, rawY] = namedDMY;
    const yyyy = rawY.length === 2 ? expandYear(rawY) : rawY;
    const d = new Date(`${dd} ${mon} ${yyyy}`);
    if (!isNaN(d)) return d.toISOString().slice(0, 10);
  }
  const namedMDY = s.match(/^([A-Za-z]{3,9})[\s\-\/,]+(\d{1,2})[\s\-\/,]*(\d{2,4})$/);
  if (namedMDY) {
    const [, mon, dd, rawY] = namedMDY;
    const yyyy = rawY.length === 2 ? expandYear(rawY) : rawY;
    const d = new Date(`${dd} ${mon} ${yyyy}`);
    if (!isNaN(d)) return d.toISOString().slice(0, 10);
  }

  // DD/MM/YYYY or DD/MM/YY or D/M/YY (UAE/UK convention first)
  const dmy = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (dmy) {
    const [, dd, mm, rawY] = dmy;
    const yyyy = rawY.length === 2 ? expandYear(rawY) : rawY;
    // Try DD/MM first
    const d1 = new Date(`${yyyy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}T00:00:00`);
    if (!isNaN(d1) && d1.getMonth() + 1 === parseInt(mm)) {
      return `${yyyy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}`;
    }
    // Fallback MM/DD
    const d2 = new Date(`${yyyy}-${dd.padStart(2,'0')}-${mm.padStart(2,'0')}T00:00:00`);
    if (!isNaN(d2)) return `${yyyy}-${dd.padStart(2,'0')}-${mm.padStart(2,'0')}`;
    return null;
  }

  // YYYY/MM/DD
  const ymd = s.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})$/);
  if (ymd) {
    const [, yyyy, mm, dd] = ymd;
    const iso = `${yyyy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}`;
    const d = new Date(`${iso}T00:00:00`);
    return isNaN(d) ? null : iso;
  }

  // Last resort: browser native parse
  const d = new Date(s);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);

  return null;
}
function today() { return new Date().toISOString().slice(0,10); }
function showToast(msg) {
  toast.textContent = msg; toast.classList.add("visible");
  clearTimeout(showToast._t); showToast._t = setTimeout(()=>toast.classList.remove("visible"),2600);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
render();
initGoogleSignIn();
