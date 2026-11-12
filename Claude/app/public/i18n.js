/*
 * i18n.js — puts the app's texts into the page.
 *
 * The server sends the merged table as /strings.js (strings/en.json overlaid
 * with strings.local.json, see strings.ts). This file applies it to the markup
 * and gives app.js / settings.js a t() for texts they build themselves.
 *
 * Markup: data-i18n="key" sets the text; data-i18n-title, data-i18n-aria-label,
 * data-i18n-placeholder, data-i18n-data-placeholder and data-i18n-data-new-label
 * set that attribute. The English text stays in the HTML as the fallback.
 */
(function (root) {
  "use strict";

  var ATTRS = ["title", "aria-label", "placeholder", "data-placeholder", "data-new-label"];

  function create(data) {
    var table = (data && data.strings) || {};
    var language = (data && data.language) || "en";

    function has(key) {
      return Object.prototype.hasOwnProperty.call(table, key);
    }

    // Text for a key with {name} placeholders filled in. A key missing from
    // every table shows as itself — visible, so it gets fixed.
    function t(key, vars) {
      var template = has(key) ? table[key] : key;
      if (!vars) return template;
      return template.replace(/\{(\w+)\}/g, function (match, name) {
        return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match;
      });
    }

    function apply(scope) {
      scope = scope || root.document;
      if (!scope || !scope.querySelectorAll) return;
      var nodes = scope.querySelectorAll("[data-i18n]");
      for (var i = 0; i < nodes.length; i++) {
        var key = nodes[i].getAttribute("data-i18n");
        if (has(key)) nodes[i].textContent = table[key];
      }
      ATTRS.forEach(function (attr) {
        var marked = scope.querySelectorAll("[data-i18n-" + attr + "]");
        for (var j = 0; j < marked.length; j++) {
          var k = marked[j].getAttribute("data-i18n-" + attr);
          if (has(k)) marked[j].setAttribute(attr, table[k]);
        }
      });
    }

    // Clock time of a message, in the configured language's format.
    function formatTime(ts) {
      try {
        return new Date(ts).toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" });
      } catch (e) {
        return "";
      }
    }

    function formatNumber(n) {
      try {
        return Number(n).toLocaleString(language);
      } catch (e) {
        return String(n);
      }
    }

    var version = (data && data.version) || "";

    return { language: language, version: version, t: t, has: has, apply: apply, formatTime: formatTime, formatNumber: formatNumber };
  }

  var api = create(root.EMBERVY_STRINGS);
  api.create = create;

  if (typeof module === "object" && module && module.exports) {
    module.exports = api; // bun test
    return;
  }
  root.embervyI18n = api;
  if (root.document) {
    root.document.documentElement.lang = api.language;
    api.apply(root.document);
  }
})(typeof window !== "undefined" ? window : globalThis);
