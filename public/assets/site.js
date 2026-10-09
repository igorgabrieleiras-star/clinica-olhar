/* Clínica Olhar — fluxo de agendamento em etapas (sem dependências) */
(function () {
  'use strict';

  var boot = JSON.parse(document.getElementById('boot').textContent);
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var form = $('[data-flow]');
  var card = $('[data-card]');
  var STORE = 'olhar_form_v1';
  var DONE = 'olhar_done_v1';
  var startedAt = Date.now();

  function ss(key, val) {
    try {
      if (val === undefined) return JSON.parse(sessionStorage.getItem(key) || 'null');
      if (val === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, JSON.stringify(val));
    } catch (e) { return null; }
  }
  function ls(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, val);
    } catch (e) { return null; }
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16); crypto.getRandomValues(b);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  // ---------------- Atribuição (UTMs) ----------------
  (function captureAttribution() {
    var p = new URLSearchParams(location.search);
    var keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid'];
    var found = {};
    var any = false;
    keys.forEach(function (k) { var v = p.get(k); if (v) { found[k] = v.slice(0, 300); any = true; } });
    var current = ss('olhar_attr');
    if (any || !current) {
      found.referrer = document.referrer && document.referrer.indexOf(location.origin) !== 0 ? document.referrer.slice(0, 500) : (current && current.referrer) || null;
      found.landing_page = (location.origin + location.pathname + location.search).slice(0, 500);
      ss('olhar_attr', found);
    }
  })();

  // ---------------- Meta Pixel (com consentimento) ----------------
  var meta = boot.meta;
  var pixelLoaded = false;
  var pending = [];
  function adsConsent() {
    if (!meta.pixel) return false;
    if (!meta.requireConsent) return true;
    return ls('olhar_ads_consent') === 'granted';
  }
  function loadPixel() {
    if (pixelLoaded || !meta.pixel) return;
    pixelLoaded = true;
    var f = window;
    if (!f.fbq) {
      var n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!f._fbq) f._fbq = n;
      n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
      var s = document.createElement('script');
      s.async = true; s.src = 'https://connect.facebook.net/en_US/fbevents.js';
      document.head.appendChild(s);
    }
    fbq('init', meta.pixelId);
    fbq('track', 'PageView');
    fbq('track', 'ViewContent', { content_name: 'Exame de vista gratuito', content_category: 'agendamento' });
    pending.splice(0).forEach(function (args) { fbq.apply(null, args); });
  }
  function track(kind, name, params, eventId) {
    if (!meta.pixel) return;
    var args = [kind, name, params || {}];
    if (eventId) args.push({ eventID: eventId });
    if (pixelLoaded) fbq.apply(null, args);
    else if (!meta.requireConsent || ls('olhar_ads_consent') === null) pending.push(args);
  }
  (function setupConsent() {
    var bar = $('[data-cookie]');
    var prefs = $('[data-cookie-prefs]');
    if (!meta.pixel) return;
    if (prefs && meta.requireConsent) prefs.hidden = false;
    function show() { bar.hidden = false; document.body.classList.add('has-cookie'); }
    function hide() { bar.hidden = true; document.body.classList.remove('has-cookie'); }
    if (!meta.requireConsent) { loadPixel(); return; }
    var c = ls('olhar_ads_consent');
    if (c === 'granted') loadPixel();
    else if (c === null) show();
    $('[data-cookie-yes]').addEventListener('click', function () { ls('olhar_ads_consent', 'granted'); hide(); loadPixel(); });
    $('[data-cookie-no]').addEventListener('click', function () { ls('olhar_ads_consent', 'denied'); hide(); pending.length = 0; });
    if (prefs) prefs.addEventListener('click', function () { show(); });
  })();

  // ---------------- Estado do formulário ----------------
  var state = Object.assign({
    step: 1, name: '', age: '', guardian_name: '', guardian_ack: false, whatsapp: '',
    consent_data: false, consent_marketing: false, consent_social: false, date: null, time: null,
  }, ss(STORE) || {});
  if (typeof state.step !== 'number' || state.step > 5) state.step = 1;
  var availability = boot.availability;
  var idemKey = null;
  var submitting = false;

  function save() { ss(STORE, state); }

  function field(name) { return form.elements[name]; }
  function fillInputs() {
    ['name', 'age', 'guardian_name', 'whatsapp'].forEach(function (k) { if (field(k)) field(k).value = state[k] || ''; });
    ['guardian_ack', 'consent_data', 'consent_marketing', 'consent_social'].forEach(function (k) { if (field(k)) field(k).checked = !!state[k]; });
    if (state.whatsapp) field('whatsapp').value = maskPhone(state.whatsapp);
    toggleGuardian();
  }

  function setError(name, msg) {
    var el = $('[data-error="' + name + '"]');
    if (el) el.textContent = msg || '';
    var input = field(name);
    if (input && input.classList && input.classList.contains('input')) {
      if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    }
  }
  function clearErrors(stepEl) {
    $$('[data-error]', stepEl).forEach(function (el) { el.textContent = ''; });
    $$('.input', stepEl).forEach(function (el) { el.removeAttribute('aria-invalid'); });
    var fe = $('[data-form-error]'); if (fe) fe.hidden = true;
  }

  // ---------------- Validações (espelham as do servidor) ----------------
  var NAME_RE = /^[\p{L}][\p{L}\p{M}'’ .-]*[\p{L}.]$/u;
  var DDD = [11,12,13,14,15,16,17,18,19,21,22,24,27,28,31,32,33,34,35,37,38,41,42,43,44,45,46,47,48,49,51,53,54,55,61,62,63,64,65,66,67,68,69,71,73,74,75,77,79,81,82,83,84,85,86,87,88,89,91,92,93,94,95,96,97,98,99];
  function normName(v) { return String(v || '').normalize('NFC').replace(/\s+/g, ' ').trim(); }
  function nameError(v) {
    if (v.length < 2) return 'Digite seu nome.';
    if (v.length > 80) return 'O nome pode ter no máximo 80 caracteres.';
    if (!NAME_RE.test(v)) return 'Use apenas letras no nome.';
    return '';
  }
  function digits(v) { return String(v || '').replace(/\D/g, ''); }
  function phoneDigits(v) {
    var d = digits(v);
    if (d.length >= 12 && d.indexOf('55') === 0) d = d.slice(2);
    if (d.length === 11 && d[0] === '0') d = d.slice(1);
    return d;
  }
  function phoneError(d) {
    var bad = 'Confira o número com DDD. Exemplo: (92) 99999-9999.';
    if (d.length !== 10 && d.length !== 11) return bad;
    if (DDD.indexOf(Number(d.slice(0, 2))) < 0) return bad;
    if (d.length === 11 && d[2] !== '9') return bad;
    if (/^(\d)\1+$/.test(d)) return bad;
    return '';
  }
  function maskPhone(v) {
    var d = digits(v).slice(0, 11);
    if (d.length <= 2) return d.length ? '(' + d : '';
    if (d.length <= 6) return '(' + d.slice(0, 2) + ') ' + d.slice(2);
    if (d.length <= 10) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6);
    return '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7);
  }
  function needsGuardian() {
    var a = Number(state.age);
    return state.age !== '' && a < 18 && boot.rules.minor_rule === 'guardian_required';
  }
  function toggleGuardian() { $('[data-guardian]').hidden = !needsGuardian(); }

  function validateStep(n) {
    var ok = true;
    if (n === 1) {
      state.name = normName(field('name').value);
      var e = nameError(state.name); setError('name', e); ok = !e;
    } else if (n === 2) {
      var raw = digits(field('age').value);
      state.age = raw;
      var r = boot.rules, msg = '';
      if (!raw) msg = 'Digite sua idade em anos.';
      else if (Number(raw) > 120) msg = 'Confira a idade digitada.';
      else if (r.min_age !== null && r.min_age !== '' && Number(raw) < Number(r.min_age)) msg = 'Este atendimento é para pessoas a partir de ' + r.min_age + ' anos.';
      else if (r.max_age !== null && r.max_age !== '' && Number(raw) > Number(r.max_age)) msg = 'Este atendimento é para pessoas de até ' + r.max_age + ' anos.';
      else if (Number(raw) < 18 && r.minor_rule === 'blocked') msg = 'Este atendimento é exclusivo para maiores de 18 anos.';
      setError('age', msg); ok = !msg;
      toggleGuardian();
      if (ok && needsGuardian()) {
        state.guardian_name = normName(field('guardian_name').value);
        state.guardian_ack = field('guardian_ack').checked;
        var ge = nameError(state.guardian_name);
        setError('guardian_name', ge ? (ge === 'Digite seu nome.' ? 'Digite o nome do responsável.' : ge) : '');
        setError('guardian_ack', state.guardian_ack ? '' : 'Confirme o acompanhamento do responsável.');
        ok = !ge && state.guardian_ack;
      }
      if (!needsGuardian()) { state.guardian_name = ''; state.guardian_ack = false; }
    } else if (n === 3) {
      var d = phoneDigits(field('whatsapp').value);
      state.whatsapp = d;
      var pe = phoneError(d); setError('whatsapp', pe);
      state.consent_data = field('consent_data').checked;
      state.consent_marketing = field('consent_marketing').checked;
      state.consent_social = field('consent_social') ? field('consent_social').checked : false;
      setError('consent_data', state.consent_data ? '' : 'Marque a autorização para continuarmos com o agendamento.');
      ok = !pe && state.consent_data;
    } else if (n === 4) {
      var opt = dateOption(state.date);
      setError('date', opt && opt.available ? '' : 'Escolha uma das datas.');
      ok = !!(opt && opt.available);
    } else if (n === 5) {
      var t = timeOption(state.time);
      setError('time', t && t.available ? '' : 'Escolha um horário disponível.');
      ok = !!(t && t.available);
    }
    save();
    return ok;
  }

  function firstInvalid(stepEl) {
    var el = $('[aria-invalid="true"]', stepEl);
    if (el) { el.focus(); return; }
    var msg = $$('[data-error]', stepEl).filter(function (x) { return x.textContent; })[0];
    if (msg) msg.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // ---------------- Disponibilidade ----------------
  function dateOption(date) {
    return (availability.dates || []).filter(function (d) { return d.date === date; })[0] || null;
  }
  function timeOption(time) {
    var d = dateOption(state.date);
    if (!d) return null;
    return d.times.filter(function (t) { return t.time === time; })[0] || null;
  }
  function availableDates() { return (availability.dates || []).filter(function (d) { return d.available; }); }

  function refreshAvailability() {
    return fetch('/api/availability', { headers: { accept: 'application/json' }, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r); })
      .then(function (data) { availability = data; renderSeats(); return data; })
      .catch(function () { return availability; });
  }

  function renderSeats() {
    var el = $('[data-seats]');
    var a = availability;
    var count, dot;
    var title = 'AGENDAMENTOS ABERTOS';
    if (!a.enabled || a.total === 0) {
      dot = ' is-off'; title = 'TODAS AS VAGAS FORAM PREENCHIDAS';
      count = a.waitlist ? 'Entre na lista de espera' : 'Novas datas em breve';
    } else {
      // "Agendamentos abertos" = o sistema aceita novos agendamentos (não indica atendentes online).
      dot = ' is-live';
      // Sem cota de campanha: mensagem genérica. O número só aparece quando é real e baixo.
      count = a.total <= (boot.threshold || 0)
        ? '<span class="seats-urgent">' + (a.total === 1 ? 'ÚLTIMA VAGA DISPONÍVEL' : 'ÚLTIMAS <b>' + a.total + '</b> VAGAS DISPONÍVEIS') + '</span>'
        : 'VAGAS DISPONÍVEIS';
    }
    el.innerHTML = '<span class="seats-dot' + dot + '" aria-hidden="true"></span><span class="seats-text"><strong class="seats-title">' + title + '</strong><span class="seats-count">' + count + '</span></span>';
    var words = dayWords();
    var lede = $('[data-lede]');
    if (words) { lede.innerHTML = 'Faça seu cadastro e escolha seu horário para <b></b>.'; lede.querySelector('b').textContent = words; }
    else lede.textContent = 'Faça seu cadastro e escolha o melhor horário para realizar seu exame de vista gratuito.';
  }
  function dayWords() {
    var w = [];
    (availability.dates || []).forEach(function (d) {
      if (!d.available) return;
      (d.kinds || [d.kind]).forEach(function (k) {
        var x = k === 'hoje' ? 'hoje' : k === 'amanha' ? 'amanhã' : 'sábado';
        if (w.indexOf(x) < 0) w.push(x);
      });
    });
    if (!w.length) return '';
    return w.length === 1 ? w[0] : w.slice(0, -1).join(', ') + ' ou ' + w[w.length - 1];
  }

  var CAL = '<svg class="cal" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 9.8h17M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><rect x="7" y="12.6" width="3.4" height="3" rx=".8" fill="currentColor"/></svg>';
  var MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  var WD = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB'];
  var WD_SHORT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  var calMonth = null;
  function weekday(iso) { return new Date(iso + 'T12:00:00Z').getUTCDay(); }
  function vagas(n) { return n === 1 ? '1 vaga' : n + ' vagas'; }

  // Calendário: só HOJE / AMANHÃ / SÁBADO com vagas reais ficam clicáveis; o resto aparece desabilitado.
  function renderDates() {
    if (state.date && !(dateOption(state.date) || {}).available) { state.date = null; state.time = null; }
    var a = availability;
    var today = a.now ? a.now.date : (a.dates[0] || {}).date;
    var months = [];
    [today].concat((a.dates || []).map(function (d) { return d.date; })).forEach(function (iso) { var mo = iso.slice(0, 7); if (months.indexOf(mo) < 0) months.push(mo); });
    months.sort();
    var firstAvail = availableDates()[0];
    if (!calMonth || months.indexOf(calMonth) < 0) calMonth = (state.date || (firstAvail && firstAvail.date) || today).slice(0, 7);
    var y = Number(calMonth.slice(0, 4)), m = Number(calMonth.slice(5, 7));
    var lead = weekday(calMonth + '-01');
    var n = new Date(Date.UTC(y, m, 0)).getUTCDate();
    var idx = months.indexOf(calMonth);
    var html = '<div class="cal-head">' +
      '<button type="button" class="cal-nav" data-cal-nav="-1" aria-label="Mês anterior"' + (idx <= 0 ? ' disabled' : '') + '>‹</button>' +
      '<p class="cal-title">' + MONTHS[m - 1].charAt(0).toUpperCase() + MONTHS[m - 1].slice(1) + ' ' + y + '</p>' +
      '<button type="button" class="cal-nav" data-cal-nav="1" aria-label="Próximo mês"' + (idx >= months.length - 1 ? ' disabled' : '') + '>›</button></div>' +
      '<div class="cal-grid cal-wd">' + WD.map(function (w) { return '<span>' + w + '</span>'; }).join('') + '</div><div class="cal-grid">';
    for (var i = 0; i < lead; i++) html += '<span class="cal-day is-blank" aria-hidden="true"></span>';
    for (var d = 1; d <= n; d++) {
      var iso = calMonth + '-' + (d < 10 ? '0' : '') + d;
      var opt = dateOption(iso);
      var isToday = iso === today;
      if (opt && opt.available) {
        var sel = state.date === iso;
        html += '<button type="button" class="cal-day is-on' + (isToday ? ' is-today' : '') + (sel ? ' is-sel' : '') + '" data-date="' + iso + '" aria-pressed="' + sel + '" aria-label="' + opt.tag + ': ' + opt.label + ', ' + vagas(opt.remaining) + '">' + d + '</button>';
      } else {
        var why = opt ? 'sem vagas' : iso < today ? 'data passada' : 'indisponível';
        html += '<span class="cal-day is-off' + (iso < today ? ' is-past' : '') + '" aria-disabled="true" title="' + why + '">' + d + '</span>';
      }
    }
    html += '</div>';
    // Atalhos grandes para as datas permitidas (mais fáceis de tocar que os dias do calendário).
    var chips = (a.dates || []).map(function (o) {
      var p = o.date.split('-');
      var on = o.available;
      return '<button type="button" class="day-chip' + (state.date === o.date ? ' is-sel' : '') + (o.isToday ? ' is-today' : '') + '"' + (on ? ' data-date="' + o.date + '"' : ' disabled') + '>' +
        '<span class="dc-tag">' + o.tag + '</span><span class="dc-date">' + WD_SHORT[weekday(o.date)] + ', ' + p[2] + '/' + p[1] + '</span>' +
        '<span class="dc-left">' + (on ? vagas(o.remaining) : (o.isToday ? 'Sem horários hoje' : 'Sem vagas')) + '</span></button>';
    }).join('');
    $('[data-calendar]').innerHTML = html + '<div class="day-chips">' + chips + '</div>';
    renderToday();
    var picked = $('[data-cal-picked]');
    var po = dateOption(state.date);
    picked.hidden = !po;
    if (po) picked.textContent = po.tag + ' · ' + po.label + ' · ' + vagas(po.remaining);
    save();
  }

  function renderToday() {
    var box = $('[data-today]');
    var t = availability.today;
    box.hidden = !t;
    if (!t) return;
    $('[data-today-slots]').innerHTML = t.next.map(function (x) {
      return '<li class="' + (x.left === 1 ? 'is-last' : '') + '"><b>' + x.time + '</b><span>' + (x.left === 1 ? 'ÚLTIMA VAGA' : vagas(x.left)) + '</span></li>';
    }).join('');
  }

  function renderTimes() {
    var d = dateOption(state.date);
    var box = $('[data-times]');
    $('[data-chosen-date]').innerHTML = d ? CAL.replace('class="cal"', '') + '<span><b>' + d.tag + '</b> · ' + d.label + '</span>' : '';
    var note = $('[data-lead-note]');
    note.hidden = !(d && d.isToday);
    if (d && d.isToday) note.textContent = 'Para hoje, mostramos apenas horários com pelo menos ' + (availability.leadTime >= 60 && availability.leadTime % 60 === 0 ? (availability.leadTime / 60) + (availability.leadTime === 60 ? ' hora' : ' horas') : availability.leadTime + ' minutos') + ' de antecedência.';
    if (!d) { box.innerHTML = ''; return; }
    if (state.time && !(timeOption(state.time) || {}).available) state.time = null;
    var groups = { manha: [], tarde: [] };
    d.times.forEach(function (t) { groups[t.period].push(t); });
    var html = '';
    [['manha', 'MANHÃ'], ['tarde', 'TARDE']].forEach(function (g) {
      if (!groups[g[0]].length) return;
      html += '<p class="period">' + g[1] + '</p><div class="time-grid" role="radiogroup" aria-label="Horários da ' + (g[0] === 'manha' ? 'manhã' : 'tarde') + '">';
      groups[g[0]].forEach(function (t) {
        if (!t.available) { html += '<button type="button" class="time" disabled aria-label="' + t.time + ', esgotado">' + t.time + '<small>Esgotado</small></button>'; return; }
        var badge = t.left === 1 ? '<small class="t-last">Última vaga</small>' : d.isToday ? '<small>' + vagas(t.left) + '</small>' : '';
        html += '<button type="button" class="time' + (t.left === 1 ? ' is-last' : '') + '" role="radio" aria-checked="' + (state.time === t.time) + '" data-time="' + t.time + '" aria-label="' + t.time + ', ' + vagas(t.left) + '">' + t.time + badge + '</button>';
      });
      html += '</div>';
    });
    box.innerHTML = html || '<p class="empty-times">Não há horários livres nesta data.</p>';
    renderSummary();
    save();
  }

  function renderSummary() {
    var sum = $('[data-summary]');
    var d = dateOption(state.date);
    sum.hidden = !state.time;
    var t = timeOption(state.time);
    $('[data-last-seat]').hidden = !(t && t.left === 1);
    if (!state.time) return;
    $('[data-sum="name"]').textContent = state.name + (state.guardian_name ? ' (resp.: ' + state.guardian_name + ')' : '');
    $('[data-sum="date"]').textContent = d ? (d.isToday ? 'Hoje, ' : '') + d.label : '';
    $('[data-sum="time"]').textContent = state.time;
    $('[data-sum="whatsapp"]').textContent = maskPhone(state.whatsapp);
  }

  // ---------------- Navegação entre etapas ----------------
  var current = null;
  function showStep(step, opts) {
    opts = opts || {};
    var prev = current;
    current = step;
    $$('.step', form).forEach(function (s) {
      var on = String(s.getAttribute('data-step')) === String(step);
      s.hidden = !on;
      s.classList.toggle('is-active', on);
      s.classList.toggle('is-back', on && !!opts.back);
    });
    var num = typeof step === 'number' ? step : null;
    $('[data-head]').hidden = !num;
    if (num) {
      $('[data-step-count]').textContent = 'Etapa ' + num + ' de 5';
      $$('.progress li').forEach(function (li, i) { li.classList.toggle('on', i < num); });
      state.step = num; save();
    }
    if (step === 4) renderDates();
    if (step === 5) renderTimes();
    if (prev === null) return; // carregamento inicial: não rouba o foco nem rola a página
    var target = { 2: 'age', 3: 'whatsapp' }[step];
    if (target && !field(target).value) field(target).focus({ preventScroll: true });
    else { var h = $('[data-step="' + step + '"] .step-title'); if (h) h.focus({ preventScroll: true }); }
    var top = card.getBoundingClientRect().top;
    if (top < 0 || top > window.innerHeight * 0.4) card.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function goNext(from) {
    var stepEl = $('[data-step="' + from + '"]');
    clearErrors(stepEl);
    if (!validateStep(from)) { firstInvalid(stepEl); return; }
    if (from === 3) {
      // Ao chegar na escolha de data, a disponibilidade é consultada novamente no servidor.
      var btn = $('[data-next]', stepEl); btn.disabled = true;
      refreshAvailability().then(function () {
        btn.disabled = false;
        if (!availableDates().length) return showWaitlist();
        showStep(4);
      });
      return;
    }
    if (from === 4) {
      var btn4 = $('[data-next]', stepEl); btn4.disabled = true;
      refreshAvailability().then(function () {
        btn4.disabled = false;
        if (!availableDates().length) return showWaitlist();
        var opt = dateOption(state.date);
        if (!opt || !opt.available) { renderDates(); setError('date', 'As vagas desta data acabaram. Escolha outra data.'); return; }
        showStep(5);
      });
      return;
    }
    showStep(from + 1);
  }

  form.addEventListener('click', function (e) {
    var t = e.target.closest('button');
    if (!t) return;
    if (t.hasAttribute('data-next')) { e.preventDefault(); goNext(current); }
    else if (t.hasAttribute('data-back')) { e.preventDefault(); clearErrors(form); showStep(Math.max(1, current - 1), { back: true }); }
    else if (t.hasAttribute('data-edit')) { e.preventDefault(); showStep(Number(t.getAttribute('data-edit')), { back: true }); }
    else if (t.hasAttribute('data-date')) {
      // Selecionar a data já carrega os horários dela.
      state.date = t.getAttribute('data-date'); state.time = null; setError('date', '');
      save(); renderDates(); goNext(4);
    } else if (t.hasAttribute('data-today-go')) {
      e.preventDefault();
      if (availability.today) { state.date = availability.today.date; state.time = null; setError('date', ''); save(); goNext(4); }
    } else if (t.hasAttribute('data-cal-nav')) {
      e.preventDefault();
      var mo = new Date(calMonth + '-15T12:00:00Z'); mo.setUTCMonth(mo.getUTCMonth() + Number(t.getAttribute('data-cal-nav')));
      calMonth = mo.toISOString().slice(0, 7); renderDates();
    } else if (t.hasAttribute('data-time')) {
      state.time = t.getAttribute('data-time'); setError('time', '');
      $$('.time[data-time]', form).forEach(function (c) { c.setAttribute('aria-checked', String(c === t)); });
      renderSummary(); save();
      var fe = $('[data-form-error]'); fe.hidden = true; $('[data-lead-note]').classList.remove('is-alert');
      $('[data-confirm]').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else if (t.hasAttribute('data-waitlist-edit')) { e.preventDefault(); showStep(1, { back: true }); }
    else if (t.hasAttribute('data-waitlist-join')) { e.preventDefault(); joinWaitlist(t); }
  });

  // Enter avança a etapa (em vez de enviar o formulário inteiro).
  form.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.matches('input.input')) { e.preventDefault(); goNext(current); }
  });
  form.addEventListener('submit', function (e) { e.preventDefault(); if (current === 5) confirmBooking(); });

  field('whatsapp').addEventListener('input', function (e) {
    var el = e.target, before = el.value;
    var masked = maskPhone(before);
    if (masked !== before) el.value = masked;
  });
  field('age').addEventListener('input', function (e) {
    e.target.value = digits(e.target.value).slice(0, 3);
    state.age = e.target.value; toggleGuardian();
  });
  form.addEventListener('input', function (e) {
    if (e.target.name) setError(e.target.name, '');
  });

  // StartRegistration: uma vez por sessão, na primeira interação com o formulário.
  var started = !!ss('olhar_started');
  // O cronômetro começa quando o visitante digita ou marca algo (não no toque em botões, para não deslocar a tela).
  function startTimer(e) { if (typeof current === 'number' && e.target.name && e.target.name !== 'website') timer.start(); }
  form.addEventListener('input', startTimer);
  form.addEventListener('change', startTimer);
  form.addEventListener('focusin', function () {
    if (started) return;
    started = true; ss('olhar_started', true);
    track('trackCustom', 'StartRegistration', { content_name: 'Exame de vista gratuito' });
  });


  // ---------------- Cronômetro de 10 minutos ----------------
  // Não existe reserva temporária de horário: o cronômetro é um guia de tempo de preenchimento.
  // Ao zerar, a disponibilidade é atualizada e os dados preenchidos são mantidos — nada é cancelado.
  var timer = (function () {
    var KEY = 'olhar_timer_v1', LIMIT = 600;
    var box = $('[data-timer]'), clock = $('[data-timer-clock]'), msg = $('[data-timer-msg]');
    var startAt = null, iv = null, finished = false, phase = '';
    function fmt(sec) { var m = Math.floor(sec / 60), x = sec % 60; return (m < 10 ? '0' : '') + m + ':' + (x < 10 ? '0' : '') + x; }
    function setPhase(p) { if (p === phase) return; phase = p; box.className = 'timer' + (p ? ' ' + p : ''); }
    function tick() {
      var left = Math.max(0, LIMIT - Math.floor((Date.now() - startAt) / 1000));
      clock.textContent = fmt(left);
      if (left === 0) {
        setPhase('is-over');
        msg.textContent = 'Tempo sugerido encerrado. Seus dados foram mantidos — confira os horários atualizados e conclua seu agendamento.';
        msg.hidden = false;
        clearInterval(iv); iv = null;
        if (!finished) { finished = true; autoRefresh(); }
        return;
      }
      setPhase(left >= 300 ? '' : left >= 120 ? 'is-deep' : left > 60 ? 'is-warn' : 'is-crit');
      if (left <= 60) { if (msg.hidden) { msg.textContent = 'Falta menos de 1 minuto para concluir sua reserva.'; msg.hidden = false; } }
      else msg.hidden = true;
    }
    function run() { box.hidden = false; tick(); if (!iv && !finished) iv = setInterval(tick, 1000); }
    return {
      start: function () {
        if (startAt !== null) return;
        startAt = Number(ss(KEY)) || Date.now();
        ss(KEY, startAt);
        run();
      },
      resume: function () { var v = Number(ss(KEY)); if (v) { startAt = v; run(); } },
      stop: function () { clearInterval(iv); iv = null; box.hidden = true; startAt = null; finished = false; phase = null; ss(KEY, null); },
    };
  })();

  // ---------------- Envio ----------------
  function errorMessageFor(data) {
    return (data && data.error) || 'Não foi possível concluir agora. Verifique sua internet e tente novamente.';
  }
  function confirmBooking() {
    if (submitting) return;
    var stepEl = $('[data-step="5"]');
    clearErrors(stepEl);
    if (!validateStep(5)) { firstInvalid(stepEl); return; }
    // Revalida as etapas anteriores (dados podem ter sido alterados)
    for (var i = 1; i <= 3; i++) {
      if (!validateStep(i)) { showStep(i, { back: true }); return; }
    }
    submitting = true;
    var btn = $('[data-confirm]');
    var label = btn.textContent;
    btn.disabled = true; btn.textContent = 'CONFIRMANDO…';
    idemKey = idemKey || uuid();
    var payload = {
      name: state.name, age: state.age, guardian_name: state.guardian_name || null, guardian_ack: !!state.guardian_ack,
      whatsapp: state.whatsapp, date: state.date, time: state.time,
      consent_data: !!state.consent_data, consent_marketing: !!state.consent_marketing, consent_social: !!state.consent_social,
      ads_consent: adsConsent(), idempotency_key: idemKey, elapsed_ms: Date.now() - startedAt,
      website: form.elements.website.value, attribution: ss('olhar_attr') || {},
    };
    fetch('/api/bookings', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (data) { return { status: r.status, data: data }; }); })
      .then(function (res) {
        submitting = false; btn.disabled = false; btn.textContent = label;
        if (res.status === 200 || res.status === 201) return onBooked(res.data.booking);
        idemKey = null; // nova tentativa = novo pedido
        var d = res.data || {};
        if (d.code === 'SLOT_FULL' || d.code === 'SLOT_UNAVAILABLE' || d.code === 'SLOT_TOO_SOON') {
          state.time = null;
          return refreshAvailability().then(function () {
            if (!availableDates().length) return showWaitlist();
            if (!(dateOption(state.date) || {}).available) { showStep(4); setError('date', 'As vagas desta data acabaram. Escolha outra data.'); return; }
            renderTimes(); showFormError(errorMessageFor(d));
          });
        }
        if (d.code === 'DATE_NOT_ALLOWED' || d.code === 'DATE_UNAVAILABLE' || d.code === 'BOOKING_CLOSED') {
          state.date = null; state.time = null;
          return refreshAvailability().then(function () { if (!availableDates().length) return showWaitlist(); showStep(4); setError('date', errorMessageFor(d)); });
        }
        if (d.field) {
          var map = { name: 1, age: 2, guardian_name: 2, guardian_ack: 2, whatsapp: 3, consent_data: 3, date: 4, time: 5 };
          if (map[d.field] && map[d.field] !== 5) { showStep(map[d.field], { back: true }); }
          setError(d.field, d.error);
          return;
        }
        showFormError(errorMessageFor(d));
      })
      .catch(function () {
        submitting = false; btn.disabled = false; btn.textContent = label;
        // Mantém a mesma chave: se o pedido chegou ao servidor, a nova tentativa não duplica.
        showFormError('Sem conexão. Verifique sua internet e toque em confirmar novamente.');
      });
  }
  function showFormError(msg) { var fe = $('[data-form-error]'); fe.textContent = msg; fe.hidden = false; fe.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }

  function onBooked(b) {
    timer.stop();
    ss(DONE, b);
    ss(STORE, null);
    // Lead: somente após gravação no banco; uma vez por agendamento (event_id usado também na API de Conversões).
    var key = 'olhar_lead_' + b.eventId;
    if (!ls(key)) {
      ls(key, '1');
      track('track', 'Lead', { content_name: 'Exame de vista gratuito' }, b.eventId);
      if (meta.scheduleEvent) track('track', 'Schedule', { content_name: 'Exame de vista gratuito' }, b.eventId);
    }
    showDone(b, true);
    refreshAvailability();
  }

  function showDone(b, focus) {
    form.hidden = true;
    var done = $('[data-done]');
    done.hidden = false;
    var set = function (k, v) { var el = $('[data-t="' + k + '"]'); if (el) el.textContent = v; };
    set('name', b.name); set('age', b.age + (Number(b.age) === 1 ? ' ano' : ' anos')); set('date', b.dateLabel); set('time', b.time);
    set('whatsapp', b.whatsapp); set('protocol', b.protocol);
    $('[data-t-guardian-row]').hidden = !b.guardian; set('guardian', b.guardian || '');
    var addr = b.clinic && b.clinic.address;
    $('[data-t-address-row]').hidden = !addr; set('address', addr || '');
    var wa = $('[data-wa-confirm]');
    if (wa && b.clinic && b.clinic.whatsapp) {
      var msg = 'Olá! Realizei meu agendamento pelo site da ' + b.clinic.name + '. Meu protocolo é ' + b.protocol + '. Gostaria de confirmar as informações do meu exame de vista gratuito.';
      wa.href = 'https://wa.me/55' + b.clinic.whatsapp + '?text=' + encodeURIComponent(msg);
    }
    if (focus) {
      card.scrollIntoView({ block: 'start', behavior: 'smooth' });
      $('.done-title').focus({ preventScroll: true });
    }
  }

  $('[data-done]').addEventListener('click', function (e) {
    if (e.target.closest('[data-wa-confirm]')) track('track', 'Contact', { content_name: 'Confirmação pelo WhatsApp' });
    if (e.target.closest('[data-again]')) {
      ss(DONE, null);
      state = { step: 1, name: '', age: '', guardian_name: '', guardian_ack: false, whatsapp: state.whatsapp || '', consent_data: false, consent_marketing: false, consent_social: false, date: null, time: null };
      var last = ss('olhar_last_phone'); if (last) state.whatsapp = last;
      save(); fillInputs();
      $('[data-done]').hidden = true; form.hidden = false; idemKey = null; timer.stop();
      refreshAvailability().then(function () { showStep(1); field('name').focus(); });
    }
  });
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-contact]')) track('track', 'Contact', { content_name: 'WhatsApp do rodapé' });
    var go = e.target.closest('[data-goto-form]');
    if (go) { e.preventDefault(); card.scrollIntoView({ block: 'start', behavior: 'smooth' }); if (current === 1) setTimeout(function () { field('name').focus({ preventScroll: true }); }, 400); }
  });

  // ---------------- Lista de espera ----------------
  function showWaitlist() {
    timer.stop();
    current = null;
    showStep('waitlist');
    var canJoin = availability.waitlist && state.name && state.whatsapp && state.consent_data;
    $('[data-waitlist-body]').hidden = !availability.waitlist;
    $('[data-waitlist-who]').textContent = canJoin ? 'Vamos usar os dados informados: ' + state.name + ' · ' + maskPhone(state.whatsapp) + '.' : '';
    $('[data-waitlist-join]').hidden = !canJoin;
    if (!availability.waitlist) $('.step[data-step="waitlist"] .step-sub').textContent = 'Novas datas serão abertas em breve. Volte a consultar esta página.';
  }
  function joinWaitlist(btn) {
    btn.disabled = true;
    var err = $('[data-waitlist-error]'); err.hidden = true;
    fetch('/api/waitlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: state.name, age: state.age, whatsapp: state.whatsapp, consent_data: !!state.consent_data, consent_marketing: !!state.consent_marketing, website: form.elements.website.value }) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        btn.disabled = false;
        if (!res.ok) { err.textContent = res.d.error || 'Não foi possível entrar na lista agora.'; err.hidden = false; return; }
        $('[data-waitlist-body]').hidden = true; $('[data-waitlist-done]').hidden = false;
      })
      .catch(function () { btn.disabled = false; err.textContent = 'Sem conexão. Tente novamente.'; err.hidden = false; });
  }

  // ---------------- Avisos de agendamentos recentes (somente reais e autorizados) ----------------
  // Pequenos, no canto inferior esquerdo, um por vez. Nunca cobrem campos, calendário, horários ou botões:
  // se não houver espaço livre, o aviso é adiado; se o visitante rolar até um controle, ele some na hora.
  (function socialProof() {
    if (!boot.socialProof) return;
    var toast = $('[data-toast]');
    var queue = [], shown = 0, MAX = 4, hideT = null, tries = 0;
    var GUARDED = 'input, select, textarea, button, a.btn, .calendar, .time-grid, .today-box, .cookie:not([hidden])';
    function overlaps(r) {
      return $$(GUARDED).some(function (el) {
        if (el === toast || toast.contains(el)) return false;
        var b = el.getBoundingClientRect();
        if (!b.width || !b.height) return false;
        return b.left < r.right + 6 && b.right > r.left - 6 && b.top < r.bottom + 6 && b.bottom > r.top - 6;
      });
    }
    function blocked() { return document.hidden || document.body.classList.contains('kb-open') || document.body.classList.contains('has-cookie'); }
    function ago(m) { return m < 60 ? 'há ' + m + ' min' : m < 120 ? 'há 1 hora' : m < 1440 ? 'há ' + Math.floor(m / 60) + ' horas' : 'recentemente'; }
    function hide() {
      if (toast.hidden) return;
      clearTimeout(hideT);
      toast.classList.remove('show'); toast.classList.add('hide');
      setTimeout(function () { toast.hidden = true; toast.classList.remove('hide'); }, 400);
    }
    function guard() { if (!toast.hidden && (blocked() || overlaps(toast.getBoundingClientRect()))) hide(); }
    window.addEventListener('scroll', guard, { passive: true });
    window.addEventListener('resize', guard);
    document.addEventListener('focusin', guard);
    function next() {
      if (shown >= MAX || !queue.length) return;
      var it = queue[0];
      toast.innerHTML = '<span class="t-ico" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M5 10.5l3.2 3.2L15 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>' +
        '<span><b></b> <span data-what></span>.<small>' + (it.demo ? 'Demonstração · ' : '') + ago(it.minutesAgo) + '</small></span>';
      toast.querySelector('b').textContent = it.firstName;
      toast.querySelector('[data-what]').textContent = (it.action || 'agendou seu exame') + (it.when ? ' ' + it.when : '');
      // Mede a posição sem exibir: só aparece se houver espaço livre.
      toast.style.visibility = 'hidden'; toast.hidden = false;
      var r = toast.getBoundingClientRect();
      toast.hidden = true; toast.style.visibility = '';
      if (blocked() || overlaps(r)) {
        if (++tries > 24) { queue.shift(); tries = 0; } // não encontrou espaço: descarta este aviso
        setTimeout(next, 5000);
        return;
      }
      queue.shift(); tries = 0; shown++;
      toast.hidden = false;
      requestAnimationFrame(function () { requestAnimationFrame(function () { toast.classList.add('show'); }); });
      hideT = setTimeout(hide, 4000);
      setTimeout(next, 20000);
    }
    setTimeout(function () {
      fetch('/api/activity').then(function (r) { return r.json(); }).then(function (d) { queue = (d.items || []).slice(0, MAX); next(); }).catch(function () {});
    }, 9000);
  })();

  // Teclado aberto no celular: esconde elementos flutuantes para não cobrirem o campo.
  document.addEventListener('focusin', function (e) { if (e.target.matches('input.input')) document.body.classList.add('kb-open'); });
  document.addEventListener('focusout', function () { setTimeout(function () { if (!document.activeElement || !document.activeElement.matches('input.input')) document.body.classList.remove('kb-open'); }, 100); });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', function () {
      var a = document.activeElement;
      if (a && a.matches && a.matches('input.input')) a.scrollIntoView({ block: 'center' });
    });
  }

  // Atualização automática (relógio do servidor): horários de hoje que perdem a antecedência mínima somem,
  // vagas e datas são recalculadas, e o que o visitante já preencheu é mantido.
  function reconcile() {
    if (current === 4) renderDates();
    if (current === 5 && !submitting) {
      var d = dateOption(state.date);
      if (!d || !d.available) {
        state.time = null;
        if (!availableDates().length) return showWaitlist();
        showStep(4);
        setError('date', 'Esta data não tem mais horários disponíveis. Escolha outra data.');
        return;
      }
      var had = state.time;
      renderTimes();
      if (had && !state.time) showFormError('Este horário não está mais disponível. Escolha outro horário.');
    }
  }
  function autoRefresh() { if (!document.hidden) refreshAvailability().then(reconcile); }
  setInterval(autoRefresh, 60000);
  document.addEventListener('visibilitychange', autoRefresh);

  // ---------------- Início ----------------
  var done = ss(DONE);
  fillInputs();
  if (done) { showDone(done, false); }
  else if (!availability.enabled || availability.total === 0) {
    // Sem vagas: o formulário coleta nome, idade e WhatsApp para a lista de espera.
    showStep(state.step <= 3 ? state.step : 1);
  } else {
    var resume = state.step;
    if (resume >= 4 && !availableDates().length) resume = 3;
    showStep(resume);
  }
  if (!done && !form.hidden && current !== 'waitlist') timer.resume(); // recarregou no meio do cadastro: continua de onde estava
  // Guarda o último WhatsApp usado para facilitar novo agendamento na mesma sessão.
  window.addEventListener('beforeunload', function () { if (state.whatsapp) ss('olhar_last_phone', state.whatsapp); });
})();
