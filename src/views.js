import { esc, assetUrl } from './http.js';
import { config } from './config.js';
import { renderLegal } from './legal.js';
import { formatWhatsapp } from './validate.js';

const FONT_HREF = 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap';

// Marca padrão: um olho estilizado. Substituída pela logo enviada no painel, quando houver.

// Logomarca oficial. As versões em /brand/ foram recortadas do arquivo original com fundo transparente
// (letras brancas) e por isso aparecem sempre sobre superfícies azul-marinho.
export const LOGO = {
  assinatura: (h = 46, cls = 'brand-logo') => `<img class="${cls}" src="${assetUrl('/brand/logo-assinatura.png')}" alt="Clínica Olhar" width="${Math.round(h * 602 / 235)}" height="${h}" decoding="async">`,
  completo: (h = 96, cls = 'brand-full') => `<img class="${cls}" src="${assetUrl('/brand/logo-completo.png')}" alt="Clínica Olhar" width="${Math.round(h * 602 / 448)}" height="${h}" loading="lazy" decoding="async">`,
};

function brand(settings, logoVersion) {
  const name = esc(settings.clinic.name);
  if (logoVersion) return `<img class="brand-img" src="/media/logo?v=${logoVersion}" alt="${name}" width="180" height="44">`;
  return LOGO.assinatura(46);
}

/** Ícones de navegador, atalhos e compartilhamento. */
function iconLinks() {
  return `<link rel="icon" href="${assetUrl('/favicon.ico')}" sizes="48x48">
<link rel="icon" href="${assetUrl('/brand/favicon-32.png')}" type="image/png" sizes="32x32">
<link rel="apple-touch-icon" href="${assetUrl('/brand/apple-touch-icon.png')}">
<link rel="manifest" href="${assetUrl('/manifest.webmanifest')}">`;
}

