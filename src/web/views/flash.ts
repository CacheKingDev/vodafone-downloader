import { escapeHtml } from "./escape.js";

export interface FlashMessage {
  readonly kind: "error" | "success";
  readonly text: string;
}

export function flashMessage({ kind, text }: FlashMessage): string {
  return `<div class="alert alert-${kind}" role="alert">${escapeHtml(text)}</div>`;
}
