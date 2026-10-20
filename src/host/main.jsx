// SubMotion host entry (ExtendScript, ES3). Loaded by CEP via manifest ScriptPath, or by the panel
// with $.evalFile as a fallback. Exposes SM.call(fn, arg) which always returns a JSON string:
// {"ok":true,"data":...} or {"ok":false,"error":"..."}.
var SM = {};

(function () {
  function quote(s) {
    var out = '"', i, c, n;
    for (i = 0; i < s.length; i++) {
      c = s.charAt(i);
      n = s.charCodeAt(i);
      if (c === '"' || c === "\\") out += "\\" + c;
      else if (n < 32 || n === 8232 || n === 8233) out += "\\u" + ("000" + n.toString(16)).slice(-4);
      else out += c;
    }
    return out + '"';
  }

  // ExtendScript has no reliable JSON object across hosts/versions.
  SM.json = function (v) {
    var i, parts;
    if (v === null || v === undefined) return "null";
    if (typeof v === "number") return isFinite(v) ? String(v) : "null";
    if (typeof v === "boolean") return String(v);
    if (typeof v === "string") return quote(v);
    parts = [];
    if (v instanceof Array) {
      for (i = 0; i < v.length; i++) parts.push(SM.json(v[i]));
      return "[" + parts.join(",") + "]";
    }
    for (i in v) if (v.hasOwnProperty(i) && typeof v[i] !== "function") parts.push(quote(i) + ":" + SM.json(v[i]));
    return "{" + parts.join(",") + "}";
  };

  SM.call = function (fn, arg) {
    try {
      if (!SM.host) throw new Error("SubMotion host scripts failed to load" + (SM.loadError ? ": " + SM.loadError : "."));
      if (!SM.host[fn]) throw new Error("Unknown host function: " + fn);
      var data = SM.host[fn](arg);
      return SM.json({ ok: true, data: data === undefined ? null : data });
    } catch (e) {
      return SM.json({ ok: false, error: String(e.message || e) + (e.line ? " (host line " + e.line + ")" : "") });
    }
  };

  // Load the app adapter next to this file. Never throw here: in Premiere a script that throws while
  // the extension loads breaks every later evalScript ("EvalScript error.") for the panel.
  try {
    var here = new File($.fileName);
    if (!$.fileName || !here.exists) return; // no file context; the panel loads us via $.evalFile(path)
    SM.root = here.parent.parent; // .../src
    var adapter = BridgeTalk.appName === "aftereffects" ? "/after-effects/host.jsx" : "/premiere/host.jsx";
    $.evalFile(new File(SM.root.fsName + adapter));
  } catch (e) {
    SM.loadError = String(e.message || e) + (e.line ? " (line " + e.line + ")" : "");
  }
})();
