
(function () {
  "use strict";

  /* ---------- Text-to-speech: shared state ---------- */
  var ttsRateNormal = parseFloat(localStorage.getItem('ttsRateNormal')) || 0.92;
  var ttsRateSlow = parseFloat(localStorage.getItem('ttsRateSlow')) || 0.6;
  var ttsRateFullscreen = parseFloat(localStorage.getItem('ttsRateFullscreen')) || 0.50;
  var ttsRateFlashcard = parseFloat(localStorage.getItem('ttsRateFlashcard')) || 0.85;

  function escapeHtmlText(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* Phones need smaller fullscreen text and smaller per-screen text chunks than
     desktop/tablet -- otherwise a paragraph sized for a wall-mounted display
     overflows the narrow viewport and effectively never becomes visible. */
  function isMobileViewport() {
    return window.matchMedia && window.matchMedia('(max-width: 700px)').matches;
  }

  /* ---------- Dialogue-aware voice selection (male/female by speaker) ---------- */
  var maleVoicePool = [];
  var femaleVoicePool = [];
  var neutralVoicePool = [];
  var speakerVoiceCache = {};
  var speakerAltCounter = {};

  var MALE_NAME_HINTS = ['riku', 'kenta', 'tom', 'sota', 'kevin', 'mike', 'peter', 'ito',
    'hiroto', 'shota', 'david', 'andy', 'ken', 'james', 'ryan', 'george'];
  var FEMALE_NAME_HINTS = ['emma', 'sara', 'aya', 'mio', 'sakura', 'hana', 'anna', 'rika',
    'rina', 'yui', 'amy', 'nancy', 'hanako', 'hara', 'claire', 'jill', 'wakako', 'momi'];

  function detectGenderFromName(name) {
    if (!name) { return null; }
    var n = name.toLowerCase().trim();
    if (/^(mr\.?|mister)\b/.test(n)) { return 'male'; }
    if (/^(ms\.?|mrs\.?|miss)\b/.test(n)) { return 'female'; }
    var last = n.replace(/^(mr|ms|mrs|miss|dr)\.?\s*/, '').split(/\s+/).pop();
    if (MALE_NAME_HINTS.indexOf(last) !== -1) { return 'male'; }
    if (FEMALE_NAME_HINTS.indexOf(last) !== -1) { return 'female'; }
    return null;
  }

  function initVoicePools() {
    if (!('speechSynthesis' in window)) { return; }
    var voices = window.speechSynthesis.getVoices().filter(function (v) {
      return v.lang && v.lang.toLowerCase().indexOf('en') === 0;
    });
    if (!voices.length) { return; }
    neutralVoicePool = voices;
    var maleRe = /\b(male|david|mark|guy|daniel|alex|fred|james|george|oliver|ryan|matthew|thomas|tom|arthur|eric)\b/i;
    var femaleRe = /\b(female|zira|samantha|victoria|karen|moira|tessa|fiona|susan|kate|serena|aria|jenny|emma|amy|joanna|salli|kimberly|allison|ava)\b/i;
    var m = [], f = [];
    for (var i = 0; i < voices.length; i++) {
      if (maleRe.test(voices[i].name)) { m.push(voices[i]); }
      else if (femaleRe.test(voices[i].name)) { f.push(voices[i]); }
    }
    if (!m.length && !f.length && voices.length >= 2) {
      m = [voices[0]];
      f = [voices[voices.length - 1]];
    } else if (!m.length) {
      m = f.length ? f.slice(0, 1) : voices.slice(0, 1);
    } else if (!f.length) {
      f = m.length ? m.slice(0, 1) : voices.slice(0, 1);
    }
    maleVoicePool = m;
    femaleVoicePool = f;
  }

  if ('speechSynthesis' in window) {
    initVoicePools();
    window.speechSynthesis.onvoiceschanged = initVoicePools;
  }

  function getVoiceForSpeaker(partId, name) {
    if (!name) { return null; }
    var key = partId + '::' + name;
    if (speakerVoiceCache.hasOwnProperty(key)) { return speakerVoiceCache[key]; }
    var gender = detectGenderFromName(name);
    var pool;
    if (gender === 'male') {
      pool = maleVoicePool.length ? maleVoicePool : neutralVoicePool;
    } else if (gender === 'female') {
      pool = femaleVoicePool.length ? femaleVoicePool : neutralVoicePool;
    } else {
      speakerAltCounter[partId] = speakerAltCounter[partId] || 0;
      var idx = speakerAltCounter[partId]++;
      pool = (idx % 2 === 0)
        ? (maleVoicePool.length ? maleVoicePool : neutralVoicePool)
        : (femaleVoicePool.length ? femaleVoicePool : neutralVoicePool);
    }
    var voice = (pool && pool.length) ? pool[0] : null;
    speakerVoiceCache[key] = voice;
    return voice;
  }

  /* Parses a paragraph element for "<strong>Name:</strong> turn text" dialogue markers.
     Returns [{speaker, text}, ...], or a single {speaker:null, text: fullText} entry
     when no dialogue structure is present (the vast majority of paragraphs). */
  function parseSpeakerSegments(el) {
    var nodes = Array.prototype.slice.call(el.childNodes);
    var segments = [];
    var current = null;
    var preText = '';
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.nodeType === 1 && node.tagName === 'STRONG') {
        var label = (node.textContent || '').trim();
        if (/[:：]$/.test(label) && label.length <= 20) {
          if (current) { segments.push(current); }
          current = { speaker: label.replace(/[:：]$/, '').trim(), text: '' };
          continue;
        }
      }
      var piece = node.textContent || '';
      if (current) { current.text += piece; } else { preText += piece; }
    }
    if (current) { segments.push(current); }
    if (!segments.length) {
      return [{ speaker: null, text: (el.innerText || el.textContent || preText || '').trim() }];
    }
    return segments;
  }

  /* Combines the English and Japanese speaker segments of one paragraph into aligned turns.
     Falls back to a single whole-paragraph entry if the two sides don't line up. */
  function buildParagraphTurns(pair) {
    var enEl = pair.querySelector('.english');
    var jaEl = pair.querySelector('.translation');
    if (!enEl) { return []; }
    var enSegs = parseSpeakerSegments(enEl);
    var jaSegs = jaEl ? parseSpeakerSegments(jaEl) : [{ speaker: null, text: '' }];
    if (enSegs.length > 1 && enSegs.length === jaSegs.length) {
      var out = [];
      for (var i = 0; i < enSegs.length; i++) {
        out.push({
          enText: enSegs[i].text.trim(),
          jaText: (jaSegs[i] && jaSegs[i].text ? jaSegs[i].text : '').trim(),
          speaker: enSegs[i].speaker
        });
      }
      return out;
    }
    return [{
      enText: enEl.innerText || enEl.textContent || '',
      jaText: jaEl ? (jaEl.innerText || jaEl.textContent || '') : '',
      speaker: null
    }];
  }

  /* ---------- Word / screen splitting for the fullscreen display (avoids any scrollbar) ---------- */
  function computeWordRanges(text) {
    var ranges = [];
    var re = /\S+/g;
    var m;
    while ((m = re.exec(text))) {
      ranges.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    }
    return ranges;
  }

  function computeWordScreens(ranges, maxChars) {
    var MAX_CHARS = maxChars || 175;
    var screens = [];
    var start = 0;
    while (start < ranges.length) {
      var end = start;
      var lastGoodBreak = -1;
      for (var i = start; i < ranges.length; i++) {
        var accLen = ranges[i].end - ranges[start].start;
        if (/[.!?]["')\]]?$/.test(ranges[i].text)) { lastGoodBreak = i; }
        if (accLen > MAX_CHARS) {
          end = (lastGoodBreak >= start) ? lastGoodBreak : i;
          break;
        }
        end = i;
      }
      screens.push({ start: start, end: end });
      start = end + 1;
    }
    return screens.length ? screens : [{ start: 0, end: Math.max(0, ranges.length - 1) }];
  }

  function findScreenForWord(screens, wordIdx) {
    for (var i = 0; i < screens.length; i++) {
      if (wordIdx >= screens[i].start && wordIdx <= screens[i].end) { return i; }
    }
    return screens.length - 1;
  }

  function findWordIndex(ranges, charIndex) {
    var best = -1;
    for (var i = 0; i < ranges.length; i++) {
      if (charIndex >= ranges[i].start && charIndex < ranges[i].end) { return i; }
      if (ranges[i].start <= charIndex) { best = i; } else { break; }
    }
    return best;
  }

  /* Splits Japanese text into subtitle-sized chunks at sentence/comma boundaries,
     merging short adjacent sentences together (up to maxLen) so chunks read naturally
     instead of being split one sentence at a time. */
  function computeJaChunks(text, maxLen) {
    if (!text) { return []; }
    var sentenceParts = text.split(/(?<=[。！？])/).filter(function (s) { return s.trim().length; });
    if (!sentenceParts.length) { sentenceParts = [text]; }
    var pieces = [];
    for (var i = 0; i < sentenceParts.length; i++) {
      var p = sentenceParts[i];
      if (p.length <= maxLen) { pieces.push(p); continue; }
      var subparts = p.split(/(?<=、)/).filter(function (s) { return s.trim().length; });
      var buf = '';
      for (var j = 0; j < subparts.length; j++) {
        var sp = subparts[j];
        if (buf && (buf + sp).length > maxLen) { pieces.push(buf); buf = sp; }
        else { buf += sp; }
      }
      if (buf) { pieces.push(buf); }
    }
    var chunks = [];
    var cur = '';
    for (var k = 0; k < pieces.length; k++) {
      var piece = pieces[k];
      if (cur && (cur + piece).length > maxLen) { chunks.push(cur); cur = piece; }
      else { cur += piece; }
    }
    if (cur) { chunks.push(cur); }
    return chunks.length ? chunks : [text];
  }

  /* ---------- Individual (single-button) playback: Listen / Slow / JA / lecture ---------- */
  var individualPlay = { btn: null, token: 0 };

  function setButtonPlaying(btn, playing) {
    if (!btn) { return; }
    if (playing) {
      if (btn.dataset.origLabel === undefined) { btn.dataset.origLabel = btn.textContent; }
      btn.textContent = '⏹ STOP';
      btn.classList.add('speaking');
    } else {
      if (btn.dataset.origLabel !== undefined) { btn.textContent = btn.dataset.origLabel; }
      btn.classList.remove('speaking');
    }
  }

  function stopIndividualPlayback() {
    individualPlay.token++;
    window.speechSynthesis.cancel();
    if (individualPlay.btn) {
      setButtonPlaying(individualPlay.btn, false);
      individualPlay.btn = null;
    }
  }

  function playSegmentsSequentially(segments, btn) {
    stopIndividualPlayback();
    stopPlayback();
    individualPlay.btn = btn;
    individualPlay.token++;
    var myToken = individualPlay.token;
    setButtonPlaying(btn, true);
    var idx = -1;
    function playNext() {
      if (myToken !== individualPlay.token) { return; }
      idx++;
      if (idx >= segments.length) {
        setButtonPlaying(btn, false);
        if (individualPlay.btn === btn) { individualPlay.btn = null; }
        return;
      }
      var seg = segments[idx];
      if (!seg.text) { playNext(); return; }
      var utter = new SpeechSynthesisUtterance(seg.text);
      utter.lang = seg.lang;
      utter.rate = seg.rate;
      if (seg.voice) { utter.voice = seg.voice; }
      utter.onend = playNext;
      utter.onerror = playNext;
      window.speechSynthesis.speak(utter);
    }
    playNext();
  }

  window.speakText = function (id, lang, isSlow) {
    var el = document.getElementById(id);
    if (!el) { return; }
    if (!('speechSynthesis' in window)) {
      alert('お使いのブラウザは読み上げ機能に対応していません。');
      return;
    }
    var btn = (typeof event !== 'undefined' && event && event.currentTarget) ? event.currentTarget : null;
    if (btn && individualPlay.btn === btn) {
      stopIndividualPlayback();
      return;
    }
    var rate = (lang && lang.indexOf('ja') === 0) ? 1.0 : (isSlow ? ttsRateSlow : ttsRateNormal);
    var segments;
    if (lang && lang.indexOf('en') === 0 && el.classList.contains('english')) {
      var partEl = el.closest('.part');
      var partId = partEl ? partEl.id : '';
      var parsed = parseSpeakerSegments(el);
      segments = parsed.map(function (seg) {
        return {
          text: seg.text.trim(),
          lang: lang,
          rate: rate,
          voice: seg.speaker ? getVoiceForSpeaker(partId, seg.speaker) : null
        };
      });
    } else {
      segments = [{ text: el.innerText || el.textContent || '', lang: lang, rate: rate }];
    }
    playSegmentsSequentially(segments, btn);
  };

  /* ---------- Sequential batch player (per-part play + fullscreen memorization mode) ---------- */
  var player = {
    queue: [],
    index: -1,
    active: false,
    paused: false,
    fsMode: false,
    cardMode: false,
    currentBtn: null,
    currentPartEl: null,
    token: 0,
    wordRanges: null,
    enScreens: null,
    jaChunks: null,
    currentScreenIdx: 0,
    lastWordIndex: -1,
    lastJaChunkIndex: -1
  };
  var fsEl, fsSubtitleEl, fsJaSubtitleEl, fsTitleEl, fsBadgeEl, fsPlayPauseBtn;

  function buildWordSpansHTML(ranges, screen) {
    var out = [];
    for (var i = screen.start; i <= screen.end; i++) {
      out.push('<span class="fs-word" data-i="' + i + '">' + escapeHtmlText(ranges[i].text) + '</span>');
    }
    return out.join(' ');
  }

  function renderEnglishScreen(idx) {
    if (!player.enScreens || !player.wordRanges) { return; }
    fsSubtitleEl.innerHTML = buildWordSpansHTML(player.wordRanges, player.enScreens[idx]);
  }

  function highlightWord(idx) {
    if (!fsSubtitleEl) { return; }
    var prev = fsSubtitleEl.querySelector('.fs-word.active');
    if (prev) { prev.classList.remove('active'); }
    var el = fsSubtitleEl.querySelector('.fs-word[data-i="' + idx + '"]');
    if (el) { el.classList.add('active'); }
  }

  function setFsJaSubtitle(text) {
    if (!fsJaSubtitleEl) { return; }
    if (text) {
      fsJaSubtitleEl.textContent = text;
      fsJaSubtitleEl.classList.add('show');
    } else {
      fsJaSubtitleEl.textContent = '';
      fsJaSubtitleEl.classList.remove('show');
    }
  }

  function setFsBadge(lang, speaker) {
    if (!fsBadgeEl) { return; }
    if (speaker) {
      fsBadgeEl.textContent = speaker;
      fsBadgeEl.classList.add('show');
    } else {
      fsBadgeEl.textContent = '';
      fsBadgeEl.classList.remove('show');
    }
  }

  function updateFsPlayPauseIcon() {
    if (!fsPlayPauseBtn) { return; }
    fsPlayPauseBtn.textContent = player.paused ? '▶ 再生' : '⏸ 一時停止';
  }

  function openFullscreenPlayer(title) {
    if (!fsEl) { return; }
    fsEl.classList.toggle('card-mode', !!player.cardMode);
    fsTitleEl.textContent = title || '';
    fsSubtitleEl.textContent = '';
    setFsJaSubtitle('');
    fsEl.classList.add('open');
    fsEl.setAttribute('aria-hidden', 'false');
    updateFsPlayPauseIcon();
    var el = document.documentElement;
    if (el.requestFullscreen) {
      el.requestFullscreen().catch(function () { /* overlay still fills the viewport */ });
    }
  }

  function closeFullscreenPlayer() {
    if (!fsEl) { return; }
    fsEl.classList.remove('open');
    fsEl.setAttribute('aria-hidden', 'true');
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(function () {});
    }
  }

  function clearPlayingButton() {
    if (player.currentBtn) {
      player.currentBtn.classList.remove('playing');
      player.currentBtn = null;
    }
  }

  function stopPlayback() {
    player.token++;
    player.active = false;
    player.paused = false;
    player.cardMode = false;
    player.queue = [];
    player.index = -1;
    window.speechSynthesis.cancel();
    clearPlayingButton();
    closeFullscreenPlayer();
  }

  function renderFsItem(item) {
    if (!player.fsMode) { return; }
    if (player.cardMode) {
      if (fsBadgeEl) {
        var totalCards = Math.ceil(player.queue.length / 2);
        var posLabel = Math.floor(player.index / 2) + 1;
        fsBadgeEl.textContent = posLabel + ' / ' + totalCards;
        fsBadgeEl.classList.add('show');
      }
      fsSubtitleEl.textContent = item.text;
      setFsJaSubtitle('');
      return;
    }
    setFsBadge(item.lang, item.speaker);
    player.lastWordIndex = -1;
    player.lastJaChunkIndex = -1;
    player.currentScreenIdx = 0;
    if (item.lang.indexOf('en') === 0) {
      player.wordRanges = computeWordRanges(item.text);
      player.enScreens = computeWordScreens(player.wordRanges, isMobileViewport() ? 90 : 175);
      renderEnglishScreen(0);
      /* The Japanese subtitle bar tracks progress through THIS SAME English utterance,
         so estimating its position from charIndex is reliable here (word-accurate ranges
         are available). Kept deliberately short/chunky, movie-subtitle style. */
      player.jaChunks = item.jaText ? computeJaChunks(item.jaText, 34) : [];
      setFsJaSubtitle(player.jaChunks.length ? player.jaChunks[0] : '');
    } else {
      /* Japanese-only items (lecture text) are pre-chunked at queue-build time
         (see buildLectureQueueItems) so that each chunk is spoken as its OWN utterance.
         The display is simply set once, in sync with utterance start -- no proportional
         guessing mid-utterance, which is what caused the previous drifting/repeating bug. */
      player.wordRanges = null;
      player.enScreens = null;
      player.jaChunks = null;
      fsSubtitleEl.textContent = item.text;
      setFsJaSubtitle('');
    }
  }

  function handleBoundary(e, item) {
    if (!player.fsMode) { return; }
    if (player.cardMode) { return; }
    if (item.lang.indexOf('en') !== 0) { return; }
    if (typeof e.charIndex !== 'number') { return; }
    var charIndex = e.charIndex;
    if (player.wordRanges && player.wordRanges.length) {
      var wi = findWordIndex(player.wordRanges, charIndex);
      /* Forward-only: some browsers/voices fire boundary events slightly out of order,
         which previously caused the highlighted word (and JA subtitle) to jump backwards
         or repeat. Ignoring any regression keeps the display moving steadily forward. */
      if (wi !== -1 && wi > player.lastWordIndex) {
        player.lastWordIndex = wi;
        var scr = findScreenForWord(player.enScreens, wi);
        if (scr > player.currentScreenIdx) {
          player.currentScreenIdx = scr;
          renderEnglishScreen(scr);
        }
        highlightWord(wi);
      }
    }
    if (player.jaChunks && player.jaChunks.length && item.text.length) {
      var progress = Math.min(1, charIndex / item.text.length);
      var ci = Math.min(player.jaChunks.length - 1, Math.floor(progress * player.jaChunks.length));
      if (ci > player.lastJaChunkIndex) {
        player.lastJaChunkIndex = ci;
        setFsJaSubtitle(player.jaChunks[ci]);
      }
    }
  }

  function getAllParts() {
    return Array.prototype.slice.call(document.querySelectorAll('.part'));
  }

  function getNextPart(partEl) {
    var all = getAllParts();
    var idx = all.indexOf(partEl);
    if (idx === -1 || idx === all.length - 1) { return null; }
    return all[idx + 1];
  }

  function getPartTitle(partEl) {
    var h2 = partEl.querySelector('h2');
    return h2 ? (h2.innerText || h2.textContent || '') : '';
  }

  function playQueueIndex(idx) {
    player.token++;
    var myToken = player.token;
    window.speechSynthesis.cancel();
    if (idx < 0) { idx = 0; }
    if (idx >= player.queue.length) {
      if (player.fsMode && !player.cardMode) {
        var next = getNextPart(player.currentPartEl);
        if (next) {
          player.currentPartEl = next;
          player.queue = buildQueueForPart(next, true);
          fsTitleEl.textContent = getPartTitle(next);
          playQueueIndex(0);
          return;
        }
      }
      player.active = false;
      player.paused = false;
      clearPlayingButton();
      if (player.fsMode) { closeFullscreenPlayer(); }
      return;
    }
    player.index = idx;
    var item = player.queue[idx];
    renderFsItem(item);
    var utter = new SpeechSynthesisUtterance(item.text);
    utter.lang = item.lang;
    if (player.cardMode) {
      utter.rate = ttsRateFlashcard;
    } else {
      utter.rate = player.fsMode ? ttsRateFullscreen : (item.lang.indexOf('ja') === 0 ? 1.0 : ttsRateNormal);
    }
    if (item.lang.indexOf('en') === 0 && item.speaker) {
      var v = getVoiceForSpeaker(item.partId, item.speaker);
      if (v) { utter.voice = v; }
    }
    utter.onboundary = function (e) { if (myToken === player.token) { handleBoundary(e, item); } };
    utter.onend = function () { if (player.active && myToken === player.token) { playQueueIndex(player.index + 1); } };
    utter.onerror = function () { if (player.active && myToken === player.token) { playQueueIndex(player.index + 1); } };
    window.speechSynthesis.speak(utter);
  }

  function goNext() {
    if (!player.active) { return; }
    playQueueIndex(player.index + 1);
  }

  function goPrev() {
    if (!player.active) { return; }
    playQueueIndex(Math.max(0, player.index - 1));
  }

  function buildQueueForPart(partEl, fullscreenMode) {
    var queue = [];
    var partId = partEl.id;
    var pairs = partEl.querySelectorAll('.para-pair');
    for (var i = 0; i < pairs.length; i++) {
      var turns = buildParagraphTurns(pairs[i]);
      for (var t = 0; t < turns.length; t++) {
        var turn = turns[t];
        queue.push({ text: turn.enText, lang: 'en-US', jaText: turn.jaText, speaker: turn.speaker, partId: partId });
        /* In fullscreen mode Japanese is shown as synced subtitles instead of being spoken
           separately. In normal (non-fullscreen) batch play there is no subtitle display,
           so Japanese is still spoken aloud (speaker names are already stripped). */
        if (!fullscreenMode) {
          queue.push({ text: turn.jaText, lang: 'ja-JP', partId: partId });
        }
      }
    }
    var lectureEl = partEl.querySelector('.lecture-script');
    if (lectureEl) {
      var paras = lectureEl.querySelectorAll('p');
      var lectureTexts = paras.length
        ? Array.prototype.map.call(paras, function (p) { return p.innerText || p.textContent || ''; })
        : [lectureEl.innerText || lectureEl.textContent || ''];
      /* Each lecture paragraph is pre-split into a small number of reasonably-sized
         chunks (not one chunk per sentence) so the on-screen text and the spoken audio
         always start together -- each chunk is its own utterance, never split mid-speech. */
      for (var j = 0; j < lectureTexts.length; j++) {
        var chunks = computeJaChunks(lectureTexts[j], 150);
        for (var k = 0; k < chunks.length; k++) {
          queue.push({ text: chunks[k], lang: 'ja-JP', partId: partId });
        }
      }
    }
    return queue;
  }

  function startPlayback(partEl, btn, fullscreen) {
    if (player.active && player.currentBtn === btn) {
      stopPlayback();
      return;
    }
    stopIndividualPlayback();
    window.speechSynthesis.cancel();
    clearPlayingButton();
    player.fsMode = !!fullscreen;
    player.cardMode = false;
    player.currentPartEl = partEl;
    player.queue = buildQueueForPart(partEl, player.fsMode);
    player.index = -1;
    player.active = true;
    player.paused = false;
    player.currentBtn = btn || null;
    if (btn) { btn.classList.add('playing'); }
    if (fullscreen) { openFullscreenPlayer(getPartTitle(partEl)); }
    playQueueIndex(0);
  }

  /* Flashcard fullscreen mode (Part 50/51 vocabulary pages): each [word, meaning]
     pair becomes two queue steps -- the English word (spoken in English, shown
     alone, centered) followed by its Japanese meaning (spoken in Japanese). */
  function buildFlashcardQueue(items) {
    var queue = [];
    for (var i = 0; i < items.length; i++) {
      var word = items[i][0];
      var meaning = items[i][1];
      queue.push({ text: word, lang: 'en-US', cardSide: 'en' });
      queue.push({ text: meaning, lang: 'ja-JP', cardSide: 'ja' });
    }
    return queue;
  }

  function startFlashcardPlayback(items, btn, title) {
    if (player.active && player.currentBtn === btn) {
      stopPlayback();
      return;
    }
    stopIndividualPlayback();
    window.speechSynthesis.cancel();
    clearPlayingButton();
    player.fsMode = true;
    player.cardMode = true;
    player.currentPartEl = null;
    player.queue = buildFlashcardQueue(items);
    player.index = -1;
    player.active = true;
    player.paused = false;
    player.currentBtn = btn || null;
    if (btn) { btn.classList.add('playing'); }
    openFullscreenPlayer(title || '');
    playQueueIndex(0);
  }
  /* Exposed globally: the vocab/idiom flashcard page script (Part 50/51) runs in
     its own separate IIFE further down in this file and needs to call this. */
  window.startFlashcardPlayback = startFlashcardPlayback;

  function togglePausePlayback() {
    if (!player.active) { return; }
    if (player.paused) {
      window.speechSynthesis.resume();
      player.paused = false;
    } else {
      window.speechSynthesis.pause();
      player.paused = true;
    }
    updateFsPlayPauseIcon();
  }

  document.addEventListener('DOMContentLoaded', function () {
    fsEl = document.getElementById('fullscreenPlayer');
    fsSubtitleEl = document.getElementById('fsSubtitle');
    fsJaSubtitleEl = document.getElementById('fsJaSubtitle');
    fsTitleEl = document.getElementById('fsPartTitle');
    fsBadgeEl = document.getElementById('fsLangBadge');
    fsPlayPauseBtn = document.getElementById('fsPlayPauseBtn');

    if (fsPlayPauseBtn) { fsPlayPauseBtn.addEventListener('click', togglePausePlayback); }
    var fsCloseBtn = document.getElementById('fsCloseBtn');
    if (fsCloseBtn) { fsCloseBtn.addEventListener('click', stopPlayback); }
    var fsPrevBtn = document.getElementById('fsPrevBtn');
    if (fsPrevBtn) { fsPrevBtn.addEventListener('click', goPrev); }
    var fsNextBtn = document.getElementById('fsNextBtn');
    if (fsNextBtn) { fsNextBtn.addEventListener('click', goNext); }

    document.addEventListener('keydown', function (e) {
      if (!fsEl || !fsEl.classList.contains('open')) { return; }
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        togglePausePlayback();
      } else if (e.code === 'Escape' || e.key === 'Escape') {
        stopPlayback();
      } else if (e.code === 'ArrowRight' || e.key === 'ArrowRight') {
        e.preventDefault();
        goNext();
      } else if (e.code === 'ArrowLeft' || e.key === 'ArrowLeft') {
        e.preventDefault();
        goPrev();
      }
    });

    document.addEventListener('fullscreenchange', function () {
      if (!document.fullscreenElement && player.fsMode && (player.active || (fsEl && fsEl.classList.contains('open')))) {
        stopPlayback();
      }
    });

    /* Inject a Japanese-reading speak button under every translation paragraph
       (for individual, non-batch study use). Speaker name prefixes are stripped
       from the spoken audio the same way as the English buttons. */
    var pairs = document.querySelectorAll('.para-pair');
    for (var p = 0; p < pairs.length; p++) {
      (function (pair) {
        var translation = pair.querySelector('.translation');
        if (!translation) { return; }
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'speak-btn';
        btn.title = '日本語訳の読み上げ';
        btn.textContent = '🔊 日本語';
        btn.addEventListener('click', function () {
          if (individualPlay.btn === btn) { stopIndividualPlayback(); return; }
          var parsed = parseSpeakerSegments(translation);
          var segments = parsed.map(function (seg) {
            return { text: seg.text.trim(), lang: 'ja-JP', rate: 1.0 };
          });
          playSegmentsSequentially(segments, btn);
        });
        var line = document.createElement('div');
        line.className = 'audio-line ja-audio-line';
        line.appendChild(btn);
        translation.insertAdjacentElement('afterend', line);
      })(pairs[p]);
    }

    /* Flashcard pages (Part 50/51): a single delegated click handler speaks the
       English term for whichever vocab-speak-btn was clicked (event delegation,
       since there are thousands of individual buttons). Toggle-to-stop, same as
       the other speak buttons. */
    document.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.vocab-speak-btn') : null;
      if (!btn) { return; }
      if (individualPlay.btn === btn) { stopIndividualPlayback(); return; }
      var term = btn.getAttribute('data-speak-text');
      if (!term) { return; }
      playSegmentsSequentially([{ text: term, lang: 'en-US', rate: ttsRateNormal }], btn);
    });

    /* Inject a batch-play control bar (normal + fullscreen) after every Part's h2 */
    var parts = document.querySelectorAll('.part');
    for (var i = 0; i < parts.length; i++) {
      (function (partEl) {
        var h2 = partEl.querySelector('h2');
        if (!h2) { return; }
        if (!partEl.querySelector('.para-pair') && !partEl.querySelector('.lecture-script')) { return; }
        var bar = document.createElement('div');
        bar.className = 'batch-play-bar';

        var playBtn = document.createElement('button');
        playBtn.type = 'button';
        playBtn.className = 'batch-play-btn';
        playBtn.textContent = '▶ この課を一括再生（英→日→講義）';
        playBtn.addEventListener('click', function () { startPlayback(partEl, playBtn, false); });

        var fsBtn = document.createElement('button');
        fsBtn.type = 'button';
        fsBtn.className = 'batch-play-btn fullscreen-btn';
        fsBtn.textContent = '⛶ フルスクリーン暗記モード';
        fsBtn.addEventListener('click', function () { startPlayback(partEl, fsBtn, true); });

        bar.appendChild(playBtn);
        bar.appendChild(fsBtn);
        h2.insertAdjacentElement('afterend', bar);
      })(parts[i]);
    }

    /* Fullscreen slideshow background color picker */
    var fsBgColorPicker = document.getElementById('fsBgColorPicker');
    var savedBg = localStorage.getItem('fsBgColor') || '#0e1116';
    document.documentElement.style.setProperty('--fs-bg-color', savedBg);
    if (fsBgColorPicker) {
      fsBgColorPicker.value = savedBg;
      fsBgColorPicker.addEventListener('input', function () {
        document.documentElement.style.setProperty('--fs-bg-color', this.value);
        localStorage.setItem('fsBgColor', this.value);
      });
    }

    /* Fullscreen word-highlight color + style (glow vs. underline) */
    function hexToRgbTriplet(hex) {
      var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
      if (!m) { return '255, 209, 102'; }
      return parseInt(m[1], 16) + ', ' + parseInt(m[2], 16) + ', ' + parseInt(m[3], 16);
    }
    var fsHighlightColorPicker = document.getElementById('fsHighlightColorPicker');
    var savedHighlightColor = localStorage.getItem('fsHighlightColor') || '#ffd166';
    document.documentElement.style.setProperty('--fs-highlight-rgb', hexToRgbTriplet(savedHighlightColor));
    if (fsHighlightColorPicker) {
      fsHighlightColorPicker.value = savedHighlightColor;
      fsHighlightColorPicker.addEventListener('input', function () {
        document.documentElement.style.setProperty('--fs-highlight-rgb', hexToRgbTriplet(this.value));
        localStorage.setItem('fsHighlightColor', this.value);
      });
    }
    var fsHighlightStyleSelect = document.getElementById('fsHighlightStyleSelect');
    function applyHighlightStyle(style) {
      var playerEl = document.getElementById('fullscreenPlayer');
      if (playerEl) { playerEl.classList.toggle('highlight-underline', style === 'underline'); }
    }
    var savedHighlightStyle = localStorage.getItem('fsHighlightStyle') || 'glow';
    applyHighlightStyle(savedHighlightStyle);
    if (fsHighlightStyleSelect) {
      fsHighlightStyleSelect.value = savedHighlightStyle;
      fsHighlightStyleSelect.addEventListener('change', function () {
        localStorage.setItem('fsHighlightStyle', this.value);
        applyHighlightStyle(this.value);
      });
    }

    /* Fullscreen slideshow speech-rate slider */
    var fsRateSlider = document.getElementById('fsRateSlider');
    var fsRateValue = document.getElementById('fsRateValue');
    if (fsRateSlider) {
      fsRateSlider.value = ttsRateFullscreen;
      if (fsRateValue) { fsRateValue.textContent = ttsRateFullscreen.toFixed(2); }
      fsRateSlider.addEventListener('input', function () {
        ttsRateFullscreen = parseFloat(this.value);
        if (fsRateValue) { fsRateValue.textContent = ttsRateFullscreen.toFixed(2); }
        localStorage.setItem('ttsRateFullscreen', ttsRateFullscreen);
      });
    }

    /* Generic px-based CSS-variable sliders (font sizes / margins).
       Phones and PCs need very different values for the same setting (a
       font/margin sized for a wall-mounted desktop display is unusable on a
       narrow phone screen), so each slider remembers a SEPARATE value per
       device type (keyed by storageKey + "_mobile" / "_desktop") and falls
       back to a device-appropriate default the first time it's used. */
    function initPxVarSlider(sliderId, valueId, cssVar, storageKey, defaultDesktopPx, defaultMobilePx) {
      var slider = document.getElementById(sliderId);
      var valueEl = document.getElementById(valueId);
      var mobile = isMobileViewport();
      var scopedKey = storageKey + (mobile ? '_mobile' : '_desktop');
      var defaultPx = mobile ? (defaultMobilePx != null ? defaultMobilePx : defaultDesktopPx) : defaultDesktopPx;
      var saved = parseInt(localStorage.getItem(scopedKey), 10);
      if (isNaN(saved)) {
        /* Fall back to a legacy (pre-device-split) value if present, so
           existing users don't lose a value they already customized. */
        var legacy = parseInt(localStorage.getItem(storageKey), 10);
        saved = isNaN(legacy) ? NaN : legacy;
      }
      var px = isNaN(saved) ? defaultPx : saved;
      document.documentElement.style.setProperty(cssVar, px + 'px');
      if (slider) {
        slider.value = px;
        if (valueEl) { valueEl.textContent = px + 'px'; }
        slider.addEventListener('input', function () {
          var v = parseInt(this.value, 10);
          document.documentElement.style.setProperty(cssVar, v + 'px');
          if (valueEl) { valueEl.textContent = v + 'px'; }
          localStorage.setItem(scopedKey, v);
        });
      }
    }
    initPxVarSlider('fsMainFontSlider', 'fsMainFontValue', '--fs-main-font-size', 'fsMainFontSize', 60, 26);
    initPxVarSlider('fsMainTopMarginSlider', 'fsMainTopMarginValue', '--fs-main-top-margin', 'fsMainTopMargin', 200, 10);
    initPxVarSlider('fsJaFontSlider', 'fsJaFontValue', '--fs-ja-font-size', 'fsJaFontSize', 40, 16);
    initPxVarSlider('fsJaBottomMarginSlider', 'fsJaBottomMarginValue', '--fs-ja-bottom-margin', 'fsJaBottomMargin', 150, 12);
    initPxVarSlider('fsCardFontSlider', 'fsCardFontValue', '--fs-card-font-size', 'fsCardFontSize', 96, 44);
    initPxVarSlider('vocabFontSlider', 'vocabFontValue', '--vocab-font-size', 'vocabFontSize', 14);

    /* Flashcard-mode speech rate (Part 50/51) */
    var fsCardRateSlider = document.getElementById('fsCardRateSlider');
    var fsCardRateValue = document.getElementById('fsCardRateValue');
    if (fsCardRateSlider) {
      fsCardRateSlider.value = ttsRateFlashcard;
      if (fsCardRateValue) { fsCardRateValue.textContent = ttsRateFlashcard.toFixed(2); }
      fsCardRateSlider.addEventListener('input', function () {
        ttsRateFlashcard = parseFloat(this.value);
        if (fsCardRateValue) { fsCardRateValue.textContent = ttsRateFlashcard.toFixed(2); }
        localStorage.setItem('ttsRateFlashcard', ttsRateFlashcard);
      });
    }

    /* Flashcard mastery-skip and shuffle toggles (Part 50/51). Read directly
       from localStorage by the vocab-page script at playback time, so simply
       persisting the checkbox state here is enough. */
    var skipMasteredToggle = document.getElementById('skipMasteredToggle');
    if (skipMasteredToggle) {
      skipMasteredToggle.checked = localStorage.getItem('skipMasteredEnabled') === '1';
      skipMasteredToggle.addEventListener('change', function () {
        localStorage.setItem('skipMasteredEnabled', this.checked ? '1' : '0');
      });
    }
    var flashcardShuffleToggle = document.getElementById('flashcardShuffleToggle');
    if (flashcardShuffleToggle) {
      flashcardShuffleToggle.checked = localStorage.getItem('flashcardShuffleEnabled') === '1';
      flashcardShuffleToggle.addEventListener('change', function () {
        localStorage.setItem('flashcardShuffleEnabled', this.checked ? '1' : '0');
      });
    }
  });

  /* ---------- Sidebar (table of contents) ---------- */
  var sidebar = document.getElementById('sidebar');
  var sidebarBackdrop = document.getElementById('sidebarBackdrop');
  var sidebarToggle = document.getElementById('sidebarToggle');
  var sidebarClose = document.getElementById('sidebarClose');

  function openSidebar() {
    closeSettings();
    sidebar.classList.add('open');
    sidebarBackdrop.classList.add('open');
    sidebar.setAttribute('aria-hidden', 'false');
  }
  function closeSidebar() {
    sidebar.classList.remove('open');
    sidebarBackdrop.classList.remove('open');
    sidebar.setAttribute('aria-hidden', 'true');
  }
  sidebarToggle.addEventListener('click', function () {
    if (sidebar.classList.contains('open')) { closeSidebar(); } else { openSidebar(); }
  });
  sidebarClose.addEventListener('click', closeSidebar);
  sidebarBackdrop.addEventListener('click', closeSidebar);

  var sidebarLinks = document.querySelectorAll('.sidebar-link');
  for (var i = 0; i < sidebarLinks.length; i++) {
    sidebarLinks[i].addEventListener('click', function (e) {
      var targetId = this.getAttribute('data-target');
      var target = targetId ? document.getElementById(targetId) : null;
      if (target) {
        /* The target part exists on THIS page: smooth-scroll instead of a full navigation. */
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'start' });
        closeSidebar();
      } else {
        /* Target lives on another page (or this is the home link) -- let the browser
           navigate there normally; it will land on the right #anchor automatically. */
        closeSidebar();
      }
    });
  }

  /* ---------- Settings panel ---------- */
  var settingsPanel = document.getElementById('settingsPanel');
  var settingsBackdrop = document.getElementById('settingsBackdrop');
  var settingsToggle = document.getElementById('settingsToggle');
  var settingsClose = document.getElementById('settingsClose');

  function openSettings() {
    closeSidebar();
    settingsPanel.classList.add('open');
    settingsBackdrop.classList.add('open');
    settingsPanel.setAttribute('aria-hidden', 'false');
  }
  function closeSettings() {
    settingsPanel.classList.remove('open');
    settingsBackdrop.classList.remove('open');
    settingsPanel.setAttribute('aria-hidden', 'true');
  }
  settingsToggle.addEventListener('click', function () {
    if (settingsPanel.classList.contains('open')) { closeSettings(); } else { openSettings(); }
  });
  settingsClose.addEventListener('click', closeSettings);
  settingsBackdrop.addEventListener('click', closeSettings);

  var manualOverlay = document.getElementById('manualOverlay');
  var manualOpenBtn = document.getElementById('manualOpenBtn');
  var manualCloseBtn = document.getElementById('manualCloseBtn');
  function openManual() {
    if (!manualOverlay) { return; }
    manualOverlay.classList.add('open');
    manualOverlay.setAttribute('aria-hidden', 'false');
  }
  function closeManual() {
    if (!manualOverlay) { return; }
    manualOverlay.classList.remove('open');
    manualOverlay.setAttribute('aria-hidden', 'true');
  }
  if (manualOpenBtn) {
    manualOpenBtn.addEventListener('click', function () {
      closeSettings();
      openManual();
    });
  }
  if (manualCloseBtn) { manualCloseBtn.addEventListener('click', closeManual); }
  if (manualOverlay) {
    manualOverlay.addEventListener('click', function (e) {
      if (e.target === manualOverlay) { closeManual(); }
    });
  }
  document.addEventListener('keydown', function (e) {
    if (manualOverlay && manualOverlay.classList.contains('open') && (e.code === 'Escape' || e.key === 'Escape')) {
      closeManual();
    }
  });

  document.getElementById('printBtn').addEventListener('click', function () {
    window.print();
  });

  var rateSlider = document.getElementById('rateSlider');
  var rateValue = document.getElementById('rateValue');
  rateSlider.value = ttsRateNormal;
  rateValue.textContent = ttsRateNormal.toFixed(2);
  rateSlider.addEventListener('input', function () {
    ttsRateNormal = parseFloat(this.value);
    rateValue.textContent = ttsRateNormal.toFixed(2);
    localStorage.setItem('ttsRateNormal', ttsRateNormal);
  });

  var slowRateSlider = document.getElementById('slowRateSlider');
  var slowRateValue = document.getElementById('slowRateValue');
  slowRateSlider.value = ttsRateSlow;
  slowRateValue.textContent = ttsRateSlow.toFixed(2);
  slowRateSlider.addEventListener('input', function () {
    ttsRateSlow = parseFloat(this.value);
    slowRateValue.textContent = ttsRateSlow.toFixed(2);
    localStorage.setItem('ttsRateSlow', ttsRateSlow);
  });

  var darkModeToggle = document.getElementById('darkModeToggle');
  function applyDarkMode(on) {
    document.body.classList.toggle('dark-mode', on);
  }
  var savedDark = localStorage.getItem('darkMode') === '1';
  darkModeToggle.checked = savedDark;
  applyDarkMode(savedDark);
  darkModeToggle.addEventListener('change', function () {
    localStorage.setItem('darkMode', this.checked ? '1' : '0');
    applyDarkMode(this.checked);
  });

  /* ---------- Header height as CSS variable (for mobile paging) ---------- */
  function updateHeaderHeight() {
    var header = document.querySelector('.screen-header');
    if (header) {
      document.documentElement.style.setProperty('--header-h', header.offsetHeight + 'px');
    }
  }
  updateHeaderHeight();
  window.addEventListener('resize', updateHeaderHeight);
  window.addEventListener('orientationchange', updateHeaderHeight);

  /* ---------- Highlight current part in sidebar while swiping ---------- */
  var pagesContainer = document.getElementById('pagesContainer');
  if (pagesContainer && 'IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting && entry.target.id) {
          var link = document.querySelector('.sidebar-link[data-target="' + entry.target.id + '"]');
          var allLinks = document.querySelectorAll('.sidebar-link');
          for (var j = 0; j < allLinks.length; j++) { allLinks[j].classList.remove('active'); }
          if (link) { link.classList.add('active'); }
        }
      });
    }, { root: pagesContainer, threshold: 0.6 });
    var partSections = pagesContainer.querySelectorAll('.part');
    for (var k = 0; k < partSections.length; k++) { observer.observe(partSections[k]); }
  }

  /* ---------- PWA: register service worker ---------- */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { /* ignore */ });
    });
  }
})();

