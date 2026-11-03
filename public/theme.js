(function () {
  const root = document.documentElement;
  const toggle = document.getElementById("theme-toggle");
  const meta = document.getElementById("theme-color");
  let media = null;
  try { media = window.matchMedia("(prefers-color-scheme: dark)"); } catch (e) {}
  let explicit = null;
  try {
    const saved = localStorage.getItem("theme");
    explicit = saved === "dark" || saved === "light" ? saved : null;
  } catch (e) {}

  function systemTheme() {
    return media && media.matches ? "dark" : "light";
  }

  function applyTheme(theme, persist) {
    const dark = theme === "dark";
    root.dataset.theme = dark ? "dark" : "light";
    if (meta) meta.content = dark ? "#000000" : "#ffffff";
    if (toggle) {
      const label = dark ? "Switch to light theme" : "Switch to dark theme";
      toggle.setAttribute("aria-label", label);
      toggle.title = label;
    }
    if (persist) {
      try { localStorage.setItem("theme", dark ? "dark" : "light"); } catch (e) {}
    }
  }

  applyTheme(explicit || systemTheme(), false);

  if (toggle) {
    toggle.addEventListener("click", function () {
      explicit = root.dataset.theme === "dark" ? "light" : "dark";
      applyTheme(explicit, true);
    });
  }

  if (media) {
    const onSystem = function (e) {
      if (!explicit) applyTheme(e.matches ? "dark" : "light", false);
    };
    if (media.addEventListener) media.addEventListener("change", onSystem);
    else if (media.addListener) media.addListener(onSystem);
  }

  window.addEventListener("storage", function (e) {
    if (e.key !== "theme" && e.key !== null) return;
    explicit = e.newValue === "dark" || e.newValue === "light" ? e.newValue : null;
    applyTheme(explicit || systemTheme(), false);
  });
})();
