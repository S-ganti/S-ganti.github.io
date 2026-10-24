// Theme toggle and scroll reveal. No dependencies.
(function () {
  var root = document.documentElement;
  root.classList.add("js");

  // Theme: follow the system unless the visitor picks one.
  var KEY = "sg-theme";
  try {
    var saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark") root.setAttribute("data-theme", saved);
  } catch (e) {}

  var btn = document.querySelector(".theme-toggle");
  if (btn) {
    btn.addEventListener("click", function () {
      var current = root.getAttribute("data-theme");
      if (!current) current = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      var next = current === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      btn.setAttribute("aria-label", next === "dark" ? "Switch to light theme" : "Switch to dark theme");
      try { localStorage.setItem(KEY, next); } catch (e) {}
    });
  }

  // Reveal on scroll. Falls back to showing everything if the observer never fires.
  var items = [].slice.call(document.querySelectorAll(".reveal"));
  function showAll() { items.forEach(function (el) { el.classList.add("in"); }); }

  if (!("IntersectionObserver" in window)) { showAll(); return; }
  var fired = false;
  var io = new IntersectionObserver(function (entries) {
    fired = true;
    entries.forEach(function (entry) {
      if (entry.isIntersecting) { entry.target.classList.add("in"); io.unobserve(entry.target); }
    });
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
  items.forEach(function (el) { io.observe(el); });
  // If the observer never reports (some embedded viewers), show everything.
  setTimeout(function () { if (!fired || !document.querySelector(".reveal.in")) showAll(); }, 1500);

  var year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());
})();
