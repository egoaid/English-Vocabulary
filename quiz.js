/* quiz.js — 本番形式 実戦問題（Part 80〜）のクイズエンジン
   Kept as a separate file from app.js on purpose: this page's logic (timers,
   scoring, localStorage history, charts) is unrelated to the reading-page
   playback engine, so keeping them apart avoids any risk of the two
   interfering with each other. */
(function () {
  "use strict";

  var STORAGE_KEY = "quizHistory";
  var quizData = null;
  var els = {};

  var state = {
    setId: null,
    setMeta: null,
    questions: [],
    idx: 0,
    answers: [],
    timerId: null,
    timeLeft: 0,
    answered: false,
    timedOut: false,
    qStartTime: 0,
    order: [],        /* displayed position -> original choice index (reshuffled every time a question opens) */
    slowMode: false   /* ゆっくりモード: no time limit + lecture after answering */
  };

  var MODE_KEY = "quizSlowMode";

  function loadSlowMode() {
    try { return localStorage.getItem(MODE_KEY) === "1"; } catch (e) { return false; }
  }
  function saveSlowMode(on) {
    try { localStorage.setItem(MODE_KEY, on ? "1" : "0"); } catch (e) { /* ignore */ }
  }

  /* Fisher-Yates shuffle of [0..n-1] */
  function shuffledOrder(n) {
    var arr = [];
    for (var i = 0; i < n; i++) { arr.push(i); }
    for (var j = n - 1; j > 0; j--) {
      var k = Math.floor(Math.random() * (j + 1));
      var t = arr[j]; arr[j] = arr[k]; arr[k] = t;
    }
    return arr;
  }

  function stopLectureSpeech() {
    try {
      if (window.stopIndividualSpeech) { window.stopIndividualSpeech(); }
      else if (window.speechSynthesis) { window.speechSynthesis.cancel(); }
    } catch (e) { /* ignore */ }
  }

  function renderLecture(q) {
    var paras = Array.isArray(q.lecture) ? q.lecture : (q.lecture ? [q.lecture] : []);
    if (!state.slowMode || !paras.length) { els.lectureBox.hidden = true; return; }
    els.lectureScript.innerHTML = paras.map(function (t) { return "<p>" + escapeHtml(t) + "</p>"; }).join("");
    els.lectureBox.hidden = false;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* ---------- localStorage history ---------- */

  function loadHistory() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function saveHistory(hist) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(hist));
    } catch (e) {
      /* storage unavailable/full: fail silently, quiz still works this session */
    }
  }

  function appendAttempt(record) {
    var hist = loadHistory();
    hist.push(record);
    /* Keep history from growing without bound; the trend chart only needs
       recent attempts and the per-question stats only need correctness,
       so capping total attempts kept is enough. */
    if (hist.length > 300) {
      hist = hist.slice(hist.length - 300);
    }
    saveHistory(hist);
  }

  function bestAccuracyForSet(setId) {
    var hist = loadHistory().filter(function (a) { return a.setId === setId; });
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
        if (set.questions[q].id === qId) {
          return { question: set.questions[q], set: set };
        }
      }
    }
    return null;
  }

  function loadQuizData(cb) {
    fetch("data/quiz.json")
      .then(function (res) { return res.json(); })
      .then(function (data) {
        quizData = data;
        cb();
      })
      .catch(function (err) {
        els.setGrid.innerHTML = "<p class=\"quiz-load-error\">問題データを読み込めませんでした。ページを再読み込みしてください。</p>";
        console.error("quiz data load failed:", err);
      });
  }

  /* ---------- view switching ---------- */

  function showView(name) {
    ["quizViewList", "quizViewQuestion", "quizViewResult", "quizViewStats", "quizViewReview"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) { el.hidden = (id !== name); }
    });
    var appEl = document.getElementById("quizApp");
    appEl.scrollTop = 0; /* mobile: the quiz area itself is the scroll container */
    window.scrollTo({ top: appEl.offsetTop - 70, behavior: "smooth" });
  }

  /* ---------- set list ---------- */

  function renderSetList() {
    var grid = els.setGrid;
    grid.innerHTML = "";
    quizData.sets.forEach(function (set) {
      var best = bestAccuracyForSet(set.id);
      var icon = set.type === "vocab" ? "📝" : "📖";
      var typeLabel = set.type === "vocab" ? "語彙・熟語（単文の空所補充）" : "長文読解";
      var card = document.createElement("button");
      card.type = "button";
      card.className = "quiz-set-card";
      card.innerHTML =
        "<span class=\"quiz-set-icon\">" + icon + "</span>" +
        "<span class=\"quiz-set-title\">Part " + set.id + "：" + escapeHtml(set.title) + "</span>" +
        "<span class=\"quiz-set-meta\">" + typeLabel + " ・ 全" + set.questions.length + "問 ・ " + (state.slowMode ? "時間制限なし" : "1問" + set.timeLimitSec + "秒") + "</span>" +
        (best === null
          ? "<span class=\"quiz-set-best quiz-set-best-none\">未挑戦</span>"
          : "<span class=\"quiz-set-best\">これまでの最高正答率：" + best + "%</span>");
      card.addEventListener("click", function () { startSet(set.id); });
      grid.appendChild(card);
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
    if (state.timerId !== null) {
      clearInterval(state.timerId);
      state.timerId = null;
    }
  }

  function showQuestion() {
    clearTimer();
    state.answered = false;
    state.timedOut = false;
    var set = state.setMeta;
    var q = state.questions[state.idx];

    els.qSetName.textContent = "Part " + set.id + "：" + set.title;
    els.qProgress.textContent = (state.idx + 1) + " / " + state.questions.length;

    if (set.type === "reading") {
      els.passageBox.hidden = false;
      els.passageEn.textContent = set.passage_en;
      els.passageJa.textContent = set.passage_ja;
      els.passageJa.hidden = true;
      els.passageJaToggle.textContent = "日本語訳を見る ▾";
      els.qText.innerHTML = q.text;
    } else {
      els.passageBox.hidden = true;
      els.qText.innerHTML = q.text;
    }

    /* Reshuffle A-D every time a question is opened so the correct answer
       is not always in the same position. state.order[displayPos] = original index. */
    state.order = shuffledOrder(q.choices.length);
    els.choices.innerHTML = "";
    state.order.forEach(function (origIdx, displayPos) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "quiz-choice-btn";
      btn.innerHTML = "<span class=\"quiz-choice-letter\">" + String.fromCharCode(65 + displayPos) + "</span><span>" + escapeHtml(q.choices[origIdx]) + "</span>";
      btn.addEventListener("click", function () { handleAnswer(displayPos); });
      els.choices.appendChild(btn);
    });

    els.feedback.hidden = true;
    els.reasonBox.hidden = true;
    els.nextBtn.hidden = true;
    els.lectureBox.hidden = true;
    stopLectureSpeech();

    /* ゆっくりモード: no countdown, and the "time ran short" reason is not offered. */
    var timeReasonBtn = els.reasonBox.querySelector('[data-reason="time"]');
    if (timeReasonBtn) { timeReasonBtn.hidden = state.slowMode; }

    state.qStartTime = Date.now();
    if (state.slowMode) {
      state.timeLeft = 0;
      els.timer.textContent = "🐢 ゆっくりモード";
      els.timer.classList.remove("quiz-timer-urgent");
      return;
    }
    state.timeLeft = set.timeLimitSec;
    updateTimerDisplay();
    state.timerId = setInterval(function () {
      state.timeLeft -= 1;
      updateTimerDisplay();
      if (state.timeLeft <= 0) {
        clearTimer();
        handleTimeout();
      }
    }, 1000);
  }

  function updateTimerDisplay() {
    els.timer.textContent = "⏱ " + state.timeLeft + "s";
    els.timer.classList.toggle("quiz-timer-urgent", state.timeLeft <= 5);
  }

  function currentQuestion() {
    return state.questions[state.idx];
  }

  function lockChoiceButtons() {
    Array.prototype.forEach.call(els.choices.querySelectorAll(".quiz-choice-btn"), function (btn) {
      btn.disabled = true;
    });
  }

  /* chosenPos / correct highlight use DISPLAYED positions (after shuffling). */
  function markChoiceButtons(q, chosenPos) {
    var correctPos = state.order.indexOf(q.answer);
    Array.prototype.forEach.call(els.choices.querySelectorAll(".quiz-choice-btn"), function (btn, i) {
      if (i === correctPos) { btn.classList.add("quiz-choice-correct"); }
      else if (i === chosenPos) { btn.classList.add("quiz-choice-wrong"); }
    });
  }

  function handleAnswer(chosenPos) {
    if (state.answered) { return; }
    state.answered = true;
    clearTimer();
    lockChoiceButtons();
    var q = currentQuestion();
    var chosenIdx = state.order[chosenPos];   /* original index, so stored history is shuffle-independent */
    var correct = chosenIdx === q.answer;
    var timeSec = Math.round((Date.now() - state.qStartTime) / 1000);
    markChoiceButtons(q, chosenPos);
    els.feedback.hidden = false;
    els.feedbackResult.textContent = correct ? "⭕ 正解！" : "❌ 不正解";
    els.feedbackResult.className = "quiz-feedback-result " + (correct ? "quiz-feedback-correct" : "quiz-feedback-wrong");
    els.feedbackExplain.textContent = q.explain || "";
    renderLecture(q);

    var record = { qId: q.id, correct: correct, chosenIndex: chosenIdx, timeSec: timeSec, reason: null };
    state.answers.push(record);

    if (correct) {
      els.reasonBox.hidden = true;
      els.nextBtn.hidden = false;
    } else {
      els.reasonBox.hidden = false;
      els.nextBtn.hidden = true;
    }
  }

  function handleTimeout() {
    if (state.answered) { return; }
    state.answered = true;
    state.timedOut = true;
    lockChoiceButtons();
    var q = currentQuestion();
    markChoiceButtons(q, -1);
    els.feedback.hidden = false;
    els.feedbackResult.textContent = "⏱ 時間切れ";
    els.feedbackResult.className = "quiz-feedback-result quiz-feedback-wrong";
    els.feedbackExplain.textContent = q.explain || "";
    state.answers.push({ qId: q.id, correct: false, chosenIndex: -1, timeSec: state.setMeta.timeLimitSec, reason: "time" });
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
    stopLectureSpeech();
    if (state.idx < state.questions.length - 1) {
      state.idx += 1;
      showQuestion();
    } else {
      finishSet();
    }
  }

  function finishSet() {
    clearTimer();
    stopLectureSpeech();
    var score = state.answers.filter(function (a) { return a.correct; }).length;
    var total = state.questions.length;
    var totalTimeSec = state.answers.reduce(function (sum, a) { return sum + a.timeSec; }, 0);
    var record = {
      setId: state.setId,
      setTitle: state.setMeta.title,
      timestamp: Date.now(),
      score: score,
      total: total,
      timeUsedSec: totalTimeSec,
      mode: state.slowMode ? "slow" : "timed",
      answers: state.answers
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

  /* ---------- stats dashboard ---------- */

  function computeQuestionStats() {
    /* Per-question aggregate across ALL history: total attempts, correct
       count, and reasons recorded for the wrong attempts. */
    var hist = loadHistory();
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
    var hist = loadHistory();
    if (!hist.length) {
      els.statsEmpty.hidden = false;
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
    renderReviewList();
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
    var size = 260, cx = size / 2, cy = size / 2, maxR = 95;
    var pts = [];
    var axisLines = "";
    var labels = "";
    for (var i = 0; i < n; i++) {
      var angle = (Math.PI * 2 * i) / n - Math.PI / 2;
      var v = values[i] === null ? 0 : values[i];
      var r = (v / 100) * maxR;
      var x = cx + r * Math.cos(angle);
      var y = cy + r * Math.sin(angle);
      pts.push(x.toFixed(1) + "," + y.toFixed(1));
      var ax = cx + maxR * Math.cos(angle);
      var ay = cy + maxR * Math.sin(angle);
      axisLines += "<line x1=\"" + cx + "\" y1=\"" + cy + "\" x2=\"" + ax.toFixed(1) + "\" y2=\"" + ay.toFixed(1) + "\" class=\"quiz-radar-axis\"/>";
      var lx = cx + (maxR + 22) * Math.cos(angle);
      var ly = cy + (maxR + 22) * Math.sin(angle);
      var labelText = "Part" + sets[i].id + (values[i] === null ? "（未）" : "（" + values[i] + "%）");
      axisLines += "<text x=\"" + lx.toFixed(1) + "\" y=\"" + ly.toFixed(1) + "\" class=\"quiz-radar-label\" text-anchor=\"middle\">" + labelText + "</text>";
    }
    var rings = "";
    [25, 50, 75, 100].forEach(function (pct) {
      var rr = (pct / 100) * maxR;
      var ringPts = [];
      for (var j = 0; j < n; j++) {
        var a2 = (Math.PI * 2 * j) / n - Math.PI / 2;
        ringPts.push((cx + rr * Math.cos(a2)).toFixed(1) + "," + (cy + rr * Math.sin(a2)).toFixed(1));
      }
      rings += "<polygon points=\"" + ringPts.join(" ") + "\" class=\"quiz-radar-ring\"/>";
    });

    var svg =
      "<svg viewBox=\"0 0 " + size + " " + (size + 20) + "\" class=\"quiz-radar-svg\" role=\"img\" aria-label=\"Part別正答率レーダーチャート\">" +
      rings + axisLines +
      "<polygon points=\"" + pts.join(" ") + "\" class=\"quiz-radar-shape\"/>" +
      "</svg>";
    els.radarWrap.innerHTML = svg;
  }

  function renderTrend(hist) {
    var recent = hist.slice(-10);
    var w = 320, h = 140, barW = w / recent.length;
    var bars = "";
    recent.forEach(function (a, i) {
      var pct = Math.round((a.score / a.total) * 100);
      var barH = (pct / 100) * (h - 24);
      var x = i * barW + barW * 0.2;
      var y = h - barH - 18;
      var d = new Date(a.timestamp);
      var dateLabel = (d.getMonth() + 1) + "/" + d.getDate();
      bars +=
        "<rect x=\"" + x.toFixed(1) + "\" y=\"" + y.toFixed(1) + "\" width=\"" + (barW * 0.6).toFixed(1) + "\" height=\"" + barH.toFixed(1) + "\" class=\"quiz-trend-bar\"/>" +
        "<text x=\"" + (x + barW * 0.3).toFixed(1) + "\" y=\"" + (h - 4) + "\" class=\"quiz-trend-label\" text-anchor=\"middle\">" + dateLabel + "</text>" +
        "<text x=\"" + (x + barW * 0.3).toFixed(1) + "\" y=\"" + (y - 4).toFixed(1) + "\" class=\"quiz-trend-pct\" text-anchor=\"middle\">" + pct + "%</text>";
    });
    var svg = "<svg viewBox=\"0 0 " + w + " " + h + "\" class=\"quiz-trend-svg\" role=\"img\" aria-label=\"直近の成績の推移\">" + bars + "</svg>";
    els.trendWrap.innerHTML = svg + "<p class=\"quiz-trend-note\">直近" + recent.length + "回分の正答率です。棒が右に行くほど新しい記録です。</p>";
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
    if (!sum) {
      els.reasonStatsWrap.innerHTML = "<p class=\"quiz-trend-note\">まだ間違えた問題に理由が記録されていません。</p>";
      return;
    }
    var html = "";
    ["knowledge", "misread", "time"].forEach(function (key) {
      var pct = Math.round((totals[key] / sum) * 100);
      html +=
        "<div class=\"quiz-reason-row\">" +
        "<span class=\"quiz-reason-row-label\">" + labels[key] + "</span>" +
        "<span class=\"quiz-reason-row-bar-wrap\"><span class=\"quiz-reason-row-bar\" style=\"width:" + pct + "%\"></span></span>" +
        "<span class=\"quiz-reason-row-pct\">" + totals[key] + "件（" + pct + "%）</span>" +
        "</div>";
    });
    els.reasonStatsWrap.innerHTML = html;
  }

  function renderReviewList() {
    var statsMap = computeQuestionStats();
    var rows = Object.keys(statsMap).map(function (qId) { return statsMap[qId]; });
    rows = rows.filter(function (r) { return r.attempts > 0 && r.correct < r.attempts; });
    rows.sort(function (a, b) {
      var accA = a.correct / a.attempts, accB = b.correct / b.attempts;
      if (accA !== accB) { return accA - accB; }
      /* Among equally-low accuracy, prioritize ones tagged "knowledge gap" over misread/time. */
      var ka = a.reasons.knowledge || 0, kb = b.reasons.knowledge || 0;
      return kb - ka;
    });

    if (!rows.length) {
      els.reviewList.innerHTML = "<p class=\"quiz-trend-note\">今のところ、繰り返し間違えている問題はありません。</p>";
      return;
    }

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
    var q = found.question, set = found.set;
    if (set.type === "reading") {
      els.reviewPassageBox.hidden = false;
      els.reviewPassageEn.textContent = set.passage_en;
      els.reviewPassageJa.textContent = set.passage_ja;
    } else {
      els.reviewPassageBox.hidden = true;
    }
    els.reviewQuestionText.innerHTML = q.text;
    els.reviewChoices.innerHTML = "";
    shuffledOrder(q.choices.length).forEach(function (origIdx, displayPos) {
      var div = document.createElement("div");
      div.className = "quiz-choice-btn quiz-choice-static" + (origIdx === q.answer ? " quiz-choice-correct" : "");
      div.innerHTML = "<span class=\"quiz-choice-letter\">" + String.fromCharCode(65 + displayPos) + "</span><span>" + escapeHtml(q.choices[origIdx]) + "</span>";
      els.reviewChoices.appendChild(div);
    });
    els.reviewExplain.textContent = q.explain || "";
    showView("quizViewReview");
  }

  /* ---------- wiring ---------- */

  function cacheEls() {
    els.setGrid = document.getElementById("quizSetGrid");
    els.goStatsBtn = document.getElementById("quizGoStatsBtn");

    els.qSetName = document.getElementById("quizQSetName");
    els.qProgress = document.getElementById("quizQProgress");
    els.timer = document.getElementById("quizTimer");
    els.passageBox = document.getElementById("quizPassageBox");
    els.passageEn = document.getElementById("quizPassageEn");
    els.passageJa = document.getElementById("quizPassageJa");
    els.passageJaToggle = document.getElementById("quizPassageJaToggle");
    els.passageListenBtn = document.getElementById("quizPassageListenBtn");
    els.qText = document.getElementById("quizQuestionText");
    els.choices = document.getElementById("quizChoices");
    els.feedback = document.getElementById("quizFeedback");
    els.feedbackResult = document.getElementById("quizFeedbackResult");
    els.feedbackExplain = document.getElementById("quizFeedbackExplain");
    els.reasonBox = document.getElementById("quizReasonBox");
    els.nextBtn = document.getElementById("quizNextBtn");
    els.lectureBox = document.getElementById("quizLectureBox");
    els.lectureScript = document.getElementById("quizLectureScript");
    els.slowToggle = document.getElementById("quizSlowToggle");

    els.resultTitle = document.getElementById("quizResultTitle");
    els.resultScore = document.getElementById("quizResultScore");
    els.resultList = document.getElementById("quizResultList");
    els.retryBtn = document.getElementById("quizRetryBtn");
    els.statsFromResultBtn = document.getElementById("quizStatsFromResultBtn");
    els.backFromResultBtn = document.getElementById("quizBackFromResultBtn");

    els.statsEmpty = document.getElementById("quizStatsEmpty");
    els.statsBody = document.getElementById("quizStatsBody");
    els.statsSummary = document.getElementById("quizStatsSummary");
    els.radarWrap = document.getElementById("quizRadarWrap");
    els.trendWrap = document.getElementById("quizTrendWrap");
    els.reasonStatsWrap = document.getElementById("quizReasonStatsWrap");
    els.reviewList = document.getElementById("quizReviewList");
    els.backFromStatsBtn = document.getElementById("quizBackFromStatsBtn");

    els.reviewBackBtn = document.getElementById("quizReviewBackBtn");
    els.reviewPassageBox = document.getElementById("quizReviewPassageBox");
    els.reviewPassageEn = document.getElementById("quizReviewPassageEn");
    els.reviewPassageJa = document.getElementById("quizReviewPassageJa");
    els.reviewQuestionText = document.getElementById("quizReviewQuestionText");
    els.reviewChoices = document.getElementById("quizReviewChoices");
    els.reviewExplain = document.getElementById("quizReviewExplain");
  }

  function wireEvents() {
    els.slowToggle.checked = loadSlowMode();
    els.slowToggle.addEventListener("change", function () {
      saveSlowMode(els.slowToggle.checked);
      state.slowMode = els.slowToggle.checked;
      renderSetList();
    });
    els.goStatsBtn.addEventListener("click", function () { renderStats(); showView("quizViewStats"); });
    els.nextBtn.addEventListener("click", goNext);
    els.passageJaToggle.addEventListener("click", function () {
      var hidden = els.passageJa.hidden;
      els.passageJa.hidden = !hidden;
      els.passageJaToggle.textContent = hidden ? "日本語訳を隠す ▴" : "日本語訳を見る ▾";
    });
    els.passageListenBtn.addEventListener("click", function () {
      if (window.speakText) {
        /* Reuse the same speech engine as the reading pages by speaking the
           passage text directly (this page's passage text isn't inside a
           DOM element with a stable id the way reading pages' paragraphs
           are, so we synthesize a one-off utterance instead of calling
           speakText(id, lang), which expects an existing element id). */
        try {
          window.speechSynthesis.cancel();
          var utter = new SpeechSynthesisUtterance(state.setMeta.passage_en);
          utter.lang = "en-US";
          window.speechSynthesis.speak(utter);
        } catch (e) { /* ignore */ }
      }
    });
    Array.prototype.forEach.call(els.reasonBox.querySelectorAll(".quiz-reason-btn"), function (btn) {
      btn.addEventListener("click", function () { selectReason(btn.getAttribute("data-reason")); });
    });
    els.retryBtn.addEventListener("click", function () { startSet(state.setId); });
    els.statsFromResultBtn.addEventListener("click", function () { renderStats(); showView("quizViewStats"); });
    els.backFromResultBtn.addEventListener("click", function () { renderSetList(); showView("quizViewList"); });
    els.backFromStatsBtn.addEventListener("click", function () { renderSetList(); showView("quizViewList"); });
    els.reviewBackBtn.addEventListener("click", function () { renderStats(); showView("quizViewStats"); });
  }

  document.addEventListener("DOMContentLoaded", function () {
    if (!document.getElementById("quizApp")) { return; }
    cacheEls();
    state.slowMode = loadSlowMode();
    wireEvents();
    loadQuizData(function () {
      renderSetList();
    });
  });
})();
