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
    theme: 'aurora',       // aurora / sunset / ocean / mono / custom
    themeCustom: '#7c5cff',// 自定义主题色（取色器选中的主色）
    bgColor: 'aurora',     // aurora / ocean / sunset / mint / rose / black / custom
    bgCustom: '#0a0717',   // 自定义背景色
    fontScale: 1,          // 字号缩放已下线，保留 1 兼容旧备份
    nightMode: 'off',      // 护眼模式：off / manual / auto
    homeCards: ['hero', 'weather', 'tips', 'care'], // 首页卡片顺序（hero 始终置顶，其余可显隐排序）
    templates: [],         // 班表模板 [{ name, seq:[shiftId,...] }]
    shifts: [
      { id: 'am',    name: '上午班', start: '08:00', end: '12:00', color: '#f59e0b', alarm: true },
      { id: 'pm',    name: '下午班', start: '14:00', end: '18:00', color: '#7c5cff', alarm: true },
      { id: 'night', name: '晚班',   start: '18:00', end: '22:00', color: '#22d3ee', alarm: true },
      { id: 'off',   name: '休息',   start: '',      end: '',      color: '#3f4460', alarm: false }
    ],
    schedule: {},          // { 'YYYY-MM-DD': shiftId }（当前激活班表的工作副本）
    profiles: null,        // 多套班表：{ id: { id, name, schedule } }
    activeProfile: 'main', // 当前激活班表 id
    fired: {},             // { 'YYYY-MM-DD': true } 已响过的闹钟
    onboarded: false       // 是否已看过新手指引
  };

  let S = load();
  migrateProfiles();   // 兼容旧备份：把单班表迁移成多套班表结构
  let viewYear, viewMonth;         // 当前显示的月份
  let pickDate = null;             // 抽屉正在编辑的日期
  let paintShift = null;           // 连点模式选中的班次
  let pendingImport = null;        // 待确认导入的数据
  let cycleSeq = [];               // 循环规则序列
  let importBuffer = null;         // 导入预览缓冲区
  let importPreviewMode = null;    // 当前预览模式
  let alarmTimer = null;
  let audioCtx = null;
  let ringTimer = null;
  let liveEnd = null;       // 当前班次下班时间（用于首页实时倒计时）
  let liveTimer = null;     // 实时倒计时 1s 定时器

  /* ================= 存储 ================= */
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return JSON.parse(JSON.stringify(DEFAULT));
      const d = JSON.parse(raw);
      const merged = Object.assign(JSON.parse(JSON.stringify(DEFAULT)), d);
      // 旧备份可能没有「健康关怀」卡，自动补上，保证新功能对老用户也可见
      if (merged.homeCards && !merged.homeCards.includes('care')) merged.homeCards.push('care');
      return merged;
    } catch (e) {
      return JSON.parse(JSON.stringify(DEFAULT));
    }
  }
  function save() {
    try {
      if (S.profiles && S.activeProfile && S.profiles[S.activeProfile]) {
        S.profiles[S.activeProfile].schedule = S.schedule;   // 同步工作副本回当前班表
      }
      localStorage.setItem(KEY, JSON.stringify(S));
    } catch (e) { toast('保存失败：存储空间不足'); }
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
  /** 下班时间 Date 对象 */
  function endAt(dateStr, sh) {
    if (!sh || !sh.end) return null;
    const d = parseYmd(dateStr);
    const t = sh.end.split(':');
    d.setHours(+t[0], +t[1], 0, 0);
    return d;
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
  /* 由自定义主色生成渐变第二段：转 HSL 后旋转色相，保证饱和度/亮度都在好看区间 */
  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;
    if (max === min) { h = s = 0; }
    else {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        default: h = (r - g) / d + 4; break;
      }
      h /= 6;
    }
    return { h: h * 360, s: s * 100, l: l * 100 };
  }
  function hslToHex(h, s, l) {
    h /= 360; s /= 100; l /= 100;
    const k = (n) => (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const to = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
    return '#' + to(f(0)) + to(f(8)) + to(f(4));
  }
  function rotateHue(hex, deg) {
    const { r, g, b } = hexToRgb(hex || '#7c5cff');
    const hsl = rgbToHsl(r, g, b);
    let h = (hsl.h + deg) % 360; if (h < 0) h += 360;
    const s = Math.max(58, Math.min(92, hsl.s));
    const l = Math.max(46, Math.min(62, hsl.l));
    return hslToHex(h, s, l);
  }

  /* ================= 渲染：Hero ================= */
  function renderHero() {
    const now = new Date();
    const today = ymd(now);
    const wk = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
    $('#heroDate').textContent = (now.getMonth() + 1) + '月' + now.getDate() + '日 · 星期' + wk;

    const hr = now.getHours();
    const greet = hr < 6 ? '夜深了' : hr < 11 ? '早上好' : hr < 14 ? '中午好' : hr < 19 ? '下午好' : '晚上好';
    const emo = hr < 6 ? '🌙' : hr < 11 ? '☀️' : hr < 14 ? '🍱' : hr < 19 ? '☕' : '🌆';
    $('#heroGreet').textContent = emo + ' ' + greet;

    const sh = shiftOf(today);
    if (!sh) {
      $('#heroShift').textContent = '今天未排班';
    } else {
      $('#heroShift').textContent = sh.name;
    }

    // 下次排班信息：今天未排班时显示下一次有班的日期；今天有班时显示今天的上班/闹钟时间
    const nextInfo = nextShiftInfo();
    if (!sh && nextInfo) {
      $('#heroCards').innerHTML =
        '<div class="mini-card wide">' +
          '<span class="mini-label">下次排班</span>' +
          '<span class="mini-value" style="font-size:20px">' + esc(nextInfo.shift.name) + '</span>' +
          '<span class="mini-sub">' + nextInfo.label + ' · ' + (nextInfo.shift.start || '休息') + '</span>' +
        '</div>' +
        '<div class="mini-card accent">' +
          '<span class="mini-label">距离</span>' +
          '<span class="mini-value" style="font-size:20px">' + nextInfo.days + '</span>' +
          '<span class="mini-sub">天后</span>' +
        '</div>';
    } else {
      $('#heroCards').innerHTML =
        '<div class="mini-card">' +
          '<span class="mini-label">上班</span>' +
          '<span class="mini-value" id="heroStart">' + (sh && sh.start ? sh.start : (sh ? '休息' : '--:--')) + '</span>' +
        '</div>' +
        '<div class="mini-card accent">' +
          '<span class="mini-label">闹钟</span>' +
          '<span class="mini-value" id="heroAlarm">' + (sh && sh.start && sh.alarm ? hhmm(alarmAt(today, sh)) : '无') + '</span>' +
        '</div>';
    }
    // 实时下班倒计时：仅当今天有完整上下班时间且当前正处于班次内
    const now0 = new Date();
    if (sh && sh.start && sh.end) {
      const st = startAt(today, sh);
      const en = endAt(today, sh);
      if (st && en && now0 >= st && now0 <= en) {
        liveEnd = en;
        const lc = $('#liveClock'); if (lc) lc.hidden = false;
      } else {
        liveEnd = null;
        const lc = $('#liveClock'); if (lc) lc.hidden = true;
      }
    } else {
      liveEnd = null;
      const lc = $('#liveClock'); if (lc) lc.hidden = true;
    }

    // 下一个休息日
    const rest = nextRestInfo();
    const restEl = $('#restInfo');
    if (restEl) {
      if (!rest) restEl.innerHTML = '<span class="cd-dot rest-dot"></span><span>🗓️ 近 60 天没有休息日，注意身体 ⚠️</span>';
      else if (rest.days === 0) restEl.innerHTML = '<span class="cd-dot rest-dot"></span><span>🎉 今天就是休息日，好好放松</span>';
      else restEl.innerHTML = '<span class="cd-dot rest-dot"></span><span>🛌 距离下一个休息日还有 <b>' + rest.days + '</b> 天（' + rest.label + '）</span>';
    }

    renderCountdown();
    renderWeekStrip();
    renderCare();
  }

  /** 首页实时下班倒计时（每秒刷新文本） */
  function updateLiveClock() {
    const el = $('#liveClockText');
    if (!el) return;
    if (!liveEnd) { const lc = $('#liveClock'); if (lc) lc.hidden = true; return; }
    const ms = liveEnd - new Date();
    if (ms <= 0) { renderHero(); return; }   // 刚下班，重渲染自动隐藏
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const str = h > 0 ? (h + ' 小时 ' + m + ' 分 ' + s + ' 秒') : (m + ' 分 ' + s + ' 秒');
    el.innerHTML = '🟢 上班中 · 还有 <b>' + str + '</b> 下班';
  }

  /** 健康关怀卡片内容 */
  function renderCare() {
    const box = $('#careBody');
    if (!box) return;
    const items = [];
    const streak = workStreak();
    if (streak >= 4) items.push('💪 已连续上班 <b>' + streak + '</b> 天，今晚务必好好休息，别硬撑');
    const sa = sleepAdvice();
    if (sa) items.push('😴 ' + sa.when + ' <b>' + sa.start + '</b> 上班，建议 <b>' + sa.bed + '</b> 前入睡（睡满 8 小时更稳）');
    const tsh = shiftOf(ymd(new Date()));
    if (isNightShift(tsh)) items.push('🌙 今晚是夜班，记得开「设置 → 护眼模式」保护暗视力');
    const rs = restStreak();
    if (rs >= 2) items.push('🏖️ 已连续休息 <b>' + rs + '</b> 天，好好放松充电');
    if (!items.length) items.push('🌿 作息规律，状态不错，保持住～');
    box.innerHTML = items.map((t) => '<div class="care-item">' + t + '</div>').join('');
  }

  /** 下一次有排班的日期信息（从明天开始找 60 天） */
  function nextShiftInfo() {
    const now = new Date();
    const today = ymd(now);
    for (let i = 1; i <= 60; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      const key = ymd(d);
      const sh = shiftOf(key);
      if (sh) {
        const days = i;
        let label;
        if (i === 1) label = '明天';
        else if (i === 2) label = '后天';
        else label = (d.getMonth() + 1) + '月' + d.getDate() + '日';
        return { key: key, date: d, shift: sh, days: days, label: label };
      }
    }
    return null;
  }

  /** 下一个休息日信息（今天也算；休息 = 有班次但没上班时间） */
  function nextRestInfo() {
    const now = new Date();
    for (let i = 0; i <= 60; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      const key = ymd(d);
      const sh = shiftOf(key);
      if (sh && !sh.start) {
        let label, days = i;
        if (i === 0) { label = '今天'; days = 0; }
        else if (i === 1) label = '明天';
        else if (i === 2) label = '后天';
        else label = (d.getMonth() + 1) + '月' + d.getDate() + '日';
        return { key: key, date: d, shift: sh, days: days, label: label };
      }
    }
    return null;
  }

  /** 是否夜班（用于护眼模式自动判断）：晚 20 点后开始，或傍晚开始且跨午夜 */
  function isNightShift(sh) {
    if (!sh || !sh.start) return false;
    const [h] = sh.start.split(':').map(Number);
    if (h >= 20) return true;
    if (sh.end) {
      const [eh] = sh.end.split(':').map(Number);
      if (eh <= h && h >= 16) return true; // 跨午夜且傍晚开始，如 18:00-02:00
    }
    return false;
  }

  /** 已连续上班天数（含今天；今天休息则从昨天往前数） */
  function workStreak() {
    let s = 0;
    const now = new Date();
    for (let i = 0; i < 60; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const sh = shiftOf(ymd(d));
      if (sh && sh.start) s++;
      else if (i === 0) continue; // 今天休息，继续往前看
      else break;
    }
    return s;
  }

  /** 已连续休息天数（仅当天就是休息才计数） */
  function restStreak() {
    const now = new Date();
    const tsh = shiftOf(ymd(now));
    if (!(tsh && !tsh.start)) return 0;
    let s = 0;
    for (let i = 0; i < 60; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      const sh = shiftOf(ymd(d));
      if (sh && !sh.start) s++;
      else break;
    }
    return s;
  }

  /** 早班睡眠建议：下一个早班（上班点 ≤ 09:00）前，建议的就寝时间 */
  function sleepAdvice() {
    const now = new Date();
    for (let i = 0; i < 3; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      const sh = shiftOf(ymd(d));
      if (sh && sh.start) {
        const [h, m] = sh.start.split(':').map(Number);
        if (h <= 9) {
          // 就寝 = 上班 − 提前量 − 8h 睡眠 − 30min 缓冲
          let bed = h * 60 + m - S.leadMinutes - 480 - 30;
          if (bed < 0) bed += 1440;
          return {
            when: i === 0 ? '今天' : (i === 1 ? '明天' : '后天'),
            start: sh.start,
            bed: pad(Math.floor(bed / 60)) + ':' + pad(bed % 60)
          };
        }
        return null; // 下一个是晚班，无需早睡提醒
      }
    }
    return null;
  }

  /** 首页 hero 内的本周排班小条（周一到周日） */
  function renderWeekStrip() {
    const box = $('#weekStrip');
    if (!box) return;
    const now = new Date();
    const dow = (now.getDay() + 6) % 7;
    const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
    let html = '';
    const labels = ['一', '二', '三', '四', '五', '六', '日'];
    for (let i = 0; i < 7; i++) {
      const d = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i);
      const key = ymd(d);
      const sh = shiftOf(key);
      const isToday = key === ymd(now);
      html +=
        '<div class="ws-day' + (isToday ? ' today' : '') + '" title="' + (d.getMonth() + 1) + '/' + d.getDate() + '">' +
          '<span class="ws-l">' + labels[i] + '</span>' +
          '<span class="ws-d">' + d.getDate() + '</span>' +
          '<span class="ws-dot" style="background:' + (sh ? sh.color : 'transparent') + '"></span>' +
          '<span class="ws-s">' + (sh ? sh.name : '') + '</span>' +
        '</div>';
    }
    box.innerHTML = html;
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
    renderStats();
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
      const sh = shiftOf(today);
      if (hol.type === 'holiday') {
        if (sh && sh.start) $('#tipHoliday').textContent = '🎉 今天' + hol.name + '放假，但你排了「' + sh.name + '」，确认下？';
        else $('#tipHoliday').textContent = '🎉 今天是' + hol.name + '，放假休息～';
      } else {
        if (!sh || !sh.start) $('#tipHoliday').textContent = '⚠️ 今天' + hol.name + '调休上班，别忘啦';
        else $('#tipHoliday').textContent = '⚠️ 今天' + hol.name + '调休上班（已排「' + sh.name + '」）';
      }
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
    const streak = workStreak();
    if (streak >= 4) lines.push('💪 已连续上班 ' + streak + ' 天，注意休息别硬撑');
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
    renderProfileBar();
    scheduleNextAlarm();
  }

  /* ================= 外观自定义 ================= */
  function applyAppearance() {
    const root = document.documentElement;
    root.setAttribute('data-theme', S.theme || 'aurora');
    root.setAttribute('data-mode', 'dark');
    root.style.setProperty('--font-scale', (S.fontScale || 1));
    // 自定义主题色：以内联方式覆盖 --grad / --grad-soft；非自定义时清掉内联，回退样式表
    if (S.theme === 'custom') {
      const base = S.themeCustom || '#7c5cff';
      const second = rotateHue(base, 38);
      root.style.setProperty('--grad', 'linear-gradient(135deg,' + base + ' 0%,' + second + ' 100%)');
      root.style.setProperty('--grad-soft', 'linear-gradient(135deg,' + hex2rgba(base, .92) + ',' + hex2rgba(second, .88) + ')');
    } else {
      root.style.removeProperty('--grad');
      root.style.removeProperty('--grad-soft');
    }
    applyBgColor();
    applyNightMode();
    renderHomeCards();
  }
  /** 护眼模式：off / manual / auto（夜班或夜间 22:00-06:00 自动开） */
  function applyNightMode() {
    const ov = $('#nightOverlay');
    if (!ov) return;
    let on = false;
    if (S.nightMode === 'manual') on = true;
    else if (S.nightMode === 'auto') {
      const hr = new Date().getHours();
      const sh = shiftOf(ymd(new Date()));
      on = (hr >= 22 || hr < 6 || isNightShift(sh));
    }
    ov.style.display = on ? 'block' : 'none';
  }
  function applyBgColor() {
    const root = document.documentElement;
    // 背景色预设：色调明显差别，光晕饱和度高、面积大，切换一眼可见
    const presets = {
      aurora: { bg: '#0a0717', a: '#3a1d8a', b: '#6d28d9' }, // 极光紫
      ocean:  { bg: '#04101f', a: '#0c4a6e', b: '#0369a1' }, // 深海蓝
      sunset: { bg: '#1a0d05', a: '#9a3412', b: '#ea580c' }, // 落日橙
      mint:   { bg: '#04140e', a: '#047857', b: '#10b981' }, // 薄荷绿
      rose:   { bg: '#1a0712', a: '#9d174d', b: '#db2777' }, // 玫瑰粉
      black:  { bg: '#000000', a: '#1a1a1a', b: '#000000' }  // 纯黑
    };
    let p = presets[S.bgColor || 'aurora'];
    let custom = false;
    if (!p && S.bgColor === 'custom') {
      const hex = S.bgCustom || '#0a0717';
      p = { bg: hex, a: hex, b: hex };
      custom = true;
    }
    if (!p) p = presets.aurora;
    root.style.setProperty('--bg', p.bg);
    const aurora = $('.aurora');
    if (aurora) {
      // 所有预设都显式铺一层大范围高饱和光晕，差异更明显
      aurora.style.background = 'radial-gradient(1000px 620px at 18% -8%,' + hex2rgba(p.a, .85) + ' 0%,transparent 58%),' +
        'radial-gradient(900px 620px at 92% 8%,' + hex2rgba(p.b, .7) + ' 0%,transparent 60%),' + p.bg;
    }
  }
  /** 按 homeCards 顺序重排首页可配置卡片（hero 始终置顶） */
  function renderHomeCards() {
    const view = $('#view-home');
    if (!view) return;
    const weather = $('#weatherCard');
    const tips = $('#tipsCard');
    const care = $('#careCard');
    if (weather) weather.remove();
    if (tips) tips.remove();
    if (care) care.remove();
    const seq = (S.homeCards && S.homeCards.length ? S.homeCards : ['hero', 'weather', 'tips', 'care'])
      .filter((x) => x !== 'hero');
    let anchor = $('#heroCard') || view;
    seq.forEach((id) => {
      const el = id === 'weather' ? weather : id === 'tips' ? tips : id === 'care' ? care : null;
      if (el) { view.insertBefore(el, anchor.nextSibling); anchor = el; }
    });
  }

  /* ================= 底部导航：视图切换 ================= */
  let curView = 'home';
  function switchView(name) {
    if (curView === 'play' && name !== 'play') leavePlay();
    curView = name;
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
    $$('.nav-tab').forEach((t) => t.classList.toggle('on', t.dataset.view === name));
    if (name === 'settings') renderSettings();
    if (name === 'schedule') { renderCalendar(); renderAlarmList(); renderPaint(); renderProfileBar(); }
    if (name === 'home') { renderHero(); renderCountdown(); }
    if (name === 'play') enterPlay();
    window.scrollTo(0, 0);
  }
  $$('.nav-tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));

  /* ================= 玩 · 睡意测试 + 贪吃蛇 ================= */
  let reactState = 'idle', reactWaitT = null, reactStart = 0;
  let reactBest = parseInt(localStorage.getItem('sw_reactBest') || '0', 10) || 0;
  let snake = null;

  function setReact(state) {
    reactState = state;
    const pad = $('#reactPad'), txt = $('#reactText');
    if (!pad) return;
    pad.className = 'react-pad ' + state;
    if (state === 'idle') txt.textContent = '点击开始';
    else if (state === 'waiting') txt.textContent = '等待绿色…';
    else if (state === 'go') txt.textContent = '点！';
  }
  function reactTap() {
    if (reactState === 'idle') {
      setReact('waiting');
      reactWaitT = setTimeout(() => { setReact('go'); reactStart = Date.now(); }, 1000 + Math.random() * 3000);
    } else if (reactState === 'waiting') {
      clearTimeout(reactWaitT); reactWaitT = null;
      const v = $('#reactVerdict'); if (v) v.textContent = '⚠️ 太快了！等变绿再点';
      setReact('idle');
    } else if (reactState === 'go') {
      const dt = Date.now() - reactStart; reactWaitT = null;
      const last = $('#reactLast'); if (last) last.textContent = dt + ' ms';
      if (!reactBest || dt < reactBest) {
        reactBest = dt; localStorage.setItem('sw_reactBest', String(dt));
        const b = $('#reactBest'); if (b) b.textContent = dt + ' ms';
      }
      const v = $('#reactVerdict'); if (v) v.textContent = reactVerdict(dt);
      setReact('idle');
    }
  }
  function reactVerdict(ms) {
    if (ms < 200) return '⚡ 反应超快，精神很在线！';
    if (ms < 350) return '😊 状态不错，挺清醒的';
    if (ms < 500) return '😐 有点走神了，干活注意安全';
    return '😴 反应偏慢，找个空档补个觉吧';
  }
  function stopReactWait() { if (reactWaitT) { clearTimeout(reactWaitT); reactWaitT = null; } }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function sizeSnake() {
    const c = snake.c, wrap = c.parentElement;
    const cssW = Math.min((wrap ? wrap.clientWidth : 320) || 320, Math.round((window.innerHeight || 640) * 0.38), 320);
    const dpr = window.devicePixelRatio || 1;
    c.style.width = cssW + 'px'; c.style.height = cssW + 'px';
    c.width = Math.round(cssW * dpr); c.height = Math.round(cssW * dpr);
    snake.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    snake.size = cssW / snake.GRID;
  }
  function drawSnake() {
    const G = snake, ctx = G.ctx, size = G.size, body = G.snake, food = G.food;
    const W = G.c.clientWidth;
    ctx.clearRect(0, 0, W, W);
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.fillRect(0, 0, W, W);
    if (food) {
      ctx.fillStyle = '#ff6b81';
      roundRect(ctx, food.x * size + size * 0.15, food.y * size + size * 0.15, size * 0.7, size * 0.7, size * 0.22);
      ctx.fill();
    }
    body.forEach((s, i) => {
      ctx.fillStyle = i === 0 ? '#9ae7ff' : 'rgba(154,231,255,' + (0.9 - 0.55 * (i / body.length)).toFixed(3) + ')';
      roundRect(ctx, s.x * size + size * 0.08, s.y * size + size * 0.08, size * 0.84, size * 0.84, size * 0.22);
      ctx.fill();
    });
  }
  function placeFood() {
    const G = snake.GRID; let p;
    do { p = { x: Math.floor(Math.random() * G), y: Math.floor(Math.random() * G) }; }
    while (snake.snake.some((s) => s.x === p.x && s.y === p.y));
    snake.food = p;
  }
  function stepSnake() {
    snake.dir = snake.next;
    const head = { x: snake.snake[0].x + snake.dir.x, y: snake.snake[0].y + snake.dir.y };
    const G = snake.GRID;
    if (head.x < 0 || head.y < 0 || head.x >= G || head.y >= G ||
        snake.snake.some((s) => s.x === head.x && s.y === head.y)) { gameOverSnake(); return; }
    snake.snake.unshift(head);
    if (snake.food && head.x === snake.food.x && head.y === snake.food.y) {
      snake.score += 10;
      const sc = $('#snakeScore'); if (sc) sc.textContent = snake.score;
      placeFood();
      if (snake.score % 50 === 0 && snake.speed > 110) {
        snake.speed -= 10;
        clearInterval(snake.timer); snake.timer = setInterval(stepSnake, snake.speed);
      }
    } else {
      snake.snake.pop();
    }
    drawSnake();
  }
  function gameOverSnake() {
    snake.running = false; snake.gameOver = true; clearInterval(snake.timer); snake.timer = null;
    if (snake.score > snake.high) {
      snake.high = snake.score; localStorage.setItem('sw_snakeHigh', String(snake.score));
      const h = $('#snakeHigh'); if (h) h.textContent = snake.high;
    }
    const m = $('#snakeMsg'); if (m) m.textContent = '游戏结束！得分 ' + snake.score + '，点「开始」再来一局';
    const p = $('#snakePause'); if (p) { p.disabled = true; }
  }
  function startSnake() {
    if (!snake) initSnake();
    stopSnake();
    // 每次都重置，保证「开始 / 重新开始」一定生效
    snake.snake = [{ x: 8, y: 8 }, { x: 7, y: 8 }, { x: 6, y: 8 }];
    snake.dir = { x: 1, y: 0 }; snake.next = { x: 1, y: 0 };
    snake.score = 0; snake.speed = 180; snake.food = null; snake.gameOver = false; placeFood();
    const sc = $('#snakeScore'); if (sc) sc.textContent = '0';
    snake.running = true;
    const st = $('#snakeStart'); if (st) st.textContent = '重新开始';
    const p = $('#snakePause'); if (p) { p.disabled = false; p.textContent = '暂停'; }
    const m = $('#snakeMsg'); if (m) m.textContent = '';
    snake.timer = setInterval(stepSnake, snake.speed);
  }
  function pauseSnake() {
    if (!snake) return;
    const p = $('#snakePause');
    if (snake.running) {
      clearInterval(snake.timer); snake.timer = null; snake.running = false;
      if (p) p.textContent = '继续';
      const m = $('#snakeMsg'); if (m) m.textContent = '已暂停';
    } else if (snake.snake.length) {
      snake.running = true; if (p) p.textContent = '暂停';
      const m = $('#snakeMsg'); if (m) m.textContent = '';
      snake.timer = setInterval(stepSnake, snake.speed);
    }
  }
  function setDir(d) {
    const map = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
    const v = map[d]; if (!v || !snake) return;
    if (!snake.running && (snake.snake.length === 0 || snake.gameOver)) startSnake();
    if (snake.snake.length > 1) {
      const cur = snake.next;
      if (v.x === -cur.x && v.y === -cur.y) return; // 不能反向
    }
    snake.next = v;
  }
  function initSnake() {
    const c = $('#snakeCanvas'); if (!c) return;
    const ctx = c.getContext('2d');
    snake = { c, ctx, GRID: 17, size: 0, snake: [], dir: { x: 1, y: 0 }, next: { x: 1, y: 0 }, food: null, score: 0, running: false, timer: null, speed: 180, high: parseInt(localStorage.getItem('sw_snakeHigh') || '0', 10) || 0, gameOver: false };
    const h = $('#snakeHigh'); if (h) h.textContent = snake.high;
    const sc = $('#snakeScore'); if (sc) sc.textContent = '0';
    sizeSnake(); drawSnake();
  }
  function stopSnake() {
    if (snake && snake.timer) { clearInterval(snake.timer); snake.timer = null; }
    if (snake) snake.running = false;
  }
  function enterPlay() {
    const b = $('#reactBest'); if (b) b.textContent = reactBest ? reactBest + ' ms' : '—';
    const l = $('#reactLast'); if (l) l.textContent = '—';
    const v = $('#reactVerdict'); if (v) v.textContent = '';
    setReact('idle');
    if (!snake) initSnake(); else { sizeSnake(); drawSnake(); }
  }
  function leavePlay() { stopReactWait(); stopSnake(); }
  function bindPlay() {
    const pad = $('#reactPad'); if (pad) pad.addEventListener('click', reactTap);
    const sc = $('#snakeCanvas'); if (sc) {
      let tsx = 0, tsy = 0;
      sc.addEventListener('touchstart', (e) => { const t = e.touches[0]; tsx = t.clientX; tsy = t.clientY; }, { passive: true });
      sc.addEventListener('touchend', (e) => {
        const t = e.changedTouches[0]; const dx = t.clientX - tsx, dy = t.clientY - tsy;
        if (Math.abs(dx) < 20 && Math.abs(dy) < 20) return;
        if (Math.abs(dx) > Math.abs(dy)) setDir(dx > 0 ? 'right' : 'left');
        else setDir(dy > 0 ? 'down' : 'up');
      }, { passive: true });
    }
    const startBtn = $('#snakeStart'); if (startBtn) startBtn.addEventListener('click', startSnake);
    const pauseBtn = $('#snakePause'); if (pauseBtn) pauseBtn.addEventListener('click', pauseSnake);
    $$('#snakeCtrl button').forEach((b) => b.addEventListener('click', () => setDir(b.dataset.dir)));
    document.addEventListener('keydown', (e) => {
      if (curView !== 'play') return;
      const m = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
      if (m[e.key]) { e.preventDefault(); setDir(m[e.key]); }
    });
    window.addEventListener('resize', () => { if (curView === 'play' && snake) { sizeSnake(); drawSnake(); } });
  }

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

    // 外观
    const themeSel = $('#themeSel'); if (themeSel) themeSel.value = S.theme || 'aurora';
    const themeCustom = $('#themeCustom'); if (themeCustom) themeCustom.value = S.themeCustom || '#7c5cff';
    const themeCustomRow = $('#themeCustomRow'); if (themeCustomRow) themeCustomRow.style.display = (S.theme === 'custom') ? 'flex' : 'none';
    const bgSel = $('#bgSel'); if (bgSel) bgSel.value = S.bgColor || 'aurora';
    const bgCustom = $('#bgCustom'); if (bgCustom) bgCustom.value = S.bgCustom || '#080a16';
    const bgCustomRow = $('#bgCustomRow'); if (bgCustomRow) bgCustomRow.style.display = (S.bgColor === 'custom') ? 'flex' : 'none';
    const nightSel = $('#nightSel'); if (nightSel) nightSel.value = S.nightMode || 'off';
    renderHomeCardsEditor();

    const box = $('#shiftEditor');
    box.innerHTML = '';
    S.shifts.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'se' + (s.start ? '' : ' off');
      row.innerHTML =
        '<input type="color" value="' + s.color + '">' +
        '<input type="text" value="' + esc(s.name) + '" maxlength="8" placeholder="班次名">' +
        '<div class="se-times">' +
          '<input type="time" value="' + (s.start || '') + '" title="上班时间" aria-label="上班时间">' +
          '<input type="time" value="' + (s.end || '') + '" title="下班时间" aria-label="下班时间">' +
        '</div>' +
        '<button class="clone" title="克隆">⧉</button>' +
        '<button class="del" title="删除">✕</button>';
      const [color, name, timesWrap, clone, del] = [row.children[0], row.children[1], row.children[2], row.children[3], row.children[4]];
      const time = timesWrap.children[0], etime = timesWrap.children[1];
      color.addEventListener('input', () => { s.color = color.value; save(); renderCalendar(); renderLegend(); });
      name.addEventListener('input', () => { s.name = name.value || '班次'; save(); });
      name.addEventListener('blur', () => { renderAll(); });
      time.addEventListener('change', () => {
        s.start = time.value;
        s.alarm = !!time.value;
        row.classList.toggle('off', !time.value);
        save(); renderAll(); renderStats();
      });
      etime.addEventListener('change', () => { s.end = etime.value; save(); renderStats(); });
      clone.addEventListener('click', () => {
        const colors = ['#34d399', '#fb7185', '#60a5fa', '#fbbf24', '#a78bfa', '#f472b6'];
        S.shifts.push({
          id: 's' + Date.now().toString(36),
          name: s.name + ' 副本', start: s.start, end: s.end, alarm: s.alarm,
          color: colors[S.shifts.length % colors.length]
        });
        save(); renderSettings(); renderAll();
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

  /** 设置页：首页卡片显隐 + 排序编辑器 */
  function renderHomeCardsEditor() {
    const box = $('#homeCardsBox');
    if (!box) return;
    box.innerHTML = '';
    const labels = { weather: '天气与贴心提醒', tips: '今日贴心提醒', care: '健康关怀' };
    const configurable = ['weather', 'tips', 'care'];
    const saved = (S.homeCards && S.homeCards.length) ? S.homeCards : ['hero', 'weather', 'tips'];
    configurable.forEach((id) => {
      const shown = saved.includes(id);
      const idx = saved.indexOf(id);
      const row = document.createElement('div');
      row.className = 'hc-row';
      row.innerHTML =
        '<span class="hc-name">' + (labels[id] || id) + '</span>' +
        '<span class="hc-ctrl">' +
          '<button class="hc-up" ' + (idx <= 1 || !shown ? 'disabled' : '') + '>↑</button>' +
          '<button class="hc-down" ' + (idx >= saved.length - 1 || !shown ? 'disabled' : '') + '>↓</button>' +
          '<label class="switch sm"><input type="checkbox" ' + (shown ? 'checked' : '') + '><span class="slider"></span></label>' +
        '</span>';
      const up = row.querySelector('.hc-up');
      const down = row.querySelector('.hc-down');
      const chk = row.querySelector('input');
      chk.addEventListener('change', () => {
        let arr = (S.homeCards && S.homeCards.length) ? S.homeCards.slice() : ['hero', 'weather', 'tips'];
        if (chk.checked) { if (!arr.includes(id)) arr.push(id); }
        else { arr = arr.filter((x) => x !== id); }
        S.homeCards = arr; save(); renderHomeCardsEditor(); renderHomeCards();
      });
      up.addEventListener('click', () => { moveHomeCard(id, -1); });
      down.addEventListener('click', () => { moveHomeCard(id, 1); });
      box.appendChild(row);
    });
  }
  function moveHomeCard(id, dir) {
    let arr = (S.homeCards && S.homeCards.length) ? S.homeCards.slice() : ['hero', 'weather', 'tips'];
    const i = arr.indexOf(id);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    S.homeCards = arr; save(); renderHomeCardsEditor(); renderHomeCards();
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
  const themeSel = $('#themeSel');
  if (themeSel) themeSel.addEventListener('change', () => {
    S.theme = themeSel.value;
    const themeCustomRow = $('#themeCustomRow');
    if (themeCustomRow) themeCustomRow.style.display = (S.theme === 'custom') ? 'flex' : 'none';
    save(); applyAppearance();
  });
  const themeCustom = $('#themeCustom');
  if (themeCustom) themeCustom.addEventListener('input', () => { S.themeCustom = themeCustom.value; save(); applyAppearance(); });
  const bgSel = $('#bgSel');
  if (bgSel) bgSel.addEventListener('change', () => {
    S.bgColor = bgSel.value;
    const bgCustomRow = $('#bgCustomRow');
    if (bgCustomRow) bgCustomRow.style.display = (S.bgColor === 'custom') ? 'flex' : 'none';
    save(); applyAppearance();
  });
  const bgCustom = $('#bgCustom');
  if (bgCustom) bgCustom.addEventListener('input', () => { S.bgCustom = bgCustom.value; save(); applyAppearance(); });
  const nightSel = $('#nightSel');
  if (nightSel) nightSel.addEventListener('change', () => { S.nightMode = nightSel.value; save(); applyNightMode(); });

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
  /** 把上个月的排班按日期复制到当前显示的月份（跳过目标月不存在的日期） */
  function copyPrevMonthToView() {
    let py = viewMonth - 1, pY = viewYear;
    if (py < 0) { py = 11; pY--; }
    const dim = new Date(viewYear, viewMonth + 1, 0).getDate();
    let cnt = 0;
    Object.keys(S.schedule).forEach((k) => {
      const p = k.split('-');
      if (+p[0] === pY && +p[1] === py + 1) {
        const day = +p[2];
        if (day <= dim) {
          const nk = viewYear + '-' + pad(viewMonth + 1) + '-' + pad(day);
          S.schedule[nk] = S.schedule[k];
          cnt++;
        }
      }
    });
    return cnt;
  }
  $('#btnCopyMonth').addEventListener('click', () => {
    let py = viewMonth - 1, pY = viewYear;
    if (py < 0) { py = 11; pY--; }
    if (!confirm('把 ' + pY + '年' + (py + 1) + '月 的排班按日期复制到当前显示的 ' + viewYear + '年' + (viewMonth + 1) + '月？\n（目标月已有排班的日子会被覆盖）')) return;
    const cnt = copyPrevMonthToView();
    save(); renderAll(); toast('已复制 ' + cnt + ' 天');
  });

  /* ================= 导入 ================= */
  $('#btnImport').addEventListener('click', () => {
    const n = new Date();
    $('#importMonth').value = n.getFullYear() + '-' + pad(n.getMonth() + 1);
    $('#cycStart').value = ymd(n);
    renderCycChips();
    renderTplList();
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
    importBuffer = []; importPreviewMode = null; pendingImport = null;
    const pv = $('#importPreview');
    if (pv) {
      pv.hidden = true;
      $('#prevList').innerHTML = '';
      $('#prevCount').textContent = '0 天';
    }
    toast('已清空循环顺序和预览');
  });
  // 班表模板
  function renderTplList() {
    const sel = $('#tplSel');
    if (!sel) return;
    sel.innerHTML = '';
    if (!S.templates.length) { sel.innerHTML = '<option value="">（暂无模板）</option>'; return; }
    S.templates.forEach((t, i) => {
      const o = document.createElement('option');
      o.value = i; o.textContent = t.name + '（' + t.seq.length + ' 天一轮）';
      sel.appendChild(o);
    });
  }
  $('#cycSaveTpl').addEventListener('click', () => {
    if (!cycleSeq.length) { toast('先添加循环顺序'); return; }
    const name = prompt('给这套循环起个名字：', '班表' + (S.templates.length + 1));
    if (!name) return;
    S.templates.push({ name: name, seq: cycleSeq.slice() });
    save(); renderTplList(); toast('已保存模板：' + name);
  });
  $('#btnUseTpl').addEventListener('click', () => {
    const sel = $('#tplSel');
    const t = S.templates[+sel.value];
    if (!t) { toast('没有可套用的模板'); return; }
    cycleSeq = t.seq.slice();
    renderCycSeq(); toast('已套用：' + t.name);
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
          if (!d.schedule && !d.profiles) throw 0;
          S = Object.assign(JSON.parse(JSON.stringify(DEFAULT)), d);
          migrateProfiles();
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
     标题前缀带上班表名：【班次闹钟·<班表名>】班次 08:00 上班 · 准备
     —— 多套班表互不误删的关键：捷径只删除「当前班表前缀」的旧提醒，再添加本次清单。
     注意：和网页闹钟清单共用 upcomingAlarms() 数据源，保证网页看到几条，剪贴板就几条。
   */
  const BATCH_SHORTCUT_NAME = '批量添加排班提醒';

  // 当前激活班表名（已清洗，安全用于标题前缀）
  function activeProfileTag() {
    let n = '本班';
    if (S.profiles && S.profiles[S.activeProfile]) n = S.profiles[S.activeProfile].name || n;
    n = (n || '').replace(/[【】|]/g, '').trim().slice(0, 10) || '本班';
    return n;
  }

  function buildRemindersList() {
    const prefix = '【班次闹钟·' + activeProfileTag() + '】';
    const lines = [];
    upcomingAlarms(30).forEach((it) => {
      const a = it.time;
      const y = a.getFullYear();
      const m = pad(a.getMonth() + 1);
      const d = pad(a.getDate());
      const hh = pad(a.getHours());
      const mm = pad(a.getMinutes());
      const datetime = y + '/' + m + '/' + d + ' ' + hh + ':' + mm; // iOS 中文系统最容易识别的日期时间格式
      const title = prefix + it.shift.name + ' ' + it.shift.start + ' 上班 · 准备';
      const note = '提前 ' + S.leadMinutes + ' 分钟提醒 · 由班次闹钟工作台生成（班表：' + activeProfileTag() + '）';
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

  /* ================= 多套班表 + 数据与统计 ================= */
  function cloneObj(o) { try { return JSON.parse(JSON.stringify(o)); } catch (e) { return {}; } }
  function migrateProfiles() {
    if (!S.profiles || typeof S.profiles !== 'object' || Array.isArray(S.profiles)) S.profiles = {};
    if (!S.activeProfile || !S.profiles[S.activeProfile]) {
      const legacy = (S.schedule && typeof S.schedule === 'object') ? S.schedule : {};
      S.profiles['main'] = { id: 'main', name: '本班', schedule: cloneObj(legacy) };
      S.activeProfile = 'main';
      S.schedule = cloneObj(legacy);
    } else {
      const p = S.profiles[S.activeProfile];
      S.schedule = cloneObj(p.schedule || {});
    }
    if (!S.profiles['main']) S.profiles['main'] = { id: 'main', name: '本班', schedule: cloneObj(S.schedule) };
  }
  function renderProfileBar() {
    const box = $('#profileChips');
    if (!box) return;
    box.innerHTML = '';
    Object.keys(S.profiles).forEach((pid) => {
      const p = S.profiles[pid];
      const b = document.createElement('button');
      b.className = 'pchip' + (pid === S.activeProfile ? ' on' : '');
      b.textContent = p.name;
      b.addEventListener('click', () => switchProfile(pid));
      box.appendChild(b);
    });
  }
  function switchProfile(pid) {
    if (pid === S.activeProfile || !S.profiles[pid]) return;
    S.profiles[S.activeProfile].schedule = S.schedule;
    S.activeProfile = pid;
    S.schedule = cloneObj(S.profiles[pid].schedule || {});
    save(); renderAll(); renderProfileBar(); renderProfileSheet();
    toast('已切换到「' + S.profiles[pid].name + '」');
  }
  function renderProfileSheet() {
    const box = $('#profileList');
    if (!box) return;
    box.innerHTML = '';
    Object.keys(S.profiles).forEach((pid) => {
      const p = S.profiles[pid];
      const row = document.createElement('div');
      row.className = 'prow' + (pid === S.activeProfile ? ' on' : '');
      row.innerHTML =
        '<span class="pname">' + esc(p.name) + (pid === S.activeProfile ? ' · 当前' : '') +
        ' <small>' + Object.keys(p.schedule || {}).length + ' 天</small></span>' +
        '<span class="pctrl">' +
        (pid === S.activeProfile ? '' : '<button class="pswitch">切换</button>') +
        '<button class="prename">改名</button>' +
        '<button class="pdel">删除</button></span>';
      const sw = row.querySelector('.pswitch');
      if (sw) sw.addEventListener('click', () => switchProfile(pid));
      row.querySelector('.prename').addEventListener('click', () => {
        const n = prompt('修改班表名称：', p.name);
        if (!n) return;
        S.profiles[pid].name = n; save(); renderProfileBar(); renderProfileSheet();
      });
      row.querySelector('.pdel').addEventListener('click', () => {
        if (Object.keys(S.profiles).length <= 1) { toast('至少保留一个班表'); return; }
        if (!confirm('删除「' + p.name + '」？里面的排班会一起清空')) return;
        delete S.profiles[pid];
        if (S.activeProfile === pid) {
          const first = Object.keys(S.profiles)[0];
          S.activeProfile = first;
          S.schedule = cloneObj(S.profiles[first].schedule || {});
        }
        save(); renderAll(); renderProfileBar(); renderProfileSheet();
        toast('已删除「' + p.name + '」');
      });
      box.appendChild(row);
    });
  }
  function durMin(a, b) {
    const [h1, m1] = a.split(':').map(Number);
    const [h2, m2] = b.split(':').map(Number);
    let d = (h2 * 60 + m2) - (h1 * 60 + m1);
    if (d < 0) d += 24 * 60; // 跨午夜（如夜班 22:00-06:00）按 +24h 算
    return d;
  }
  function renderStats() {
    const box = $('#statBox');
    if (!box) return;
    const sm = $('#statMonth');
    if (sm) sm.textContent = viewYear + '年' + (viewMonth + 1) + '月';
    const dim = new Date(viewYear, viewMonth + 1, 0).getDate();
    const counts = {};
    let workDays = 0, restDays = 0, totalMin = 0, noEndDays = 0;
    S.shifts.forEach((s) => { counts[s.id] = 0; });
    for (let d = 1; d <= dim; d++) {
      const key = viewYear + '-' + pad(viewMonth + 1) + '-' + pad(d);
      const sid = S.schedule[key];
      if (!sid) continue;
      const sh = getShift(sid);
      if (!sh) continue;
      counts[sid] = (counts[sid] || 0) + 1;
      if (sh.start) {
        workDays++;
        if (sh.end) totalMin += durMin(sh.start, sh.end);
        else noEndDays++;
      } else restDays++;
    }
    const hrs = totalMin > 0 ? (totalMin / 60).toFixed(1) : (workDays > 0 ? '—' : '0');
    let html = '<div class="stat-top">' +
      '<div class="stat-cell"><b>' + workDays + '</b><span>上班天</span></div>' +
      '<div class="stat-cell"><b>' + restDays + '</b><span>休息天</span></div>' +
      '<div class="stat-cell"><b>' + hrs + '</b><span>工时(h)</span></div></div>' +
      '<div class="stat-break">';
    S.shifts.forEach((s) => {
      if (!counts[s.id]) return;
      html += '<div class="stat-b"><span class="stat-dot" style="background:' + s.color + '"></span>' +
        '<span class="stat-n">' + esc(s.name) + '</span><span class="stat-c">' + counts[s.id] + ' 天</span></div>';
    });
    html += '</div>';
    if (noEndDays > 0) {
      html += '<div class="stat-note">⚠️ 本月有 ' + noEndDays + ' 天排了班但没设「下班时间」，工时未计入。去 设置 → 班次编辑 补上下班时间即可。</div>';
    }
    box.innerHTML = html;
  }
  function roundRect(x, X, Y, w, h, r) {
    x.beginPath();
    x.moveTo(X + r, Y);
    x.arcTo(X + w, Y, X + w, Y + h, r);
    x.arcTo(X + w, Y + h, X, Y + h, r);
    x.arcTo(X, Y + h, X, Y, r);
    x.arcTo(X, Y, X + w, Y, r);
    x.closePath();
  }
  function exportWeekImage() {
    const now = new Date();
    const dow = (now.getDay() + 6) % 7;   // 周一为首列
    const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i);
      days.push({ d: d, sh: shiftOf(ymd(d)) });
    }
    const W = 720, rowH = 92, padTop = 132, H = padTop + 7 * rowH + 44;
    const scale = Math.min(3, window.devicePixelRatio || 2);
    const cv = document.createElement('canvas');
    cv.width = W * scale; cv.height = H * scale;
    const x = cv.getContext('2d');
    x.scale(scale, scale);
    const grad = x.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#15183a'); grad.addColorStop(1, '#0c0e22');
    x.fillStyle = grad; x.fillRect(0, 0, W, H);
    x.fillStyle = '#fff'; x.font = '700 34px -apple-system,sans-serif';
    x.fillText('本周排班 · ' + (S.profiles[S.activeProfile] ? S.profiles[S.activeProfile].name : '本班'), 36, 62);
    x.fillStyle = 'rgba(255,255,255,.6)'; x.font = '500 20px -apple-system,sans-serif';
    const range = (mon.getMonth() + 1) + '/' + mon.getDate() + ' - ' + (days[6].d.getMonth() + 1) + '/' + days[6].d.getDate();
    x.fillText(range + '  ·  ' + now.getFullYear() + '年', 36, 98);
    const labels = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    days.forEach((it, i) => {
      const y = padTop + i * rowH;
      x.fillStyle = 'rgba(255,255,255,.06)';
      roundRect(x, 24, y, W - 48, rowH - 14, 18); x.fill();
      x.fillStyle = it.sh ? it.sh.color : '#3f4460';
      roundRect(x, 24, y, 10, rowH - 14, 6); x.fill();
      x.fillStyle = 'rgba(255,255,255,.85)'; x.font = '600 22px -apple-system,sans-serif';
      x.fillText(labels[i], 50, y + 40);
      x.fillStyle = 'rgba(255,255,255,.5)'; x.font = '500 17px -apple-system,sans-serif';
      x.fillText((it.d.getMonth() + 1) + '/' + it.d.getDate(), 50, y + 66);
      x.textAlign = 'right';
      if (it.sh) {
        x.fillStyle = '#fff'; x.font = '700 26px -apple-system,sans-serif';
        x.fillText(it.sh.name, W - 44, y + 42);
        x.fillStyle = 'rgba(255,255,255,.6)'; x.font = '500 18px -apple-system,sans-serif';
        x.fillText(it.sh.start ? (it.sh.start + (it.sh.end ? (' - ' + it.sh.end) : '')) : '休息', W - 44, y + 68);
      } else {
        x.fillStyle = 'rgba(255,255,255,.35)'; x.font = '500 20px -apple-system,sans-serif';
        x.fillText('未排班', W - 44, y + 56);
      }
      x.textAlign = 'left';
    });
    x.fillStyle = 'rgba(255,255,255,.35)'; x.font = '500 15px -apple-system,sans-serif';
    x.fillText('由「班次闹钟工作台」生成', 36, H - 16);
    cv.toBlob((blob) => {
      if (!blob) { toast('生成失败'); return; }
      const file = new File([blob], '本周排班.png', { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: '本周排班' }).catch(() => {});
      } else {
        download('本周排班.png', blob, 'image/png');
        toast('已生成图片，可长按保存/分享');
      }
    }, 'image/png');
  }

  $('#btnAddProfile').addEventListener('click', () => {
    const name = prompt('给新班表起个名字（如 替班 / 培训 / 夜班轮换）：', '班表' + (Object.keys(S.profiles).length + 1));
    if (!name) return;
    const id = 'p' + Date.now().toString(36);
    S.profiles[id] = { id: id, name: name, schedule: cloneObj(S.schedule) };
    S.activeProfile = id;
    save(); renderAll(); renderProfileBar(); renderProfileSheet();
    toast('已新建并切换到「' + name + '」');
  });
  $('#btnManageProfile').addEventListener('click', () => { renderProfileSheet(); openSheet('#sheetProfiles'); });
  $('#btnWeekImg').addEventListener('click', exportWeekImage);
  $('#profilesClose').addEventListener('click', closeSheets);

  /* ================= 新手指引 + 使用说明书 ================= */
  const ONBOARD_STEPS = [
    { icon: '🏠', title: '先看今天上什么班', text: '首页顶部显示今天的班次和上班 / 闹钟时间。今天没排班也不用慌，会自动算出「下次排班」还有几天。' },
    { icon: '📅', title: '日历里点几下就排好', text: '到「排班」页，先选一个班次，开启「连点」后点日期直接刷班；也能用「循环生成」一次性铺满一个月。' },
    { icon: '⏰', title: '让手机准时叫你', text: '「设置」里调好"提前多久响"。想锁屏也响、防睡过头，用「一键添加闹钟」把排班写进 iPhone 提醒事项（需先装好捷径）。' },
    { icon: '🗂️', title: '多套班表随便切', text: '本班 / 替班 / 培训……顶部「班表」随时切换，每套独立保存、互不干扰。' }
  ];
  const MANUAL_SECTIONS = [
    { t: '一、首页', h: '<p>顶部显示<b>今天的班次</b>和<b>上班 / 闹钟时间</b>；今天没排班会自动显示<b>下次排班</b>还有几天。</p><p>上班期间，首页会多一条<b>实时下班倒计时</b>（一秒一跳，看着时间变小很有盼头）；任何时候都显示<b>距离下一个休息日还有几天</b>。</p><p>首页还有<b>健康关怀</b>卡：连续上班天数提醒、早班就寝建议、护眼模式提示等。<b>本周排班条</b>（周一到周日，今天高亮）、天气、节假日贴心提醒也都在这。这些卡片在「设置 → 首页显示」里可勾选 / 排序。</p>' },
    { t: '二、排班', h: '<p>① 选一个班次后，日历上方有「连点」开关，开启后点日期直接刷班，批量排班很快。</p><p>②<b>循环生成</b>：在「循环规则」里排好顺序，一键铺满一个月；还能「保存为模板」下次套用。</p><p>③<b>复制上月排班到本月</b>：调休换班时一键搬运。</p><p>④ 还支持<b>导入文本 / 文件</b>（一行一个日期+班次）。</p>' },
    { t: '三、班次编辑', h: '<p>「设置 → 班次设置」里可增删班次、改<b>颜色 / 名称 / 上班时间 / 下班时间</b>。</p><p>点 ⧉ 可<b>克隆</b>一个相似班次，改名即可。工时统计按"下班 − 上班"计算，记得把上下班时间都填上。</p>' },
    { t: '四、闹钟与提醒', h: '<p>「设置」里调<b>提前多久响</b>。网页会在上班前提醒，但<b>锁屏后 iOS 会挂起页面</b>，睡眠场景不靠谱。</p><p>要锁屏也持续响，用排班页<b>「一键添加闹钟」</b>把排班写进 iPhone「提醒事项」（捷径先删当前班表旧提醒、再添加）。装捷径见「设置 → 换手机」。</p>' },
    { t: '五、多套班表', h: '<p>排班页顶部「班表」可切换<b>本班 / 替班 / 培训</b>等多套；点 ＋ 新建、⚙ 管理（改名 / 删除）。每套独立保存。</p><p>每套班表的提醒带独立前缀（如 <code>【班次闹钟·本班】</code>），导入某班表时捷径只删该班表旧提醒，互不误删。</p>' },
    { t: '六、本月统计与周报', h: '<p>排班页「本月统计」卡自动算出<b>上班天数 / 休息天数 / 总工时</b>及各班次天数分布（翻月刷新）。</p><p>点「🖼️ 导出本周排班图片」可生成本周图，直接发班组群。</p>' },
    { t: '七、外观与背景', h: '<p>「设置 → 外观」可选<b>主题色</b>与<b>背景色</b>。主题色有 极光紫 / 日落橙 / 深海蓝 / 石墨灰 四套预设，也能选「自定义」用取色器挑任意颜色（会自动生成渐变，用于按钮、强调条等）。背景色有 紫 / 蓝 / 橙 / 绿 / 粉 / 黑 及「自定义」，切换时整页光晕会明显变化。</p><p><b>护眼模式</b>：同样在「外观」里，可选 关 / 手动开 / 自动（夜班/夜间）。开启后整屏覆一层<b>红色滤镜</b>，保护暗视力、夜间不刺眼；「自动」会在夜班当天或夜间（22:00–06:00）自动启用，白天自动关。</p>' },
    { t: '八、备份与还原', h: '<p>「设置 → 数据」里<b>导出备份</b>存一份 JSON；换新手机用<b>导入备份</b>还原，排班不丢。</p><p>「彻底清除缓存」会重置全部数据，慎用。</p>' },
    { t: '九、玩 · 摸鱼解压', h: '<p>底部「🎮 玩」标签页有两个打发时间的小玩意：</p><p>① <b>睡意测试</b>：屏幕变绿瞬间点它，测你的反应速度，并给出「现在有多困」的趣味结论（< 200ms 超清醒，> 500ms 该补觉了）。最佳成绩会记住。</p><p>② <b>贪吃蛇</b>：点「开始」用屏幕滑动或方向键 / 方向按钮操控，吃豆加分、撞墙或咬到自己就结束，最高分本地保存。</p>' },
    { t: '九、把它当 App 用', h: '<p>iPhone Safari：点底部「分享」→「添加到主屏幕」。之后桌面多一个图标，点开即用，离线也能跑。</p>' }
  ];

  let obStep = 0;
  function renderOnboardStep() {
    const step = ONBOARD_STEPS[obStep];
    const card = $('#onboardCard');
    if (card) {
      card.innerHTML = '<div class="ob-icon">' + step.icon + '</div>' +
        '<h2 class="ob-title">' + step.title + '</h2>' +
        '<p class="ob-text">' + step.text + '</p>';
    }
    const dots = $('#onboardDots');
    if (dots) {
      dots.innerHTML = ONBOARD_STEPS.map((_, i) => '<span class="ob-dot' + (i === obStep ? ' on' : '') + '"></span>').join('');
    }
    const next = $('#onboardNext');
    if (next) next.textContent = (obStep === ONBOARD_STEPS.length - 1) ? '开始使用' : '下一步';
  }
  function showOnboarding() {
    obStep = 0;
    renderOnboardStep();
    const ov = $('#onboardOverlay');
    if (ov) ov.classList.add('on');
  }
  function endOnboarding() {
    const ov = $('#onboardOverlay');
    if (ov) ov.classList.remove('on');
    S.onboarded = true; save();
  }
  function openManual() {
    const body = $('#manualBody');
    if (body) {
      body.innerHTML = MANUAL_SECTIONS.map((s) =>
        '<div class="manual-sec"><h3>' + s.t + '</h3>' + s.h + '</div>'
      ).join('');
    }
    const ov = $('#manualOverlay');
    if (ov) ov.classList.add('on');
  }
  function closeManual() {
    const ov = $('#manualOverlay');
    if (ov) ov.classList.remove('on');
  }

  /* ================= 启动 ================= */
  function init() {
    const n = new Date();
    viewYear = n.getFullYear();
    viewMonth = n.getMonth();
    loadWeatherCache();
    applyAppearance();   // 应用主题/深浅/字号/首页卡片顺序
    renderAll();
    switchView('home');
    fetchWeather();   // 后台刷新天气
    if (!S.onboarded) showOnboarding();

    setInterval(() => { renderHero(); applyNightMode(); }, 30000);
    liveTimer = setInterval(updateLiveClock, 1000);  // 首页下班倒计时每秒跳动
    updateLiveClock();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { notifyOnExit(); }
      else { exitNotified = false; renderAll(); }
    });
    window.addEventListener('pagehide', () => { if (curView === 'play') leavePlay(); notifyOnExit(); });
    // 解锁音频（iOS 需用户手势）
    document.addEventListener('touchstart', function unlock() {
      try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
      } catch (e) {}
      document.removeEventListener('touchstart', unlock);
    }, { passive: true });

    // 新手指引 & 说明书
    const onboardNext = $('#onboardNext');
    if (onboardNext) onboardNext.addEventListener('click', () => {
      if (obStep < ONBOARD_STEPS.length - 1) { obStep++; renderOnboardStep(); }
      else endOnboarding();
    });
    const onboardSkip = $('#onboardSkip');
    if (onboardSkip) onboardSkip.addEventListener('click', endOnboarding);
    const manualClose = $('#manualClose');
    if (manualClose) manualClose.addEventListener('click', closeManual);
    const manualOverlay = $('#manualOverlay');
    if (manualOverlay) manualOverlay.addEventListener('click', (e) => { if (e.target === manualOverlay) closeManual(); });
    const btnManual = $('#btnManual');
    if (btnManual) btnManual.addEventListener('click', openManual);

    bindPlay();   // 玩 · 睡意测试 + 贪吃蛇 事件绑定

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
