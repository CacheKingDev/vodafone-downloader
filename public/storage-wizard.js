(function () {
  "use strict";

  // Open the "Standardspeicher ändern?" dialog once htmx has swapped its
  // content in; <dialog> already closes on Escape/backdrop natively.
  document.body.addEventListener("htmx:afterSwap", function (event) {
    var target = event.detail.target;
    if (target && target.id === "default-confirm-dialog" && typeof target.showModal === "function") {
      target.showModal();
    }
    if (target && target.id === "test-result") {
      syncSaveGate(target.closest("form"));
    }
  });

  document.body.addEventListener("click", function (event) {
    var closeButton = event.target.closest("[data-close-dialog]");
    if (closeButton === null) return;
    var dialog = closeButton.closest("dialog");
    if (dialog !== null) dialog.close();
  });

  // Row-action popovers ("⋯" menu) render in the top layer, so they escape
  // the table's own horizontal-scroll clipping — but that means their
  // position has to be set in JS instead of plain CSS. This runs on
  // "beforetoggle" (before the popover is actually shown/focused), not
  // "toggle": positioning it only after it briefly appeared at its unstyled
  // in-flow spot let the browser's focus-follows-visibility behaviour
  // scroll the table sideways to reveal that spot first. Neither event
  // bubbles, so this listener runs in the capture phase to still catch it.
  // The popover is still display:none at this point, so offsetWidth/Height
  // read 0 — read the CSS width instead and just place below the trigger.
  document.body.addEventListener(
    "beforetoggle",
    function (event) {
      var popover = event.target;
      if (!popover.matches || !popover.matches(".row-menu-panel, .help-popover") || event.newState !== "open") {
        return;
      }
      var trigger = document.querySelector('[popovertarget="' + popover.id + '"]');
      if (trigger === null) return;
      var rect = trigger.getBoundingClientRect();
      var width = parseFloat(getComputedStyle(popover).width) || 190;
      var left = Math.min(rect.right - width, window.innerWidth - width - 8);
      left = Math.max(8, left);
      var top = Math.min(rect.bottom + 4, window.innerHeight - 8);
      popover.style.left = left + "px";
      popover.style.top = top + "px";
    },
    true,
  );

  // FTP default port follows the connection type unless the user already
  // typed a custom value (spec section 7: "sinnvolle Standardports").
  var KNOWN_FTP_PORTS = { none: "21", explicit: "21", implicit: "990" };
  document.body.addEventListener("change", function (event) {
    if (!event.target.matches("[data-ftp-secure]")) return;
    var form = event.target.closest("form");
    if (form === null) return;
    var portField = form.querySelector("[data-ftp-port]");
    if (portField === null) return;
    var currentIsKnownDefault = Object.values(KNOWN_FTP_PORTS).includes(portField.value);
    if (portField.value === "" || currentIsKnownDefault) {
      portField.value = KNOWN_FTP_PORTS[event.target.value] || portField.value;
    }
  });

  // "Speichern" stays disabled until the currently entered configuration has
  // been tested successfully (spec section 10) — editing any connection
  // field afterwards invalidates that test again.
  document.body.addEventListener("input", function (event) {
    var form = event.target.closest("[data-storage-form]");
    if (form === null) return;
    if (event.target.closest("#test-result") !== null) return;
    invalidateSaveGate(form);
  });
  document.body.addEventListener("change", function (event) {
    var form = event.target.closest("[data-storage-form]");
    if (form === null) return;
    if (event.target.closest("#test-result") !== null) return;
    invalidateSaveGate(form);
  });

  function invalidateSaveGate(form) {
    var button = form.querySelector("[data-requires-test]");
    if (button !== null) button.disabled = true;
  }

  function syncSaveGate(form) {
    if (form === null) return;
    var button = form.querySelector("[data-requires-test]");
    if (button === null) return;
    var result = form.querySelector("#test-result");
    button.disabled = result === null || result.dataset.testOutcome !== "success";
  }

  document.querySelectorAll("[data-storage-form]").forEach(function (form) {
    syncSaveGate(form);
  });
})();
