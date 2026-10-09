/* Clínica Olhar — painel administrativo (sem dependências) */
(function () {
  'use strict';
  var app = document.getElementById('app');
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var MARK = '<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M3 20c4.6-7.4 10.3-11 17-11s12.4 3.6 17 11c-4.6 7.4-10.3 11-17 11S7.6 27.4 3 20Z" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"/><circle cx="20" cy="20" r="6.6" fill="currentColor"/></svg>';
  var STATUS = { NOVO: 'Novo', CONFIRMADO: 'Confirmado', CONTATADO: 'Contatado', COMPARECEU: 'Compareceu', NAO_COMPARECEU: 'Não compareceu', CANCELADO: 'Cancelado' };
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
        if (r.status === 401 && url !== '/api/admin/login') { renderLogin(d.error); throw new Error(d.error || 'Sessão expirada'); }
        if (r.status === 403 && d.code === 'MUST_CHANGE_PASSWORD') { renderChangePassword(); throw new Error(d.error); }
        if (!r.ok) { var e = new Error(d.error || 'Erro ' + r.status); e.data = d; throw e; }
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
    me = null;
    app.className = '';
    app.innerHTML = '<div class="auth"><form class="auth-card" id="login" novalidate>' +
      '<div class="logo">' + MARK + '<span>Clínica Olhar</span></div>' +
      '<h1>Painel administrativo</h1><p>Entre com seu e-mail e senha.</p>' +
      '<label class="f"><span>E-mail</span><input type="email" name="email" autocomplete="username" required></label>' +
      '<label class="f"><span>Senha</span><input type="password" name="password" autocomplete="current-password" required></label>' +
      '<p class="err" id="login-err"' + (msg && msg !== 'Sua sessão expirou. Entre novamente.' ? '' : ' hidden') + '>' + esc(msg || '') + '</p>' +
      '<button class="btn primary" style="width:100%;min-height:46px">Entrar</button></form></div>';
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
    app.innerHTML = '<div class="auth"><form class="auth-card" id="pw" novalidate>' +
      '<div class="logo">' + MARK + '<span>Clínica Olhar</span></div>' +
      '<h1>Crie uma nova senha</h1><p>Por segurança, troque a senha inicial antes de continuar. Use pelo menos 12 caracteres, com letras e números.</p>' +
      '<label class="f"><span>Senha atual</span><input type="password" name="current" autocomplete="current-password"></label>' +
      '<label class="f"><span>Nova senha</span><input type="password" name="next" autocomplete="new-password" minlength="12"></label>' +
      '<label class="f"><span>Repita a nova senha</span><input type="password" name="again" autocomplete="new-password"></label>' +
      '<p class="err" id="pw-err" hidden></p><button class="btn primary" style="width:100%;min-height:46px">Salvar nova senha</button></form></div>';
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
  var PAGES = [
    ['painel', 'Painel'], ['agendamentos', 'Agendamentos'], ['agenda', 'Agenda'], ['espera', 'Lista de espera'],
    ['configuracoes', 'Configurações'], ['integracoes', 'Integrações'],
  ];
  function shell(active, inner) {
    app.className = '';
    app.innerHTML = '<div class="shell"><aside class="side"><div class="logo">' + MARK + '<span>Clínica Olhar</span></div><nav class="nav">' +
      PAGES.map(function (p) { return '<a href="#/' + p[0] + '" class="' + (p[0] === active ? 'on' : '') + '">' + p[1] + '</a>'; }).join('') +
      '</nav><div class="side-foot"><div class="who">' + esc(me.email) + '</div><button type="button" id="logout">Sair</button></div></aside><main class="main" id="main">' + inner + '</main></div>';
    $('#logout').addEventListener('click', function () { api('POST', '/api/admin/logout').then(function () { renderLogin(); }); });
  }
  function main() { return $('#main'); }

  function route() {
    if (!me) return;
    var parts = (location.hash.replace(/^#\/?/, '') || 'painel').split('/');
    var page = parts[0];
    var fn = { painel: pageDashboard, agendamentos: pageAppointments, agenda: pageAgenda, espera: pageWaitlist, configuracoes: pageSettings, integracoes: pageIntegrations }[page] || pageDashboard;
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
      main().innerHTML = '<div class="page-head"><div><h1>Painel</h1><p>Hoje é ' + esc(d.labels.today) + '.</p></div>' + publicLink('/', 'Ver site') + '</div>' +
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
    }).catch(fail);
  }

  // ---------- Agendamentos ----------
  var filters = { period: '', field: 'exame', status: '', q: '', from: '', to: '', page: 1 };
  function qs() {
    var p = new URLSearchParams();
    Object.keys(filters).forEach(function (k) { if (filters[k]) p.set(k, filters[k]); });
    return p.toString();
  }
  function pageAppointments() {
    var periods = [['', 'Todos'], ['hoje', 'Hoje'], ['amanha', 'Amanhã'], ['sabado', 'Sábado'], ['7d', 'Últimos 7 dias'], ['mes', 'Este mês'], ['custom', 'Período personalizado']];
    main().innerHTML = '<div class="page-head"><div><h1>Agendamentos</h1><p id="ap-count"></p></div><a class="btn" id="csv" href="#">Exportar CSV</a></div>' +
      '<div class="filters"><div class="chips" id="periods">' + periods.map(function (p) { return '<button type="button" class="chip' + (filters.period === p[0] ? ' on' : '') + '" data-p="' + p[0] + '">' + p[1] + '</button>'; }).join('') + '</div>' +
      '<div class="filters-row" id="custom"' + (filters.period === 'custom' ? '' : ' hidden') + '><select id="f-field"><option value="exame">Data do exame</option><option value="criacao">Data de criação</option></select>' +
      '<label>de <input type="date" id="f-from" value="' + esc(filters.from) + '"></label><label>até <input type="date" id="f-to" value="' + esc(filters.to) + '"></label></div>' +
      '<div class="filters-row"><input type="search" id="f-q" placeholder="Buscar por nome, WhatsApp ou protocolo" value="' + esc(filters.q) + '">' +
      '<select id="f-status"><option value="">Todos os status</option>' + Object.keys(STATUS).map(function (k) { return '<option value="' + k + '"' + (filters.status === k ? ' selected' : '') + '>' + STATUS[k] + '</option>'; }).join('') + '</select></div></div>' +
      '<div id="ap-list"><div class="empty">Carregando…</div></div>';
    $('#f-field').value = filters.field;
    $('#periods').addEventListener('click', function (e) {
      var b = e.target.closest('[data-p]'); if (!b) return;
      filters.period = b.getAttribute('data-p'); filters.page = 1;
      $$('#periods .chip').forEach(function (c) { c.classList.toggle('on', c === b); });
      $('#custom').hidden = filters.period !== 'custom';
      loadAppointments();
    });
    var t;
    $('#f-q').addEventListener('input', function (e) { clearTimeout(t); t = setTimeout(function () { filters.q = e.target.value; filters.page = 1; loadAppointments(); }, 300); });
    $('#f-status').addEventListener('change', function (e) { filters.status = e.target.value; filters.page = 1; loadAppointments(); });
    ['f-field', 'f-from', 'f-to'].forEach(function (id) {
      $('#' + id).addEventListener('change', function () { filters.field = $('#f-field').value; filters.from = $('#f-from').value; filters.to = $('#f-to').value; filters.page = 1; loadAppointments(); });
    });
    $('#csv').addEventListener('click', function (e) { e.preventDefault(); location.href = '/api/admin/appointments.csv?' + qs(); });
    loadAppointments();
  }

  var lastList = [];
  function loadAppointments() {
    api('GET', '/api/admin/appointments?' + qs()).then(function (d) {
      lastList = d.items;
      $('#ap-count').textContent = d.total + (d.total === 1 ? ' agendamento encontrado' : ' agendamentos encontrados');
      if (!d.items.length) { $('#ap-list').innerHTML = '<div class="panel empty">Nenhum agendamento com esses filtros.</div>'; return; }
      $('#ap-list').innerHTML = '<div class="table-wrap"><table class="t"><thead><tr><th>Protocolo</th><th>Nome</th><th>Idade</th><th>WhatsApp</th><th>Data do exame</th><th>Horário</th><th>Criado em</th><th>Status</th><th>Origem</th><th></th></tr></thead><tbody>' +
        d.items.map(function (r) {
          return '<tr data-id="' + r.id + '"><td class="mono" data-l="Protocolo">' + esc(r.protocol) + '</td>' +
            '<td data-l="Nome"><b>' + esc(r.name) + '</b>' + (r.guardian ? '<span class="sub">Resp.: ' + esc(r.guardian) + '</span>' : '') + '</td>' +
            '<td data-l="Idade">' + r.age + '</td>' +
            '<td data-l="WhatsApp">' + (r.anonymized ? '—' : '<a href="' + wa(r.whatsapp) + '" target="_blank" rel="noopener">' + esc(r.whatsappLabel) + '</a>') + '</td>' +
            '<td class="mono" data-l="Data">' + fmtDate(r.date) + '</td><td class="mono" data-l="Horário">' + esc(r.time) + '</td>' +
            '<td data-l="Criado em">' + esc(r.created.split(' ')[0].split('-').reverse().join('/')) + '<span class="sub">' + esc(r.created.split(' ')[1]) + '</span></td>' +
            '<td data-l="Status"><span class="pill s-' + r.status + '">' + STATUS[r.status] + '</span><div class="quick">' + quickButtons(r) + '</div></td>' +
            '<td data-l="Origem">' + esc(r.origin) + (r.attribution.campaign ? '<span class="sub">' + esc(r.attribution.campaign) + '</span>' : '') + '</td>' +
            '<td><button class="btn small" data-open="' + r.id + '">Detalhes</button></td></tr>';
        }).join('') + '</tbody></table></div>' +
        '<div class="pager">' + (d.page > 1 ? '<button class="btn small" data-page="' + (d.page - 1) + '">Anterior</button>' : '') + '<span>Página ' + d.page + ' de ' + d.pages + '</span>' + (d.page < d.pages ? '<button class="btn small" data-page="' + (d.page + 1) + '">Próxima</button>' : '') + '</div>';
    }).catch(fail);
  }
  function quickButtons(r) {
    var opts = { NOVO: ['CONFIRMADO', 'CONTATADO', 'CANCELADO'], CONFIRMADO: ['COMPARECEU', 'NAO_COMPARECEU', 'CANCELADO'], CONTATADO: ['CONFIRMADO', 'COMPARECEU', 'NAO_COMPARECEU', 'CANCELADO'], COMPARECEU: ['NAO_COMPARECEU'], NAO_COMPARECEU: ['COMPARECEU'], CANCELADO: ['NOVO'] }[r.status] || [];
    var label = { CONFIRMADO: 'Confirmar', CONTATADO: 'Contatado', COMPARECEU: 'Compareceu', NAO_COMPARECEU: 'Faltou', CANCELADO: 'Cancelar', NOVO: 'Reativar' };
    return opts.map(function (s) { return '<button class="btn small' + (s === 'CANCELADO' ? ' danger' : '') + '" data-status="' + s + '" data-id="' + r.id + '">' + label[s] + '</button>'; }).join('');
  }
  function setStatus(id, status, after) {
    if (status === 'CANCELADO' && !confirm('Cancelar este agendamento? A vaga será liberada.')) return;
    api('PATCH', '/api/admin/appointments/' + id, { status: status }).then(function () { toast('Status atualizado: ' + STATUS[status]); after(); }).catch(fail);
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-status]');
    if (b && $('#ap-list') && $('#ap-list').contains(b)) setStatus(b.getAttribute('data-id'), b.getAttribute('data-status'), loadAppointments);
    var o = e.target.closest('[data-open]');
    if (o) openDrawer(lastList.filter(function (r) { return String(r.id) === o.getAttribute('data-open'); })[0]);
    var pg = e.target.closest('[data-page]');
    if (pg) { filters.page = Number(pg.getAttribute('data-page')); loadAppointments(); }
  });

  function closeDrawer() { $$('.drawer, .drawer-bg').forEach(function (x) { x.remove(); }); }
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
      '<section class="panel" id="rules-panel"><h2>CONFIGURAÇÕES DA AGENDA — horário padrão por dia da semana</h2><p class="hint">Ao salvar, os próximos 60 dias são atualizados. Horários que você editou manualmente não mudam, e horários com pacientes nunca são apagados.</p><div id="rules"></div></section>' +
      '<section class="panel"><h2>Exceções por data</h2><p class="hint">Feriados, dias sem atendimento ou horário especial em uma data específica.</p><div id="overrides"></div></section>';
    $('#ag-date').addEventListener('change', function (e) { agendaDate = e.target.value; loadDay(); });
    $$('[data-d]').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = b.getAttribute('data-d');
        agendaDate = v === 'today' ? todayLocal() : addDays(agendaDate, Number(v));
        $('#ag-date').value = agendaDate; loadDay();
      });
    });
    loadDay(); loadRules();
  }
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
    Promise.all([api('GET', '/api/admin/settings'), api('GET', '/api/admin/faq'), api('GET', '/api/admin/legal'), api('GET', '/api/admin/audit')]).then(function (all) {
      var s = all[0].settings, faq = all[1].items, legal = all[2], auditLog = all[3].items;
      var cb = function (name, checked, label) { return '<label class="cbx"><input type="checkbox" name="' + name + '"' + (checked ? ' checked' : '') + '><span>' + label + '</span></label>'; };
      var inp = function (name, label, value, attrs) { return '<label class="f"><span>' + label + '</span><input ' + (attrs || 'type="text"') + ' name="' + name + '" value="' + esc(value == null ? '' : value) + '"></label>'; };
      main().innerHTML = '<div class="page-head"><div><h1>Configurações</h1><p>Tudo o que aparece no site pode ser ajustado aqui.</p></div></div>' +
        '<form class="panel" data-sec="booking"><h2>Agendamento</h2>' +
        cb('enabled', s.booking.enabled, '<b>Agendamentos online abertos</b> — quando desligado, o site não aceita novos agendamentos.') +
        cb('waitlist_enabled', s.booking.waitlist_enabled, 'Oferecer lista de espera quando não houver vagas') +
        '<div class="form-grid">' + inp('scarcity_threshold', 'Mostrar “Últimas vagas” quando restarem até', s.booking.scarcity_threshold, 'type="number" min="0"') +
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

        '<form class="panel" data-sec="social_proof"><h2>Avisos de agendamentos recentes</h2><p class="hint">Mostra no site avisos como “Mariana realizou um agendamento”. Usa somente agendamentos reais de pacientes que autorizaram exibir o primeiro nome. Sem autorizações, nada é exibido.</p>' +
        cb('enabled', s.social_proof.enabled, 'Exibir avisos') + inp('max_age_hours', 'Mostrar agendamentos das últimas (horas)', s.social_proof.max_age_hours, 'type="number" min="1" max="168"') + '<button class="btn primary">Salvar</button></form>' +

        '<form class="panel" data-sec="content"><h2>Seção “Por que cuidar da visão?”</h2>' + inp('vision_title', 'Título', s.content.vision_title) +
        '<label class="f"><span>Parágrafos (um por linha em branco)</span><textarea name="vision_paragraphs" rows="8">' + esc(s.content.vision_paragraphs.join('\n\n')) + '</textarea></label><p class="hint">Use linguagem informativa. Não prometa diagnóstico, cura ou resultados.</p><button class="btn primary" style="margin-top:10px">Salvar</button></form>' +

        '<section class="panel"><h2>Dúvidas frequentes</h2><p class="hint">Perguntas sem resposta não aparecem no site. A pergunta “Onde será realizado o exame?” sem resposta usa automaticamente o endereço cadastrado.</p><div id="faq" style="margin-top:12px">' +
        faq.map(faqItem).join('') + '</div><div class="btn-row"><button class="btn" id="faq-add">Adicionar pergunta</button><button class="btn primary" id="faq-save">Salvar dúvidas</button></div></section>' +

        '<section class="panel"><h2>Privacidade e LGPD</h2><form data-sec="privacy" class="form-grid">' + inp('retention_days', 'Anonimizar dados após (dias)', s.privacy.retention_days, 'type="number" min="30" max="3650"') + '<div style="align-self:end;margin-bottom:12px"><button class="btn primary">Salvar prazo</button></div></form>' +
        '<h3>Política de Privacidade — versão em vigor: ' + esc(legal.current ? legal.current.version : '—') + '</h3><p class="hint">Marcadores disponíveis: {{clinica}}, {{whatsapp}}, {{retencao}}. Linhas com “## ” viram subtítulos e com “- ” viram itens. Publicar cria uma nova versão; os consentimentos registram a versão aceita. Revise o texto com a assessoria jurídica da clínica.</p>' +
        '<textarea id="policy" rows="16" style="margin-top:8px">' + esc(legal.current ? legal.current.body : '') + '</textarea><div class="btn-row" style="margin-top:8px"><button class="btn primary" id="policy-save">Publicar nova versão</button>' + publicLink('/privacidade', 'Ver página') + '</div></section>' +

        '<form class="panel" id="pwf"><h2>Segurança — trocar senha</h2><div class="form-grid">' + inp('current', 'Senha atual', '', 'type="password" autocomplete="current-password"') + inp('next', 'Nova senha (12+ caracteres)', '', 'type="password" autocomplete="new-password"') + '</div><button class="btn primary">Trocar senha</button></form>' +

        '<section class="panel"><h2>Registro de atividades</h2><ul class="list-kv">' + (auditLog.length ? auditLog.slice(0, 40).map(function (a) { return '<li><span>' + esc(a.at) + ' · ' + esc(a.email || '—') + '</span><span>' + esc(a.action) + (a.entity_id ? ' #' + esc(a.entity_id) : '') + '</span></li>'; }).join('') : '<li>Sem registros.</li>') + '</ul></section>';

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
          if (sec === 'meta') body.require_consent = !!body.require_consent;
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

  // ---------- Integrações ----------
  function pageIntegrations() {
    api('GET', '/api/admin/settings').then(function (d) {
      var m = d.settings.meta, env = d.env;
      main().innerHTML = '<div class="page-head"><div><h1>Integrações</h1><p>META ADS — Pixel e API de Conversões.</p></div></div>' +
        '<form class="panel" data-sec="meta"><h2>Meta Pixel</h2>' +
        '<label class="cbx"><input type="checkbox" name="pixel_enabled"' + (m.pixel_enabled ? ' checked' : '') + '><span><b>Ativar Meta Pixel</b></span></label>' +
        '<label class="f" style="max-width:360px"><span>ID do Meta Pixel</span><input type="text" name="pixel_id" inputmode="numeric" value="' + esc(m.pixel_id) + '" placeholder="Somente números"></label>' +
        '<label class="cbx"><input type="checkbox" name="require_consent"' + (m.require_consent ? ' checked' : '') + '><span>Pedir consentimento de cookies antes de ativar o Pixel (recomendado pela LGPD)</span></label>' +
        '<label class="cbx"><input type="checkbox" name="schedule_event"' + (m.schedule_event ? ' checked' : '') + '><span>Enviar também o evento <b>Schedule</b> no agendamento confirmado</span></label>' +
        '<h3>API de Conversões</h3><label class="cbx"><input type="checkbox" name="capi_enabled"' + (m.capi_enabled ? ' checked' : '') + '><span>Enviar o evento <b>Lead</b> também pelo servidor</span></label>' +
        '<p class="hint">Token de acesso no ' + (env.separate ? 'serviço do site público' : 'servidor') + ': ' + (env.capiTokenConfigured ? '<b style="color:var(--green)">configurado</b>' : '<b style="color:var(--red)">não configurado</b> — defina META_CAPI_ACCESS_TOKEN nas variáveis do ' + (env.separate ? 'serviço do site público' : 'servidor') + '.') + (env.testEventCode ? ' · Código de teste ativo.' : '') +
        (env.separate ? (env.seenAt ? ' · Site público iniciado em ' + esc(env.seenAt) + '.' : ' · O site público ainda não se conectou ao banco.') : '') + '</p>' +
        '<button class="btn primary" style="margin-top:12px">Salvar</button></form>' +
        '<section class="panel"><h2>Eventos implementados</h2><ul class="list-kv">' +
        '<li><span><b>PageView</b></span><span>carregamento da página</span></li><li><span><b>ViewContent</b></span><span>visualização da oferta</span></li>' +
        '<li><span><b>StartRegistration</b> (personalizado)</span><span>primeira interação com o formulário</span></li>' +
        '<li><span><b>Lead</b> — conversão principal</span><span>somente após o agendamento ser gravado no banco; mesmo event_id no Pixel e na API de Conversões (deduplicação); uma vez por agendamento</span></li>' +
        '<li><span><b>Contact</b></span><span>clique no botão do WhatsApp</span></li><li><span><b>Schedule</b> (opcional)</span><span>agendamento confirmado</span></li></ul>' +
        '<p class="hint" style="margin-top:10px">Enviados à Meta: WhatsApp e primeiro nome em hash SHA-256, IP, navegador e identificadores de clique. Nunca são enviados idade, informações clínicas ou de saúde.</p></section>' +
        '<section class="panel"><h2>Últimos envios pela API de Conversões</h2>' + (d.metaLog.length ? '<ul class="list-kv">' + d.metaLog.map(function (e) { return '<li><span>' + esc(e.at) + ' · ' + esc(e.event_name) + ' · ' + esc(e.protocol || '') + '</span><span class="pill ' + (e.status === 'sent' ? 's-COMPARECEU' : 's-NAO_COMPARECEU') + '">' + esc(e.status) + '</span></li>'; }).join('') + '</ul>' : '<p class="hint">Nenhum envio ainda.</p>') + '</section>';
      $('form[data-sec=meta]').addEventListener('submit', function (e) {
        e.preventDefault(); var f = e.target;
        api('PUT', '/api/admin/settings/meta', { pixel_enabled: f.pixel_enabled.checked, pixel_id: f.pixel_id.value, require_consent: f.require_consent.checked, schedule_event: f.schedule_event.checked, capi_enabled: f.capi_enabled.checked })
          .then(function () { toast('Integração salva.'); }).catch(fail);
      });
    }).catch(fail);
  }

  // ---------- Início ----------
  api('GET', '/api/admin/me').then(function (d) {
    me = d.admin;
    if (me.mustChangePassword) renderChangePassword(); else route();
  }).catch(function () { /* renderLogin já foi chamado em 401 */ if (!me) renderLogin(); });
})();
