# Clínica Olhar — Exame de Vista Grátis

Sistema de agendamento em **dois ambientes separados**, integrados pelo mesmo banco de dados:

| | Site público de agendamento | Sistema administrativo |
|---|---|---|
| Quem usa | Pacientes vindos dos anúncios | Somente a administração da clínica |
| Endereço | Domínio divulgado (ex.: `exame.clinicaolhar.com.br`) | Domínio interno, não divulgado (ex.: `gestao.clinicaolhar.com.br`) |
| O que faz | Oferta, formulário em 5 etapas, escolha de amanhã/sábado e horário, protocolo | Agendamentos, pacientes, agenda e vagas, cancelamentos e remarcações, status, relatórios, Meta Pixel, configurações |
| Indexação | Sim (página e política) | Nunca (`noindex` em cabeçalho e HTML, `robots.txt` bloqueando tudo) |
| Acesso | Livre | Camada extra (Cloudflare Access, IPs permitidos ou senha de acesso) **+** login com senha forte **+** autorização em cada requisição |
| Usuário do banco | `olhar_site` — permissões mínimas | Dono do banco |

---

## 1. Arquitetura

```
 Visitante (Instagram/Facebook)                         Equipe da clínica
            │ HTTPS                                             │ HTTPS
            ▼                                                   ▼
 ┌──────────────────────────┐                     ┌─────────────────────────────────┐
 │  SITE PÚBLICO            │                     │  CAMADA DE ACESSO               │
 │  APP_ROLE=public         │                     │  Cloudflare Access / IP / senha │
 │                          │                     └───────────────┬─────────────────┘
 │  /  /privacidade         │                                     ▼
 │  /api/availability       │                     ┌─────────────────────────────────┐
 │  /api/bookings           │                     │  PAINEL  APP_ROLE=admin         │
 │  /api/waitlist           │                     │  login + sessão + anti-CSRF     │
 │  /api/activity           │                     │  /  (painel)   /api/admin/*     │
 │                          │                     │  migrações, retenção LGPD       │
 │  /admin → 404            │                     └───────────────┬─────────────────┘
 └────────────┬─────────────┘                                     │
              │ usuário olhar_site                                │ usuário dono
              │ (só lê agenda e cria agendamentos)                │ (gestão completa)
              ▼                                                   ▼
        ┌──────────────────────────────────────────────────────────────────┐
        │                PostgreSQL (rede privada)                         │
        │  agendamentos ● pacientes ● horários/vagas ● configurações       │
        │  LISTEN/NOTIFY: mudança no painel → site atualiza na hora        │
        └──────────────────────────────────────────────────────────────────┘
```

**Um código, duas implantações.** O mesmo repositório gera os dois serviços; a variável `APP_ROLE` define qual deles cada processo é. Isso evita duplicar regras de negócio e garante que o site e o painel validem tudo do mesmo jeito.

### O que garante a separação

- **Rotas inexistentes, não escondidas.** No serviço público, as rotas do painel não são registradas: `/admin`, `/api/admin/*` e `admin.js` respondem 404. A página pública não tem nenhum link de login ou painel. No serviço do painel, o site e a API de agendamento não existem.
- **Camada extra antes do login**, verificada no servidor em todas as requisições do painel (inclusive arquivos):
  - **Cloudflare Access** (recomendado): a equipe entra com e-mail/Google antes de ver o painel. O servidor valida a assinatura RS256 do token, a audiência, o emissor e a validade — acessar o endereço do servidor diretamente, sem passar pela Cloudflare, é recusado.
  - **IPs permitidos:** IP fixo da clínica ou da VPN (aceita faixas CIDR). Fora da lista, a resposta é 404.
  - **Senha de acesso:** o navegador pede uma senha extra antes da tela de login.
  - Em produção, o painel **não inicia** sem pelo menos uma delas.
