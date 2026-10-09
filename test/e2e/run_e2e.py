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
    check("Selo de vagas mostra disponibilidade real (2 datas × 14 horários × 3 = 84)", "84" in seats, seats.replace("\n", " "))
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
    cards = pg.locator("[data-dates] [data-date]")
    labels = [cards.nth(i).inner_text().replace("\n", " ") for i in range(cards.count())]
    check("Quinta-feira: duas opções (amanhã sexta 09/10 e sábado 10/10)", cards.count() == 2 and "09 de outubro" in labels[0] and "10 de outubro" in labels[1], " | ".join(labels))
    pg.screenshot(path=str(SHOTS / "m-04-datas.png"))
    cards.nth(0).click()
    pg.wait_for_timeout(250)
    check("Card selecionado recebe estado ativo", cards.nth(0).get_attribute("aria-checked") == "true")
    pg.screenshot(path=str(SHOTS / "m-04b-data-selecionada.png"))
    pg.click('[data-step="4"] [data-next]')
    wait_step(pg, 5)

    # Etapa 5 — horários
    check("Indicador 'Etapa 5 de 5'", "5 de 5" in pg.inner_text("[data-step-count]"))
    times = pg.locator("[data-times] [data-time]")
    check("Grade de horários com 14 horários (08–12 e 13–16)", times.count() == 14, str(times.count()))
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
    check("Contador atualizado após reserva (84 → 83)", av["total"] == 83, str(av["total"]))
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
    pg2.locator("[data-dates] [data-date]").nth(0).click()
    pg2.click('[data-step="4"] [data-next]'); wait_step(pg2, 5)
    full = pg2.locator('[data-times] button.time', has_text='09:30')
    check("Horário lotado aparece como 'Esgotado' e desabilitado", full.is_disabled() and "Esgotado" in full.inner_text(), full.inner_text())
    full.scroll_into_view_if_needed()
    pg2.screenshot(path=str(SHOTS / "m-07-esgotado.png"))

    # Avisos discretos (somente autorizados): Mariana autorizou
    st, act = api(pg2ctx, "GET", "/api/activity")
    names = [a.get("firstName") for a in act.get("items", [])]
    check("Avisos de atividade: só quem autorizou (Mariana sim; Joana/Carlos não)", names == ["Mariana"], str(act)[:200])

    # ------------------------------------------------------------------ Responsividade
    for w in [320, 360, 375, 390, 430, 768, 1280, 1440]:
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

    # ------------------------------------------------------------------ Sem vagas: bloquear as duas datas
    for d in ["2026-10-09", "2026-10-10"]:
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
