const STORAGE_KEY = "country-kitchen-compliance-v1";
const SESSION_KEY = "country-kitchen-compliance-session";
const AUTHORIZED_EMAILS = ["m.illikkal@calo.app"];
const CERTIFICATES = {
  bfs: {
    label: "BFS",
    fullName: "Basic Food Safety",
    validYears: 2,
  },
  ohc: {
    label: "OHC",
    fullName: "Occupational Health Card",
    validYears: 1,
  },
};

const defaultSettings = {
  alertsEmail: "compliance.manager@calo.app",
  reminderDays: 30,
};

let state = loadState();
let session = loadSession();

const loginView = document.getElementById("loginView");
const appShell = document.getElementById("appShell");
const toast = document.getElementById("toast");
const views = document.querySelectorAll(".view");
const tabs = document.querySelectorAll(".nav-tab");
const employeeForm = document.getElementById("employeeForm");
const certificateForm = document.getElementById("certificateForm");
const alertSettingsForm = document.getElementById("alertSettingsForm");
const bulkUploadForm = document.getElementById("bulkUploadForm");
const employeeSearch = document.getElementById("employeeSearch");
const employeeDepartmentFilter = document.getElementById("employeeDepartmentFilter");
const employeeStatusFilter = document.getElementById("employeeStatusFilter");
const statusFilter = document.getElementById("statusFilter");

document.getElementById("loginForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = formData(event.currentTarget);
  const email = data.email.trim().toLowerCase();
  if (!AUTHORIZED_EMAILS.includes(email)) {
    showToast("Use an authorized compliance team email.");
    return;
  }
  session = { email, signedInAt: new Date().toISOString() };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  event.currentTarget.reset();
  render();
  showToast("Signed in with Google account.");
});

document.getElementById("signOutButton").addEventListener("click", () => {
  session = null;
  localStorage.removeItem(SESSION_KEY);
  render();
});

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const nextView = tab.dataset.view;
    tabs.forEach((item) => item.classList.toggle("active", item === tab));
    views.forEach((view) => view.classList.toggle("active-view", view.id === nextView));
  });
});

employeeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = formData(event.currentTarget);
  const existing = state.employees.find((employee) => employee.id === data.editingId);
  const duplicateId = state.employees.find(
    (employee) => employee.employeeId.toLowerCase() === data.employeeId.trim().toLowerCase() && employee.id !== data.editingId,
  );

  if (duplicateId) {
    showToast("That employee ID is already in use.");
    event.currentTarget.elements.employeeId.focus();
    return;
  }

  const employee = {
    id: existing?.id || crypto.randomUUID(),
    name: data.name.trim(),
    employeeId: data.employeeId.trim(),
    department: data.department.trim(),
    position: data.position.trim(),
    email: data.email.trim().toLowerCase(),
    phone: data.phone.trim(),
    certificates: existing?.certificates || createEmptyCertificates(),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (existing) {
    state.employees = state.employees.map((item) => (item.id === existing.id ? employee : item));
  } else {
    state.employees.unshift(employee);
  }

  persist();
  resetEmployeeForm();
  render();
  showToast(existing ? "Employee updated." : "Employee added.");
});

document.getElementById("cancelEmployeeEdit").addEventListener("click", resetEmployeeForm);

certificateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = formData(event.currentTarget);
  const employee = state.employees.find((item) => item.id === data.employeeId);
  if (!employee) {
    showToast("Add an employee before saving a certificate.");
    return;
  }

  const type = data.type;
  const file = event.currentTarget.elements.file.files[0];
  const previous = employee.certificates[type] || {};
  const uploadedFile = file ? await readCertificateFile(file) : previous.file || null;

  employee.certificates[type] = {
    issueDate: data.issueDate,
    expiryDate: data.expiryDate || calculateExpiryDate(data.issueDate, CERTIFICATES[type].validYears),
    file: uploadedFile,
    updatedAt: new Date().toISOString(),
  };
  employee.updatedAt = new Date().toISOString();

  persist();
  event.currentTarget.reset();
  render();
  showToast(`${CERTIFICATES[type].label} certificate saved for ${employee.name}.`);
});

alertSettingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = formData(event.currentTarget);
  state.settings = {
    alertsEmail: data.alertsEmail.trim().toLowerCase(),
    reminderDays: Number(data.reminderDays),
  };
  persist();
  render();
  sendEmailAlert();
});

bulkUploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = event.currentTarget.elements.csvFile.files[0];
  if (!file) return;
  const text = await file.text();
  const result = importEmployeesFromCsv(text);
  persist();
  event.currentTarget.reset();
  render();
  showToast(`CSV upload complete: ${result.added} added, ${result.updated} updated, ${result.skipped} skipped.`);
});