- **Login e autorização:** senha scrypt de 12+ caracteres, troca obrigatória no 1º acesso, bloqueio após 5 erros, sessão de 12 h em cookie `HttpOnly`/`Secure`/`SameSite=Strict` restrito ao domínio do painel, cabeçalho anti-CSRF e checagem de origem em toda escrita, auditoria das ações.
- **Permissões distintas no banco.** O site conecta com o usuário `olhar_site`, que o próprio banco limita a: ler agenda/configurações, criar pacientes e agendamentos, e registrar consentimentos. Ele **não consegue** ler administradores, sessões, auditoria, consentimentos, origem dos anúncios ou observações; nem apagar, cancelar, alterar vagas, bloqueios, status ou configurações. Em produção, o site **recusa iniciar** se estiver conectado com um usuário com permissões administrativas.
- **Sincronização imediata.** Agendamento feito no site aparece no painel na próxima atualização da tela. Vagas e bloqueios alterados no painel valem no site na hora, porque a disponibilidade é calculada no banco a cada acesso. Configurações (agendamento aberto/fechado, WhatsApp, Pixel) chegam por LISTEN/NOTIFY do PostgreSQL, com um cache de no máximo 5 s como reserva.
- **Segredos separados.** O token da API de Conversões fica só no site (que envia o Lead); o painel mostra se ele está configurado sem precisar conhecê-lo. Cada serviço tem seu próprio `SESSION_SECRET`.

---

## 2. Stack e estrutura

| Camada | Escolha | Por quê |
|---|---|---|
| Servidor | Node.js 20+ (HTTP nativo, ES modules) | Uma única dependência (`pg`). Inicia em < 1 s, superfície de ataque mínima. |
| Banco | PostgreSQL 14+ | Transações, travas por data contra overbooking, permissões por coluna, LISTEN/NOTIFY. |
| Front-end | HTML gerado no servidor + CSS/JS próprios | ~25 KB de JS/CSS no site: rápido em 3G, que é o que importa no tráfego pago. |

```
server.js                 inicialização por papel (painel: migrações, 1º admin, retenção; site: espera o banco, confere permissões)
src/
  config.js               APP_ROLE e variáveis, travas de segurança de produção
  app.js                  monta cada serviço só com as próprias rotas e arquivos; HTTPS; erros
  admin-gate.js           camada extra do painel: IPs, Cloudflare Access (JWT), senha de acesso
  db-roles.js             permissões mínimas do usuário olhar_site
  dates.js                regra "amanhã ou próximo sábado" (America/Manaus)
  availability.js         vagas reais por horário/dia
  booking.js              criação/cancelamento/remarcação com transação e trava por data
  validate.js             nome, idade, WhatsApp (DDD + 9º dígito), regras de menores
  meta.js                 API de Conversões (hash SHA-256, dedupe por event_id)
  auth.js                 senhas, sessões, bloqueio, troca obrigatória
  settings.js / legal.js  configurações (com aviso em tempo real) e Política de Privacidade versionada
  routes/public.js        rotas do site (+ rotas comuns: logo, robots, healthz)
  routes/admin.js         API do painel
  views.js                HTML do site e do painel
public/assets/            site.* (só no site) e admin.* (só no painel)
migrations/               esquema do banco (aplicado pelo painel)
scripts/                  create-admin, create-public-db-user, migrate
test/                     55 testes de backend + E2E no navegador com os dois serviços
```

---

## 3. Rodar localmente

Pré-requisitos: Node.js 20.11+ e PostgreSQL 14+.

```bash
createdb olhar
cat > .env <<'X'
DATABASE_URL=postgres://usuario:senha@127.0.0.1:5432/olhar
SESSION_SECRET=troque-por-um-segredo-de-32-caracteres-ou-mais
ADMIN_EMAIL=voce@clinica.com.br
ADMIN_INITIAL_PASSWORD=SenhaTemporaria2026
X
npm install
npm start          # APP_ROLE=all (só desenvolvimento): site em http://localhost:3000 e painel em /admin
```

Para simular a produção localmente, rode os dois papéis em portas diferentes:

