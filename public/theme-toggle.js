const button = document.querySelector("[data-theme-toggle]");
if (button) {
  button.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    document.cookie = "theme=" + next + "; Path=/; Max-Age=31536000; SameSite=Lax";
  });
}
