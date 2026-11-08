/* ============================================================
   app.js —— 界面、手写画板、判分逻辑
   纯原生 JS，无框架。所有识别都在浏览器本地完成。

   防作弊说明（重要）：
     本页面的答案区是只读 <div>，全页不存在任何 <input>/<textarea>/contenteditable，
     并且全局拦截右键菜单、拖拽、粘贴（paste / drop / beforeinput / Ctrl+V）。
     目的：防止学生切到系统输入法、语音输入或粘贴现成文字来绕过「书写考察」。
   ============================================================ */
(function () {
  'use strict';

  var SIZE = 256;              // 画板逻辑坐标系（0..256）
  var PAD_SCALE = 2;           // 画板实际像素倍率，保证高分屏清晰
  var RECOGNIZE_DELAY = 380;   // 笔停多久后自动识别（ms）

  var $ = function (id) { return document.getElementById(id); };

  var pad = $('pad');
  var ctx = pad.getContext('2d');

  var el = {
    padWrap: $('padWrap'),
    padTip: $('padTip'),
    engineStatus: $('engineStatus'),
    engineStatusText: $('engineStatusText'),
    qProgress: $('qProgress'),
    qCharHint: $('qCharHint'),
    wordDisplay: $('wordDisplay'),
    wordPinyin: $('wordPinyin'),
    feedback: $('feedback'),
    candidates: $('candidates'),
    candidatesEmpty: $('candidatesEmpty'),
    answerBox: $('answerBox'),
    debugGrid: $('debugGrid'),
    btnUndo: $('btnUndo'),
    btnClear: $('btnClear'),
    btnJudge: $('btnJudge'),
    btnDelChar: $('btnDelChar'),
    btnDelAll: $('btnDelAll'),
    resultMask: $('resultMask'),
    resultScore: $('resultScore'),
    resultStats: $('resultStats'),
    resultDetail: $('resultDetail'),
    btnRestart: $('btnRestart')
  };

  // ------------------------- 运行状态 -------------------------
  var app = {
    words: [],
    wordIndex: 0,
    charIndex: 0,
    mode: 'single',          // single=逐字录入 / whole=整词连写
    records: [],             // {wordIndex, pos, target, got, ok}
    roundStart: 0,
    finished: false,
    busy: false
  };

  var strokes = [];          // [[[x,y], ...], ...]
  var currentStroke = null;
  var drawing = false;
  var recognizeTimer = null;
  var advanceTimer = null;
  var lastRec = { ms: 0, matches: [] };
  var lastCandidates = [];

  // ===========================================================
  // 防作弊
  // ===========================================================
  function blockEvent(e) {
    e.preventDefault();
    return false;
  }

  function bindAntiCheat() {
    document.addEventListener('contextmenu', blockEvent);
    document.addEventListener('dragstart', blockEvent);
    document.addEventListener('dragover', blockEvent);
    document.addEventListener('drop', blockEvent);
    document.addEventListener('paste', blockEvent);
    document.addEventListener('cut', blockEvent);
    document.addEventListener('copy', blockEvent);
    document.addEventListener('selectstart', blockEvent);

    // 页面内没有任何可编辑控件；这里再兜底拦截「系统输入法 / 语音输入」产生的输入事件
    document.addEventListener('beforeinput', function (e) {
      if (!e.target || !e.target.isContentEditable) e.preventDefault();
    });

    document.addEventListener('keydown', function (e) {
      var k = (e.key || '').toLowerCase();
      if ((e.ctrlKey || e.metaKey) && (k === 'v' || k === 'x')) e.preventDefault();
      if (k === 'insert' && (e.shiftKey || e.ctrlKey)) e.preventDefault();
    });
  }

  // ===========================================================
  // 画板
  // ===========================================================
  function setupCanvas() {
    pad.width = SIZE * PAD_SCALE;
    pad.height = SIZE * PAD_SCALE;
    ctx.setTransform(PAD_SCALE, 0, 0, PAD_SCALE, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  function drawStroke(pts) {
    if (!pts || !pts.length) return;
    ctx.strokeStyle = '#161412';
    ctx.fillStyle = '#161412';
    ctx.lineWidth = 6;

    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0][0], pts[0][1], 3, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length - 1; i++) {
      var mx = (pts[i][0] + pts[i + 1][0]) / 2;
      var my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    ctx.stroke();
  }

  function redraw() {
    ctx.clearRect(0, 0, SIZE, SIZE);
    for (var i = 0; i < strokes.length; i++) drawStroke(strokes[i]);
    if (currentStroke) drawStroke(currentStroke);
  }

  function pointerPos(e) {
    var r = pad.getBoundingClientRect();
    return [
      (e.clientX - r.left) / r.width * SIZE,
      (e.clientY - r.top) / r.height * SIZE
    ];
  }

  function bindPad() {
    pad.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      if (app.finished) return;
      drawing = true;
      el.padWrap.classList.add('drawing');
      el.padTip.classList.add('hide');
      try { pad.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      currentStroke = [pointerPos(e)];
      redraw();
    });

    pad.addEventListener('pointermove', function (e) {
      if (!drawing || !currentStroke) return;
      e.preventDefault();
      var events = (typeof e.getCoalescedEvents === 'function') ? e.getCoalescedEvents() : [e];
      if (!events.length) events = [e];
      for (var i = 0; i < events.length; i++) {
        var p = pointerPos(events[i]);
        var last = currentStroke[currentStroke.length - 1];
        if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < 1.2) continue;
        currentStroke.push(p);
      }
      redraw();
    });

    function endStroke(e) {
      if (!drawing) return;
      e.preventDefault();
      drawing = false;
      el.padWrap.classList.remove('drawing');
      if (currentStroke && currentStroke.length) strokes.push(currentStroke);
      currentStroke = null;
      redraw();
      updateDebug();
      scheduleRecognize(RECOGNIZE_DELAY);
    }

    pad.addEventListener('pointerup', endStroke);
    pad.addEventListener('pointercancel', endStroke);
    window.addEventListener('pointerup', function (e) {
      if (drawing && e.target !== pad) endStroke(e);
    });

    // 触屏/手写笔：禁止浏览器滚动与缩放手势
    pad.addEventListener('touchstart', function (e) { e.preventDefault(); }, { passive: false });
    pad.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
  }

  function clearPad(showTip) {
    clearTimeout(recognizeTimer);
    strokes = [];
    currentStroke = null;
    drawing = false;
    lastRec = { ms: 0, matches: [] };
    lastCandidates = [];
    redraw();
    renderCandidates([]);
    if (showTip) el.padTip.classList.remove('hide');
    updateDebug();
  }

  // ===========================================================
  // 识别
  // ===========================================================
  function hasEnoughPoints(list) {
    if (!list.length) return false;
    var total = 0;
    for (var i = 0; i < list.length; i++) total += list[i].length;
    return total >= 2;
  }

  function scheduleRecognize(delay) {
    clearTimeout(recognizeTimer);
    if (app.mode !== 'single') return;
    if (!hasEnoughPoints(strokes)) return;
    setFeedback('识别中…', '');
    recognizeTimer = setTimeout(runRecognize, delay);
  }

  function runRecognize() {
    if (!hasEnoughPoints(strokes)) return Promise.resolve(null);
    var snapshot = strokes.map(function (s) { return s.map(function (p) { return [p[0], p[1]]; }); });
    return HWEngine.recognize(snapshot, HWEngine.MAX_MATCHES).then(function (res) {
      // 识别期间画板被清空/改变则丢弃本次结果
      if (snapshot !== strokes && strokes.length !== snapshot.length) return;
      lastRec = res;
      lastCandidates = res.matches;
      if (app.mode === 'single') {
        renderCandidates(res.matches);
        setFeedback(res.matches.length ? '选择正确的字上屏，或继续补笔。' : '没有识别结果，请重写。', '');
      }
      updateDebug();
      return res;
    });
  }

  function renderCandidates(list) {
    var box = el.candidates;
    box.innerHTML = '';
    if (app.mode !== 'single') {
      el.candidatesEmpty.textContent = '整词模式：写完整词后点「完成识别」判分';
      el.candidatesEmpty.hidden = false;
      return;
    }
    if (!list || !list.length) {
      el.candidatesEmpty.textContent = '写完一笔后自动识别，点候选字上屏';
      el.candidatesEmpty.hidden = false;
      return;
    }
    el.candidatesEmpty.hidden = true;
    list.slice(0, 8).forEach(function (m, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'cand';
      b.title = '得分 ' + m.score.toFixed(3);
      var idx = document.createElement('span');
      idx.className = 'idx';
      idx.textContent = String(i + 1);
      b.appendChild(idx);
      b.appendChild(document.createTextNode(m.character));
      b.addEventListener('click', function () { selectCandidate(m.character); });
      box.appendChild(b);
    });
  }

  // ===========================================================
  // 答题流程
  // ===========================================================
  function currentWord() { return app.words[app.wordIndex] || null; }

  function setFeedback(text, kind) {
    el.feedback.textContent = text;
    el.feedback.className = 'feedback' + (kind ? ' ' + kind : '');
  }

  function setEngineStatus(status, text) {
    el.engineStatus.className = 'engine-status ' + status;
    el.engineStatusText.textContent = text;
  }

  function renderQuestion() {
    if (app.wordIndex >= app.words.length) return;
    var word = currentWord();
    var chars = Array.from(word.word);

    el.qProgress.textContent = '第 ' + (app.wordIndex + 1) + ' / ' + app.words.length + ' 题';
    el.qCharHint.textContent = app.mode === 'single'
      ? '请写第 ' + (app.charIndex + 1) + ' 个字'
      : '一次写完整个词，共 ' + chars.length + ' 个字';
    el.wordPinyin.textContent = word.pinyin || '';

    el.wordDisplay.innerHTML = '';
    chars.forEach(function (ch, i) {
      var d = document.createElement('div');
      d.className = 'word-char';
      var rec = findRecord(app.wordIndex, i);
      if (app.mode === 'single' && i === app.charIndex && !rec) d.classList.add('current');
      if (rec) d.classList.add(rec.ok ? 'ok' : 'bad');
      d.textContent = ch;
      if (rec) {
        var m = document.createElement('span');
        m.className = 'mark';
        m.textContent = rec.ok ? '✓' : '✗';
        d.appendChild(m);
      }
      el.wordDisplay.appendChild(d);
    });

    el.btnJudge.hidden = app.mode !== 'whole';
    renderCandidates(app.mode === 'single' ? lastCandidates : []);
  }

  function findRecord(wordIndex, pos) {
    for (var i = app.records.length - 1; i >= 0; i--) {
      var r = app.records[i];
      if (r.wordIndex === wordIndex && r.pos === pos) return r;
    }
    return null;
  }

  function addRecord(pos, target, got) {
    var ok = got === target;
    app.records.push({ wordIndex: app.wordIndex, pos: pos, target: target, got: got, ok: ok });
    return ok;
  }

  function selectCandidate(ch) {
    if (app.mode !== 'single' || app.finished || app.busy) return;
    var word = currentWord();
    if (!word) return;
    var target = word.word[app.charIndex];
    var ok = addRecord(app.charIndex, target, ch);

    app.busy = true;
    renderQuestion();
    updateAnswerBox();
    updateDebug();

    if (ok) {
      setFeedback('✓ 正确，识别为「' + ch + '」', 'ok');
    } else {
      setFeedback('✗ 识别为「' + ch + '」，正确是「' + target + '」', 'bad');
    }

    clearTimeout(advanceTimer);
    advanceTimer = setTimeout(function () {
      app.busy = false;
      clearPad(app.charIndex + 1 >= word.word.length);
      advanceAfterChar();
    }, ok ? 620 : 1200);
  }

  function advanceAfterChar() {
    if (app.wordIndex >= app.words.length) return;
    var word = currentWord();
    app.charIndex++;
    if (app.charIndex >= word.word.length) {
      app.wordIndex++;
      app.charIndex = 0;
      if (app.wordIndex >= app.words.length) { finishRound(); return; }
      renderQuestion();
      setFeedback('本题完成，请继续下一题。', '');
    } else {
      renderQuestion();
      setFeedback('请继续写第 ' + (app.charIndex + 1) + ' 个字。', '');
    }
  }

  /* ---------- 整词连写：按笔迹横向位置切分成 N 个字 ---------- */
  function segmentStrokes(list, k) {
    if (k <= 1) return [list.slice()];
    var cents = list.map(function (s) {
      var sum = 0;
      for (var i = 0; i < s.length; i++) sum += s[i][0];
      return sum / s.length;
    });
    var centers = [];
    for (var i = 0; i < k; i++) centers.push(SIZE * (i + 0.5) / k);
    var assign = new Array(list.length).fill(0);

    for (var iter = 0; iter < 12; iter++) {
      var changed = false;
      for (var s = 0; s < list.length; s++) {
        var best = 0, bestD = Infinity;
        for (var c = 0; c < k; c++) {
          var d = Math.abs(cents[s] - centers[c]);
          if (d < bestD) { bestD = d; best = c; }
        }
        if (assign[s] !== best) { assign[s] = best; changed = true; }
      }
      var sums = new Array(k).fill(0), counts = new Array(k).fill(0);
      for (var j = 0; j < list.length; j++) { sums[assign[j]] += cents[j]; counts[assign[j]]++; }
      for (var c2 = 0; c2 < k; c2++) if (counts[c2]) centers[c2] = sums[c2] / counts[c2];
      if (!changed && iter > 0) break;
    }

    // 空簇兜底：从笔画最多的簇里挪一笔过去
    for (var c3 = 0; c3 < k; c3++) {
      if (counts[c3] === 0) {
        var big = 0;
        for (var c4 = 1; c4 < k; c4++) if (counts[c4] > counts[big]) big = c4;
        if (counts[big] > 1) {
          for (var p = 0; p < assign.length; p++) {
            if (assign[p] === big) {
              assign[p] = c3;
              counts[big]--; counts[c3]++;
              break;
            }
          }
        }
      }
    }

    var groups = [];
    for (var g = 0; g < k; g++) groups.push([]);
    for (var idx = 0; idx < list.length; idx++) groups[assign[idx]].push(list[idx]);
    // 按书写顺序保留簇内笔画（上面按原顺序 push，已满足）
    return groups;
  }

  function judgeWholeWord() {
    if (app.mode !== 'whole' || app.finished || app.busy) return;
    var word = currentWord();
    if (!word) return;
    if (!hasEnoughPoints(strokes)) {
      setFeedback('请先在手写区写字。', 'bad');
      return;
    }
    app.busy = true;
    el.btnJudge.disabled = true;
    setFeedback('识别中…', '');

    var groups = segmentStrokes(strokes, word.word.length);
    var targets = Array.from(word.word);
    var tasks = groups.map(function (g) {
      return HWEngine.recognize(g, 3).then(function (res) {
        return res.matches.length ? res.matches[0].character : '';
      });
    });

    Promise.all(tasks).then(function (gots) {
      var okCount = 0;
      gots.forEach(function (got, i) {
        if (addRecord(i, targets[i], got)) okCount++;
      });
      renderQuestion();
      updateAnswerBox();
      updateDebug();
      setFeedback(
        okCount === targets.length
          ? '✓ 整词正确：' + word.word
          : '识别为「' + gots.join('') + '」，正确是「' + word.word + '」',
        okCount === targets.length ? 'ok' : 'bad'
      );
      app.busy = false;
      el.btnJudge.disabled = false;
      clearTimeout(advanceTimer);
      advanceTimer = setTimeout(function () {
        clearPad(true);
        app.wordIndex++;
        app.charIndex = 0;
        if (app.wordIndex >= app.words.length) { finishRound(); return; }
        renderQuestion();
        setFeedback('请继续下一题。', '');
      }, 1600);
    });
  }

  // ===========================================================
  // 答案区（只读 div，非 input）
  // ===========================================================
  function updateAnswerBox() {
    var box = el.answerBox;
    box.innerHTML = '';
    var lastWord = -1;
    app.records.forEach(function (r) {
      if (r.wordIndex !== lastWord) {
        if (lastWord !== -1) {
          var sep = document.createElement('span');
          sep.className = 'ans-sep';
          sep.textContent = '|';
          box.appendChild(sep);
        }
        lastWord = r.wordIndex;
      }
      var d = document.createElement('span');
      d.className = 'ans-char ' + (r.ok ? 'ok' : 'bad');
      d.textContent = r.got || '？';
      d.title = '目标字：' + r.target + '，识别：' + (r.got || '无');
      box.appendChild(d);
    });
  }

  function deleteLastChar() {
    if (!app.records.length || app.finished) return;
    clearTimeout(advanceTimer);
    app.busy = false;
    var rec = app.records.pop();
    app.wordIndex = rec.wordIndex;
    app.charIndex = rec.pos;
    updateAnswerBox();
    renderQuestion();
    clearPad(true);
    setFeedback('已删除「' + (rec.got || '？') + '」，请重写第 ' + (rec.pos + 1) + ' 个字。', '');
    updateDebug();
  }

  function clearAnswer() {
    if (app.finished) return;
    clearTimeout(advanceTimer);
    app.records = [];
    app.wordIndex = 0;
    app.charIndex = 0;
    app.busy = false;
    app.roundStart = performance.now();
    updateAnswerBox();
    renderQuestion();
    clearPad(true);
    setFeedback('答案已清空，本轮重新开始。', '');
    updateDebug();
  }

  // ===========================================================
  // 结果页
  // ===========================================================
  function finishRound() {
    app.finished = true;
    clearTimeout(advanceTimer);
    var total = app.words.reduce(function (a, w) { return a + w.word.length; }, 0);
    var correct = app.records.filter(function (r) { return r.ok; }).length;
    var answered = app.records.length;
    var acc = total ? Math.round(correct / total * 100) : 0;
    var seconds = Math.max(1, Math.round((performance.now() - app.roundStart) / 1000));

    el.resultScore.textContent = acc + '%';
    el.resultStats.innerHTML =
      '答对字数：<b>' + correct + ' / ' + total + '</b><br>' +
      '已录入：' + answered + ' 字　正确率：' + acc + '%<br>' +
      '用时：' + seconds + ' 秒';

    el.resultDetail.innerHTML = '';
    app.words.forEach(function (w, wi) {
      var recs = app.records.filter(function (r) { return r.wordIndex === wi; });
      if (!recs.length) return;
      var line = document.createElement('div');
      line.className = 'result-line';
      var left = document.createElement('span');
      left.textContent = w.word;
      var right = document.createElement('span');
      right.className = 'r-chars';
      right.textContent = recs.map(function (r) {
        return r.ok ? '✓' : '✗' + (r.got || '？');
      }).join(' ');
      line.appendChild(left);
      line.appendChild(right);
      el.resultDetail.appendChild(line);
    });

    el.resultMask.hidden = false;
  }

  // ===========================================================
  // 调试面板
  // ===========================================================
  function fmtBytes(n) {
    if (!n) return '—';
    return (n / 1024).toFixed(1) + ' KB（' + n.toLocaleString('en-US') + ' B）';
  }

  function updateDebug() {
    var st = HWEngine.state;
    var statusText = st.status === 'ready' ? '就绪' : (st.status === 'error' ? '失败' : '加载中');
    var elapsed = app.roundStart ? Math.round((performance.now() - app.roundStart) / 1000) : 0;
    var scores = lastCandidates.slice(0, 4).map(function (m) {
      return m.character + ' ' + (m.score * 100).toFixed(1);
    }).join(' / ') || '—';

    el.debugGrid.innerHTML =
      '<div>引擎状态　<b>' + statusText + '</b></div>' +
      '<div>数据文件　<b>' + fmtBytes(st.bytes) + '</b></div>' +
      '<div>字典字数　<b>' + (st.charCount || '—') + '</b></div>' +
      '<div>数据加载　<b>' + (st.dataMs || 0) + ' ms</b></div>' +
      '<div>当前笔画数　<b>' + strokes.length + '</b></div>' +
      '<div>识别耗时　<b>' + (lastRec.ms || 0) + ' ms</b></div>' +
      '<div>候选分数　<b>' + scores + '</b></div>' +
      '<div>本轮用时　<b>' + elapsed + ' s</b></div>';
  }

  // ===========================================================
  // 启动
  // ===========================================================
  function bindUi() {
    el.btnUndo.addEventListener('click', function () {
      if (!strokes.length) return;
      strokes.pop();
      redraw();
      updateDebug();
      scheduleRecognize(60);
    });

    el.btnClear.addEventListener('click', function () { clearPad(true); });

    el.btnJudge.addEventListener('click', judgeWholeWord);
    el.btnDelChar.addEventListener('click', deleteLastChar);
    el.btnDelAll.addEventListener('click', clearAnswer);
    el.btnRestart.addEventListener('click', function () {
      el.resultMask.hidden = true;
      startRound();
    });

    document.querySelectorAll('.mode-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (app.busy) return;
        app.mode = btn.dataset.mode;
        document.querySelectorAll('.mode-btn').forEach(function (b) {
          var on = b === btn;
          b.classList.toggle('active', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        clearPad(true);
        renderQuestion();
        setFeedback(app.mode === 'single'
          ? '逐字录入：每写完一个字，点候选字上屏。'
          : '整词连写：把整个词写在一块画板上，写完点「完成识别」。', '');
      });
    });
  }

  function loadWords() {
    return fetch('data/words.json')
      .then(function (r) {
        if (!r.ok) throw new Error('words.json HTTP ' + r.status);
        return r.json();
      })
      .then(function (list) {
        if (!Array.isArray(list) || !list.length) throw new Error('题库为空');
        app.words = list;
        return list;
      });
  }

  function startRound() {
    app.wordIndex = 0;
    app.charIndex = 0;
    app.records = [];
    app.finished = false;
    app.busy = false;
    app.roundStart = performance.now();
    clearTimeout(advanceTimer);
    clearPad(true);
    updateAnswerBox();
    renderQuestion();
    setFeedback('请在右侧手写区书写第 1 个字。', '');
    updateDebug();
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('service-worker.js')
        .then(function (reg) {
          console.log('[handwriting] SW registered, scope=' + reg.scope);
        })
        .catch(function (err) {
          console.warn('[handwriting] SW register failed:', err);
        });
    });
  }

  function init() {
    setupCanvas();
    bindAntiCheat();
    bindPad();
    bindUi();
    updateDebug();
    registerServiceWorker();

    setInterval(updateDebug, 1000);

    loadWords()
      .catch(function (err) {
        setFeedback('题库加载失败：' + err.message, 'bad');
        return [];
      })
      .then(function () {
        return HWEngine.load();
      })
      .then(function (st) {
        if (st.status === 'ready') {
          setEngineStatus('ready', '引擎就绪 · 本地识别');
          console.log('[handwriting] engine ready, chars=' + st.charCount +
            ', data=' + st.bytes + 'B, load=' + st.dataMs + 'ms');
        } else {
          setEngineStatus('error', '引擎加载失败');
          setFeedback('识别引擎加载失败：' + st.error, 'bad');
          console.error('[handwriting] engine load failed:', st.error);
        }
        updateDebug();
        startRound();
      });
  }

  // 调试/验收钩子：供自动化测试直接喂合成笔画
  window.HWDebug = {
    recognize: function (list, limit) { return HWEngine.recognize(list, limit || 10); },
    segment: segmentStrokes,
    // 把一组合成笔画放进画板并立即识别（不绕过任何判分逻辑）
    setStrokes: function (list) {
      clearTimeout(recognizeTimer);
      strokes = list.map(function (s) {
        return s.map(function (p) { return [p[0], p[1]]; });
      });
      currentStroke = null;
      el.padTip.classList.add('hide');
      redraw();
      updateDebug();
      return runRecognize();
    },
    getState: function () {
      return {
        status: HWEngine.state.status,
        bytes: HWEngine.state.bytes,
        chars: HWEngine.state.charCount,
        wordIndex: app.wordIndex,
        charIndex: app.charIndex,
        mode: app.mode,
        records: app.records.slice(),
        finished: app.finished
      };
    }
  };

  init();
})();