function head({ title, description, extra = '' }) {
  const canonical = config.appUrl ? `<link rel="canonical" href="${esc(config.appUrl)}/">` : '';
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="#131842">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:locale" content="pt_BR">
${config.appUrl ? `<meta property="og:url" content="${esc(config.appUrl)}/">` : ''}
${canonical}
${iconLinks()}
${config.appUrl ? `<meta property="og:image" content="${esc(config.appUrl)}/brand/logo-original.png">` : ''}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONT_HREF}">
<link rel="stylesheet" href="${assetUrl('/assets/site.css')}">
${extra}
</head>`;
}

function seatsMarkup(av, threshold = 10) {
  if (!av.enabled || av.total === 0) {
    return `<span class="seats-dot is-off" aria-hidden="true"></span><span class="seats-text"><strong class="seats-title">TODAS AS VAGAS FORAM PREENCHIDAS</strong><span class="seats-count">${av.waitlist ? 'Entre na lista de espera' : 'Novas datas em breve'}</span></span>`;
  }
  // "Agendamentos abertos" indica que o sistema aceita novos agendamentos (não é presença de atendentes).
  // Sem cota de campanha configurada: mensagem genérica; o número só aparece quando é real e baixo ("Últimas N vagas").
  const count = av.total <= threshold
    ? `<span class="seats-urgent">${av.total === 1 ? 'ÚLTIMA VAGA DISPONÍVEL' : `ÚLTIMAS <b>${av.total}</b> VAGAS DISPONÍVEIS`}</span>`
    : 'VAGAS DISPONÍVEIS';
  return `<span class="seats-dot is-live" aria-hidden="true"></span><span class="seats-text"><strong class="seats-title">AGENDAMENTOS ABERTOS</strong><span class="seats-count">${count}</span></span>`;
}

/** "hoje, amanhã ou sábado" conforme as datas com vagas reais. */
export function dayWords(av) {
  const words = [];
  for (const d of av.dates || []) {
    if (!d.available) continue;
    for (const k of d.kinds || [d.kind]) {
      const w = k === 'hoje' ? 'hoje' : k === 'amanha' ? 'amanhã' : 'sábado';
      if (!words.includes(w)) words.push(w);
    }
  }
  if (!words.length) return '';
  return words.length === 1 ? words[0] : words.slice(0, -1).join(', ') + ' ou ' + words[words.length - 1];
}

const ICON = {
  bolt: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M11.3 1.8 4.2 11.2h5.1l-1 7 7.5-9.9H10.6l.7-6.5Z" fill="currentColor"/></svg>',
  check: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 10.5l3.5 3.5 7.5-8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  whatsapp: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38a9.9 9.9 0 0 0 4.74 1.21c5.46 0 9.91-4.45 9.91-9.91C21.95 6.45 17.5 2 12.04 2Zm0 18.15c-1.48 0-2.93-.4-4.2-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.26 8.26 0 0 1-1.26-4.38c0-4.54 3.7-8.24 8.25-8.24 4.54 0 8.24 3.7 8.24 8.24 0 4.55-3.7 8.24-8.24 8.24Zm4.52-6.16c-.25-.12-1.47-.72-1.69-.81-.23-.08-.39-.12-.56.13-.16.24-.64.8-.78.97-.14.17-.29.19-.54.06-.25-.12-1.05-.39-1.99-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.02-.38.11-.5.11-.11.25-.29.37-.43.13-.15.17-.25.25-.42.08-.16.04-.31-.02-.43-.06-.13-.56-1.35-.76-1.84-.2-.48-.41-.42-.56-.43h-.48c-.17 0-.43.06-.66.31-.22.25-.86.85-.86 2.07 0 1.22.89 2.4 1.01 2.56.12.17 1.75 2.67 4.23 3.74.59.26 1.05.41 1.41.52.59.19 1.13.16 1.56.1.48-.07 1.47-.6 1.67-1.18.21-.58.21-1.07.14-1.18-.06-.1-.22-.16-.47-.28Z"/></svg>',
};

/** Página principal. */
export function renderLanding({ settings, availability, faq, logoVersion }) {
  const s = settings;
  const boot = {
    availability,
    clinic: { name: s.clinic.name, whatsapp: s.clinic.whatsapp, address: s.clinic.address, maps_url: s.clinic.maps_url },
    rules: { min_age: s.booking.min_age, max_age: s.booking.max_age, minor_rule: s.booking.minor_rule },
    socialProof: !!s.social_proof.enabled || s.social_proof.institutional !== false,
    threshold: Number(s.booking.scarcity_threshold) || 0,
    meta: {
      pixel: !!(s.meta.pixel_enabled && s.meta.pixel_id),
      pixelId: s.meta.pixel_id,
      requireConsent: s.meta.require_consent !== false,
      scheduleEvent: !!s.meta.schedule_event,
    },
  };
  const bootJson = JSON.stringify(boot).replace(/</g, '\\u003c');
  const wa = s.clinic.whatsapp;

  return `${head({
    title: 'Exame de Vista Grátis | ' + s.clinic.name,
    description: `Solicite seu exame de vista gratuito na ${s.clinic.name}. Faça seu cadastro e escolha uma data e horário disponíveis.`,
  })}
<body>
<a class="skip" href="#agendar">Ir para o agendamento</a>
<header class="top">
  <div class="wrap top-inner">
    <a class="brand" href="/" aria-label="${esc(s.clinic.name)} — início">${brand(s, logoVersion)}</a>
  </div>
</header>

