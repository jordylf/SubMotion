// After Effects adapter (ExtendScript, ES3).
// Output: one "SubMotion Captions" comp (added to the target comp) with a controls null, plus one
// precomp per caption holding one editable text layer per word. Motion is procedural (expressions
// reading the controls null), so there are no keyframes and every word stays editable.
(function () {
  var MAIN = "SubMotion Captions";
  var CONTROLS = "SubMotion Controls";
  var FOLDER = "SubMotion Precomps";
  var TEMPLATE_FOLDER = "SubMotion Templates";
  var S = null; // state of the current run

  function eachItem(fn) {
    for (var i = app.project.numItems; i >= 1; i--) fn(app.project.item(i));
  }

  function itemById(id) {
    var found = null;
    eachItem(function (it) { if (it.id === id) found = it; });
    return found;
  }

  function activeComp() {
    var c = app.project.activeItem;
    return c && c instanceof CompItem ? c : null;
  }

  /** The comp captions go into. If the user is looking at our own comp, use the comp it was made for. */
  function targetComp() {
    var c = activeComp();
    if (c && c.name === MAIN) {
      var m = /SubMotion target:(\d+)/.exec(c.comment);
      return m ? itemById(Number(m[1])) : null;
    }
    return c;
  }

  function frameInfo() {
    var c = targetComp();
    if (!c) return { width: 1080, height: 1920, name: "No active comp - a 1080x1920 comp will be created" };
    return { width: c.width, height: c.height, name: c.name };
  }

  /** Selected text layers become cues. A layer with Source Text keyframes yields one cue per keyframe. */
  function readSourceCaptions() {
    var c = activeComp();
    if (!c) throw new Error("Open a comp and select text layers first.");
    var out = [], layers = c.selectedLayers, i, k, L, st;
    for (i = 0; i < layers.length; i++) {
      L = layers[i];
      if (!(L instanceof TextLayer)) continue;
      st = L.property("ADBE Text Properties").property("ADBE Text Document");
      if (st.numKeys > 1) {
        for (k = 1; k <= st.numKeys; k++) {
          var end = k < st.numKeys ? st.keyTime(k + 1) : L.outPoint;
          var txt = st.keyValue(k).text;
          if (txt && end > st.keyTime(k)) out.push({ start: st.keyTime(k), end: end, text: txt.replace(/[\r\n]+/g, " ") });
        }
      } else {
        out.push({ start: L.inPoint, end: L.outPoint, text: st.value.text.replace(/[\r\n]+/g, " ") });
      }
    }
    if (!out.length) throw new Error("No text layers selected.");
    out.sort(function (a, b) { return a.start - b.start; });
    return out;
  }

  /** Media file of the selected footage layer and how its time maps to comp time (for transcription). */
  function mediaSource() {
    var c = activeComp();
    var L = c && c.selectedLayers.length ? c.selectedLayers[0] : null;
    if (!L || !L.source || !(L.source instanceof FootageItem) || !L.source.file)
      throw new Error("Select a video or audio footage layer in the comp first.");
    if (L.timeRemapEnabled || L.stretch <= 0) throw new Error("Time remap / reversed layers are not supported for transcription.");
    return { path: L.source.file.fsName, offset: L.startTime, rate: L.stretch / 100, from: L.inPoint, to: L.outPoint };
  }

  function deleteGenerated() {
    var doomed = [];
    eachItem(function (it) {
      if ((it instanceof CompItem && it.name === MAIN) || (it instanceof FolderItem && it.name === FOLDER)) doomed.push(it);
    });
    // Collect first: removing a folder removes its children and shifts item indices.
    for (var i = 0; i < doomed.length; i++) doomed[i].remove(); // also removes its layer from the target comp
    return doomed.length;
  }

  // ---------- controls ----------

  function addEffect(layer, matchName, name) {
    var e = layer.property("ADBE Effect Parade").addProperty(matchName);
    e.name = name;
    return e;
  }

  function rgba(c) { return [c[0], c[1], c[2], 1]; } // Color Control is RGBA; TextDocument colors are RGB

  function addControls(comp, ctl, extra) {
    var L = comp.layers.addNull(comp.duration);
    L.name = CONTROLS;
    function dropdown(name, value) {
      var fx = L.property("ADBE Effect Parade");
      var idx = fx.addProperty("ADBE Dropdown Control").propertyIndex;
      fx.property(idx).property(1).setPropertyParameters(ctl.labels);
      // setPropertyParameters rebuilds the effect and resets its name, so name it afterwards (fresh refs).
      fx.property(idx).name = name;
      fx.property(idx).property(1).setValue(value);
      if (fx.property(idx).name !== name) throw new Error("Could not name dropdown \"" + name + "\".");
    }
    function set(matchName, name, value) { addEffect(L, matchName, name).property(1).setValue(value); }
    dropdown("Animation", ctl.animation);
    dropdown("Emphasis Animation", ctl.emphasisAnimation);
    set("ADBE Checkbox Control", "Animate Emphasis", ctl.animateEmphasis ? 1 : 0);
    set("ADBE Slider Control", "Intensity", ctl.intensity);
    set("ADBE Slider Control", "Emphasis Intensity", ctl.emphasisIntensity);
    set("ADBE Slider Control", "Speed", ctl.speed); // 50 = normal
    set("ADBE Slider Control", "Velocity", ctl.velocity);
    set("ADBE Color Control", "Normal Color", rgba(ctl.normalColor));
    set("ADBE Color Control", "Emphasis Color", rgba(ctl.emphasisColor));
    set("ADBE Color Control", "Active Color", rgba(ctl.activeColor));
    set("ADBE Checkbox Control", "Active Word Highlight", ctl.activeWordHighlight ? 1 : 0);
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) set("ADBE Slider Control", k, extra[k]);
    return L;
  }

  // ---------- text ----------

  function textDoc(L) {
    return L.property("ADBE Text Properties").property("ADBE Text Document");
  }

  function has(list, name) {
    for (var i = 0; list && i < list.length; i++) if (list[i] === name) return true;
    return false;
  }

  /** cls: 0 normal, 1 emphasis, -1 = template (outline if either class has it). */
  function styleText(L, st, size, font, justify, cls) {
    var outline = cls < 0 ? has(st.effects[0], "outline") || has(st.effects[1], "outline") : has(st.effects[cls], "outline");
    var sp = textDoc(L), td = sp.value;
    td.resetCharStyle();
    td.resetParagraphStyle();
    if (font) td.font = font;
    td.fontSize = size;
    td.applyFill = true;
    td.fillColor = st.textColor;
    td.applyStroke = outline;
    if (outline) {
      td.strokeColor = st.strokeColor;
      td.strokeWidth = st.strokeWidth;
      td.strokeOverFill = false;
    }
    td.tracking = st.tracking;
    td.justification = justify;
    sp.setValue(td);
  }

  /** First installed font of the list, tested once per run on a scratch layer. */
  function resolveFont(comp, fonts) {
    var L = comp.layers.addText("Ag"), sp = textDoc(L), i, td;
    try {
      for (i = 0; i < fonts.length; i++) {
        td = sp.value;
        try { td.font = fonts[i]; sp.setValue(td); } catch (e) { continue; }
        if (sp.value.font === fonts[i]) return fonts[i];
      }
      return null; // AE default font
    } finally {
      L.remove();
    }
  }

  // ---------- generation ----------

  function prepare(job) {
    app.beginUndoGroup("SubMotion: Prepare");
    try {
      // standalone: the caption comp itself is the output (Premiere Dynamic Link), sized to the sequence.
      var target = job.standalone ? null : targetComp();
      deleteGenerated();
      if (!target && !job.standalone)
        target = app.project.items.addComp("SubMotion Output", job.frame.width, job.frame.height, 1, Math.max(job.duration, 1), job.fps || 30);
      var main = target
        ? app.project.items.addComp(MAIN, target.width, target.height, target.pixelAspect, Math.max(target.duration, job.duration), target.frameRate)
        : app.project.items.addComp(MAIN, job.frame.width, job.frame.height, 1, Math.max(job.duration, 1), job.fps || 30);
      if (target) main.comment = "SubMotion target:" + target.id;
      addControls(main, job.controls, null);
      if (target) target.layers.add(main).startTime = 0;
      var st = job.style, font = resolveFont(main, [st.font].concat(st.fallbackFonts || []));
      var emphFont = st.emphasisFont ? resolveFont(main, [st.emphasisFont]) || font : font;
      S = { job: job, target: target, main: main, folder: app.project.items.addFolder(FOLDER), fonts: [font, emphFont] };
      return { fonts: S.fonts };
    } finally {
      app.endUndoGroup();
    }
  }

  function setExpr(L, matchName, expr) {
    L.property("ADBE Transform Group").property(matchName).expression = expr;
  }

  function addWordAnimator(L, ex) {
    var animators = L.property("ADBE Text Properties").property("ADBE Text Animators");
    animators.addProperty("ADBE Text Animator").name = "SubMotion";
    animators.property(1).property("ADBE Text Selectors").addProperty("ADBE Text Selector");
    animators.property(1).property("ADBE Text Animator Properties").addProperty("ADBE Text Fill Color").expression = ex.fill;
    animators.property(1).property("ADBE Text Animator Properties").addProperty("ADBE Text Blur").expression = ex.blur;
  }

  /** Measures real glyph bounds, auto-fits to max width, and lays words out on their lines. */
  function place(layers, words, st, layout) {
    var meas = [], lw = [], nLines = 0, i, r, ln, f = 1, sizes = [];
    var space = st.fontSize * st.wordSpacing;
    for (i = 0; i < layers.length; i++) {
      r = layers[i].sourceRectAtTime(layers[i].inPoint, false);
      ln = words[i][4];
      meas.push({ w: r.width, left: r.left, line: ln });
      sizes.push(textDoc(layers[i]).value.fontSize);
      lw[ln] = (lw[ln] === undefined ? -space : lw[ln]) + space + r.width;
      if (ln + 1 > nLines) nLines = ln + 1;
    }
    var widest = 0;
    for (i = 0; i < nLines; i++) if ((lw[i] || 0) > widest) widest = lw[i];
    if (layout.autoResize && widest > layout.maxWidth) f = layout.maxWidth / widest;
    if (f < 1) {
      for (i = 0; i < layers.length; i++) {
        var sp = textDoc(layers[i]), td = sp.value;
        td.fontSize = sizes[i] = sizes[i] * f;
        sp.setValue(td);
        meas[i].w *= f;
        meas[i].left *= f;
      }
      for (i = 0; i < nLines; i++) lw[i] = (lw[i] || 0) * f;
      space *= f;
    }
    // Each line is as tall as its biggest word, so emphasis lines get room; lineSpacing < 1 overlaps.
    var lineSize = [], lineCenter = [], total = 0;
    for (i = 0; i < layers.length; i++) lineSize[meas[i].line] = Math.max(lineSize[meas[i].line] || 0, sizes[i]);
    for (i = 0; i < nLines; i++) total += (lineSize[i] || st.fontSize * f) * st.lineSpacing;
    var y = layout.centerY - total / 2;
    for (i = 0; i < nLines; i++) {
      var lh = (lineSize[i] || st.fontSize * f) * st.lineSpacing;
      lineCenter[i] = y + lh / 2;
      y += lh;
    }
    var cursor = [];
    for (i = 0; i < layers.length; i++) {
      ln = meas[i].line;
      if (cursor[ln] === undefined) cursor[ln] = layout.centerX - (lw[ln] || 0) / 2;
      var baseline = lineCenter[ln] + 0.35 * lineSize[ln];
      var ay = -0.35 * sizes[i]; // anchor at x-height center, so words pop around their middle
      layers[i].property("ADBE Transform Group").property("ADBE Anchor Point").setValue([meas[i].left + meas[i].w / 2, ay]);
      layers[i].property("ADBE Transform Group").property("ADBE Position").setValue([cursor[ln] + meas[i].w / 2, baseline + ay]);
      cursor[ln] += meas[i].w + space;
    }
  }

  /** Effects per word class (0 normal, 1 emphasis). Glow = zero-distance shadow in the class color. */
  function addWordEffects(L, cls, st) {
    var fs = textDoc(L).value.fontSize, list = st.effects[cls];
    function shadow(name, distance, softness) {
      var ds = addEffect(L, "ADBE Drop Shadow", name);
      ds.property("ADBE Drop Shadow-0004").setValue(distance);
      ds.property("ADBE Drop Shadow-0005").setValue(softness);
      return ds;
    }
    if (has(list, "shadow")) shadow("Shadow", fs * 0.05, fs * 0.2);
    if (has(list, "hard-shadow")) shadow("Hard Shadow", fs * 0.07, 0);
    if (has(list, "glow")) {
      shadow("Glow", 0, fs * 0.45).property("ADBE Drop Shadow-0001").expression =
        'comp("' + MAIN + '").layer("' + CONTROLS + '").effect("' + (cls ? "Emphasis Color" : "Normal Color") + '")(1)';
    }
  }

  /** Installed fonts (AE 24+), for the panel's font picker. */
  function listFonts() {
    if (!app.fonts || !app.fonts.allFonts) return [];
    var out = [], fams = app.fonts.allFonts, i, j, f;
    for (i = 0; i < fams.length; i++)
      for (j = 0; j < fams[i].length; j++) {
        f = fams[i][j];
        out.push([f.postScriptName, f.familyName, f.styleName]);
      }
    return out;
  }

  function captionName(cap) {
    var n = "000" + (cap.i + 1), words = [];
    for (var k = 0; k < cap.words.length; k++) words.push(cap.words[k][0]);
    return n.slice(-4) + " " + words.join(" ").slice(0, 40);
  }

  function createCaption(cap) {
    var job = S.job, st = job.style, fps = S.main.frameRate, frame = 1 / fps;
    var dur = Math.max(cap.e - cap.s, frame);
    var pc = app.project.items.addComp(captionName(cap), S.main.width, S.main.height, S.main.pixelAspect, dur, fps);
    pc.parentFolder = S.folder;
    var layers = [], k, w, L, at;
    for (k = 0; k < cap.words.length; k++) {
      w = cap.words[k];
      L = pc.layers.addText(w[0]);
      L.name = w[0];
      styleText(L, st, w[3] ? st.fontSize * st.emphasisSizeMul : st.fontSize, S.fonts[w[3]], ParagraphJustification.LEFT_JUSTIFY, w[3]);
      at = st.reveal === "word" ? w[1] : k * 0.04;
      at = Math.max(0, Math.min(at, dur - frame));
      L.startTime = at;
      L.outPoint = dur;
      // Marker = editable metadata: comment "emph"/"normal" drives styling, duration = spoken time (karaoke).
      var mv = new MarkerValue(w[3] ? "emph" : "normal");
      mv.duration = Math.max(0, Math.min(w[2], dur) - Math.max(0, w[1]));
      L.property("ADBE Marker").setValueAtTime(Math.max(0, Math.min(w[1], dur - frame)), mv);
      layers.push(L);
    }
    place(layers, cap.words, st, job.layout);
    for (k = 0; k < layers.length; k++) {
      L = layers[k];
      setExpr(L, "ADBE Scale", job.expr.scale);
      setExpr(L, "ADBE Opacity", job.expr.opacity);
      setExpr(L, "ADBE Position", job.expr.position);
      addWordAnimator(L, job.expr);
      addWordEffects(L, cap.words[k][3], st);
    }
    S.main.layers.add(pc).startTime = cap.s;
  }

  function createBatch(caps) {
    if (!S) throw new Error("Run was not prepared.");
    app.beginUndoGroup("SubMotion: Generate captions");
    try {
      for (var i = 0; i < caps.length; i++) createCaption(caps[i]);
    } finally {
      app.endUndoGroup();
    }
    return caps.length;
  }

  function finish() {
    if (S) (S.target || S.main).openInViewer();
    S = null;
  }

  /**
   * Premiere Dynamic Link: switch AE to SubMotion's own project file (create it if needed).
   * Never touches a project with unsaved changes.
   */
  function useSubMotionProject(arg) {
    var dir = new Folder(arg.folder || Folder.myDocuments.fsName + "/SubMotion");
    if (!dir.exists && !dir.create()) throw new Error("Cannot create " + dir.fsName);
    var target = new File(dir.fsName + "/" + arg.name + ".aep");
    var cur = app.project.file;
    if (cur && cur.fsName === target.fsName) return target.fsName;
    if (app.project.dirty && (cur || app.project.numItems > 0))
      throw new Error("After Effects has unsaved changes in \"" + (cur ? cur.name : "Untitled Project") +
        "\". Save or close that project in After Effects, then Generate again. SubMotion will not touch it.");
    if (target.exists) app.open(target);
    else {
      if (cur || app.project.numItems > 0) app.newProject();
      app.project.save(target);
    }
    return target.fsName;
  }

  function saveProject() {
    if (!app.project.file) throw new Error("The SubMotion After Effects project has no file.");
    app.project.save();
    return app.project.file.fsName;
  }

  // ---------- Premiere template (.mogrt) ----------

  function addAnimator(L, name, propMatch, value, propExpr, amountExpr) {
    var animators = L.property("ADBE Text Properties").property("ADBE Text Animators");
    var idx = animators.addProperty("ADBE Text Animator").propertyIndex;
    animators.property(idx).name = name;
    var selectors = animators.property(idx).property("ADBE Text Selectors");
    if (amountExpr) {
      var sel = selectors.addProperty("ADBE Text Expressible Selector");
      sel.property("ADBE Text Range Type2").setValue(3); // Based On: Words
      sel.property("ADBE Text Expressible Amount").expression = amountExpr;
    } else {
      selectors.addProperty("ADBE Text Selector");
    }
    var p = animators.property(idx).property("ADBE Text Animator Properties").addProperty(propMatch);
    if (value !== null) p.setValue(value);
    if (propExpr) p.expression = propExpr;
  }

  function dataLayer(comp, name, text) {
    var L = comp.layers.addText(text);
    L.name = name;
    L.guideLayer = true; // never renders
    L.property("ADBE Transform Group").property("ADBE Opacity").setValue(0);
    return L;
  }

  function buildOne(job, tpl) {
    var comp = app.project.items.addComp("SubMotion Caption " + tpl.width + "x" + tpl.height, tpl.width, tpl.height, 1, 10, 30);
    var ex = job.mogrtExpr;
    var ctl = addControls(comp, job.controls, {
      "Size %": 50, "Emphasis Size +%": job.controls.emphasisSizeExtra, "Position Y %": tpl.positionYPct, "Max Width %": tpl.maxWidthPct
    });
    var kw = dataLayer(comp, "SM Keywords", "3");
    var wt = dataLayer(comp, "SM Word Times", "0,0.3,0.6,0.9");
    var cap = comp.layers.addText("SubMotion caption here");
    cap.name = "SM Caption";
    styleText(cap, job.style, tpl.fontSize, resolveFont(comp, [job.style.font].concat(job.style.fallbackFonts || [])), ParagraphJustification.CENTER_JUSTIFY, -1);
    var more = cap.property("ADBE Text Properties").property("ADBE Text More Options");
    more.property("ADBE Text Anchor Point Option").setValue(2); // group by word: words scale around their own center
    more.property("ADBE Text Anchor Point Align").setValue([0, -50]);
    addAnimator(cap, "SM Normal Color", "ADBE Text Fill Color", null, ex.normalColor, null);
    addAnimator(cap, "SM Emphasis Color", "ADBE Text Fill Color", null, ex.emphasisColor, ex.emphasisAmount);
    addAnimator(cap, "SM Active Color", "ADBE Text Fill Color", null, ex.activeColor, ex.activeAmount);
    addAnimator(cap, "SM Emphasis Size", "ADBE Text Scale 3D", [200, 200, 200], null, ex.emphasisSizeAmount);
    addAnimator(cap, "SM Opacity", "ADBE Text Opacity", 0, null, ex.opacityAmount);
    addAnimator(cap, "SM Scale", "ADBE Text Scale 3D", [200, 200, 200], null, ex.scaleAmount);
    addAnimator(cap, "SM Move Y", "ADBE Text Position 3D", [0, 100, 0], null, ex.moveYAmount);
    addAnimator(cap, "SM Move X", "ADBE Text Position 3D", [100, 0, 0], null, ex.moveXAmount);
    addAnimator(cap, "SM Blur", "ADBE Text Blur", [20, 20], null, ex.blurAmount);
    setExpr(cap, "ADBE Anchor Point", ex.anchor);
    setExpr(cap, "ADBE Position", ex.position);
    setExpr(cap, "ADBE Scale", ex.scale);

    comp.openInEssentialGraphics();
    comp.motionGraphicsTemplateName = tpl.file.replace(/\.mogrt$/, ""); // no spaces: export fails silently on them
    function expose(prop, name) {
      if (!prop.canAddToMotionGraphicsTemplate(comp)) throw new Error("Cannot expose \"" + name + "\" in Essential Graphics.");
      prop.addToMotionGraphicsTemplateAs(comp, name);
    }
    expose(textDoc(cap), "Caption");
    expose(textDoc(kw), "Keywords");
    expose(textDoc(wt), "Word Times");
    var fx = ctl.property("ADBE Effect Parade");
    for (var i = 1; i <= fx.numProperties; i++) expose(fx.property(i).property(1), fx.property(i).name);

    // AE takes a destination FOLDER, names the file after motionGraphicsTemplateName, and fails on
    // folders with spaces. It also exports ASYNCHRONOUSLY: it returns (often false) before the file
    // exists. So stage into a space-free temp folder and let the caller wait for the file and copy it.
    var stage = new Folder(Folder.temp.fsName + "/submotion_mogrt");
    if (!stage.exists) stage.create();
    var written = new File(stage.fsName + "/" + comp.motionGraphicsTemplateName + ".mogrt");
    if (written.exists) written.remove();
    // AE only exports from a project without unsaved changes. The caller has confirmed saving;
    // untitled projects never get here (buildTemplate checks).
    var folder = null;
    eachItem(function (it) { if (it instanceof FolderItem && it.name === TEMPLATE_FOLDER) folder = it; });
    comp.parentFolder = folder || app.project.items.addFolder(TEMPLATE_FOLDER);
    if (app.project.dirty) app.project.save();
    // Nothing may touch project objects after this call: references become invalid during export.
    comp.exportAsMotionGraphicsTemplate(true, stage.fsName);
    return { staged: written.fsName, file: tpl.file };
  }

  /**
   * Builds ONE template (arg.template) and starts its export. Returns the staged file path; the
   * caller waits for it to appear (export is asynchronous) and copies it. One per call, because a
   * second export or a save while one is pending can hang After Effects.
   */
  function buildTemplate(arg) {
    if (!app.project.file)
      throw new Error("Save the After Effects project once first: AE only exports templates from a saved project.");
    app.beginUndoGroup("SubMotion: Build Premiere template");
    try {
      return buildOne(arg.job, arg.template);
    } finally {
      app.endUndoGroup();
    }
  }

  // Exposed for the in-app verification script (scripts/verify-ae.jsx); not used by the panel.
  SM.internals = { addControls: addControls, styleText: styleText, addWordAnimator: addWordAnimator, addWordEffects: addWordEffects, setExpr: setExpr };

  SM.host = {
    frameInfo: frameInfo,
    readSourceCaptions: readSourceCaptions,
    mediaSource: mediaSource,
    listFonts: listFonts,
    prepare: prepare,
    createBatch: createBatch,
    finish: finish,
    useSubMotionProject: useSubMotionProject,
    saveProject: saveProject,
    deleteGenerated: function () {
      app.beginUndoGroup("SubMotion: Delete generated");
      try { return deleteGenerated(); } finally { app.endUndoGroup(); }
    },
    buildTemplate: buildTemplate
  };
})();