```bash
APP_ROLE=admin PORT=3001 PUBLIC_SITE_URL=http://localhost:3000 PUBLIC_DB_PASSWORD=uma-senha-de-20-caracteres-ou-mais npm start
APP_ROLE=public PORT=3000 DATABASE_URL=postgres://olhar_site:uma-senha-de-20-caracteres-ou-mais@127.0.0.1:5432/olhar npm start
```

---

## 4. Publicação

Ordem em qualquer hospedagem: **banco → painel → site**. O painel aplica as migrações e cria o usuário restrito; o site aguarda o banco ficar pronto (até 5 minutos) antes de aceitar visitas.

### Opção A — Railway (dois serviços no mesmo projeto)

1. Crie um projeto e adicione **PostgreSQL**. Ele fica na rede privada do projeto.
2. **Serviço "painel"** (a partir deste repositório; o `railway.json` usa o `Dockerfile` e o healthcheck `/healthz`). Variáveis:
   - `APP_ROLE=admin`, `NODE_ENV=production`, `TRUST_PROXY=true`
   - `DATABASE_URL=${{Postgres.DATABASE_URL}}`
   - `PUBLIC_DB_PASSWORD` = segredo de 20+ caracteres (`openssl rand -hex 24`) → o painel cria o usuário `olhar_site`
   - `SESSION_SECRET` = `openssl rand -hex 32`
   - `APP_URL=https://gestao.seudominio.com.br`, `PUBLIC_SITE_URL=https://exame.seudominio.com.br`
   - `ADMIN_EMAIL`, `ADMIN_INITIAL_PASSWORD` (temporária)
   - A camada extra (ver seção 5)
3. **Serviço "site"** (mesmo repositório). Variáveis:
   - `APP_ROLE=public`, `NODE_ENV=production`, `TRUST_PROXY=true`
   - `DATABASE_URL=postgresql://olhar_site:${{painel.PUBLIC_DB_PASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}`
   - `SESSION_SECRET` = **outro** `openssl rand -hex 32`
   - `APP_URL=https://exame.seudominio.com.br`
   - `META_CAPI_ACCESS_TOKEN` (se usar a API de Conversões)
4. **Domínios** (Settings → Networking): adicione `exame.…` no serviço site e `gestao.…` no serviço painel. **Remova o domínio `*.up.railway.app` gerado para o painel** — o painel só deve ser alcançado pelo domínio protegido.
5. Mantenha **1 réplica por serviço** (o anti-spam por IP fica em memória do processo).

### Opção B — Servidor próprio (VPS) com Docker Compose

```bash
cp .env.compose.example .env      # preencha (segredos: openssl rand -hex 32)
docker compose up -d --build      # sobe banco, painel (porta local 3001) e site (porta local 3000)
```

O banco fica numa rede interna e as portas dos serviços só escutam em `127.0.0.1`. Na frente, um proxy HTTPS — exemplo com Caddy (certificados automáticos):

```
exame.clinicaolhar.com.br {
  reverse_proxy 127.0.0.1:3000
}

gestao.clinicaolhar.com.br {
  # opcional: restringe também no proxy
  # @fora not remote_ip 200.150.10.20
  # respond @fora 404
  reverse_proxy 127.0.0.1:3001
}
```

Com VPN (WireGuard/Tailscale), basta não publicar `gestao.…` na internet e usar `ADMIN_ALLOWED_IPS` com a faixa da VPN.

---

## 5. Protegendo o painel (camada extra obrigatória em produção)

O painel usa **login individual por e-mail e senha** (bloqueio após tentativas, sessões HttpOnly/Secure, autorização no servidor e níveis de acesso). As camadas abaixo são **opcionais** e podem ser combinadas — a mais indicada é o Cloudflare Access, que não usa senha compartilhada.

**A) Cloudflare Access — recomendado (controle de identidade, gratuito até 50 usuários)**
1. Coloque o DNS do domínio na Cloudflare e crie o registro de `gestao.…` com o proxy ativo (nuvem laranja).
2. Zero Trust → Access → Applications → *Self-hosted*: domínio `gestao.seudominio.com.br`; política *Allow* com os e-mails da equipe (ou o domínio de e-mail da clínica).
3. Copie o **Application Audience (AUD) Tag** e o domínio da equipe (`<equipe>.cloudflareaccess.com`).
4. No serviço do painel: `ADMIN_CF_ACCESS_TEAM_DOMAIN=<equipe>.cloudflareaccess.com` e `ADMIN_CF_ACCESS_AUD=<AUD>`.