<main id="conteudo">
  <section class="hero">
    <div class="wrap hero-grid">
      <div class="hero-copy">
        <p class="seats" data-seats role="status" aria-live="polite">${seatsMarkup(availability, Number(s.booking.scarcity_threshold) || 0)}</p>
        <h1 class="chart">
          <span class="chart-1">Exame de vista</span>
          <span class="chart-2">100%</span>
          <span class="chart-3">grátis</span>
        </h1>
        <p class="acuity" aria-hidden="true"><span>E</span><span>F</span><span>P</span><span>T</span><span>O</span><span>Z</span><span>L</span><span>P</span><span>E</span><span>D</span></p>
        <p class="lede" data-lede>${dayWords(availability) ? `Faça seu cadastro e escolha seu horário para <b>${esc(dayWords(availability))}</b>.` : 'Faça seu cadastro e escolha o melhor horário para realizar seu exame de vista gratuito.'}</p>
        <ul class="perks">
          <li>${ICON.check}Cadastro rápido</li>
          <li>${ICON.check}Escolha seu horário</li>
          <li>${ICON.check}Atendimento gratuito</li>
        </ul>
      </div>

      <div class="booking" id="agendar">
        <div class="card" data-card>
          <form class="flow" data-flow novalidate autocomplete="on">
            <div class="flow-head" data-head>
              <p class="step-count" data-step-count>Etapa 1 de 5</p>
              <ol class="progress" aria-hidden="true">${'<li></li>'.repeat(5)}</ol>
            </div>
            <div class="timer" data-timer hidden>
              <div class="timer-row">
                <span class="timer-label">TEMPO PARA CONCLUIR SUA RESERVA</span>
                <span class="timer-clock" data-timer-clock role="timer" aria-label="Tempo para concluir sua reserva">10:00</span>
              </div>
              <p class="timer-msg" data-timer-msg aria-live="polite" hidden></p>
            </div>

            <div class="hp" aria-hidden="true"><label>Não preencha<input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>

            <!-- Etapa 1 -->
            <section class="step is-active" data-step="1" aria-labelledby="t1">
              <h2 id="t1" class="step-title" tabindex="-1">Como podemos te chamar?</h2>
              <p class="step-sub">Vamos começar com seu nome.</p>
              <label class="field">
                <span class="field-label">Nome</span>
                <input class="input" name="name" type="text" placeholder="Digite seu nome" autocomplete="name" autocapitalize="words" maxlength="80" enterkeyhint="next" aria-describedby="e-name">
                <span class="field-error" id="e-name" data-error="name" role="alert"></span>
              </label>
              <button class="btn btn-primary" type="button" data-next>CONTINUAR →</button>
            </section>

            <!-- Etapa 2 -->
            <section class="step" data-step="2" aria-labelledby="t2" hidden>
              <h2 id="t2" class="step-title" tabindex="-1">Qual é a sua idade?</h2>
              <p class="step-sub">Se for agendar para outra pessoa, informe a idade dela.</p>
              <label class="field">
                <span class="field-label">Idade</span>
                <span class="input-suffix">
                  <input class="input" name="age" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" placeholder="Digite sua idade" enterkeyhint="next" aria-describedby="e-age">
                  <span class="suffix" aria-hidden="true">anos</span>
                </span>
                <span class="field-error" id="e-age" data-error="age" role="alert"></span>
              </label>
              <div class="guardian" data-guardian hidden>
                <p class="note">Para menores de 18 anos, o atendimento acontece com o acompanhamento de um responsável.</p>
                <label class="field">
                  <span class="field-label">Nome do responsável</span>
                  <input class="input" name="guardian_name" type="text" placeholder="Nome completo do responsável" autocomplete="off" maxlength="80" aria-describedby="e-guardian_name">
                  <span class="field-error" id="e-guardian_name" data-error="guardian_name" role="alert"></span>
                </label>
                <label class="check">
                  <input type="checkbox" name="guardian_ack">
                  <span>Sou o responsável ou o paciente irá acompanhado por ele no dia do exame.</span>
                </label>
                <span class="field-error" data-error="guardian_ack" role="alert"></span>
              </div>
              <div class="actions">
                <button class="btn btn-ghost" type="button" data-back>VOLTAR</button>
                <button class="btn btn-primary" type="button" data-next>CONTINUAR →</button>
              </div>
            </section>

            <!-- Etapa 3 -->
            <section class="step" data-step="3" aria-labelledby="t3" hidden>
              <h2 id="t3" class="step-title" tabindex="-1">Qual é o seu WhatsApp?</h2>
              <p class="step-sub">Enviaremos as informações do seu agendamento para este número.</p>
              <label class="field">
                <span class="field-label">WhatsApp com DDD</span>
                <span class="input-icon">
                  <span class="wa-icon" aria-hidden="true">${ICON.whatsapp}</span>
                  <input class="input" name="whatsapp" type="tel" inputmode="tel" placeholder="(DDD) 99999-9999" autocomplete="tel-national" maxlength="16" enterkeyhint="next" aria-describedby="e-whatsapp">
                </span>
                <span class="field-error" id="e-whatsapp" data-error="whatsapp" role="alert"></span>
              </label>
              <div class="consents">
                <label class="check">
                  <input type="checkbox" name="consent_data">
                  <span>Autorizo a ${esc(s.clinic.name)} a usar meu nome, idade e WhatsApp para agendar e falar comigo sobre o exame, conforme a <a href="/privacidade" target="_blank" rel="noopener">Política de Privacidade</a>.</span>
                </label>
                <span class="field-error" data-error="consent_data" role="alert"></span>
                <label class="check check-optional">
                  <input type="checkbox" name="consent_marketing">
                  <span>Quero receber novidades e ofertas pelo WhatsApp. <em>(opcional)</em></span>
                </label>
                ${s.social_proof.enabled ? `<label class="check check-optional">
                  <input type="checkbox" name="consent_social">
                  <span>Pode mostrar meu primeiro nome no aviso de agendamentos recentes do site. <em>(opcional)</em></span>
                </label>` : ''}
              </div>
              <div class="actions">
                <button class="btn btn-ghost" type="button" data-back>VOLTAR</button>
                <button class="btn btn-primary" type="button" data-next>ESCOLHER DATA →</button>
              </div>
            </section>

            <!-- Etapa 4 -->
            <section class="step" data-step="4" aria-labelledby="t4" hidden>
              <h2 id="t4" class="step-title step-title-caps" tabindex="-1">ESCOLHA O MELHOR DIA PARA SEU EXAME</h2>
              <p class="step-sub" data-date-sub>Confira as datas e os horários disponíveis.</p>
              <div class="today-box" data-today hidden>
                <div class="today-head">
                  <p class="today-flag">${ICON.bolt}<span>EXAME AINDA HOJE</span></p>
                  <span class="today-pill"><span class="pulse-dot" aria-hidden="true"></span>VAGAS PARA HOJE</span>
                </div>
                <p class="today-sub">Você ainda pode realizar seu exame hoje! Confira os horários disponíveis para atendimento.</p>
                <ul class="today-slots" data-today-slots></ul>
                <button class="btn btn-today" type="button" data-today-go>VER HORÁRIOS DE HOJE →</button>
              </div>
              <div class="calendar" data-calendar role="group" aria-labelledby="t4"></div>
              <ul class="cal-legend" aria-hidden="true">
                <li><i class="lg-on"></i>Disponível</li><li><i class="lg-off"></i>Indisponível</li><li><i class="lg-today"></i>Hoje</li>
              </ul>
              <p class="cal-picked" data-cal-picked hidden></p>
              <span class="field-error" data-error="date" role="alert"></span>
              <div class="actions">
                <button class="btn btn-ghost" type="button" data-back>VOLTAR</button>
                <button class="btn btn-primary" type="button" data-next>ESCOLHER HORÁRIO →</button>
              </div>
            </section>

            <!-- Etapa 5 -->
            <section class="step" data-step="5" aria-labelledby="t5" hidden>
              <h2 id="t5" class="step-title" tabindex="-1">Qual horário fica melhor para você?</h2>
              <p class="chosen-date" data-chosen-date></p>
              <p class="lead-note" data-lead-note hidden></p>
              <div class="times" data-times></div>
              <span class="field-error" data-error="time" role="alert"></span>
              <div class="summary" data-summary hidden>
                <p class="summary-title">Confira seus dados</p>
                <dl class="summary-list">
                  <div><dt>Nome</dt><dd data-sum="name"></dd><button type="button" class="link" data-edit="1">Alterar</button></div>
                  <div><dt>Data</dt><dd data-sum="date"></dd><button type="button" class="link" data-edit="4">Alterar</button></div>
                  <div><dt>Horário</dt><dd data-sum="time"></dd></div>
                  <div><dt>WhatsApp</dt><dd data-sum="whatsapp"></dd><button type="button" class="link" data-edit="3">Alterar</button></div>
                </dl>
              </div>
              <p class="last-seat" data-last-seat hidden>ÚLTIMA VAGA PARA ESTE HORÁRIO</p>
              <p class="form-error" data-form-error role="alert" hidden></p>
              <div class="actions actions-stack">
                <button class="btn btn-confirm" type="submit" data-confirm>CONFIRMAR MEU EXAME GRÁTIS</button>
                <button class="btn btn-ghost" type="button" data-back>VOLTAR</button>
              </div>
            </section>

            <!-- Sem vagas: lista de espera -->
            <section class="step" data-step="waitlist" aria-labelledby="tw" hidden>
              <h2 id="tw" class="step-title" tabindex="-1">TODAS AS VAGAS FORAM PREENCHIDAS</h2>
              <p class="step-sub">Você pode entrar em nossa lista de espera. Avisaremos pelo WhatsApp quando abrirem novos horários.</p>
              <div data-waitlist-body>
                <p class="note" data-waitlist-who></p>
                <p class="form-error" data-waitlist-error role="alert" hidden></p>
                <div class="actions actions-stack">
                  <button class="btn btn-primary" type="button" data-waitlist-join>ENTRAR NA LISTA DE ESPERA</button>
                  <button class="btn btn-ghost" type="button" data-waitlist-edit>Corrigir meus dados</button>
                </div>
              </div>
              <div class="waitlist-done" data-waitlist-done hidden>
                <p class="ok-line">${ICON.check}<span>Pronto! Você está na lista de espera.</span></p>
                <p class="note">Nenhum horário foi reservado. A clínica vai falar com você quando houver vagas.</p>
              </div>
            </section>
          </form>

          <!-- Confirmação -->
          <section class="done" data-done hidden aria-labelledby="td">
            <div class="done-icon" aria-hidden="true"><svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="29" /><path d="M19 33.5l9 9 17-19" /></svg></div>
            <h2 id="td" class="done-title" tabindex="-1">SEU AGENDAMENTO FOI REALIZADO!</h2>
            <p class="done-sub">Seu exame de vista gratuito foi agendado com sucesso.</p>
            <div class="ticket">
              <p class="ticket-head">${LOGO.assinatura(30, 'ticket-logo')}</p>
              <dl class="ticket-list">
                <div><dt>Paciente</dt><dd data-t="name"></dd></div>
                <div data-t-guardian-row hidden><dt>Responsável</dt><dd data-t="guardian"></dd></div>
                <div><dt>Idade</dt><dd data-t="age"></dd></div>
                <div><dt>Data</dt><dd data-t="date"></dd></div>
                <div><dt>Horário</dt><dd data-t="time"></dd></div>
                <div><dt>WhatsApp</dt><dd data-t="whatsapp"></dd></div>
                <div data-t-address-row hidden><dt>Local</dt><dd data-t="address"></dd></div>
              </dl>
              <p class="ticket-protocol"><span>Protocolo</span><strong data-t="protocol"></strong></p>
            </div>
            <p class="keep">Guarde essas informações para o dia do atendimento.</p>
            ${wa ? `<a class="btn btn-wa" data-wa-confirm href="#" target="_blank" rel="noopener">${ICON.whatsapp}CONFIRMAR PELO WHATSAPP</a>` : ''}
            <button class="btn btn-ghost btn-small" type="button" data-again>Agendar para outra pessoa</button>
          </section>
        </div>
      </div>
    </div>
  </section>

  <section class="how" aria-labelledby="how-title">
    <div class="wrap">
      <h2 id="how-title" class="section-title">Cuidar da sua visão ficou mais fácil.</h2>
      <ol class="how-steps">
        <li><span class="how-n" aria-hidden="true">1</span><div><h3>Faça seu cadastro</h3><p>Informe seu nome, idade e WhatsApp.</p></div></li>
        <li><span class="how-n" aria-hidden="true">2</span><div><h3>Escolha seu horário</h3><p>Selecione uma das datas disponíveis e o horário de sua preferência.</p></div></li>
        <li><span class="how-n" aria-hidden="true">3</span><div><h3>Compareça ao atendimento</h3><p>Vá ao local informado na confirmação.</p></div></li>
      </ol>
      <a class="btn btn-outline how-cta" href="#agendar" data-goto-form>AGENDAR MEU EXAME GRÁTIS</a>
    </div>
  </section>

  <section class="why" aria-labelledby="why-title">
    <div class="wrap why-grid">
      <h2 id="why-title" class="section-title">${esc(s.content.vision_title)}</h2>
      <div class="why-text">${s.content.vision_paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')}</div>
    </div>
  </section>

  ${faq.length ? `<section class="faq" aria-labelledby="faq-title">
    <div class="wrap faq-wrap">
      <h2 id="faq-title" class="section-title">Dúvidas frequentes</h2>
      <div class="faq-list">
        ${faq.map((f) => `<details><summary>${esc(f.question)}</summary><div class="faq-a">${esc(f.answer).split(/\n+/).map((p) => `<p>${p}</p>`).join('')}</div></details>`).join('')}
      </div>
    </div>
  </section>` : ''}
</main>

<footer class="foot">
  <div class="wrap foot-inner">
    <p class="foot-brand">${LOGO.completo(84)}</p>
    ${s.clinic.address ? `<p>${esc(s.clinic.address)}${s.clinic.maps_url ? ` · <a href="${esc(s.clinic.maps_url)}" target="_blank" rel="noopener">Ver no mapa</a>` : ''}</p>` : ''}
    ${s.clinic.opening_hours_text ? `<p>${esc(s.clinic.opening_hours_text)}</p>` : ''}
    ${wa ? `<p><a href="https://wa.me/55${esc(wa)}" target="_blank" rel="noopener" data-contact>WhatsApp ${esc(formatWhatsapp(wa))}</a></p>` : ''}
    <p class="foot-legal"><a href="/privacidade">Política de Privacidade</a> <button type="button" class="link" data-cookie-prefs hidden>Preferências de cookies</button></p>
  </div>
</footer>

<div class="toast" data-toast role="status" aria-live="polite" hidden></div>
<div class="cookie" data-cookie hidden>
  <p>Usamos cookies para medir nossos anúncios. <a href="/privacidade">Saiba mais</a></p>
  <div class="cookie-actions">
    <button type="button" class="btn btn-ghost btn-small" data-cookie-no>Recusar</button>
    <button type="button" class="btn btn-primary btn-small" data-cookie-yes>Aceitar</button>
  </div>
</div>
<script type="application/json" id="boot">${bootJson}</script>
<script src="${assetUrl('/assets/site.js')}" defer></script>
</body>
</html>`;
}

function simplePage({ settings, title, body }) {
  return `${head({ title, description: settings ? `${settings.clinic.name}` : 'Clínica Olhar' })}
<body class="page-simple">
<header class="top"><div class="wrap top-inner"><a class="brand" href="/" aria-label="Clínica Olhar — início">${LOGO.assinatura(46)}</a></div></header>
<main class="wrap doc">${body}</main>
</body></html>`;
}

export function renderPrivacy({ settings, policy }) {
  const vars = {
    clinica: settings.clinic.name,
    whatsapp: settings.clinic.whatsapp ? formatWhatsapp(settings.clinic.whatsapp) : '',
    retencao: String(settings.privacy.retention_days),
  };
  const updated = policy ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Manaus', dateStyle: 'long' }).format(new Date(policy.created_at)) : '';
  return simplePage({
    settings,
    title: 'Política de Privacidade | ' + settings.clinic.name,
    body: `<p class="doc-back"><a href="/">← Voltar para o agendamento</a></p>
<h1>Política de Privacidade</h1>
<p class="doc-meta">Versão ${esc(policy?.version || '1')} · atualizada em ${esc(updated)}</p>
${renderLegal(policy?.body || '', vars)}`,
  });
}

export function renderNotFound() {
  return simplePage({ title: 'Página não encontrada', body: '<h1>Página não encontrada</h1><p>O endereço acessado não existe.</p><p><a class="btn btn-primary" href="/">Ir para o agendamento</a></p>' });
}

export function renderError(status, message) {
  return simplePage({ title: 'Erro', body: `<h1>Algo não saiu como esperado</h1><p>${esc(message)}</p><p><a class="btn btn-primary" href="/">Voltar ao início</a></p>` });
}

export function renderAdmin() {
  // Endereço do site público para os links "Ver site"/"Ver página". Em desenvolvimento (APP_ROLE=all) é o próprio servidor.
  const publicUrl = config.role === 'all' ? '' : config.publicSiteUrl;
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="no-referrer">
<meta name="olhar-public-url" content="${esc(publicUrl)}" data-role="${esc(config.role)}">
<title>Painel | Clínica Olhar</title>
${iconLinks()}
<meta name="theme-color" content="#131842">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONT_HREF}">
<link rel="stylesheet" href="${assetUrl('/assets/admin.css')}">
</head>
<body>
<div id="app" class="boot">Carregando…</div>
<script src="${assetUrl('/assets/admin.js')}" defer></script>
</body>
</html>`;
}
