"""
Teste ponta a ponta no navegador (Chromium via Playwright), com os DOIS serviços separados.

Pré-requisitos (banco vazio, FAKE_NOW numa quinta-feira):
  # painel (dono do banco), com senha de acesso extra
  APP_ROLE=admin DATABASE_URL=postgres://dono@.../olhar_e2e FAKE_NOW=2026-10-08T14:00:00Z PORT=3101 \
  ADMIN_EMAIL=admin@e2e.local ADMIN_INITIAL_PASSWORD=SenhaInicial2026 \
  ADMIN_GATE_USER=clinica ADMIN_GATE_PASSWORD=porta-de-acesso-2026 PUBLIC_SITE_URL=http://127.0.0.1:3100 node server.js
  # site público (usuário restrito criado com npm run db:public-user)
  APP_ROLE=public DATABASE_URL=postgres://olhar_site@.../olhar_e2e FAKE_NOW=2026-10-08T14:00:00Z PORT=3100 node server.js

Uso: python3 test/e2e/run_e2e.py [url_site] [url_painel] [pasta_capturas]
"""
import json
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3100"      # site público
ADMIN = sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:3101"     # painel privado
SHOTS = Path(sys.argv[3] if len(sys.argv) > 3 else "e2e-shots")
GATE = {"username": "clinica", "password": "porta-de-acesso-2026"}
SHOTS.mkdir(parents=True, exist_ok=True)
ADMIN_EMAIL = "admin@e2e.local"
INITIAL_PW = "SenhaInicial2026"
NEW_PW = "NovaSenhaForte#2026"

results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail else ""))


def api(ctx, method, path, body=None):
    headers = {"x-olhar-csrf": "1", "accept": "application/json"}
    kw = {"headers": headers}
    if body is not None:
        kw["data"] = json.dumps(body)
        headers["content-type"] = "application/json"
    r = ctx.request.fetch((ADMIN if path.startswith("/api/admin/") else BASE) + path, method=method, **kw)
    try:
        data = r.json()
    except Exception:
        data = r.text()
    return r.status, data


def block_external(page):
    # Sem rede externa no ambiente de teste: o Pixel fica na fila (window.fbq.queue), que é o que verificamos.
    page.route("**/connect.facebook.net/**", lambda r: r.abort())
    page.route("**/fonts.googleapis.com/**", lambda r: r.abort())
    page.route("**/fonts.gstatic.com/**", lambda r: r.abort())


def fbq_events(page):
    return page.evaluate("() => (window.fbq && window.fbq.queue ? window.fbq.queue.map(a => Array.from(a)) : [])")


def wait_step(page, n):
    page.wait_for_selector(f'[data-step="{n}"]:not([hidden])', timeout=4000)
    page.wait_for_timeout(350)


