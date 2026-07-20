import { escapeHtml } from "../escape.js";

const LABELS = {
  ok: "OK",
  error: "Fehler",
  needs_action: "Aktion nötig",
  success: "Erfolgreich",
  partial: "Teilweise",
  failed: "Fehlgeschlagen",
  pending: "Ausstehend",
  stored: "Gespeichert",
};

export function statusBadge(status: keyof typeof LABELS): string {
  return `<span class="status-badge status-${status}">${escapeHtml(LABELS[status])}</span>`;
}