employeeSearch.addEventListener("input", renderEmployeeRows);
employeeDepartmentFilter.addEventListener("change", renderEmployeeRows);
employeeStatusFilter.addEventListener("change", renderEmployeeRows);
statusFilter.addEventListener("change", renderCertificateRows);
document.getElementById("seedDemo").addEventListener("click", seedDemoData);
document.getElementById("exportExcel").addEventListener("click", exportExcel);
document.getElementById("exportExcelTop").addEventListener("click", exportExcel);
document.getElementById("prepareAllAlerts").addEventListener("click", sendEmailAlert);
document.getElementById("downloadEmployeeTemplate").addEventListener("click", downloadEmployeeTemplate);

// ── Bulk Certificate File Upload ──────────────────────────────────────────────

function normalise(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function matchFileToEmployee(fileName) {
  // Strip extension
  const base = normalise(fileName.replace(/\.[^.]+$/, ""));
  // Try exact match first, then partial
  const exact = state.employees.find((e) => normalise(e.name) === base);
  if (exact) return { employee: exact, confidence: "exact" };
  const partial = state.employees.find(
    (e) => base.includes(normalise(e.name)) || normalise(e.name).includes(base)
  );
  if (partial) return { employee: partial, confidence: "partial" };
  return null;
}

function buildBulkPreview(files, type) {
  const rows = Array.from(files).map((file) => {
    const match = matchFileToEmployee(file.name);
    return { file, match };
  });
  return rows;
}

function renderBulkPreview(rows, previewEl) {
  if (!rows.length) { previewEl.classList.add("hidden"); return; }
  const matched = rows.filter((r) => r.match);
  const unmatched = rows.filter((r) => !r.match);
  let html = `<p class="bulk-summary">${matched.length} of ${rows.length} file(s) matched to employees.</p>`;
  html += `<div class="table-wrap"><table><thead><tr><th>File</th><th>Matched Employee</th><th>Confidence</th></tr></thead><tbody>`;
  for (const row of rows) {
    const matchCell = row.match
      ? `<span class="status-valid">${escapeHtml(row.match.employee.name)}</span>`
      : `<span class="status-expired">No match</span>`;
    const confCell = row.match
      ? `<span class="conf-${row.match.confidence}">${row.match.confidence}</span>`
      : "—";
    html += `<tr><td>${escapeHtml(row.file.name)}</td><td>${matchCell}</td><td>${confCell}</td></tr>`;
  }
  html += `</tbody></table></div>`;
  previewEl.innerHTML = html;
  previewEl.classList.remove("hidden");
}

async function applyBulkCertFiles(rows, type) {
  let count = 0;
  for (const row of rows) {
    if (!row.match) continue;
    const employee = state.employees.find((e) => e.id === row.match.employee.id);
    if (!employee) continue;
    const uploadedFile = await readCertificateFile(row.file);
    if (!employee.certificates[type]) employee.certificates[type] = {};
    employee.certificates[type].file = uploadedFile;
    employee.certificates[type].updatedAt = new Date().toISOString();
    employee.updatedAt = new Date().toISOString();
    count++;
  }
  return count;
}

(function initBulkCertUploads() {
  ["bfs", "ohc"].forEach((type) => {
    const inputEl = document.getElementById(`${type}BulkInput`);
    const previewEl = document.getElementById(`${type}BulkPreview`);
    const actionsEl = document.getElementById(`${type}BulkActions`);
    const confirmBtn = document.getElementById(`${type}BulkConfirm`);
    const clearBtn = document.getElementById(`${type}BulkClear`);
    let currentRows = [];

    inputEl.addEventListener("change", () => {
      const files = inputEl.files;
      if (!files || !files.length) {
        previewEl.classList.add("hidden");
        actionsEl.classList.add("hidden");
        return;
      }
      currentRows = buildBulkPreview(files, type);
      renderBulkPreview(currentRows, previewEl);
      actionsEl.classList.remove("hidden");
    });

    confirmBtn.addEventListener("click", async () => {
      if (!currentRows.length) return;
      const count = await applyBulkCertFiles(currentRows, type);
      persist();
      render();
      showToast(`${count} ${CERTIFICATES[type].label} file(s) attached to employees.`);
      inputEl.value = "";
      previewEl.classList.add("hidden");
      actionsEl.classList.add("hidden");
      currentRows = [];
    });

    clearBtn.addEventListener("click", () => {
      inputEl.value = "";
      previewEl.classList.add("hidden");
      actionsEl.classList.add("hidden");
      currentRows = [];
    });
  });
})();

// ─────────────────────────────────────────────────────────────────────────────

certificateForm.elements.issueDate.addEventListener("change", (event) => {
  const issueDate = event.target.value;
  const type = certificateForm.elements.type.value;
  if (issueDate && type) {
    certificateForm.elements.expiryDate.value = calculateExpiryDate(issueDate, CERTIFICATES[type].validYears);
  }
});
certificateForm.elements.type.addEventListener("change", (event) => {
  const issueDate = certificateForm.elements.issueDate.value;
  const type = event.target.value;
  if (issueDate && type) {
    certificateForm.elements.expiryDate.value = calculateExpiryDate(issueDate, CERTIFICATES[type].validYears);
  }
});

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) {
    return {
      employees: [],
      settings: { ...defaultSettings },
    };
  }

  try {
    const parsed = JSON.parse(saved);
    return {
      employees: (parsed.employees || []).map(normalizeEmployee),
      settings: normalizeSettings(parsed.settings || {}),
    };
  } catch {
    return {
      employees: [],
      settings: { ...defaultSettings },
    };
  }
}

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}

