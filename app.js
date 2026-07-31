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
    scheduleNextAlarm();
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
  $('#setClose').addEventListener('click', () => { closeSheets(); renderAll(); });
  $('#impClose').addEventListener('click', closeSheets);

  /* ================= 设置 ================= */
  function renderSettings() {
    $('#leadRange').value = S.leadMinutes;
    $('#leadVal').textContent = S.leadMinutes + ' 分钟';
    $('#leadExample').textContent = minusLead('14:00');
    $('#helpLead').textContent = S.leadMinutes;

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

  $('#btnSettings').addEventListener('click', () => { renderSettings(); openSheet('#sheetSettings'); });
  $('#leadRange').addEventListener('input', (e) => {
    S.leadMinutes = +e.target.value;
    $('#leadVal').textContent = S.leadMinutes + ' 分钟';
    $('#leadExample').textContent = minusLead('14:00');
    $('#helpLead').textContent = S.leadMinutes;
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
  $('#cycClear').addEventListener('click', () => { cycleSeq = []; renderCycSeq(); });
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
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + 'T' +
      pad(d.getHours()) + pad(d.getMinutes()) + '00';
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
  function buildICS() {
    const L = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ShiftWorkbench//CN', 'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH', 'X-WR-CALNAME:我的排班闹钟', 'X-WR-TIMEZONE:Asia/Shanghai',
      'BEGIN:VTIMEZONE', 'TZID:Asia/Shanghai',
      'BEGIN:STANDARD', 'DTSTART:19700101T000000',
      'TZOFFSETFROM:+0800', 'TZOFFSETTO:+0800', 'TZNAME:CST',
      'END:STANDARD', 'END:VTIMEZONE'
    ];
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
    let count = 0;
    Object.keys(S.schedule).sort().forEach((key) => {
      const sh = shiftOf(key);
      if (!sh || !sh.start) return;
      const d = parseYmd(key);
      if (d < from) return;
      const st = startAt(key, sh);
      let en;
      if (sh.end) {
        const t = sh.end.split(':');
        en = parseYmd(key); en.setHours(+t[0], +t[1], 0, 0);
        if (en <= st) en = new Date(en.getTime() + 86400000);
      } else {
        en = new Date(st.getTime() + 4 * 3600000);
      }
      count++;
      L.push('BEGIN:VEVENT');
      L.push('UID:sw-' + key + '-' + sh.id + '@shift.local');
      L.push('DTSTAMP:' + icsStamp());
      L.push('DTSTART;TZID=Asia/Shanghai:' + icsTime(st));
      L.push('DTEND;TZID=Asia/Shanghai:' + icsTime(en));
      L.push(fold('SUMMARY:' + sh.name + ' ' + sh.start + ' 上班'));
      L.push(fold('DESCRIPTION:提前 ' + S.leadMinutes + " 分钟提醒\\n由班次闹钟工作台生成"));
      if (sh.alarm) {
        L.push('BEGIN:VALARM');
        L.push('ACTION:DISPLAY');
        L.push(fold('DESCRIPTION:该准备上班了 · ' + sh.name + ' ' + sh.start));
        L.push('TRIGGER:-PT' + S.leadMinutes + 'M');
        L.push('END:VALARM');
      }
      L.push('END:VEVENT');
    });
    L.push('END:VCALENDAR');
    return { text: L.join('\r\n'), count: count };
  }
  $('#btnExport').addEventListener('click', () => {
    const r = buildICS();
    if (!r.count) { toast('还没有可导出的排班'); return; }
    exportIcs(r);
  });

  /**
   * 移动端优先走系统分享面板（可直接选「日历」导入），
   * 不支持时退回下载，再不行就展示文本让用户自行保存。
   */
  function exportIcs(r) {
    const fileName = '我的排班闹钟.ics';
    const type = 'text/calendar';

    // 1) Web Share Level 2：手机上体验最好
    try {
      if (navigator.canShare && window.File) {
        const file = new File([r.text], fileName, { type: type });
        if (navigator.canShare({ files: [file] })) {
          navigator.share({ files: [file], title: '我的排班闹钟' })
            .then(() => toast('已分享 ' + r.count + ' 天 · 请选择「日历」导入'))
            .catch((err) => {
              if (err && err.name === 'AbortError') return;   // 用户主动取消
              tryDownload(r, fileName, type);
            });
          return;
        }
      }
    } catch (e) { /* 继续降级 */ }

    tryDownload(r, fileName, type);
  }

  function tryDownload(r, fileName, type) {
    try {
      const a = document.createElement('a');
      if (typeof a.download === 'undefined') throw new Error('no download');
      const blob = new Blob([r.text], { type: type + ';charset=utf-8' });
      const url = URL.createObjectURL(blob);
      a.href = url; a.download = fileName;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
      toast('已导出 ' + r.count + ' 天 · 用日历 App 打开该文件');
    } catch (e) {
      showIcsFallback(r);
    }
  }

  /** 兜底：把内容摊开让用户复制 */
  function showIcsFallback(r) {
    $('#icsText').value = r.text;
    $('#icsCount').textContent = r.count + ' 天';
    openSheet('#sheetIcs');
  }

  $('#icsClose').addEventListener('click', closeSheets);
  $('#btnCopyIcs').addEventListener('click', () => {
    const ta = $('#icsText');
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    if (!ok && navigator.clipboard) {
      navigator.clipboard.writeText(ta.value).then(() => toast('已复制')).catch(() => toast('请手动长按选择复制'));
      return;
    }
    toast(ok ? '已复制 · 存成 .ics 文件后用日历打开' : '请手动长按选择复制');
  });

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
  function beep() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const t0 = audioCtx.currentTime;
      [0, 0.28, 0.56].forEach((off) => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(880, t0 + off);
        o.frequency.setValueAtTime(1170, t0 + off + 0.12);
        g.gain.setValueAtTime(0.0001, t0 + off);
        g.gain.exponentialRampToValueAtTime(0.32, t0 + off + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.24);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(t0 + off); o.stop(t0 + off + 0.26);
      });
    } catch (e) { /* ignore */ }
  }

  function fireAlarm(item) {
    $('#alarmTitle').textContent = '该准备上班了';
    $('#alarmSub').textContent = item.shift.start + ' ' + item.shift.name + ' · 还有 ' + S.leadMinutes + ' 分钟';
    $('#alarmNow').textContent = hhmm(new Date());
    $('#alarmOverlay').classList.add('on');
    beep();
    clearInterval(ringTimer);
    let n = 0;
    ringTimer = setInterval(() => { beep(); if (++n > 20) clearInterval(ringTimer); }, 1800);
    if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 600]);
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
    clearInterval(ringTimer);
  });
  $('#btnTest').addEventListener('click', () => {
    const sh = S.shifts.find((s) => s.start) || { name: '示例班次', start: '14:00' };
    fireAlarm({ key: 'test', shift: sh });
  });

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

  /* 通知权限 */
  function checkPerm() {
    if (!('Notification' in window)) return;
    $('#permNotice').hidden = Notification.permission === 'granted';
  }
  $('#btnPerm').addEventListener('click', () => {
    if (!('Notification' in window)) { toast('此浏览器不支持通知'); return; }
    Notification.requestPermission().then((p) => {
      checkPerm();
      toast(p === 'granted' ? '通知已开启' : '未开启通知，可用日历导入方式');
      if (!audioCtx) beep();
    });
  });

  /* ================= 启动 ================= */
  function init() {
    const n = new Date();
    viewYear = n.getFullYear();
    viewMonth = n.getMonth();
    renderAll();
    checkPerm();

    setInterval(() => { renderHero(); }, 30000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { renderAll(); checkPerm(); }
    });
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
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }
  init();
})();
