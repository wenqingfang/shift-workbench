/* ==========================================================
   班次闹钟工作台
   数据全部保存在 localStorage，无后端
   ========================================================== */
(function () {
  'use strict';

  const KEY = 'shiftWorkbench.v1';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.prototype.slice.call(document.querySelectorAll(s));

  /* ---------- 默认数据 ---------- */
  const DEFAULT = {
    leadMinutes: 60,
    shifts: [
      { id: 'am',    name: '上午班', start: '08:00', end: '12:00', color: '#f59e0b', alarm: true },
      { id: 'pm',    name: '下午班', start: '14:00', end: '18:00', color: '#7c5cff', alarm: true },
      { id: 'night', name: '晚班',   start: '18:00', end: '22:00', color: '#22d3ee', alarm: true },
      { id: 'off',   name: '休息',   start: '',      end: '',      color: '#3f4460', alarm: false }
    ],
    schedule: {},          // { 'YYYY-MM-DD': shiftId }
    fired: {}              // { 'YYYY-MM-DD': true } 已响过的闹钟
  };

  let S = load();
  let viewYear, viewMonth;         // 当前显示的月份
  let pickDate = null;             // 抽屉正在编辑的日期
  let paintShift = null;           // 连点模式选中的班次
  let pendingImport = null;        // 待确认导入的数据
  let cycleSeq = [];               // 循环规则序列
  let alarmTimer = null;
  let audioCtx = null;
  let ringTimer = null;

  /* ================= 存储 ================= */
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return JSON.parse(JSON.stringify(DEFAULT));
      const d = JSON.parse(raw);
      return Object.assign(JSON.parse(JSON.stringify(DEFAULT)), d);
    } catch (e) {
      return JSON.parse(JSON.stringify(DEFAULT));
    }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('保存失败：存储空间不足'); }
  }

  /* ================= 工具 ================= */
  const pad = (n) => String(n).padStart(2, '0');
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseYmd(s) { const p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function getShift(id) { return S.shifts.find((s) => s.id === id) || null; }
  function shiftOf(dateStr) { return getShift(S.schedule[dateStr]); }

  /** 上班时间 Date 对象 */
  function startAt(dateStr, sh) {
    if (!sh || !sh.start) return null;
    const d = parseYmd(dateStr);
    const t = sh.start.split(':');
    d.setHours(+t[0], +t[1], 0, 0);
    return d;
  }
  /** 闹钟时间 Date 对象 */
  function alarmAt(dateStr, sh) {
    if (!sh || !sh.start || !sh.alarm) return null;
    const st = startAt(dateStr, sh);
    return new Date(st.getTime() - S.leadMinutes * 60000);
  }
  function hhmm(d) { return d ? pad(d.getHours()) + ':' + pad(d.getMinutes()) : '--:--'; }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.remove('on'), 2200);
  }
  function hex2rgba(hex, a) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /* ================= 渲染：Hero ================= */
  function renderHero() {
    const now = new Date();
    const today = ymd(now);
    const wk = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
    $('#heroDate').textContent = (now.getMonth() + 1) + '月' + now.getDate() + '日 · 星期' + wk;

    const sh = shiftOf(today);
    if (!sh) {
      $('#heroShift').textContent = '今天未排班';
      $('#heroStart').textContent = '--:--';
      $('#heroAlarm').textContent = '--:--';
    } else {
      $('#heroShift').textContent = sh.name;
      $('#heroStart').textContent = sh.start || '休息';
      const a = alarmAt(today, sh);
      $('#heroAlarm').textContent = a ? hhmm(a) : '无';
    }
    renderCountdown();
  }

  function renderCountdown() {
    const next = nextAlarm();
    const el = $('#countdownText');
    if (!next) { el.textContent = '未来 30 天没有待响的闹钟'; return; }
    let ms = next.time - new Date();
    if (ms < 0) ms = 0;
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const d = Math.floor(h / 24);
    let str;
    if (d >= 1) str = d + ' 天 ' + (h % 24) + ' 小时后';
    else if (h >= 1) str = h + ' 小时 ' + m + ' 分后';
    else str = m + ' 分钟后';
    el.innerHTML = '下一个闹钟 <b style="color:#9ae7ff">' + str + '</b> · ' +
      (next.date.getMonth() + 1) + '/' + next.date.getDate() + ' ' + hhmm(next.time) + ' ' + next.shift.name;
  }

  /** 未来所有闹钟（最多 30 天） */
  function upcomingAlarms(days) {
    const out = [];
    const now = new Date();
    for (let i = 0; i < (days || 30); i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      const key = ymd(d);
      const sh = shiftOf(key);
      if (!sh) continue;
      const a = alarmAt(key, sh);
      if (!a || a < now) continue;
      out.push({ key: key, date: d, shift: sh, time: a, start: startAt(key, sh) });
    }
    return out;
  }
  function nextAlarm() { return upcomingAlarms(30)[0] || null; }

  /* ================= 渲染：日历 ================= */
  function renderCalendar() {
    $('#calTitle').textContent = viewYear + '年' + (viewMonth + 1) + '月';
    const grid = $('#calGrid');
    grid.innerHTML = '';

    const first = new Date(viewYear, viewMonth, 1);
    let offset = first.getDay() - 1;           // 周一为首列
    if (offset < 0) offset = 6;
    const start = new Date(viewYear, viewMonth, 1 - offset);
    const todayKey = ymd(new Date());

    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const key = ymd(d);
      const sh = shiftOf(key);
      const cell = document.createElement('button');
      cell.className = 'day';
      if (d.getMonth() !== viewMonth) cell.classList.add('out');
      if (key === todayKey) cell.classList.add('today');
      if (sh) {
        cell.classList.add('has');
        cell.style.background = 'linear-gradient(150deg,' + hex2rgba(sh.color, .55) + ',' + hex2rgba(sh.color, .2) + ')';
        cell.style.borderColor = hex2rgba(sh.color, .5);
      }
      const num = document.createElement('span');
      num.className = 'dnum';
      num.textContent = d.getDate();
      cell.appendChild(num);

      const hol = holidayOf(key);
      if (hol) {
        const hb = document.createElement('span');
        hb.className = 'hbadge ' + (hol.type === 'holiday' ? 'h' : 'w');
        hb.textContent = hol.type === 'holiday' ? '休' : '班';
        hb.title = hol.name;
        cell.appendChild(hb);
      }

      if (sh) {
        const tag = document.createElement('span');
        tag.className = 'dtag';
        tag.textContent = sh.start ? sh.start : sh.name;
        cell.appendChild(tag);
        if (sh.alarm && sh.start) {
          const dot = document.createElement('i');
          dot.className = 'adot';
          cell.appendChild(dot);
        }
      }
      cell.addEventListener('click', () => onDayTap(key, d));
      grid.appendChild(cell);
    }
    renderLegend();
  }

  function renderLegend() {
    const box = $('#legend');
    box.innerHTML = '';
    S.shifts.forEach((s) => {
      const el = document.createElement('span');
      el.className = 'lg';
      el.innerHTML = '<i style="background:' + s.color + '"></i>' + s.name +
        (s.start ? ' ' + s.start + (s.alarm ? ' 🔔' : '') : '');
      box.appendChild(el);
    });
  }

  function onDayTap(key, d) {
    if (paintShift) {
      if (S.schedule[key] === paintShift) delete S.schedule[key];
      else S.schedule[key] = paintShift;
      delete S.fired[key];
      save(); renderAll();
      return;
    }
    pickDate = key;
    $('#sheetDate').textContent = (d.getMonth() + 1) + '月' + d.getDate() + '日 · 星期' +
      ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    renderPicker();
    openSheet('#sheetShift');
  }

  /* ================= 渲染：班次选择抽屉 ================= */
  function renderPicker() {
    const box = $('#shiftPicker');
    box.innerHTML = '';
    const cur = S.schedule[pickDate];

    S.shifts.forEach((s) => {
      const b = document.createElement('button');
      b.className = 'sp' + (cur === s.id ? ' on' : '');
      if (cur === s.id) {
        b.style.background = 'linear-gradient(140deg,' + hex2rgba(s.color, .6) + ',' + hex2rgba(s.color, .22) + ')';
      }
      b.innerHTML = '<span class="sp-dot" style="background:' + s.color + '"></span>' +
        '<span class="sp-txt"><strong>' + esc(s.name) + '</strong><small>' +
        (s.start ? s.start + (s.alarm ? ' · 闹钟 ' + minusLead(s.start) : ' · 无闹钟') : '不上班') +
        '</small></span>';
      b.addEventListener('click', () => {
        S.schedule[pickDate] = s.id;
        delete S.fired[pickDate];
        save(); renderPicker(); renderAll();
      });
      box.appendChild(b);
    });

    const clr = document.createElement('button');
    clr.className = 'sp';
    clr.innerHTML = '<span class="sp-dot" style="background:#555a78"></span><span class="sp-txt"><strong>清除</strong><small>取消这天的安排</small></span>';
    clr.addEventListener('click', () => {
      delete S.schedule[pickDate];
      delete S.fired[pickDate];
      save(); renderPicker(); renderAll();
    });
    box.appendChild(clr);

    const sh = shiftOf(pickDate);
    const a = sh ? alarmAt(pickDate, sh) : null;
    $('#sheetPreview').innerHTML = a
      ? '这天 <b>' + sh.start + '</b> 上班，闹钟将在 <b>' + hhmm(a) + '</b> 响'
      : (sh ? '这天不设闹钟' : '还没有选择班次');
  }
  function minusLead(hm) {
    const t = hm.split(':');
    let m = (+t[0]) * 60 + (+t[1]) - S.leadMinutes;
    if (m < 0) m += 1440;
    return pad(Math.floor(m / 60)) + ':' + pad(m % 60);
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  /* ================= 节假日（2026，国务院办公厅官方） ================= */
  const HOLIDAYS = {};
  [
    ['元旦', '2026-01-01', '2026-01-03'],
    ['春节', '2026-02-15', '2026-02-23'],
    ['清明', '2026-04-04', '2026-04-06'],
    ['劳动节', '2026-05-01', '2026-05-05'],
    ['端午节', '2026-06-19', '2026-06-21'],
    ['中秋节', '2026-09-25', '2026-09-27'],
    ['国庆节', '2026-10-01', '2026-10-07']
  ].forEach(([name, a, b]) => {
    let d = parseYmd(a), e = parseYmd(b);
    while (d <= e) { HOLIDAYS[ymd(d)] = { type: 'holiday', name }; d.setDate(d.getDate() + 1); }
  });
  [
    ['元旦', '2026-01-04'], ['春节', '2026-02-14'], ['春节', '2026-02-28'],
    ['劳动节', '2026-05-09'], ['中秋节', '2026-09-20'], ['国庆节', '2026-10-10']
  ].forEach(([name, day]) => { HOLIDAYS[day] = { type: 'work', name }; });
  function holidayOf(key) { return HOLIDAYS[key] || null; }

  /* ================= 天气（Open-Meteo，免密钥 / 前端直连） ================= */
  const WMO = { 0: '晴', 1: '大致晴朗', 2: '局部多云', 3: '阴', 45: '雾', 48: '雾凇', 51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨',
    56: '冻毛毛雨', 57: '冻毛毛雨', 61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨', 71: '小雪', 73: '中雪', 75: '大雪',
    77: '米雪', 80: '阵雨', 81: '阵雨', 82: '强阵雨', 85: '阵雪', 86: '阵雪', 95: '雷阵雨', 96: '雷阵雨冰雹', 99: '雷阵雨冰雹' };
  const WMO_ICO = { 0: '☀️', 1: '🌤️', 2: '⛅️', 3: '☁️', 45: '🌫️', 48: '🌫️', 51: '🌦️', 53: '🌦️', 55: '🌧️', 56: '🌧️', 57: '🌧️',
    61: '🌧️', 63: '🌧️', 65: '🌧️', 66: '🌧️', 67: '🌧️', 71: '🌨️', 73: '🌨️', 75: '❄️', 77: '🌨️', 80: '🌦️', 81: '🌦️', 82: '⛈️',
    85: '🌨️', 86: '🌨️', 95: '⛈️', 96: '⛈️', 99: '⛈️' };
  function weatherTip(code, temp) {
    if ([95, 96, 99].includes(code)) return '有雷阵雨，注意防雷避雨 ⛈️';
    if ([71, 73, 75, 77, 85, 86].includes(code)) return '有降雪，注意保暖防滑 ❄️';
    if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return '今天有雨，记得带伞 ☔';
    if ([45, 48].includes(code)) return '有雾，出行注意能见度 🌫️';
    if (temp >= 33) return '高温暴晒，多喝水、注意防晒 🥵';
    if (temp <= 5) return '气温偏低，记得添衣保暖 🧥';
    if (temp >= 28) return '天气较热，注意防暑补水 🌞';
    return '天气不错，注意劳逸结合 ☀️';
  }

  let todayWeather = null;   // 当前天气对象 {city,temp,code,hi,lo}

  function loadWeatherCache() {
    try {
      const raw = localStorage.getItem('shiftWeather.v1');
      if (raw) { const d = JSON.parse(raw); if (d.date === ymd(new Date())) todayWeather = d.w; }
    } catch (e) { /* ignore */ }
  }
  function saveWeatherCache(w) {
    try { localStorage.setItem('shiftWeather.v1', JSON.stringify({ date: ymd(new Date()), w: w })); } catch (e) { /* ignore */ }
  }
  function geocode(city) {
    return fetch('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(city) + '&count=1&language=zh')
      .then((r) => r.json()).then((d) => {
        if (!d.results || !d.results.length) throw new Error('no city');
        const r0 = d.results[0];
        return { lat: r0.latitude, lon: r0.longitude, name: r0.name };
      });
  }
  function getCoords() {
    return new Promise((resolve, reject) => {
      if (S.lat && S.lon) return resolve({ lat: S.lat, lon: S.lon, name: S.city || '已设城市' });
      if (S.city) { geocode(S.city).then(resolve).catch(reject); return; }
      if (!navigator.geolocation) { geocode('上海').then(resolve).catch(reject); return; }
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, name: '当前位置' }),
        () => geocode('上海').then(resolve).catch(reject),
        { timeout: 8000, maximumAge: 600000 }
      );
    });
  }
  function fetchWeather() {
    getCoords().then((c) => {
      const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + c.lat + '&longitude=' + c.lon +
        '&current=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto';
      return fetch(url).then((r) => r.json()).then((d) => {
        const w = {
          city: c.name,
          temp: Math.round(d.current.temperature_2m),
          code: d.current.weather_code,
          hi: Math.round(d.daily.temperature_2m_max[0]),
          lo: Math.round(d.daily.temperature_2m_min[0])
        };
        todayWeather = w; saveWeatherCache(w); renderWeather(); renderToday();
      });
    }).catch(() => { toast('天气获取失败，可在设置里手动填城市'); });
  }
  function renderWeather() {
    if (!todayWeather) {
      $('#wCity').textContent = '点刷新获取天气';
      $('#wTemp').textContent = '--°';
      $('#wCond').textContent = '--';
      $('#wHiLo').textContent = '--/--';
      $('#wIco').textContent = '🌤️';
      return;
    }
    const w = todayWeather;
    $('#wCity').textContent = w.city;
    $('#wTemp').textContent = w.temp + '°';
    $('#wCond').textContent = (WMO[w.code] || '未知');
    $('#wHiLo').textContent = w.hi + '°/' + w.lo + '°';
    $('#wIco').textContent = WMO_ICO[w.code] || '🌡️';
  }

  /* 今日贴心提醒（同时用于退出通知） */
  function renderToday() {
    const today = ymd(new Date());
    const sh = shiftOf(today);
    if (!sh) $('#tipShift').textContent = '💼 今天未排班';
    else if (!sh.start) $('#tipShift').textContent = '💼 今天休息（' + sh.name + '）';
    else {
      const a = alarmAt(today, sh);
      $('#tipShift').textContent = '💼 ' + sh.name + ' ' + sh.start + ' 上班' + (a ? '，闹钟 ' + hhmm(a) : '');
    }
    if (todayWeather) {
      $('#tipWeather').textContent = '🌤 ' + todayWeather.city + ' ' + todayWeather.temp + '° ' +
        (WMO[todayWeather.code] || '') + '：' + weatherTip(todayWeather.code, todayWeather.temp);
    } else $('#tipWeather').textContent = '🌤 天气加载中…';
    const hol = holidayOf(today);
    if (hol) {
      if (hol.type === 'holiday') $('#tipHoliday').textContent = '🎉 今天是' + hol.name + '，放假休息～';
      else $('#tipHoliday').textContent = '⚠️ 今天' + hol.name + '调休上班，别忘啦';
    } else $('#tipHoliday').textContent = '🎉 今天无特殊节假日';
  }
  function buildDailySummary() {
    const today = ymd(new Date());
    const sh = shiftOf(today);
    const lines = [];
    if (!sh) lines.push('💼 今天未排班');
    else if (!sh.start) lines.push('💼 今天休息（' + sh.name + '）');
    else { const a = alarmAt(today, sh); lines.push('💼 ' + sh.name + ' ' + sh.start + ' 上班' + (a ? '，闹钟 ' + hhmm(a) : '')); }
    if (todayWeather) lines.push('🌤 ' + todayWeather.city + ' ' + todayWeather.temp + '° ' +
      (WMO[todayWeather.code] || '') + '：' + weatherTip(todayWeather.code, todayWeather.temp));
    else lines.push('🌤 天气未获取');
    const hol = holidayOf(today);
    if (hol) lines.push(hol.type === 'holiday' ? '🎉 今天是' + hol.name + '，放假休息～' : '⚠️ 今天' + hol.name + '调休上班，别忘啦');
    else lines.push('🎉 今天无特殊节假日');
    return lines;
  }

  /* 退出 / 切后台时，通过 Service Worker 弹通知（锁屏可见） */
  let exitNotified = false;
  function notifyOnExit() {
    if (exitNotified) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const now = Date.now();
    if (S.lastExit && now - S.lastExit < 120000) return;   // 2 分钟内不重复
    const d = new Date();
    const title = '今日提醒 · ' + (d.getMonth() + 1) + '/' + d.getDate();
    sendSWNotification(title, buildDailySummary().join('\n'));
    S.lastExit = now; save();
    exitNotified = true;
  }
  function sendSWNotification(title, body) {
    if (navigator.serviceWorker && navigator.serviceWorker.ready) {
      navigator.serviceWorker.ready.then((reg) => {
        reg.showNotification(title, { body: body, tag: 'daily-reminder', requireInteraction: false });
      }).catch(() => fallbackNotify(title, body));
    } else fallbackNotify(title, body);
  }
  function fallbackNotify(title, body) {
    try { new Notification(title, { body: body, tag: 'daily-reminder' }); } catch (e) { /* ignore */ }
  }

  /* ================= 渲染：闹钟列表 ================= */
  function renderAlarmList() {
    const list = upcomingAlarms(30).slice(0, 8);
    const box = $('#alarmList');
    $('#alarmCount').textContent = upcomingAlarms(30).length;
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = '<p class="empty-txt">还没有安排闹钟<br>点日历上的日期开始排班</p>';
      return;
    }
    const today = ymd(new Date());
    list.forEach((it) => {
      const el = document.createElement('div');
      el.className = 'al';
      const wk = ['日', '一', '二', '三', '四', '五', '六'][it.date.getDay()];
      const dLabel = it.key === today ? '今天' : (it.date.getMonth() + 1) + '月' + it.date.getDate() + '日 周' + wk;
      el.innerHTML =
        '<span class="al-bar" style="background:' + it.shift.color + '"></span>' +
        '<span class="al-main"><span class="al-d">' + dLabel + '</span>' +
        '<span class="al-s">' + esc(it.shift.name) + ' · ' + it.shift.start + ' 上班</span></span>' +
        '<span class="al-t"><b>' + hhmm(it.time) + '</b><small>提前 ' + S.leadMinutes + ' 分</small></span>';
      box.appendChild(el);
    });
  }

  /* ================= 渲染：连点条 ================= */
  function renderPaint() {
    const box = $('#paintChips');
    box.innerHTML = '';
    S.shifts.forEach((s) => {
      const c = document.createElement('button');
      c.className = 'chip' + (paintShift === s.id ? ' on' : '');
      if (paintShift === s.id) c.style.background = 'linear-gradient(135deg,' + s.color + ',' + hex2rgba(s.color, .55) + ')';
      c.textContent = s.name;
      c.addEventListener('click', () => {
        paintShift = paintShift === s.id ? null : s.id;
        renderPaint();
      });
      box.appendChild(c);
    });
    $('#paintHint').textContent = paintShift
      ? '连点模式：开 · 点日期直接刷「' + getShift(paintShift).name + '」，再点一次取消'
      : '连点模式：关 · 选一个班次可批量刷班';
  }

  function renderAll() {
    renderHero();
    renderCalendar();
    renderAlarmList();
    renderPaint();
    renderWeather();
    renderToday();
    scheduleNextAlarm();
  }

  /* ================= 底部导航：视图切换 ================= */
  let curView = 'home';
  function switchView(name) {
    curView = name;
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
    $$('.nav-tab').forEach((t) => t.classList.toggle('on', t.dataset.view === name));
    if (name === 'settings') renderSettings();
    if (name === 'schedule') { renderCalendar(); renderAlarmList(); renderPaint(); }
    if (name === 'home') { renderHero(); renderCountdown(); }
    window.scrollTo(0, 0);
  }
  $$('.nav-tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));

  /* ================= 抽屉控制 ================= */
  function openSheet(sel) {
    $('#mask').classList.add('on');
    $(sel).classList.add('on');
  }
  function closeSheets() {
    $('#mask').classList.remove('on');
    $$('.sheet').forEach((s) => s.classList.remove('on'));
  }
  $('#mask').addEventListener('click', closeSheets);
  $('#sheetClose').addEventListener('click', closeSheets);
  $('#impClose').addEventListener('click', closeSheets);

  /* ================= 设置 ================= */
  function renderSettings() {
    $('#cityInput').value = S.city || '';
    $('#leadRange').value = S.leadMinutes;
    $('#leadVal').textContent = S.leadMinutes + ' 分钟';
    $('#leadExample').textContent = minusLead('14:00');

    const box = $('#shiftEditor');
    box.innerHTML = '';
    S.shifts.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'se' + (s.start ? '' : ' off');
      row.innerHTML =
        '<input type="color" value="' + s.color + '">' +
        '<input type="text" value="' + esc(s.name) + '" maxlength="8">' +
        '<input type="time" value="' + (s.start || '') + '">' +
        '<button class="del">✕</button>';
      const [color, name, time, del] = [row.children[0], row.children[1], row.children[2], row.children[3]];
      color.addEventListener('input', () => { s.color = color.value; save(); renderCalendar(); renderLegend(); });
      name.addEventListener('input', () => { s.name = name.value || '班次'; save(); });
      name.addEventListener('blur', () => { renderAll(); });
      time.addEventListener('change', () => {
        s.start = time.value;
        s.alarm = !!time.value;
        row.classList.toggle('off', !time.value);
        save(); renderAll();
      });
      del.addEventListener('click', () => {
        if (S.shifts.length <= 1) { toast('至少保留一个班次'); return; }
        if (!confirm('删除「' + s.name + '」？已排的这些天会被清空')) return;
        Object.keys(S.schedule).forEach((k) => { if (S.schedule[k] === s.id) delete S.schedule[k]; });
        S.shifts.splice(i, 1);
        if (paintShift === s.id) paintShift = null;
        save(); renderSettings(); renderAll();
      });
      box.appendChild(row);
    });
  }

  $('#btnSettings').addEventListener('click', () => switchView('settings'));
  $('#btnWeatherRefresh').addEventListener('click', () => { fetchWeather(); toast('正在获取天气…'); });
  $('#citySave').addEventListener('click', () => {
    const v = $('#cityInput').value.trim();
    if (!v) { toast('请输入城市名'); return; }
    S.city = v; S.lat = null; S.lon = null; save();
    fetchWeather(); toast('已切换城市：' + v);
  });
  $('#leadRange').addEventListener('input', (e) => {
    S.leadMinutes = +e.target.value;
    $('#leadVal').textContent = S.leadMinutes + ' 分钟';
    $('#leadExample').textContent = minusLead('14:00');
    save(); renderHero(); renderAlarmList();
  });
  $('#btnAddShift').addEventListener('click', () => {
    const colors = ['#34d399', '#fb7185', '#60a5fa', '#fbbf24', '#a78bfa', '#f472b6'];
    S.shifts.push({
      id: 's' + Date.now().toString(36),
      name: '新班次', start: '09:00', end: '', alarm: true,
      color: colors[S.shifts.length % colors.length]
    });
    save(); renderSettings(); renderAll();
  });
  $('#btnClear').addEventListener('click', () => {
    if (!confirm('清空所有已排的班次？班次设置会保留')) return;
    S.schedule = {}; S.fired = {};
    save(); renderAll(); toast('已清空排班');
  });
  // 彻底清除：排班 + 班次设置 + Service Worker 缓存，全部清空并重置
  $('#btnWipe').addEventListener('click', () => {
    if (!confirm('彻底清除全部数据并重置为初始状态？\n（排班、班次设置、本地缓存都会清空）')) return;
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
        navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister()));
      }
    } catch (e) { /* ignore */ }
    try { localStorage.clear(); } catch (e) { /* ignore */ }
    toast('已彻底清除，正在重新加载…');
    setTimeout(() => location.reload(true), 500);
  });
  $('#btnBackup').addEventListener('click', () => {
    download('shift-backup-' + ymd(new Date()) + '.json',
      JSON.stringify(S, null, 2), 'application/json');
    toast('备份已导出');
  });
  $('#btnRestore').addEventListener('click', () => { closeSheets(); setTimeout(() => { switchTab('file'); openSheet('#sheetImport'); }, 260); });

  /* ================= 日历导航 ================= */
  $('#prevMonth').addEventListener('click', () => {
    viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; } renderCalendar();
  });
  $('#nextMonth').addEventListener('click', () => {
    viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; } renderCalendar();
  });
  $('#btnToday').addEventListener('click', () => {
    const n = new Date(); viewYear = n.getFullYear(); viewMonth = n.getMonth(); renderCalendar();
  });

  /* ================= 导入 ================= */
  $('#btnImport').addEventListener('click', () => {
    const n = new Date();
    $('#importMonth').value = n.getFullYear() + '-' + pad(n.getMonth() + 1);
    $('#cycStart').value = ymd(n);
    renderCycChips();
    $('#importPreview').hidden = true;
    pendingImport = null;
    openSheet('#sheetImport');
  });
  function switchTab(name) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $$('.tab-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
  }
  $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  /** 关键词 → 班次 */
  function matchShift(word) {
    if (!word) return null;
    const w = word.trim().toLowerCase();
    let hit = S.shifts.find((s) => s.name.toLowerCase() === w || s.id.toLowerCase() === w);
    if (hit) return hit;
    hit = S.shifts.find((s) => w.indexOf(s.name.toLowerCase()) >= 0 || s.name.toLowerCase().indexOf(w) >= 0);
    if (hit) return hit;
    const alias = {
      '早': ['上午', '早'], '上午': ['上午', '早'], 'am': ['上午', '早'], '白': ['上午', '早', '白'],
      '中': ['中', '下午'], '下午': ['下午', '中'], 'pm': ['下午', '中'],
      '晚': ['晚', '夜'], '夜': ['夜', '晚'], 'night': ['晚', '夜'],
      '休': ['休'], 'off': ['休'], '休息': ['休']
    };
    const keys = alias[w];
    if (keys) {
      for (const k of keys) {
        const f = S.shifts.find((s) => s.name.indexOf(k) >= 0);
        if (f) return f;
      }
    }
    return null;
  }

  function parseScheduleText(text, defYear, defMonth) {
    const res = [];
    text.split(/[\n\r]+/).forEach((raw) => {
      let line = raw.trim();
      if (!line) return;
      line = line.replace(/[,，、\t|]+/g, ' ').replace(/\s+/g, ' ');
      let y = defYear, m = defMonth, d = null, rest = line;

      let mt = line.match(/^(\d{4})[-\/.年](\d{1,2})[-\/.月](\d{1,2})日?\s*(.*)$/);
      if (mt) { y = +mt[1]; m = +mt[2]; d = +mt[3]; rest = mt[4]; }
      else if ((mt = line.match(/^(\d{1,2})[-\/.月](\d{1,2})日?\s*(.*)$/))) { m = +mt[1]; d = +mt[2]; rest = mt[3]; }
      else if ((mt = line.match(/^(\d{1,2})日?\s*(.*)$/))) { d = +mt[1]; rest = mt[2]; }
      if (!d || d < 1 || d > 31) return;

      const sh = matchShift(rest);
      if (!sh) return;
      const key = y + '-' + pad(m) + '-' + pad(d);
      res.push({ key: key, shift: sh });
    });
    return res;
  }

  $('#btnParseText').addEventListener('click', () => {
    const mv = ($('#importMonth').value || '').split('-');
    const now = new Date();
    const y = mv[0] ? +mv[0] : now.getFullYear();
    const m = mv[1] ? +mv[1] : now.getMonth() + 1;
    const rows = parseScheduleText($('#importText').value, y, m);
    if (!rows.length) { toast('没解析到有效行，检查格式或班次名'); return; }
    showPreview(rows);
  });

  /* 循环规则 */
  function renderCycChips() {
    const box = $('#cycChips');
    box.innerHTML = '';
    S.shifts.forEach((s) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = '+ ' + s.name;
      b.addEventListener('click', () => { cycleSeq.push(s.id); renderCycSeq(); });
      box.appendChild(b);
    });
    renderCycSeq();
  }
  function renderCycSeq() {
    const box = $('#cycSeq');
    if (!cycleSeq.length) { box.innerHTML = '<span class="empty">还没有添加班次</span>'; return; }
    box.innerHTML = '';
    cycleSeq.forEach((id, i) => {
      const s = getShift(id);
      const el = document.createElement('span');
      el.className = 'seq-i';
      el.style.background = 'linear-gradient(135deg,' + s.color + ',' + hex2rgba(s.color, .6) + ')';
      el.textContent = (i + 1) + '.' + s.name;
      box.appendChild(el);
    });
  }
  $('#cycUndo').addEventListener('click', () => { cycleSeq.pop(); renderCycSeq(); });
  $('#cycClear').addEventListener('click', () => {
    cycleSeq = []; renderCycSeq();
    importBuffer = []; importPreviewMode = null;
    $('#importPreview').hidden = true; $('#prevList').innerHTML = ''; $('#prevCount').textContent = '0 天';
  });
  $('#btnCycGen').addEventListener('click', () => {
    if (!cycleSeq.length) { toast('先添加循环顺序'); return; }
    const sv = $('#cycStart').value;
    if (!sv) { toast('请选择起始日期'); return; }
    const days = Math.min(366, Math.max(1, +$('#cycDays').value || 30));
    const st = parseYmd(sv);
    const rows = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(st.getFullYear(), st.getMonth(), st.getDate() + i);
      rows.push({ key: ymd(d), shift: getShift(cycleSeq[i % cycleSeq.length]) });
    }
    showPreview(rows);
  });

  /* 文件导入 */
  $('#btnPickFile').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      const txt = String(r.result);
      if (/\.json$/i.test(f.name)) {
        try {
          const d = JSON.parse(txt);
          if (!d.schedule) throw 0;
          S = Object.assign(JSON.parse(JSON.stringify(DEFAULT)), d);
          save(); closeSheets(); renderAll();
          toast('备份已恢复');
        } catch (err) { toast('不是有效的备份文件'); }
        return;
      }
      const n = new Date();
      const rows = parseScheduleText(txt, n.getFullYear(), n.getMonth() + 1);
      if (!rows.length) { toast('没解析到有效行'); return; }
      showPreview(rows);
    };
    r.readAsText(f, 'utf-8');
    e.target.value = '';
  });

  function showPreview(rows) {
    pendingImport = rows;
    $('#importPreview').hidden = false;
    $('#prevCount').textContent = rows.length + ' 天';
    const box = $('#prevList');
    box.innerHTML = '';
    rows.slice(0, 60).forEach((r) => {
      const el = document.createElement('div');
      el.className = 'pv';
      const d = parseYmd(r.key);
      el.innerHTML = '<span>' + (d.getMonth() + 1) + '/' + d.getDate() + '</span>' +
        '<span style="color:' + r.shift.color + '">' + esc(r.shift.name) +
        (r.shift.start ? ' ' + r.shift.start : '') + '</span>';
      box.appendChild(el);
    });
    if (rows.length > 60) {
      const el = document.createElement('div');
      el.className = 'pv';
      el.innerHTML = '<span>…</span><span>共 ' + rows.length + ' 天</span>';
      box.appendChild(el);
    }
    $('#importPreview').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  $('#btnApplyImport').addEventListener('click', () => {
    if (!pendingImport) return;
    pendingImport.forEach((r) => { S.schedule[r.key] = r.shift.id; delete S.fired[r.key]; });
    save(); closeSheets(); renderAll();
    toast('已导入 ' + pendingImport.length + ' 天排班');
    pendingImport = null;
  });

  /* ================= 导出 ICS ================= */
  function icsTime(d) {
    // floating local time（无 TZID），日历导入用
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + 'T' +
      pad(d.getHours()) + pad(d.getMinutes()) + '00';
  }
  function icsTimeUTC(d) {
    // Apple 原生 UTC 格式，提醒事项解析最稳
    return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' +
      pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
  }
  function icsStamp() {
    const d = new Date();
    return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' +
      pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
  }
  function fold(line) {
    if (line.length <= 74) return line;
    let out = line.slice(0, 74);
    let rest = line.slice(74);
    while (rest.length) { out += '\r\n ' + rest.slice(0, 73); rest = rest.slice(73); }
    return out;
  }

  function download(name, content, type) {
    try {
      const blob = new Blob([content], { type: type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
    } catch (e) { toast('当前环境不支持下载'); }
  }

  /* ================= 闹钟 ================= */
  /* ================= 闹钟（前台持续响铃，直到手动停止） ================= */
  let ringing = false;
  let ringLoopTimer = null;
  let wakeLock = null;

  function ensureAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { /* ignore */ }
  }

  /** 短试听音（设置页切换铃声用） */
  function beep() {
    ensureAudio();
    try {
      const t0 = audioCtx.currentTime;
      const tone = S.ringTone || 'default';
      const presets = {
        default: [880, 1170],
        urgent: [1046, 1318, 1568],
        triple: [660, 880, 1046],
        lull: [392, 392]
      };
      const notes = presets[tone] || presets.default;
      const step = (tone === 'urgent') ? 0.14 : 0.26;
      notes.forEach((f, i) => {
        const off = i * step;
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(f, t0 + off);
        g.gain.setValueAtTime(0.0001, t0 + off);
        g.gain.exponentialRampToValueAtTime(0.32, t0 + off + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + off + step * 0.9);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(t0 + off); o.stop(t0 + off + step);
      });
    } catch (e) { /* ignore */ }
  }

  /** 持续响铃：循环警笛 + 振动 + 保持屏幕常亮，直到手动停止。仅在前台有效。 */
  function startRinging() {
    if (ringing) return;
    ringing = true;
    ensureAudio();
    const ctx = audioCtx;
    const preset = S.ringTone || 'default';

    const playCycle = () => {
      if (!ringing) return;
      ensureAudio();   // 若被系统暂停，每次循环尝试恢复
      try {
        const now = ctx.currentTime;
        if (preset === 'lull') {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.type = 'sawtooth'; o.frequency.value = 300;
          o.connect(g); g.connect(ctx.destination);
          g.gain.setValueAtTime(0.0001, now);
          g.gain.exponentialRampToValueAtTime(0.35, now + 0.05);
          g.gain.setValueAtTime(0.35, now + 1.15);
          g.gain.exponentialRampToValueAtTime(0.0001, now + 1.35);
          o.start(now); o.stop(now + 1.4);
        } else if (preset === 'triple') {
          [660, 880, 1046].forEach((f, i) => {
            const o = ctx.createOscillator(), g = ctx.createGain();
            o.type = 'square'; o.frequency.value = f;
            o.connect(g); g.connect(ctx.destination);
            const st = now + i * 0.18;
            g.gain.setValueAtTime(0.0001, st);
            g.gain.exponentialRampToValueAtTime(0.33, st + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, st + 0.16);
            o.start(st); o.stop(st + 0.18);
          });
        } else {
          const base = preset === 'urgent' ? 1000 : 740;
          const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain();
          o1.type = 'square'; o2.type = 'square';
          o1.connect(g); o2.connect(g); g.connect(ctx.destination);
          g.gain.setValueAtTime(0.0001, now);
          const peak = preset === 'urgent' ? 0.42 : 0.36;
          g.gain.exponentialRampToValueAtTime(peak, now + 0.04);
          o1.frequency.setValueAtTime(base, now);
          o1.frequency.linearRampToValueAtTime(base * 1.6, now + 0.45);
          o1.frequency.linearRampToValueAtTime(base, now + 0.9);
          o2.frequency.setValueAtTime(base * 1.5, now);
          o2.frequency.linearRampToValueAtTime(base * 2.2, now + 0.45);
          o2.frequency.linearRampToValueAtTime(base * 1.5, now + 0.9);
          g.gain.setValueAtTime(peak, now + 0.85);
          g.gain.exponentialRampToValueAtTime(0.0001, now + 0.95);
          o1.start(now); o2.start(now); o1.stop(now + 1.0); o2.stop(now + 1.0);
        }
      } catch (e) { /* ignore */ }
      if (navigator.vibrate) {
        try { navigator.vibrate(preset === 'urgent' ? [220, 60, 220, 60, 220] : [420, 120, 420, 120, 420]); } catch (e) {}
      }
    };

    playCycle();
    ringLoopTimer = setInterval(playCycle, preset === 'urgent' ? 850 : 1000);
    requestWakeLock();
    document.body.classList.add('alarm-ringing');
  }

  function stopRinging() {
    ringing = false;
    clearInterval(ringLoopTimer);
    ringLoopTimer = null;
    try { if (audioCtx) audioCtx.suspend(); } catch (e) {}
    document.body.classList.remove('alarm-ringing');
    releaseWakeLock();
  }

  async function requestWakeLock() {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* ignore */ }
  }
  function releaseWakeLock() {
    try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (e) {}
  }

  function fireAlarm(item) {
    $('#alarmTitle').textContent = '⏰ 该准备上班了';
    $('#alarmSub').textContent = item.shift.start + ' ' + item.shift.name + ' · 提前 ' + S.leadMinutes + ' 分钟';
    $('#alarmNow').textContent = hhmm(new Date());
    $('#alarmOverlay').classList.add('on');
    startRinging();
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification('该准备上班了 🔔', {
          body: item.shift.name + ' ' + item.shift.start + ' 上班，还有 ' + S.leadMinutes + ' 分钟',
          tag: 'shift-' + item.key, requireInteraction: true
        });
      } catch (e) { /* ignore */ }
    }
  }
  $('#btnStopAlarm').addEventListener('click', () => {
    $('#alarmOverlay').classList.remove('on');
    stopRinging();
  });
  $('#btnClock').addEventListener('click', () => { openSheet('#sheetClock'); });
  $('#clockClose').addEventListener('click', closeSheets);

  /* ================= 一键加闹钟快捷指令（.shortcut） =================
     iOS「创建闹钟」动作只能设置时间（HH:MM），不能指定具体日期，
     因此这里按未来 7 天的排班生成多个 Add Alarm 动作，运行一次全部加入时钟 App。
     文件格式：Apple 二进制 plist（bplist00）。 */
  /* ================= 批量创建提醒事项（绕过 iOS 不支持 .ics 批量导入）=================
     iPhone 直接导入 .ics 到「提醒事项」通常只能得到一条，或只把文件当附件（截图就是）。
     真正能一次创建 N 条提醒事项的方法是：在「快捷指令」App 里建一个简单捷径，
     读取我们生成的文本清单，循环「添加提醒事项」。这里生成该清单。
     每行格式：YYYY/MM/DD HH:MM | 标题 | 备注（| 竖线分隔，iOS 26 没有制表符预设，用竖线最好输入）。
     注意：和网页闹钟清单共用 upcomingAlarms() 数据源，保证网页看到几条，剪贴板就几条。
   */
  const BATCH_SHORTCUT_NAME = '批量添加排班提醒';
  function buildRemindersList() {
    const lines = [];
    upcomingAlarms(30).forEach((it) => {
      const a = it.time;
      const y = a.getFullYear();
      const m = pad(a.getMonth() + 1);
      const d = pad(a.getDate());
      const hh = pad(a.getHours());
      const mm = pad(a.getMinutes());
      const datetime = y + '/' + m + '/' + d + ' ' + hh + ':' + mm; // iOS 中文系统最容易识别的日期时间格式
      const title = '【班次闹钟】' + it.shift.name + ' ' + it.shift.start + ' 上班 · 准备';
      const note = '提前 ' + S.leadMinutes + ' 分钟提醒 · 由班次闹钟工作台生成';
      lines.push([datetime, title, note].join(' | '));
    });
    return lines.join('\n');
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    toast(ok ? '已复制 ' + text.split('\n').length + ' 条提醒清单' : '复制失败，请用「下载清单」方式');
  }

  function runBatchShortcut() {
    const text = buildRemindersList();
    if (!text) { toast('还没有可生成的提醒事项'); return; }
    const doOpen = () => {
      const url = 'shortcuts://run-shortcut?name=' + encodeURIComponent(BATCH_SHORTCUT_NAME);
      const a = document.createElement('a');
      a.href = url; a.style.display = 'none';
      document.body.appendChild(a);
      try { a.click(); } catch (e) {}
      setTimeout(() => a.remove(), 600);
    };
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        toast('已复制 ' + text.split('\n').length + ' 条 · 正在唤起快捷指令…');
        doOpen();
      }).catch(() => {
        fallbackCopy(text);
        doOpen();
      });
    } else {
      fallbackCopy(text);
      doOpen();
    }
  }

  $('#btnRunRemindersShortcut').addEventListener('click', runBatchShortcut);

  function scheduleNextAlarm() {
    clearTimeout(alarmTimer);
    const now = new Date();
    const list = upcomingAlarms(3).filter((it) => !S.fired[it.key]);
    if (!list.length) return;
    const next = list[0];
    let ms = next.time - now;
    if (ms < 0) ms = 0;
    if (ms > 1800000) ms = 1800000;      // 最多 30 分钟后重新评估
    alarmTimer = setTimeout(() => {
      const t = new Date();
      if (t >= next.time && t - next.time < 300000 && !S.fired[next.key]) {
        S.fired[next.key] = true; save();
        fireAlarm(next);
      }
      scheduleNextAlarm();
    }, ms + 500);
  }

  /* ================= 启动 ================= */
  function init() {
    const n = new Date();
    viewYear = n.getFullYear();
    viewMonth = n.getMonth();
    loadWeatherCache();
    renderAll();
    switchView('home');
    fetchWeather();   // 后台刷新天气

    setInterval(() => { renderHero(); }, 30000);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { notifyOnExit(); }
      else { exitNotified = false; renderAll(); }
    });
    window.addEventListener('pagehide', () => { notifyOnExit(); });
    // 解锁音频（iOS 需用户手势）
    document.addEventListener('touchstart', function unlock() {
      try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
      } catch (e) {}
      document.removeEventListener('touchstart', unlock);
    }, { passive: true });

    // 单文件 / file:// 模式下没有 sw.js，也无法注册，直接跳过
    if ('serviceWorker' in navigator &&
        location.protocol !== 'file:' &&
        !window.__SINGLE_FILE__) {
      navigator.serviceWorker.register('sw.js', { scope: './' })
        .then((reg) => {
          // 若已有新版在等待，立即激活
          if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          // 下次检测到新版本时，安装完自动跳过等待，立即接管
          reg.addEventListener('updatefound', () => {
            const nw = reg.installing;
            if (nw) nw.addEventListener('statechange', () => {
              if (nw.state === 'installed' && navigator.serviceWorker.controller) {
                nw.postMessage({ type: 'SKIP_WAITING' });
              }
            });
          });
        })
        .catch(() => {});
    }
  }
  init();
})();
