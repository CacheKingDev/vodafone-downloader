const DISMISS_AFTER_MS = 4000;
const FADE_DURATION_MS = 300;

function scheduleDismiss(row) {
  if (row.dataset.dismissScheduled === "true") {
    return;
  }
  row.dataset.dismissScheduled = "true";
  setTimeout(() => {
    row.classList.add("row-note-fade");
    setTimeout(() => row.remove(), FADE_DURATION_MS);
  }, DISMISS_AFTER_MS);
}

document.body.addEventListener("htmx:afterSettle", () => {
  for (const row of document.querySelectorAll(".row-note")) {
    scheduleDismiss(row);
  }
});
