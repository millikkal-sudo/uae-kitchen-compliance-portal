// ── Constants ─────────────────────────────────────────────────────────────────
const CLIENT_ID = "942236854237-ecukbhhhmkdm2564vf27e830o9daq69f.apps.googleusercontent.com";
const SCOPES = "https://www.googleapis.com/auth/drive.appdata";
const DRIVE_FILE_NAME = "uae-kitchen-compliance-data.json";
const AUTHORIZED_DOMAIN = "calo.app";
const SLACK_ALERT_ENDPOINT = "/api/send-alert";

const CERTIFICATES = {
  bfs: { label: "BFS", fullName: "Basic Food Safety",        validYears: 2 },
  ohc: { label: "OHC", fullName: "Occupational Health Card", validYears: 1 },
};
const CERT_TYPES = Object.keys(CERTIFICATES); // ["bfs","ohc"]
const SECTION_SUFFIX = { bfs: "Bfs", ohc: "Ohc" };

const defaultSettings = { reminderDays: 30 };

// ── State ─────────────────────────────────────────────────────────────────────
let state   = { employees: [], settings: { ...defaultSettings } };
let session = null;
let driveFileId = null;
let saveTimer   = null;

// ── DOM refs (shared) ────────────────────────────────────────────────────────
const loginView  = document.getElementById("loginView");
const appShell   = document.getElementById("appShell");
const toast      = document.getElementById("toast");
const views      = document.querySelectorAll(".view");
const tabs       = document.querySelectorAll(".nav-tab");
const syncStatus = document.getElementById("syncStatus");
const syncLabel  = document.getElementById("syncLabel");

const alertSettingsForm = document.getElementById("alertSettingsForm");

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

  document.getElementById("loginLoading").classList.remove("hidden");
  _tokenClient.requestAccessToken({ prompt: "" });
}

