// Premiere Pro adapter (ExtendScript, ES3).
// Premiere cannot create animated text from script directly. Two outputs:
//  - Dynamic Link (default): After Effects builds the captions in SubMotion's own .aep (driven over
//    BridgeTalk), Premiere links the "SubMotion Captions" comp and puts it on the timeline.
//  - Template: one SubMotion .mogrt per caption via importMGT, parameters filled in.
(function () {
  var TICKS = 254016000000;
  var PREFIX = "SubMotion_Caption"; // project item name = template name (see TEMPLATES in pipeline.ts)
  var DL_COMP = "SubMotion Captions"; // linked AE comp (project item name starts with it)
  var DL_BIN = "SubMotion";
  var S = null;

  function seq() {
    var s = app.project.activeSequence;
    if (!s) throw new Error("Open a sequence first.");
    return s;
  }

  function frameInfo() {
    var s = app.project.activeSequence;
    if (!s) return { width: 1080, height: 1920, fps: 30, name: "No active sequence" };
    var fps = Math.round((TICKS / Number(s.timebase)) * 1000) / 1000;
    return { width: Number(s.frameSizeHorizontal), height: Number(s.frameSizeVertical), fps: fps, name: s.name };
  }

  function readSourceCaptions() {
    throw new Error(
      "Premiere Pro's scripting APIs cannot read caption tracks yet. Export them with " +
      "File > Export > Captions (SRT) and load the file in SubMotion."
    );
  }

  /** Media file of the selected timeline clip and how its time maps to sequence time (for transcription). */
  function mediaSource() {
    var sel = seq().getSelection(), i, clip;
    for (i = 0; i < sel.length; i++) {
      clip = sel[i];
      if (!clip.projectItem || isOurs(clip)) continue;
      var path = clip.projectItem.getMediaPath();
      if (!path) continue;
      var speed = clip.getSpeed ? clip.getSpeed() : 1;
      if (!(speed > 0) || (clip.isSpeedReversed && clip.isSpeedReversed())) throw new Error("Reversed clips are not supported for transcription.");
      return {
        path: path,
        offset: clip.start.seconds - clip.inPoint.seconds / speed,
        rate: 1 / speed,
        from: clip.start.seconds,
        to: clip.end.seconds
      };
    }
    throw new Error("Select a video or audio clip in the timeline first.");
  }

  function isOurs(clip) {
    try {
      var n = clip.projectItem && clip.projectItem.name;
      return !!n && (n.indexOf(PREFIX) === 0 || n.indexOf(DL_COMP) === 0);
    } catch (e) {
      return false;
    }
  }

  function deleteGenerated() {
    var s = seq(), n = 0, v, c, clips;
    for (v = 0; v < s.videoTracks.numTracks; v++) {
      clips = s.videoTracks[v].clips;
      for (c = clips.numItems - 1; c >= 0; c--) {
        if (isOurs(clips[c])) {
          clips[c].remove(false, false); // no ripple: the rest of the edit never moves
          n++;
        }
      }
    }
    return n;
  }

  /** Lowest video track with nothing on it or above it; adds one (QE DOM) when the top track is used. */
  function freeTrack(s) {
    var top = s.videoTracks.numTracks - 1, t;
    for (t = top; t >= 0 && s.videoTracks[t].clips.numItems === 0; t--) {}
    if (t < top) return t + 1;
    try {
      app.enableQE();
      qe.project.getActiveSequence().addTracks(1, s.videoTracks.numTracks, 0);
    } catch (e) {}
    if (s.videoTracks.numTracks > top + 1) return top + 1;
    throw new Error("No empty video track. Add one above your footage and try again.");
  }

  // ---------- Dynamic Link ----------

  /**
   * Runs SM.call(fn, payload) inside After Effects over BridgeTalk and returns its data.
   * reload: (re)load SubMotion's host scripts in AE first (once per run, keeps run state after).
   */
  function aeCall(arg) {
    if (!BridgeTalk.isRunning("aftereffects") && !BridgeTalk.launch("aftereffects"))
      throw new Error("Could not start After Effects.");
    var bt = new BridgeTalk(), result = null, failure = null, waited = 0, limit = (arg.timeout || 600) * 1000;
    bt.target = "aftereffects";
    // BridgeTalk strips a level of backslashes in both directions, which breaks quoted strings and
    // Windows paths. So the payload and the result travel URL-encoded (no backslashes or quotes).
    var payload = encodeURIComponent(SM.json(arg.payload === undefined ? null : arg.payload));
    bt.body =
      (arg.reload ? "$.evalFile(new File(" + SM.json(arg.main) + "));" :
        "if (!(typeof SM === 'object' && SM.host && SM.host.useSubMotionProject)) $.evalFile(new File(" + SM.json(arg.main) + "));") +
      "encodeURIComponent(SM.call(" + SM.json(arg.fn) + ", eval('(' + decodeURIComponent(\"" + payload + "\") + ')')));";
    bt.onResult = function (r) { result = decodeURIComponent(r.body); };
    bt.onError = function (r) { failure = r.body || "BridgeTalk error"; };
    bt.send();
    while (result === null && failure === null && waited < limit) {
      BridgeTalk.pump();
      $.sleep(50);
      waited += 50;
    }
    if (failure !== null) throw new Error("After Effects: " + failure);
    if (result === null) throw new Error("After Effects did not answer in time (is it busy or showing a dialog?).");
    var res = eval("(" + result + ")");
    if (!res.ok) throw new Error("After Effects: " + String(res.error).replace(/ \(host line \d+\)$/, ""));
    return res.data;
  }

  function findBin(name) {
    var root = app.project.rootItem;
    for (var i = 0; i < root.children.numItems; i++) {
      var it = root.children[i];
      if (it.type === ProjectItemType.BIN && it.name === name) return it;
    }
    return null;
  }

  /** Links the saved AE comp into a fresh "SubMotion" bin and puts it on a free track at 0. */
  function dlPlace(arg) {
    var s = seq();
    deleteGenerated();
    var old = findBin(DL_BIN);
    if (old) old.deleteBin();
    var bin = app.project.rootItem.createBin(DL_BIN);
    if (!app.project.importAEComps(arg.aepPath, [DL_COMP], bin) || bin.children.numItems === 0)
      throw new Error("Premiere could not link \"" + DL_COMP + "\" from " + arg.aepPath);
    var track = freeTrack(s);
    s.videoTracks[track].overwriteClip(bin.children[0], 0);
    return { track: track + 1 };
  }

  function prepare(job) {
    var s = seq();
    if (!new File(job.premiere.templatePath).exists)
      throw new Error(
        "Premiere template not found:\n" + job.premiere.templatePath +
        "\nBuild it once: open SubMotion in After Effects and click \"Build Premiere Template\"."
      );
    deleteGenerated();
    S = { job: job, seq: s, track: freeTrack(s) };
    return { track: S.track + 1 };
  }

  function param(comp, name) {
    var p = comp.properties.getParamForDisplayName(name);
    if (!p) throw new Error("Template parameter \"" + name + "\" is missing. Rebuild the Premiere template in After Effects.");
    return p;
  }

  /** AE text params hold a JSON document; only textEditValue (and per-run arrays) need changing. */
  function setText(p, text, font) {
    var v = null;
    try { v = eval("(" + p.getValue() + ")"); } catch (e) {}
    if (!v || typeof v !== "object" || v.textEditValue === undefined) {
      p.setValue(text, true);
      return;
    }
    v.textEditValue = text;
    for (var k in v) if (v.hasOwnProperty(k) && v[k] instanceof Array && v[k].length > 1) v[k] = [v[k][0]];
    if (v.fontTextRunLength) v.fontTextRunLength = [text.length];
    if (font && v.fontEditValue) v.fontEditValue = [font];
    p.setValue(SM.json(v), true);
  }

  function setColor(p, c) {
    p.setColorValue(255, Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255), true);
  }

  function setMotionScale(clip, scale) {
    if (Math.abs(scale - 100) < 0.01) return;
    for (var i = 0; i < clip.components.numItems; i++) {
      var comp = clip.components[i];
      if (comp.matchName === "AE.ADBE Motion" || comp.displayName === "Motion") {
        comp.properties.getParamForDisplayName("Scale").setValue(scale, true);
        return;
      }
    }
  }

  function createCaption(cap) {
    var job = S.job, ctl = job.controls, pr = job.premiere;
    var clip = S.seq.importMGT(pr.templatePath, String(Math.round(cap.s * TICKS)), S.track, 0);
    if (!clip) throw new Error("importMGT failed at caption " + (cap.i + 1));
    var end = new Time();
    end.seconds = cap.e;
    clip.end = end;
    var mgt = clip.getMGTComponent();
    if (!mgt) throw new Error("Placed clip is not a Motion Graphics Template.");
    setText(param(mgt, "Caption"), cap.text, pr.font);
    setText(param(mgt, "Keywords"), cap.kw || "0", null);
    setText(param(mgt, "Word Times"), cap.times, null);
    // Premiere dropdown params are 0-based; AE dropdown values are 1-based.
    param(mgt, "Animation").setValue(ctl.animation - 1, true);
    param(mgt, "Emphasis Animation").setValue(ctl.emphasisAnimation - 1, true);
    param(mgt, "Animate Emphasis").setValue(!!ctl.animateEmphasis, true);
    param(mgt, "Intensity").setValue(ctl.intensity, true);
    param(mgt, "Emphasis Intensity").setValue(ctl.emphasisIntensity, true);
    param(mgt, "Speed").setValue(ctl.speed, true);
    param(mgt, "Velocity").setValue(ctl.velocity, true);
    param(mgt, "Emphasis Size +%").setValue(ctl.emphasisSizeExtra, true);
    setColor(param(mgt, "Normal Color"), ctl.normalColor);
    setColor(param(mgt, "Emphasis Color"), ctl.emphasisColor);
    setColor(param(mgt, "Active Color"), ctl.activeColor);
    param(mgt, "Active Word Highlight").setValue(!!ctl.activeWordHighlight, true);
    param(mgt, "Size %").setValue(pr.sizePct, true);
    param(mgt, "Position Y %").setValue(pr.positionYPct, true);
    param(mgt, "Max Width %").setValue(job.layout.autoResize ? pr.maxWidthPct : 100, true);
    setMotionScale(clip, pr.motionScale);
  }

  function createBatch(caps) {
    if (!S) throw new Error("Run was not prepared.");
    for (var i = 0; i < caps.length; i++) createCaption(caps[i]);
    return caps.length;
  }

  SM.host = {
    frameInfo: frameInfo,
    readSourceCaptions: readSourceCaptions,
    mediaSource: mediaSource,
    listFonts: function () { return []; }, // Premiere has no font enumeration API
    aeCall: aeCall,
    dlPlace: dlPlace,
    prepare: prepare,
    createBatch: createBatch,
    finish: function () { S = null; },
    deleteGenerated: deleteGenerated,
    buildTemplate: function () { throw new Error("Build the Premiere template from After Effects."); }
  };
})();
