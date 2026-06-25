// ── Supabase ──────────────────────────────────────────────────────────────────
const SUPABASE_URL  = "https://iflquskysqchhbywvmow.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlmbHF1c2t5c3FjaGhieXd2bW93Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4NjM3ODIsImV4cCI6MjA5NzQzOTc4Mn0.FFcd80AqZ8hpyi-Bs_rPnCNZNp075YqBYM1yAYeyGUw";
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

// ── Constants ─────────────────────────────────────────────────────────────────
const EDITOR_EMAILS = ["m.illikkal@calo.app", "j.swamy@calo.app"];

const CERTIFICATES = {
  bfs: { label: "BFS", fullName: "Basic Food Safety",        validYears: 2 },
  ohc: { label: "OHC", fullName: "Occupational Health Card", validYears: 1 },
};
const CERT_TYPES     = Object.keys(CERTIFICATES);
const SECTION_SUFFIX = { bfs: "Bfs", ohc: "Ohc" };
const defaultSettings = { reminderDays: 30, managerEmail: "" };

// ── State ─────────────────────────────────────────────────────────────────────
let state    = { employees: [], settings: { ...defaultSettings } };
let session  = null;   // supabase user object
let isEditor = false;
let saveTimer = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const loginView       = document.getElementById("loginView");
const appShell        = document.getElementById("appShell");
const toast           = document.getElementById("toast");
const views           = document.querySelectorAll(".view");
const tabs            = document.querySelectorAll(".nav-tab");
const syncStatus      = document.getElementById("syncStatus");
const syncLabel       = document.getElementById("syncLabel");
const alertSettingsForm = document.getElementById("alertSettingsForm");

// ── Login form ────────────────────────────────────────────────────────────────
document.getElementById("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  const email    = document.getElementById("loginEmail").value.trim().toLowerCase();
  const password = document.getElementById("loginPassword").value;
  const errEl    = document.getElementById("loginError");
  const btn      = document.getElementById("loginSubmitBtn");
  errEl.classList.add("hidden");
  btn.textContent = "Signing in…"; btn.disabled = true;
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  btn.textContent = "Sign in"; btn.disabled = false;
  if (error) { errEl.textContent = error.message; errEl.classList.remove("hidden"); return; }
  await onSignIn(data.user);
});

// Password visibility toggle
document.getElementById("togglePw").addEventListener("click", () => {
  const pw = document.getElementById("loginPassword");
  pw.type = pw.type === "password" ? "text" : "password";
});

async function onSignIn(user) {
  session  = user;
  isEditor = EDITOR_EMAILS.includes(user.email.toLowerCase());
  setSyncState("syncing");
  await loadFromSupabase();
  render();
  showToast(`Welcome, ${(user.email.split("@")[0])}!`);
}

// ── Sign out ──────────────────────────────────────────────────────────────────
async function signOut() {
  await sb.auth.signOut();
  session = null; isEditor = false;
  state = { employees: [], settings: { ...defaultSettings } };
  render();
}
document.getElementById("signOutButton").addEventListener("click", signOut);

// ── Supabase data layer ───────────────────────────────────────────────────────

async function loadFromSupabase() {
  try {
    // Load employees
    const { data: emps, error: empErr } = await sb.from("employees").select("*").order("created_at", { ascending: false });
    if (empErr) throw empErr;

    // Load certificates
    const { data: certs, error: certErr } = await sb.from("certificates").select("*");
    if (certErr) throw certErr;

    // Load settings
    const { data: settings } = await sb.from("settings").select("*").eq("id", 1).single();

    // Merge into state
    state.employees = (emps || []).map(emp => {
      const empCerts = (certs || []).filter(c => c.employee_id === emp.id);
      const bfs = empCerts.find(c => c.type === "bfs") || {};
      const ohc = empCerts.find(c => c.type === "ohc") || {};
      return {
        id: emp.id,
        name: emp.name,
        employeeId: emp.employee_id,
        department: emp.department,
        createdAt: emp.created_at,
        updatedAt: emp.updated_at,
        certificates: {
          bfs: bfs.id ? { issueDate: bfs.issue_date||"", expiryDate: bfs.expiry_date||"", file: bfs.file_name ? { name: bfs.file_name, dataUrl: bfs.file_data, type: "application/pdf" } : null } : {},
          ohc: ohc.id ? { issueDate: ohc.issue_date||"", expiryDate: ohc.expiry_date||"", file: ohc.file_name ? { name: ohc.file_name, dataUrl: ohc.file_data, type: "application/pdf" } : null } : {},
        },
        _certIds: { bfs: bfs.id || null, ohc: ohc.id || null },
      };
    });

    state.settings = settings ? { reminderDays: settings.reminder_days, managerEmail: settings.manager_email || "" } : { ...defaultSettings };
    setSyncState("idle");
  } catch(e) {
    console.error("loadFromSupabase:", e);
    setSyncState("error");
    showToast("Could not load data — check connection.");
  }
}

async function upsertEmployee(emp) {
  const { data, error } = await sb.from("employees").upsert({
    id: emp.id,
    name: emp.name,
    employee_id: emp.employeeId,
    department: emp.department,
    updated_at: new Date().toISOString(),
  }, { onConflict: "id" }).select().single();
  if (error) throw error;
  return data.id;
}

async function upsertCertificate(empDbId, type, cert, existingId) {
  const payload = {
    employee_id: empDbId,
    type,
    issue_date:  cert.issueDate  || null,
    expiry_date: cert.expiryDate || null,
    file_name:   cert.file?.name || null,
    file_data:   cert.file?.dataUrl || null,
    updated_at:  new Date().toISOString(),
  };
  if (existingId) payload.id = existingId;
  const { error } = await sb.from("certificates").upsert(payload, { onConflict: "employee_id,type" });
  if (error) throw error;
}

