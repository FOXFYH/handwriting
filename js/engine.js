/* ============================================================
   engine.js —— HanziLookupJS 封装
   纯 JS，无 WASM，无后端；数据文件随仓库一起托管，可离线。
   使用全局 HanziLookup（lib/hanzilookup.min.js 提供）
   ============================================================ */
(function (global) {
  'use strict';

  var DATA_URL = 'data/mmah.json';
  var DATA_NAME = 'mmah';
  var MAX_MATCHES = 8;

  var state = {
    status: 'loading',   // loading | ready | error
    bytes: 0,
    charCount: 0,
    dataMs: 0,
    error: '',
    matcher: null
  };

  /**
   * 加载识别数据。只做一次，之后走内存。
   * 用 fetch 而不是库自带的 XHR，便于拿到文件字节数做验收展示。
   */
  function load() {
    var t0 = performance.now();
    return fetch(DATA_URL)
      .then(function (res) {
        if (!res.ok) throw new Error('mmah.json HTTP ' + res.status);
        return res.text();
      })
      .then(function (text) {
        state.bytes = new Blob([text]).size;
        var data = JSON.parse(text);
        if (!data || !data.chars || !data.substrokes) {
          throw new Error('mmah.json 结构异常：缺少 chars / substrokes');
        }
        data.substrokes = HanziLookup.decodeCompact(data.substrokes);
        HanziLookup.data[DATA_NAME] = data;
        state.charCount = data.chars.length;
        state.matcher = new HanziLookup.Matcher(DATA_NAME, HanziLookup.DEFAULT_LOOSENESS);
        state.status = 'ready';
        state.dataMs = Math.round(performance.now() - t0);
        return state;
      })
      .catch(function (err) {
        state.status = 'error';
        state.error = err && err.message ? err.message : String(err);
        state.dataMs = Math.round(performance.now() - t0);
        return state;
      });
  }

  /**
   * 识别一组笔画。
   * @param {Array<Array<Array<number>>>} strokes 笔画数组，坐标 0..256
   * @param {number} limit 候选数量
   * @returns {Promise<{matches: Array<{character:string, score:number}>, ms:number}>}
   * 放到 setTimeout 里执行，避免阻塞界面绘制/输入。
   */
  function recognize(strokes, limit) {
    var n = limit || MAX_MATCHES;
    return new Promise(function (resolve) {
      if (state.status !== 'ready' || !state.matcher) {
        resolve({ matches: [], ms: 0 });
        return;
      }
      setTimeout(function () {
        var t0 = performance.now();
        var matches = [];
        try {
          var analyzed = new HanziLookup.AnalyzedCharacter(
            strokes.map(function (s) {
              return s.map(function (p) { return [p[0], p[1]]; });
            })
          );
          state.matcher.match(analyzed, n, function (list) { matches = list || []; });
        } catch (e) {
          // 单次识别失败不应打断答题，记录到控制台即可
          console.error('[engine] recognize failed:', e);
        }
        resolve({ matches: matches, ms: Math.round(performance.now() - t0) });
      }, 0);
    });
  }

  global.HWEngine = {
    state: state,
    load: load,
    recognize: recognize,
    MAX_MATCHES: MAX_MATCHES
  };
})(window);