function normalizeEmployee(employee) {
  return {
    ...employee,
    certificates: {
      ...createEmptyCertificates(),
      ...(employee.certificates || {}),
    },
  };
}

function normalizeSettings(settings = {}) {
  return {
    ...defaultSettings,
    ...settings,
    alertsEmail: settings.alertsEmail || settings.kitchenManagerEmail || defaultSettings.alertsEmail,
    reminderDays: Number(settings.reminderDays || settings.finalReminder || defaultSettings.reminderDays),
  };
}

function createEmptyCertificates() {
  return {
    bfs: {},
    ohc: {},
  };
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function render() {
  const isSignedIn = Boolean(session?.email);
  loginView.classList.toggle("hidden", isSignedIn);
  appShell.classList.toggle("hidden", !isSignedIn);
  document.getElementById("signedInEmail").textContent = session?.email || "Not signed in";

  if (!isSignedIn) return;

  renderCertificateEmployeeOptions();
  renderEmployeeFilterOptions();
  renderDashboard();
  renderEmployeeRows();
  renderCertificateRows();
  renderAlertSettings();
  renderAlertQueue();
  renderReportSummary();
  renderReportRows();
}

function renderCertificateEmployeeOptions() {
  const select = certificateForm.elements.employeeId;
  select.innerHTML = state.employees.length
    ? state.employees
        .map((employee) => `<option value="${employee.id}">${escapeHtml(employee.name)} (${escapeHtml(employee.employeeId)})</option>`)
        .join("")
    : '<option value="">Add employees first</option>';
}

function renderEmployeeFilterOptions() {
  const currentDepartment = employeeDepartmentFilter.value || "all";
  const departments = [...new Set(state.employees.map((employee) => employee.department).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  employeeDepartmentFilter.innerHTML = [
    '<option value="all">All departments</option>',
    ...departments.map((department) => `<option value="${escapeHtml(department)}">${escapeHtml(department)}</option>`),
  ].join("");
  employeeDepartmentFilter.value = departments.includes(currentDepartment) ? currentDepartment : "all";
}

function renderDashboard() {
  const summaries = getCertificateSummaries();
  const statusCounts = countBy(summaries, "status");
  const urgentItems = summaries
    .filter((item) => item.status === "Expired" || item.status === "Expiring in 30 Days")
    .sort((a, b) => a.daysRemaining - b.daysRemaining);

  const urgentCount = (statusCounts.Expired || 0) + (statusCounts["Expiring in 30 Days"] || 0);
  document.getElementById("employeeMetric").textContent = state.employees.length;
  document.getElementById("validMetric").textContent = statusCounts.Valid || 0;
  document.getElementById("ninetyMetric").textContent = statusCounts["Expiring in 90 Days"] || 0;
  document.getElementById("urgentMetric").textContent = urgentCount;
  document.getElementById("attentionCount").textContent = `${urgentItems.length} items`;

  const overallStatus = document.getElementById("overallStatus");
  overallStatus.textContent = urgentCount ? "Action Needed" : "Compliant";
  overallStatus.classList.toggle("risk", Boolean(urgentCount));

  const rows = urgentItems.slice(0, 8).map((item) => `<tr>
    <td>${escapeHtml(item.employee.name)}<br><small>${escapeHtml(item.employee.employeeId)}</small></td>
    <td>${escapeHtml(item.certificate.label)}</td>
    <td>${formatDateOnly(item.expiryDate)}</td>
    <td>${statusBadge(item.status)}</td>
    <td><a class="table-link" href="${createMailto(item)}">Email ${escapeHtml(getAlertRoute(item.employee).label)}</a></td>
  </tr>`);
  setRows("attentionRows", rows, 5, "No expired or 30-day certificate renewals.");

  renderDepartmentRisk(summaries);
}

function renderDepartmentRisk(summaries) {
  const grouped = summaries.reduce((groups, item) => {
    const department = item.employee.department || "Unassigned";
    groups[department] ||= { department, total: 0, urgent: 0, warning: 0 };
    groups[department].total += 1;
    if (item.status === "Expired" || item.status === "Expiring in 30 Days") groups[department].urgent += 1;
    if (item.status === "Expiring in 90 Days") groups[department].warning += 1;
    return groups;
  }, {});

  const items = Object.values(grouped).sort((a, b) => b.urgent - a.urgent || b.warning - a.warning || a.department.localeCompare(b.department));
  document.getElementById("departmentRiskList").innerHTML = items.length
    ? items
        .map(
          (item) => `<div class="risk-item">
            <strong>${escapeHtml(item.department)}</strong>
            <span>${item.urgent} urgent, ${item.warning} due soon, ${item.total} total certificates</span>
          </div>`,
        )
        .join("")
    : '<div class="empty-state">No employee records yet.</div>';
}

function renderEmployeeRows() {
  const query = employeeSearch.value.trim().toLowerCase();
  const department = employeeDepartmentFilter.value;
  const status = employeeStatusFilter.value;
  const employees = state.employees.filter((employee) => {
    const searchable = [employee.name, employee.employeeId, employee.department, employee.position, employee.email, employee.phone].join(" ").toLowerCase();
    const summaries = Object.keys(CERTIFICATES).map((type) => getCertificateSummary(employee, type));
    const matchesQuery = searchable.includes(query);
    const matchesDepartment = department === "all" || employee.department === department;
    const matchesStatus =
      status === "all" ||
      summaries.some((item) => {
        if (status === "Expiring") return item.status === "Expiring in 30 Days" || item.status === "Expiring in 90 Days";
        return item.status === status;
      });
    return matchesQuery && matchesDepartment && matchesStatus;
  });

  const rows = employees.map((employee) => {
    const bfs = getCertificateSummary(employee, "bfs");
    const ohc = getCertificateSummary(employee, "ohc");
    return `<tr>
      <td><strong>${escapeHtml(employee.name)}</strong></td>
      <td>${escapeHtml(employee.employeeId)}</td>
      <td>${escapeHtml(employee.department)}</td>
      <td>${escapeHtml(employee.position)}</td>
      <td>${escapeHtml(employee.email)}<br><small>${escapeHtml(employee.phone)}</small></td>
      <td>${compactCertificateStatus("BFS", bfs.status)} ${compactCertificateStatus("OHC", ohc.status)}</td>
      <td class="row-actions">
        <button class="text-btn" type="button" data-action="edit-employee" data-id="${employee.id}">Edit</button>
        <button class="text-btn danger" type="button" data-action="remove-employee" data-id="${employee.id}">Remove</button>
      </td>
    </tr>`;
  });

  setRows("employeeRows", rows, 7, "No employees match the current search.");
  wireRowActions();
}

function renderCertificateRows() {
  const filter = statusFilter.value;
  const summaries = getCertificateSummaries().filter((item) => filter === "all" || item.status === filter);
  const rows = summaries.map((item) => `<tr>
    <td>${escapeHtml(item.employee.name)}<br><small>${escapeHtml(item.employee.employeeId)}</small></td>
    <td>${escapeHtml(item.employee.department)}</td>
    <td>${escapeHtml(item.certificate.label)}<br><small>${escapeHtml(item.certificate.fullName)}</small></td>
    <td>${formatDateOnly(item.issueDate)}</td>
    <td>${formatDateOnly(item.expiryDate)}</td>
    <td>${statusBadge(item.status)}</td>
    <td>${renderFileLink(item.record.file)}</td>
    <td class="row-actions">
      <button class="text-btn" type="button" data-action="edit-certificate" data-employee-id="${item.employee.id}" data-type="${item.type}">Edit</button>
      <button class="text-btn danger" type="button" data-action="remove-certificate" data-employee-id="${item.employee.id}" data-type="${item.type}">Clear</button>
    </td>
  </tr>`);

  setRows("certificateRows", rows, 8, "No certificates found for this filter.");
  wireRowActions();
}

function renderAlertSettings() {
  alertSettingsForm.elements.alertsEmail.value = state.settings.alertsEmail;
  alertSettingsForm.elements.reminderDays.value = String(state.settings.reminderDays);
}

function renderAlertQueue() {
  const items = getAlertItems();
  document.getElementById("alertQueue").innerHTML = items.length
    ? items
        .map(
          (item) => `<div class="alert-item">
            <div>
              <strong>${escapeHtml(item.employee.name)} - ${escapeHtml(item.certificate.label)} ${escapeHtml(item.status.toLowerCase())}</strong>
              <span>${escapeHtml(item.employee.department)} / expires ${formatDateOnly(item.expiryDate)} / ${formatDays(item.daysRemaining)} / routes to ${escapeHtml(getAlertRoute(item.employee).label)}</span>
            </div>
            <div class="alert-actions">
              <a class="primary-btn" href="${createMailto(item)}">Prepare Alert</a>
            </div>
          </div>`,
        )
        .join("")
    : '<div class="empty-state">No alert emails are due.</div>';
}

function renderReportSummary() {
  const summaries = getCertificateSummaries();
  const total = summaries.length;
  const valid = summaries.filter((item) => item.status === "Valid").length;
  const needsAction = summaries.filter((item) => item.status === "Expired" || item.status === "Missing" || item.status === "Expiring in 30 Days").length;
  const complianceRate = total ? Math.round((valid / total) * 100) : 0;
  const painPoint = getPainPoint(summaries);
  const weakestDepartment = getWeakestDepartment(summaries);

  document.getElementById("complianceRateMetric").textContent = `${complianceRate}%`;
  document.getElementById("complianceRateDetail").textContent = `${valid} of ${total} certificates valid`;
  document.getElementById("needsActionMetric").textContent = needsAction;
  document.getElementById("painPointMetric").textContent = painPoint.title;
  document.getElementById("painPointDetail").textContent = painPoint.detail;
  document.getElementById("weakestDepartmentMetric").textContent = weakestDepartment.title;
  document.getElementById("weakestDepartmentDetail").textContent = weakestDepartment.detail;
}

function renderReportRows() {
  document.getElementById("reportCount").textContent = `${state.employees.length} rows`;
  const rows = state.employees.map((employee) => {
    const bfs = getCertificateSummary(employee, "bfs");
    const ohc = getCertificateSummary(employee, "ohc");
    return `<tr>
      <td>${escapeHtml(employee.employeeId)}</td>
      <td>${escapeHtml(employee.name)}</td>
      <td>${escapeHtml(employee.department)}</td>
      <td>${statusBadge(bfs.status)}</td>
      <td>${formatDateOnly(bfs.expiryDate)}</td>
      <td>${statusBadge(ohc.status)}</td>
      <td>${formatDateOnly(ohc.expiryDate)}</td>
    </tr>`;
  });
  setRows("reportRows", rows, 7, "No employee records to export.");
}

function getCertificateSummaries() {
  return state.employees.flatMap((employee) => Object.keys(CERTIFICATES).map((type) => getCertificateSummary(employee, type)));
}

function getCertificateSummary(employee, type) {
  const certificate = CERTIFICATES[type];
  const record = employee.certificates[type] || {};
  const issueDate = record.issueDate || "";
  const expiryDate = record.expiryDate || (issueDate ? calculateExpiryDate(issueDate, certificate.validYears) : "");
  const daysRemaining = expiryDate ? daysUntil(expiryDate) : Number.POSITIVE_INFINITY;
  const status = getCertificateStatus(expiryDate);

  return {
    employee,
    type,
    certificate,
    record,
    issueDate,
    expiryDate,
    daysRemaining,
    status,
  };
}

function getCertificateStatus(expiryDate) {
  if (!expiryDate) return "Missing";
  const days = daysUntil(expiryDate);
  if (days < 0) return "Expired";
  if (days <= 30) return "Expiring in 30 Days";
  if (days <= 90) return "Expiring in 90 Days";
  return "Valid";
}

function daysUntil(dateString) {
  const today = startOfDay(new Date());
  const target = startOfDay(new Date(`${dateString}T00:00:00`));
  return Math.ceil((target - today) / 86400000);
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function calculateExpiryDate(issueDate, years) {
  const date = new Date(`${issueDate}T00:00:00`);
  date.setFullYear(date.getFullYear() + years);
  return date.toISOString().slice(0, 10);
}

function getAlertItems() {
  const reminderDays = Number(state.settings.reminderDays);
  return getCertificateSummaries()
    .filter((item) => item.status !== "Missing")
    .filter((item) => item.daysRemaining < 0 || item.daysRemaining <= reminderDays)
    .sort((a, b) => a.daysRemaining - b.daysRemaining);
}

function sendEmailAlert() {
  const items = getAlertItems();
  const email = state.settings.alertsEmail;
  if (!items.length) {
    showToast("No certificate alerts are due for the selected reminder.");
    return;
  }
  const subject = encodeURIComponent(`UAE Kitchen certificate alerts - ${items.length} items`);
  const body = encodeURIComponent(
    [
      "Hello Compliance Team,",
      "",
      `The following ${items.length} certificate renewal(s) need attention (due within ${state.settings.reminderDays} days or overdue):`,
      "",
      items
        .map(
          (item) =>
            `- ${item.employee.name} (${item.employee.employeeId}) - ${item.certificate.label}: ${item.status} (Expires: ${formatDateOnly(item.expiryDate)}, ${formatDays(item.daysRemaining)})`
        )
        .join("\n"),
      "",
      "Please arrange renewals and update the portal once the new certificate is issued.",
      "",
      "UAE Kitchen - Compliance Portal",
    ].join("\n")
  );
  window.location.href = `mailto:${encodeURIComponent(email)}?subject=${subject}&body=${body}`;
  showToast("Opening mail client...");
}

function createMailto(item) {
  const email = state.settings.alertsEmail;
  const subject = encodeURIComponent(`${item.certificate.label} certificate ${item.status.toLowerCase()} - ${item.employee.name}`);
  const body = encodeURIComponent(
    [
      "Hello,",
      "",
      `${item.employee.name}'s ${item.certificate.fullName} (${item.certificate.label}) certificate is ${item.status.toLowerCase()}.`,
      `Employee ID: ${item.employee.employeeId}`,
      `Department: ${item.employee.department}`,
      `Expiry date: ${formatDateOnly(item.expiryDate)}`,
      `Time remaining: ${formatDays(item.daysRemaining)}`,
      "",
      "Please arrange renewal and update the portal once the new certificate is issued.",
      "",
      "UAE Kitchen - Compliance Portal",
    ].join("\n")
  );
  return `mailto:${encodeURIComponent(email)}?subject=${subject}&body=${body}`;
}

function getAlertRoute(employee) {
  return { type: "alerts", label: "Compliance Email", email: state.settings.alertsEmail };
}

function getAlertRecipients() {
  return [state.settings.alertsEmail].filter(Boolean);
}

function getPainPoint(summaries) {
  const issueCounts = summaries.reduce((counts, item) => {
    if (item.status === "Valid") return counts;
    const key = `${item.certificate.label} ${item.status}`;
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  const top = Object.entries(issueCounts).sort((a, b) => b[1] - a[1])[0];
  if (!top) return { title: "None", detail: "No certificate issues found" };
  return { title: top[0], detail: `${top[1]} certificate${top[1] === 1 ? "" : "s"} need attention` };
}

function getWeakestDepartment(summaries) {
  const departments = summaries.reduce((groups, item) => {
    const department = item.employee.department || "Unassigned";
    groups[department] ||= { urgent: 0, total: 0 };
    groups[department].total += 1;
    if (item.status === "Expired" || item.status === "Missing" || item.status === "Expiring in 30 Days") groups[department].urgent += 1;
    return groups;
  }, {});
  const top = Object.entries(departments).sort((a, b) => b[1].urgent - a[1].urgent || b[1].total - a[1].total)[0];
  if (!top || !top[1].urgent) return { title: "None", detail: "No urgent department risk" };
  return { title: top[0], detail: `${top[1].urgent} of ${top[1].total} certificates need action` };
}

function downloadEmployeeTemplate() {
  const rows = [
    ["employeeId", "name", "department", "position", "email", "phone", "bfsIssueDate", "ohcIssueDate"],
    ["UK-1001", "Sample Employee", "Kitchen", "Commis Chef", "sample.employee@calo.app", "+971 50 000 0000", "2026-01-15", "2026-03-01"],
    ["UK-1002", "Dispatch Sample", "Dispatch", "Driver", "dispatch.sample@calo.app", "+971 50 000 0001", "2025-09-20", "2026-02-10"],
  ];
  downloadTextFile(`uae-kitchen-employee-template-${new Date().toISOString().slice(0, 10)}.csv`, rows.map((row) => row.map(csvEscape).join(",")).join("\n"), "text/csv;charset=utf-8");
}

function importEmployeesFromCsv(text) {
  const rows = parseCsv(text).filter((row) => row.some((cell) => cell.trim()));
  if (rows.length < 2) return { added: 0, updated: 0, skipped: 0 };
  const headers = rows[0].map((header) => normalizeHeader(header));
  let added = 0;
  let updated = 0;
  let skipped = 0;

  rows.slice(1).forEach((row) => {
    const record = headers.reduce((item, header, index) => {
      item[header] = (row[index] || "").trim();
      return item;
    }, {});
    if (!record.employeeid || !record.name || !record.department || !record.position || !record.email || !record.phone) {
      skipped += 1;
      return;
    }

    const existing = state.employees.find((employee) => employee.employeeId.toLowerCase() === record.employeeid.toLowerCase());
    const certificates = existing?.certificates || createEmptyCertificates();
    applyCsvCertificate(certificates, "bfs", record.bfsissuedate);
    applyCsvCertificate(certificates, "ohc", record.ohcissuedate);

    const employee = {
      id: existing?.id || crypto.randomUUID(),
      name: record.name,
      employeeId: record.employeeid,
      department: record.department,
      position: record.position,
      email: record.email.toLowerCase(),
      phone: record.phone,
      certificates,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    if (existing) {
      state.employees = state.employees.map((item) => (item.id === existing.id ? employee : item));
      updated += 1;
    } else {
      state.employees.unshift(employee);
      added += 1;
    }
  });

  return { added, updated, skipped };
}

function applyCsvCertificate(certificates, type, issueDate) {
  if (!issueDate) return;
  if (!isValidDateInput(issueDate)) return;
  certificates[type] = {
    issueDate,
    expiryDate: calculateExpiryDate(issueDate, CERTIFICATES[type].validYears),
    file: certificates[type]?.file || null,
    updatedAt: new Date().toISOString(),
  };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell);
  rows.push(row);
  return rows;
}

function normalizeHeader(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isValidDateInput(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00`).getTime());
}

function editEmployee(employeeId) {
  const employee = state.employees.find((item) => item.id === employeeId);
  if (!employee) return;
  employeeForm.elements.editingId.value = employee.id;
  employeeForm.elements.name.value = employee.name;
  employeeForm.elements.employeeId.value = employee.employeeId;
  employeeForm.elements.department.value = employee.department;
  employeeForm.elements.position.value = employee.position;
  employeeForm.elements.email.value = employee.email;
  employeeForm.elements.phone.value = employee.phone;
  document.getElementById("employeeSubmitButton").textContent = "Save Changes";
  document.getElementById("cancelEmployeeEdit").classList.remove("hidden");
  showView("employees");
  employeeForm.elements.name.focus();
}

function removeEmployee(employeeId) {
  const employee = state.employees.find((item) => item.id === employeeId);
  if (!employee) return;
  if (!confirm(`Remove ${employee.name} and their certificate records?`)) return;
  state.employees = state.employees.filter((item) => item.id !== employeeId);
  persist();
  render();
  showToast("Employee removed.");
}

function editCertificate(employeeId, type) {
  const employee = state.employees.find((item) => item.id === employeeId);
  if (!employee) return;
  certificateForm.elements.employeeId.value = employeeId;
  certificateForm.elements.type.value = type;
  certificateForm.elements.issueDate.value = employee.certificates[type]?.issueDate || "";
  certificateForm.elements.expiryDate.value = employee.certificates[type]?.expiryDate || "";
  showView("certificates");
  certificateForm.elements.issueDate.focus();
}

function removeCertificate(employeeId, type) {
  const employee = state.employees.find((item) => item.id === employeeId);
  if (!employee) return;
  if (!employee.certificates[type]?.issueDate) {
    showToast("There is no certificate to clear.");
    return;
  }
  if (!confirm(`Clear ${CERTIFICATES[type].label} certificate for ${employee.name}?`)) return;
  employee.certificates[type] = {};
  employee.updatedAt = new Date().toISOString();
  persist();
  render();
  showToast("Certificate cleared.");
}

function resetEmployeeForm() {
  employeeForm.reset();
  employeeForm.elements.editingId.value = "";
  document.getElementById("employeeSubmitButton").textContent = "Add Employee";
  document.getElementById("cancelEmployeeEdit").classList.add("hidden");
}

function showView(viewId) {
  tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.view === viewId));
  views.forEach((view) => view.classList.toggle("active-view", view.id === viewId));
}

function wireRowActions() {
  document.querySelectorAll("[data-action]").forEach((button) => {
    if (button.dataset.bound) return;
    button.dataset.bound = "true";
    button.addEventListener("click", () => {
      const action = button.dataset.action;
      if (action === "edit-employee") editEmployee(button.dataset.id);
      if (action === "remove-employee") removeEmployee(button.dataset.id);
      if (action === "edit-certificate") editCertificate(button.dataset.employeeId, button.dataset.type);
      if (action === "remove-certificate") removeCertificate(button.dataset.employeeId, button.dataset.type);
    });
  });
}

async function readCertificateFile(file) {
  if (!file) return null;
  const allowed = file.type === "application/pdf" || file.type.startsWith("image/");
  if (!allowed) {
    showToast("Upload a PDF or image certificate file.");
    throw new Error("Unsupported file type");
  }
  return {
    name: file.name,
    type: file.type,
    size: file.size,
    dataUrl: await readFileAsDataUrl(file),
    uploadedAt: new Date().toISOString(),
  };
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

function renderFileLink(file) {
  if (!file?.dataUrl) return '<span class="muted">No file</span>';
  return `<a class="table-link" href="${file.dataUrl}" download="${escapeHtml(file.name)}">${escapeHtml(file.name)}</a>`;
}

function exportExcel() {
  const rows = state.employees.map((employee) => {
    const bfs = getCertificateSummary(employee, "bfs");
    const ohc = getCertificateSummary(employee, "ohc");
    return [
      employee.employeeId,
      employee.name,
      employee.department,
      employee.position,
      employee.email,
      employee.phone,
      bfs.issueDate,
      bfs.expiryDate,
      bfs.status,
      bfs.record.file?.name || "",
      ohc.issueDate,
      ohc.expiryDate,
      ohc.status,
      ohc.record.file?.name || "",
    ];
  });

  const headers = [
    "Employee ID",
    "Name",
    "Department",
    "Position",
    "Email",
    "Phone",
    "BFS Issue Date",
    "BFS Expiry Date",
    "BFS Status",
    "BFS File",
    "OHC Issue Date",
    "OHC Expiry Date",
    "OHC Status",
    "OHC File",
  ];
  const table = `<table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
  const html = `<!doctype html><html><head><meta charset="UTF-8"></head><body>${table}</body></html>`;
  downloadTextFile(`uae-kitchen-certificate-register-${new Date().toISOString().slice(0, 10)}.xls`, html, "application/vnd.ms-excel;charset=utf-8");
  showToast("Excel export prepared.");
}

function downloadTextFile(fileName, content, type) {
  const blob = new Blob([content], { type });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(link.href);
}

function seedDemoData() {
  const today = new Date();
  const dateIn = (days) => {
    const date = new Date(today);
    date.setDate(date.getDate() + days);
    return date.toISOString().slice(0, 10);
  };
  const issueFor = (expiry, years) => {
    const date = new Date(`${expiry}T00:00:00`);
    date.setFullYear(date.getFullYear() - years);
    return date.toISOString().slice(0, 10);
  };
  const makeCert = (type, expiryOffset, fileName) => {
    const expiryDate = dateIn(expiryOffset);
    return {
      issueDate: issueFor(expiryDate, CERTIFICATES[type].validYears),
      expiryDate,
      file: {
        name: fileName,
        type: "application/pdf",
        size: 0,
        dataUrl: "data:application/pdf;base64,",
        uploadedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    };
  };

  state.employees = [
    {
      id: crypto.randomUUID(),
      name: "Aisha Rahman",
      employeeId: "CK-1001",
      department: "Kitchen",
      position: "Line Supervisor",
      email: "aisha.rahman@countrykitchen.ae",
      phone: "+971 50 100 1001",
      certificates: {
        bfs: makeCert("bfs", 140, "aisha-bfs.pdf"),
        ohc: makeCert("ohc", 24, "aisha-ohc.pdf"),
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: crypto.randomUUID(),
      name: "Khalid Mansoor",
      employeeId: "CK-1002",
      department: "Dispatch",
      position: "Driver",
      email: "khalid.mansoor@countrykitchen.ae",
      phone: "+971 50 100 1002",
      certificates: {
        bfs: makeCert("bfs", -12, "khalid-bfs.pdf"),
        ohc: makeCert("ohc", 82, "khalid-ohc.pdf"),
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: crypto.randomUUID(),
      name: "Maria Santos",
      employeeId: "CK-1003",
      department: "Kitchen",
      position: "QA Officer",
      email: "maria.santos@countrykitchen.ae",
      phone: "+971 50 100 1003",
      certificates: {
        bfs: makeCert("bfs", 410, "maria-bfs.pdf"),
        ohc: makeCert("ohc", 9, "maria-ohc.pdf"),
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: crypto.randomUUID(),
      name: "Omar Faris",
      employeeId: "CK-1004",
      department: "Kitchen",
      position: "Commis Chef",
      email: "omar.faris@countrykitchen.ae",
      phone: "+971 50 100 1004",
      certificates: {
        bfs: makeCert("bfs", 67, "omar-bfs.pdf"),
        ohc: {},
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];
  persist();
  render();
  showToast("Sample compliance records loaded.");
}

function setRows(targetId, rows, colspan, emptyMessage) {
  document.getElementById(targetId).innerHTML = rows.length
    ? rows.join("")
    : `<tr><td colspan="${colspan}" class="empty-state">${emptyMessage}</td></tr>`;
}

function countBy(items, key) {
  return items.reduce((counts, item) => {
    counts[item[key]] = (counts[item[key]] || 0) + 1;
    return counts;
  }, {});
}

function compactCertificateStatus(label, status) {
  return `<span class="compact-status">${label}: ${statusBadge(status)}</span>`;
}

function statusBadge(status) {
  const className =
    status === "Valid"
      ? "good"
      : status === "Expiring in 90 Days"
        ? "watch"
        : status === "Expiring in 30 Days"
          ? "warn"
          : status === "Missing"
            ? "neutral"
            : "bad";
  return `<span class="badge ${className}">${escapeHtml(status)}</span>`;
}

function formatDateOnly(value) {
  if (!value) return "Not recorded";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(`${value}T00:00:00`));
}

function formatDays(days) {
  if (!Number.isFinite(days)) return "not recorded";
  if (days < 0) return `${Math.abs(days)} days overdue`;
  if (days === 0) return "expires today";
  return `${days} days remaining`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function csvEscape(value) {
  const str = String(value ?? "");
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replaceAll('"', '""')}"`;
  }
  return str;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => toast.classList.remove("visible"), 2600);
}

render();
