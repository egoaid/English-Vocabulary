/* quiz.js — 実戦トレーニング（Part 80〜）のクイズエンジン
   Kept as a separate file from app.js on purpose: this page's logic (timers,
   scoring, localStorage history, charts, chip-assembly UI) is unrelated to the
   reading-page playback engine, so keeping them apart avoids any risk of the
   two interfering with each other.

   Question types (q.type, default "single"):
     single   4-choice, choices/answer
     multi    choose N of M, choices/answers[]/pick
     order    put sentences in order, items[] (correct order) -> tap/drag chips
     assemble build English from chips (word-order / short writing), chips/answers or branches
   Listening: any question may carry q.listen = {script:[{s,t}], ja} ; the script is spoken
   by the shared speech engine in app.js (speaker names -> male/female voices). */
(function () {
  "use strict";

  var STORAGE_KEY = "quizHistory";
  var MODE_KEY = "quizSlowMode";
  var STATS_MODE_KEY = "quizStatsMode";
  var quizData = null;
  var els = {};

  var state = {
    setId: null, setMeta: null, questions: [], idx: 0, answers: [],
    timerId: null, timeLeft: 0, answered: false, timedOut: false, qStartTime: 0,
    order: [],          /* single/multi: displayed position -> original choice index */
    multiSel: [],       /* multi: selected DISPLAY positions */
    tray: null,         /* order/assemble: {kind, chips[], placed[], sel, branch} */
    slowMode: false,
    statsMode: "timed"
  };

  /* ---------- small helpers ---------- */

  function escapeHtml(str) {
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function loadSlowMode() { return lsGet(MODE_KEY) === "1"; }
  function saveSlowMode(on) { lsSet(MODE_KEY, on ? "1" : "0"); }

  function shuffledOrder(n) {
    var arr = [];
    for (var i = 0; i < n; i++) { arr.push(i); }
    for (var j = n - 1; j > 0; j--) {
      var k = Math.floor(Math.random() * (j + 1));
      var t = arr[j]; arr[j] = arr[k]; arr[k] = t;
    }
    return arr;
  }
  function qType(q) { return q.type || "single"; }
  function qLimit(q, set) { return q.timeLimitSec || set.timeLimitSec; }
  function attemptMode(a) { return a && a.mode === "slow" ? "slow" : "timed"; }   /* records before v1.7.0 had no mode = timed */

  function stopSpeech() {
    try {
      if (window.stopIndividualSpeech) { window.stopIndividualSpeech(); }
      else if (window.speechSynthesis) { window.speechSynthesis.cancel(); }
    } catch (e) { /* ignore */ }
  }

  function getPassage(set, q) {
    if (q && q.passage && set.passages && set.passages[q.passage]) { return set.passages[q.passage]; }
    if (set.passage_en) { return { en: set.passage_en, ja: set.passage_ja, title: "Reading Passage" }; }
    return null;
  }

  function normSentence(s) {
    return String(s).toLowerCase().replace(/[\u2019\u2018]/g, "'").replace(/[^a-z0-9'\s]/g, " ").replace(/\s+/g, " ").trim();
  }
  function splitSentences(text) {
    var m = String(text).match(/[^.!?]+[.!?]*/g) || [];
    return m.map(function (x) { return x.trim(); }).filter(function (x) { return x.length; });
  }
  function countWords(text) {
    return String(text).split(/\s+/).filter(function (w) { return /[A-Za-z0-9]/.test(w); }).length;
  }
  function capitalizeSentences(text) {
    return String(text).replace(/(^|[.!?]\s+)([a-z])/g, function (m, a, b) { return a + b.toUpperCase(); });
  }

  /* ---------- scoring (pure functions; also exercised by the offline test) ---------- */

  function gradeMulti(q, selectedOrigIdx) {
    var want = (q.answers || []).slice().sort().join(",");
    var got = selectedOrigIdx.slice().sort().join(",");
    return want === got;
  }
  function gradeOrder(q, pickedOrigIdx) {
    if (pickedOrigIdx.length !== q.items.length) { return false; }
    for (var i = 0; i < pickedOrigIdx.length; i++) { if (pickedOrigIdx[i] !== i) { return false; } }
    return true;
  }
  /* answers: array of acceptable answers, each an array of sentences. */
  function gradeAssemble(answersList, builtText, minWords) {
    var sents = splitSentences(builtText).map(normSentence);
    var words = countWords(builtText);
    var best = { matches: -1, ans: null, exact: false };
    answersList.forEach(function (ans) {
      var want = ans.map(normSentence);
      var m = 0;
      for (var i = 0; i < want.length; i++) { if (sents[i] === want[i]) { m += 1; } }
      var exact = (m === want.length && sents.length === want.length);
      if (exact || m > best.matches) { if (!best.exact) { best = { matches: m, ans: ans, exact: exact }; } }
    });
    var wordOk = minWords ? words >= minWords : true;
    return { correct: best.exact && wordOk, exact: best.exact, wordOk: wordOk, words: words, sentences: sents, best: best.ans };
  }
  /* exported for the offline test harness */
  window.__quizPure = { gradeMulti: gradeMulti, gradeOrder: gradeOrder, gradeAssemble: gradeAssemble, splitSentences: splitSentences, normSentence: normSentence, countWords: countWords };

  /* ---------- localStorage history ---------- */

  function loadHistory() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
  }
  function saveHistory(hist) { lsSet(STORAGE_KEY, JSON.stringify(hist)); }
  function appendAttempt(record) {
    var hist = loadHistory();
    hist.push(record);
    if (hist.length > 400) { hist = hist.slice(hist.length - 400); }
    saveHistory(hist);
  }
  function bestAccuracyForSet(setId, mode) {
    var hist = loadHistory().filter(function (a) { return a.setId === setId && attemptMode(a) === mode; });
    if (!hist.length) { return null; }
    var best = 0;
    hist.forEach(function (a) {
      var pct = Math.round((a.score / a.total) * 100);
      if (pct > best) { best = pct; }
    });
    return best;
  }

  /* ---------- data loading ---------- */

  function findQuestionById(qId) {
    for (var s = 0; s < quizData.sets.length; s++) {
      var set = quizData.sets[s];
      for (var q = 0; q < set.questions.length; q++) {
        if (set.questions[q].id === qId) { return { question: set.questions[q], set: set }; }
      }
    }
    return null;
  }
  function loadQuizData(cb) {
    fetch("data/quiz.json")
      .then(function (res) { return res.json(); })
      .then(function (data) { quizData = data; cb(); })
      .catch(function (err) {
        els.setGrid.innerHTML = "<p class=\"quiz-load-error\">問題データを読み込めませんでした。ページを再読み込みしてください。</p>";
        console.error("quiz data load failed:", err);
      });
  }

  /* ---------- view switching ---------- */

  function showView(name, noScroll) {
    ["quizViewList", "quizViewQuestion", "quizViewResult", "quizViewStats", "quizViewReview"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) { el.hidden = (id !== name); }
    });
    if (noScroll) { return; }
    var appEl = document.getElementById("quizApp");
    appEl.scrollTop = 0;
    window.scrollTo({ top: appEl.offsetTop - 70, behavior: "smooth" });
  }

  /* ---------- set list ---------- */

  var KIND_LABEL = {
    vocab: ["📝", "語彙・熟語（単文の空所補充）"],
    reading: ["📖", "長文読解"],
    listening: ["🎧", "リスニング（音声はブラウザの読み上げ）"],
    writing: ["✍️", "英作文（チップを並べて組み立てる）"]
  };
  var SECTIONS = [
    { id: "eiken2", domId: "quizGroupEiken", title: "Part 80–82：英検2級レベル 本番形式 実戦問題" },
    { id: "hs", domId: "quizGroupHs", title: "Part 83–85：High School Entrance English 実戦トレーニング" }
  ];

  function bestLine(label, v) {
    return "<span class=\"quiz-set-best" + (v === null ? " quiz-set-best-none" : "") + "\">" + label + "：" + (v === null ? "未挑戦" : v + "%") + "</span>";
  }

  function renderSetList() {
    var grid = els.setGrid;
    grid.innerHTML = "";
    SECTIONS.forEach(function (sec) {
      var sets = quizData.sets.filter(function (s) { return (s.section || "eiken2") === sec.id; });
      if (!sets.length) { return; }
      var h = document.createElement("h3");
      h.className = "quiz-group-title";
      h.id = sec.domId;
      h.textContent = sec.title;
      grid.appendChild(h);
      sets.forEach(function (set) {
        var kind = KIND_LABEL[set.type] || KIND_LABEL.reading;
        var card = document.createElement("button");
        card.type = "button";
        card.className = "quiz-set-card";
        card.innerHTML =
          "<span class=\"quiz-set-icon\">" + kind[0] + "</span>" +
          "<span class=\"quiz-set-title\">Part " + set.id + "：" + escapeHtml(set.title) + "</span>" +
          "<span class=\"quiz-set-meta\">" + kind[1] + " ・ 全" + set.questions.length + "問 ・ " +
          (state.slowMode ? "時間制限なし" : (set.limitLabel || ("1問" + set.timeLimitSec + "秒"))) + "</span>" +
          bestLine("最高正答率（本番モード）", bestAccuracyForSet(set.id, "timed")) +
          bestLine("最高正答率（ゆっくり）", bestAccuracyForSet(set.id, "slow"));
        card.addEventListener("click", function () { startSet(set.id); });
        grid.appendChild(card);
      });
    });
  }

  /* ---------- taking a quiz ---------- */

  function startSet(setId) {
    var set = quizData.sets.filter(function (s) { return s.id === setId; })[0];
    if (!set) { return; }
    state.setId = setId;
    state.setMeta = set;
    state.slowMode = loadSlowMode();
    state.questions = set.questions;
    state.idx = 0;
    state.answers = [];
    showView("quizViewQuestion");
    showQuestion();
  }

  function clearTimer() {
    if (state.timerId !== null) { clearInterval(state.timerId); state.timerId = null; }
  }

  function hideInteraction() {
    els.choices.hidden = true;
    els.choices.innerHTML = "";
    els.multiBar.hidden = true;
    els.tray.hidden = true;
    els.listenBox.hidden = true;
    els.listenScript.classList.remove("is-open");
    els.listenJa.hidden = true;
    els.feedbackDetail.innerHTML = "";
    els.feedbackDetail.hidden = true;
  }

  function showQuestion() {
    clearTimer();
    state.answered = false;
    state.timedOut = false;
    var set = state.setMeta;
    var q = state.questions[state.idx];
    var type = qType(q);

    els.qSetName.textContent = "Part " + set.id + "：" + set.title;
    els.qProgress.textContent = (state.idx + 1) + " / " + state.questions.length;

    var passage = getPassage(set, q);
    if (passage) {
      els.passageBox.hidden = false;
      els.passageHead.textContent = passage.title || "Reading Passage";
      els.passageEn.textContent = passage.en;
      els.passageJa.textContent = passage.ja || "";
      els.passageJa.hidden = true;
      els.passageJaToggle.hidden = !passage.ja;
      els.passageJaToggle.textContent = "日本語訳を見る ▾";
    } else {
      els.passageBox.hidden = true;
    }
    els.qText.innerHTML = q.text;

    els.feedback.hidden = true;
    els.reasonBox.hidden = true;
    els.nextBtn.hidden = true;
    els.lectureBox.hidden = true;
    stopSpeech();
    hideInteraction();

    if (q.listen) { initListening(q); }
    if (type === "multi") { initMulti(q); }
    else if (type === "order" || type === "assemble") { initTray(q, type); }
    else { initSingle(q); }

    var timeReasonBtn = els.reasonBox.querySelector('[data-reason="time"]');
    if (timeReasonBtn) { timeReasonBtn.hidden = state.slowMode; }

    state.qStartTime = Date.now();
    if (state.slowMode) {
      state.timeLeft = 0;
      els.timer.textContent = "🐢 ゆっくりモード";
      els.timer.classList.remove("quiz-timer-urgent");
      return;
    }
    state.timeLeft = qLimit(q, set);
    updateTimerDisplay();
    state.timerId = setInterval(function () {
      state.timeLeft -= 1;
      updateTimerDisplay();
      if (state.timeLeft <= 0) { clearTimer(); handleTimeout(); }
    }, 1000);
  }

  function updateTimerDisplay() {
    els.timer.textContent = "⏱ " + state.timeLeft + "s";
    els.timer.classList.toggle("quiz-timer-urgent", state.timeLeft <= 5);
  }
  function currentQuestion() { return state.questions[state.idx]; }

  /* ---------- listening ---------- */

  function initListening(q) {
    var html = "";
    q.listen.script.forEach(function (ln) {
      html += (ln.s ? "<strong>" + escapeHtml(ln.s) + ":</strong> " : "") + escapeHtml(ln.t) + " ";
    });
    els.listenScript.innerHTML = html;
    els.listenJa.textContent = q.listen.ja || "";
    els.listenNote.textContent = state.slowMode
      ? "何度でも聞けます。聞き取れなければ「ゆっくり」で再生しましょう。"
      : "本番は1回だけ放送されます。練習では何度でも再生できますが、できるだけ1〜2回で答えましょう。";
    els.listenBox.hidden = false;
  }
  function revealListeningScript(q) {
    if (!q.listen) { return; }
    els.listenScript.classList.add("is-open");
    els.listenJa.hidden = !q.listen.ja;
  }

  /* ---------- single ---------- */

  function initSingle(q) {
    state.order = shuffledOrder(q.choices.length);
    els.choices.hidden = false;
    els.choices.innerHTML = "";
    state.order.forEach(function (origIdx, displayPos) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "quiz-choice-btn";
      btn.innerHTML = "<span class=\"quiz-choice-letter\">" + String.fromCharCode(65 + displayPos) + "</span><span>" + escapeHtml(q.choices[origIdx]) + "</span>";
      btn.addEventListener("click", function () { handleSingleAnswer(displayPos); });
      els.choices.appendChild(btn);
    });
  }
  function lockChoiceButtons() {
    Array.prototype.forEach.call(els.choices.querySelectorAll(".quiz-choice-btn"), function (b) { b.disabled = true; });
  }
  function markSingle(q, chosenPos) {
    var correctPos = state.order.indexOf(q.answer);
    Array.prototype.forEach.call(els.choices.querySelectorAll(".quiz-choice-btn"), function (btn, i) {
      if (i === correctPos) { btn.classList.add("quiz-choice-correct"); }
      else if (i === chosenPos) { btn.classList.add("quiz-choice-wrong"); }
    });
  }
  function handleSingleAnswer(chosenPos) {
    if (state.answered) { return; }
    var q = currentQuestion();
    var chosenIdx = state.order[chosenPos];
    var correct = chosenIdx === q.answer;
    lockChoiceButtons();
    markSingle(q, chosenPos);
    finishAnswer(q, correct, { chosenIndex: chosenIdx });
  }

  /* ---------- multi-select ---------- */

  function initMulti(q) {
    state.order = shuffledOrder(q.choices.length);
    state.multiSel = [];
    els.choices.hidden = false;
    els.choices.innerHTML = "";
    state.order.forEach(function (origIdx, displayPos) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "quiz-choice-btn quiz-choice-multi";
      btn.setAttribute("aria-pressed", "false");
      btn.innerHTML = "<span class=\"quiz-choice-letter\">" + String.fromCharCode(65 + displayPos) + "</span><span>" + escapeHtml(q.choices[origIdx]) + "</span>";
      btn.addEventListener("click", function () { toggleMulti(q, displayPos, btn); });
      els.choices.appendChild(btn);
    });
    els.multiBar.hidden = false;
    updateMultiBar(q);
  }
  function toggleMulti(q, pos, btn) {
    if (state.answered) { return; }
    var i = state.multiSel.indexOf(pos);
    if (i >= 0) { state.multiSel.splice(i, 1); }
    else if (state.multiSel.length < q.pick) { state.multiSel.push(pos); }
    btn.classList.toggle("quiz-choice-selected", state.multiSel.indexOf(pos) >= 0);
    btn.setAttribute("aria-pressed", state.multiSel.indexOf(pos) >= 0 ? "true" : "false");
    updateMultiBar(q);
  }
  function updateMultiBar(q) {
    els.multiHint.textContent = q.pick + "つ選んでください（選択中：" + state.multiSel.length + " / " + q.pick + "）";
    els.multiConfirm.disabled = state.multiSel.length !== q.pick;
  }
  function handleMultiConfirm() {
    if (state.answered) { return; }
    var q = currentQuestion();
    if (state.multiSel.length !== q.pick) { return; }
    var chosen = state.multiSel.map(function (p) { return state.order[p]; });
    var correct = gradeMulti(q, chosen);
    markMulti(q);
    finishAnswer(q, correct, { chosen: chosen.slice().sort() });
  }
  function markMulti(q) {
    Array.prototype.forEach.call(els.choices.querySelectorAll(".quiz-choice-btn"), function (btn, pos) {
      btn.disabled = true;
      var orig = state.order[pos];
      var isRight = q.answers.indexOf(orig) >= 0;
      var picked = state.multiSel.indexOf(pos) >= 0;
      if (isRight) { btn.classList.add("quiz-choice-correct"); }
      else if (picked) { btn.classList.add("quiz-choice-wrong"); }
    });
    els.multiBar.hidden = true;
  }

  /* ---------- chip tray (order / assemble) ---------- */

  var JP_LABELS = ["ア", "イ", "ウ", "エ", "オ", "カ"];

  function initTray(q, kind) {
    var tr = { kind: kind, chips: [], placed: [], sel: null, branch: null, drag: null };
    state.tray = tr;
    els.tray.hidden = false;
    els.trayBranch.hidden = true;
    els.trayBranch.innerHTML = "";
    els.trayCount.hidden = true;
    els.trayPreview.hidden = true;

    if (kind === "order") {
      var ord = shuffledOrder(q.items.length);
      ord.forEach(function (orig, pos) {
        tr.chips.push({ id: "c" + orig, orig: orig, text: q.items[orig], label: JP_LABELS[pos] });
      });
      els.trayHint.textContent = "タップして、意味が通る順に並べましょう（上から順番になります）。";
      if (q.lead) { els.trayLead.hidden = false; els.trayLead.innerHTML = "<span class=\"quiz-chip-lead-tag\">最初の文</span> " + escapeHtml(q.lead); }
      else { els.trayLead.hidden = true; }
    } else {
      els.trayLead.hidden = true;
      if (q.branches) {
        els.trayHint.textContent = "まず、どちらについて書くかを選びましょう。選ぶと、使える語句（チップ）が表示されます。";
        els.trayBranch.hidden = false;
        q.branches.forEach(function (br, bi) {
          var b = document.createElement("button");
          b.type = "button";
          b.className = "quiz-btn quiz-btn-secondary quiz-branch-btn";
          b.textContent = br.label;
          b.addEventListener("click", function () {
            if (state.answered) { return; }
            setBranch(q, bi);
            Array.prototype.forEach.call(els.trayBranch.children, function (c, ci) { c.classList.toggle("is-active", ci === bi); });
          });
          els.trayBranch.appendChild(b);
        });
      } else {
        loadAssembleChips(q, q.chips);
        els.trayHint.textContent = "語句（チップ）をタップして、正しい英文に並べましょう。使わないチップもあります。";
      }
      if (q.minWords) { els.trayCount.hidden = false; }
      els.trayPreview.hidden = false;
    }
    renderTray();
  }
  function loadAssembleChips(q, list) {
    var tr = state.tray;
    var ord = shuffledOrder(list.length);
    tr.chips = ord.map(function (i) { return { id: list[i].id, text: list[i].t, label: "" }; });
    tr.placed = [];
    tr.sel = null;
  }
  function setBranch(q, bi) {
    state.tray.branch = bi;
    loadAssembleChips(q, q.branches[bi].chips);
    els.trayHint.textContent = "語句（チップ）をタップして英文を作りましょう。" + (q.minWords ? q.minWords + "語以上になるように。" : "") + "使わないチップもあります。";
    renderTray();
  }

  function chipById(id) {
    var c = state.tray.chips;
    for (var i = 0; i < c.length; i++) { if (c[i].id === id) { return c[i]; } }
    return null;
  }
  function builtText() {
    return state.tray.placed.map(function (id) { return chipById(id).text; }).join(" ");
  }

  function makeChipEl(chip, where) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "quiz-chip quiz-chip-" + where + (state.tray.kind === "order" ? " quiz-chip-sentence" : "");
    b.draggable = !state.answered;
    b.setAttribute("data-id", chip.id);
    b.innerHTML = (chip.label ? "<span class=\"quiz-chip-label\">" + chip.label + "</span>" : "") + "<span class=\"quiz-chip-text\">" + escapeHtml(chip.text) + "</span>";
    b.addEventListener("dragstart", function (e) {
      if (state.answered) { e.preventDefault(); return; }
      state.tray.drag = { id: chip.id, from: where };
      try { e.dataTransfer.setData("text/plain", chip.id); e.dataTransfer.effectAllowed = "move"; } catch (err) { /* ignore */ }
      b.classList.add("is-dragging");
    });
    b.addEventListener("dragend", function () { b.classList.remove("is-dragging"); state.tray.drag = null; });
    return b;
  }

  function renderTray() {
    var tr = state.tray;
    if (!tr) { return; }
    var q = currentQuestion();
    els.trayBank.innerHTML = "";
    els.trayAnswer.innerHTML = "";

    var waitingBranch = tr.kind === "assemble" && q.branches && tr.branch === null;
    els.trayBankWrap.hidden = waitingBranch;
    els.trayAnswerWrap.hidden = waitingBranch;
    els.trayTools.hidden = waitingBranch;
    els.trayConfirm.hidden = waitingBranch;
    if (waitingBranch) { return; }

    tr.chips.forEach(function (chip) {
      if (tr.placed.indexOf(chip.id) >= 0) { return; }
      var el = makeChipEl(chip, "bank");
      el.addEventListener("click", function () {
        if (state.answered) { return; }
        tr.placed.push(chip.id);
        tr.sel = null;
        renderTray();
      });
      els.trayBank.appendChild(el);
    });
    if (!els.trayBank.children.length) {
      var done = document.createElement("span");
      done.className = "quiz-tray-empty";
      done.textContent = "（すべて使いました）";
      els.trayBank.appendChild(done);
    }

    tr.placed.forEach(function (id, i) {
      var chip = chipById(id);
      var el = makeChipEl(chip, "answer");
      if (tr.sel === i) { el.classList.add("is-selected"); }
      el.setAttribute("data-pos", String(i));
      el.addEventListener("click", function () {
        if (state.answered) { return; }
        tr.sel = (tr.sel === i) ? null : i;
        renderTray();
      });
      els.trayAnswer.appendChild(el);
    });
    if (!tr.placed.length) {
      var ph = document.createElement("span");
      ph.className = "quiz-tray-empty";
      ph.textContent = tr.kind === "order" ? "ここに順番に並びます" : "ここに英文ができあがります";
      els.trayAnswer.appendChild(ph);
    }

    /* toolbar */
    var hasSel = tr.sel !== null && !state.answered;
    els.trayLeft.hidden = !hasSel; els.trayRight.hidden = !hasSel; els.trayRemove.hidden = !hasSel;
    els.trayLeft.disabled = !hasSel || tr.sel === 0;
    els.trayRight.disabled = !hasSel || tr.sel === tr.placed.length - 1;
    els.trayUndo.disabled = !tr.placed.length || state.answered;
    els.trayReset.disabled = !tr.placed.length || state.answered;

    if (tr.kind === "assemble") {
      var text = builtText();
      els.trayPreview.textContent = text ? capitalizeSentences(text) : "（ここに文章のプレビューが出ます）";
      if (q.minWords) {
        var w = countWords(text);
        els.trayCount.textContent = "ワード数：" + w + " / " + q.minWords + " 語以上";
        els.trayCount.classList.toggle("is-ok", w >= q.minWords);
      }
      els.trayConfirm.disabled = !tr.placed.length || state.answered;
    } else {
      els.trayConfirm.disabled = tr.placed.length !== tr.chips.length || state.answered;
    }
  }

  function insertionIndex(x, y) {
    var chips = els.trayAnswer.querySelectorAll(".quiz-chip");
    for (var i = 0; i < chips.length; i++) {
      var r = chips[i].getBoundingClientRect();
      if (y < r.top) { return i; }
      if (y <= r.bottom && x < r.left + r.width / 2) { return i; }
    }
    return chips.length;
  }
  function wireTrayDnD() {
    els.trayAnswer.addEventListener("dragover", function (e) { if (state.tray && state.tray.drag) { e.preventDefault(); els.trayAnswer.classList.add("is-over"); } });
    els.trayAnswer.addEventListener("dragleave", function () { els.trayAnswer.classList.remove("is-over"); });
    els.trayAnswer.addEventListener("drop", function (e) {
      e.preventDefault();
      els.trayAnswer.classList.remove("is-over");
      var tr = state.tray;
      if (!tr || !tr.drag || state.answered) { return; }
      var id = tr.drag.id;
      var at = insertionIndex(e.clientX, e.clientY);
      var from = tr.placed.indexOf(id);
      if (from >= 0) { tr.placed.splice(from, 1); if (from < at) { at -= 1; } }
      tr.placed.splice(at, 0, id);
      tr.sel = null;
      renderTray();
    });
    els.trayBank.addEventListener("dragover", function (e) { if (state.tray && state.tray.drag && state.tray.drag.from === "answer") { e.preventDefault(); } });
    els.trayBank.addEventListener("drop", function (e) {
      e.preventDefault();
      var tr = state.tray;
      if (!tr || !tr.drag || state.answered) { return; }
      var from = tr.placed.indexOf(tr.drag.id);
      if (from >= 0) { tr.placed.splice(from, 1); tr.sel = null; renderTray(); }
    });
  }
  function wireTrayButtons() {
    els.trayLeft.addEventListener("click", function () {
      var tr = state.tray; if (tr.sel === null || tr.sel === 0) { return; }
      var t = tr.placed[tr.sel]; tr.placed[tr.sel] = tr.placed[tr.sel - 1]; tr.placed[tr.sel - 1] = t; tr.sel -= 1; renderTray();
    });
    els.trayRight.addEventListener("click", function () {
      var tr = state.tray; if (tr.sel === null || tr.sel >= tr.placed.length - 1) { return; }
      var t = tr.placed[tr.sel]; tr.placed[tr.sel] = tr.placed[tr.sel + 1]; tr.placed[tr.sel + 1] = t; tr.sel += 1; renderTray();
    });
    els.trayRemove.addEventListener("click", function () {
      var tr = state.tray; if (tr.sel === null) { return; }
      tr.placed.splice(tr.sel, 1); tr.sel = null; renderTray();
    });
    els.trayUndo.addEventListener("click", function () { var tr = state.tray; tr.placed.pop(); tr.sel = null; renderTray(); });
    els.trayReset.addEventListener("click", function () { var tr = state.tray; tr.placed = []; tr.sel = null; renderTray(); });
    els.trayConfirm.addEventListener("click", handleTrayConfirm);
  }

  function lockTray() {
    var tr = state.tray;
    if (tr) { tr.sel = null; }
    renderTray();
    els.trayTools.hidden = true;
    els.trayConfirm.hidden = true;
    Array.prototype.forEach.call(els.tray.querySelectorAll(".quiz-chip, .quiz-branch-btn"), function (b) { b.disabled = true; b.draggable = false; });
  }

  function handleTrayConfirm() {
    if (state.answered) { return; }
    var q = currentQuestion();
    var tr = state.tray;
    if (tr.kind === "order") {
      var picked = tr.placed.map(function (id) { return chipById(id).orig; });
      var correct = gradeOrder(q, picked);
      lockTray();
      var seq = picked.map(function (o) { return "<li>" + escapeHtml(q.items[o]) + "</li>"; }).join("");
      var right = q.items.map(function (t) { return "<li>" + escapeHtml(t) + "</li>"; }).join("");
      var detail = "<p class=\"quiz-detail-label\">正しい順番</p><ol class=\"quiz-detail-list\">" + right + "</ol>";
      if (!correct) { detail = "<p class=\"quiz-detail-label\">あなたの順番</p><ol class=\"quiz-detail-list quiz-detail-wrongorder\">" + seq + "</ol>" + detail; }
      finishAnswer(q, correct, { chosen: picked, detailHtml: detail });
    } else {
      var branch = q.branches ? q.branches[tr.branch] : q;
      var text = builtText();
      var res = gradeAssemble(branch.answers, text, q.minWords || 0);
      lockTray();
      finishAnswer(q, res.correct, { chosen: tr.placed.slice(), branch: tr.branch, detailHtml: assembleDetail(q, branch, res, text) });
    }
  }

  function assembleDetail(q, branch, res, text) {
    var html = "<p class=\"quiz-detail-label\">あなたの英文（" + res.words + "語）</p><div class=\"quiz-detail-built\">";
    var sents = splitSentences(capitalizeSentences(text));
    var want = res.best ? res.best.map(normSentence) : [];
    sents.forEach(function (s, i) {
      var ok = res.sentences[i] === want[i];
      html += "<div class=\"quiz-detail-sent " + (ok ? "ok" : "ng") + "\">" + (ok ? "⭕ " : "❌ ") + escapeHtml(s) + "</div>";
    });
    html += "</div>";
    if (q.minWords) { html += "<p class=\"quiz-detail-wc " + (res.wordOk ? "ok" : "ng") + "\">ワード数：" + res.words + "（" + q.minWords + "語以上が条件）" + (res.wordOk ? " ✔" : " ✘") + "</p>"; }
    if (!res.exact) {
      html += "<p class=\"quiz-detail-label\">模範解答の一例</p><div class=\"quiz-detail-model\">" +
        escapeHtml((res.best || branch.answers[0]).join(" ")) + "</div>";
    } else if (branch.answers.length > 1) {
      html += "<p class=\"quiz-detail-note\">この問題には、ほかにも正解の並べ方があります。</p>";
    }
    return html;
  }

  /* ---------- common answer / timeout handling ---------- */

  function renderLecture(q) {
    var paras = Array.isArray(q.lecture) ? q.lecture : (q.lecture ? [q.lecture] : []);
    if (!state.slowMode || !paras.length) { els.lectureBox.hidden = true; return; }
    els.lectureScript.innerHTML = paras.map(function (t) { return "<p>" + escapeHtml(t) + "</p>"; }).join("");
    els.lectureBox.hidden = false;
  }

  function finishAnswer(q, correct, extra) {
    state.answered = true;
    clearTimer();
    var timeSec = Math.round((Date.now() - state.qStartTime) / 1000);
    els.feedback.hidden = false;
    els.feedbackResult.textContent = correct ? "⭕ 正解！" : "❌ 不正解";
    els.feedbackResult.className = "quiz-feedback-result " + (correct ? "quiz-feedback-correct" : "quiz-feedback-wrong");
    els.feedbackExplain.textContent = q.explain || "";
    if (extra.detailHtml) { els.feedbackDetail.innerHTML = extra.detailHtml; els.feedbackDetail.hidden = false; }
    revealListeningScript(q);
    renderLecture(q);

    var record = { qId: q.id, type: qType(q), correct: correct, timeSec: timeSec, reason: null };
    if (extra.chosenIndex !== undefined) { record.chosenIndex = extra.chosenIndex; }
    if (extra.chosen !== undefined) { record.chosen = extra.chosen; }
    if (extra.branch !== undefined) { record.branch = extra.branch; }
    state.answers.push(record);

    if (correct) { els.reasonBox.hidden = true; els.nextBtn.hidden = false; }
    else { els.reasonBox.hidden = false; els.nextBtn.hidden = true; }
  }

  function revealOnTimeout(q) {
    var type = qType(q);
    if (type === "single") { markSingle(q, -1); lockChoiceButtons(); return ""; }
    if (type === "multi") { markMulti(q); return ""; }
    if (type === "order") {
      lockTray();
      return "<p class=\"quiz-detail-label\">正しい順番</p><ol class=\"quiz-detail-list\">" +
        q.items.map(function (t) { return "<li>" + escapeHtml(t) + "</li>"; }).join("") + "</ol>";
    }
    /* assemble */
    var tr = state.tray;
    var branch = q.branches ? q.branches[tr.branch === null ? 0 : tr.branch] : q;
    var text = builtText();
    lockTray();
    var res = gradeAssemble(branch.answers, text, q.minWords || 0);
    return assembleDetail(q, branch, res, text);
  }

  function handleTimeout() {
    if (state.answered) { return; }
    state.answered = true;
    state.timedOut = true;
    var q = currentQuestion();
    var detail = revealOnTimeout(q);
    els.feedback.hidden = false;
    els.feedbackResult.textContent = "⏱ 時間切れ";
    els.feedbackResult.className = "quiz-feedback-result quiz-feedback-wrong";
    els.feedbackExplain.textContent = q.explain || "";
    if (detail) { els.feedbackDetail.innerHTML = detail; els.feedbackDetail.hidden = false; }
    revealListeningScript(q);
    state.answers.push({ qId: q.id, type: qType(q), correct: false, timeSec: qLimit(q, state.setMeta), reason: "time", timedOut: true });
    els.reasonBox.hidden = true;
    els.nextBtn.hidden = false;
  }

  function selectReason(reason) {
    var last = state.answers[state.answers.length - 1];
    if (last) { last.reason = reason; }
    els.reasonBox.hidden = true;
    els.nextBtn.hidden = false;
  }

  function goNext() {
    stopSpeech();
    if (state.idx < state.questions.length - 1) { state.idx += 1; showQuestion(); }
    else { finishSet(); }
  }

  function finishSet() {
    clearTimer();
    stopSpeech();
    var score = state.answers.filter(function (a) { return a.correct; }).length;
    var total = state.questions.length;
    var totalTimeSec = state.answers.reduce(function (sum, a) { return sum + a.timeSec; }, 0);
    var record = {
      setId: state.setId, setTitle: state.setMeta.title, timestamp: Date.now(),
      score: score, total: total, timeUsedSec: totalTimeSec,
      mode: state.slowMode ? "slow" : "timed", answers: state.answers
    };
    appendAttempt(record);
    renderResult(record);
    showView("quizViewResult");
  }

  function renderResult(record) {
    var pct = Math.round((record.score / record.total) * 100);
    els.resultTitle.textContent = "Part " + record.setId + "：" + record.setTitle + " の結果";
    els.resultScore.innerHTML =
      "<div class=\"quiz-score-big\">" + record.score + " / " + record.total + "</div>" +
      "<div class=\"quiz-score-pct\">正答率 " + pct + "%" + (record.mode === "slow" ? " ・ 🐢 ゆっくりモード" : " ・ 所要時間 約" + record.timeUsedSec + "秒") + "</div>";
    els.resultList.innerHTML = "";
    record.answers.forEach(function (a, i) {
      var found = findQuestionById(a.qId);
      var qText = found ? found.question.text.replace(/<[^>]+>/g, "") : a.qId;
      var row = document.createElement("div");
      row.className = "quiz-result-row " + (a.correct ? "quiz-result-row-ok" : "quiz-result-row-ng");
      var reasonLabel = a.reason === "knowledge" ? "知識不足" : a.reason === "misread" ? "読み違い" : a.reason === "time" ? "時間不足" : "";
      row.innerHTML =
        "<span class=\"quiz-result-mark\">" + (a.correct ? "⭕" : "❌") + "</span>" +
        "<span class=\"quiz-result-qtext\">問" + (i + 1) + "：" + escapeHtml(qText.length > 60 ? qText.slice(0, 60) + "…" : qText) + "</span>" +
        (reasonLabel ? "<span class=\"quiz-result-reason\">" + reasonLabel + "</span>" : "");
      els.resultList.appendChild(row);
    });
  }

  /* ---------- stats dashboard (separate for timed / slow) ---------- */

  function histForStats() {
    return loadHistory().filter(function (a) { return attemptMode(a) === state.statsMode; });
  }

  function computeQuestionStats(hist) {
    var map = {};
    hist.forEach(function (attempt) {
      attempt.answers.forEach(function (a) {
        if (!map[a.qId]) { map[a.qId] = { qId: a.qId, attempts: 0, correct: 0, reasons: {} }; }
        map[a.qId].attempts += 1;
        if (a.correct) { map[a.qId].correct += 1; }
        else if (a.reason) { map[a.qId].reasons[a.reason] = (map[a.qId].reasons[a.reason] || 0) + 1; }
      });
    });
    return map;
  }

  function renderStats() {
    Array.prototype.forEach.call(els.statsTabs.querySelectorAll("button"), function (b) {
      b.classList.toggle("is-active", b.getAttribute("data-mode") === state.statsMode);
    });
    var all = loadHistory();
    var hist = histForStats();
    els.statsModeNote.textContent = state.statsMode === "timed"
      ? "制限時間つき（本番モード）で挑戦した記録だけを集計しています。"
      : "ゆっくりモード（時間制限なし・解説講義つき）で挑戦した記録だけを集計しています。";
    if (!all.length) {
      els.statsEmpty.hidden = false; els.statsBody.hidden = true; els.statsTabs.hidden = true; els.statsModeNote.hidden = true;
      return;
    }
    els.statsTabs.hidden = false; els.statsModeNote.hidden = false;
    if (!hist.length) {
      els.statsEmpty.hidden = false;
      els.statsEmpty.textContent = state.statsMode === "timed" ? "このモードの記録はまだありません。" : "ゆっくりモードの記録はまだありません。";
      els.statsBody.hidden = true;
      return;
    }
    els.statsEmpty.hidden = true;
    els.statsBody.hidden = false;

    var totalQ = 0, totalCorrect = 0;
    hist.forEach(function (a) { totalQ += a.total; totalCorrect += a.score; });
    var overallPct = totalQ ? Math.round((totalCorrect / totalQ) * 100) : 0;
    els.statsSummary.innerHTML =
      "<div class=\"quiz-summary-card\"><span class=\"quiz-summary-num\">" + hist.length + "</span><span class=\"quiz-summary-label\">挑戦回数</span></div>" +
      "<div class=\"quiz-summary-card\"><span class=\"quiz-summary-num\">" + overallPct + "%</span><span class=\"quiz-summary-label\">全体正答率</span></div>" +
      "<div class=\"quiz-summary-card\"><span class=\"quiz-summary-num\">" + totalCorrect + "/" + totalQ + "</span><span class=\"quiz-summary-label\">累計正解数</span></div>";
    renderRadar(hist);
    renderTrend(hist);
    renderReasonBreakdown(hist);
    renderReviewList(hist);
  }

  function renderRadar(hist) {
    var sets = quizData.sets;
    var values = sets.map(function (set) {
      var attempts = hist.filter(function (a) { return a.setId === set.id; });
      if (!attempts.length) { return null; }
      var q = 0, c = 0;
      attempts.forEach(function (a) { q += a.total; c += a.score; });
      return Math.round((c / q) * 100);
    });
    var n = sets.length;
    var W = 340, H = 300, cx = W / 2, cy = 150, maxR = 100;
    var pts = [], axisLines = "";
    for (var i = 0; i < n; i++) {
      var angle = (Math.PI * 2 * i) / n - Math.PI / 2;
      var v = values[i] === null ? 0 : values[i];
      var r = (v / 100) * maxR;
      pts.push((cx + r * Math.cos(angle)).toFixed(1) + "," + (cy + r * Math.sin(angle)).toFixed(1));
      axisLines += "<line x1=\"" + cx + "\" y1=\"" + cy + "\" x2=\"" + (cx + maxR * Math.cos(angle)).toFixed(1) + "\" y2=\"" + (cy + maxR * Math.sin(angle)).toFixed(1) + "\" class=\"quiz-radar-axis\"/>";
      var lx = cx + (maxR + 24) * Math.cos(angle);
      var ly = cy + (maxR + 20) * Math.sin(angle);
      var labelText = "P" + sets[i].id + (values[i] === null ? " 未" : " " + values[i] + "%");
      axisLines += "<text x=\"" + lx.toFixed(1) + "\" y=\"" + ly.toFixed(1) + "\" class=\"quiz-radar-label\" text-anchor=\"middle\">" + labelText + "</text>";
    }
    var rings = "";
    [25, 50, 75, 100].forEach(function (pct) {
      var rr = (pct / 100) * maxR, ringPts = [];
      for (var j = 0; j < n; j++) {
        var a2 = (Math.PI * 2 * j) / n - Math.PI / 2;
        ringPts.push((cx + rr * Math.cos(a2)).toFixed(1) + "," + (cy + rr * Math.sin(a2)).toFixed(1));
      }
      rings += "<polygon points=\"" + ringPts.join(" ") + "\" class=\"quiz-radar-ring\"/>";
    });
    els.radarWrap.innerHTML =
      "<svg viewBox=\"0 0 " + W + " " + H + "\" class=\"quiz-radar-svg\" role=\"img\" aria-label=\"Part別正答率レーダーチャート\">" +
      rings + axisLines + "<polygon points=\"" + pts.join(" ") + "\" class=\"quiz-radar-shape\"/></svg>";
  }

  function renderTrend(hist) {
    var recent = hist.slice(-10);
    var w = 320, h = 140, barW = w / recent.length, bars = "";
    recent.forEach(function (a, i) {
      var pct = Math.round((a.score / a.total) * 100);
      var barH = (pct / 100) * (h - 24);
      var x = i * barW + barW * 0.2, y = h - barH - 18;
      var d = new Date(a.timestamp);
      var dateLabel = (d.getMonth() + 1) + "/" + d.getDate();
      bars +=
        "<rect x=\"" + x.toFixed(1) + "\" y=\"" + y.toFixed(1) + "\" width=\"" + (barW * 0.6).toFixed(1) + "\" height=\"" + barH.toFixed(1) + "\" class=\"quiz-trend-bar\"/>" +
        "<text x=\"" + (x + barW * 0.3).toFixed(1) + "\" y=\"" + (h - 4) + "\" class=\"quiz-trend-label\" text-anchor=\"middle\">" + dateLabel + "</text>" +
        "<text x=\"" + (x + barW * 0.3).toFixed(1) + "\" y=\"" + (y - 4).toFixed(1) + "\" class=\"quiz-trend-pct\" text-anchor=\"middle\">" + pct + "%</text>";
    });
    els.trendWrap.innerHTML = "<svg viewBox=\"0 0 " + w + " " + h + "\" class=\"quiz-trend-svg\" role=\"img\" aria-label=\"直近の成績の推移\">" + bars + "</svg>" +
      "<p class=\"quiz-trend-note\">直近" + recent.length + "回分の正答率です。棒が右に行くほど新しい記録です。</p>";
  }

  function renderReasonBreakdown(hist) {
    var totals = { knowledge: 0, misread: 0, time: 0 };
    hist.forEach(function (attempt) {
      attempt.answers.forEach(function (a) {
        if (!a.correct && a.reason && totals.hasOwnProperty(a.reason)) { totals[a.reason] += 1; }
      });
    });
    var sum = totals.knowledge + totals.misread + totals.time;
    var labels = { knowledge: "知識不足（分からなかった）", misread: "読み違い（勘違いした）", time: "時間不足" };
    if (!sum) { els.reasonStatsWrap.innerHTML = "<p class=\"quiz-trend-note\">まだ間違えた問題に理由が記録されていません。</p>"; return; }
    var html = "";
    ["knowledge", "misread", "time"].forEach(function (key) {
      var pct = Math.round((totals[key] / sum) * 100);
      html += "<div class=\"quiz-reason-row\"><span class=\"quiz-reason-row-label\">" + labels[key] + "</span>" +
        "<span class=\"quiz-reason-row-bar-wrap\"><span class=\"quiz-reason-row-bar\" style=\"width:" + pct + "%\"></span></span>" +
        "<span class=\"quiz-reason-row-pct\">" + totals[key] + "件（" + pct + "%）</span></div>";
    });
    els.reasonStatsWrap.innerHTML = html;
  }

  function renderReviewList(hist) {
    var statsMap = computeQuestionStats(hist);
    var rows = Object.keys(statsMap).map(function (qId) { return statsMap[qId]; });
    rows = rows.filter(function (r) { return r.attempts > 0 && r.correct < r.attempts; });
    rows.sort(function (a, b) {
      var accA = a.correct / a.attempts, accB = b.correct / b.attempts;
      if (accA !== accB) { return accA - accB; }
      return (b.reasons.knowledge || 0) - (a.reasons.knowledge || 0);
    });
    if (!rows.length) { els.reviewList.innerHTML = "<p class=\"quiz-trend-note\">今のところ、繰り返し間違えている問題はありません。</p>"; return; }
    els.reviewList.innerHTML = "";
    rows.slice(0, 15).forEach(function (r) {
      var found = findQuestionById(r.qId);
      if (!found) { return; }
      var pct = Math.round((r.correct / r.attempts) * 100);
      var topReason = Object.keys(r.reasons).sort(function (a, b) { return r.reasons[b] - r.reasons[a]; })[0];
      var reasonLabel = topReason === "knowledge" ? "知識不足" : topReason === "misread" ? "読み違い" : topReason === "time" ? "時間不足" : "";
      var qText = found.question.text.replace(/<[^>]+>/g, "");
      var row = document.createElement("div");
      row.className = "quiz-review-row";
      row.innerHTML =
        "<span class=\"quiz-review-pct\">" + pct + "%</span>" +
        "<span class=\"quiz-review-qtext\">Part " + found.set.id + "：" + escapeHtml(qText.length > 50 ? qText.slice(0, 50) + "…" : qText) + "</span>" +
        (reasonLabel ? "<span class=\"quiz-review-reason\">" + reasonLabel + "</span>" : "") +
        "<button class=\"quiz-btn quiz-btn-small\" type=\"button\">復習する</button>";
      row.querySelector("button").addEventListener("click", function () { openReview(r.qId); });
      els.reviewList.appendChild(row);
    });
  }

  function openReview(qId) {
    var found = findQuestionById(qId);
    if (!found) { return; }
    var q = found.question, set = found.set, type = qType(q);
    var passage = getPassage(set, q);
    if (passage) {
      els.reviewPassageBox.hidden = false;
      els.reviewPassageEn.textContent = passage.en;
      els.reviewPassageJa.textContent = passage.ja || "";
    } else { els.reviewPassageBox.hidden = true; }
    els.reviewQuestionText.innerHTML = q.text;
    els.reviewChoices.innerHTML = "";
    var extra = "";
    if (q.listen) {
      extra += "<div class=\"quiz-detail-script\"><p class=\"quiz-detail-label\">放送文（Script）</p><p class=\"quiz-detail-en\">" +
        q.listen.script.map(function (ln) { return (ln.s ? "<strong>" + escapeHtml(ln.s) + ":</strong> " : "") + escapeHtml(ln.t); }).join("<br>") +
        "</p><p class=\"quiz-detail-ja\">" + escapeHtml(q.listen.ja || "") + "</p></div>";
    }
    if (type === "single" || type === "multi") {
      var rightSet = type === "single" ? [q.answer] : q.answers;
      shuffledOrder(q.choices.length).forEach(function (origIdx, displayPos) {
        var div = document.createElement("div");
        div.className = "quiz-choice-btn quiz-choice-static" + (rightSet.indexOf(origIdx) >= 0 ? " quiz-choice-correct" : "");
        div.innerHTML = "<span class=\"quiz-choice-letter\">" + String.fromCharCode(65 + displayPos) + "</span><span>" + escapeHtml(q.choices[origIdx]) + "</span>";
        els.reviewChoices.appendChild(div);
      });
    } else if (type === "order") {
      extra += "<p class=\"quiz-detail-label\">正しい順番</p><ol class=\"quiz-detail-list\">" + q.items.map(function (t) { return "<li>" + escapeHtml(t) + "</li>"; }).join("") + "</ol>";
    } else {
      var brs = q.branches ? q.branches : [{ label: "", answers: q.answers }];
      brs.forEach(function (br) {
        extra += "<p class=\"quiz-detail-label\">模範解答の一例" + (br.label ? "（" + escapeHtml(br.label) + "）" : "") + "</p><div class=\"quiz-detail-model\">" + escapeHtml(br.answers[0].join(" ")) + "</div>";
      });
    }
    els.reviewExtra.innerHTML = extra;
    els.reviewExplain.textContent = q.explain || "";
    showView("quizViewReview");
  }

  /* ---------- wiring ---------- */

  function cacheEls() {
    var ids = {
      setGrid: "quizSetGrid", goStatsBtn: "quizGoStatsBtn",
      qSetName: "quizQSetName", qProgress: "quizQProgress", timer: "quizTimer",
      passageBox: "quizPassageBox", passageHead: "quizPassageHead", passageEn: "quizPassageEn", passageJa: "quizPassageJa",
      passageJaToggle: "quizPassageJaToggle", passageListenBtn: "quizPassageListenBtn",
      listenBox: "quizListenBox", listenScript: "quizListenScript", listenJa: "quizListenJa", listenNote: "quizListenNote",
      qText: "quizQuestionText", choices: "quizChoices",
      multiBar: "quizMultiBar", multiHint: "quizMultiHint", multiConfirm: "quizMultiConfirm",
      tray: "quizTray", trayHint: "quizTrayHint", trayLead: "quizTrayLead", trayBranch: "quizTrayBranch",
      trayBankWrap: "quizTrayBankWrap", trayBank: "quizTrayBank", trayAnswerWrap: "quizTrayAnswerWrap", trayAnswer: "quizTrayAnswer",
      trayCount: "quizTrayCount", trayPreview: "quizTrayPreview", trayTools: "quizTrayTools",
      trayLeft: "quizTrayLeft", trayRight: "quizTrayRight", trayRemove: "quizTrayRemove", trayUndo: "quizTrayUndo", trayReset: "quizTrayReset", trayConfirm: "quizTrayConfirm",
      feedback: "quizFeedback", feedbackResult: "quizFeedbackResult", feedbackExplain: "quizFeedbackExplain", feedbackDetail: "quizFeedbackDetail",
      reasonBox: "quizReasonBox", nextBtn: "quizNextBtn", lectureBox: "quizLectureBox", lectureScript: "quizLectureScript", slowToggle: "quizSlowToggle",
      resultTitle: "quizResultTitle", resultScore: "quizResultScore", resultList: "quizResultList",
      retryBtn: "quizRetryBtn", statsFromResultBtn: "quizStatsFromResultBtn", backFromResultBtn: "quizBackFromResultBtn",
      statsEmpty: "quizStatsEmpty", statsBody: "quizStatsBody", statsSummary: "quizStatsSummary", statsTabs: "quizStatsTabs", statsModeNote: "quizStatsModeNote",
      radarWrap: "quizRadarWrap", trendWrap: "quizTrendWrap", reasonStatsWrap: "quizReasonStatsWrap", reviewList: "quizReviewList", backFromStatsBtn: "quizBackFromStatsBtn",
      reviewBackBtn: "quizReviewBackBtn", reviewPassageBox: "quizReviewPassageBox", reviewPassageEn: "quizReviewPassageEn", reviewPassageJa: "quizReviewPassageJa",
      reviewQuestionText: "quizReviewQuestionText", reviewChoices: "quizReviewChoices", reviewExtra: "quizReviewExtra", reviewExplain: "quizReviewExplain"
    };
    Object.keys(ids).forEach(function (k) { els[k] = document.getElementById(ids[k]); });
  }

  function openStats() { renderStats(); showView("quizViewStats"); }

  function wireEvents() {
    els.slowToggle.checked = loadSlowMode();
    els.slowToggle.addEventListener("change", function () {
      saveSlowMode(els.slowToggle.checked);
      state.slowMode = els.slowToggle.checked;
      renderSetList();
    });
    els.goStatsBtn.addEventListener("click", openStats);
    els.nextBtn.addEventListener("click", goNext);
    els.multiConfirm.addEventListener("click", handleMultiConfirm);
    els.passageJaToggle.addEventListener("click", function () {
      var hidden = els.passageJa.hidden;
      els.passageJa.hidden = !hidden;
      els.passageJaToggle.textContent = hidden ? "日本語訳を隠す ▴" : "日本語訳を見る ▾";
    });
    els.passageListenBtn.addEventListener("click", function () {
      var q = currentQuestion();
      var p = q ? getPassage(state.setMeta, q) : null;
      if (!p) { return; }
      try {
        window.speechSynthesis.cancel();
        var utter = new SpeechSynthesisUtterance(p.en.replace(/\[[^\]]*\]/g, " ").replace(/[\u2022\u00b7]/g, " "));
        utter.lang = "en-US";
        window.speechSynthesis.speak(utter);
      } catch (e) { /* ignore */ }
    });
    Array.prototype.forEach.call(els.reasonBox.querySelectorAll(".quiz-reason-btn"), function (btn) {
      btn.addEventListener("click", function () { selectReason(btn.getAttribute("data-reason")); });
    });
    Array.prototype.forEach.call(els.statsTabs.querySelectorAll("button"), function (btn) {
      btn.addEventListener("click", function () {
        state.statsMode = btn.getAttribute("data-mode");
        lsSet(STATS_MODE_KEY, state.statsMode);
        renderStats();
      });
    });
    els.retryBtn.addEventListener("click", function () { startSet(state.setId); });
    els.statsFromResultBtn.addEventListener("click", function () {
      var last = loadHistory().slice(-1)[0];
      if (last) { state.statsMode = attemptMode(last); }
      openStats();
    });
    els.backFromResultBtn.addEventListener("click", function () { renderSetList(); showView("quizViewList"); });
    els.backFromStatsBtn.addEventListener("click", function () { renderSetList(); showView("quizViewList"); });
    els.reviewBackBtn.addEventListener("click", openStats);
    wireTrayDnD();
    wireTrayButtons();
  }

  document.addEventListener("DOMContentLoaded", function () {
    if (!document.getElementById("quizApp")) { return; }
    cacheEls();
    state.slowMode = loadSlowMode();
    state.statsMode = lsGet(STATS_MODE_KEY) === "slow" ? "slow" : "timed";
    wireEvents();
    loadQuizData(function () {
      renderSetList();
      if (location.hash === "#quizGroupHs") {
        var t = document.getElementById("quizGroupHs");
        if (t) { setTimeout(function () { t.scrollIntoView({ behavior: "smooth", block: "start" }); }, 100); }
      }
    });
  });
})();
