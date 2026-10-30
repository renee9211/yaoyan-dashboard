// Shared cross-module relationship rules.

export function relationTimestampValue(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

export function quotationMonthFromNumber(number) {
  const match = String(number || "").trim().match(/^Y(\d{2})(\d{2})/i);
  if (!match) return "";
  const month = Number(match[2]);
  if (month < 1 || month > 12) return "";
  return `20${match[1]}-${String(month).padStart(2, "0")}`;
}

export function confirmedQuotationForProject(project, quotations = []) {
  if (!project) return null;
  const linked = quotations
    .filter(quotation => quotation.projectId === project.id && quotation.status === "confirmed")
    .sort((a, b) => {
      const confirmedCompare = relationTimestampValue(b.confirmedAt || b.updatedAt || b.createdAt)
        - relationTimestampValue(a.confirmedAt || a.updatedAt || a.createdAt);
      if (confirmedCompare) return confirmedCompare;
      return Number(b.version || 1) - Number(a.version || 1);
    });
  if (linked[0]) return linked[0];
  if (!project.confirmedQuotationId) return null;
  return quotations.find(quotation => quotation.id === project.confirmedQuotationId && quotation.status === "confirmed") || null;
}

export function latestQuotationForProject(project, quotations = []) {
  if (!project) return null;
  return quotations
    .filter(quotation => quotation.projectId === project.id)
    .sort((a, b) => {
      const updatedCompare = relationTimestampValue(b.updatedAt || b.createdAt)
        - relationTimestampValue(a.updatedAt || a.createdAt);
      if (updatedCompare) return updatedCompare;
      return Number(b.version || 1) - Number(a.version || 1);
    })[0] || null;
}

export function projectQuotationNumber(project, quotations = []) {
  return confirmedQuotationForProject(project, quotations)?.number
    || project?.confirmedQuotationNumber
    || "";
}

export function projectReportingMonth(project, quotations = []) {
  const adoptedNumber = project?.confirmedQuotationNumber
    || confirmedQuotationForProject(project, quotations)?.number
    || "";
  return quotationMonthFromNumber(adoptedNumber)
    || String(project?.startDate || "").slice(0, 7);
}