async function deleteEmployeeFromDb(empId) {
  const { error } = await sb.from("employees").delete().eq("id", empId);
  if (error) throw error;
}

async function deleteCertFromDb(empDbId, type) {
  const { error } = await sb.from("certificates").delete().eq("employee_id", empDbId).eq("type", type);
  if (error) throw error;
}

async function saveSettingsToDb(settings) {
  const { error } = await sb.from("settings").upsert({ id: 1, manager_email: settings.managerEmail, reminder_days: settings.reminderDays }, { onConflict: "id" });
  if (error) throw error;
}

// ── Persist (debounced write to Supabase) ─────────────────────────────────────
function persist(fn) {
  if (!isEditor) return;
  clearTimeout(saveTimer);
  setSyncState("syncing");
  saveTimer = setTimeout(async () => {
    try { await fn(); setSyncState("idle"); }
    catch(e) { console.error(e); setSyncState("error"); showToast("Save failed — check connection."); }
  }, 400);
}

function setSyncState(s) {
  syncStatus.className = "sync-status sync-" + s;
  syncLabel.textContent = s === "syncing" ? "Saving…" : s === "error" ? "Save failed" : "Saved";
}

// ── Tab navigation ─────────────────────────────────────────────────────────────
tabs.forEach(tab => tab.addEventListener("click", () => {
  tabs.forEach(t => t.classList.toggle("active", t === tab));
  views.forEach(v => v.classList.toggle("active-view", v.id === tab.dataset.view));
}));
function showView(id) {
  tabs.forEach(t => t.classList.toggle("active", t.dataset.view === id));
  views.forEach(v => v.classList.toggle("active-view", v.id === id));
}

// ── Cert upload modal ──────────────────────────────────────────────────────────
const certUploadModal     = document.getElementById("certUploadModal");
const certUploadModalForm = document.getElementById("certUploadModalForm");

function openCertModal(empId, type) {
  const emp = state.employees.find(x => x.id === empId); if (!emp) return;
  document.getElementById("certUploadModalTitle").textContent = `Upload ${CERTIFICATES[type].label} – ${emp.name}`;
  certUploadModalForm.elements.employeeId.value = empId;
  certUploadModalForm.elements.type.value       = type;
  certUploadModalForm.elements.issueDate.value  = emp.certificates[type]?.issueDate  || "";
  certUploadModalForm.elements.expiryDate.value = emp.certificates[type]?.expiryDate || "";
  certUploadModalForm.elements.file.value = "";
  certUploadModal.classList.remove("hidden");
}
function closeCertModal() { certUploadModal.classList.add("hidden"); certUploadModalForm.reset(); }
document.getElementById("certUploadModalClose").addEventListener("click", closeCertModal);
document.getElementById("certUploadModalCancel").addEventListener("click", closeCertModal);
certUploadModal.addEventListener("click", e => { if (e.target === certUploadModal) closeCertModal(); });
certUploadModalForm.elements.issueDate.addEventListener("change", e => {
  const type = certUploadModalForm.elements.type.value;
  if (e.target.value && type) certUploadModalForm.elements.expiryDate.value = calcExpiry(e.target.value, CERTIFICATES[type].validYears);
});
certUploadModalForm.addEventListener("submit", async e => {
  e.preventDefault();
  const d    = formData(e.currentTarget);
  const emp  = state.employees.find(x => x.id === d.employeeId); if (!emp) return;
  const type = d.type;
  const file = e.currentTarget.elements.file.files[0];
  const prev = emp.certificates[type] || {};
  const uploaded = file ? await readCertFile(file) : prev.file || null;
  const certData = {
    issueDate:  d.issueDate  || prev.issueDate  || "",
    expiryDate: d.expiryDate || prev.expiryDate || (d.issueDate ? calcExpiry(d.issueDate, CERTIFICATES[type].validYears) : ""),
    file: uploaded,
  };
  emp.certificates[type] = certData;
  persist(async () => { await upsertCertificate(emp.id, type, certData, emp._certIds?.[type]); });
  closeCertModal(); renderAll();
  showToast(`${CERTIFICATES[type].label} certificate saved for ${emp.name}.`);
});