document.getElementById("driveConsentBtn").addEventListener("click", () => {
  if (!_tokenClient) return;
  document.getElementById("loginLoading").classList.remove("hidden");
  document.getElementById("driveConsentBtn").classList.add("hidden");
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
      driveFileId = list.files[0].id;
      const fileRes = await driveReq("GET",
        `https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`
      );
      if (fileRes.ok) {
        const raw = await fileRes.json().catch(()=>({}));
        state = { employees: (raw.employees||[]).map(normalizeEmployee), settings: normalizeSettings(raw.settings||{}) };
      }
    } else {
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

// ── Tab navigation ────────────────────────────────────────────────────────────
tabs.forEach(tab => tab.addEventListener("click", () => {
  tabs.forEach(t => t.classList.toggle("active", t === tab));
  views.forEach(v => v.classList.toggle("active-view", v.id === tab.dataset.view));
}));

function showView(id) {
  tabs.forEach(t => t.classList.toggle("active", t.dataset.view === id));
  views.forEach(v => v.classList.toggle("active-view", v.id === id));
}

// ── Per-section (BFS / OHC) wiring ─────────────────────────────────────────────
// Each section ("bfs" / "ohc") has its own: add-employee form, bulk employee CSV
// upload, bulk certificate-file upload, register table + filters, and a cert
// edit panel. They all operate on the SAME shared `state.employees` array.

function initSection(type) {
  const sfx = SECTION_SUFFIX[type];

  const employeeForm   = document.getElementById(`employeeForm${sfx}`);
  const showBulkBtn    = document.getElementById(`showBulkUpload${sfx}`);
  const bulkEmpSection = document.getElementById(`bulkEmpSection${sfx}`);
  const bulkUploadForm = document.getElementById(`bulkUploadForm${sfx}`);
  const downloadTplBtn = document.getElementById(`downloadEmployeeTemplate${sfx}`);
  const cancelEditBtn  = document.getElementById(`cancelEmployeeEdit${sfx}`);

  const bulkCertInput   = document.getElementById(`bulkCertInput${sfx}`);
  const bulkCertPreview = document.getElementById(`bulkCertPreview${sfx}`);
  const bulkCertActions = document.getElementById(`bulkCertActions${sfx}`);
  const bulkCertConfirm = document.getElementById(`bulkCertConfirm${sfx}`);
  const bulkCertClear   = document.getElementById(`bulkCertClear${sfx}`);

  const search     = document.getElementById(`employeeSearch${sfx}`);
  const deptFilter = document.getElementById(`employeeDepartmentFilter${sfx}`);
  const statFilter = document.getElementById(`employeeStatusFilter${sfx}`);

  const certEditPanel = document.getElementById(`certEditPanel${sfx}`);
  const certificateForm = document.getElementById(`certificateForm${sfx}`);

  // -- Add / edit employee (only this section's issue-date field is present) --
  employeeForm.addEventListener("submit", e => {
    e.preventDefault();
    const d = formData(e.currentTarget);
    const existing = state.employees.find(x => x.id === d.editingId);
    const dupId = state.employees.find(x => x.employeeId.toLowerCase() === d.employeeId.trim().toLowerCase() && x.id !== d.editingId);
    if (dupId) { showToast("Employee ID already in use."); return; }
    const certs = existing?.certificates || createEmptyCertificates();
    const issueDate = parseDate(d[`${type}IssueDate`]);
    if (issueDate) {
      certs[type] = { ...(certs[type]||{}), issueDate, expiryDate: calcExpiry(issueDate, CERTIFICATES[type].validYears), updatedAt: new Date().toISOString() };
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
    persist(); resetEmployeeForm(type); renderAll();
    showToast(existing ? "Employee updated." : "Employee added.");
  });

  cancelEditBtn.addEventListener("click", () => resetEmployeeForm(type));

  // -- Bulk employee upload toggle --
  showBulkBtn.addEventListener("click", () => {
    const isHidden = bulkEmpSection.classList.toggle("hidden");
    showBulkBtn.textContent = isHidden ? "⬆ Bulk Upload Employees" : "✕ Close";
  });

  downloadTplBtn.addEventListener("click", () => downloadTemplate(type));

  bulkUploadForm.addEventListener("submit", async e => {
    e.preventDefault();
    const file = e.currentTarget.elements.csvFile.files[0];
    if (!file) return;
    const result = importFromCsv(await file.text());
    persist(); e.currentTarget.reset(); renderAll();
    showToast(`CSV done: ${result.added} added, ${result.updated} updated, ${result.skipped} skipped.`);
  });

  // -- Bulk certificate file upload (fixed to this section's type) --
  let rows = [];
  bulkCertInput.addEventListener("change", () => {
    if (!bulkCertInput.files?.length) { bulkCertPreview.classList.add("hidden"); bulkCertActions.classList.add("hidden"); return; }
    rows = buildPreview(bulkCertInput.files);
    renderPreview(rows, bulkCertPreview, type);
    bulkCertActions.classList.remove("hidden");
  });

  bulkCertConfirm.addEventListener("click", async () => {
    const count = await applyBulkFiles(rows, type);
    persist(); renderAll();
    showToast(`${count} ${CERTIFICATES[type].label} file(s) attached.`);
    bulkCertInput.value = ""; bulkCertPreview.classList.add("hidden"); bulkCertActions.classList.add("hidden"); rows = [];
  });

  bulkCertClear.addEventListener("click", () => {
    bulkCertInput.value = ""; bulkCertPreview.classList.add("hidden"); bulkCertActions.classList.add("hidden"); rows = [];
  });

  // -- Filters --
  search.addEventListener("input", () => renderSectionRows(type));
  deptFilter.addEventListener("change", () => renderSectionRows(type));
  statFilter.addEventListener("change", () => renderSectionRows(type));

  // -- Certificate edit panel for this section --
  certificateForm.addEventListener("submit", async e => {
    e.preventDefault();
    const d = formData(e.currentTarget);
    const emp = state.employees.find(x => x.id === d.employeeId);
    if (!emp) return;
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
    persist(); hideCertEdit(type); renderAll();
    showToast(`${CERTIFICATES[type].label} saved for ${emp.name}.`);
  });

  certificateForm.elements.issueDate.addEventListener("change", e => {
    if (e.target.value) certificateForm.elements.expiryDate.value = calcExpiry(e.target.value, CERTIFICATES[type].validYears);
  });

  document.getElementById(`cancelCertEdit${sfx}`).addEventListener("click", () => hideCertEdit(type));
}

function resetEmployeeForm(type) {
  const sfx = SECTION_SUFFIX[type];
  const form = document.getElementById(`employeeForm${sfx}`);
  form.reset();
  form.elements.editingId.value = "";
  document.getElementById(`employeeFormTitle${sfx}`).textContent = "Add Employee";
  document.getElementById(`employeeSubmitButton${sfx}`).textContent = "Add Employee";
  document.getElementById(`cancelEmployeeEdit${sfx}`).classList.add("hidden");
}

function showCertEdit(empId, type) {
  const emp = state.employees.find(x => x.id === empId);
  if (!emp) return;
  const sfx = SECTION_SUFFIX[type];
  const panel = document.getElementById(`certEditPanel${sfx}`);
  const certificateForm = document.getElementById(`certificateForm${sfx}`);
  document.getElementById(`certEditTitle${sfx}`).textContent = `Edit ${CERTIFICATES[type].label} – ${emp.name}`;
  certificateForm.elements.employeeId.value = empId;
  certificateForm.elements.issueDate.value  = emp.certificates[type]?.issueDate  || "";
  certificateForm.elements.expiryDate.value = emp.certificates[type]?.expiryDate || "";
  panel.classList.remove("hidden");
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function hideCertEdit(type) {
  const sfx = SECTION_SUFFIX[type];
  document.getElementById(`certEditPanel${sfx}`).classList.add("hidden");
  document.getElementById(`certificateForm${sfx}`).reset();
}

function editEmployee(id, type) {
  const e = state.employees.find(x => x.id === id);
  if (!e) return;
  const sfx = SECTION_SUFFIX[type];
  const form = document.getElementById(`employeeForm${sfx}`);
  form.elements.editingId.value  = e.id;
  form.elements.name.value       = e.name;
  form.elements.employeeId.value = e.employeeId;
  form.elements.department.value = e.department;
  form.elements[`${type}IssueDate`].value = e.certificates?.[type]?.issueDate || "";
  document.getElementById(`employeeFormTitle${sfx}`).textContent     = `Editing: ${e.name}`;
  document.getElementById(`employeeSubmitButton${sfx}`).textContent  = "Save Changes";
  document.getElementById(`cancelEmployeeEdit${sfx}`).classList.remove("hidden");
  showView(type);
  form.elements.name.focus();
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function deleteEmployee(id) {
  const e = state.employees.find(x => x.id === id);
  if (!e || !confirm(`Remove ${e.name}?`)) return;
  state.employees = state.employees.filter(x => x.id !== id);
  persist(); renderAll(); showToast("Employee removed.");
}

function clearCertificate(empId, type) {
  const e = state.employees.find(x => x.id === empId);
  if (!e) return;
  if (!confirm(`Delete the ${CERTIFICATES[type].label} certificate for ${e.name}? This removes the uploaded file and dates.`)) return;
  e.certificates[type] = {};
  e.updatedAt = new Date().toISOString();
  persist(); renderAll();
  showToast(`${CERTIFICATES[type].label} certificate deleted for ${e.name}.`);
}

document.body.addEventListener("click", e => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const a = btn.dataset.action;
  if (a === "edit-emp")  editEmployee(btn.dataset.id, btn.dataset.section);
  if (a === "del-emp")   deleteEmployee(btn.dataset.id);
  if (a === "edit-cert") showCertEdit(btn.dataset.eid, btn.dataset.type);
  if (a === "del-cert")  clearCertificate(btn.dataset.eid, btn.dataset.type);
});

// ── Bulk certificate file matching (shared logic, parameterized by type) ─────
function buildPreview(files) {
  return Array.from(files).map(f => ({ file: f, match: matchFile(f.name) }));
}

function matchFile(fileName) {
  const base = fileName.replace(/\.[^.]+$/, "").trim().toLowerCase();
  const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const baseNorm = normalize(base);
  const firstName = e => e.name.trim().split(/\s+/)[0].toLowerCase();
  const lastName  = e => e.name.trim().split(/\s+/).slice(-1)[0].toLowerCase();
  let emp = state.employees.find(e => e.employeeId.trim().toLowerCase() === base);
  if (!emp) emp = state.employees.find(e => e.name.trim().toLowerCase() === base);
  if (!emp) emp = state.employees.find(e => normalize(e.name) === baseNorm);
  if (!emp) emp = state.employees.find(e => firstName(e) === base);
  if (!emp) emp = state.employees.find(e => lastName(e) === base);
  if (!emp) emp = state.employees.find(e => base.includes(e.employeeId.trim().toLowerCase()));
  if (!emp) emp = state.employees.find(e => baseNorm.includes(normalize(firstName(e))) && normalize(firstName(e)).length > 2);
  if (!emp) emp = state.employees.find(e => baseNorm.includes(normalize(e.name)));
  return emp ? { employee: emp } : null;
}

function renderPreview(rows, el, type) {
  const matched = rows.filter(r => r.match).length;
  let html = `<p class="bulk-summary">${matched} of ${rows.length} file(s) matched · Type: <strong>${CERTIFICATES[type].label}</strong></p>`;
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

// ── Other top-level controls ──────────────────────────────────────────────────
document.getElementById("exportPdf").addEventListener("click", exportPDF);
document.getElementById("exportPdfTop").addEventListener("click", exportPDF);
document.getElementById("prepareAllAlerts").addEventListener("click", () => sendSlackAlert());

// ── Alert settings ────────────────────────────────────────────────────────────
alertSettingsForm.addEventListener("submit", e => {
  e.preventDefault();
  const d = formData(e.currentTarget);
  state.settings = { reminderDays: Number(d.reminderDays) };
  persist(); renderAll(); sendSlackAlert();
});

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  const ok = Boolean(session?.email);
  loginView.classList.toggle("hidden", ok);
  appShell.classList.toggle("hidden", !ok);
  document.getElementById("signedInEmail").textContent = session?.email || "—";
  if (!ok) return;
  renderAll();
}

function renderAll() {
  renderDeptFilterOptions();
  renderDashboard();
  CERT_TYPES.forEach(renderSectionRows);
  renderAlertSettings();
  renderAlertQueue();
}

function renderDeptFilterOptions() {
  const depts = [...new Set(state.employees.map(e => e.department).filter(Boolean))].sort((a,b) => a.localeCompare(b));
  CERT_TYPES.forEach(type => {
    const sfx = SECTION_SUFFIX[type];
    const el = document.getElementById(`employeeDepartmentFilter${sfx}`);
    const cur = el.value || "all";
    el.innerHTML = ['<option value="all">All departments</option>', ...depts.map(d => `<option value="${escHtml(d)}">${escHtml(d)}</option>`)].join("");
    el.value = depts.includes(cur) ? cur : "all";
  });
}

function renderDashboard() {
  const sums = getCertSummaries();
  const by = countBy(sums, "status");
  const urgent = sums.filter(s => s.status === "Expired" || s.status === "Expiring in 30 Days").sort((a,b) => a.daysLeft - b.daysLeft);
  const uc = (by.Expired||0) + (by["Expiring in 30 Days"]||0);
  document.getElementById("employeeMetric").textContent = state.employees.length;
  document.getElementById("urgentMetric").textContent   = uc;
  document.getElementById("attentionCount").textContent = `${urgent.length} items`;
  const pill = document.getElementById("overallStatus");
  pill.textContent = uc ? "Action Needed" : "Compliant";
  pill.classList.toggle("risk", Boolean(uc));

  CERT_TYPES.forEach(type => {
    const sfx = SECTION_SUFFIX[type].toLowerCase();
    const typeBy = countBy(state.employees.map(e => getCertSummary(e, type)), "status");
    document.getElementById(`${sfx}ValidMetric`).textContent   = typeBy.Valid || 0;
    document.getElementById(`${sfx}NinetyMetric`).textContent  = typeBy["Expiring in 90 Days"] || 0;
    document.getElementById(`${sfx}ThirtyMetric`).textContent  = typeBy["Expiring in 30 Days"] || 0;
    document.getElementById(`${sfx}ExpiredMetric`).textContent = typeBy.Expired || 0;
    document.getElementById(`${sfx}MissingMetric`).textContent = typeBy.Missing || 0;
  });

  setRows("attentionRows", urgent.slice(0,8).map(s => `<tr>
    <td>${escHtml(s.emp.name)}<br><small>${escHtml(s.emp.employeeId)}</small></td>
    <td>${escHtml(s.cert.label)}</td>
    <td>${fmtDate(s.expiryDate)}</td>
    <td>${badge(s.status)}</td>
    <td><button class="text-btn" type="button" data-slack-item='${escAttr(JSON.stringify(summaryToItem(s)))}'>Send to Slack</button></td>
  </tr>`), 5, "No urgent renewals.");

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

function renderSectionRows(type) {
  const sfx = SECTION_SUFFIX[type];
  const search     = document.getElementById(`employeeSearch${sfx}`);
  const deptFilter = document.getElementById(`employeeDepartmentFilter${sfx}`);
  const statFilter = document.getElementById(`employeeStatusFilter${sfx}`);

  const q    = search.value.trim().toLowerCase();
  const dept = deptFilter.value;
  const stat = statFilter.value;

  const emps = state.employees.filter(e => {
    const searchable = [e.name, e.employeeId, e.department].join(" ").toLowerCase();
    const sum = getCertSummary(e, type);
    const matchQ    = searchable.includes(q);
    const matchDept = dept === "all" || e.department === dept;
    const matchStat = stat === "all" || (stat === "Expiring"
      ? (sum.status === "Expiring in 30 Days" || sum.status === "Expiring in 90 Days")
      : sum.status === stat);
    return matchQ && matchDept && matchStat;
  });

  setRows(`staffRows${sfx}`, emps.map(e => {
    const sum = getCertSummary(e, type);
    return `<tr>
      <td><strong>${escHtml(e.name)}</strong></td>
      <td>${escHtml(e.employeeId)}</td>
      <td>${escHtml(e.department)}</td>
      <td>
        <button class="cert-status-btn" type="button" title="Edit ${CERTIFICATES[type].label} certificate" aria-label="Edit ${CERTIFICATES[type].label} certificate" data-action="edit-cert" data-eid="${e.id}" data-type="${type}">
          ${badge(sum.status)}
        </button>
      </td>
      <td>${fmtDate(sum.issueDate)}</td>
      <td>${fmtDate(sum.expiryDate)}</td>
      <td class="cert-file-cell">
        ${fileLink(sum.record.file)}
        ${(sum.record.file || sum.record.issueDate) ? `<button class="icon-btn danger" type="button" title="Delete ${CERTIFICATES[type].label} certificate" aria-label="Delete ${CERTIFICATES[type].label} certificate" data-action="del-cert" data-eid="${e.id}" data-type="${type}">🗑</button>` : ""}
      </td>
      <td class="row-actions">
        <button class="text-btn" type="button" data-action="edit-emp" data-id="${e.id}" data-section="${type}">Edit</button>
        <button class="text-btn danger" type="button" data-action="del-emp" data-id="${e.id}">Remove</button>
      </td>
    </tr>`;
  }), 8, "No employees match this filter.");
}

function renderAlertSettings() {
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
        <div class="alert-actions"><button class="primary-btn" type="button" data-slack-item='${escAttr(JSON.stringify(summaryToItem(s)))}'>Send to Slack</button></div>
      </div>`).join("")
    : '<div class="empty-state">No alerts due.</div>';
}

document.getElementById("alertQueue").addEventListener("click", e => {
  const btn = e.target.closest("[data-slack-item]");
  if (!btn) return;
  sendSlackAlert([JSON.parse(btn.dataset.slackItem)]);
});
document.getElementById("attentionRows").addEventListener("click", e => {
  const btn = e.target.closest("[data-slack-item]");
  if (!btn) return;
  sendSlackAlert([JSON.parse(btn.dataset.slackItem)]);
});

// ── Certificate logic ─────────────────────────────────────────────────────────
function getCertSummaries() {
  return state.employees.flatMap(e => CERT_TYPES.map(t => getCertSummary(e,t)));
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

// ── Slack alerts ──────────────────────────────────────────────────────────────
function summaryToItem(s) {
  return {
    employeeName: s.emp.name,
    employeeId: s.emp.employeeId,
    department: s.emp.department,
    certType: s.cert.label,
    certFullName: s.cert.fullName,
    status: s.status,
    expiryDate: s.expiryDate || null,
    daysLeft: isFinite(s.daysLeft) ? s.daysLeft : null,
  };
}

function getAlertItems() {
  return getCertSummaries()
    .filter(s => s.status !== "Missing" && (s.daysLeft < 0 || s.daysLeft <= state.settings.reminderDays))
    .sort((a,b) => a.daysLeft - b.daysLeft);
}

async function sendSlackAlert(itemsOverride) {
  const items = itemsOverride || getAlertItems().map(summaryToItem);
  if (!items.length) { showToast("No alerts due."); return; }
  showToast("Sending to Slack…");
  try {
    const res = await fetch(SLACK_ALERT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items, reminderDays: state.settings.reminderDays, sentBy: session?.email || "unknown" }),
    });
    if (!res.ok) {
      const err = await res.json().catch(()=>({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    showToast(`Sent ${items.length} alert(s) to Slack.`);
  } catch (e) {
    console.error("Slack alert failed:", e);
    showToast("Slack alert failed — check server configuration.");
  }
}

// ── CSV import ────────────────────────────────────────────────────────────────
function importFromCsv(text) {
  const rows = parseCsv(text).filter(r => r.some(c => c.trim()));
  if (rows.length < 2) return { added:0, updated:0, skipped:0 };
  const hdrs = rows[0].map(h => h.toLowerCase().replace(/[^a-z0-9]/g,""));
  rows.slice(1).forEach(r => { while (r.length < hdrs.length) r.push(""); });
  let added=0, updated=0, skipped=0;
  rows.slice(1).forEach(row => {
    const rec = hdrs.reduce((o,h,i) => { o[h]=(row[i]||"").trim(); return o; }, {});
    if (!rec.employeeid || !rec.name || !rec.department) { skipped++; return; }
    const existing = state.employees.find(e => e.employeeId.toLowerCase() === rec.employeeid.toLowerCase());
    const certs = existing?.certificates || createEmptyCertificates();
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

function findRecKey(rec, prefix) {
  const key = Object.keys(rec).find(k => k.startsWith(prefix) && (k.includes("issue") || k.includes("date")));
  return key ? rec[key] : "";
}

function downloadTemplate(type) {
  const rows = type === "bfs"
    ? [["employeeId","name","department","bfsIssueDate"], ["CK-1001","Sample Employee","Kitchen","2026-01-15"]]
    : [["employeeId","name","department","ohcIssueDate"], ["CK-1001","Sample Employee","Kitchen","2026-03-01"]];
  downloadFile(`uae-kitchen-${type}-template-${today()}.csv`, rows.map(r=>r.map(csvEsc).join(",")).join("\n"), "text/csv;charset=utf-8");
}

// ── PDF export ────────────────────────────────────────────────────────────────
function exportPDF() {
  if (!window.jspdf || !window.jspdf.jsPDF) { showToast("PDF library still loading — try again in a moment."); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 40;
  let y = 50;

  // ── Header ──
  doc.setFont("helvetica", "bold"); doc.setFontSize(20); doc.setTextColor(17,24,39);
  doc.text("CALO", margin, y);
  doc.setFontSize(11); doc.setFont("helvetica","normal"); doc.setTextColor(107,114,128);
  doc.text("UAE Kitchen Compliance Portal", margin, y + 16);
  doc.setFontSize(14); doc.setFont("helvetica","bold"); doc.setTextColor(17,24,39);
  doc.text("Staff Certificate Compliance Report", margin, y + 40);
  doc.setFontSize(9); doc.setFont("helvetica","normal"); doc.setTextColor(107,114,128);
  doc.text(`Generated: ${fmtDate(today())}`, margin, y + 56);

  y += 80;

  // ── Executive summary tiles ──
  const sums = getCertSummaries();
  const by = countBy(sums, "status");
  const uc = (by.Expired||0) + (by["Expiring in 30 Days"]||0);
  const bfsBy = countBy(state.employees.map(e => getCertSummary(e,"bfs")), "status");
  const ohcBy = countBy(state.employees.map(e => getCertSummary(e,"ohc")), "status");

  doc.setFontSize(11); doc.setFont("helvetica","bold"); doc.setTextColor(17,24,39);
  doc.text("EXECUTIVE SUMMARY", margin, y);
  y += 14;

  const tiles = [
    { label: "TOTAL EMPLOYEES",   value: state.employees.length },
    { label: "BFS VALID",         value: bfsBy.Valid || 0 },
    { label: "BFS EXPIRING 30D",  value: bfsBy["Expiring in 30 Days"] || 0 },
    { label: "BFS EXPIRED",       value: bfsBy.Expired || 0 },
    { label: "OHC VALID",         value: ohcBy.Valid || 0 },
    { label: "OHC EXPIRING 30D",  value: ohcBy["Expiring in 30 Days"] || 0 },
    { label: "OHC EXPIRED",       value: ohcBy.Expired || 0 },
    { label: "ACTION NEEDED",     value: uc },
  ];

  const cols = 4, gap = 10, tileH = 52;
  const tileW = (pageW - margin*2 - gap*(cols-1)) / cols;
  tiles.forEach((t, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = margin + col * (tileW + gap);
    const ty = y + row * (tileH + gap);
    doc.setDrawColor(226,230,236); doc.setFillColor(248,250,252);
    doc.roundedRect(x, ty, tileW, tileH, 4, 4, "FD");
    doc.setFontSize(7); doc.setFont("helvetica","bold"); doc.setTextColor(107,114,128);
    doc.text(t.label, x + 10, ty + 17, { maxWidth: tileW - 20 });
    doc.setFontSize(18); doc.setFont("helvetica","bold"); doc.setTextColor(17,24,39);
    doc.text(String(t.value), x + 10, ty + 38);
  });

  y += Math.ceil(tiles.length / cols) * (tileH + gap) + 18;

  // ── BFS table ──
  doc.setFontSize(11); doc.setFont("helvetica","bold"); doc.setTextColor(17,24,39);
  doc.text("BFS — Basic Food Safety", margin, y);
  doc.autoTable({
    startY: y + 8,
    margin: { left: margin, right: margin },
    head: [["Name","ID","Department","Status","Issue Date","Expiry Date"]],
    body: state.employees.map(e => { const s = getCertSummary(e,"bfs"); return [e.name, e.employeeId, e.department, s.status, fmtDate(s.issueDate), fmtDate(s.expiryDate)]; }),
    styles: { fontSize: 8, cellPadding: 5 },
    headStyles: { fillColor: [22,163,74], textColor: 255, fontStyle: "bold" },
    theme: "grid",
  });

  y = doc.lastAutoTable.finalY + 26;
  if (y > 680) { doc.addPage(); y = 50; }

  // ── OHC table ──
  doc.setFontSize(11); doc.setFont("helvetica","bold"); doc.setTextColor(17,24,39);
  doc.text("OHC — Occupational Health Card", margin, y);
  doc.autoTable({
    startY: y + 8,
    margin: { left: margin, right: margin },
    head: [["Name","ID","Department","Status","Issue Date","Expiry Date"]],
    body: state.employees.map(e => { const s = getCertSummary(e,"ohc"); return [e.name, e.employeeId, e.department, s.status, fmtDate(s.issueDate), fmtDate(s.expiryDate)]; }),
    styles: { fontSize: 8, cellPadding: 5 },
    headStyles: { fillColor: [109,40,217], textColor: 255, fontStyle: "bold" },
    theme: "grid",
  });

  // ── Footer on every page ──
  const pageCount = doc.internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFontSize(8); doc.setTextColor(156,163,175);
    doc.text("UAE Kitchen Compliance Portal · Confidential · For internal use", pageW / 2, doc.internal.pageSize.getHeight() - 20, { align: "center" });
  }

  doc.save(`uae-kitchen-compliance-${today()}.pdf`);
  showToast("PDF report ready.");
}

// ── Normalise helpers ─────────────────────────────────────────────────────────
function normalizeEmployee(e) { return { ...e, certificates: { ...createEmptyCertificates(), ...(e.certificates||{}) } }; }
function normalizeSettings(s) { return { reminderDays: Number(s.reminderDays||defaultSettings.reminderDays) }; }
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
  return new Intl.DateTimeFormat("en-US",{year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(`${v}T00:00:00`));
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
function escAttr(v) {
  return escHtml(v).replaceAll("'", "&#039;");
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

// Accepts: YYYY-MM-DD, DD/MM/YYYY, MM/DD/YYYY, DD/MM/YY, DD-MM-YY,
//          named months with 2 or 4-digit year (16-Jun-26), Excel serials
// Returns "YYYY-MM-DD" or null
function parseDate(v) {
  if (!v || !String(v).trim()) return null;
  const s = String(v).trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00`);
    return isNaN(d) ? null : s;
  }

  if (/^\d{4,5}$/.test(s)) {
    const serial = parseInt(s, 10);
    if (serial > 1000 && serial < 100000) {
      const d = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
      if (!isNaN(d)) return d.toISOString().slice(0, 10);
    }
    return null;
  }

  const expandYear = yy => { const n = parseInt(yy, 10); return String(n <= 29 ? 2000 + n : 1900 + n); };

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

  const dmy = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (dmy) {
    const [, dd, mm, rawY] = dmy;
    const yyyy = rawY.length === 2 ? expandYear(rawY) : rawY;
    const d1 = new Date(`${yyyy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}T00:00:00`);
    if (!isNaN(d1) && d1.getMonth() + 1 === parseInt(mm)) {
      return `${yyyy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}`;
    }
    const d2 = new Date(`${yyyy}-${dd.padStart(2,'0')}-${mm.padStart(2,'0')}T00:00:00`);
    if (!isNaN(d2)) return `${yyyy}-${dd.padStart(2,'0')}-${mm.padStart(2,'0')}`;
    return null;
  }

  const ymd = s.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})$/);
  if (ymd) {
    const [, yyyy, mm, dd] = ymd;
    const iso = `${yyyy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}`;
    const d = new Date(`${iso}T00:00:00`);
    return isNaN(d) ? null : iso;
  }

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
CERT_TYPES.forEach(initSection);
render();
initGoogleSignIn();