O servidor valida o token de cada requisição; quem tentar acessar o servidor por outro caminho recebe 403.

**B) IPs permitidos** — `ADMIN_ALLOWED_IPS=200.150.10.20,10.8.0.0/24` (IP fixo da clínica, faixa da VPN). Fora da lista: 404.

**C) Senha de acesso compartilhada (não recomendada)** — `ADMIN_GATE_USER` e `ADMIN_GATE_PASSWORD`. Mantida só por compatibilidade; prefira A ou B.

### Administradores e Integrações

- **Níveis:** *Administrador principal* (tudo, inclusive administradores e Integrações) e *Administrador* (agendamentos, pacientes, agenda, lista de espera e configurações do site).
- **Convites:** em *Administradores → + ADICIONAR ADMINISTRADOR* é gerado um link de uso único, válido por 24 h. A pessoa confirma o e-mail e cria a própria senha. Só o hash do token é gravado.
- **Integrações:** protegidas por uma senha exclusiva criada pelo administrador principal no primeiro acesso (com código de recuperação exibido uma vez). O desbloqueio vale para a sessão e expira após 10 min sem uso. Tokens (ex.: API de Conversões) ficam nas variáveis do Railway e nunca vão ao navegador.
- **Recuperação:** senha da conta + código de recuperação. Sem o código: `npm run integrations:reset -- --confirmar` no terminal do serviço do painel.

---

## 6. Variáveis de ambiente

Modelos completos: `.env.public.example`, `.env.admin.example` e `.env.compose.example`.

| Variável | Site | Painel | Descrição |
|---|:-:|:-:|---|
| `APP_ROLE` | `public` | `admin` | Papel do serviço. `all` só em desenvolvimento (recusado em produção). |
| `NODE_ENV` | ✔ | ✔ | `production` ativa cookies `Secure`, HSTS e as travas de segurança. |
| `APP_URL` | ✔ | ✔ | URL https do próprio serviço. |
| `DATABASE_URL` | ✔ usuário `olhar_site` | ✔ usuário dono | Conexão PostgreSQL. |
| `DATABASE_SSL` | opc. | opc. | `require` se o provedor exigir SSL. |
| `SESSION_SECRET` | ✔ | ✔ | 32+ caracteres, **diferente** em cada serviço. |
| `TRUST_PROXY` | ✔ | ✔ | `true` atrás de proxy/CDN (IP real e redirecionamento HTTPS). |
| `PUBLIC_SITE_URL` | | ✔ | Links "Ver site" e "Ver página" no painel. |
| `PUBLIC_DB_PASSWORD` | | opc. | Cria/atualiza o usuário `olhar_site` a cada início do painel. |
| `PUBLIC_DB_ROLE` | | opc. | Nome do usuário restrito (padrão `olhar_site`). |
| `ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD` | | 1º acesso | Primeiro administrador (só se não houver nenhum). |
| `ADMIN_CF_ACCESS_TEAM_DOMAIN` / `ADMIN_CF_ACCESS_AUD` | | camada | Cloudflare Access. |
| `ADMIN_ALLOWED_IPS` | | camada | IPs/CIDR permitidos. |
| `ADMIN_GATE_USER` / `ADMIN_GATE_PASSWORD` | | camada | Senha de acesso extra. |
| `META_CAPI_ACCESS_TOKEN` | opc. | | Token da API de Conversões (o ID do Pixel e a ativação ficam no painel). |
| `META_TEST_EVENT_CODE` | opc. | | Código de teste do Gerenciador de Eventos. |
| `BOOKING_RATE_LIMIT` | opc. | | Reservas por IP por hora (padrão 8). |
| `ALLOW_PRIVILEGED_PUBLIC_DB` | emergência | | `true` permite o site iniciar com usuário administrativo. Não use no dia a dia. |

