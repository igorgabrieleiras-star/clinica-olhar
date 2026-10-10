/* Clínica Olhar — painel administrativo (sem dependências) */
(function () {
  'use strict';
  var app = document.getElementById('app');
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  // Logomarca oficial (versões com fundo transparente, sempre sobre azul-marinho)
  var LOGO_SIG = '<img class="logo-sig" src="/brand/logo-assinatura.png" alt="Clínica Olhar" width="113" height="44">';
  var LOGO_FULL = '<img class="logo-full" src="/brand/logo-completo.png" alt="Clínica Olhar" width="148" height="110">';
  var STATUS = { NOVO: 'Agendado',CONFIRMADO: 'Confirmado', CONTATADO: 'Contatado', COMPARECEU: 'Compareceu', NAO_COMPARECEU: 'Não compareceu', CANCELADO: 'Cancelado' };
  var DAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  var me = null;
  // Endereço do site público (o painel roda em outro domínio). Vazio em desenvolvimento = mesmo servidor.
  var metaUrl = document.querySelector('meta[name="olhar-public-url"]');
  var SAME_ORIGIN = metaUrl && metaUrl.getAttribute('data-role') === 'all';
  var PUBLIC_URL = SAME_ORIGIN ? '' : (metaUrl ? metaUrl.getAttribute('content') : '');
  function publicLink(path, label, cls) {
    if (!SAME_ORIGIN && !PUBLIC_URL) return '';
    return '<a class="' + (cls || 'btn') + '" href="' + esc(PUBLIC_URL + path) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
  }

  // A CSP do painel bloqueia atributos style="" vindos de HTML. Reaplicamos esses estilos pelo CSSOM
  // (permitido pela CSP), mantendo a política rígida contra injeção de CSS.
  function applyInlineStyles(node) {
    if (node.nodeType !== 1) return;
    if (node.hasAttribute('style')) node.style.cssText = node.getAttribute('style');
    Array.prototype.forEach.call(node.querySelectorAll('[style]'), function (el) { el.style.cssText = el.getAttribute('style'); });
  }
  new MutationObserver(function (list) {
    list.forEach(function (m) { Array.prototype.forEach.call(m.addedNodes, applyInlineStyles); });
  }).observe(document.documentElement, { childList: true, subtree: true });

  // ---------- API ----------
  function api(method, url, body) {
    var opts = { method: method, credentials: 'same-origin', headers: { accept: 'application/json', 'x-olhar-csrf': '1' } };
    if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (r.status === 401 && d.code === 'UNAUTHENTICATED') { renderLogin(d.error); throw new Error(d.error || 'Sessão expirada'); }
        if (r.status === 403 && d.code === 'MUST_CHANGE_PASSWORD') { renderChangePassword(); throw new Error(d.error); }
        if (!r.ok) { var e = new Error(d.error || 'Erro ' + r.status); e.data = d; e.status = r.status; e.code = d.code; throw e; }
        return d;
      });
    });
  }
  function toast(msg, bad) {
    var t = document.createElement('div');
    t.className = 'toast' + (bad ? ' bad' : ''); t.textContent = msg; t.setAttribute('role', 'status');
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3200);
  }
  function fail(e) { if (e && e.message) toast(e.message, true); }
  function fmtDate(iso) { return iso ? iso.split('-').reverse().join('/') : ''; }
  function phone(d) { if (!d) return ''; return d.length === 11 ? '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7) : '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6); }
  function wa(d, text) { return 'https://wa.me/55' + d + (text ? '?text=' + encodeURIComponent(text) : ''); }

  // ---------- Autenticação ----------
  function renderLogin(msg) {
    stopLive();
    me = null;
    app.className = '';
    app.innerHTML = '<div class="auth"><div class="auth-brand">' + LOGO_FULL + '</div><form class="auth-card" id="login" novalidate>' +
      '<h1>Painel administrativo</h1><p>Entre com seu e-mail e senha.</p>' +
      '<label class="f"><span>E-mail</span><input type="email" name="email" autocomplete="username" required></label>' +
      '<label class="f"><span>Senha</span><input type="password" name="password" autocomplete="current-password" required></label>' +
      '<p class="err" id="login-err"' + (msg && msg !== 'Sua sessão expirou. Entre novamente.' ? '' : ' hidden') + '>' + esc(msg || '') + '</p>' +
      '<button class="btn primary btn-block">Entrar</button></form></div>';
    $('#login').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target, err = $('#login-err');
      f.querySelector('button').disabled = true;
      api('POST', '/api/admin/login', { email: f.email.value, password: f.password.value })
        .then(function (d) { me = d.admin; if (me.mustChangePassword) renderChangePassword(); else route(); })
        .catch(function (x) { err.textContent = x.message; err.hidden = false; f.querySelector('button').disabled = false; });
    });
    $('#login input').focus();
  }

  function renderChangePassword() {
    app.className = '';
    app.innerHTML = '<div class="auth"><div class="auth-brand">' + LOGO_FULL + '</div><form class="auth-card" id="pw" novalidate>' +
      '<h1>Crie uma nova senha</h1><p>Por segurança, troque a senha inicial antes de continuar. Use pelo menos 12 caracteres, com letras e números.</p>' +
      '<label class="f"><span>Senha atual</span><input type="password" name="current" autocomplete="current-password"></label>' +
      '<label class="f"><span>Nova senha</span><input type="password" name="next" autocomplete="new-password" minlength="12"></label>' +
      '<label class="f"><span>Repita a nova senha</span><input type="password" name="again" autocomplete="new-password"></label>' +
      '<p class="err" id="pw-err" hidden></p><button class="btn primary btn-block">Salvar nova senha</button></form></div>';
    $('#pw').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target, err = $('#pw-err');
      if (f.next.value !== f.again.value) { err.textContent = 'As senhas não conferem.'; err.hidden = false; return; }
      api('POST', '/api/admin/password', { current: f.current.value, next: f.next.value })
        .then(function () { toast('Senha alterada.'); me.mustChangePassword = false; location.hash = '#/painel'; route(); })
        .catch(function (x) { err.textContent = x.message; err.hidden = false; });
    });
  }

  // ---------- Estrutura ----------
  var ALL_PAGES = [
    ['painel', 'Painel'], ['agendamentos', 'Agendamentos'], ['agenda', 'Agenda'], ['espera', 'Lista de espera'],
    ['configuracoes', 'Configurações'], ['administradores', 'Administradores', true], ['integracoes', 'Integrações', true],
  ];
  var PAGES = ALL_PAGES;
  function isPrincipal() { return !!(me && me.role === 'principal'); }
  function shell(active, inner) {
    app.className = '';
    // Administradores comuns não veem Administradores nem Integrações (o servidor também nega o acesso).
    PAGES = ALL_PAGES.filter(function (p) { return !p[2] || isPrincipal(); });
    var label = (PAGES.filter(function (p) { return p[0] === active; })[0] || PAGES[0])[1];
    app.innerHTML = '<div class="shell">' +
      // Barra superior do celular: logomarca + botão do menu
      '<header class="mbar"><button type="button" class="menu-btn" id="menu-open" aria-controls="side" aria-expanded="false"><span class="menu-ico" aria-hidden="true"></span><span class="sr">Abrir menu</span></button>' +
      '<span class="mbar-title">' + esc(label) + '</span>' + LOGO_SIG + '</header>' +
      '<div class="side-bg" id="side-bg" hidden></div>' +
      '<aside class="side" id="side"><div class="side-top"><div class="logo">' + LOGO_SIG + '</div><button type="button" class="menu-close" id="menu-close" aria-label="Fechar menu">×</button></div><nav class="nav">' +
      PAGES.map(function (p) { return '<a href="#/' + p[0] + '" class="' + (p[0] === active ? 'on' : '') + '">' + p[1] + '</a>'; }).join('') +
      '</nav><div class="side-foot"><div class="who"><b>' + esc(me.name) + '</b><span>' + esc(me.email) + '</span><span class="role-tag">' + esc(me.roleLabel || '') + '</span></div><button type="button" id="logout">Sair</button></div></aside><main class="main" id="main">' + inner + '</main></div>';
    $('#logout').addEventListener('click', function () { api('POST', '/api/admin/logout').then(function () { location.hash = '#/painel'; renderLogin(); }); });
    var side = $('#side'), bg = $('#side-bg'), openBtn = $('#menu-open');
    function setMenu(open) {
      side.classList.toggle('open', open); bg.hidden = !open; openBtn.setAttribute('aria-expanded', String(open));
      document.body.classList.toggle('menu-open', open);
      if (open) $('.nav a', side).focus();
    }
    openBtn.addEventListener('click', function () { setMenu(true); });
    $('#menu-close').addEventListener('click', function () { setMenu(false); openBtn.focus(); });
    bg.addEventListener('click', function () { setMenu(false); });
    $$('.nav a', side).forEach(function (a) { a.addEventListener('click', function () { setMenu(false); }); });
  }
  // Esc fecha o menu do celular (um único ouvinte para todas as telas)
  document.addEventListener('keydown', function (e) {
    var side = document.getElementById('side');
    if (e.key === 'Escape' && side && side.classList.contains('open')) document.getElementById('menu-close').click();
  });
  function main() { return $('#main'); }

  var pageTimers = [];
  function route() {
    pageTimers.forEach(clearInterval); pageTimers = [];
    var parts = (location.hash.replace(/^#\/?/, '') || 'painel').split('/');
    if (parts[0] === 'convite') return renderInvite(parts[1] || '');
    if (!me) return renderLogin();
    startLive();
    var page = parts[0];
    var fn = { painel: pageDashboard, agendamentos: pageAppointments, agenda: pageAgenda, espera: pageWaitlist, configuracoes: pageSettings, administradores: pageAdmins, integracoes: pageIntegrations }[page] || pageDashboard;
    shell(page, '<div class="empty">Carregando…</div>');
    fn(parts.slice(1));
  }
  window.addEventListener('hashchange', route);

  // ---------- Painel ----------
  function pageDashboard() {
    api('GET', '/api/admin/dashboard').then(function (d) {
      var c = d.counts;
      var setup = [];
      if (!d.setup.bookingEnabled) setup.push('Os agendamentos online estão <b>fechados</b>. Revise a agenda e abra em <a href="#/configuracoes">Configurações → Agendamento</a>.');
      if (!d.setup.whatsappConfigured) setup.push('Cadastre o <b>WhatsApp da clínica</b> para o botão de confirmação aparecer.');
      if (!d.setup.addressConfigured) setup.push('Cadastre o <b>endereço</b> para ele aparecer na confirmação e nas dúvidas frequentes.');
      var max = Math.max.apply(null, d.series.map(function (s) { return s.n; }).concat([1]));
      var stat = function (label, value, sub) { return '<div class="stat"><span>' + label + '</span><b>' + value + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</div>'; };
      var total30 = d.series.reduce(function (n, s) { return n + s.n; }, 0);
      main().innerHTML = '<div class="page-head greet-head"><div class="greet"><p class="greet-date" id="greet-date"></p><h1 id="greet"></h1><p>Confira os agendamentos e acompanhe os atendimentos da Clínica Olhar.</p>' +
        (me.name === 'Administrador' ? '<p class="hint"><a href="#/configuracoes">Informe seu nome</a> para personalizar a saudação.</p>' : '') + '</div>' + publicLink('/', 'Ver site') + '</div>' +
        (setup.length ? '<div class="alert"><div><b>Antes de divulgar</b><ul>' + setup.map(function (s) { return '<li>' + s + '</li>'; }).join('') + '</ul></div></div>' : '') +
        '<div class="stats">' +
        stat('TOTAL DE AGENDAMENTOS', c.total, c.cancelled + ' cancelados') +
        stat('AGENDAMENTOS DE HOJE', c.today, esc(fmtDate(d.today))) +
        stat('AGENDAMENTOS PARA AMANHÃ', c.tomorrow, esc(d.labels.tomorrow)) +
        (d.tomorrowIsSaturday ? '' : stat('AGENDAMENTOS PARA SÁBADO', c.saturday, esc(d.labels.saturday))) +
        stat('VAGAS DISPONÍVEIS', d.available, d.availability.enabled ? 'nas datas oferecidas no site' : 'agendamento fechado') +
        stat('PACIENTES QUE COMPARECERAM', c.attended, c.no_show + ' não compareceram') +
        '</div><div class="grid2"><section class="panel"><h2>Agendamentos criados — últimos 30 dias</h2><p class="hint">' + total30 + ' no período</p>' +
        '<div class="chart-bars" role="img" aria-label="Agendamentos por dia">' + d.series.map(function (s) {
          return '<div style="height:' + Math.round((s.n / max) * 100) + '%" title="' + fmtDate(s.day) + ': ' + s.n + '"></div>';
        }).join('') + '</div><div class="chart-axis"><span>' + fmtDate(d.series[0].day) + '</span><span>' + fmtDate(d.series[d.series.length - 1].day) + '</span></div></section>' +
        '<section class="panel"><h2>Por status</h2><ul class="list-kv">' + Object.keys(STATUS).map(function (k) {
          var row = d.byStatus.filter(function (x) { return x.status === k; })[0];
          return '<li><span class="pill s-' + k + '">' + STATUS[k] + '</span><b>' + (row ? row.n : 0) + '</b></li>';
        }).join('') + '</ul><h3>Campanhas (30 dias)</h3><ul class="list-kv">' + (d.bySource.length ? d.bySource.map(function (s) { return '<li><span>' + esc(s.campaign) + '</span><b>' + s.n + '</b></li>'; }).join('') : '<li>Nenhum agendamento ainda.</li>') + '</ul></section></div>';
      updateGreeting();
      pageTimers.push(setInterval(updateGreeting, 30000)); // troca sozinha de "bom dia" para "boa tarde"/"boa noite"
    }).catch(fail);
  }

  // Saudação pelo horário de Manaus: 05:00–11:59 bom dia · 12:00–17:59 boa tarde · 18:00–04:59 boa noite.
  function manausHour(d) { return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Manaus', hour: 'numeric', hourCycle: 'h23' }).format(d)) % 24; }
  function greetingFor(hour) { return hour >= 5 && hour < 12 ? 'Bom dia' : hour >= 12 && hour < 18 ? 'Boa tarde' : 'Boa noite'; }
  function updateGreeting() {
    var g = $('#greet'); if (!g || !me) return;
    var d = new Date();
    var first = String(me.name || '').trim().split(/\s+/)[0] || '';
    g.textContent = greetingFor(manausHour(d)) + (first && me.name !== 'Administrador' ? ', ' + first : '') + '!';
    var date = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Manaus', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
    $('#greet-date').textContent = date.charAt(0).toUpperCase() + date.slice(1);
  }

  // ---------- Agendamentos: central de acompanhamento ----------
  // Status (mutuamente exclusivos): Agendado/Contatado = aguardando confirmação da equipe · Confirmado ·
  // Compareceu · Não compareceu · Cancelado. Todos os números vêm do servidor (banco de dados).
  var AP = { period: 'hoje', from: '', to: '', evo: '7', evo_from: '', evo_to: '', q: '', status: '', time: '', origin: '', campaign: '', page: 1 };
  var apData = null, apPending = false, apBusy = false, lastList = [];
  var ICO = {
    total: '<path d="M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>',
    ok: '<path d="M20 6 9 17l-5-5"/>',
    wait: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
    came: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
    miss: '<circle cx="12" cy="12" r="8"/><path d="m9 9 6 6M15 9l-6 6"/>',
    seats: '<path d="M4 18v-6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6M4 14h16M7 10V7a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v3"/>',
  };
  function ico(name) { return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + ICO[name] + '</svg>'; }
  function apQs(extra) {
    var p = new URLSearchParams();
    ['period', 'from', 'to', 'q', 'status', 'time', 'origin', 'campaign'].forEach(function (k) { if (AP[k]) p.set(k, AP[k]); });
    if (AP.period !== 'custom') { p.delete('from'); p.delete('to'); }
    Object.keys(extra || {}).forEach(function (k) { p.set(k, extra[k]); });
    return p.toString();
  }
  function hourLabel(t) { var h = Number(t.slice(0, 2)), m = t.slice(3, 5); return h + 'h' + (m !== '00' ? m : ''); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  var PERIOD_WORD = { hoje: 'hoje', amanha: 'amanhã', sabado: 'sábado' };

  function pageAppointments() {
    var periods = [['hoje', 'Hoje'], ['amanha', 'Amanhã'], ['sabado', 'Sábado'], ['7d', 'Últimos 7 dias'], ['mes', 'Este mês'], ['custom', 'Período personalizado']];
    main().innerHTML = '<div class="page-head ap-head"><div><h1>Agendamentos</h1><p>Acompanhe os agendamentos, horários e atendimentos da Clínica Olhar.</p></div>' +
      '<p class="live" id="ap-live" aria-live="polite"><span class="live-dot" aria-hidden="true"></span><span id="ap-updated">Carregando…</span></p></div>' +
      '<div class="period-bar"><div class="chips" id="ap-periods" role="tablist" aria-label="Período">' + periods.map(function (p) { return '<button type="button" class="chip' + (AP.period === p[0] ? ' on' : '') + '" data-p="' + p[0] + '" role="tab" aria-selected="' + (AP.period === p[0]) + '">' + p[1] + '</button>'; }).join('') + '</div>' +
      '<div class="filters-row" id="ap-custom"' + (AP.period === 'custom' ? '' : ' hidden') + '><label>de <input type="date" id="ap-from" value="' + esc(AP.from) + '"></label><label>até <input type="date" id="ap-to" value="' + esc(AP.to) + '"></label></div></div>' +
      '<div class="kpis" id="ap-kpis"><div class="empty">Carregando…</div></div>' +
      '<div class="ap-grid"><section class="panel" id="ap-summary"><h2>RESUMO DO DIA</h2><div class="empty">Carregando…</div></section>' +
      '<section class="panel" id="ap-status"><h2>SITUAÇÃO DOS AGENDAMENTOS</h2><div class="empty">Carregando…</div></section></div>' +
      '<div class="ap-grid"><section class="panel" id="ap-hours"><h2>HORÁRIOS MAIS PROCURADOS</h2><p class="hint">Veja os horários com maior volume de agendamentos.</p><div class="empty">Carregando…</div></section>' +
      '<section class="panel" id="ap-evo"><div class="panel-head"><div><h2>EVOLUÇÃO DOS AGENDAMENTOS</h2><p class="hint">Agendamentos realizados por dia (data do cadastro).</p></div>' +
      '<div class="chips chips-sm" id="ap-evo-range">' + [['7', '7 dias'], ['15', '15 dias'], ['30', '30 dias'], ['custom', 'Personalizado']].map(function (r) { return '<button type="button" class="chip' + (AP.evo === r[0] ? ' on' : '') + '" data-evo="' + r[0] + '">' + r[1] + '</button>'; }).join('') + '</div></div>' +
      '<div class="filters-row" id="ap-evo-custom"' + (AP.evo === 'custom' ? '' : ' hidden') + '><label>de <input type="date" id="ap-evo-from" value="' + esc(AP.evo_from) + '"></label><label>até <input type="date" id="ap-evo-to" value="' + esc(AP.evo_to) + '"></label></div>' +
      '<div id="ap-evo-chart"><div class="empty">Carregando…</div></div></section></div>' +
      '<section class="panel" id="ap-slots" hidden></section>' +
      '<section class="panel" id="ap-listwrap"><div class="panel-head"><div><h2 id="ap-list-title">AGENDAMENTOS DE HOJE</h2><p class="hint" id="ap-count"></p></div>' +
      '<div class="btn-row"><button type="button" class="btn" id="ap-filters-btn" aria-expanded="false" aria-controls="ap-filters">FILTROS<span class="badge" id="ap-fcount" hidden></span></button><a class="btn" id="csv" href="#">Exportar CSV</a></div></div>' +
      '<input type="search" id="f-q" class="ap-search" placeholder="Buscar por nome, WhatsApp ou protocolo" value="' + esc(AP.q) + '" aria-label="Buscar agendamento">' +
      '<div class="ap-filters" id="ap-filters"><div class="form-grid">' +
      '<label class="f"><span>Status</span><select id="f-status"><option value="">Todos</option><option value="AGUARDANDO">Aguardando confirmação</option><option value="CONFIRMADO">Confirmado</option><option value="COMPARECEU">Compareceu</option><option value="NAO_COMPARECEU">Não compareceu</option><option value="CANCELADO">Cancelado</option></select></label>' +
      '<label class="f"><span>Horário</span><select id="f-time"><option value="">Todos</option></select></label>' +
      '<label class="f"><span>Origem</span><select id="f-origin"><option value="">Todas</option><option value="meta">Anúncios (Facebook/Instagram)</option><option value="manual">Cadastro manual</option><option value="outros">Outras origens</option></select></label>' +
      '<label class="f"><span>Campanha</span><select id="f-campaign"><option value="">Todas</option></select></label></div>' +
      '<button type="button" class="linkbtn" id="ap-clear">Limpar filtros</button></div>' +
      '<div id="ap-list"><div class="empty">Carregando…</div></div></section>';
    $('#f-status').value = AP.status; $('#f-origin').value = AP.origin;

    $('#ap-periods').addEventListener('click', function (e) {
      var b = e.target.closest('[data-p]'); if (!b) return;
      AP.period = b.getAttribute('data-p'); AP.page = 1; AP.time = '';
      $$('#ap-periods .chip').forEach(function (c) { c.classList.toggle('on', c === b); c.setAttribute('aria-selected', String(c === b)); });
      $('#ap-custom').hidden = AP.period !== 'custom';
      if (AP.period === 'custom' && !AP.from) return; // espera escolher as datas
      refreshAll();
    });
    ['ap-from', 'ap-to'].forEach(function (id) { $('#' + id).addEventListener('change', function () { AP.from = $('#ap-from').value; AP.to = $('#ap-to').value || AP.from; AP.page = 1; refreshAll(); }); });
    $('#ap-evo-range').addEventListener('click', function (e) {
      var b = e.target.closest('[data-evo]'); if (!b) return;
      AP.evo = b.getAttribute('data-evo');
      $$('#ap-evo-range .chip').forEach(function (c) { c.classList.toggle('on', c === b); });
      $('#ap-evo-custom').hidden = AP.evo !== 'custom';
      if (AP.evo !== 'custom' || (AP.evo_from && AP.evo_to)) loadOverview();
    });
    ['ap-evo-from', 'ap-evo-to'].forEach(function (id) { $('#' + id).addEventListener('change', function () { AP.evo_from = $('#ap-evo-from').value; AP.evo_to = $('#ap-evo-to').value; if (AP.evo_from && AP.evo_to) loadOverview(); }); });
    var t;
    $('#f-q').addEventListener('input', function (e) { clearTimeout(t); t = setTimeout(function () { AP.q = e.target.value.trim(); AP.page = 1; loadList(); }, 300); });
    [['f-status', 'status'], ['f-time', 'time'], ['f-origin', 'origin'], ['f-campaign', 'campaign']].forEach(function (x) {
      $('#' + x[0]).addEventListener('change', function (e) { AP[x[1]] = e.target.value; AP.page = 1; loadList(); });
    });
    $('#ap-clear').addEventListener('click', function () {
      AP.q = AP.status = AP.time = AP.origin = AP.campaign = ''; AP.page = 1;
      $('#f-q').value = ''; ['f-status', 'f-time', 'f-origin', 'f-campaign'].forEach(function (id) { $('#' + id).value = ''; });
      loadList();
    });
    $('#ap-filters-btn').addEventListener('click', function () {
      var box = $('#ap-filters'), open = !box.classList.contains('open');
      box.classList.toggle('open', open); this.setAttribute('aria-expanded', String(open));
    });
    $('#csv').addEventListener('click', function (e) { e.preventDefault(); location.href = '/api/admin/appointments.csv?' + apQs(); });
    refreshAll();
  }

  // Recarrega tudo (indicadores, gráficos, horários e lista) sem atrapalhar uma edição em andamento.
  function refreshAll() {
    if (!$('#ap-kpis')) return;
    if ($('.drawer') || $('#modal')) { apPending = true; return; }
    apPending = false;
    loadOverview(); loadList();
  }
  function loadAppointments() { refreshAll(); }

  function loadOverview() {
    var extra = { evo: AP.evo };
    if (AP.evo === 'custom') { extra.evo_from = AP.evo_from; extra.evo_to = AP.evo_to; }
    api('GET', '/api/admin/appointments/overview?' + apQs(extra)).then(function (d) {
      if (!$('#ap-kpis')) return;
      apData = d;
      renderKpis(d); renderSummary(d); renderStatus(d); renderHours(d); renderEvolution(d); fillFilterOptions(d);
      var word = PERIOD_WORD[d.period];
      $('#ap-list-title').textContent = word ? 'AGENDAMENTOS DE ' + word.toUpperCase() : 'AGENDAMENTOS DO PERÍODO';
      $('#ap-updated').textContent = (live.connected ? 'Ao vivo · ' : '') + 'Dados atualizados às ' + d.updatedAt;
      $('#ap-live').classList.toggle('on', !!live.connected);
      if (d.single) loadSlots(d.range.from); else $('#ap-slots').hidden = true;
    }).catch(fail);
  }

  function renderKpis(d) {
    var c = d.counts;
    var card = function (icon, label, value, sub, cls) { return '<div class="kpi' + (cls ? ' ' + cls : '') + '"><span class="kpi-ico">' + ico(icon) + '</span><span class="kpi-label">' + label + '</span><b class="kpi-value">' + value + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</div>'; };
    $('#ap-kpis').innerHTML =
      card('total', 'TOTAL DE AGENDAMENTOS', c.total, c.cancelados ? plural(c.cancelados, 'cancelado não incluído', 'cancelados não incluídos') : 'no período') +
      card('ok', 'AGENDAMENTOS CONFIRMADOS', c.confirmados, 'confirmados pela equipe', 'k-blue') +
      card('wait', 'AGUARDANDO CONFIRMAÇÃO', c.aguardando, 'agendaram, sem confirmação', 'k-amber') +
      card('came', 'PACIENTES QUE COMPARECERAM', c.compareceram, 'atendimento realizado', 'k-green') +
      card('miss', 'NÃO COMPARECERAM', c.nao_compareceram, 'faltaram ao horário', 'k-red') +
      card('seats', 'VAGAS RESTANTES', d.remainingDays ? d.remaining : '—', d.remainingDays ? 'horários livres a partir de agora' : 'período já encerrado', 'k-navy');
  }

  function renderSummary(d) {
    var c = d.counts, s = [];
    var when = PERIOD_WORD[d.period] ? 'para ' + PERIOD_WORD[d.period] : 'no período (' + d.label + ')';
    if (!c.total && !c.cancelados) s.push('Ainda não há agendamentos ' + when + '.');
    else s.push('Você possui ' + plural(c.total, 'agendamento', 'agendamentos') + ' ' + when + '.');
    if (c.aguardando) s.push(plural(c.aguardando, 'paciente ainda aguarda', 'pacientes ainda aguardam') + ' confirmação.');
    else if (c.total) s.push('Todos os pacientes do período já foram confirmados ou atendidos.');
    if (d.top) s.push('O horário mais procurado é ' + hourLabel(d.top.time) + ' (' + plural(d.top.n, 'agendamento', 'agendamentos') + ').');
    if (d.remainingDays) s.push(d.remaining ? 'Restam ' + plural(d.remaining, 'vaga disponível', 'vagas disponíveis') + ' ' + when + '.' : 'Não há mais vagas livres ' + when + '.');
    if (c.compareceram) s.push(plural(c.compareceram, 'paciente já compareceu', 'pacientes já compareceram') + '.');
    if (c.nao_compareceram) s.push(plural(c.nao_compareceram, 'paciente não compareceu', 'pacientes não compareceram') + '.');
    $('#ap-summary').innerHTML = '<h2>RESUMO DO DIA</h2><ul class="summary">' + s.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
  }

  // Percentuais pelo método do maior resto: somam exatamente 100%.
  function percents(values) {
    var total = values.reduce(function (a, b) { return a + b; }, 0);
    if (!total) return values.map(function () { return 0; });
    var raw = values.map(function (v) { return v * 100 / total; });
    var out = raw.map(Math.floor);
    var left = 100 - out.reduce(function (a, b) { return a + b; }, 0);
    raw.map(function (r, i) { return [r - Math.floor(r), i]; }).sort(function (a, b) { return b[0] - a[0]; }).slice(0, left).forEach(function (x) { out[x[1]]++; });
    return out;
  }
  function renderStatus(d) {
    var c = d.counts;
    var rows = [['Aguardando confirmação', c.aguardando, 'st-wait'], ['Confirmados', c.confirmados, 'st-ok'], ['Compareceram', c.compareceram, 'st-came'], ['Não compareceram', c.nao_compareceram, 'st-miss'], ['Cancelados', c.cancelados, 'st-cancel']];
    var all = rows.reduce(function (a, r) { return a + r[1]; }, 0);
    var pct = percents(rows.map(function (r) { return r[1]; }));
    $('#ap-status').innerHTML = '<h2>SITUAÇÃO DOS AGENDAMENTOS</h2>' + (all ? '<ul class="dist">' + rows.map(function (r, i) {
      return '<li class="' + r[2] + '" title="' + esc(r[0]) + ': ' + r[1] + ' (' + pct[i] + '%)"><span class="dist-label"><i aria-hidden="true"></i>' + r[0] + '</span>' +
        '<span class="dist-bar" aria-hidden="true"><span style="width:' + pct[i] + '%"></span></span><span class="dist-val"><b>' + pct[i] + '%</b> ' + r[1] + '</span></li>';
    }).join('') + '</ul><p class="hint">' + plural(all, 'agendamento', 'agendamentos') + ' no período, cada um contado uma vez pelo status atual.</p>' : '<p class="empty-sm">Sem agendamentos neste período.</p>');
  }

  function renderHours(d) {
    var hrs = d.hours, max = Math.max.apply(null, hrs.map(function (h) { return h.n; }).concat([0]));
    var box = $('#ap-hours');
    var head = '<h2>HORÁRIOS MAIS PROCURADOS</h2><p class="hint">Veja os horários com maior volume de agendamentos.</p>';
    if (!hrs.length) { box.innerHTML = head + '<p class="empty-sm">Nenhum horário de atendimento neste período.</p>'; return; }
    box.innerHTML = head + (max ? '' : '<p class="empty-sm">Ainda sem agendamentos no período — os horários aparecem abaixo.</p>') +
      '<ul class="hbars" role="list">' + hrs.map(function (h) {
        var top = d.top && h.time === d.top.time;
        var w = max ? Math.max(h.n ? 3 : 0, Math.round(h.n * 100 / max)) : 0;
        return '<li class="' + (top ? 'is-top' : '') + '" tabindex="0" title="' + h.time + ': ' + plural(h.n, 'agendamento', 'agendamentos') + '" aria-label="' + h.time + ', ' + plural(h.n, 'agendamento', 'agendamentos') + (top ? ', horário mais procurado' : '') + '">' +
          '<span class="hb-time">' + h.time + '</span><span class="hb-track"><span class="hb-fill" style="width:' + w + '%"></span></span><span class="hb-val">' + h.n + (top ? '<em>mais procurado</em>' : '') + '</span></li>';
      }).join('') + '</ul>';
  }

  function renderEvolution(d) {
    var days = d.evolution.days, max = Math.max.apply(null, days.map(function (x) { return x.n; }).concat([1]));
    var total = days.reduce(function (a, x) { return a + x.n; }, 0);
    var best = days.reduce(function (b, x) { return x.n > (b ? b.n : 0) ? x : b; }, null);
    var step = Math.ceil(days.length / 8);
    if (!total) { $('#ap-evo-chart').innerHTML = '<p class="empty-sm">Nenhum agendamento realizado entre ' + fmtDate(d.evolution.from).slice(0, 5) + ' e ' + fmtDate(d.evolution.to).slice(0, 5) + '.</p>'; return; }
    $('#ap-evo-chart').innerHTML = '<p class="evo-meta"><b>' + total + '</b> no período' + (best ? ' · maior movimento em <b>' + fmtDate(best.day).slice(0, 5) + '</b> (' + best.n + ')' : '') + '</p>' +
      '<div class="vbars" role="img" aria-label="Agendamentos por dia: ' + days.map(function (x) { return fmtDate(x.day).slice(0, 5) + ' ' + x.n; }).join(', ') + '">' + days.map(function (x) {
        var h = x.n ? Math.max(4, Math.round(x.n * 100 / max)) : 0;
        return '<div class="vb' + (best && x.day === best.day ? ' is-top' : '') + '" tabindex="0" data-tip="' + fmtDate(x.day).slice(0, 5) + ': ' + plural(x.n, 'agendamento', 'agendamentos') + '"><span style="height:' + h + '%"></span></div>';
      }).join('') + '</div><div class="vaxis">' + days.map(function (x, i) { return '<span>' + (i % step === 0 || i === days.length - 1 ? fmtDate(x.day).slice(0, 5) : '') + '</span>'; }).join('') + '</div>';
  }

  function fillFilterOptions(d) {
    var ts = $('#f-time'), cs = $('#f-campaign');
    ts.innerHTML = '<option value="">Todos</option>' + d.hours.map(function (h) { return '<option value="' + h.time + '">' + h.time + '</option>'; }).join('');
    ts.value = AP.time;
    cs.innerHTML = '<option value="">Todas</option>' + d.campaigns.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('');
    cs.value = AP.campaign;
  }

  // Visualização por horário (períodos de um único dia): ocupação real de cada sessão.
  function loadSlots(date) {
    api('GET', '/api/admin/agenda?date=' + date).then(function (ag) {
      var box = $('#ap-slots'); if (!box) return;
      box.hidden = false;
      var slots = ag.slots.filter(function (s) { return s.patients.length || !s.blocked; });
      box.innerHTML = '<div class="panel-head"><div><h2>VISUALIZAÇÃO POR HORÁRIO</h2><p class="hint">' + esc(ag.label) + (ag.open ? ' · ' + ag.booked + ' pacientes · ' + ag.remaining + ' vagas livres' : ' · sem atendimento' + (ag.reason ? ': ' + esc(ag.reason) : '')) + '</p></div>' +
        '<ul class="legend-sm"><li><i class="lg-free"></i>com vagas</li><li><i class="lg-almost"></i>última vaga</li><li><i class="lg-full"></i>lotado</li></ul></div>' +
        (slots.length ? '<div class="slots-grid">' + slots.map(function (s) {
          var cls = s.blocked ? 'is-blocked' : s.booked >= s.capacity ? 'is-full' : s.capacity - s.booked === 1 ? 'is-almost' : 'is-free';
          return '<div class="sblock ' + cls + '"><div class="sb-head"><b>' + s.time + '</b><span>' + (s.blocked ? 'bloqueado' : s.booked + ' de ' + s.capacity + ' vagas ocupadas') + '</span></div>' +
            (s.patients.length ? '<ul>' + s.patients.map(function (p) {
              return '<li><span class="sb-name">' + esc(p.name) + '</span><span class="pill s-' + p.status + '">' + STATUS[p.status] + '</span>' +
                '<span class="sb-actions">' + quickButtons(p, true) + '<a class="btn small" href="' + wa(p.whatsapp) + '" target="_blank" rel="noopener" aria-label="WhatsApp de ' + esc(p.name) + '">WhatsApp</a><button class="btn small" data-open-protocol="' + esc(p.protocol) + '">Detalhes</button></span></li>';
            }).join('') + '</ul>' : '<p class="empty-sm">Nenhum paciente neste horário.</p>') + '</div>';
        }).join('') + '</div>' : '<p class="empty-sm">Nenhum horário de atendimento nesta data.</p>');
    }).catch(fail);
  }

  function loadList() {
    api('GET', '/api/admin/appointments?' + apQs({ sort: 'chrono', page: AP.page })).then(function (d) {
      if (!$('#ap-list')) return;
      lastList = d.items;
      var nf = ['status', 'time', 'origin', 'campaign'].filter(function (k) { return AP[k]; }).length;
      $('#ap-fcount').hidden = !nf; $('#ap-fcount').textContent = nf;
      $('#ap-count').textContent = plural(d.total, 'agendamento encontrado', 'agendamentos encontrados') + ' · ordem de atendimento';
      if (!d.items.length) { $('#ap-list').innerHTML = '<p class="empty-sm">Nenhum agendamento com esses filtros.</p>'; return; }
      var multiDay = apData && !apData.single;
      $('#ap-list').innerHTML = '<div class="table-wrap"><table class="t t-ap"><thead><tr><th>Horário</th><th>Paciente</th><th>WhatsApp</th><th>Protocolo</th><th>Status</th><th>Ações</th></tr></thead><tbody>' +
        d.items.map(function (r) {
          return '<tr data-id="' + r.id + '"><td class="mono ap-time" data-l="Horário"><b>' + esc(r.time) + '</b>' + (multiDay ? '<span class="sub">' + fmtDate(r.date) + '</span>' : '') + '</td>' +
            '<td data-l="Paciente" class="ap-name"><div><b>' + esc(r.name) + '</b><span class="sub">' + (r.age != null ? r.age + ' anos · ' : '') + 'cadastro ' + esc(r.created.split(' ')[0].split('-').reverse().join('/').slice(0, 5)) + ' às ' + esc(r.created.split(' ')[1]) + '</span>' + (r.guardian ? '<span class="sub">Resp.: ' + esc(r.guardian) + '</span>' : '') + '</div></td>' +
            '<td data-l="WhatsApp">' + (r.anonymized ? '—' : esc(r.whatsappLabel)) + '</td>' +
            '<td class="mono" data-l="Protocolo">' + esc(r.protocol) + '</td>' +
            '<td data-l="Status"><span class="pill s-' + r.status + '">' + STATUS[r.status] + '</span></td>' +
            '<td class="ap-actions"><div class="quick">' + quickButtons(r) + '</div><div class="btn-row">' +
            (r.anonymized ? '' : '<a class="btn small green" href="' + wa(r.whatsapp, 'Olá, ' + r.name.split(' ')[0] + '! Aqui é da Clínica Olhar, sobre o seu exame de vista gratuito (protocolo ' + r.protocol + ') em ' + fmtDate(r.date) + ' às ' + r.time + '.') + '" target="_blank" rel="noopener">WhatsApp</a>') +
            '<button class="btn small" data-open="' + r.id + '">Ver detalhes</button></div></td></tr>';
        }).join('') + '</tbody></table></div>' +
        (d.pages > 1 ? '<div class="pager">' + (d.page > 1 ? '<button class="btn small" data-page="' + (d.page - 1) + '">Anterior</button>' : '') + '<span>Página ' + d.page + ' de ' + d.pages + '</span>' + (d.page < d.pages ? '<button class="btn small" data-page="' + (d.page + 1) + '">Próxima</button>' : '') + '</div>' : '');
    }).catch(fail);
  }

  // Ações rápidas conforme o status atual.
  function quickButtons(r, compact) {
    var opts = { NOVO: ['CONFIRMADO', 'COMPARECEU', 'NAO_COMPARECEU', 'CANCELADO'], CONTATADO: ['CONFIRMADO', 'COMPARECEU', 'NAO_COMPARECEU', 'CANCELADO'], CONFIRMADO: ['COMPARECEU', 'NAO_COMPARECEU', 'CANCELADO'], COMPARECEU: ['NAO_COMPARECEU'], NAO_COMPARECEU: ['COMPARECEU'], CANCELADO: ['NOVO'] }[r.status] || [];
    var label = compact
      ? { CONFIRMADO: 'Confirmar', COMPARECEU: 'Compareceu', NAO_COMPARECEU: 'Faltou', CANCELADO: 'Cancelar', NOVO: 'Reativar' }
      : { CONFIRMADO: 'CONFIRMAR', COMPARECEU: 'MARCAR COMPARECIMENTO', NAO_COMPARECEU: 'NÃO COMPARECEU', CANCELADO: 'CANCELAR', NOVO: 'REATIVAR' };
    return opts.map(function (s) { return '<button class="btn small' + (s === 'CANCELADO' ? ' danger' : s === 'CONFIRMADO' ? ' primary' : '') + '" data-status="' + s + '" data-id="' + r.id + '" data-name="' + esc(r.name) + '">' + label[s] + '</button>'; }).join('');
  }
  var CONFIRM_MSG = {
    CANCELADO: 'Cancelar o agendamento de {n}? A vaga será liberada no site.',
    COMPARECEU: 'Registrar que {n} compareceu ao atendimento?',
    NAO_COMPARECEU: 'Registrar que {n} NÃO compareceu ao atendimento?',
    NOVO: 'Reativar o agendamento de {n}? A vaga volta a ser ocupada.',
  };
  function setStatus(id, status, after, name) {
    if (CONFIRM_MSG[status] && !confirm(CONFIRM_MSG[status].replace('{n}', name || 'este paciente'))) return;
    api('PATCH', '/api/admin/appointments/' + id, { status: status }).then(function () { toast('Status atualizado: ' + STATUS[status]); after(); }).catch(fail);
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-status]');
    if (b && (($('#ap-list') && $('#ap-list').contains(b)) || ($('#ap-slots') && $('#ap-slots').contains(b)))) setStatus(b.getAttribute('data-id'), b.getAttribute('data-status'), refreshAll, b.getAttribute('data-name'));
    var o = e.target.closest('[data-open]');
    if (o) openDrawer(lastList.filter(function (r) { return String(r.id) === o.getAttribute('data-open'); })[0]);
    var op = e.target.closest('[data-open-protocol]');
    if (op) api('GET', '/api/admin/appointments?q=' + encodeURIComponent(op.getAttribute('data-open-protocol'))).then(function (d) { if (d.items[0]) openDrawer(d.items[0]); }).catch(fail);
    var pg = e.target.closest('[data-page]');
    if (pg) { AP.page = Number(pg.getAttribute('data-page')); loadList(); }
  });

  // ---------- Atualização ao vivo (Server-Sent Events, com atualização periódica de reserva) ----------
  var live = { es: null, connected: false, poll: null };
  function startLive() {
    if (live.es || !window.EventSource) return;
    live.es = new EventSource('/api/admin/stream');
    live.es.onopen = function () { live.connected = true; setLiveLabel(); };
    live.es.addEventListener('appointments', function () { refreshAll(); });
    live.es.addEventListener('logout', function () { stopLive(); });
    live.es.onerror = function () { live.connected = false; setLiveLabel(); };
    // Reserva: a cada 60 s, mesmo se o canal ao vivo cair.
    live.poll = setInterval(function () { if (!live.connected && !document.hidden) refreshAll(); }, 60000);
  }
  function stopLive() { if (live.es) live.es.close(); live.es = null; live.connected = false; clearInterval(live.poll); }
  function setLiveLabel() {
    var el = $('#ap-live'); if (!el || !apData) return;
    el.classList.toggle('on', live.connected);
    $('#ap-updated').textContent = (live.connected ? 'Ao vivo · ' : '') + 'Dados atualizados às ' + apData.updatedAt;
  }

  function closeDrawer() {
    $$('.drawer, .drawer-bg').forEach(function (x) { x.remove(); });
    if (apPending) setTimeout(refreshAll, 0); // aplica a atualização que chegou enquanto a gaveta estava aberta
  }
  function openDrawer(r) {
    if (!r) return;
    closeDrawer();
    var bg = document.createElement('div'); bg.className = 'drawer-bg'; bg.addEventListener('click', closeDrawer);
    var d = document.createElement('aside'); d.className = 'drawer'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Detalhes do agendamento');
    var msg = 'Olá, ' + r.name.split(' ')[0] + '! Aqui é da Clínica Olhar. Sobre o seu exame de vista gratuito (protocolo ' + r.protocol + ') em ' + fmtDate(r.date) + ' às ' + r.time + ': ';
    var a = r.attribution;
    d.innerHTML = '<button class="btn small close" data-x>Fechar</button><h2>' + esc(r.protocol) + '</h2><p class="hint"><span class="pill s-' + r.status + '">' + STATUS[r.status] + '</span> · ' + esc(r.dateLabel) + ' às ' + esc(r.time) + '</p>' +
      (r.anonymized ? '<div class="alert">Dados pessoais excluídos a pedido do titular ou pelo prazo de retenção.</div>' :
      '<div class="btn-row" style="margin:14px 0"><a class="btn green" href="' + wa(r.whatsapp, msg) + '" target="_blank" rel="noopener">Abrir conversa no WhatsApp</a></div>' +
      '<section class="panel"><h2>Paciente</h2><form id="pf"><label class="f"><span>Nome</span><input type="text" name="name" value="' + esc(r.name) + '"></label>' +
      '<div class="form-grid"><label class="f"><span>Idade</span><input type="number" name="age" min="0" max="120" value="' + r.age + '"></label><label class="f"><span>WhatsApp</span><input type="text" name="whatsapp" value="' + esc(r.whatsappLabel) + '"></label></div>' +
      '<label class="f"><span>Responsável (menores)</span><input type="text" name="guardian_name" value="' + esc(r.guardian || '') + '"></label>' +
      '<button class="btn primary">Salvar correção</button></form></section>' +
      '<section class="panel"><h2>Remarcar</h2><p class="hint">Você pode escolher qualquer data com horários cadastrados.</p><div class="form-grid" style="margin-top:10px"><label class="f"><span>Data</span><input type="date" id="rs-date" value="' + r.date + '"></label><label class="f"><span>Horário</span><select id="rs-time"><option>Escolha a data</option></select></label></div><button class="btn primary" id="rs-go">Remarcar</button></section>' +
      '<section class="panel"><h2>Observações internas</h2><textarea id="notes" maxlength="1000">' + esc(r.notes || '') + '</textarea><div class="btn-row" style="margin-top:8px"><button class="btn" id="save-notes">Salvar observação</button></div></section>') +
      '<section class="panel"><h2>Origem</h2><ul class="list-kv"><li><span>Origem</span><b>' + esc(r.origin) + '</b></li>' +
      ['source', 'medium', 'campaign', 'content', 'term'].map(function (k) { return a[k] ? '<li><span>utm_' + k + '</span><b>' + esc(a[k]) + '</b></li>' : ''; }).join('') +
      (a.fbclid ? '<li><span>fbclid</span><b>presente</b></li>' : '') + (a.referrer ? '<li><span>Referência</span><b>' + esc(a.referrer) + '</b></li>' : '') + '</ul></section>' +
      (r.anonymized ? '' : '<section class="panel"><h2>Excluir dados pessoais (LGPD)</h2><p class="hint">Use quando o paciente pedir a exclusão. O nome e o WhatsApp são apagados; agendamentos futuros são cancelados. Não pode ser desfeito.</p><button class="btn danger" id="anon" style="margin-top:10px">Excluir dados deste paciente</button></section>');
    document.body.appendChild(bg); document.body.appendChild(d);
    $('[data-x]', d).addEventListener('click', closeDrawer);
    if (r.anonymized) return;
    var refresh = function () { closeDrawer(); loadAppointments(); };
    $('#pf', d).addEventListener('submit', function (e) {
      e.preventDefault(); var f = e.target;
      api('PATCH', '/api/admin/patients/' + r.patientId, { name: f.name.value, age: f.age.value, whatsapp: f.whatsapp.value, guardian_name: f.guardian_name.value || null })
        .then(function () { toast('Dados corrigidos.'); refresh(); }).catch(fail);
    });
    function loadTimes() {
      var date = $('#rs-date', d).value;
      api('GET', '/api/admin/agenda?date=' + date).then(function (ag) {
        var sel = $('#rs-time', d);
        if (!ag.slots.length) { sel.innerHTML = '<option value="">Sem horários nesta data</option>'; return; }
        sel.innerHTML = ag.slots.map(function (s) {
          var mine = s.patients.some(function (p) { return p.id === r.id; });
          var dis = (s.blocked || s.free <= 0) && !mine;
          return '<option value="' + s.time + '"' + (dis ? ' disabled' : '') + (mine ? ' selected' : '') + '>' + s.time + ' — ' + s.booked + '/' + s.capacity + (s.blocked ? ' (bloqueado)' : '') + '</option>';
        }).join('');
      }).catch(fail);
    }
    $('#rs-date', d).addEventListener('change', loadTimes); loadTimes();
    $('#rs-go', d).addEventListener('click', function () {
      api('POST', '/api/admin/appointments/' + r.id + '/reschedule', { date: $('#rs-date', d).value, time: $('#rs-time', d).value })
        .then(function () { toast('Agendamento remarcado.'); refresh(); }).catch(fail);
    });
    $('#save-notes', d).addEventListener('click', function () {
      api('PATCH', '/api/admin/appointments/' + r.id, { notes: $('#notes', d).value }).then(function () { toast('Observação salva.'); }).catch(fail);
    });
    $('#anon', d).addEventListener('click', function () {
      if (!confirm('Excluir definitivamente os dados pessoais de ' + r.name + '?')) return;
      api('POST', '/api/admin/patients/' + r.patientId + '/anonymize').then(function () { toast('Dados excluídos.'); refresh(); }).catch(fail);
    });
  }

  // ---------- Agenda ----------
  var agendaDate = null;
  function todayLocal() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Manaus' }).format(new Date()); }
  function addDays(iso, n) { var d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function pageAgenda() {
    agendaDate = agendaDate || addDays(todayLocal(), 1);
    main().innerHTML = '<div class="page-head"><div><h1>Agenda</h1><p>Ocupação real de cada horário, bloqueios e regras de atendimento.</p></div></div>' +
      '<section class="panel"><div class="day-head"><div class="btn-row"><button class="btn small" data-d="-1">← Dia anterior</button><input type="date" id="ag-date" value="' + agendaDate + '" style="width:auto"><button class="btn small" data-d="1">Próximo dia →</button><button class="btn small" data-d="today">Hoje</button></div></div><div id="ag-day" style="margin-top:14px"></div></section>' +
      '<form class="panel" id="site-opts"><h2>CONFIGURAÇÕES DA AGENDA — datas oferecidas no site</h2><p class="hint">O site calcula sozinho, todos os dias, as datas permitidas. Bloqueios de datas e horários sempre prevalecem.</p><div id="site-opts-body" class="empty">Carregando…</div></form>' +
      '<section class="panel" id="rules-panel"><h2>CONFIGURAÇÕES DA AGENDA — horário de funcionamento por dia da semana</h2><p class="hint">Ao salvar, os próximos 60 dias são atualizados. Horários que você editou manualmente não mudam, e horários com pacientes nunca são apagados.</p><div id="rules"></div></section>' +
      '<section class="panel"><h2>Exceções por data</h2><p class="hint">Feriados, dias sem atendimento ou horário especial em uma data específica.</p><div id="overrides"></div></section>';
    $('#ag-date').addEventListener('change', function (e) { agendaDate = e.target.value; loadDay(); });
    $$('[data-d]').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = b.getAttribute('data-d');
        agendaDate = v === 'today' ? todayLocal() : addDays(agendaDate, Number(v));
        $('#ag-date').value = agendaDate; loadDay();
      });
    });
    loadDay(); loadRules(); loadSiteOptions();
  }
  function loadSiteOptions() {
    api('GET', '/api/admin/settings').then(function (d) {
      var b = d.settings.booking;
      var row = function (name, on, title, sub) { return '<label class="cbx"><input type="checkbox" name="' + name + '"' + (on ? ' checked' : '') + '><span><b>' + title + '</b> — ' + sub + '</span></label>'; };
      $('#site-opts-body').className = '';
      $('#site-opts-body').innerHTML =
        row('enabled', b.enabled, 'Agendamentos online abertos', 'desligado, o site não aceita novos agendamentos.') +
        row('today_enabled', b.today_enabled !== false, 'AGENDAMENTOS PARA HOJE', 'somente horários futuros, respeitando a antecedência mínima.') +
        row('tomorrow_enabled', b.tomorrow_enabled !== false, 'AGENDAMENTOS PARA AMANHÃ', 'sempre que houver capacidade.') +
        row('saturday_enabled', b.saturday_enabled !== false, 'AGENDAMENTOS PARA SÁBADO', 'o próximo sábado (no sábado, o da semana seguinte).') +
        '<div class="form-grid">' +
        '<label class="f"><span>ANTECEDÊNCIA MÍNIMA para hoje (minutos)</span><input type="number" name="min_lead_minutes" min="0" max="1440" step="5" value="' + (b.min_lead_minutes == null ? 60 : b.min_lead_minutes) + '"></label>' +
        '<label class="f"><span>LIMITE DE VAGAS DO MESMO DIA (por horário)</span><input type="number" name="same_day_cap" min="1" max="500" placeholder="sem limite extra" value="' + (b.same_day_cap == null ? '' : b.same_day_cap) + '"></label>' +
        '</div><p class="hint">O limite do mesmo dia é um teto adicional para HOJE: nunca passa da capacidade real do horário. Ex.: horário com 5 vagas e limite 3 → no máximo 3 pacientes agendados para hoje nesse horário.</p>' +
        '<button class="btn primary" style="margin-top:10px">Salvar opções</button>';
    }).catch(fail);
  }
  document.addEventListener('submit', function (e) {
    if (!e.target || e.target.id !== 'site-opts') return;
    e.preventDefault();
    var f = e.target, body = {};
    ['enabled', 'today_enabled', 'tomorrow_enabled', 'saturday_enabled'].forEach(function (n) { body[n] = $('[name=' + n + ']', f).checked; });
    body.min_lead_minutes = $('[name=min_lead_minutes]', f).value;
    body.same_day_cap = $('[name=same_day_cap]', f).value;
    api('PUT', '/api/admin/settings/booking', body).then(function () { toast('Opções da agenda salvas. O site já foi atualizado.'); }).catch(fail);
  });
  function loadDay() {
    var box = $('#ag-day');
    api('GET', '/api/admin/agenda?date=' + agendaDate).then(function (d) {
      var ov = d.override;
      var head = '<p class="day-title">' + esc(d.label.toUpperCase()) + ' — ' + fmtDate(d.date).slice(0, 5) + '</p>' +
        '<p class="hint">' + (d.open ? d.booked + ' pacientes agendados · ' + d.remaining + ' vagas livres' + (d.dailyLimit !== null ? ' · limite diário ' + d.dailyLimit : '') : '<b>Sem atendimento:</b> ' + esc(d.reason || '')) + '</p>' +
        '<div class="btn-row" style="margin:10px 0 6px">' +
        (ov && ov.is_blocked ? '<button class="btn small" id="unblock-day">Reabrir esta data</button>' : '<button class="btn small danger" id="block-day">Bloquear esta data</button>') +
        '<button class="btn small" id="special-day">Horário especial nesta data</button>' +
        (ov && !ov.is_blocked ? '<button class="btn small" id="unblock-day">Voltar ao horário padrão</button>' : '') +
        '<button class="btn small" id="add-slot">Adicionar horário extra</button></div>';
      var slots = d.slots.length ? d.slots.map(function (s) {
        var pct = s.capacity ? Math.min(100, Math.round((s.booked / s.capacity) * 100)) : 100;
        return '<div class="slot' + (s.blocked ? ' blocked' : '') + '"><span class="slot-time">' + s.time + '</span>' +
          '<div><b>' + s.booked + '/' + s.capacity + ' vagas ocupadas</b>' + (s.blocked ? ' · <span class="pill s-CANCELADO" style="text-decoration:none">bloqueado</span>' : '') + (s.manual ? ' <span class="hint">(ajustado manualmente)</span>' : '') +
          '<div class="bar' + (s.booked >= s.capacity ? ' full' : '') + '"><i style="width:' + pct + '%"></i></div></div>' +
          '<div class="btn-row"><button class="btn small" data-cap="' + s.id + '" data-cur="' + s.capacity + '">Vagas</button><button class="btn small" data-block="' + s.id + '" data-v="' + (!s.blocked) + '">' + (s.blocked ? 'Desbloquear' : 'Bloquear') + '</button>' + (s.manual ? '<button class="btn small" data-reset="' + s.id + '">Padrão</button>' : '') + '</div>' +
          (s.patients.length ? '<ul class="slot-people">' + s.patients.map(function (p) { return '<li>' + esc(p.protocol) + ' · <b>' + esc(p.name) + '</b>, ' + p.age + ' anos · ' + esc(p.whatsappLabel) + ' · <span class="pill s-' + p.status + '">' + STATUS[p.status] + '</span></li>'; }).join('') + '</ul>' : '') + '</div>';
      }).join('') : '<p class="empty">Nenhum horário nesta data.</p>';
      box.innerHTML = head + slots;
      var on = function (id, fn) { var el = $('#' + id, box); if (el) el.addEventListener('click', fn); };
      on('block-day', function () {
        var reason = prompt('Motivo do bloqueio (ex.: Feriado). Pacientes já agendados continuam na lista.', 'Sem atendimento');
        if (reason === null) return;
        api('PUT', '/api/admin/date-overrides/' + agendaDate, { is_blocked: true, reason: reason }).then(function () { toast('Data bloqueada.'); loadDay(); loadRules(); }).catch(fail);
      });
      on('unblock-day', function () { api('DELETE', '/api/admin/date-overrides/' + agendaDate).then(function () { toast('Data reaberta com o horário padrão.'); loadDay(); loadRules(); }).catch(fail); });
      on('special-day', function () { specialDayForm(ov); });
      on('add-slot', function () {
        var t = prompt('Horário extra (HH:MM):', '17:00'); if (!t) return;
        var c = prompt('Quantidade de vagas:', '5'); if (c === null) return;
        api('POST', '/api/admin/slots', { date: agendaDate, time: t, capacity: c }).then(function () { toast('Horário adicionado.'); loadDay(); }).catch(fail);
      });
      $$('[data-cap]', box).forEach(function (b) {
        b.addEventListener('click', function () {
          var v = prompt('Vagas para este horário:', b.getAttribute('data-cur')); if (v === null) return;
          api('PATCH', '/api/admin/slots/' + b.getAttribute('data-cap'), { capacity: v }).then(function () { toast('Vagas atualizadas.'); loadDay(); }).catch(fail);
        });
      });
      $$('[data-block]', box).forEach(function (b) {
        b.addEventListener('click', function () {
          api('PATCH', '/api/admin/slots/' + b.getAttribute('data-block'), { blocked: b.getAttribute('data-v') === 'true' }).then(function () { loadDay(); }).catch(fail);
        });
      });
      $$('[data-reset]', box).forEach(function (b) {
        b.addEventListener('click', function () { api('POST', '/api/admin/slots/' + b.getAttribute('data-reset') + '/reset').then(function () { loadDay(); }).catch(fail); });
      });
    }).catch(fail);
  }
  function specialDayForm(ov) {
    ov = ov || {};
    var box = $('#ag-day');
    var f = document.createElement('form');
    f.className = 'panel'; f.style.background = '#FAFCFE';
    f.innerHTML = '<h2>Horário especial em ' + fmtDate(agendaDate) + '</h2><div class="form-grid">' +
      '<label class="f"><span>Abertura</span><input type="time" name="open_time" value="' + (ov.open_time || '08:00') + '"></label>' +
      '<label class="f"><span>Encerramento</span><input type="time" name="close_time" value="' + (ov.close_time || '12:00') + '"></label>' +
      '<label class="f"><span>Pausa início (opcional)</span><input type="time" name="lunch_start" value="' + (ov.lunch_start || '') + '"></label>' +
      '<label class="f"><span>Pausa fim</span><input type="time" name="lunch_end" value="' + (ov.lunch_end || '') + '"></label>' +
      '<label class="f"><span>Intervalo (min)</span><input type="number" name="interval_minutes" min="5" max="240" value="' + (ov.interval_minutes || 30) + '"></label>' +
      '<label class="f"><span>Vagas por horário</span><input type="number" name="capacity" min="0" max="500" value="' + (ov.capacity == null ? 5 : ov.capacity) + '"></label>' +
      '<label class="f"><span>Limite diário (opcional)</span><input type="number" name="daily_limit" min="0" value="' + (ov.daily_limit == null ? '' : ov.daily_limit) + '"></label></div>' +
      '<div class="btn-row"><button class="btn primary">Salvar horário especial</button><button type="button" class="btn" data-cancel>Cancelar</button></div>';
    box.prepend(f);
    $('[data-cancel]', f).addEventListener('click', function () { f.remove(); });
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var body = { is_blocked: false };
      ['open_time', 'close_time', 'lunch_start', 'lunch_end', 'interval_minutes', 'capacity', 'daily_limit'].forEach(function (k) { body[k] = f[k].value || null; });
      api('PUT', '/api/admin/date-overrides/' + agendaDate, body).then(function () { toast('Horário especial salvo.'); loadDay(); loadRules(); }).catch(fail);
    });
  }
  function loadRules() {
    api('GET', '/api/admin/schedule-rules').then(function (d) {
      $('#rules').innerHTML = '<form id="rf"><div style="overflow-x:auto"><table class="rules"><thead><tr><th>Dia</th><th>Atende</th><th>Abertura</th><th>Encerramento</th><th>Pausa início</th><th>Pausa fim</th><th>Intervalo (min)</th><th>Vagas por horário</th><th>Limite diário</th></tr></thead><tbody>' +
        d.rules.map(function (r) {
          var w = r.weekday;
          return '<tr data-w="' + w + '"><td>' + DAYS[w] + '</td><td><label class="cbx" style="margin:0"><input type="checkbox" name="is_open"' + (r.is_open ? ' checked' : '') + '> sim</label></td>' +
            '<td><input type="time" name="open_time" value="' + r.open_time + '" aria-label="Abertura ' + DAYS[w] + '"></td><td><input type="time" name="close_time" value="' + r.close_time + '" aria-label="Encerramento"></td>' +
            '<td><input type="time" name="lunch_start" value="' + (r.lunch_start || '') + '" aria-label="Pausa início"></td><td><input type="time" name="lunch_end" value="' + (r.lunch_end || '') + '" aria-label="Pausa fim"></td>' +
            '<td><input type="number" name="interval_minutes" min="5" max="240" value="' + r.interval_minutes + '" aria-label="Intervalo"></td><td><input type="number" name="capacity" min="0" max="500" value="' + r.capacity + '" aria-label="Vagas"></td>' +
            '<td><input type="number" name="daily_limit" min="0" placeholder="sem limite" value="' + (r.daily_limit == null ? '' : r.daily_limit) + '" aria-label="Limite diário"></td></tr>';
        }).join('') + '</tbody></table></div><div class="btn-row" style="margin-top:12px"><button class="btn primary">Salvar horários</button></div></form>';
      $('#rf').addEventListener('submit', function (e) {
        e.preventDefault();
        var rules = $$('#rf tr[data-w]').map(function (tr) {
          var g = function (n) { return tr.querySelector('[name=' + n + ']'); };
          return { weekday: Number(tr.getAttribute('data-w')), is_open: g('is_open').checked, open_time: g('open_time').value, close_time: g('close_time').value, lunch_start: g('lunch_start').value || null, lunch_end: g('lunch_end').value || null, interval_minutes: g('interval_minutes').value, capacity: g('capacity').value, daily_limit: g('daily_limit').value };
        });
        api('PUT', '/api/admin/schedule-rules', { rules: rules }).then(function () { toast('Horários salvos e agenda atualizada.'); loadDay(); }).catch(fail);
      });
      $('#overrides').innerHTML = d.overrides.length ? '<ul class="list-kv">' + d.overrides.map(function (o) {
        return '<li><span><b>' + esc(o.label) + '</b> — ' + (o.is_blocked ? 'bloqueada' + (o.reason ? ' (' + esc(o.reason) + ')' : '') : 'horário especial ' + (o.open_time || '') + '–' + (o.close_time || '')) + '</span><span class="btn-row"><button class="btn small" data-go="' + o.date + '">Ver</button><button class="btn small" data-del="' + o.date + '">Remover</button></span></li>';
      }).join('') + '</ul>' : '<p class="hint">Nenhuma exceção cadastrada.</p>';
      $$('#overrides [data-go]').forEach(function (b) { b.addEventListener('click', function () { agendaDate = b.getAttribute('data-go'); $('#ag-date').value = agendaDate; loadDay(); window.scrollTo({ top: 0, behavior: 'smooth' }); }); });
      $$('#overrides [data-del]').forEach(function (b) { b.addEventListener('click', function () { api('DELETE', '/api/admin/date-overrides/' + b.getAttribute('data-del')).then(function () { toast('Exceção removida.'); loadRules(); loadDay(); }).catch(fail); }); });
    }).catch(fail);
  }

  // ---------- Lista de espera ----------
  function pageWaitlist() {
    api('GET', '/api/admin/waitlist').then(function (d) {
      var ST = { AGUARDANDO: 'Aguardando', CONTATADO: 'Contatado', AGENDADO: 'Agendado', DESCARTADO: 'Descartado' };
      main().innerHTML = '<div class="page-head"><div><h1>Lista de espera</h1><p>Pessoas que procuraram horário quando não havia vagas.</p></div></div>' +
        (d.items.length ? '<div class="table-wrap"><table class="t"><thead><tr><th>Nome</th><th>Idade</th><th>WhatsApp</th><th>Entrou em</th><th>Status</th></tr></thead><tbody>' +
          d.items.map(function (r) {
            return '<tr><td data-l="Nome"><b>' + esc(r.name) + '</b></td><td data-l="Idade">' + (r.age == null ? '—' : r.age) + '</td><td data-l="WhatsApp"><a href="' + wa(r.whatsapp, 'Olá, ' + r.name.split(' ')[0] + '! Abrimos novos horários para o exame de vista gratuito da Clínica Olhar.') + '" target="_blank" rel="noopener">' + esc(r.whatsappLabel) + '</a></td><td data-l="Entrou em">' + esc(r.created) + '</td>' +
              '<td data-l="Status"><select data-wl="' + r.id + '">' + Object.keys(ST).map(function (k) { return '<option value="' + k + '"' + (r.status === k ? ' selected' : '') + '>' + ST[k] + '</option>'; }).join('') + '</select></td></tr>';
          }).join('') + '</tbody></table></div>' : '<div class="panel empty">Ninguém na lista de espera.</div>');
      $$('[data-wl]').forEach(function (s) { s.addEventListener('change', function () { api('PATCH', '/api/admin/waitlist/' + s.getAttribute('data-wl'), { status: s.value }).then(function () { toast('Status atualizado.'); }).catch(fail); }); });
    }).catch(fail);
  }

  // ---------- Configurações ----------
  function pageSettings() {
    Promise.all([api('GET', '/api/admin/settings'), api('GET', '/api/admin/faq'), api('GET', '/api/admin/legal'), isPrincipal() ? api('GET', '/api/admin/audit') : Promise.resolve(null)]).then(function (all) {
      var s = all[0].settings, faq = all[1].items, legal = all[2], auditLog = all[3] ? all[3].items : null;
      var cb = function (name, checked, label) { return '<label class="cbx"><input type="checkbox" name="' + name + '"' + (checked ? ' checked' : '') + '><span>' + label + '</span></label>'; };
      var inp = function (name, label, value, attrs) { return '<label class="f"><span>' + label + '</span><input ' + (attrs || 'type="text"') + ' name="' + name + '" value="' + esc(value == null ? '' : value) + '"></label>'; };
      main().innerHTML = '<div class="page-head"><div><h1>Configurações</h1><p>Tudo o que aparece no site pode ser ajustado aqui.</p></div></div>' +
        '<form class="panel" id="profile"><h2>Meu perfil</h2><p class="hint">Seu nome aparece na saudação do painel.</p><div class="form-grid">' + inp('name', 'Seu nome', me.name === 'Administrador' ? '' : me.name, 'type="text" maxlength="80" autocomplete="name" placeholder="Ex.: Igor"') +
        '<div style="align-self:end;margin-bottom:12px"><button class="btn primary">Salvar nome</button></div></div></form>' +
        '<form class="panel" data-sec="booking"><h2>Agendamento</h2>' +
        cb('enabled', s.booking.enabled, '<b>Agendamentos online abertos</b> — quando desligado, o site não aceita novos agendamentos.') +
        cb('waitlist_enabled', s.booking.waitlist_enabled, 'Oferecer lista de espera quando não houver vagas') +
        '<div class="form-grid">' + inp('scarcity_threshold', 'Mostrar “Últimas N vagas” quando restarem até', s.booking.scarcity_threshold, 'type="number" min="0"') +
        inp('min_age', 'Idade mínima (vazio = sem regra)', s.booking.min_age, 'type="number" min="0" max="120"') +
        inp('max_age', 'Idade máxima (vazio = sem regra)', s.booking.max_age, 'type="number" min="0" max="120"') +
        '<label class="f"><span>Menores de 18 anos</span><select name="minor_rule"><option value="guardian_required">Aceitar com responsável (pede nome e confirmação)</option><option value="allowed">Aceitar sem exigências adicionais</option><option value="blocked">Não aceitar</option></select></label></div>' +
        '<p class="hint">O selo do topo do site mostra sempre o número real de vagas. “Últimas vagas” só aparece quando o total é igual ou menor que o valor acima.</p><button class="btn primary" style="margin-top:10px">Salvar</button></form>' +

        '<form class="panel" data-sec="clinic"><h2>Clínica</h2><div class="form-grid">' + inp('name', 'Nome da clínica', s.clinic.name) + inp('whatsapp', 'WhatsApp oficial (com DDD)', s.clinic.whatsapp ? phone(s.clinic.whatsapp) : '', 'type="text" inputmode="tel" placeholder="(92) 99999-9999"') + '</div>' +
        inp('address', 'Endereço completo do atendimento', s.clinic.address, 'type="text" placeholder="Rua, número, bairro, cidade"') +
        '<div class="form-grid">' + inp('maps_url', 'Link do mapa (opcional)', s.clinic.maps_url, 'type="text" placeholder="https://maps.google.com/..."') + inp('opening_hours_text', 'Horário de funcionamento (texto do rodapé)', s.clinic.opening_hours_text, 'type="text" placeholder="Seg. a sex., 8h às 16h · Sáb., 8h às 12h"') + '</div>' +
        '<button class="btn primary">Salvar</button></form>' +

        '<section class="panel"><h2>Logomarca</h2><p class="hint">PNG, JPG ou WEBP de até 400 KB, de preferência com fundo transparente e formato horizontal.</p><div class="btn-row" style="margin-top:10px">' +
        (all[0].logo ? '<img src="/media/logo?v=' + all[0].logo.version + '" alt="Logo atual" style="height:44px;border:1px solid var(--line);border-radius:8px;padding:4px;background:#fff">' : '<span class="hint">Usando a marca padrão.</span>') +
        '<input type="file" id="logo-file" accept="image/png,image/jpeg,image/webp" style="width:auto">' + (all[0].logo ? '<button class="btn danger small" id="logo-del">Remover logo</button>' : '') + '</div></section>' +

        '<form class="panel" data-sec="social_proof"><h2>Pop-ups do site</h2><p class="hint">Pequenos avisos no canto da tela, um por vez, que nunca cobrem o formulário. Os avisos de agendamento usam somente agendamentos reais de pacientes que autorizaram exibir o primeiro nome.</p>' +
        cb('institutional', s.social_proof.institutional !== false, '<b>Avisos da clínica</b> — ex.: “Exame de vista 100% gratuito”, “Horários disponíveis para hoje e amanhã” (sem citar pacientes)') +
        cb('enabled', s.social_proof.enabled, '<b>Avisos de agendamentos reais</b> — ex.: “Mariana agendou seu exame para sábado, às 10h”') + inp('max_age_hours', 'Mostrar agendamentos das últimas (horas)', s.social_proof.max_age_hours, 'type="number" min="1" max="168"') + '<button class="btn primary">Salvar</button></form>' +

        '<form class="panel" data-sec="content"><h2>Seção “Por que cuidar da visão?”</h2>' + inp('vision_title', 'Título', s.content.vision_title) +
        '<label class="f"><span>Parágrafos (um por linha em branco)</span><textarea name="vision_paragraphs" rows="8">' + esc(s.content.vision_paragraphs.join('\n\n')) + '</textarea></label><p class="hint">Use linguagem informativa. Não prometa diagnóstico, cura ou resultados.</p><button class="btn primary" style="margin-top:10px">Salvar</button></form>' +

        '<section class="panel"><h2>Dúvidas frequentes</h2><p class="hint">Perguntas sem resposta não aparecem no site. A pergunta “Onde será realizado o exame?” sem resposta usa automaticamente o endereço cadastrado.</p><div id="faq" style="margin-top:12px">' +
        faq.map(faqItem).join('') + '</div><div class="btn-row"><button class="btn" id="faq-add">Adicionar pergunta</button><button class="btn primary" id="faq-save">Salvar dúvidas</button></div></section>' +

        '<section class="panel"><h2>Privacidade e LGPD</h2><form data-sec="privacy" class="form-grid">' + inp('retention_days', 'Anonimizar dados após (dias)', s.privacy.retention_days, 'type="number" min="30" max="3650"') + '<div style="align-self:end;margin-bottom:12px"><button class="btn primary">Salvar prazo</button></div></form>' +
        '<h3>Política de Privacidade — versão em vigor: ' + esc(legal.current ? legal.current.version : '—') + '</h3><p class="hint">Marcadores disponíveis: {{clinica}}, {{whatsapp}}, {{retencao}}. Linhas com “## ” viram subtítulos e com “- ” viram itens. Publicar cria uma nova versão; os consentimentos registram a versão aceita. Revise o texto com a assessoria jurídica da clínica.</p>' +
        '<textarea id="policy" rows="16" style="margin-top:8px">' + esc(legal.current ? legal.current.body : '') + '</textarea><div class="btn-row" style="margin-top:8px"><button class="btn primary" id="policy-save">Publicar nova versão</button>' + publicLink('/privacidade', 'Ver página') + '</div></section>' +

        '<form class="panel" id="pwf"><h2>Segurança — trocar senha</h2><div class="form-grid">' + inp('current', 'Senha atual', '', 'type="password" autocomplete="current-password"') + inp('next', 'Nova senha (12+ caracteres)', '', 'type="password" autocomplete="new-password"') + '</div><button class="btn primary">Trocar senha</button></form>' +

        (auditLog ? '<section class="panel"><h2>Registro de atividades</h2><ul class="list-kv">' + (auditLog.length ? auditLog.slice(0, 60).map(function (a) { return '<li><span>' + esc(a.at) + ' · ' + esc(a.email || '—') + '</span><span>' + esc(a.action) + (a.entity_id ? ' #' + esc(a.entity_id) : '') + '</span></li>'; }).join('') : '<li>Sem registros.</li>') + '</ul></section>' : '');
      $('#profile').addEventListener('submit', function (e) {
        e.preventDefault();
        api('PATCH', '/api/admin/me', { name: e.target.name.value }).then(function (d) { me = d.admin; toast('Nome salvo.'); route(); }).catch(fail);
      });

      $('[name=minor_rule]').value = s.booking.minor_rule;
      $$('form[data-sec]').forEach(function (f) {
        f.addEventListener('submit', function (e) {
          e.preventDefault();
          var sec = f.getAttribute('data-sec'), body = {};
          $$('input, select, textarea', f).forEach(function (el) {
            if (!el.name) return;
            body[el.name] = el.type === 'checkbox' ? el.checked : el.value;
          });
          if (sec === 'content') body.vision_paragraphs = body.vision_paragraphs.split(/\n\s*\n/).map(function (p) { return p.trim(); }).filter(Boolean);
          api('PUT', '/api/admin/settings/' + sec, body).then(function () { toast('Configurações salvas.'); }).catch(fail);
        });
      });
      $('#faq-add').addEventListener('click', function () { $('#faq').insertAdjacentHTML('beforeend', faqItem({ question: '', answer: '', active: true })); });
      $('#faq').addEventListener('click', function (e) { var b = e.target.closest('[data-faq-del]'); if (b) b.closest('.faq-item').remove(); });
      $('#faq-save').addEventListener('click', function () {
        var items = $$('#faq .faq-item').map(function (it) { return { question: $('[name=q]', it).value, answer: $('[name=a]', it).value, active: $('[name=on]', it).checked }; });
        api('PUT', '/api/admin/faq', { items: items }).then(function () { toast('Dúvidas salvas.'); }).catch(fail);
      });
      $('#policy-save').addEventListener('click', function () {
        if (!confirm('Publicar uma nova versão da Política de Privacidade?')) return;
        api('PUT', '/api/admin/legal', { body: $('#policy').value }).then(function (d) { toast('Versão ' + d.version + ' publicada.'); route(); }).catch(fail);
      });
      $('#pwf').addEventListener('submit', function (e) {
        e.preventDefault();
        api('POST', '/api/admin/password', { current: e.target.current.value, next: e.target.next.value }).then(function () { toast('Senha alterada.'); e.target.reset(); }).catch(fail);
      });
      $('#logo-file').addEventListener('change', function (e) {
        var file = e.target.files[0]; if (!file) return;
        if (file.size > 400 * 1024) { toast('A imagem deve ter até 400 KB.', true); return; }
        var reader = new FileReader();
        reader.onload = function () {
          api('POST', '/api/admin/logo', { mime: file.type, data: String(reader.result).split(',')[1] }).then(function () { toast('Logo atualizada.'); route(); }).catch(fail);
        };
        reader.readAsDataURL(file);
      });
      var del = $('#logo-del'); if (del) del.addEventListener('click', function () { api('DELETE', '/api/admin/logo').then(function () { toast('Logo removida.'); route(); }).catch(fail); });
    }).catch(fail);
  }
  function faqItem(f) {
    return '<div class="faq-item"><label class="f"><span>Pergunta</span><input type="text" name="q" value="' + esc(f.question) + '" maxlength="200"></label>' +
      '<label class="f"><span>Resposta</span><textarea name="a" rows="3" maxlength="2000">' + esc(f.answer) + '</textarea></label>' +
      '<div class="btn-row"><label class="cbx" style="margin:0"><input type="checkbox" name="on"' + (f.active ? ' checked' : '') + '> Exibir no site</label><button type="button" class="btn small danger" data-faq-del>Remover</button></div></div>';
  }

  // ---------- Janela (modal) ----------
  function modal(title, bodyHtml, opts) {
    closeModal();
    opts = opts || {};
    var bg = document.createElement('div'); bg.className = 'modal-bg'; bg.id = 'modal-bg';
    var m = document.createElement('div'); m.className = 'modal' + (opts.cls ? ' ' + opts.cls : ''); m.id = 'modal';
    m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', 'modal-title');
    m.innerHTML = '<div class="modal-head"><h2 id="modal-title">' + title + '</h2><button type="button" class="modal-x" data-modal-x aria-label="Fechar">×</button></div><div class="modal-body">' + bodyHtml + '</div>';
    bg.addEventListener('click', closeModal);
    document.body.appendChild(bg); document.body.appendChild(m);
    document.body.classList.add('modal-open');
    $('[data-modal-x]', m).addEventListener('click', closeModal);
    var first = $('input, select, button:not([data-modal-x])', m); if (first) first.focus();
    return m;
  }
  function closeModal() { $$('#modal, #modal-bg').forEach(function (x) { x.remove(); }); document.body.classList.remove('modal-open'); }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && $('#modal')) closeModal(); });

  // Campo de senha com botão mostrar/ocultar
  function pwField(name, label, auto, extra) {
    return '<label class="f"><span>' + label + '</span><span class="pw-wrap"><input type="password" name="' + name + '" autocomplete="' + (auto || 'off') + '"' + (extra || '') + '>' +
      '<button type="button" class="pw-eye" data-eye aria-label="Mostrar senha" aria-pressed="false">Mostrar</button></span></label>';
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-eye]'); if (!b) return;
    var i = b.parentNode.querySelector('input'); var show = i.type === 'password';
    i.type = show ? 'text' : 'password'; b.textContent = show ? 'Ocultar' : 'Mostrar';
    b.setAttribute('aria-pressed', String(show)); b.setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
  });
  function copyText(text, btn) {
    var done = function () { if (btn) { btn.textContent = 'Copiado!'; setTimeout(function () { btn.textContent = 'Copiar'; }, 1800); } };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, function () { manual(); });
    else manual();
    function manual() { var i = btn && btn.parentNode.querySelector('input'); if (i) { i.select(); try { document.execCommand('copy'); done(); } catch (x) { /* o usuário copia manualmente */ } } }
  }

  // ---------- Administradores (somente o administrador principal) ----------
  var ST_ADMIN = { ativo: ['Ativo', 's-COMPARECEU'], desativado: ['Desativado', 's-CANCELADO'], convite_pendente: ['Convite pendente', 's-CONTATADO'], convite_expirado: ['Convite expirado', 's-NAO_COMPARECEU'] };
  function pageAdmins() {
    if (!isPrincipal()) { main().innerHTML = deniedHtml(); return; }
    api('GET', '/api/admin/admins').then(function (d) {
      var roleSel = function (id, cur) { return '<select data-role="' + id + '" aria-label="Permissão">' + Object.keys(d.roles).map(function (k) { return '<option value="' + k + '"' + (k === cur ? ' selected' : '') + '>' + esc(d.roles[k]) + '</option>'; }).join('') + '</select>'; };
      var rows = d.admins.map(function (a) {
        var self = a.id === d.me;
        return '<tr><td data-l="Nome"><b>' + esc(a.name) + '</b>' + (self ? '<span class="sub">Você</span>' : '') + '</td><td data-l="E-mail">' + esc(a.email) + '</td>' +
          '<td data-l="Permissão">' + (self ? esc(d.roles[a.role]) : roleSel(a.id, a.role)) + '</td>' +
          '<td data-l="Status"><span class="pill ' + ST_ADMIN[a.status][1] + '">' + ST_ADMIN[a.status][0] + '</span></td>' +
          '<td data-l="Último acesso">' + esc(a.last_login || '—') + '</td>' +
          '<td data-l="Ações">' + (self ? '' : '<div class="btn-row">' + (a.disabled ? '<button class="btn small" data-enable="' + a.id + '">Reativar acesso</button>' : '<button class="btn small" data-disable="' + a.id + '">Desativar acesso</button>') +
            '<button class="btn small danger" data-remove="' + a.id + '" data-name="' + esc(a.name) + '">Remover</button></div>') + '</td></tr>';
      }).concat(d.invites.map(function (i) {
        return '<tr class="is-invite"><td data-l="Nome"><b>' + esc(i.name) + '</b><span class="sub">Convite ' + (i.expired ? 'expirou' : 'válido até') + ' ' + esc(i.expires) + '</span></td><td data-l="E-mail">' + esc(i.email) + '</td>' +
          '<td data-l="Permissão">' + esc(d.roles[i.role]) + '</td><td data-l="Status"><span class="pill ' + ST_ADMIN[i.status][1] + '">' + ST_ADMIN[i.status][0] + '</span></td><td data-l="Último acesso">—</td>' +
          '<td data-l="Ações"><div class="btn-row"><button class="btn small" data-resend="' + i.id + '">Reenviar convite</button><button class="btn small danger" data-revoke="' + i.id + '">Revogar convite</button></div></td></tr>';
      }));
      main().innerHTML = '<div class="page-head"><div><h1>Gerenciar administradores</h1><p>Somente você, como administrador principal, pode convidar, alterar ou remover acessos.</p></div><button class="btn primary" id="add-admin">+ ADICIONAR ADMINISTRADOR</button></div>' +
        '<div class="table-wrap"><table class="t t-admins"><thead><tr><th>Nome</th><th>E-mail</th><th>Permissão</th><th>Status</th><th>Último acesso</th><th></th></tr></thead><tbody>' + rows.join('') + '</tbody></table></div>' +
        '<section class="panel"><h2>Níveis de acesso</h2><ul class="list-kv"><li><span><b>Administrador principal</b></span><span>acesso completo: administradores, Integrações e configurações sensíveis</span></li>' +
        '<li><span><b>Administrador</b></span><span>agendamentos, pacientes, agenda, lista de espera e configurações do site — sem Integrações e sem gerenciar administradores</span></li></ul></section>';
      $('#add-admin').addEventListener('click', function () { inviteForm(d); });
      $$('[data-role]').forEach(function (sel) {
        sel.addEventListener('change', function () {
          api('PATCH', '/api/admin/admins/' + sel.getAttribute('data-role'), { role: sel.value }).then(function () { toast('Permissão alterada.'); pageAdmins(); }).catch(function (x) { fail(x); pageAdmins(); });
        });
      });
      var act = function (attr, fn) { $$('[' + attr + ']').forEach(function (b) { b.addEventListener('click', function () { fn(b.getAttribute(attr), b); }); }); };
      act('data-disable', function (id) { if (!confirm('Desativar o acesso deste administrador? As sessões abertas serão encerradas.')) return; api('PATCH', '/api/admin/admins/' + id, { disabled: true }).then(function () { toast('Acesso desativado.'); pageAdmins(); }).catch(fail); });
      act('data-enable', function (id) { api('PATCH', '/api/admin/admins/' + id, { disabled: false }).then(function () { toast('Acesso reativado.'); pageAdmins(); }).catch(fail); });
      act('data-remove', function (id, b) { if (!confirm('Remover ' + b.getAttribute('data-name') + ' dos administradores? Esta ação não pode ser desfeita.')) return; api('DELETE', '/api/admin/admins/' + id).then(function () { toast('Administrador removido.'); pageAdmins(); }).catch(fail); });
      act('data-revoke', function (id) { if (!confirm('Revogar este convite? O link deixará de funcionar.')) return; api('DELETE', '/api/admin/invites/' + id).then(function () { toast('Convite revogado.'); pageAdmins(); }).catch(fail); });
      act('data-resend', function (id) { api('POST', '/api/admin/invites/' + id + '/resend').then(function (r) { showInviteLink(r, d); pageAdmins(); }).catch(fail); });
    }).catch(failPage);
  }
  function inviteForm(d) {
    var m = modal('Adicionar administrador', '<form id="inv-form" novalidate>' +
      '<label class="f"><span>Nome do administrador</span><input type="text" name="name" maxlength="80" autocomplete="off" required></label>' +
      '<label class="f"><span>E-mail</span><input type="email" name="email" maxlength="160" autocomplete="off" required></label>' +
      '<label class="f"><span>Nível de acesso</span><select name="role"><option value="admin">Administrador</option><option value="principal">Administrador principal</option></select></label>' +
      '<p class="hint">Será gerado um link de ativação exclusivo, de uso único e válido por ' + d.inviteHours + ' horas. A pessoa cria a própria senha — nenhuma senha é enviada.</p>' +
      '<p class="err" id="inv-err" hidden></p><div class="btn-row modal-actions"><button type="button" class="btn" data-cancel>Cancelar</button><button class="btn primary">Gerar convite</button></div></form>');
    $('[data-cancel]', m).addEventListener('click', closeModal);
    $('#inv-form', m).addEventListener('submit', function (e) {
      e.preventDefault(); var f = e.target, err = $('#inv-err', m);
      api('POST', '/api/admin/invites', { name: f.name.value, email: f.email.value, role: f.role.value })
        .then(function (r) { showInviteLink(r, d); pageAdmins(); })
        .catch(function (x) { err.textContent = x.message; err.hidden = false; });
    });
  }
  function showInviteLink(r, d) {
    var link = location.origin + location.pathname + '#/convite/' + r.token;
    var m = modal('Convite criado', '<p>Envie este link para a pessoa por um canal seguro (ex.: WhatsApp direto). Ele é de <b>uso único</b> e vale por <b>' + r.hours + ' horas</b>.</p>' +
      '<div class="copy-row"><input type="text" readonly id="inv-link" value="' + esc(link) + '" aria-label="Link do convite"><button type="button" class="btn primary" id="inv-copy">Copiar</button></div>' +
      '<p class="hint">' + (r.emailSent ? 'O convite também foi enviado por e-mail.' : 'O envio automático por e-mail não está configurado — por isso o link aparece aqui. Ele não será exibido novamente; se precisar, use “Reenviar convite” para gerar outro.') + '</p>' +
      '<div class="btn-row modal-actions"><button type="button" class="btn" data-ok>Concluir</button></div>');
    $('#inv-copy', m).addEventListener('click', function (e) { copyText(link, e.target); });
    $('[data-ok]', m).addEventListener('click', closeModal);
  }
  function deniedHtml() { return '<div class="panel denied"><h2>Acesso negado</h2><p class="hint">Esta área é exclusiva do administrador principal.</p></div>'; }
  function failPage(x) { if (x && x.status === 403 && x.code === 'FORBIDDEN') { main().innerHTML = deniedHtml(); return; } fail(x); }

  // ---------- Ativação do convite (sem login) ----------
  function renderInvite(token) {
    app.className = '';
    var wrap = function (inner) { app.innerHTML = '<div class="auth"><div class="auth-brand">' + LOGO_FULL + '</div>' + inner + '</div>'; };
    wrap('<div class="auth-card"><p>Verificando convite…</p></div>');
    api('POST', '/api/admin/invites/check', { token: token }).then(function (d) {
      var inv = d.invite;
      wrap('<form class="auth-card" id="accept" novalidate><h1>Ative seu acesso</h1><p>Você foi convidado como <b>' + esc(inv.roleLabel) + '</b> do painel da Clínica Olhar.</p>' +
        '<label class="f"><span>Confirme seu e-mail</span><input type="email" name="email" autocomplete="username" placeholder="' + esc(inv.email.replace(/^(.).*(@.*)$/, '$1•••$2')) + '" required></label>' +
        '<label class="f"><span>Seu nome</span><input type="text" name="name" maxlength="80" autocomplete="name" value="' + esc(inv.name) + '"></label>' +
        pwField('password', 'Crie sua senha (12+ caracteres, letras e números)', 'new-password') + pwField('confirm', 'Confirme a senha', 'new-password') +
        '<p class="err" id="acc-err" hidden></p><button class="btn primary btn-block">Ativar minha conta</button></form>');
      $('#accept').addEventListener('submit', function (e) {
        e.preventDefault(); var f = e.target, err = $('#acc-err');
        if (f.password.value !== f.confirm.value) { err.textContent = 'As senhas não conferem.'; err.hidden = false; return; }
        f.querySelector('button.primary').disabled = true;
        api('POST', '/api/admin/invites/accept', { token: token, email: f.email.value, name: f.name.value, password: f.password.value, confirm: f.confirm.value })
          .then(function () {
            history.replaceState(null, '', location.pathname + '#/painel'); // o link de uso único sai da barra de endereço
            renderLogin(); toast('Conta ativada. Entre com seu e-mail e a senha que você criou.');
          })
          .catch(function (x) { err.textContent = x.message; err.hidden = false; f.querySelector('button.primary').disabled = false; });
      });
    }).catch(function (x) {
      wrap('<div class="auth-card"><h1>Convite indisponível</h1><p>' + esc(x.message) + '</p><a class="btn primary btn-block" href="#/painel">Ir para o login</a></div>');
    });
  }

  // ---------- Integrações (somente administrador principal + senha exclusiva) ----------
  var integrIdle = null;
  function armIntegrationsIdle(minutes) {
    clearTimeout(integrIdle);
    // Espelha o prazo do servidor: após 10 min sem uso, a tela volta a ficar bloqueada.
    integrIdle = setTimeout(function () { if (/^#\/integracoes/.test(location.hash)) { toast('Integrações bloqueadas por inatividade.'); route(); } }, (minutes || 10) * 60 * 1000);
  }
  function pageIntegrations() {
    if (!isPrincipal()) { main().innerHTML = deniedHtml(); return; }
    api('GET', '/api/admin/integrations').then(function (d) { armIntegrationsIdle(10); renderIntegrations(d); }).catch(function (x) {
      if (x.status === 423 && x.code === 'INTEGRATIONS_SETUP') return renderIntegrationsSetup();
      if (x.status === 423) return renderUnlock();
      failPage(x);
    });
  }
  var LOCK_ICO = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="15.5" r="1.4" fill="currentColor"/></svg>';
  function lockCard(inner) { main().innerHTML = '<div class="lock-wrap"><div class="lock-card"><span class="lock-ico">' + LOCK_ICO + '</span>' + inner + '</div></div>'; }
  function renderUnlock() {
    lockCard('<p class="lock-kicker">ÁREA PROTEGIDA</p><h1>Integrações</h1><p class="hint">Por segurança, confirme sua senha de Integrações para continuar.</p>' +
      '<form id="unlock" novalidate>' + pwField('password', 'Senha de Integrações', 'off', ' required') +
      '<p class="err" id="un-err" hidden></p><button class="btn primary btn-block">DESBLOQUEAR INTEGRAÇÕES</button></form>' +
      '<button type="button" class="linkbtn" id="forgot">Esqueci a senha de Integrações</button>');
    var f = $('#unlock'); f.password.focus();
    f.addEventListener('submit', function (e) {
      e.preventDefault(); var err = $('#un-err'); var btn = f.querySelector('button.primary'); btn.disabled = true;
      api('POST', '/api/admin/integrations/unlock', { password: f.password.value }).then(function () { pageIntegrations(); })
        .catch(function (x) { err.textContent = x.message; err.hidden = false; btn.disabled = false; f.password.value = ''; f.password.focus(); });
    });
    $('#forgot').addEventListener('click', renderReset);
  }
  function showRecoveryCode(code, then) {
    lockCard('<p class="lock-kicker">CÓDIGO DE RECUPERAÇÃO</p><h1>Guarde este código</h1><p class="hint">Ele é exibido <b>uma única vez</b> e será pedido, junto com a senha da sua conta, se você esquecer a senha de Integrações. Anote em local seguro (fora deste computador).</p>' +
      '<div class="copy-row"><input type="text" readonly id="rc" value="' + esc(code) + '" aria-label="Código de recuperação" class="mono"><button type="button" class="btn primary" id="rc-copy">Copiar</button></div>' +
      '<label class="cbx"><input type="checkbox" id="rc-ok"><span>Guardei o código em local seguro</span></label><button class="btn primary btn-block" id="rc-go" disabled>Continuar</button>');
    $('#rc-copy').addEventListener('click', function (e) { copyText(code, e.target); });
    $('#rc-ok').addEventListener('change', function (e) { $('#rc-go').disabled = !e.target.checked; });
    $('#rc-go').addEventListener('click', then);
  }
  function renderIntegrationsSetup() {
    lockCard('<p class="lock-kicker">SEGURANÇA DAS INTEGRAÇÕES</p><h1>Crie a senha de Integrações</h1><p class="hint">Primeiro acesso: defina uma senha exclusiva para proteger Meta Pixel, API de Conversões e tokens. Use pelo menos 12 caracteres, com letras e números — e uma senha diferente da sua senha de login.</p>' +
      '<form id="isetup" novalidate>' + pwField('password', 'Nova senha de Integrações', 'new-password') + pwField('confirm', 'Confirme a nova senha', 'new-password') +
      '<p class="err" id="is-err" hidden></p><button class="btn primary btn-block">Criar senha de proteção</button></form>');
    $('#isetup').addEventListener('submit', function (e) {
      e.preventDefault(); var f = e.target, err = $('#is-err');
      if (f.password.value !== f.confirm.value) { err.textContent = 'As senhas não conferem.'; err.hidden = false; return; }
      api('POST', '/api/admin/integrations/setup', { password: f.password.value, confirm: f.confirm.value })
        .then(function (r) { showRecoveryCode(r.recoveryCode, pageIntegrations); })
        .catch(function (x) { err.textContent = x.message; err.hidden = false; });
    });
  }
  function renderReset() {
    lockCard('<p class="lock-kicker">RECUPERAR ACESSO</p><h1>Redefinir a senha de Integrações</h1><p class="hint">Confirme a senha da sua conta e o código de recuperação recebido ao criar a senha de Integrações.</p>' +
      '<form id="ireset" novalidate>' + pwField('accountPassword', 'Senha da sua conta (login)', 'current-password') +
      '<label class="f"><span>Código de recuperação</span><input type="text" name="recoveryCode" autocomplete="off" autocapitalize="characters" placeholder="XXXXX-XXXXX-XXXXX-XXXXX" class="mono"></label>' +
      pwField('next', 'Nova senha de Integrações', 'new-password') + pwField('confirm', 'Confirme a nova senha', 'new-password') +
      '<p class="err" id="ir-err" hidden></p><button class="btn primary btn-block">Redefinir senha</button></form>' +
      '<p class="hint small-print">Perdeu também o código? Quem administra o servidor pode liberar uma nova configuração pelo terminal do Railway (<span class="mono">npm run integrations:reset -- --confirmar</span>).</p>' +
      '<button type="button" class="linkbtn" id="back-unlock">Voltar</button>');
    $('#back-unlock').addEventListener('click', renderUnlock);
    $('#ireset').addEventListener('submit', function (e) {
      e.preventDefault(); var f = e.target, err = $('#ir-err');
      if (f.next.value !== f.confirm.value) { err.textContent = 'As senhas não conferem.'; err.hidden = false; return; }
      api('POST', '/api/admin/integrations/reset', { accountPassword: f.accountPassword.value, recoveryCode: f.recoveryCode.value, next: f.next.value, confirm: f.confirm.value })
        .then(function (r) { toast('Senha de Integrações redefinida.'); showRecoveryCode(r.recoveryCode, pageIntegrations); })
        .catch(function (x) { err.textContent = x.message; err.hidden = false; });
    });
  }
  function renderIntegrations(d) {
    var m = d.meta, env = d.env;
    main().innerHTML = '<div class="page-head"><div><h1>Integrações</h1><p>META ADS — Pixel e API de Conversões. <span class="unlocked-tag">' + LOCK_ICO + ' Desbloqueado · bloqueia após 10 min sem uso</span></p></div><button class="btn" id="relock">Bloquear agora</button></div>' +
      '<form class="panel" data-sec="meta"><h2>Meta Pixel</h2>' +
      '<label class="cbx"><input type="checkbox" name="pixel_enabled"' + (m.pixel_enabled ? ' checked' : '') + '><span><b>Ativar Meta Pixel</b></span></label>' +
      '<label class="f" style="max-width:360px"><span>ID do Meta Pixel</span><input type="text" name="pixel_id" inputmode="numeric" value="' + esc(m.pixel_id) + '" placeholder="Somente números"></label>' +
      '<label class="cbx"><input type="checkbox" name="require_consent"' + (m.require_consent ? ' checked' : '') + '><span>Pedir consentimento de cookies antes de ativar o Pixel (recomendado pela LGPD)</span></label>' +
      '<label class="cbx"><input type="checkbox" name="schedule_event"' + (m.schedule_event ? ' checked' : '') + '><span>Enviar também o evento <b>Schedule</b> no agendamento confirmado</span></label>' +
      '<h3>API de Conversões</h3><label class="cbx"><input type="checkbox" name="capi_enabled"' + (m.capi_enabled ? ' checked' : '') + '><span>Enviar o evento <b>Lead</b> também pelo servidor</span></label>' +
      '<p class="hint">Token de acesso: ' + (env.capiTokenConfigured ? '<b style="color:var(--green)">configurado</b>' : '<b style="color:var(--red)">não configurado</b>') + '. O token nunca é exibido nem enviado ao navegador; para cadastrar ou substituir, use a variável <span class="mono">META_CAPI_ACCESS_TOKEN</span> do ' + (env.separate ? 'serviço do site público' : 'servidor') + ' no Railway (armazenamento seguro de segredos).' + (env.testEventCode ? ' · Código de teste ativo.' : '') +
      (env.separate ? (env.seenAt ? ' · Site público iniciado em ' + esc(env.seenAt) + '.' : ' · O site público ainda não se conectou ao banco.') : '') + '</p>' +
      '<button class="btn primary" style="margin-top:12px">Salvar</button></form>' +
      '<section class="panel"><h2>Eventos implementados</h2><ul class="list-kv">' +
      '<li><span><b>PageView</b></span><span>carregamento da página</span></li><li><span><b>ViewContent</b></span><span>visualização da oferta</span></li>' +
      '<li><span><b>StartRegistration</b> (personalizado)</span><span>primeira interação com o formulário</span></li>' +
      '<li><span><b>Lead</b> — conversão principal</span><span>somente após o agendamento ser gravado no banco; mesmo event_id no Pixel e na API de Conversões (deduplicação); uma vez por agendamento</span></li>' +
      '<li><span><b>Contact</b></span><span>clique no botão do WhatsApp</span></li><li><span><b>Schedule</b> (opcional)</span><span>agendamento confirmado</span></li></ul>' +
      '<p class="hint" style="margin-top:10px">Enviados à Meta: WhatsApp e primeiro nome em hash SHA-256, IP, navegador e identificadores de clique. Nunca são enviados idade, informações clínicas ou de saúde.</p></section>' +
      '<section class="panel"><h2>Últimos envios pela API de Conversões</h2>' + (d.metaLog.length ? '<ul class="list-kv">' + d.metaLog.map(function (e) { return '<li><span>' + esc(e.at) + ' · ' + esc(e.event_name) + ' · ' + esc(e.protocol || '') + '</span><span class="pill ' + (e.status === 'sent' ? 's-COMPARECEU' : 's-NAO_COMPARECEU') + '">' + esc(e.status) + '</span></li>'; }).join('') + '</ul>' : '<p class="hint">Nenhum envio ainda.</p>') + '</section>' +
      '<section class="panel" id="isec"><h2>SEGURANÇA DAS INTEGRAÇÕES</h2><ul class="list-kv"><li><span>Status da proteção</span><b style="color:var(--green)">Ativa</b></li><li><span>Desbloqueio</span><span>temporário, nesta sessão; expira após 10 minutos sem uso e ao sair da conta</span></li></ul>' +
      '<form id="ipw" novalidate><h3>Alterar senha de Integrações</h3><div class="form-grid">' + pwField('current', 'Senha atual de Integrações', 'off') + pwField('next', 'Nova senha (12+ caracteres)', 'new-password') + pwField('confirm', 'Confirmar nova senha', 'new-password') + '</div>' +
      '<p class="err" id="ipw-err" hidden></p><button class="btn primary">Alterar senha</button></form>' +
      '<h3>Sessões de acesso</h3><p class="hint">Bloqueia imediatamente as Integrações em todos os dispositivos (inclusive este).</p><button class="btn danger" id="revoke" style="margin-top:8px">Revogar sessões de acesso às integrações</button></section>';
    $('#relock').addEventListener('click', function () { api('POST', '/api/admin/integrations/lock').then(function () { clearTimeout(integrIdle); renderUnlock(); }).catch(fail); });
    $('form[data-sec=meta]').addEventListener('submit', function (e) {
      e.preventDefault(); var f = e.target;
      api('PUT', '/api/admin/settings/meta', { pixel_enabled: f.pixel_enabled.checked, pixel_id: f.pixel_id.value, require_consent: f.require_consent.checked, schedule_event: f.schedule_event.checked, capi_enabled: f.capi_enabled.checked })
        .then(function () { armIntegrationsIdle(10); toast('Integração salva.'); }).catch(integrFail);
    });
    $('#ipw').addEventListener('submit', function (e) {
      e.preventDefault(); var f = e.target, err = $('#ipw-err'); err.hidden = true;
      if (f.next.value !== f.confirm.value) { err.textContent = 'As senhas não conferem.'; err.hidden = false; return; }
      api('POST', '/api/admin/integrations/password', { current: f.current.value, next: f.next.value, confirm: f.confirm.value })
        .then(function () { armIntegrationsIdle(10); f.reset(); toast('Senha de Integrações alterada. Outras sessões foram bloqueadas.'); })
        .catch(function (x) { if (x.status === 423) return integrFail(x); err.textContent = x.message; err.hidden = false; });
    });
    $('#revoke').addEventListener('click', function () {
      if (!confirm('Bloquear as Integrações em todas as sessões, inclusive esta?')) return;
      api('POST', '/api/admin/integrations/revoke').then(function () { clearTimeout(integrIdle); toast('Sessões de acesso revogadas.'); renderUnlock(); }).catch(integrFail);
    });
  }
  function integrFail(x) { if (x && x.status === 423) { toast('Integrações bloqueadas. Confirme a senha novamente.', true); renderUnlock(); return; } fail(x); }

  // ---------- Início ----------
  if (/^#\/convite\//.test(location.hash)) route(); // ativação de convite não precisa de sessão
  else api('GET', '/api/admin/me').then(function (d) {
    me = d.admin;
    if (me.mustChangePassword) renderChangePassword(); else route();
  }).catch(function () { /* renderLogin já foi chamado em 401 */ if (!me) renderLogin(); });
})();
