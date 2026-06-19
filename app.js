// Supabase project settings. The anon key is intended for browser clients.
const SUPABASE_URL = "https://iflquskysqchhbywvmow.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlmbHF1c2t5c3FjaGhieXd2bW93Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4NjM3ODIsImV4cCI6MjA5NzQzOTc4Mn0.FFcd80AqZ8hpyi-Bs_rPnCNZNp075YqBYM1yAYeyGUw";

const CERTIFICATES = {
  bfs: { label: "BFS", fullName: "Basic Food Safety", validYears: 2 },
  ohc: { label: "OHC", fullName: "Occupational Health Card", validYears: 1 },
};
const CERT_TYPES = Object.keys(CERTIFICATES);
const SECTION_SUFFIX = { bfs: "Bfs", ohc: "Ohc" };
const DEFAULT_SETTINGS = { reminderDays: 30, managerEmail: "" };

let supabaseClient = null;
let session = null;
let state = { employees: [], settings: { ...DEFAULT_SETTINGS } };
let bulkFileRows = { bfs: [], ohc: [] };

const loginView = document.getElementById("loginView");
const appShell = document.getElementById("appShell");
const toast = document.getElementById("toast");
const views = document.querySelectorAll(".view");
const tabs = document.querySelectorAll(".nav-tab");
const syncStatus = document.getElementById("syncStatus");
const syncLabel = document.getElementById("syncLabel");
const alertSettingsForm = document.getElementById("alertSettingsForm");
const certUploadModal = document.getElementById("certUploadModal");
const certUploadModalForm = document.getElementById("certUploadModalForm");

boot();

async function boot() {
  if (!window.supabase) {
    showLoginError("Supabase library did not load. Check your internet connection.");
    return;
  }

  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  wireAuth();
  wireNavigation();
  wireGlobalActions();
  CERT_TYPES.forEach(initSection);

  const { data, error } = await supabaseClient.auth.getSession();
  if (error) {
    showLoginError(error.message);
    render();
    return;
  }

  session = data.session;
  if (session) {
    await loadFromSupabase();
  }
  render();

  supabaseClient.auth.onAuthStateChange(async (_event, nextSession) => {
    session = nextSession;
    if (session) {
      await loadFromSupabase();
    } else {
      state = { employees: [], settings: { ...DEFAULT_SETTINGS } };
    }
    render();
  });
}

function wireAuth() {
  document.getElementById("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = formData(form);
    setLoginLoading(true);
    showLoginError("");
    const { error } = await supabaseClient.auth.signInWithPassword({
      email: data.email.trim().toLowerCase(),
      password: data.password,
    });
    setLoginLoading(false);
    if (error) {
      showLoginError(error.message);
      return;
    }
    form.reset();
    showToast("Signed in.");
  });

  document.getElementById("signOutButton").addEventListener("click", async () => {
    await supabaseClient.auth.signOut();
    showToast("Signed out.");
  });
}

function wireNavigation() {
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => showView(tab.dataset.view));
  });
}

function wireGlobalActions() {
  document.getElementById("refreshButton").addEventListener("click", async () => {
    await loadFromSupabase();
    renderAll();
    showToast("Data refreshed.");
  });
  document.getElementById("exportPdf").addEventListener("click", exportPDF);
  document.getElementById("exportPdfTop").addEventListener("click", exportPDF);
  document.getElementById("prepareAllAlerts").addEventListener("click", sendAllAlerts);

  alertSettingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = formData(event.currentTarget);
    await saveSettings({
      reminderDays: Number(data.reminderDays),
      managerEmail: data.managerEmail.trim().toLowerCase(),
    });
    renderAll();
    sendAllAlerts();
  });

  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    if (action === "edit-emp") editEmployee(button.dataset.id, button.dataset.section);
    if (action === "del-emp") await removeEmployee(button.dataset.id);
    if (action === "edit-cert") editCertificate(button.dataset.eid, button.dataset.type);
    if (action === "del-cert") await removeCertificate(button.dataset.eid, button.dataset.type);
    if (action === "upload-cert") openCertModal(button.dataset.eid, button.dataset.type);
    if (action === "mail-alert") sendSingleAlert(button.dataset.eid, button.dataset.type);
  });

  document.getElementById("certUploadModalClose").addEventListener("click", closeCertModal);
  document.getElementById("certUploadModalCancel").addEventListener("click", closeCertModal);
  certUploadModal.addEventListener("click", (event) => {
    if (event.target === certUploadModal) closeCertModal();
  });

  certUploadModalForm.elements.issueDate.addEventListener("change", () => {
    const issueDate = certUploadModalForm.elements.issueDate.value;
    const type = certUploadModalForm.elements.type.value;
    if (issueDate && type) {
      certUploadModalForm.elements.expiryDate.value = calcExpiry(issueDate, CERTIFICATES[type].validYears);
    }
  });

  certUploadModalForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = formData(event.currentTarget);
    const file = event.currentTarget.elements.file.files[0];
    await saveCertificate(data.employeeId, data.type, data.issueDate, data.expiryDate, file);
    closeCertModal();
    await loadFromSupabase();
    renderAll();
    showToast("Certificate saved.");
  });
}

function initSection(type) {
  const suffix = SECTION_SUFFIX[type];
  const employeeForm = document.getElementById(`employeeForm${suffix}`);
  const showBulkCertBtn = document.getElementById(`showBulkCert${suffix}`);
  const showBulkEmpBtn = document.getElementById(`showBulkUpload${suffix}`);
  const bulkCertSection = document.getElementById(`bulkCertSection${suffix}`);
  const bulkEmpSection = document.getElementById(`bulkEmpSection${suffix}`);
  const bulkUploadForm = document.getElementById(`bulkUploadForm${suffix}`);
  const downloadTemplateBtn = document.getElementById(`downloadEmployeeTemplate${suffix}`);
  const cancelEditBtn = document.getElementById(`cancelEmployeeEdit${suffix}`);
  const certificateForm = document.getElementById(`certificateForm${suffix}`);
  const cancelCertEditBtn = document.getElementById(`cancelCertEdit${suffix}`);
  const bulkCertInput = document.getElementById(`bulkCertInput${suffix}`);
  const bulkCertPreview = document.getElementById(`bulkCertPreview${suffix}`);
  const bulkCertActions = document.getElementById(`bulkCertActions${suffix}`);
  const bulkCertConfirm = document.getElementById(`bulkCertConfirm${suffix}`);
  const bulkCertClear = document.getElementById(`bulkCertClear${suffix}`);
  const search = document.getElementById(`employeeSearch${suffix}`);
  const deptFilter = document.getElementById(`employeeDepartmentFilter${suffix}`);
  const statusFilter = document.getElementById(`employeeStatusFilter${suffix}`);

  employeeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = formData(event.currentTarget);
    const issueDate = parseDate(data[`${type}IssueDate`]);
    const employee = await saveEmployee({
      id: data.editingId || null,
      name: data.name.trim(),
      employeeId: data.employeeId.trim(),
      department: data.department.trim(),
    });
    if (issueDate) {
      await saveCertificate(employee.id, type, issueDate, calcExpiry(issueDate, CERTIFICATES[type].validYears), null);
    }
    resetEmployeeForm(type);
    await loadFromSupabase();
    renderAll();
    showToast(data.editingId ? "Employee updated." : "Employee added.");
  });

  cancelEditBtn.addEventListener("click", () => resetEmployeeForm(type));