---

## 7. Acesso inicial seguro ao painel

1. Acesse `https://gestao.seudominio.com.br` → passe pela camada extra (Cloudflare Access, IP ou senha de acesso).
2. Entre com `ADMIN_EMAIL` e `ADMIN_INITIAL_PASSWORD`. O sistema **obriga a troca de senha** (12+ caracteres, letras e números) antes de liberar qualquer tela e encerra as outras sessões.
3. Remova `ADMIN_INITIAL_PASSWORD` das variáveis do painel.
4. Novos usuários ou senha esquecida: no terminal do serviço do painel, `npm run create-admin -- email@clinica.com.br "Nome"`.

---

## 8. Checklist antes de divulgar

O sistema **nasce com agendamentos fechados e sem endereço** — nada é inventado. No painel (`gestao.…`):

1. **Agenda → Configurações da agenda:** horário de abertura/encerramento, pausa de almoço, intervalo e vagas por horário para cada dia da semana. Domingo vem fechado.
2. **Agenda → Exceções por data:** feriados e dias sem atendimento.
3. **Configurações → Clínica:** WhatsApp oficial (ativa o botão "Confirmar pelo WhatsApp"), endereço, link do mapa, horário de funcionamento e logomarca.
4. **Configurações → Dúvidas frequentes:** revise as respostas (ex.: documentos necessários, local).
5. **Configurações → Privacidade:** revise a Política de Privacidade com o responsável jurídico. Cada alteração gera uma nova versão, e cada consentimento registra a versão aceita.
6. **Configurações → Agendamento:** abra os agendamentos.
7. **Integrações → Meta Ads:** informe o ID do Pixel e ative. Para a API de Conversões, configure `META_CAPI_ACCESS_TOKEN` **no serviço do site** e ative no painel. Teste com `META_TEST_EVENT_CODE` e confira os últimos envios na mesma tela (ela também mostra se o site está conectado e com o token).
8. (Opcional) **Configurações → Avisos de agendamentos:** ativa os avisos "Mariana realizou um agendamento". Só aparecem pacientes reais que marcaram a autorização opcional, apenas o primeiro nome, e nunca sobre o formulário no celular.
9. Divulgue **somente** o endereço do site público nos anúncios. O endereço do painel não deve aparecer em anúncios, no site ou em materiais externos.

---

## 9. Como as regras funcionam

### Datas oferecidas (fuso America/Manaus, relógio do servidor)
- **HOJE**, **AMANHÃ** e o **PRÓXIMO SÁBADO**, calculados automaticamente todos os dias. Cada opção pode ser desligada em **Agenda → Configurações da agenda**.
- Datas iguais aparecem uma vez só: na sexta, "AMANHÃ · SÁBADO". No sábado: HOJE (sábado), AMANHÃ (domingo) e PRÓXIMO SÁBADO (semana seguinte).
- **Hoje** mostra apenas horários com a **antecedência mínima** (padrão 60 min). Ex.: às 13h20 o primeiro horário é 14h30 (grade de 30 min). Sem horários elegíveis — antes do fim do expediente ou depois das 17h —, hoje fica desabilitado e o destaque "EXAME AINDA HOJE" some.
- **Limite de vagas do mesmo dia** (padrão 3 por horário): teto adicional para hoje, nunca acima da capacidade real.
- O servidor revalida tudo na confirmação. Quem demorou e perdeu a antecedência recebe "Este horário não está mais disponível. Escolha outro horário." sem perder os dados preenchidos. A página também se atualiza sozinha a cada minuto.
- Expediente padrão: **09:00–17:00, todos os dias**, 30 min por atendimento, 5 vagas por horário. Para fechar domingos ou feriados, use o horário por dia da semana ou as exceções por data; bloqueios sempre prevalecem.
- O calendário mostra o mês inteiro; só as datas permitidas e com vagas reais ficam clicáveis.