// ── Per-section (BFS / OHC) wiring ────────────────────────────────────────────
function initSection(type) {
  const sfx = SECTION_SUFFIX[type];
  const employeeForm    = document.getElementById(`employeeForm${sfx}`);
  const showBulkCertBtn = document.getElementById(`showBulkCert${sfx}`);
  const showBulkEmpBtn  = document.getElementById(`showBulkUpload${sfx}`);
  const bulkCertSection = document.getElementById(`bulkCertSection${sfx}`);
  const bulkEmpSection  = document.getElementById(`bulkEmpSection${sfx}`);
  const bulkUploadForm  = document.getElementById(`bulkUploadForm${sfx}`);
  const downloadTplBtn  = document.getElementById(`downloadEmployeeTemplate${sfx}`);
  const cancelEditBtn   = document.getElementById(`cancelEmployeeEdit${sfx}`);
  const bulkCertInput   = document.getElementById(`bulkCertInput${sfx}`);
  const bulkCertPreview = document.getElementById(`bulkCertPreview${sfx}`);
  const bulkCertActions = document.getElementById(`bulkCertActions${sfx}`);
  const bulkCertConfirm = document.getElementById(`bulkCertConfirm${sfx}`);
  const bulkCertClear   = document.getElementById(`bulkCertClear${sfx}`);
  const search          = document.getElementById(`employeeSearch${sfx}`);
  const deptFilter      = document.getElementById(`employeeDepartmentFilter${sfx}`);
  const statFilter      = document.getElementById(`employeeStatusFilter${sfx}`);
  const certificateForm = document.getElementById(`certificateForm${sfx}`);

  // Add / edit employee
  employeeForm.addEventListener("submit", async e => {
    e.preventDefault(); if (!isEditor) return;
    const d = formData(e.currentTarget);
    const existing = state.employees.find(x => x.id === d.editingId);
    const dupId = state.employees.find(x => x.employeeId.toLowerCase() === d.employeeId.trim().toLowerCase() && x.id !== d.editingId);
    if (dupId) { showToast("Employee ID already in use."); return; }
    const id = existing?.id || crypto.randomUUID();
    const issueDate = parseDate(d[`${type}IssueDate`]);
    const certData = existing?.certificates || createEmptyCertificates();
    if (issueDate) certData[type] = { ...(certData[type]||{}), issueDate, expiryDate: calcExpiry(issueDate, CERTIFICATES[type].validYears) };
    const emp = { id, name: d.name.trim(), employeeId: d.employeeId.trim(), department: d.department.trim(), certificates: certData, _certIds: existing?._certIds || {}, createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
    state.employees = existing ? state.employees.map(x => x.id === existing.id ? emp : x) : [emp, ...state.employees];
    resetEmployeeForm(type); renderAll();
    persist(async () => {
      const dbId = await upsertEmployee(emp);
      if (issueDate) await upsertCertificate(dbId, type, certData[type], emp._certIds?.[type]);
    });
    showToast(existing ? "Employee updated." : "Employee added.");
  });

  cancelEditBtn.addEventListener("click", () => resetEmployeeForm(type));

  // Bulk cert toggle
  showBulkCertBtn.addEventListener("click", () => {
    const h = bulkCertSection.classList.toggle("hidden");
    bulkEmpSection.classList.add("hidden");
    showBulkEmpBtn.textContent  = "⬆ Bulk Upload Employees";
    showBulkCertBtn.textContent = h ? `📎 Bulk Upload ${CERTIFICATES[type].label} Files` : "✕ Close Files";
  });

  // Bulk employee toggle
  showBulkEmpBtn.addEventListener("click", () => {
    const h = bulkEmpSection.classList.toggle("hidden");
    bulkCertSection.classList.add("hidden");
    showBulkCertBtn.textContent = `📎 Bulk Upload ${CERTIFICATES[type].label} Files`;
    showBulkEmpBtn.textContent  = h ? "⬆ Bulk Upload Employees" : "✕ Close";
  });

  downloadTplBtn.addEventListener("click", () => downloadTemplate(type));

  bulkUploadForm.addEventListener("submit", async e => {
    e.preventDefault(); if (!isEditor) return;
    const file = e.currentTarget.elements.csvFile.files[0]; if (!file) return;
    const result = await importFromCsv(await file.text());
    e.currentTarget.reset(); renderAll();
    showToast(`CSV done: ${result.added} added, ${result.updated} updated, ${result.skipped} skipped.`);
  });

  // Bulk cert file upload
  let rows = [];
  bulkCertInput.addEventListener("change", () => {
    if (!bulkCertInput.files?.length) { bulkCertPreview.classList.add("hidden"); bulkCertActions.classList.add("hidden"); return; }
    rows = buildPreview(bulkCertInput.files);
    renderPreview(rows, bulkCertPreview, type);
    bulkCertActions.classList.remove("hidden");
  });
  bulkCertConfirm.addEventListener("click", async () => {
    if (!isEditor) return;
    setSyncState("syncing");
    const count = await applyBulkFiles(rows, type);
    setSyncState("idle"); renderAll();
    showToast(`${count} ${CERTIFICATES[type].label} file(s) attached.`);
    bulkCertInput.value = ""; bulkCertPreview.classList.add("hidden"); bulkCertActions.classList.add("hidden"); rows = [];
  });
  bulkCertClear.addEventListener("click", () => {
    bulkCertInput.value = ""; bulkCertPreview.classList.add("hidden"); bulkCertActions.classList.add("hidden"); rows = [];
  });

  search.addEventListener("input",      () => renderSectionRows(type));
  deptFilter.addEventListener("change", () => renderSectionRows(type));
  statFilter.addEventListener("change", () => renderSectionRows(type));

  // Cert edit panel
  certificateForm.addEventListener("submit", async e => {
    e.preventDefault(); if (!isEditor) return;
    const d    = formData(e.currentTarget);
    const emp  = state.employees.find(x => x.id === d.employeeId); if (!emp) return;
    const file = e.currentTarget.elements.file.files[0];
    const prev = emp.certificates[type] || {};
    const uploaded  = file ? await readCertFile(file) : prev.file || null;
    const certData  = { issueDate: d.issueDate, expiryDate: d.expiryDate || calcExpiry(d.issueDate, CERTIFICATES[type].validYears), file: uploaded };
    emp.certificates[type] = certData;
    persist(async () => { await upsertCertificate(emp.id, type, certData, emp._certIds?.[type]); });
    hideCertEdit(type); renderAll();
    showToast(`${CERTIFICATES[type].label} saved for ${emp.name}.`);
  });
  certificateForm.elements.issueDate.addEventListener("change", e => {
    if (e.target.value) certificateForm.elements.expiryDate.value = calcExpiry(e.target.value, CERTIFICATES[type].validYears);
  });
  document.getElementById(`cancelCertEdit${sfx}`).addEventListener("click", () => hideCertEdit(type));
}

function resetEmployeeForm(type) {
  const sfx = SECTION_SUFFIX[type];
  document.getElementById(`employeeForm${sfx}`).reset();
  document.getElementById(`employeeForm${sfx}`).elements.editingId.value = "";
  document.getElementById(`employeeFormTitle${sfx}`).textContent    = "Add Employee";
  document.getElementById(`employeeSubmitButton${sfx}`).textContent = "Add Employee";
  document.getElementById(`cancelEmployeeEdit${sfx}`).classList.add("hidden");
}
function showCertEdit(empId, type) {
  const emp = state.employees.find(x => x.id === empId); if (!emp) return;
  const sfx  = SECTION_SUFFIX[type];
  const form = document.getElementById(`certificateForm${sfx}`);
  document.getElementById(`certEditTitle${sfx}`).textContent = `Edit ${CERTIFICATES[type].label} – ${emp.name}`;
  form.elements.employeeId.value = empId;
  form.elements.issueDate.value  = emp.certificates[type]?.issueDate  || "";
  form.elements.expiryDate.value = emp.certificates[type]?.expiryDate || "";
  document.getElementById(`certEditPanel${sfx}`).classList.remove("hidden");
  document.getElementById(`certEditPanel${sfx}`).scrollIntoView({ behavior: "smooth", block: "start" });
}
function hideCertEdit(type) {
  document.getElementById(`certEditPanel${SECTION_SUFFIX[type]}`).classList.add("hidden");
  document.getElementById(`certificateForm${SECTION_SUFFIX[type]}`).reset();
}
function editEmployee(id, type) {
  if (!isEditor) return;
  const e = state.employees.find(x => x.id === id); if (!e) return;
  const sfx  = SECTION_SUFFIX[type];
  const form = document.getElementById(`employeeForm${sfx}`);
  form.elements.editingId.value  = e.id;
  form.elements.name.value       = e.name;
  form.elements.employeeId.value = e.employeeId;
  form.elements.department.value = e.department;
  form.elements[`${type}IssueDate`].value = e.certificates?.[type]?.issueDate || "";
  document.getElementById(`employeeFormTitle${sfx}`).textContent    = `Editing: ${e.name}`;
  document.getElementById(`employeeSubmitButton${sfx}`).textContent = "Save Changes";
  document.getElementById(`cancelEmployeeEdit${sfx}`).classList.remove("hidden");
  showView(type); form.elements.name.focus();
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}
async function deleteEmployee(id) {
  if (!isEditor) return;
  const e = state.employees.find(x => x.id === id);
  if (!e || !confirm(`Remove ${e.name}?`)) return;
  state.employees = state.employees.filter(x => x.id !== id);
  renderAll();
  persist(async () => { await deleteEmployeeFromDb(id); });
  showToast("Employee removed.");
}
async function clearCertificate(empId, type) {
  if (!isEditor) return;
  const e = state.employees.find(x => x.id === empId);
  if (!e || !confirm(`Delete ${CERTIFICATES[type].label} certificate for ${e.name}?`)) return;
  e.certificates[type] = {};
  renderAll();
  persist(async () => { await deleteCertFromDb(empId, type); });
  showToast(`${CERTIFICATES[type].label} certificate deleted.`);
}

// ── Delegated click handler ────────────────────────────────────────────────────
document.body.addEventListener("click", e => {
  const btn = e.target.closest("[data-action]"); if (!btn) return;
  const a = btn.dataset.action;
  if (a === "edit-emp")    editEmployee(btn.dataset.id, btn.dataset.section);
  if (a === "del-emp")     deleteEmployee(btn.dataset.id);
  if (a === "edit-cert")   showCertEdit(btn.dataset.eid, btn.dataset.type);
  if (a === "del-cert")    clearCertificate(btn.dataset.eid, btn.dataset.type);
  if (a === "upload-cert") openCertModal(btn.dataset.eid, btn.dataset.type);
  if (a === "mail-alert")  openGmailDraft([JSON.parse(btn.dataset.item)]);
});

// ── Bulk cert file matching ────────────────────────────────────────────────────
function buildPreview(files) { return Array.from(files).map(f => ({ file: f, match: matchFile(f.name) })); }
function matchFile(fileName) {
  const base = fileName.replace(/\.[^.]+$/, "").trim().toLowerCase();
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  let emp = state.employees.find(e => e.employeeId.trim().toLowerCase() === base);
  if (!emp) emp = state.employees.find(e => norm(e.name) === norm(base));
  if (!emp) emp = state.employees.find(e => base.includes(e.employeeId.trim().toLowerCase()));
  return emp ? { employee: emp } : null;
}
function renderPreview(rows, el, type) {
  const matched = rows.filter(r => r.match).length;
  let html = `<p class="bulk-summary">${matched} of ${rows.length} file(s) matched · <strong>${CERTIFICATES[type].label}</strong></p>`;
  html += `<div class="table-wrap"><table><thead><tr><th>File</th><th>Matched Employee</th></tr></thead><tbody>`;
  rows.forEach(r => { html += `<tr><td>${escHtml(r.file.name)}</td><td>${r.match ? `<span class="status-valid">${escHtml(r.match.employee.name)}</span>` : `<span class="status-expired">No match</span>`}</td></tr>`; });
  html += `</tbody></table></div>`;
  el.innerHTML = html; el.classList.remove("hidden");
}
async function applyBulkFiles(rows, type) {
  let count = 0;
  for (const r of rows) {
    if (!r.match) continue;
    const emp = state.employees.find(e => e.id === r.match.employee.id); if (!emp) continue;
    const fileObj = await readCertFile(r.file);
    emp.certificates[type] = { ...(emp.certificates[type] || {}), file: fileObj };
    await upsertCertificate(emp.id, type, emp.certificates[type], emp._certIds?.[type]);
    count++;
  }
  return count;
}

// ── Alert settings ─────────────────────────────────────────────────────────────
alertSettingsForm.addEventListener("submit", async e => {
  e.preventDefault();
  const d = formData(e.currentTarget);
  state.settings = { reminderDays: Number(d.reminderDays), managerEmail: (d.managerEmail || "").trim().toLowerCase() };
  persist(async () => { await saveSettingsToDb(state.settings); });
  renderAll();
  openGmailDraft(getAlertItems().map(summaryToItem));
});
document.getElementById("prepareAllAlerts").addEventListener("click", () => openGmailDraft(getAlertItems().map(summaryToItem)));
document.getElementById("exportPdf").addEventListener("click", exportPDF);
document.getElementById("exportPdfTop").addEventListener("click", exportPDF);

// ── Gmail draft ────────────────────────────────────────────────────────────────
function openGmailDraft(items) {
  if (!items.length) { showToast("No alerts due."); return; }
  const to      = state.settings.managerEmail || "";
  const subject = encodeURIComponent(`UAE Kitchen Certificate Alert – ${items.length} item(s) need attention`);
  const lines   = ["Hello,", "", `The following ${items.length} certificate renewal(s) require attention:`, "",
    ...items.map(i => `• ${i.employeeName} (${i.employeeId}) · ${i.certType}: ${i.status}` + (i.expiryDate ? ` · Expires: ${fmtDate(i.expiryDate)}` : "") + (i.daysLeft !== null ? ` · ${fmtDays(i.daysLeft)}` : "")),
    "", "Please arrange renewals and update the portal once new certificates are issued.", "", "UAE Kitchen – Compliance Portal",
  ];
  window.open(`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${subject}&body=${encodeURIComponent(lines.join("\n"))}`, "_blank");
  showToast("Opening Gmail draft…");
}

// ── Render ─────────────────────────────────────────────────────────────────────
function render() {
  const ok = Boolean(session?.email);
  loginView.classList.toggle("hidden", ok);
  appShell.classList.toggle("hidden", !ok);
  document.getElementById("signedInEmail").textContent = session?.email || "—";
  if (!ok) return;
  document.querySelectorAll(".editor-only").forEach(el => el.classList.toggle("hidden", !isEditor));
  document.querySelectorAll(".editor-only-col").forEach(el => el.classList.toggle("hidden", !isEditor));
  document.getElementById("viewerBadge").classList.toggle("hidden", isEditor);
  renderAll();
}
function renderAll() {
  renderDeptFilterOptions(); renderDashboard();
  CERT_TYPES.forEach(renderSectionRows);
  renderAlertSettings(); renderAlertQueue();
}
function renderDeptFilterOptions() {
  const depts = [...new Set(state.employees.map(e => e.department).filter(Boolean))].sort((a,b) => a.localeCompare(b));
  CERT_TYPES.forEach(type => {
    const el  = document.getElementById(`employeeDepartmentFilter${SECTION_SUFFIX[type]}`);
    const cur = el.value || "all";
    el.innerHTML = ['<option value="all">All departments</option>', ...depts.map(d => `<option value="${escHtml(d)}">${escHtml(d)}</option>`)].join("");
    el.value = depts.includes(cur) ? cur : "all";
  });
}
function renderDashboard() {
  const sums   = getCertSummaries();
  const by     = countBy(sums, "status");
  const urgent = sums.filter(s => s.status === "Expired" || s.status === "Expiring in 30 Days").sort((a,b) => a.daysLeft - b.daysLeft);
  const uc     = (by.Expired||0) + (by["Expiring in 30 Days"]||0);
  document.getElementById("employeeMetric").textContent = state.employees.length;
  document.getElementById("urgentMetric").textContent   = uc;
  document.getElementById("attentionCount").textContent = `${urgent.length} items`;
  const pill = document.getElementById("overallStatus");
  pill.textContent = uc ? "Action Needed" : "Compliant";
  pill.classList.toggle("risk", Boolean(uc));
  CERT_TYPES.forEach(type => {
    const tb = countBy(state.employees.map(e => getCertSummary(e, type)), "status");
    document.getElementById(`${type}ValidMetric`).textContent   = tb.Valid || 0;
    document.getElementById(`${type}NinetyMetric`).textContent  = tb["Expiring in 90 Days"] || 0;
    document.getElementById(`${type}ThirtyMetric`).textContent  = tb["Expiring in 30 Days"] || 0;
    document.getElementById(`${type}ExpiredMetric`).textContent = tb.Expired || 0;
    document.getElementById(`${type}MissingMetric`).textContent = tb.Missing || 0;
  });
  setRows("attentionRows", urgent.slice(0,8).map(s => `<tr>
    <td>${escHtml(s.emp.name)}<br><small>${escHtml(s.emp.employeeId)}</small></td>
    <td>${escHtml(s.cert.label)}</td><td>${fmtDate(s.expiryDate)}</td><td>${badge(s.status)}</td>
    <td><button class="send-manager-btn" type="button" data-action="mail-alert" data-item='${escAttr(JSON.stringify(summaryToItem(s)))}'>✉ Send to Manager</button></td>
  </tr>`), 5, "No urgent renewals.");
  const grouped = sums.reduce((g,s) => {
    const d = s.emp.department || "Unassigned"; g[d] ||= {d,total:0,urgent:0,warn:0};
    g[d].total++; if(s.status==="Expired"||s.status==="Expiring in 30 Days")g[d].urgent++; if(s.status==="Expiring in 90 Days")g[d].warn++;
    return g;
  }, {});
  document.getElementById("departmentRiskList").innerHTML = Object.values(grouped).sort((a,b) => b.urgent-a.urgent).map(x =>
    `<div class="risk-item"><strong>${escHtml(x.d)}</strong><span>${x.urgent} urgent · ${x.warn} due soon · ${x.total} total</span></div>`
  ).join("") || '<div class="empty-state">No records yet.</div>';
}
function renderSectionRows(type) {
  const sfx  = SECTION_SUFFIX[type];
  const q    = document.getElementById(`employeeSearch${sfx}`).value.trim().toLowerCase();
  const dept = document.getElementById(`employeeDepartmentFilter${sfx}`).value;
  const stat = document.getElementById(`employeeStatusFilter${sfx}`).value;
  const emps = state.employees.filter(e => {
    const s = getCertSummary(e, type);
    return [e.name, e.employeeId, e.department].join(" ").toLowerCase().includes(q)
      && (dept === "all" || e.department === dept)
      && (stat === "all" || (stat === "Expiring" ? (s.status === "Expiring in 30 Days" || s.status === "Expiring in 90 Days") : s.status === stat));
  });
  setRows(`staffRows${sfx}`, emps.map(e => {
    const s = getCertSummary(e, type);
    const uploadBtn = isEditor && !s.record.file
      ? `<button class="upload-cert-btn" title="Upload ${CERTIFICATES[type].label} file" data-action="upload-cert" data-eid="${e.id}" data-type="${type}">＋</button>` : "";
    const editorActions = isEditor ? `
      <button class="text-btn" data-action="edit-emp" data-id="${e.id}" data-section="${type}">Edit</button>
      <button class="text-btn danger" data-action="del-emp" data-id="${e.id}">Remove</button>` : "";
    return `<tr>
      <td><strong>${escHtml(e.name)}</strong></td>
      <td>${escHtml(e.employeeId)}</td><td>${escHtml(e.department)}</td>
      <td>${isEditor ? `<button class="cert-status-btn" data-action="edit-cert" data-eid="${e.id}" data-type="${type}">${badge(s.status)}</button>` : badge(s.status)}</td>
      <td>${fmtDate(s.issueDate)}</td><td>${fmtDate(s.expiryDate)}</td>
      <td class="cert-file-cell">
        ${uploadBtn}${fileLink(s.record.file)}
        ${isEditor && (s.record.file || s.record.issueDate) ? `<button class="icon-btn danger" data-action="del-cert" data-eid="${e.id}" data-type="${type}">🗑</button>` : ""}
      </td>
      ${isEditor ? `<td class="row-actions editor-only">${editorActions}</td>` : ""}
    </tr>`;
  }), isEditor ? 8 : 7, "No employees match this filter.");
}
function renderAlertSettings() {
  alertSettingsForm.elements.reminderDays.value = String(state.settings.reminderDays);
  alertSettingsForm.elements.managerEmail.value = state.settings.managerEmail || "";
}
function renderAlertQueue() {
  const items = getAlertItems();
  document.getElementById("alertQueue").innerHTML = items.length
    ? items.map(s => `<div class="alert-item">
        <div><strong>${escHtml(s.emp.name)} · ${escHtml(s.cert.label)} ${escHtml(s.status.toLowerCase())}</strong>
        <span>${escHtml(s.emp.department)} · expires ${fmtDate(s.expiryDate)} · ${fmtDays(s.daysLeft)}</span></div>
        <div class="alert-actions"><button class="primary-btn send-manager-btn" data-action="mail-alert" data-item='${escAttr(JSON.stringify(summaryToItem(s)))}'>✉ Send to Manager</button></div>
      </div>`).join("")
    : '<div class="empty-state">No alerts due.</div>';
}

// ── Certificate logic ──────────────────────────────────────────────────────────
function getCertSummaries() { return state.employees.flatMap(e => CERT_TYPES.map(t => getCertSummary(e, t))); }
function getCertSummary(emp, type) {
  const cert = CERTIFICATES[type], record = emp.certificates[type] || {};
  const issueDate  = record.issueDate  || "";
  const expiryDate = record.expiryDate || (issueDate ? calcExpiry(issueDate, cert.validYears) : "");
  const daysLeft   = expiryDate ? daysUntil(expiryDate) : Infinity;
  return { emp, type, cert, record, issueDate, expiryDate, daysLeft, status: certStatus(expiryDate) };
}
function certStatus(exp) {
  if (!exp) return "Missing";
  const d = daysUntil(exp);
  if (d < 0) return "Expired"; if (d <= 30) return "Expiring in 30 Days"; if (d <= 90) return "Expiring in 90 Days";
  return "Valid";
}
function daysUntil(ds) {
  const t = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.ceil((t(new Date(`${ds}T00:00:00`)) - t(new Date())) / 86400000);
}
function calcExpiry(issue, years) {
  const d = new Date(`${issue}T00:00:00`); d.setFullYear(d.getFullYear() + years); return d.toISOString().slice(0, 10);
}
function summaryToItem(s) {
  return { employeeName: s.emp.name, employeeId: s.emp.employeeId, department: s.emp.department, certType: s.cert.label, status: s.status, expiryDate: s.expiryDate || null, daysLeft: isFinite(s.daysLeft) ? s.daysLeft : null };
}
function getAlertItems() {
  return getCertSummaries().filter(s => s.status !== "Missing" && (s.daysLeft < 0 || s.daysLeft <= state.settings.reminderDays)).sort((a,b) => a.daysLeft - b.daysLeft);
}

// ── CSV import ─────────────────────────────────────────────────────────────────
async function importFromCsv(text) {
  const rows = parseCsv(text).filter(r => r.some(c => c.trim()));
  if (rows.length < 2) return { added:0, updated:0, skipped:0 };
  const hdrs = rows[0].map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ""));
  rows.slice(1).forEach(r => { while (r.length < hdrs.length) r.push(""); });
  let added = 0, updated = 0, skipped = 0;
  for (const row of rows.slice(1)) {
    const rec = hdrs.reduce((o,h,i) => { o[h] = (row[i]||"").trim(); return o; }, {});
    if (!rec.employeeid || !rec.name || !rec.department) { skipped++; continue; }
    const existing = state.employees.find(e => e.employeeId.toLowerCase() === rec.employeeid.toLowerCase());
    const certs    = existing?.certificates || createEmptyCertificates();
    const bfsDate  = parseDate(rec.bfsissuedate || rec.bfsdate || rec.bfs || "");
    const ohcDate  = parseDate(rec.ohcissuedate || rec.ohcdate || rec.ohc || "");
    if (bfsDate) certs.bfs = { issueDate: bfsDate, expiryDate: calcExpiry(bfsDate, 2), file: certs.bfs?.file || null };
    if (ohcDate) certs.ohc = { issueDate: ohcDate, expiryDate: calcExpiry(ohcDate, 1), file: certs.ohc?.file || null };
    const emp = { id: existing?.id || crypto.randomUUID(), name: rec.name, employeeId: rec.employeeid, department: rec.department, certificates: certs, _certIds: existing?._certIds || {}, createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
    if (existing) { state.employees = state.employees.map(x => x.id === existing.id ? emp : x); updated++; }
    else { state.employees.unshift(emp); added++; }
    try {
      const dbId = await upsertEmployee(emp);
      if (bfsDate) await upsertCertificate(dbId, "bfs", certs.bfs, emp._certIds?.bfs);
      if (ohcDate) await upsertCertificate(dbId, "ohc", certs.ohc, emp._certIds?.ohc);
    } catch(e) { console.error("CSV upsert error:", e); }
  }
  setSyncState("idle");
  return { added, updated, skipped };
}
function downloadTemplate(type) {
  const cols = type === "bfs" ? ["employeeId","name","department","bfsIssueDate"] : ["employeeId","name","department","ohcIssueDate"];
  const ex   = type === "bfs" ? ["CK-1001","Sample Employee","Kitchen","2026-01-15"] : ["CK-1001","Sample Employee","Kitchen","2026-03-01"];
  downloadFile(`uae-kitchen-${type}-template-${today()}.csv`, [cols,ex].map(r => r.map(csvEsc).join(",")).join("\n"), "text/csv;charset=utf-8");
}

