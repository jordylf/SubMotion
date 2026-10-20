// In-app verification for After Effects (dev tool). Run via `node scripts/verify-ae.ts`.
// Builds controls + two word layers with the real host code in TEMPORARY comps, samples the
// expression results over time, then deletes the temporary comps. The user's project is left as-is.
(function () {
  var dir = File($.fileName).parent, out = [];
  function log(s) { out.push(s); }
  function fmt(v) {
    if (typeof v === "number") return isFinite(v) ? String(Math.round(v * 1000) / 1000) : "NaN";
    if (v && v.length !== undefined && typeof v !== "string") { var a = []; for (var z = 0; z < v.length; z++) a.push(fmt(v[z])); return "[" + a.join(",") + "]"; }
    return String(v);
  }
  function read(path) { var f = new File(path); f.encoding = "UTF-8"; f.open("r"); var s = f.read(); f.close(); return s; }

  var ctlComp = null, wordComp = null;
  app.beginUndoGroup("SubMotion verify (temporary)");
  try {
    var job = eval("(" + read(dir.fsName + "/.verify-job.json") + ")");
    $.evalFile(new File(dir.parent.fsName + "/src/host/main.jsx"));
    var I = SM.internals;
    log("AE " + app.version);

    ctlComp = app.project.items.addComp(job.controlsComp, 1080, 1920, 1, 5, 30);
    var ctl = I.addControls(ctlComp, job.controls, null);
    var fx = ctl.property("ADBE Effect Parade"), names = [];
    for (var i = 1; i <= fx.numProperties; i++) names.push(fx.property(i).name);
    log("controls: " + names.join(", "));

    wordComp = app.project.items.addComp("SM__verify_words", 1080, 1920, 1, 5, 30);
    var words = [["Gue", 0.2, 0.5, 0], ["50 RIBU", 0.6, 1.2, 1]];
    for (var k = 0; k < words.length; k++) {
      var w = words[k], L = wordComp.layers.addText(w[0]);
      I.styleText(L, job.style, w[3] ? job.style.fontSize * job.style.emphasisSizeMul : job.style.fontSize, null, ParagraphJustification.LEFT_JUSTIFY, w[3]);
      L.startTime = w[1];
      L.outPoint = 5;
      var mv = new MarkerValue(w[3] ? "emph" : "normal");
      mv.duration = w[2] - w[1];
      L.property("ADBE Marker").setValueAtTime(w[1], mv);
      L.property("ADBE Transform Group").property("ADBE Position").setValue([540, 900]);
      I.setExpr(L, "ADBE Scale", job.expr.scale);
      I.setExpr(L, "ADBE Opacity", job.expr.opacity);
      I.setExpr(L, "ADBE Position", job.expr.position);
      I.addWordAnimator(L, job.expr);
      I.addWordEffects(L, w[3], job.style);

      var tr = L.property("ADBE Transform Group");
      var props = [tr.property("ADBE Scale"), tr.property("ADBE Opacity"), tr.property("ADBE Position")];
      var an = L.property("ADBE Text Properties").property("ADBE Text Animators").property(1).property("ADBE Text Animator Properties");
      props.push(an.property("ADBE Text Fill Color"), an.property("ADBE Text Blur"));
      log("word '" + w[0] + "' (" + (w[3] ? "emphasis" : "normal") + ", appears at " + w[1] + "s)");
      for (var p = 0; p < props.length; p++) {
        var pr = props[p], samples = [];
        var ts = [-0.05, 0, 0.034, 0.067, 0.1, 0.2, 0.5];
        for (var t = 0; t < ts.length; t++) samples.push("+" + ts[t] + ":" + fmt(pr.valueAtTime(w[1] + ts[t], false)));
        log("  " + pr.name + (pr.expressionError ? "  ERROR: " + pr.expressionError : "  ok") + "\n     " + samples.join("  "));
      }
    }
  } catch (e) {
    log("VERIFY ERROR: " + e.toString() + " (line " + e.line + ")");
  } finally {
    try { if (wordComp) wordComp.remove(); if (ctlComp) ctlComp.remove(); } catch (e2) { log("cleanup failed: " + e2); }
    app.endUndoGroup();
    var f = new File(dir.fsName + "/.verify-report.txt");
    f.encoding = "UTF-8";
    f.open("w");
    f.write(out.join("\n"));
    f.close();
  }
})();