/* ---------- Vocabulary/idiom flashcard pages (Part 50/51): fetch JSON, render ---------- */
(function () {
  "use strict";
  var mount = document.getElementById('vocabMount');
  if (!mount) { return; }
  var src = mount.getAttribute('data-src');
  var partId = mount.getAttribute('data-part-id') || '';

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ---------- Mastery tracking (per word/idiom "known" checkmark) ---------- */
  var MASTERED_KEY = 'vocabMastered::' + partId;
  function loadMastered() {
    try {
      var raw = localStorage.getItem(MASTERED_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }
  function saveMastered(store) {
    try { localStorage.setItem(MASTERED_KEY, JSON.stringify(store)); } catch (e) { /* ignore quota errors */ }
  }
  var masteredStore = loadMastered();

  mount.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.mastered-check') : null;
    if (!btn) { return; }
    var id = btn.getAttribute('data-item-id');
    if (!id) { return; }
    var nowMastered = !masteredStore[id];
    if (nowMastered) { masteredStore[id] = true; } else { delete masteredStore[id]; }
    saveMastered(masteredStore);
    var item = btn.closest('.vocab-item');
    if (item) { item.classList.toggle('mastered', nowMastered); }
  });

  fetch(src)
    .then(function (res) { return res.json(); })
    .then(function (data) {
      renderVocabPage(data);
    })
    .catch(function (err) {
      mount.innerHTML = '<p class="vocab-loading">データの読み込みに失敗しました。オフラインの場合は、一度オンラインでこのページを開いてキャッシュしてください。</p>';
    });

  function renderVocabPage(data) {
    var nav = document.createElement('nav');
    nav.className = 'rank-nav';
    data.ranks.forEach(function (rank) {
      var a = document.createElement('a');
      a.href = '#' + partId + '-rank-' + rank.letter.toLowerCase();
      a.textContent = 'ランク' + rank.letter + '（' + rank.items.length + data.unit + '）';
      nav.appendChild(a);
    });
    mount.innerHTML = '';
    mount.appendChild(nav);

    data.ranks.forEach(function (rank) {
      var heading = document.createElement('h3');
      heading.className = 'rank-heading';
      heading.id = partId + '-rank-' + rank.letter.toLowerCase();
      heading.innerHTML = 'ランク' + rank.letter +
        '<span class="rank-desc">' + esc(rank.desc) + '（' + rank.items.length + data.unit + '）</span>';
      var fcBtn = document.createElement('button');
      fcBtn.type = 'button';
      fcBtn.className = 'rank-flashcard-btn';
      fcBtn.textContent = '\uD83C\uDFB4 フラッシュカードで学習';
      fcBtn.addEventListener('click', function () {
        /* Read the skip/shuffle settings fresh on every click, so a change made
           in the settings panel takes effect on the very next playback. */
        var skipMastered = localStorage.getItem('skipMasteredEnabled') === '1';
        var shuffle = localStorage.getItem('flashcardShuffleEnabled') === '1';
        var pool = rank.items.map(function (pair, i) {
          return { id: rank.letter + '_' + i, word: pair[0], meaning: pair[1] };
        });
        if (skipMastered) {
          pool = pool.filter(function (it) { return !masteredStore[it.id]; });
        }
        if (!pool.length) {
          alert('ランク' + rank.letter + 'の単語・熟語はすべて「暗記済み」としてチェックされています。\n設定で「暗記済みを省略」をオフにするか、チェックを外してからもう一度お試しください。');
          return;
        }
        if (shuffle) {
          for (var s = pool.length - 1; s > 0; s--) {
            var r = Math.floor(Math.random() * (s + 1));
            var tmp = pool[s]; pool[s] = pool[r]; pool[r] = tmp;
          }
        }
        var pairs = pool.map(function (it) { return [it.word, it.meaning]; });
        startFlashcardPlayback(pairs, fcBtn, data.title + '　ランク' + rank.letter);
      });
      heading.appendChild(fcBtn);
      mount.appendChild(heading);

      var grid = document.createElement('div');
      grid.className = 'vocab-grid';
      var rowsHtml = [];
      rank.items.forEach(function (pair, i) {
        var word = pair[0];
        var meaning = pair[1];
        var itemId = rank.letter + '_' + i;
        var isMastered = !!masteredStore[itemId];
        rowsHtml.push(
          '<div class="vocab-item' + (isMastered ? ' mastered' : '') + '">' +
          '<button type="button" class="mastered-check" data-item-id="' + itemId + '" title="暗記済みにする" aria-label="暗記済みにする">&#10003;</button>' +
          '<div class="vocab-item-head">' +
          '<button type="button" class="vocab-speak-btn" data-speak-text="' + esc(word) + '" title="発音を聞く">&#128266;</button>' +
          '<span class="word">' + esc(word) + '</span>' +
          '</div>' +
          '<span class="meaning">' + esc(meaning) + '</span>' +
          '</div>'
        );
      });
      grid.innerHTML = rowsHtml.join('');
      mount.appendChild(grid);
    });
  }
})();