// ── PDF export ─────────────────────────────────────────────────────────────────
function exportPDF() {
  if (!window.jspdf?.jsPDF) { showToast("PDF library still loading — try again."); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit:"pt", format:"a4" });
  const pageW = doc.internal.pageSize.getWidth(), margin = 40; let y = 50;
  doc.setFont("helvetica","bold"); doc.setFontSize(20); doc.setTextColor(17,24,39); doc.text("CALO", margin, y);
  doc.setFontSize(11); doc.setFont("helvetica","normal"); doc.setTextColor(107,114,128); doc.text("UAE Kitchen Compliance Portal", margin, y+16);
  doc.setFontSize(14); doc.setFont("helvetica","bold"); doc.setTextColor(17,24,39); doc.text("Staff Certificate Compliance Report", margin, y+40);
  doc.setFontSize(9); doc.setFont("helvetica","normal"); doc.setTextColor(107,114,128); doc.text(`Generated: ${fmtDate(today())}`, margin, y+56); y += 80;
  const sums = getCertSummaries(), by = countBy(sums,"status"), uc = (by.Expired||0)+(by["Expiring in 30 Days"]||0);
  const bfsBy = countBy(state.employees.map(e=>getCertSummary(e,"bfs")),"status");
  const ohcBy = countBy(state.employees.map(e=>getCertSummary(e,"ohc")),"status");
  doc.setFontSize(11); doc.setFont("helvetica","bold"); doc.setTextColor(17,24,39); doc.text("EXECUTIVE SUMMARY", margin, y); y+=14;
  const tiles=[{label:"TOTAL EMPLOYEES",value:state.employees.length},{label:"BFS VALID",value:bfsBy.Valid||0},{label:"BFS EXPIRING 30D",value:bfsBy["Expiring in 30 Days"]||0},{label:"BFS EXPIRED",value:bfsBy.Expired||0},{label:"OHC VALID",value:ohcBy.Valid||0},{label:"OHC EXPIRING 30D",value:ohcBy["Expiring in 30 Days"]||0},{label:"OHC EXPIRED",value:ohcBy.Expired||0},{label:"ACTION NEEDED",value:uc}];
  const tcols=4,gap=10,tileH=52,tileW=(pageW-margin*2-gap*(tcols-1))/tcols;
  tiles.forEach((t,i)=>{const col=i%tcols,row=Math.floor(i/tcols),x=margin+col*(tileW+gap),ty=y+row*(tileH+gap);doc.setDrawColor(226,230,236);doc.setFillColor(248,250,252);doc.roundedRect(x,ty,tileW,tileH,4,4,"FD");doc.setFontSize(7);doc.setFont("helvetica","bold");doc.setTextColor(107,114,128);doc.text(t.label,x+10,ty+17,{maxWidth:tileW-20});doc.setFontSize(18);doc.setFont("helvetica","bold");doc.setTextColor(17,24,39);doc.text(String(t.value),x+10,ty+38);});
  y+=Math.ceil(tiles.length/tcols)*(tileH+gap)+18;
  doc.setFontSize(11);doc.setFont("helvetica","bold");doc.setTextColor(17,24,39);doc.text("BFS — Basic Food Safety",margin,y);
  doc.autoTable({startY:y+8,margin:{left:margin,right:margin},head:[["Name","ID","Department","Status","Issue Date","Expiry Date"]],body:state.employees.map(e=>{const s=getCertSummary(e,"bfs");return[e.name,e.employeeId,e.department,s.status,fmtDate(s.issueDate),fmtDate(s.expiryDate)];}),styles:{fontSize:8,cellPadding:5},headStyles:{fillColor:[22,163,74],textColor:255,fontStyle:"bold"},theme:"grid"});
  y=doc.lastAutoTable.finalY+26; if(y>680){doc.addPage();y=50;}
  doc.setFontSize(11);doc.setFont("helvetica","bold");doc.setTextColor(17,24,39);doc.text("OHC — Occupational Health Card",margin,y);
  doc.autoTable({startY:y+8,margin:{left:margin,right:margin},head:[["Name","ID","Department","Status","Issue Date","Expiry Date"]],body:state.employees.map(e=>{const s=getCertSummary(e,"ohc");return[e.name,e.employeeId,e.department,s.status,fmtDate(s.issueDate),fmtDate(s.expiryDate)];}),styles:{fontSize:8,cellPadding:5},headStyles:{fillColor:[109,40,217],textColor:255,fontStyle:"bold"},theme:"grid"});
  const pc=doc.internal.getNumberOfPages();
  for(let p=1;p<=pc;p++){doc.setPage(p);doc.setFontSize(8);doc.setTextColor(156,163,175);doc.text("UAE Kitchen Compliance Portal · Confidential",pageW/2,doc.internal.pageSize.getHeight()-20,{align:"center"});}
  doc.save(`uae-kitchen-compliance-${today()}.pdf`); showToast("PDF report ready.");
}