### Vagas e concorrência
- Cada horário tem capacidade própria. O contador do topo é a soma real das vagas livres nas datas oferecidas (considera capacidade, reservas ativas, bloqueios, limite diário e cancelamentos).
- Cada reserva roda numa transação com trava por data (`pg_advisory_xact_lock`): duas pessoas clicando ao mesmo tempo no último lugar → uma confirma, a outra recebe "horário esgotado" e escolhe outro.
- Índice único impede o mesmo paciente com dois agendamentos ativos na mesma data. Uma chave de idempotência evita duplicar a reserva se a rede cair e o botão for clicado de novo.
- Cancelar libera a vaga na hora. Reativar um cancelado exige vaga livre.
- O administrador pode remarcar para qualquer data com horários configurados; o visitante só vê amanhã/sábado.

### Menores de idade
Configurável em **Configurações → Agendamento**: exigir responsável (padrão — pede nome do responsável e confirmação), permitir ou bloquear. Idade mínima/máxima também é opcional; ninguém é recusado por idade sem regra explícita.

### Eventos da Meta

| Evento | Quando |
|---|---|
| `PageView` | Carregamento da página (após consentimento de cookies). |
| `ViewContent` | Visualização da oferta. |
| `StartRegistration` (personalizado) | Na primeira interação com o formulário. Uma vez por sessão. |
| `Lead` | **Somente** após o servidor gravar o agendamento. Uma vez por agendamento: recarregar a página não repete. |
| `Schedule` | Opcional (ativável), junto com o Lead. |
| `Contact` | Clique nos botões de WhatsApp. |

- Pixel e API de Conversões usam o **mesmo `event_id`**, então a Meta deduplica.
- A API de Conversões envia apenas telefone e primeiro nome em hash SHA-256, país, IP/navegador e `fbc`/`fbp`. **Nunca** envia idade, dados de saúde ou informações clínicas.
- Com "exigir consentimento" ativo (padrão), o Pixel só carrega após o visitante aceitar, e a API de Conversões só envia se ele tiver aceitado.

