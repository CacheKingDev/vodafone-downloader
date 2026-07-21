const links = document.querySelectorAll(".top-nav nav a[href]");
let active = null;
for (const link of links) {
  const path = new URL(link.href).pathname;
  if (location.pathname === path || location.pathname.startsWith(path + "/")) {
    if (active === null || path.length > new URL(active.href).pathname.length) {
      active = link;
    }
  }
}
if (active) {
  active.setAttribute("aria-current", "page");
}