// ── Utilities ──────────────────────────────────────────────────────────────────
function createEmptyCertificates() { return { bfs:{}, ohc:{} }; }
function formData(form) { return Object.fromEntries(new FormData(form).entries()); }
function setRows(id, rows, cols, empty) { document.getElementById(id).innerHTML = rows.length ? rows.join("") : `<tr><td colspan="${cols}" class="empty-state">${empty}</td></tr>`; }
function countBy(arr, key) { return arr.reduce((c,i) => { c[i[key]] = (c[i[key]]||0)+1; return c; }, {}); }
function badge(status) {
  const cls = status==="Valid"?"good":status==="Expiring in 90 Days"?"watch":status==="Expiring in 30 Days"?"warn":status==="Missing"?"neutral":"bad";
  return `<span class="badge ${cls}">${escHtml(status)}</span>`;
}
function fmtDate(v) { if(!v)return"—"; return new Intl.DateTimeFormat("en-US",{year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(`${v}T00:00:00`)); }
function fmtDays(d) { if(!isFinite(d))return"not recorded"; if(d<0)return`${Math.abs(d)} days overdue`; if(d===0)return"expires today"; return`${d} days remaining`; }
function fileLink(f) { if(!f?.dataUrl)return'<span class="muted">—</span>'; return`<a class="table-link" href="${f.dataUrl}" download="${escHtml(f.name)}">${escHtml(f.name)}</a>`; }
function escHtml(v) { return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;"); }
function escAttr(v) { return String(v??"").replace(/'/g,"&#039;").replace(/"/g,"&quot;"); }
async function readCertFile(file) {
  if(!file)return null;
  if(file.type!=="application/pdf"&&!file.type.startsWith("image/")){showToast("Upload a PDF or image.");throw new Error("bad type");}
  return{name:file.name,type:file.type,size:file.size,dataUrl:await toDataUrl(file),uploadedAt:new Date().toISOString()};
}
function toDataUrl(file) { return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=()=>rej(r.error);r.readAsDataURL(file);}); }
function downloadFile(name,content,type){const a=Object.assign(document.createElement("a"),{href:URL.createObjectURL(new Blob([content],{type})),download:name});a.click();URL.revokeObjectURL(a.href);}
function parseCsv(text){const rows=[];let row=[],cell="",inQ=false;for(let i=0;i<text.length;i++){const c=text[i],n=text[i+1];if(c==='"'&&inQ&&n==='"'){cell+='"';i++;}else if(c==='"'){inQ=!inQ;}else if(c===","&&!inQ){row.push(cell);cell="";}else if((c==="\n"||c==="\r")&&!inQ){if(c==="\r"&&n==="\n")i++;row.push(cell);rows.push(row);row=[];cell="";}else{cell+=c;}}row.push(cell);rows.push(row);return rows;}
function csvEsc(v){const s=String(v??"");return/[,"\n\r]/.test(s)?`"${s.replaceAll('"','""')}"`  :s;}
function parseDate(v){if(!v||!String(v).trim())return null;const s=String(v).trim();if(/^\d{4}-\d{2}-\d{2}$/.test(s)){const d=new Date(`${s}T00:00:00`);return isNaN(d)?null:s;}const ey=yy=>{const n=parseInt(yy,10);return String(n<=29?2000+n:1900+n);};const nm=s.match(/^(\d{1,2})[\s\-\/]([A-Za-z]{3,9})[\s\-\/,]*(\d{2,4})$/);if(nm){const[,dd,mon,ry]=nm;const yyyy=ry.length===2?ey(ry):ry;const d=new Date(`${dd} ${mon} ${yyyy}`);if(!isNaN(d))return d.toISOString().slice(0,10);}const dmy=s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);if(dmy){const[,dd,mm,ry]=dmy;const yyyy=ry.length===2?ey(ry):ry;const iso=`${yyyy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}`;const d=new Date(`${iso}T00:00:00`);if(!isNaN(d))return iso;}const d=new Date(s);if(!isNaN(d))return d.toISOString().slice(0,10);return null;}
function today(){return new Date().toISOString().slice(0,10);}
function showToast(msg){toast.textContent=msg;toast.classList.add("visible");clearTimeout(showToast._t);showToast._t=setTimeout(()=>toast.classList.remove("visible"),2600);}

// ── Boot ───────────────────────────────────────────────────────────────────────
CERT_TYPES.forEach(initSection);
// Check for existing Supabase session (auto-login if already signed in)
sb.auth.getSession().then(({ data: { session: s } }) => { if (s?.user) onSignIn(s.user); else render(); });
sb.auth.onAuthStateChange((_event, s) => { if (!s) { session=null; isEditor=false; state={employees:[],settings:{...defaultSettings}}; render(); } });