with sync_playwright() as p:
    browser = p.chromium.launch()

    # ------------------------------------------------------------------ Admin: primeiro acesso
    # Separação: o site público não tem painel
    probe = browser.new_context()
    for path in ["/admin", "/api/admin/me", "/assets/admin.js"]:
        r = probe.request.get(BASE + path)
        check(f"Site público: {path} não existe (404)", r.status == 404, str(r.status))
    home_html = probe.request.get(BASE + "/").text().lower()
    check("Site público: nenhum link de login/painel", all(w not in home_html for w in ["/admin", "login", "painel"]))
    r = probe.request.get(ADMIN + "/")
    check("Painel: sem a senha de acesso extra → 401", r.status == 401, str(r.status))
    probe.close()

    admin = browser.new_context(viewport={"width": 1366, "height": 860}, locale="pt-BR", http_credentials=GATE)
    ap = admin.new_page()
    block_external(ap)
    ap.goto(ADMIN + "/")
    ap.wait_for_selector('input[name="email"]')
    ap.screenshot(path=str(SHOTS / "admin-01-login.png"))
    lw = ap.evaluate("() => { const i = document.querySelector('.auth .logo-full'); return i ? i.naturalWidth : 0 }")
    check("Painel: logomarca oficial na tela de login", lw > 0, f"naturalWidth={lw}")
    ap.fill('input[name="email"]', ADMIN_EMAIL)
    ap.fill('input[name="password"]', "senha-errada")
    ap.click('form button.primary')
    ap.wait_for_timeout(500)
    check("Admin: senha errada é recusada", "incorret" in ap.content().lower())
    ap.fill('input[name="password"]', INITIAL_PW)
    ap.click('form button.primary')
    ap.wait_for_selector('input[name="next"]', timeout=5000)
    check("Admin: primeiro acesso exige troca de senha", True)
    ap.fill('input[name="current"]', INITIAL_PW)
    ap.fill('input[name="next"]', NEW_PW)
    ap.fill('input[name="again"]', NEW_PW)
    ap.click('form button.primary')
    ap.wait_for_timeout(1200)

    st, me = api(admin, "GET", "/api/admin/me")
    check("Admin: sessão ativa após trocar a senha", st == 200 and not me["admin"]["mustChangePassword"], str(st))

    # Agenda: seg–sáb 08–12 e 13–16, intervalo 30 min, 3 vagas por horário; domingo fechado.
    rules = []
    for wd in range(7):
        rules.append({
            "weekday": wd, "is_open": wd != 0, "open_time": "08:00", "close_time": "16:00",
            "lunch_start": "12:00", "lunch_end": "13:00", "interval_minutes": 30, "capacity": 3, "daily_limit": None,
        })
    st, _ = api(admin, "PUT", "/api/admin/schedule-rules", {"rules": rules})
    check("Admin: regras da agenda salvas", st == 200, str(st))
    st, cur = api(admin, "GET", "/api/admin/settings")
    s = cur["settings"]
    clinic = dict(s["clinic"], whatsapp="92991234567")
    st1, _ = api(admin, "PUT", "/api/admin/settings/clinic", clinic)
    st2, _ = api(admin, "PUT", "/api/admin/settings/booking", dict(s["booking"], enabled=True))
    st3, _ = api(admin, "PUT", "/api/admin/settings/meta", dict(s["meta"], pixel_enabled=True, pixel_id="123456789012345"))
    st4, _ = api(admin, "PUT", "/api/admin/settings/social_proof", dict(s["social_proof"], enabled=True))
    check("Admin: configurações (WhatsApp, agendamento, Pixel, avisos) salvas", (st1, st2, st3, st4) == (200, 200, 200, 200), str((st1, st2, st3, st4)))

    # ------------------------------------------------------------------ Público: fluxo completo (390px)
    pub = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, locale="pt-BR")
    pg = pub.new_page()
    block_external(pg)
    pg.goto(BASE + "/?utm_source=facebook&utm_medium=paid&utm_campaign=Exame%20Gratis%20Manaus&utm_content=Criativo%2002&utm_term=Publico%2035%2B&fbclid=TESTFBCLID123")
    pg.wait_for_selector('[data-step="1"]')
    pg.wait_for_timeout(300)
    pg.screenshot(path=str(SHOTS / "m-01-primeira-tela.png"))
    seats = pg.inner_text("[data-seats]")
    # Quinta 10h: hoje 11:00–15:30 (8 horários × teto 3 = 24) + sexta (14 × 3 = 42) + sábado (14 × 3 = 42) = 108
    # Sem cota de campanha configurada: mensagem genérica (o total real 108 não vira número de destaque)
    check("Selo compacto: AGENDAMENTOS ABERTOS · VAGAS DISPONÍVEIS (sem cota → mensagem genérica)", "AGENDAMENTOS ABERTOS" in seats and "VAGAS DISPONÍVEIS" in seats and "108" not in seats, seats.replace("\n", " "))
    check("Selo: ponto verde pulsante", pg.evaluate("() => getComputedStyle(document.querySelector('.seats-dot.is-live'), '::after').animationName") == "pulse")
    check("Chamada dinâmica: escolha seu horário para hoje, amanhã ou sábado", "escolha seu horário para hoje, amanhã ou sábado" in pg.inner_text("[data-lede]"), pg.inner_text("[data-lede]"))
    title_visible = pg.locator(".chart-2").bounding_box()
    name_box = pg.locator('input[name="name"]').bounding_box()
    check("Mobile: oferta e início do formulário na primeira tela", name_box and name_box["y"] + name_box["height"] < 844 * 1.35, f"campo nome y={name_box and round(name_box['y'])}")

    # Consentimento de cookies → Pixel carrega
    if pg.is_visible("[data-cookie]"):
        pg.screenshot(path=str(SHOTS / "m-01b-cookies.png"))
        pg.click("[data-cookie-yes]")
    pg.wait_for_timeout(200)
    ev = [e[1] for e in fbq_events(pg) if e[0] == "track"]
    check("Pixel: PageView e ViewContent após consentimento", "PageView" in ev and "ViewContent" in ev, str(ev))

    # Etapa 1 — nome
    pg.click('[data-step="1"] [data-next]')
    pg.wait_for_timeout(200)
    err = pg.inner_text('[data-error="name"]')
    check("Validação do nome vazio", len(err) > 0, err)
    pg.fill('input[name="name"]', "Maria 123")
    pg.click('[data-step="1"] [data-next]')
    pg.wait_for_timeout(200)
    check("Validação do nome com números", len(pg.inner_text('[data-error="name"]')) > 0)
    pg.fill('input[name="name"]', "Mariana Conceição")
    pg.click('[data-step="1"] [data-next]')
    wait_step(pg, 2)
    custom = [e for e in fbq_events(pg) if e[0] == "trackCustom" and e[1] == "StartRegistration"]
    check("Pixel: StartRegistration (personalizado) ao iniciar", len(custom) == 1, str(len(custom)))
    check("Indicador 'Etapa 2 de 5'", "2 de 5" in pg.inner_text("[data-step-count]"))
    tclock = pg.inner_text("[data-timer-clock]")
    check("Cronômetro aparece ao iniciar o cadastro (perto da barra de progresso)", pg.is_visible("[data-timer]") and (tclock.startswith("09:") or tclock == "10:00"), tclock)
    inputmode = pg.get_attribute('input[name="age"]', "inputmode")
    check("Idade abre teclado numérico", inputmode == "numeric")

    # Etapa 2 — idade
    pg.fill('input[name="age"]', "180")
    pg.click('[data-step="2"] [data-next]')
    pg.wait_for_timeout(200)
    check("Validação de idade implausível", len(pg.inner_text('[data-error="age"]')) > 0, pg.inner_text('[data-error="age"]'))
    pg.fill('input[name="age"]', "15")
    pg.wait_for_timeout(150)
    check("Menor de idade pede responsável", pg.is_visible("[data-guardian]"))
    pg.fill('input[name="age"]', "42")
    pg.wait_for_timeout(150)
    pg.screenshot(path=str(SHOTS / "m-02-idade.png"))
    pg.click('[data-step="2"] [data-next]')
    wait_step(pg, 3)

    # Etapa 3 — WhatsApp
    pg.fill('input[name="whatsapp"]', "9299")
    pg.click('[data-step="3"] [data-next]')
    pg.wait_for_timeout(200)
    check("Validação de WhatsApp incompleto", len(pg.inner_text('[data-error="whatsapp"]')) > 0)
    pg.fill('input[name="whatsapp"]', "")
    pg.type('input[name="whatsapp"]', "92988887777", delay=10)
    masked = pg.input_value('input[name="whatsapp"]')
    check("Máscara brasileira no WhatsApp", masked == "(92) 98888-7777", masked)
    pg.click('[data-step="3"] [data-next]')
    pg.wait_for_timeout(200)
    check("Consentimento obrigatório para tratar dados", len(pg.inner_text('[data-error="consent_data"]')) > 0)
    pg.check('input[name="consent_data"]')
    pg.check('input[name="consent_social"]')
    pg.screenshot(path=str(SHOTS / "m-03-whatsapp.png"))
    lead_before = [e for e in fbq_events(pg) if e[1] == "Lead"]
    pg.click('[data-step="3"] [data-next]')
    wait_step(pg, 4)

    # Etapa 4 — datas
    check("Etapa 4: chamada ESCOLHA O MELHOR DIA PARA SEU EXAME", "ESCOLHA O MELHOR DIA PARA SEU EXAME" in pg.inner_text("#t4"))
    on_days = pg.locator(".calendar .cal-day.is-on")
    on_list = [on_days.nth(i).get_attribute("data-date") for i in range(on_days.count())]
    check("Calendário: só hoje (08), amanhã (09) e sábado (10) clicáveis", on_list == ["2026-10-08", "2026-10-09", "2026-10-10"], str(on_list))
    off = pg.locator(".calendar span.cal-day.is-off")
    check("Calendário: demais dias visíveis e desabilitados", off.count() >= 25, str(off.count()))
    check("Calendário: hoje com indicador", pg.locator('.cal-day.is-today[data-date="2026-10-08"]').count() == 1)
    wd = pg.inner_text(".cal-wd")
    check("Calendário: cabeçalho DOM…SÁB", all(x in wd for x in ["DOM", "SEG", "TER", "QUA", "QUI", "SEX", "SÁB"]))
    check("Destaque EXAME AINDA HOJE visível", pg.is_visible("[data-today]") and "EXAME AINDA HOJE" in pg.inner_text("[data-today]"))
    slots_today = pg.inner_text("[data-today-slots]").replace("\n", " ")
    check("VAGAS PARA HOJE: próximos horários com vagas reais (11:00, 11:30, 13:00 — 3 vagas)", all(x in slots_today for x in ["11:00", "11:30", "13:00", "3 vagas"]), slots_today)
    sw = pg.evaluate("() => document.documentElement.scrollWidth")
    check("Calendário sem rolagem horizontal no celular", sw <= 390, f"scrollWidth={sw}")
    pg.screenshot(path=str(SHOTS / "m-04-calendario.png"))
    pg.locator(".calendar").scroll_into_view_if_needed()
    pg.screenshot(path=str(SHOTS / "m-04b-calendario-grade.png"))
    # "VER HORÁRIOS DE HOJE" seleciona hoje e mostra os horários elegíveis
    pg.click("[data-today-go]")
    wait_step(pg, 5)
    t_first = pg.locator("[data-times] [data-time]").first
    check("Hoje: primeiro horário 11:00 (antecedência 1h) com contagem de vagas", t_first.get_attribute("data-time") == "11:00" and "3 vagas" in t_first.inner_text(), t_first.inner_text().replace("\n", " "))
    check("Hoje: aviso de antecedência mínima", pg.is_visible("[data-lead-note]"))
    pg.screenshot(path=str(SHOTS / "m-05a-horarios-hoje.png"))
    pg.click('[data-step="5"] [data-back]')
    wait_step(pg, 4)
    # Seleciona a sexta pela grade: carrega os horários automaticamente
    pg.click('.cal-day.is-on[data-date="2026-10-09"]')
    wait_step(pg, 5)

    # Etapa 5 — horários
    check("Indicador 'Etapa 5 de 5'", "5 de 5" in pg.inner_text("[data-step-count]"))
    times = pg.locator("[data-times] [data-time]")
    check("Sexta: 14 horários (08–12 e 13–16)", times.count() == 14, str(times.count()))
    pg.screenshot(path=str(SHOTS / "m-05-horarios.png"), full_page=False)
    pg.locator('[data-time="09:30"]').click()
    pg.wait_for_timeout(300)
    check("Resumo antes de confirmar", pg.is_visible("[data-summary]") and "Mariana" in pg.inner_text("[data-summary]"))
    check("Lead NÃO dispara ao escolher horário", len([e for e in fbq_events(pg) if e[1] == "Lead"]) == 0 and len(lead_before) == 0)
    pg.locator("[data-confirm]").scroll_into_view_if_needed()
    pg.screenshot(path=str(SHOTS / "m-05b-resumo.png"))
    pg.click("[data-confirm]")
    pg.wait_for_selector("[data-done]:not([hidden])", timeout=6000)
    pg.wait_for_timeout(700)
    protocol = pg.inner_text('[data-t="protocol"]')
    check("Confirmação com protocolo OLH-", protocol.startswith("OLH-"), protocol)
    ticket = pg.inner_text(".ticket")
    check("Cartão de confirmação com nome, idade, data, horário, WhatsApp", all(x in ticket for x in ["Mariana Conceição", "42", "09 de outubro", "09:30", "(92) 98888-7777"]), ticket.replace("\n", " | "))
    pg.screenshot(path=str(SHOTS / "m-06-confirmacao.png"))
    leads = [e for e in fbq_events(pg) if e[1] == "Lead"]
    check("Lead dispara uma vez, com eventID", len(leads) == 1 and len(leads[0]) == 4 and leads[0][3].get("eventID"), str(leads))
    wa_href = pg.get_attribute("[data-wa-confirm]", "href")
    check("Botão WhatsApp com número da clínica e protocolo", "5592991234567" in wa_href and protocol in wa_href.replace("%2D", "-"), wa_href[:120])

    # Recarregar não duplica o Lead
    pg.reload()
    pg.wait_for_timeout(800)
    leads2 = [e for e in fbq_events(pg) if e[1] == "Lead"]
    check("Recarregar a página não duplica o Lead", len(leads2) == 0, str(len(leads2)))

    # Vagas atualizadas
    st, av = api(pub, "GET", "/api/availability")
    check("Contador atualizado após reserva (108 → 107)", av["total"] == 107, str(av["total"]))
    st, ag = api(admin, "GET", "/api/admin/agenda?date=2026-10-09")
    slot = [x for x in ag["slots"] if x["time"] == "09:30"][0]
    check("Agenda do painel: 09:30 com 1/3 ocupada", len(slot["patients"]) == 1 and slot["capacity"] == 3, json.dumps({k: slot[k] for k in slot if k != "patients"}))

    # ------------------------------------------------------------------ Lotar um horário e ver 'Esgotado'
    booker = browser.new_context()
    def book(ctx, name, phone, date, time_):
        return api(ctx, "POST", "/api/bookings", {
            "name": name, "age": 30, "whatsapp": phone, "date": date, "time": time_,
            "consent_data": True, "elapsed_ms": 9000, "website": "", "idempotency_key": f"k-{phone}-{date}-{time_}",
        })

    # Usa contextos novos (rate limit é por IP, então espaçamos o suficiente)
    st_a, _ = book(booker, "Joana Prado", "92977776661", "2026-10-09", "09:30")
    st_b, _ = book(booker, "Carlos Lima", "92977776662", "2026-10-09", "09:30")
    st_c, resp_c = book(booker, "Pedro Alves", "92977776663", "2026-10-09", "09:30")
    check("Horário lotado recusa a 4ª reserva no servidor", st_a == 201 or st_a == 200, f"{st_a},{st_b},{st_c}")
    check("Servidor responde 409 quando o horário esgota", st_c == 409, f"{st_c} {resp_c}")

    pg2ctx = browser.new_context(viewport={"width": 375, "height": 812}, is_mobile=True, has_touch=True, locale="pt-BR")
    pg2 = pg2ctx.new_page()
    block_external(pg2)
    pg2.goto(BASE + "/")
    pg2.fill('input[name="name"]', "José Antônio")
    pg2.click('[data-step="1"] [data-next]'); wait_step(pg2, 2)
    pg2.fill('input[name="age"]', "67")
    pg2.click('[data-step="2"] [data-next]'); wait_step(pg2, 3)
    pg2.type('input[name="whatsapp"]', "92981112222", delay=5)
    pg2.check('input[name="consent_data"]')
    pg2.click('[data-step="3"] [data-next]'); wait_step(pg2, 4)
    pg2.click('.day-chip[data-date="2026-10-09"]'); wait_step(pg2, 5)
    full = pg2.locator('[data-times] button.time', has_text='09:30')
    check("Horário lotado aparece como 'Esgotado' e desabilitado", full.is_disabled() and "Esgotado" in full.inner_text(), full.inner_text())
    full.scroll_into_view_if_needed()
    pg2.screenshot(path=str(SHOTS / "m-07-esgotado.png"))

    # Atualização automática: visitante escolheu 10:00; o painel bloqueia esse horário; a página se atualiza sozinha
    pg2.locator('[data-time="10:00"]').click()
    pg2.wait_for_timeout(200)
    st, ag2 = api(admin, "GET", "/api/admin/agenda?date=2026-10-09")
    sid = [x for x in ag2["slots"] if x["time"] == "10:00"][0]["id"]
    api(admin, "PATCH", f"/api/admin/slots/{sid}", {"blocked": True})
    pg2.evaluate("() => document.dispatchEvent(new Event('visibilitychange'))")
    pg2.wait_for_timeout(1200)
    err = pg2.inner_text("[data-form-error]") if pg2.is_visible("[data-form-error]") else ""
    still = pg2.locator('[data-time="10:00"]').count()
    check("Atualização automática: horário que deixou de existir é removido e o aviso aparece", still == 0 and "não está mais disponível" in err, f"{still} | {err}")
    check("Atualização automática: dados preenchidos mantidos", pg2.input_value('input[name="name"]') == "José Antônio")
    api(admin, "PATCH", f"/api/admin/slots/{sid}", {"blocked": False})

    # Avisos discretos (somente autorizados): Mariana autorizou
    st, act = api(pg2ctx, "GET", "/api/activity")
    names = [a.get("firstName") for a in act.get("items", [])]
    check("Avisos de atividade: só quem autorizou (Mariana sim; Joana/Carlos não)", names == ["Mariana"], str(act)[:200])

    # ------------------------------------------------------------------ Responsividade
    # Marca oficial no site
    bc = browser.new_context(viewport={"width": 390, "height": 844}, locale="pt-BR")
    bp = bc.new_page(); block_external(bp); bp.goto(BASE + "/"); bp.wait_for_timeout(400)
    info = bp.evaluate("""() => ({
      header: (document.querySelector('.top .brand-logo') || {}).currentSrc || '',
      headerOk: (document.querySelector('.top .brand-logo') || {}).naturalWidth > 0,
      footerOk: (document.querySelector('.foot .brand-full') || {}).naturalWidth > 0,
      favicon: [...document.querySelectorAll('link[rel~=icon], link[rel=apple-touch-icon], link[rel=manifest]')].map(l => l.getAttribute('href')),
      headerBg: getComputedStyle(document.querySelector('.top')).backgroundColor,
    })""")
    check("Marca: logomarca oficial no cabeçalho (sobre marinho) e no rodapé", "/brand/logo-assinatura.png" in info["header"] and info["headerOk"] and info["footerOk"] and info["headerBg"] == "rgb(19, 24, 66)", json.dumps(info)[:200])
    statuses = {}
    for path in ["/favicon.ico", "/brand/favicon-32.png", "/brand/apple-touch-icon.png", "/brand/icon-192.png", "/brand/icon-512.png", "/manifest.webmanifest", "/assets/deco-arcos.svg", "/assets/deco-linhas.svg"]:
        statuses[path] = bc.request.get(BASE + path).status
    check("Marca: favicon, ícones de atalho, manifest e elementos gráficos publicados", all(v == 200 for v in statuses.values()) and len(info["favicon"]) >= 4, json.dumps(statuses))
    check("Marca: logomarca provisória removida", bc.request.get(BASE + "/favicon.svg").status == 404 and "<svg class=\"mark\"" not in bp.content())
    bc.close()

    # ------------------------------------------------------------------ Cabeçalho: logomarca centralizada e +10px até a linha
    for w in [320, 360, 375, 390, 430, 1440]:
        c = browser.new_context(viewport={"width": w, "height": 800 if w < 768 else 900}, locale="pt-BR", reduced_motion="reduce")
        hp = c.new_page(); block_external(hp); hp.goto(BASE + "/"); hp.wait_for_timeout(200)
        g = hp.evaluate("""() => { const l = document.querySelector('.top .brand-logo').getBoundingClientRect(), t = document.querySelector('.top').getBoundingClientRect();
          return { left: l.left, right: innerWidth - l.right, top: l.top - t.top, gap: (t.bottom - 4) - l.bottom, h: t.height, lh: l.height } }""")
        expect_gap = 16 if w < 1024 else 18  # antes: 6 px (celular) / 8 px (desktop)
        check(f"Cabeçalho {w}px: logomarca centralizada e linha ~10 px mais baixa", abs(g["left"] - g["right"]) <= 1.5 and abs(g["gap"] - expect_gap) <= 1 and abs(g["top"] - (10 if w < 1024 else 12)) <= 1, json.dumps({k: round(v, 1) for k, v in g.items()}))
        if w in (390, 1440):
            hp.screenshot(path=str(SHOTS / f"cabecalho-{w}.png"), clip={"x": 0, "y": 0, "width": w, "height": 140})
        c.close()

    # ------------------------------------------------------------------ Animações de entrada (300–600 ms) e movimento reduzido
    c = browser.new_context(viewport={"width": 390, "height": 844}, locale="pt-BR")
    ep = c.new_page(); block_external(ep); ep.goto(BASE + "/")
    anim = ep.evaluate("""() => Object.fromEntries([['logo', '.top .brand-logo'], ['titulo', '.hero .chart'], ['selo', '.hero .seats'], ['form', '.hero .card']].map(([k, sel]) => {
      const cs = getComputedStyle(document.querySelector(sel)); return [k, { name: cs.animationName, ms: parseFloat(cs.animationDuration) * 1000, delay: parseFloat(cs.animationDelay) * 1000 }] }))""")
    ok = anim["logo"]["name"] == "fadeIn" and anim["titulo"]["name"] == "fadeUp" and anim["selo"]["delay"] > anim["titulo"]["delay"] and all(300 <= a["ms"] <= 600 for a in anim.values()) and anim["form"]["delay"] <= 100
    check("Entrada: logo (fade), título (sobe), selo depois do título, formulário rápido — 300 a 600 ms", ok, json.dumps(anim))
    c.close()
    c = browser.new_context(viewport={"width": 390, "height": 844}, locale="pt-BR", reduced_motion="reduce")
    ep = c.new_page(); block_external(ep); ep.goto(BASE + "/"); ep.wait_for_timeout(60)
    op = ep.evaluate("() => ['.hero .chart', '.hero .seats', '.hero .card'].map(s => getComputedStyle(document.querySelector(s)).opacity)")
    check("Movimento reduzido: conteúdo visível na hora, sem animação", all(o == "1" for o in op), str(op))
    c.close()

    # ------------------------------------------------------------------ Cronômetro: cores por faixa, último minuto e fim sem perder dados
    c = browser.new_context(viewport={"width": 375, "height": 760}, locale="pt-BR")
    tp = c.new_page(); block_external(tp); tp.goto(BASE + "/")
    def timer_at(left):
        tp.evaluate(f"() => sessionStorage.setItem('olhar_timer_v1', String(Date.now() - {(600 - left) * 1000}))")
        tp.reload(); tp.wait_for_selector("[data-timer]:not([hidden])", timeout=3000); tp.wait_for_timeout(150)
        return tp.evaluate("() => ({ cls: document.querySelector('[data-timer]').className, clock: document.querySelector('[data-timer-clock]').textContent, msg: document.querySelector('[data-timer-msg]').hidden ? '' : document.querySelector('[data-timer-msg]').textContent, color: getComputedStyle(document.querySelector('[data-timer-clock]')).color })")
    phases = {n: timer_at(n) for n in (420, 200, 90, 45)}
    check("Cronômetro 10:00–05:00 azul institucional", phases[420]["cls"] == "timer" and phases[420]["clock"][:3] in ("06:", "07:"), json.dumps(phases[420]))
    check("Cronômetro 04:59–02:00 azul mais intenso", "is-deep" in phases[200]["cls"], json.dumps(phases[200]))
    check("Cronômetro 01:59–01:01 laranja", "is-warn" in phases[90]["cls"] and phases[90]["msg"] == "", json.dumps(phases[90]))
    check("Cronômetro último minuto: vermelho + aviso", "is-crit" in phases[45]["cls"] and phases[45]["msg"] == "Falta menos de 1 minuto para concluir sua reserva." and phases[45]["color"] == "rgb(180, 35, 24)", json.dumps(phases[45]))
    tp.screenshot(path=str(SHOTS / "m-cronometro-ultimo-minuto.png"))
    timer_at(2)
    tp.fill('input[name="name"]', "Teste Cronômetro")
    tp.wait_for_timeout(2600)
    end = tp.evaluate("() => ({ cls: document.querySelector('[data-timer]').className, msg: document.querySelector('[data-timer-msg]').textContent, name: document.querySelector('input[name=name]').value, step: !document.querySelector('[data-step=\"1\"]').hidden })")
    check("Cronômetro zerado: atualiza disponibilidade, mantém os dados e não diz que a vaga foi perdida", "is-over" in end["cls"] and end["name"] == "Teste Cronômetro" and end["step"] and "perd" not in end["msg"].lower() and "mantidos" in end["msg"], json.dumps(end, ensure_ascii=False))
    tb = tp.locator("[data-timer]").bounding_box(); nb = tp.locator('input[name="name"]').bounding_box()
    check("Cronômetro não cobre campos", tb["y"] + tb["height"] <= nb["y"], f"{tb} {nb}")
    c.close()

    # ------------------------------------------------------------------ Pop-ups pequenos no canto (somente reais)
    c = browser.new_context(viewport={"width": 1366, "height": 860}, locale="pt-BR")
    dp = c.new_page(); block_external(dp); dp.goto(BASE + "/")
    dp.evaluate("() => { try { localStorage.setItem('olhar_ads_consent', 'denied') } catch (e) {} }"); dp.reload()
    dp.wait_for_selector(".toast.show", timeout=16000); dp.wait_for_timeout(400)
    tb = dp.evaluate("() => { const r = document.querySelector('.toast').getBoundingClientRect(); return { left: r.left, bottom: innerHeight - r.bottom, width: r.width, text: document.querySelector('.toast').innerText } }")
    check("Pop-up desktop: canto inferior esquerdo (20 px), até 280 px, texto real", abs(tb["left"] - 20) <= 1 and abs(tb["bottom"] - 20) <= 1 and tb["width"] <= 280 and "Mariana agendou seu exame" in tb["text"], json.dumps(tb, ensure_ascii=False))
    dp.screenshot(path=str(SHOTS / "d-popup.png"))
    gone = dp.wait_for_selector(".toast", state="hidden", timeout=6000)
    check("Pop-up some sozinho (~4 s) e só um por vez", dp.locator(".toast").count() == 1)
    c.close()

    c = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, locale="pt-BR")
    mp = c.new_page(); block_external(mp); mp.goto(BASE + "/")
    mp.evaluate("() => { try { localStorage.setItem('olhar_ads_consent', 'denied') } catch (e) {} }"); mp.reload()
    bad, seen = [], 0
    for i in range(30):
        if i == 12:
            mp.evaluate("() => document.querySelector('.why').scrollIntoView()")  # área só de texto (sem controles)
        r = mp.evaluate("""() => { const t = document.querySelector('.toast'); if (t.hidden || !t.classList.contains('show')) return null;
          const a = t.getBoundingClientRect();
          const hit = [...document.querySelectorAll('input, button, a.btn, .calendar, .time-grid, .today-box')].filter(el => { const b = el.getBoundingClientRect(); return b.width && b.height && b.left < a.right && b.right > a.left && b.top < a.bottom && b.bottom > a.top });
          return { w: a.width, hit: hit.map(h => h.className || h.tagName).slice(0, 3) } }""")
        if r:
            seen += 1
            if r["hit"]: bad.append(r)
        mp.wait_for_timeout(700)
    check("Pop-up celular: nunca cobre campos, calendário, horários ou botões", not bad, json.dumps(bad)[:200])
    check("Pop-up celular: aparece só em área livre (adiado sobre o formulário)", seen > 0, f"amostras visíveis={seen}")
    mp.evaluate("() => document.body.classList.add('kb-open')")
    check("Pop-up oculto com o teclado aberto", mp.evaluate("() => getComputedStyle(document.querySelector('.toast')).display") == "none")
    c.close()

    for w in [320, 360, 375, 390, 414, 430, 768, 1280, 1440]:
        c = browser.new_context(viewport={"width": w, "height": 800 if w < 768 else 900}, locale="pt-BR")
        pp = c.new_page()
        block_external(pp)
        pp.goto(BASE + "/")
        pp.wait_for_timeout(300)
        sw = pp.evaluate("() => document.documentElement.scrollWidth")
        check(f"{w}px: sem rolagem horizontal", sw <= w, f"scrollWidth={sw}")
        pp.screenshot(path=str(SHOTS / f"w{w}-topo.png"))
        if w in (360, 1440):
            pp.screenshot(path=str(SHOTS / f"w{w}-pagina-inteira.png"), full_page=True)
        c.close()

    # ------------------------------------------------------------------ Admin: dashboard, lista, agenda
    ap.goto(ADMIN + "/")
    ap.wait_for_timeout(1200)
    ap.screenshot(path=str(SHOTS / "admin-02-dashboard.png"), full_page=True)
    href = ap.get_attribute("a:has-text('Ver site')", "href")
    check("Painel: 'Ver site' aponta para o domínio público", href == BASE + "/", str(href))
    st, dash = api(admin, "GET", "/api/admin/dashboard")
    check("Dashboard: agendamento aparece nos totais", st == 200 and json.dumps(dash).find('"total"') >= 0, json.dumps(dash)[:220])
    st, lst = api(admin, "GET", "/api/admin/appointments?q=" + protocol)
    row = (lst.get("rows") or lst.get("items") or [None])[0] if isinstance(lst, dict) else None
    check("Lista: busca por protocolo encontra o agendamento", row and row["protocol"] == protocol)
    check("Lista: origem do anúncio registrada (UTMs + fbclid)", row and "facebook" in json.dumps(row).lower() and "Exame Gratis Manaus" in json.dumps(row), json.dumps(row.get("attribution") if row else {})[:200])

    st, cfg = api(admin, "GET", "/api/admin/settings")
    check("Painel enxerga o estado do site público (serviço separado)", cfg["env"]["separate"] and cfg["env"]["seenAt"], json.dumps(cfg["env"]))

    # Telas do painel
    for hash_, name in [("#/agendamentos", "admin-03-agendamentos"), ("#/agenda", "admin-04-agenda"), ("#/configuracoes", "admin-05-configuracoes"), ("#/integracoes", "admin-06-integracoes")]:
        ap.goto(ADMIN + "/" + hash_)
        ap.wait_for_timeout(1000)
        ap.screenshot(path=str(SHOTS / f"{name}.png"), full_page=True)

    # Cancelamento libera a vaga
    st, _ = api(admin, "PATCH", f"/api/admin/appointments/{row['id']}", {"status": "CANCELADO"})
    st2, av2 = api(pub, "GET", "/api/availability")
    fri2 = [d for d in av2["dates"] if d["date"] == "2026-10-09"][0]
    slot2 = [t for t in fri2["times"] if t["time"] == "09:30"][0]
    check("Cancelamento libera a vaga (09:30 volta a ficar disponível no site)", st == 200 and slot2["available"] is True, f"{st} {slot2}")

    # CSV
    r = admin.request.get(ADMIN + "/api/admin/appointments.csv?period=all", headers={"x-olhar-csrf": "1"})
    check("Exportação CSV", r.status == 200 and "Protocolo" in r.text() and protocol in r.text(), str(r.status))

    # Admin mobile
    am = browser.new_context(viewport={"width": 390, "height": 844}, locale="pt-BR", storage_state=admin.storage_state(), http_credentials=GATE)
    amp = am.new_page()
    block_external(amp)
    amp.goto(ADMIN + "/#/agendamentos")
    amp.wait_for_timeout(1200)
    sw = amp.evaluate("() => document.documentElement.scrollWidth")
    check("Painel no celular sem rolagem horizontal", sw <= 390, f"scrollWidth={sw}")
    amp.screenshot(path=str(SHOTS / "admin-07-mobile.png"), full_page=True)
    # Menu lateral recolhível
    x0 = amp.evaluate("() => document.getElementById('side').getBoundingClientRect().right")
    check("Painel celular: menu recolhido por padrão", x0 <= 0, f"right={x0}")
    amp.click("#menu-open"); amp.wait_for_timeout(400)
    x1 = amp.evaluate("() => document.getElementById('side').getBoundingClientRect().left")
    check("Painel celular: botão abre o menu lateral", x1 >= 0 and amp.is_visible("#side-bg"), f"left={x1}")
    amp.screenshot(path=str(SHOTS / "admin-08-mobile-menu.png"))
    amp.click("#side .nav a[href='#/agenda']"); amp.wait_for_timeout(1000)
    x2 = amp.evaluate("() => document.getElementById('side').getBoundingClientRect().right")
    check("Painel celular: escolher uma página fecha o menu e navega", x2 <= 0 and "Agenda" in amp.inner_text(".mbar-title"), f"right={x2}")
    sw2 = amp.evaluate("() => document.documentElement.scrollWidth")
    check("Painel celular: agenda sem rolagem horizontal", sw2 <= 390, f"scrollWidth={sw2}")
    amp.screenshot(path=str(SHOTS / "admin-09-mobile-agenda.png"), full_page=True)
    amp.goto(ADMIN + "/#/painel"); amp.wait_for_timeout(1000)
    amp.screenshot(path=str(SHOTS / "admin-10-mobile-dashboard.png"), full_page=True)
    amp.goto(ADMIN + "/#/configuracoes"); amp.wait_for_timeout(1000)
    sw3 = amp.evaluate("() => document.documentElement.scrollWidth")
    check("Painel celular: configurações sem campos cortados", sw3 <= 390, f"scrollWidth={sw3}")
    amp.screenshot(path=str(SHOTS / "admin-11-mobile-config.png"), full_page=True)

    # ------------------------------------------------------------------ Sem vagas: bloquear as duas datas
    for d in ["2026-10-08", "2026-10-09", "2026-10-10"]:
        api(admin, "PUT", f"/api/admin/date-overrides/{d}", {"is_blocked": True, "reason": "Teste sem vagas"})
    nc = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, locale="pt-BR")
    npg = nc.new_page()
    block_external(npg)
    npg.goto(BASE + "/")
    npg.wait_for_timeout(300)
    check("Sem vagas: selo 'TODAS AS VAGAS FORAM PREENCHIDAS'", "TODAS AS VAGAS FORAM PREENCHIDAS" in npg.inner_text("[data-seats]"))
    npg.screenshot(path=str(SHOTS / "m-08-sem-vagas-topo.png"))
    npg.fill('input[name="name"]', "Ana Beatriz")
    npg.click('[data-step="1"] [data-next]'); wait_step(npg, 2)
    npg.fill('input[name="age"]', "35")
    npg.click('[data-step="2"] [data-next]'); wait_step(npg, 3)
    npg.type('input[name="whatsapp"]', "92985554444", delay=5)
    npg.check('input[name="consent_data"]')
    npg.click('[data-step="3"] [data-next]')
    npg.wait_for_selector('[data-step="waitlist"]:not([hidden])', timeout=4000)
    npg.wait_for_timeout(300)
    npg.screenshot(path=str(SHOTS / "m-09-lista-espera.png"))
    npg.click("[data-waitlist-join]")
    npg.wait_for_selector("[data-waitlist-done]:not([hidden])", timeout=4000)
    check("Sem vagas: lista de espera sem confirmar agendamento", npg.is_visible("[data-waitlist-done]") and not npg.is_visible("[data-done]"))
    npg.screenshot(path=str(SHOTS / "m-10-lista-espera-ok.png"))
    st, wl = api(admin, "GET", "/api/admin/waitlist")
    check("Lista de espera aparece no painel", "Ana Beatriz" in json.dumps(wl, ensure_ascii=False))

    browser.close()

passed = sum(1 for r in results if r[1])
print(f"\n{passed}/{len(results)} verificações passaram")
(SHOTS / "results.json").write_text(json.dumps([{"name": n, "ok": ok, "detail": d} for n, ok, d in results], ensure_ascii=False, indent=2))
sys.exit(0 if passed == len(results) else 1)
