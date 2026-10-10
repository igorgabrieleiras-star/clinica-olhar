"""
Teste ponta a ponta no navegador (Chromium via Playwright), com os DOIS serviços separados.

Pré-requisitos (banco vazio, FAKE_NOW numa quinta-feira):
  # painel (dono do banco), com senha de acesso extra
  APP_ROLE=admin DATABASE_URL=postgres://dono@.../olhar_e2e FAKE_NOW=2026-10-08T14:00:00Z PORT=3101 \
  ADMIN_EMAIL=admin@e2e.local ADMIN_INITIAL_PASSWORD=SenhaInicial2026 \
  PUBLIC_SITE_URL=http://127.0.0.1:3100 node server.js   (sem senha extra: login individual por e-mail e senha)
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
INTEGR_PW = "SenhaDasIntegracoes#2026"
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
    check("Painel: abre direto na tela de login (sem senha extra compartilhada)", r.status == 200 and not r.headers.get("www-authenticate"), str(r.status))
    r = probe.request.get(ADMIN + "/api/admin/appointments")
    check("Painel: dados bloqueados sem login (401)", r.status == 401, str(r.status))
    probe.close()

    admin = browser.new_context(viewport={"width": 1366, "height": 860}, locale="pt-BR", )
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
    # Integrações: senha exclusiva criada no primeiro acesso (a sessão que cria fica desbloqueada)
    stI, setup = api(admin, "POST", "/api/admin/integrations/setup", {"password": INTEGR_PW, "confirm": INTEGR_PW})
    check("Integrações: senha exclusiva criada no primeiro acesso (com código de recuperação)", stI == 201 and len(setup.get("recoveryCode", "")) == 23, str(stI))
    RECOVERY = setup.get("recoveryCode")
    _, integ = api(admin, "GET", "/api/admin/integrations")
    st3, _ = api(admin, "PUT", "/api/admin/settings/meta", dict(integ["meta"], pixel_enabled=True, pixel_id="123456789012345"))
    st_name, _ = api(admin, "PATCH", "/api/admin/me", {"name": "Igor Gabriel"})
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
    names = [a.get("firstName") for a in act.get("items", []) if a.get("kind") != "info"]
    check("Pop-ups: mensagens institucionais sem pacientes", all(not a.get("firstName") for a in act.get("items", []) if a.get("kind") == "info") and any(a.get("kind") == "info" for a in act.get("items", [])))
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

    st, cfg = api(admin, "GET", "/api/admin/integrations")
    check("Painel enxerga o estado do site público (serviço separado)", cfg["env"]["separate"] and cfg["env"]["seenAt"], json.dumps(cfg["env"]))
    st, cfg2 = api(admin, "GET", "/api/admin/settings")
    check("Configurações gerais não expõem Pixel/API de Conversões", "meta" not in cfg2["settings"] and "env" not in cfg2, ",".join(cfg2["settings"].keys()))

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
    am = browser.new_context(viewport={"width": 390, "height": 844}, locale="pt-BR", storage_state=admin.storage_state())
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

    # ------------------------------------------------------------------ Saudação pelo horário de Manaus
    gctx = browser.new_context(viewport={"width": 1280, "height": 800}, locale="pt-BR", storage_state=admin.storage_state())
    gp = gctx.new_page(); block_external(gp)
    for utc, expect in [("2026-10-09T13:00:00Z", "Bom dia, Igor!"), ("2026-10-09T18:30:00Z", "Boa tarde, Igor!"), ("2026-10-09T23:10:00Z", "Boa noite, Igor!"), ("2026-10-09T08:30:00Z", "Boa noite, Igor!")]:
        gp.close(); gp = gctx.new_page(); block_external(gp)
        gp.clock.set_fixed_time(utc)
        gp.goto(ADMIN + "/#/painel"); gp.wait_for_selector("#greet:not(:empty)", timeout=5000)
        g = gp.inner_text("#greet")
        check(f"Saudação {utc[11:16]} UTC (Manaus {int(utc[11:13]) - 4:02d}{utc[13:16]}): {expect}", g == expect, g)
    check("Saudação: data atual em português", "outubro de 2026" in gp.inner_text("#greet-date"), gp.inner_text("#greet-date"))
    gp.close()
    gp = gctx.new_page(); block_external(gp)
    gp.clock.install(time="2026-10-09T15:59:20Z")  # 11:59:20 em Manaus
    gp.goto(ADMIN + "/#/painel"); gp.wait_for_selector("#greet:not(:empty)", timeout=5000)
    before_g = gp.inner_text("#greet")
    gp.clock.run_for(60000)
    after_g = gp.inner_text("#greet")
    check("Saudação muda sozinha na virada do período (bom dia → boa tarde)", before_g == "Bom dia, Igor!" and after_g == "Boa tarde, Igor!", f"{before_g} → {after_g}")
    gp.screenshot(path=str(SHOTS / "admin-12-saudacao.png"))
    gctx.close()
    mg = browser.new_context(viewport={"width": 360, "height": 780}, locale="pt-BR", storage_state=admin.storage_state())
    mgp = mg.new_page(); block_external(mgp); mgp.goto(ADMIN + "/#/painel"); mgp.wait_for_selector("#greet:not(:empty)", timeout=5000)
    gb = mgp.locator("#greet").bounding_box()
    check("Saudação no celular (360px) sem quebrar o layout", mgp.evaluate("() => document.documentElement.scrollWidth") <= 360 and gb["height"] < 70, str(gb))
    mgp.screenshot(path=str(SHOTS / "admin-13-saudacao-celular.png"))
    mg.close()

    # ------------------------------------------------------------------ Integrações protegidas (tela)
    ic = browser.new_context(viewport={"width": 1280, "height": 860}, locale="pt-BR")
    ip = ic.new_page(); block_external(ip)
    ip.goto(ADMIN + "/"); ip.wait_for_selector('input[name="email"]')
    ip.fill('input[name="email"]', ADMIN_EMAIL); ip.fill('input[name="password"]', NEW_PW); ip.click("form button.primary")
    ip.wait_for_selector("#greet", timeout=6000)
    ip.goto(ADMIN + "/#/integracoes"); ip.wait_for_selector(".lock-card", timeout=5000)
    lock_txt = ip.inner_text(".lock-card")
    check("Integrações: nova sessão mostra ÁREA PROTEGIDA", "ÁREA PROTEGIDA" in lock_txt and "DESBLOQUEAR INTEGRAÇÕES" in lock_txt, lock_txt[:80])
    ip.fill('#unlock input[name="password"]', "senha-errada-123")
    ip.click("[data-eye]")
    check("Integrações: botão mostrar/ocultar senha", ip.get_attribute('#unlock input[name="password"]', "type") == "text")
    ip.screenshot(path=str(SHOTS / "admin-14-integracoes-bloqueadas.png"))
    ip.click("#unlock button.primary"); ip.wait_for_selector("#un-err:not([hidden])", timeout=4000)
    check("Integrações: senha errada recusada", "incorreta" in ip.inner_text("#un-err"), ip.inner_text("#un-err"))
    ip.fill('#unlock input[name="password"]', INTEGR_PW); ip.click("#unlock button.primary")
    ip.wait_for_selector("#isec", timeout=5000)
    check("Integrações: desbloqueio com a senha exclusiva", "SEGURANÇA DAS INTEGRAÇÕES" in ip.inner_text("#isec"))
    page_txt = ip.inner_text("#main")
    check("Integrações: token nunca exibido, só o status", "configurado" in page_txt and "EAAB" not in ip.content())
    ip.screenshot(path=str(SHOTS / "admin-15-integracoes.png"), full_page=True)
    ip.click("#relock"); ip.wait_for_selector(".lock-card", timeout=4000)
    check("Integrações: 'Bloquear agora' volta à área protegida", True)
    ic.close()
    mi = browser.new_context(viewport={"width": 375, "height": 760}, locale="pt-BR", storage_state=admin.storage_state())
    mip = mi.new_page(); block_external(mip)
    api(admin, "POST", "/api/admin/integrations/lock")
    mip.goto(ADMIN + "/#/integracoes"); mip.wait_for_selector(".lock-card", timeout=5000)
    check("Integrações no celular sem rolagem horizontal", mip.evaluate("() => document.documentElement.scrollWidth") <= 375)
    mip.screenshot(path=str(SHOTS / "admin-16-integracoes-celular.png"))
    mi.close()

    # ------------------------------------------------------------------ Convite de administrador (tela) e permissões
    ap.goto(ADMIN + "/#/administradores"); ap.wait_for_selector("#add-admin", timeout=5000)
    check("Administradores: tabela Nome/E-mail/Permissão/Status/Último acesso", all(h in ap.inner_text(".t-admins thead") for h in ["Nome", "E-mail", "Permissão", "Status", "Último acesso"]))
    ap.click("#add-admin"); ap.wait_for_selector("#inv-form")
    ap.fill('#inv-form input[name="name"]', "Teste Convite E2E"); ap.fill('#inv-form input[name="email"]', "convite.e2e@teste.local")
    ap.click("#inv-form button.primary"); ap.wait_for_selector("#inv-link", timeout=5000)
    link = ap.input_value("#inv-link")
    check("Convite: link gerado (uso único, 24 h, sem senha pronta)", "#/convite/" in link and "24 horas" in ap.inner_text("#modal"), link[:60])
    ap.screenshot(path=str(SHOTS / "admin-17-convite.png"))
    ap.click("[data-ok]")
    ap.wait_for_timeout(600)
    check("Administradores: convite pendente na lista", "Convite pendente" in ap.inner_text(".t-admins"))
    ap.screenshot(path=str(SHOTS / "admin-18-administradores.png"), full_page=True)

    nctx = browser.new_context(viewport={"width": 390, "height": 844}, locale="pt-BR", is_mobile=True, has_touch=True)
    np_ = nctx.new_page(); block_external(np_)
    np_.goto(link); np_.wait_for_selector("#accept", timeout=5000)
    np_.screenshot(path=str(SHOTS / "admin-19-ativar-convite.png"))
    np_.fill('#accept input[name="email"]', "convite.e2e@teste.local")
    np_.fill('#accept input[name="password"]', "SenhaDoConvite2026"); np_.fill('#accept input[name="confirm"]', "SenhaDoConvite2026")
    np_.click("#accept button.primary"); np_.wait_for_selector("#login", timeout=5000)
    check("Convite: conta ativada e link removido da barra de endereço", "convite" not in np_.url, np_.url)
    np_.goto(link); np_.wait_for_selector(".auth-card h1", timeout=5000)
    check("Convite: link não funciona duas vezes", "indisponível" in np_.inner_text(".auth-card h1"))
    np_.goto(ADMIN + "/#/painel"); np_.wait_for_selector('input[name="email"]')
    np_.fill('input[name="email"]', "convite.e2e@teste.local"); np_.fill('input[name="password"]', "SenhaDoConvite2026"); np_.click("form button.primary")
    np_.wait_for_selector("#greet", timeout=6000)
    nav = np_.text_content("#side .nav")  # menu recolhido no celular (oculto até abrir)
    check("Novo administrador entra e não vê Integrações nem Administradores", "Integrações" not in nav and "Administradores" not in nav and "Agendamentos" in nav, nav.replace("\n", " | "))
    np_.goto(ADMIN + "/#/integracoes"); np_.wait_for_timeout(800)
    check("Administrador comum: URL direta das Integrações → acesso negado", "Acesso negado" in np_.inner_text("#main"))
    for m_, path_ in [("GET", "/api/admin/integrations"), ("POST", "/api/admin/integrations/unlock"), ("GET", "/api/admin/admins"), ("GET", "/api/admin/audit")]:
        rr = nctx.request.fetch(ADMIN + path_, method=m_, headers={"x-olhar-csrf": "1", "content-type": "application/json"}, data=json.dumps({"password": INTEGR_PW}) if m_ == "POST" else None)
        check(f"Administrador comum: {m_} {path_} → 403", rr.status == 403, str(rr.status))
    # Desativar encerra a sessão na hora
    st, adm_list = api(admin, "GET", "/api/admin/admins")
    new_id = [a for a in adm_list["admins"] if a["email"] == "convite.e2e@teste.local"][0]["id"]
    st, _ = api(admin, "PATCH", f"/api/admin/admins/{new_id}", {"disabled": True})
    rr = nctx.request.get(ADMIN + "/api/admin/dashboard")
    check("Desativar acesso encerra a sessão do administrador", st == 200 and rr.status == 401, f"{st} {rr.status}")
    st, _ = api(admin, "DELETE", f"/api/admin/admins/{new_id}")
    check("Remover administrador de teste", st == 200, str(st))
    nctx.close()

    # ------------------------------------------------------------------ Central de Agendamentos (indicadores, gráficos, ações, ao vivo)
    apc = browser.new_context(viewport={"width": 1366, "height": 900}, locale="pt-BR", storage_state=admin.storage_state())
    app_ = apc.new_page(); block_external(app_)
    app_.on("dialog", lambda d: d.accept())
    app_.goto(ADMIN + "/#/agendamentos"); app_.wait_for_selector(".kpi", timeout=6000)
    check("Agendamentos: abre em 'Hoje' com título e subtítulo", "on" in app_.get_attribute('#ap-periods [data-p="hoje"]', "class") and "Acompanhe os agendamentos, horários e atendimentos da Clínica Olhar." in app_.inner_text(".ap-head"))
    app_.click('#ap-periods [data-p="amanha"]'); app_.wait_for_timeout(1500)
    st, ov = api(admin, "GET", "/api/admin/appointments/overview?period=amanha")
    kp = app_.inner_text("#ap-kpis")
    labels = ["TOTAL DE AGENDAMENTOS", "AGENDAMENTOS CONFIRMADOS", "AGUARDANDO CONFIRMAÇÃO", "PACIENTES QUE COMPARECERAM", "NÃO COMPARECERAM", "VAGAS RESTANTES"]
    check("Agendamentos: 6 indicadores com os números do banco", all(l in kp for l in labels) and app_.inner_text(".kpi:nth-child(1) .kpi-value") == str(ov["counts"]["total"]) and app_.inner_text(".kpi:nth-child(6) .kpi-value") == str(ov["remaining"]), json.dumps(ov["counts"]))
    c = ov["counts"]
    st2, lst2 = api(admin, "GET", "/api/admin/appointments?period=amanha")
    stat = {}
    for it in lst2["items"]:
        stat[it["status"]] = stat.get(it["status"], 0) + 1
    check("Agendamentos: totais conferem com a lista (cada agendamento uma vez)", c["total"] + c["cancelados"] == lst2["total"] and c["confirmados"] == stat.get("CONFIRMADO", 0) and c["aguardando"] == stat.get("NOVO", 0) + stat.get("CONTATADO", 0), f"{c} {stat}")
    pcts = app_.eval_on_selector_all("#ap-status .dist-val b", "els => els.map(e => parseInt(e.textContent))")
    check("Situação: 5 status com percentuais somando 100%", len(pcts) == 5 and sum(pcts) == 100, str(pcts))
    check("Horários mais procurados: barras com destaque do maior", app_.locator("#ap-hours .hbars li").count() >= 1 and (ov["top"] is None or app_.locator("#ap-hours li.is-top").count() == 1), json.dumps(ov["top"]))
    for evo in ["15", "30"]:
        app_.click(f'#ap-evo-range [data-evo="{evo}"]'); app_.wait_for_timeout(800)
    st, ov30 = api(admin, "GET", "/api/admin/appointments/overview?period=amanha&evo=30")
    check("Evolução: 30 dias com dados reais", len(ov30["evolution"]["days"]) == 30 and (app_.locator("#ap-evo-chart .vb").count() == 30 or "Nenhum agendamento" in app_.inner_text("#ap-evo-chart")))
    check("Resumo do dia com frases dos dados reais", f"Você possui {c['total']} agendamento" in app_.inner_text("#ap-summary") or "Ainda não há" in app_.inner_text("#ap-summary"), app_.inner_text("#ap-summary")[:120])
    check("Visualização por horário: vagas ocupadas / capacidade", app_.locator("#ap-slots .sblock").count() >= 1 and "vagas ocupadas" in app_.inner_text("#ap-slots") or "bloqueado" in app_.inner_text("#ap-slots"))
    app_.screenshot(path=str(SHOTS / "admin-20-agendamentos.png"), full_page=True)
    # Filtros: painel recolhido, abre pelo botão; busca
    check("Filtros recolhidos até tocar em FILTROS", not app_.is_visible("#ap-filters"))
    app_.click("#ap-filters-btn"); app_.wait_for_timeout(200)
    check("Botão FILTROS abre o painel", app_.is_visible("#f-origin"))
    app_.fill("#f-q", "Joana"); app_.wait_for_timeout(900)
    check("Pesquisa por nome", app_.locator("#ap-list tbody tr").count() == 1 and "Joana" in app_.inner_text("#ap-list"))
    app_.click("#ap-clear"); app_.wait_for_timeout(900)
    # Ações rápidas: confirmar e cancelar (com confirmação), vaga liberada
    row = app_.locator('#ap-list tr:has-text("Carlos Lima")')
    row.locator('[data-status="CONFIRMADO"]').click(); app_.wait_for_timeout(1200)
    st, l3 = api(admin, "GET", "/api/admin/appointments?period=amanha&q=Carlos")
    check("Confirmar pelo painel grava no banco", l3["items"][0]["status"] == "CONFIRMADO", l3["items"][0]["status"])
    before_rem = api(admin, "GET", "/api/admin/appointments/overview?period=amanha")[1]["remaining"]
    app_.locator('#ap-list tr:has-text("Carlos Lima") [data-status="CANCELADO"]').click(); app_.wait_for_timeout(1500)
    after = api(admin, "GET", "/api/admin/appointments/overview?period=amanha")[1]
    check("Cancelar (com confirmação) libera a vaga", after["remaining"] == before_rem + 1, f"{before_rem} → {after['remaining']}")
    st, audit_l = api(admin, "GET", "/api/admin/audit")
    check("Alterações de status no histórico administrativo", sum(1 for a in audit_l["items"] if a["action"] == "status") >= 2)
    r = admin.request.get(ADMIN + "/api/admin/appointments.csv?period=amanha&status=CANCELADO", headers={"x-olhar-csrf": "1"})
    check("Exportação CSV com filtros", r.status == 200 and "Carlos Lima" in r.text() and "Joana Prado" not in r.text(), str(r.status))
    # Ao vivo: novo agendamento no site aparece sem recarregar a página
    t_before = app_.inner_text(".kpi:nth-child(1) .kpi-value")
    st, avx = api(pub, "GET", "/api/availability")
    fri = [d for d in avx["dates"] if d["date"] == "2026-10-09"][0]
    free_t = [t["time"] for t in fri["times"] if t["available"]][0]
    stb, _ = api(pub, "POST", "/api/bookings", {"name": "Teste Ao Vivo", "age": 33, "whatsapp": "92966660001", "date": "2026-10-09", "time": free_t, "consent_data": True, "elapsed_ms": 9000, "website": "", "idempotency_key": "k-live-1"})
    for _ in range(40):
        if app_.inner_text(".kpi:nth-child(1) .kpi-value") != t_before:
            break
        app_.wait_for_timeout(250)
    app_.wait_for_timeout(600)
    check("Ao vivo: indicador atualiza sozinho com novo agendamento", app_.inner_text(".kpi:nth-child(1) .kpi-value") == str(int(t_before) + 1) and "Teste Ao Vivo" in app_.inner_text("#ap-list") and "Ao vivo" in app_.inner_text("#ap-live"), f"{t_before} → {app_.inner_text('.kpi:nth-child(1) .kpi-value')} ({stb})")
    check("Ao vivo: horário da atualização exibido", "Dados atualizados às" in app_.inner_text("#ap-live"))
    apc.close()
    for w in [320, 360, 375, 390, 430]:
        mc = browser.new_context(viewport={"width": w, "height": 800}, locale="pt-BR", is_mobile=True, has_touch=True, storage_state=admin.storage_state())
        mp_ = mc.new_page(); block_external(mp_)
        mp_.goto(ADMIN + "/#/agendamentos"); mp_.wait_for_selector(".kpi", timeout=6000)
        mp_.click('#ap-periods [data-p="amanha"]'); mp_.wait_for_timeout(1500)
        sw = mp_.evaluate("() => document.documentElement.scrollWidth")
        cols = mp_.evaluate("() => getComputedStyle(document.querySelector('.kpis')).gridTemplateColumns.split(' ').length")
        check(f"Agendamentos {w}px: sem rolagem horizontal, cards e {cols} coluna(s) de indicadores", sw <= w and (cols == 2 if w >= 360 else cols >= 1) and mp_.is_hidden("#ap-list thead"), f"scrollWidth={sw}")
        if w == 390:
            mp_.screenshot(path=str(SHOTS / "admin-21-agendamentos-celular.png"), full_page=True)
        mc.close()

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