### Atribuição (UTMs)
`utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `fbclid`, `referrer` e página de entrada são guardados com o agendamento. O painel mostra a origem (ex.: "Facebook Ads · Exame Gratis Manaus"); quando não há dados, aparece "(não identificada)" — nada é deduzido.

Sugestão de URL para os anúncios:
```
https://seu-dominio.com.br/?utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&utm_term={{adset.name}}
```

### LGPD
- Coleta mínima: nome, idade, WhatsApp. Sem CPF, e-mail ou endereço.
- Consentimentos separados e registrados com data, versão do texto e hash do IP: tratamento para agendamento (obrigatório), mensagens promocionais (opcional) e exibição do primeiro nome nos avisos (opcional).
- Retenção configurável (padrão 365 dias): dados de pacientes sem atendimento recente são anonimizados automaticamente a cada 6 horas.
- No painel, cada paciente pode ter os dados **corrigidos** ou **excluídos (anonimizados)** sob pedido, com registro em auditoria.
- A exportação CSV é protegida contra injeção de fórmulas no Excel.

> Por envolver serviço de saúde, revise com o responsável técnico e jurídico: as normas de publicidade aplicáveis à profissão de quem realiza o exame, a Política de Privacidade e a confirmação de que o exame é realmente gratuito, sem exigência de compra de óculos ou lentes.

---

## 10. Testes

```bash
npm test             # 74 testes de backend (banco olhar_test; o usuário de teste precisa de CREATEROLE para o teste de permissões)
npm run test:e2e     # E2E no navegador com os dois serviços separados; instruções no topo de test/e2e/run_e2e.py
```

### Resumo da última execução

**Backend — 74/74 aprovados** (inclui 17 cenários de agendamento para hoje: antes das 9h, 10h, 13h20, perto das 17h, após o expediente, sexta→sábado, sábado→domingo, virada de mês/ano, bloqueios, lotação, antecedência, teto do mesmo dia, opções do painel e 20 reservas simultâneas) (`node --test`, PostgreSQL 16)
- **Separação:** no site, `/admin`, `/api/admin/*` (inclusive o login) e `admin.js` → 404, e nenhum link de login/painel na página. No painel, o site, a política e a API de agendamento → 404; `robots.txt` bloqueia tudo; cabeçalho e HTML `noindex`.
- **Integração:** agendamento feito no serviço do site aparece na lista do serviço do painel; horário bloqueado no painel deixa de ser oferecido no site e o contador cai na hora.
- **Camadas do painel:** IPs (IPv4, IPv6, CIDR, endereços mapeados); senha de acesso (401 sem/errada, 200 certa, site não afetado); Cloudflare Access — token válido aceito; audiência errada, expirado, emissor falso, conteúdo adulterado e `alg: none` recusados.
- **Banco:** com o usuário `olhar_site`, 17 operações administrativas recusadas pelo próprio PostgreSQL (ler admins, sessões, auditoria, consentimentos, atribuições, observações; cancelar, apagar, truncar, alterar vagas, configurações, horários, bloqueios, WhatsApp de pacientes; criar tabelas).
- Regras de data para os 7 dias da semana, virada de mês/ano, fuso de Manaus, nunca hoje nem datas passadas.
- Cadastro completo com protocolo, UTMs e consentimentos; validações de nome, idade e menores, WhatsApp.
- **Concorrência:** 25 reservas simultâneas no mesmo horário de 5 vagas → exatamente 5 confirmadas e 20 recusadas com "esgotado". Limite diário respeitado.
- Cancelamento libera vaga; duplicidade bloqueada; idempotência em reenvio; contador = soma real das vagas; lista de espera sem vagas.
- API de Conversões: Lead enviado uma única vez, dados em hash, sem idade.
- Segurança: login, troca de senha no 1º acesso, CSRF, bloqueio após tentativas, limite de requisições, XSS, anti-robô, CSV seguro. LGPD: retenção, correção e exclusão.

**Navegador (Chromium) — 70/70 verificações aprovadas** (calendário, destaque de hoje, horários com vagas reais, atualização automática sem perder dados), com **dois processos separados** (site com o usuário `olhar_site`, painel com senha de acesso), simulando uma quinta-feira:
- Site sem `/admin`, sem API do painel, sem `admin.js` e sem links de login; painel responde 401 sem a senha de acesso.
- Primeiro acesso do admin com troca de senha obrigatória; configuração da agenda, WhatsApp, Pixel e avisos pelo painel — refletidas no site imediatamente (LISTEN/NOTIFY).
- Fluxo completo no celular (390 px) com UTMs: validações, máscara `(92) 98888-7777`, teclado numérico, responsável para menor, duas datas (sexta 09/10 e sábado 10/10), 14 horários, resumo editável, protocolo `OLH-000001`, WhatsApp com protocolo.
- Pixel: PageView/ViewContent após aceitar cookies, StartRegistration uma vez, **Lead uma única vez com eventID, nenhum Lead ao escolher horário nem ao recarregar**.
- Contador 84 → 83; horário lotado aparece "Esgotado" e o servidor recusa a 4ª reserva com 409; avisos de atividade só de quem autorizou.
- Sem rolagem horizontal em 320, 360, 375, 390, 430, 768, 1280 e 1440 px; painel também no celular.
- Painel: "Ver site" aponta para o domínio público; vê o estado do site (conectado/token); dashboard, busca por protocolo, origem do anúncio, cancelamento liberando vaga no site, CSV.
- Sem vagas → "TODAS AS VAGAS FORAM PREENCHIDAS" → lista de espera → aparece no painel.

**Travas de produção verificadas:** `APP_ROLE=all` ou ausente → não inicia; painel sem camada extra → não inicia; site conectado com usuário dono → não inicia; site com `olhar_site` → inicia, `/admin` = 404. HTTP → HTTPS preservando UTMs, HSTS e CSP restritiva.

> O `docker-compose.yml` teve a sintaxe validada; a execução com Docker não foi possível neste ambiente de testes (sem o serviço do Docker). Os mesmos dois serviços foram testados como processos reais.
