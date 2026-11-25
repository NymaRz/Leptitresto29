// Le P'tit Resto 29 : menu mobile, jour courant et statut d'ouverture.
(function () {
  "use strict";

  // Horaires : 0 = dimanche … 6 = samedi. Créneaux en minutes depuis minuit.
  var HORAIRES = {
    0: [], 1: [], 6: [],
    2: [[720, 810], [1140, 1260]],
    3: [[720, 810], [1140, 1260]],
    4: [[720, 810], [1140, 1260]],
    5: [[720, 810], [1140, 1260]]
  };
  var JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

  // Menu mobile
  var toggle = document.querySelector(".nav-toggle");
  var nav = document.getElementById("menu");
  if (toggle && nav) {
    var setOpen = function (open) {
      toggle.setAttribute("aria-expanded", String(open));
      nav.classList.toggle("open", open);
      toggle.querySelector(".sr-only").textContent = open ? "Fermer le menu" : "Ouvrir le menu";
    };
    toggle.addEventListener("click", function () {
      setOpen(toggle.getAttribute("aria-expanded") !== "true");
    });
    nav.addEventListener("click", function (e) {
      if (e.target.closest("a")) setOpen(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") setOpen(false);
    });
  }

  // Année du pied de page
  var year = document.querySelector("[data-year]");

  // Heure locale du restaurant (Europe/Paris), quel que soit le fuseau du visiteur
  var now = new Date();
  var day = now.getDay();
  var minutes = now.getHours() * 60 + now.getMinutes();
  try {
    var parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Paris", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", year: "numeric"
    }).formatToParts(now);
    var get = function (t) { return (parts.find(function (p) { return p.type === t; }) || {}).value; };
    day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
    minutes = parseInt(get("hour"), 10) * 60 + parseInt(get("minute"), 10);
    if (year) year.textContent = get("year");
  } catch (err) {
    if (year) year.textContent = String(now.getFullYear());
  }

  var row = document.querySelector('.hours tr[data-day="' + day + '"]');
  if (row) row.classList.add("today");

  var fmt = function (m) {
    var h = Math.floor(m / 60), mm = m % 60;
    return h + "h" + (mm ? String(mm).padStart(2, "0") : "");
  };

  var status = document.querySelector("[data-status]");
  if (!status) return;

  var slots = HORAIRES[day] || [];
  var text = "";
  for (var i = 0; i < slots.length; i++) {
    if (minutes >= slots[i][0] && minutes < slots[i][1]) {
      text = "Ouvert jusqu'à " + fmt(slots[i][1]);
      status.classList.add("is-open");
      break;
    }
    if (minutes < slots[i][0]) {
      text = "Fermé · ouvre aujourd'hui à " + fmt(slots[i][0]);
      break;
    }
  }
  if (!text) {
    for (var d = 1; d <= 7; d++) {
      var next = (day + d) % 7;
      if ((HORAIRES[next] || []).length) {
        text = "Fermé · ouvre " + (d === 1 ? "demain" : JOURS[next]) + " à " + fmt(HORAIRES[next][0][0]);
        break;
      }
    }
  }
  status.textContent = text;
  status.hidden = false;
})();
